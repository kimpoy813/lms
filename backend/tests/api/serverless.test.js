// The API as it runs on a function platform (Vercel): no process that stays up, no lasting disk.
// Uploaded files live in the database, background jobs are driven by requests and by a scheduled
// call, and the web app is told that the server cannot push updates.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Before any application module loads (imports are hoisted; this is hoisted above them).
vi.hoisted(() => {
  process.env.SERVERLESS = 'true';
  process.env.STORAGE_QUOTA_MB = '3';
  process.env.CRON_SECRET = 'cron-secret-for-the-tests';
  // Lets the scheduled call run the jobs; in the test-suite nothing runs them by itself anyway.
  process.env.SCHEDULER_ENABLED = 'true';
});

const { actor, anonymous, classroom, minutesFromNow, prepare, prisma } = await import('../helpers/index.js');
const { env } = await import('../../src/config/env.js');
const { runInBackground, setBackgroundRunner } = await import('../../src/lib/background.js');
const { closeIdleConnectionsBeforeFreeze, keepAliveUntil, restoreRequestUrl } = await import('../../src/lib/vercel.js');
const { pgOptionsFromUrl } = await import('../../src/db/connection.js');
const { default: pg } = await import('pg');
const { checkDueJobs, jobNames, resetDueCheck, runDueJobs } = await import('../../src/services/scheduler.js');
const { persistBuffer, purgeOrphanFiles, readStoredFile } = await import('../../src/services/storage.js');

beforeAll(prepare);

const MB = 1024 * 1024;
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
/** A file the type check accepts as PDF, of exactly `size` bytes. */
const pdf = (size) => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(size - 9)]);
const binary = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});
const emptyStore = () => prisma.fileBlob.deleteMany({});

describe('configuration', () => {
  it('follows from SERVERLESS: files in the database, no push, small pool', () => {
    expect(env.serverless).toBe(true);
    expect(env.realtime).toBe(false);
    expect(env.storageDriver).toBe('database');
    expect(env.storageQuotaBytes).toBe(3 * MB);
    expect(env.databasePoolMax).toBeLessThanOrEqual(5);
    // An instance stays awake until its idle connections are closed, so they are closed quickly.
    expect(env.databasePoolIdleMs).toBe(1_000);
  });

  it('tells the web app that it cannot push and how large an upload may be', async () => {
    const student = await actor('STUDENT');
    const session = await student.get('/api/auth/session');
    expect(session.body.data.runtime).toEqual({ realtime: false, maxUploadBytes: env.maxUploadBytes });
  });
});

describe('uploaded files kept in the database', () => {
  it('stores, serves (whole and in part) and deletes a file without touching the disk', async () => {
    await emptyStore();
    const teacher = await actor('TEACHER');
    const content = pdf(Math.round(1.5 * MB));
    const uploaded = await teacher.upload([{ name: 'handout.pdf', content }]);
    expect(uploaded.status).toBe(201);
    const [{ id }] = uploaded.body.data;

    const row = await prisma.file.findUnique({ where: { id } });
    const blob = await prisma.fileBlob.findUnique({ where: { storedName: row.storedName }, select: { sizeBytes: true } });
    expect(blob.sizeBytes).toBe(content.length);
    // Where the disk driver would have put it.
    expect(fs.existsSync(path.join(env.storageDir, 'files', row.storedName.slice(0, 2), row.storedName))).toBe(false);
    // The temporary copy made while checking the upload is gone.
    expect(fs.readdirSync(path.join(env.storageDir, 'tmp'))).toHaveLength(0);

    const whole = await binary(teacher.get(`/api/files/${id}`));
    expect(whole.status).toBe(200);
    expect(whole.headers['content-length']).toBe(String(content.length));
    expect(sha(whole.body)).toBe(sha(content));

    // A part that spans the 1 MB pieces the file is read in.
    const start = MB - 700;
    const end = MB + 300;
    const part = await binary(teacher.get(`/api/files/${id}`).set('Range', `bytes=${start}-${end}`));
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/${content.length}`);
    expect(part.body.equals(content.subarray(start, end + 1))).toBe(true);

    const tail = await binary(teacher.get(`/api/files/${id}`).set('Range', 'bytes=-100'));
    expect(tail.status).toBe(206);
    expect(tail.body.equals(content.subarray(content.length - 100))).toBe(true);

    expect((await teacher.delete(`/api/files/${id}`)).status).toBe(204);
    expect(await prisma.fileBlob.count({ where: { storedName: row.storedName } })).toBe(0);
    expect((await teacher.get(`/api/files/${id}`)).status).toBe(404);
  });

  it('keeps files private exactly as on disk', async () => {
    const owner = await actor('TEACHER');
    const stranger = await actor('STUDENT');
    const [{ id }] = (await owner.upload([{ name: 'key.pdf', content: pdf(2000) }])).body.data;
    expect((await stranger.get(`/api/files/${id}`)).status).toBe(404);
    expect((await anonymous().get(`/api/files/${id}`)).status).toBe(401);
  });

  it('refuses an upload that would take the store over its quota, and says so', async () => {
    await emptyStore();
    const teacher = await actor('TEACHER');
    expect((await teacher.upload([{ name: 'a.pdf', content: pdf(Math.round(1.6 * MB)) }])).status).toBe(201);
    const second = await teacher.upload([{ name: 'b.pdf', content: pdf(Math.round(1.6 * MB)) }]);
    expect(second.status).toBe(507);
    expect(second.body.error.code).toBe('STORAGE_FULL');
    expect(await prisma.fileBlob.count()).toBe(1);
    expect(fs.readdirSync(path.join(env.storageDir, 'tmp'))).toHaveLength(0);
    // A file that still fits is accepted.
    expect((await teacher.upload([{ name: 'c.pdf', content: pdf(Math.round(1.2 * MB)) }])).status).toBe(201);
  });

  it('reports where files are kept and how full the store is to administrators', async () => {
    await emptyStore();
    const admin = await actor('ADMIN');
    await admin.upload([{ name: 'policy.pdf', content: pdf(50_000) }]);
    const status = await admin.get('/api/admin/status');
    expect(status.body.data).toMatchObject({ serverless: true, realtime: false, storage: { driver: 'database', usedBytes: 50_000, quotaBytes: 3 * MB } });
  });

  it('stores and reads back bytes the server produces itself', async () => {
    await emptyStore();
    const teacher = await actor('TEACHER');
    const file = await persistBuffer(Buffer.from('Week 1 notes\n'), { ownerId: teacher.user.id, originalName: 'notes.txt' });
    expect((await readStoredFile(file)).toString()).toBe('Week 1 notes\n');
  });

  it('removes bytes whose file record is gone, and nothing else', async () => {
    await emptyStore();
    const teacher = await actor('TEACHER');
    const [{ id }] = (await teacher.upload([{ name: 'kept.pdf', content: pdf(3000) }])).body.data;
    const kept = await prisma.file.findUnique({ where: { id } });
    const twoHoursAgo = minutesFromNow(-120);
    await prisma.fileBlob.update({ where: { storedName: kept.storedName }, data: { createdAt: twoHoursAgo } });
    const stale = 'a'.repeat(48);
    const recent = 'b'.repeat(48);
    await prisma.fileBlob.createMany({
      data: [
        { storedName: stale, sizeBytes: 3, data: Buffer.from('old'), createdAt: twoHoursAgo },
        { storedName: recent, sizeBytes: 3, data: Buffer.from('new') }, // may belong to a request still in flight
      ],
    });
    await purgeOrphanFiles();
    const left = (await prisma.fileBlob.findMany({ select: { storedName: true } })).map((b) => b.storedName).sort();
    expect(left).toEqual([kept.storedName, recent].sort());
  });
});

describe('background jobs without a timer', () => {
  const forgetRuns = () => prisma.jobState.deleteMany({});

  it('runs each job once its interval has passed, whichever request notices first', async () => {
    await forgetRuns();
    expect((await runDueJobs()).sort()).toEqual(jobNames().sort());
    expect(await runDueJobs()).toEqual([]);

    await prisma.jobState.update({ where: { name: 'publishing' }, data: { lastRunAt: minutesFromNow(-2) } });
    expect(await runDueJobs()).toEqual(['publishing']);
    expect(await runDueJobs()).toEqual([]);
  });

  it('never gives the same turn to two instances', async () => {
    await forgetRuns();
    const [a, b, c] = await Promise.all([runDueJobs(), runDueJobs(), runDueJobs()]);
    const all = [...a, ...b, ...c];
    expect(all.sort()).toEqual(jobNames().sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('publishes scheduled work when a request comes in after its time', async () => {
    const { teacher, cls, students } = await classroom(1);
    const scheduled = await teacher.post('/api/announcements', { classId: cls.id, title: 'Exam room changed', contentHtml: '<p>Room 204.</p>', status: 'SCHEDULED', publishAt: minutesFromNow(30).toISOString() });
    expect(scheduled.status).toBe(201);
    await prisma.announcement.update({ where: { id: scheduled.body.data.id }, data: { publishAt: minutesFromNow(-1) } });

    await forgetRuns();
    resetDueCheck();
    const pending = checkDueJobs();
    expect(pending).not.toBeNull();
    // One instance asks the database at most every 20 seconds.
    expect(checkDueJobs()).toBeNull();
    expect(await pending).toContain('publishing');

    expect((await prisma.announcement.findUnique({ where: { id: scheduled.body.data.id } })).status).toBe('PUBLISHED');
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'announcement.new' } })).toBe(1);
  });

  it('runs everything on the scheduled call, which needs the secret', async () => {
    await forgetRuns();
    await runDueJobs(); // nothing is due any more
    expect((await anonymous().get('/api/internal/cron')).status).toBe(401);
    expect((await anonymous().get('/api/internal/cron').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const res = await anonymous().get('/api/internal/cron').set('Authorization', 'Bearer cron-secret-for-the-tests');
    expect(res.status).toBe(200);
    expect(res.body.data.ran.sort()).toEqual(jobNames().sort());
  });
});

describe('work that outlives the response', () => {
  it('is handed to the platform so that the instance stays up until it is done', async () => {
    const kept = [];
    setBackgroundRunner((promise) => kept.push(promise));
    try {
      let done = false;
      const settled = runInBackground(async () => { done = true; }, 'test task');
      expect(kept).toEqual([settled]);
      await settled;
      expect(done).toBe(true);
      // A failure is logged, never thrown into the request that started it.
      await expect(runInBackground(() => { throw new Error('boom'); }, 'failing task')).resolves.toBeUndefined();
      expect(kept).toHaveLength(2);
    } finally {
      setBackgroundRunner(null);
    }
  });
});

describe('the Vercel entry point', () => {
  it('asks the platform to keep the instance up, and says when there is no platform', () => {
    const work = Promise.resolve();
    expect(keepAliveUntil(work)).toBe(false);
    // Vercel publishes the request in progress under this symbol.
    const symbol = Symbol.for('@vercel/request-context');
    const kept = [];
    globalThis[symbol] = { get: () => ({ waitUntil: (promise) => kept.push(promise) }) };
    try {
      expect(keepAliveUntil(work)).toBe(true);
      expect(kept).toEqual([work]);
    } finally {
      delete globalThis[symbol];
    }
  });

  it('stays awake after a query until the pool has closed the connection it used', async () => {
    const symbol = Symbol.for('@vercel/request-context');
    const kept = [];
    globalThis[symbol] = { get: () => ({ waitUntil: (promise) => kept.push(promise) }) };
    const pool = new pg.Pool({ ...pgOptionsFromUrl(env.databaseUrl), max: 2, idleTimeoutMillis: 300 });
    try {
      closeIdleConnectionsBeforeFreeze(pool);
      await pool.query('SELECT 1');
      await pool.query('SELECT 2');
      // One promise per use of a connection; an earlier one ends when a later one starts.
      expect(kept).toHaveLength(2);
      await kept[0];
      expect(pool.totalCount).toBe(1);
      // The last one lasts until just after the idle time, when the connection has been closed.
      await kept[1];
      expect(pool.totalCount).toBe(0);
    } finally {
      delete globalThis[symbol];
      await pool.end();
    }
  });

  it('restores the path that vercel.json hands over, whichever URL the platform passes on', () => {
    const restored = (url) => {
      const req = { url };
      restoreRequestUrl(req);
      return req.url;
    };
    // The platform passes the rewritten URL …
    expect(restored('/api?__path=api/auth/session&optional=1')).toBe('/api/auth/session?optional=1');
    expect(restored('/api?__path=healthz')).toBe('/healthz');
    // … or the original one with the parameter added.
    expect(restored('/api/auth/session?optional=1&__path=api/auth/session')).toBe('/api/auth/session?optional=1');
    expect(restored('/api/classes')).toBe('/api/classes');
    // Sent by hand it changes nothing: other paths ignore it, and it cannot carry a query string.
    expect(restored('/api/files/abc?__path=api/admin/users')).toBe('/api/files/abc');
    expect(restored('/api?__path=api/files/abc%3Fkind%3Dimage')).toBe('/api/files/abc%3Fkind=image');
  });

  it('exports the Express application itself and answers under both URL forms', async () => {
    const { default: handler } = await import('../../../api/index.js');
    // Vercel leaves the request untouched only for an export that has listen().
    expect(typeof handler.listen).toBe('function');
    try {
      expect((await request(handler).get('/api?__path=healthz')).body).toEqual({ status: 'ok' });
      expect((await request(handler).get('/healthz')).body).toEqual({ status: 'ok' });
      const rewritten = await request(handler).get('/api?__path=api/auth/config');
      const original = await request(handler).get('/api/auth/config?__path=api/auth/config');
      expect(rewritten.status).toBe(200);
      expect(original.body).toEqual(rewritten.body);
      // A sign-in through the rewritten form: the body reaches the application intact.
      const student = await actor('STUDENT');
      const login = await request(handler).post('/api?__path=api/auth/login').send({ email: student.user.email, password: 'Correct-Horse-42' });
      expect(login.status).toBe(200);
      expect(login.body.data.user.email).toBe(student.user.email);
    } finally {
      setBackgroundRunner(null);
    }
  });
});
