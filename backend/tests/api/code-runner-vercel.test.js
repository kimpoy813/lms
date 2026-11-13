// The code runner where it is meant to run: inside a Vercel Function.
//
// There the machines are started with the project's own identity: a short-lived token that Vercel
// sends along with every request, so that nothing has to be configured or stored. And work that
// should end after the response (removing the machine) depends on the platform keeping the
// instance awake.
//
// Requests go through the function's real entry point (api/index.js). Vercel's SDK is replaced by
// a pretend account (tests/helpers/fakeSandbox.js); the platform's own part — the header, and the
// "request in progress" it publishes — is played by the tests.
import http from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Before any application module loads (imports are hoisted; this is hoisted above them).
vi.hoisted(() => {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_REGION = 'sin1';
  process.env.VERCEL_PROJECT_ID = 'prj_site';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'edusphere.example';
  process.env.CODE_RUNNER_PROVIDER = 'vercel-sandbox';
  process.env.CRON_SECRET = 'secret-of-the-operator';
  // Lets the scheduled call run the jobs; in the test-suite nothing runs them by itself.
  process.env.SCHEDULER_ENABLED = 'true';
  delete process.env.VERCEL_OIDC_TOKEN;
});

const { PASSWORD, classroom, prepare, prisma } = await import('../helpers/index.js');
const { fakeSandboxAccount, okReport } = await import('../helpers/fakeSandbox.js');
const { env } = await import('../../src/config/env.js');
const { setBackgroundRunner } = await import('../../src/lib/background.js');
const { operatorToken } = await import('../../src/lib/tokens.js');
const { startupReportToken } = await import('../../src/lib/vercel.js');
const { CODE_RUNNER_CHECK } = await import('../../src/routes.js');
const { resetCodeRunner } = await import('../../src/services/codeRunner.js');
const { imageName, setSandboxSdk } = await import('../../src/services/judge/vercelSandbox.js');
const { default: handler } = await import('../../../api/index.js');

const NAME = imageName('sin1');
const PLATFORM = Symbol.for('@vercel/request-context');
const HEADER = 'x-vercel-oidc-token';
const WITH_REQUEST = 'the project’s identity, handed to this request by Vercel';
/** A token as Vercel issues it, as far as this application reads it: who it is for. */
const tokenFor = (claims) => `header.${Buffer.from(JSON.stringify({ owner_id: 'team_site', project_id: 'prj_site', ...claims })).toString('base64url')}.signature`;

let fake;
let server;
let room;
beforeAll(async () => {
  await prepare();
  server = handler.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  // A class with a problem, and its student signed in through the function.
  const made = await classroom(1);
  const created = await made.teacher.post('/api/programming/problems', {
    classId: made.cls.id, title: 'Double it', statementHtml: '<p>Read a number and print twice its value.</p>', allowedLanguages: ['PYTHON'],
    testCases: [{ input: '2', expectedOutput: '4' }, { input: '5', expectedOutput: '10', isHidden: true }],
  });
  expect(created.status).toBe(201);
  const agent = request.agent(server);
  const login = await agent.post('/api/auth/login').send({ email: made.students[0].user.email, password: PASSWORD });
  expect(login.status).toBe(200);
  room = {
    run: `/api/programming/problems/${created.body.data.id}/run`,
    csrf: login.body.data.csrfToken,
    cookie: login.headers['set-cookie'].map((line) => line.split(';')[0]).join('; '),
    agent,
  };
});
/** What the runner in the machine would report: twice the input for a program, and every language in order for a check. */
function pretendRunner(job) {
  if (!job.selfTest) return okReport(job);
  const languages = Object.fromEntries(['PYTHON', 'JAVASCRIPT', 'C', 'CPP', 'JAVA'].map((id) => [id, { ok: true, compileMs: 50, runMs: 20, peakKb: 3000, detail: null }]));
  return { ...okReport(job), selfTest: { languages, versions: { PYTHON: 'Python 3.14.4' } } };
}
beforeEach(() => {
  fake = fakeSandboxAccount(NAME, { report: pretendRunner });
  setSandboxSdk(fake);
  resetCodeRunner();
});
afterEach(() => {
  delete globalThis[PLATFORM];
});
afterAll(async () => {
  setSandboxSdk(null);
  setBackgroundRunner(null);
  await new Promise((resolve) => server.close(resolve));
});

const program = { language: 'PYTHON', code: 'print(int(input()) * 2)' };
/** The student asks for the sample tests; `token` is what the platform sends along. */
const runSamples = (token) => {
  const sent = room.agent.post(room.run).set('x-csrf-token', room.csrf);
  return (token === undefined ? sent : sent.set(HEADER, token)).send(program);
};
const forks = () => fake.calls.filter((call) => call[0] === 'fork').map((call) => call[1]);
const checkAddress = `/api/internal/code-runner-check?token=${operatorToken('secret-of-the-operator', CODE_RUNNER_CHECK)}`;

describe('the configuration on Vercel', () => {
  it('needs nothing but the choice of the code runner: region and identity come from the platform', () => {
    expect(env.platform).toBe('vercel');
    expect(env.codeRunner).toMatchObject({ provider: 'vercel-sandbox', configured: true, region: 'sin1', vercelAccess: null });
  });
});

describe('the project’s identity', () => {
  it('starts the machine for a student’s program with the token that came with the request', async () => {
    const token = tokenFor({ nonce: 'first' });
    const ran = await runSamples(token);
    expect(ran.status).toBe(200);
    expect(ran.body.data).toMatchObject({ mode: 'SAMPLES', status: 'COMPLETED', passedCount: 1, totalCount: 1 });
    expect(forks()).toHaveLength(1);
    expect(forks()[0]).toMatchObject({ sourceSandbox: NAME, region: 'sin1', networkPolicy: 'deny-all', token, teamId: 'team_site', projectId: 'prj_site' });
  });

  it('does so when the program arrives after its headers, piece by piece', async () => {
    const token = tokenFor({ nonce: 'late body' });
    const body = JSON.stringify(program);
    const answer = await new Promise((resolve, reject) => {
      const sent = http.request(
        { host: '127.0.0.1', port: server.address().port, path: room.run, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie: room.cookie, 'x-csrf-token': room.csrf, [HEADER]: token } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      sent.on('error', reject);
      sent.flushHeaders();
      setTimeout(() => sent.write(body.slice(0, 10)), 40);
      setTimeout(() => sent.end(body.slice(10)), 80);
    });
    expect(answer.status).toBe(200);
    expect(answer.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 1 });
    expect(forks()[0]).toMatchObject({ token, projectId: 'prj_site' });
  });

  it('is taken from each request anew, and several at once do not mix', async () => {
    const tokens = ['a', 'b', 'c', 'd'].map((nonce) => tokenFor({ nonce }));
    const answers = await Promise.all(tokens.map((token) => runSamples(token)));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    expect(forks().map((fork) => fork.token).sort()).toEqual([...tokens].sort());

    // A request that brings none does not borrow the one before it.
    fake.calls.length = 0;
    const without = await runSamples();
    expect(without.status).toBe(503);
    expect(without.body.error.code).toBe('CODE_RUNNER_UNAVAILABLE');
    expect(JSON.stringify(without.body)).not.toMatch(/token|identity/i);
    expect(fake.calls).toEqual([]);
  });

  it('is only used when it is this project’s: a token of another project starts nothing', async () => {
    const foreign = tokenFor({ owner_id: 'team_somebody', project_id: 'prj_somebody' });
    const ran = await runSamples(foreign);
    expect(ran.status).toBe(503);
    expect(ran.body.error.code).toBe('CODE_RUNNER_UNAVAILABLE');
    expect(fake.calls).toEqual([]);

    const checked = await request(server).get(checkAddress).set(HEADER, foreign);
    expect(checked.body.data).toMatchObject({ ok: false, provider: 'vercel-sandbox', identity: 'none', code: 'CODE_RUNNER_UNAVAILABLE' });
    expect(checked.body.data.detail).toMatch(/no Vercel identity.*An identity token for another Vercel project was found; nothing is started with it\./);
    expect(fake.calls).toEqual([]);
  });

  it('is what the operator’s check uses and names', async () => {
    const token = tokenFor({ nonce: 'check' });
    const checked = await request(server).get(checkAddress).set(HEADER, token);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ ok: true, provider: 'vercel-sandbox', region: 'sin1', identity: WITH_REQUEST });
    expect(forks()[0].token).toBe(token);

    const none = await request(server).get(checkAddress);
    expect(none.body.data).toMatchObject({ ok: false, identity: 'none' });
    expect(none.body.data.detail).toMatch(/No identity token reached this process/);
  });

  it('is reported to the operator as present or absent, never as a value', async () => {
    const address = `/healthz?startup-report=${startupReportToken('secret-of-the-operator')}`;
    const token = tokenFor({ nonce: 'report' });
    const bare = await request(server).get(address);
    expect(bare.body.data).toMatchObject({ started: true, projectKnown: true, request: { requestContext: false, waitUntil: false, identityHeader: false, identityInContext: false } });

    const withHeader = await request(server).get(address).set(HEADER, token);
    expect(withHeader.body.data.request).toEqual({ requestContext: false, waitUntil: false, identityHeader: true, identityInContext: false });

    // The other way the platform has of telling: the request it publishes as being in progress.
    globalThis[PLATFORM] = { get: () => ({ waitUntil: () => {}, headers: { [HEADER]: token } }) };
    const published = await request(server).get(address);
    expect(published.body.data.request).toEqual({ requestContext: true, waitUntil: true, identityHeader: false, identityInContext: true });
    expect(JSON.stringify([bare.body, withHeader.body, published.body])).not.toContain(token);

    // Published only, without the header: that is enough to start a machine.
    const ran = await runSamples();
    expect(ran.status).toBe(200);
    expect(forks()[0].token).toBe(token);
  });
});

describe('removing the machine of a program', () => {
  it('is done before the answer when the platform cannot be asked to stay awake', async () => {
    // Stopping a machine takes seconds on the real service; here it takes until the test says so.
    let machineStopped;
    fake.state.stopGate = new Promise((resolve) => { machineStopped = resolve; });
    let answered = false;
    const answer = runSamples(tokenFor({})).then((res) => {
      answered = true;
      return res;
    });
    // The program has been checked and the machine is being stopped — and the answer waits for that.
    await vi.waitFor(() => expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop']));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(answered).toBe(false);
    machineStopped();
    expect((await answer).status).toBe(200);
    // Nothing is left to do when the answer is out.
    expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop', 'delete']);
  });

  it('is left for after the answer when the platform keeps the instance awake for it', async () => {
    // The platform is asked to wait for several things (the database pool has its own); note who asks.
    const kept = [];
    globalThis[PLATFORM] = { get: () => ({ waitUntil: (promise) => kept.push({ promise, askedBy: new Error('here').stack }) }) };
    let machineStopped;
    fake.state.stopGate = new Promise((resolve) => { machineStopped = resolve; });

    const ran = await runSamples(tokenFor({}));
    expect(ran.status).toBe(200);
    // The answer is out while the machine is still being stopped …
    expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop']);
    // … and the platform has been told to stay awake until that is done.
    const removal = kept.filter((entry) => /judge[\\/]vercelSandbox\.js/.test(entry.askedBy));
    expect(removal).toHaveLength(1);
    let over = false;
    removal[0].promise.then(() => { over = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(over).toBe(false);
    machineStopped();
    await removal[0].promise;
    expect(fake.names().slice(-2)).toEqual(['stop', 'delete']);
  });
});

describe('machines that were never removed', () => {
  it('are deleted by the daily housekeeping, with the identity of the request that sets it off', async () => {
    // Three programs whose machines could not be stopped at the time.
    fake.state.stopError = Object.assign(new Error('could not stop'), { response: { status: 500 } });
    for (const nonce of ['one', 'two', 'three']) expect((await runSamples(tokenFor({ nonce }))).status).toBe(200);
    fake.state.stopError = null;
    expect(fake.machines.map((machine) => machine.deleted)).toEqual([false, false, false]);
    // Since then two have ended by themselves.
    fake.machines[0].status = 'stopped';
    fake.machines[1].status = 'aborted';

    // The job needs the project's identity like everything else, and has it from the request that set it off.
    await prisma.jobState.deleteMany({});
    const token = tokenFor({ nonce: 'housekeeping' });
    const cron = await request(server).get('/api/internal/cron').set('authorization', 'Bearer secret-of-the-operator').set(HEADER, token);
    expect(cron.status).toBe(200);
    expect(cron.body.data.ran).toContain('codeRunner.leftovers');
    expect(fake.machines.map((machine) => machine.deleted)).toEqual([true, true, false]);
    const list = fake.calls.filter((call) => call[0] === 'list').pop()[1];
    expect(list).toMatchObject({ tags: { edusphere: 'judge-run' }, token, teamId: 'team_site', projectId: 'prj_site' });
    // The image is not a leftover.
    expect([...fake.bases.keys()]).toEqual([NAME]);
  });

  it('are left alone, without a fuss, when Vercel cannot be asked', async () => {
    await prisma.jobState.deleteMany({});
    const cron = await request(server).get('/api/internal/cron').set('authorization', 'Bearer secret-of-the-operator');
    expect(cron.status).toBe(200);
    expect(cron.body.data.ran).toContain('codeRunner.leftovers');
    expect(fake.calls).toEqual([]);
  });
});
