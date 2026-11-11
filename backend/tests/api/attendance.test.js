import { beforeAll, describe, expect, it } from 'vitest';
import { actor, classroom, clearSetting, createClass, minutesFromNow, prepare, prisma, setSetting } from '../helpers/index.js';
import { autoCloseAttendance } from '../../src/jobs/attendance.js';
import { applyLocationRetention } from '../../src/jobs/maintenance.js';
import { checkQrToken, currentQrToken, extractQrToken } from '../../src/modules/attendance/service.js';

beforeAll(prepare);

// A classroom at Holy Angel University, Angeles City (any real coordinate works).
const ROOM = { latitude: 15.1335, longitude: 120.5907 };
const metresNorth = (m) => ({ latitude: ROOM.latitude + m / 111_195, longitude: ROOM.longitude });
const fix = (m, accuracy = 12) => ({ ...metresNorth(m), accuracy });

const startGps = (teacher, cls, extra = {}) =>
  teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {
    allowQr: true, requireLocation: true, location: ROOM, radiusMeters: 50, durationMinutes: 30, ...extra,
  });
const qr = async (teacher, sessionId) => (await teacher.get(`/api/attendance/sessions/${sessionId}/qr`)).body.data;

describe('manual attendance', () => {
  it('records a roster, closes the session and marks the rest absent', async () => {
    const { teacher, cls, students } = await classroom(4);
    const created = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { title: 'Week 1' });
    expect(created.status).toBe(201);
    expect(created.body.data.roster).toHaveLength(4);
    expect(created.body.data.counts).toMatchObject({ present: 0, unmarked: 4, enrolled: 4 });
    const id = created.body.data.id;

    const saved = await teacher.put(`/api/attendance/sessions/${id}/records`, {
      records: [
        { studentId: students[0].user.id, status: 'PRESENT' },
        { studentId: students[1].user.id, status: 'LATE', remarks: 'Arrived 8:20' },
        { studentId: students[2].user.id, status: 'EXCUSED', remarks: 'Varsity game' },
      ],
      close: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.status).toBe('CLOSED');
    expect(saved.body.data.counts).toMatchObject({ present: 1, late: 1, excused: 1, absent: 1, unmarked: 0 });
    const absent = saved.body.data.roster.find((r) => r.studentId === students[3].user.id);
    expect(absent.record).toMatchObject({ status: 'ABSENT', method: 'AUTO_ABSENT' });
  });

  it('requires a reason to change a status after the session closed, and audits the change', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {})).body.data.id;
    await teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'ABSENT' }], close: true });

    const noReason = await teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'PRESENT' }] });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.details.fields.reason).toBeTruthy();

    const fixed = await teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'PRESENT' }], reason: 'Student was in the room; marked by mistake' });
    expect(fixed.status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'attendance.record.correct', classId: cls.id } });
    expect(log.before).toMatchObject({ status: 'ABSENT' });
    expect(log.after).toMatchObject({ status: 'PRESENT' });
    expect(log.summary).toContain('marked by mistake');
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'attendance.corrected' } })).toBe(1);
  });

  it('rejects students who are not in the class and duplicate rows', async () => {
    const { teacher, cls, students } = await classroom(1);
    const outsider = await actor('STUDENT');
    const id = (await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {})).body.data.id;
    expect((await teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: outsider.user.id, status: 'PRESENT' }] })).status).toBe(422);
    const dup = await teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'PRESENT' }, { studentId: students[0].user.id, status: 'LATE' }] });
    expect(dup.status).toBe(422);
  });

  it('does not allow two sessions for the same class at the same time', async () => {
    const { teacher, cls } = await classroom(0);
    expect((await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {})).status).toBe(201);
    const second = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SESSION_OVERLAP');
  });

  it('is managed only by the class teacher', async () => {
    const { teacher, cls, students } = await classroom(1);
    const other = await actor('TEACHER');
    const id = (await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, {})).body.data.id;
    expect((await other.post(`/api/classes/${cls.id}/attendance/sessions`, {})).status).toBe(404);
    expect((await other.get(`/api/attendance/sessions/${id}`)).status).toBe(404);
    expect((await other.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'PRESENT' }] })).status).toBe(404);
    expect((await students[0].post(`/api/classes/${cls.id}/attendance/sessions`, {})).status).toBe(403);
    expect((await students[0].put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: students[0].user.id, status: 'PRESENT' }] })).status).toBe(403);
    expect((await students[0].get(`/api/attendance/sessions/${id}/qr`)).status).toBe(403);
    expect((await students[0].get(`/api/attendance/sessions/${id}/attempts`)).status).toBe(403);
  });
});

describe('attendance code', () => {
  it('checks a student in once, marks late arrivals, and refuses wrong or expired codes', async () => {
    const { teacher, cls, students } = await classroom(3);
    const created = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowCode: true, lateAfterMinutes: 10, durationMinutes: 60 });
    const { id, code } = created.body.data;
    expect(code).toMatch(/^\d{6}$/);

    const ok = await students[0].post('/api/attendance/check-in', { code });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'RECORDED', record: { status: 'PRESENT', method: 'CODE' } });
    const again = await students[0].post('/api/attendance/check-in', { code });
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('ALREADY_RECORDED');
    expect(await prisma.attendanceRecord.count({ where: { sessionId: id } })).toBe(1);

    const wrong = await students[1].post('/api/attendance/check-in', { code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('CODE_INVALID');

    // Past the late cut-off → LATE.
    await prisma.attendanceSession.update({ where: { id }, data: { lateAfter: minutesFromNow(-1) } });
    const late = await students[1].post('/api/attendance/check-in', { code });
    expect(late.body.data.record.status).toBe('LATE');

    await prisma.attendanceSession.update({ where: { id }, data: { codeExpiresAt: minutesFromNow(-1) } });
    const expired = await students[2].post('/api/attendance/check-in', { code });
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('CODE_EXPIRED');
    // A fresh code works again.
    const fresh = await teacher.post(`/api/attendance/sessions/${id}/code`, { ttlMinutes: 5 });
    expect((await students[2].post('/api/attendance/check-in', { code: fresh.body.data.code })).status).toBe(201);
  });

  it('only matches sessions of the student\'s own classes', async () => {
    const { teacher, cls } = await classroom(0);
    const outsider = await actor('STUDENT');
    const { code } = (await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowCode: true })).body.data;
    const res = await outsider.post('/api/attendance/check-in', { code });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CODE_INVALID');
  });
});

describe('rotating QR code', () => {
  it('produces tokens that verify now, expire after the grace window, and cannot be forged', async () => {
    const session = { id: 'sess1', allowQr: true, qrSecret: 'top-secret', qrRotationSeconds: 20, endTime: minutesFromNow(30) };
    const t0 = new Date('2026-11-11T08:00:05Z');
    const { token, expiresInMs } = currentQrToken(session, t0);
    expect(expiresInMs).toBe(15_000);
    const parsed = extractQrToken(token);
    expect(checkQrToken(session, parsed, t0)).toBe('OK');
    expect(checkQrToken(session, parsed, new Date(t0.getTime() + 20_000))).toBe('OK'); // previous window: grace
    expect(checkQrToken(session, parsed, new Date(t0.getTime() + 40_000))).toBe('EXPIRED');
    expect(currentQrToken(session, new Date(t0.getTime() + 20_000)).token).not.toBe(token);
    // Tampering with any part breaks the signature.
    expect(checkQrToken(session, { ...parsed, counter: parsed.counter + 1 }, new Date(t0.getTime() + 20_000))).toBe('INVALID');
    expect(checkQrToken({ ...session, qrSecret: 'other' }, parsed, t0)).toBe('INVALID');
    expect(extractQrToken('garbage')).toBeNull();
    expect(extractQrToken(`http://localhost:5173/attendance/scan?t=${encodeURIComponent(token)}`)).toEqual(parsed);
  });

  it('records attendance from a fresh code and rejects an expired one', async () => {
    const { teacher, cls, students } = await classroom(2);
    const created = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowQr: true, qrRotationSeconds: 15 });
    const id = created.body.data.id;
    const code = await qr(teacher, id);
    expect(code.rotationSeconds).toBe(15);
    expect(code.url).toContain('/attendance/scan?t=');

    const ok = await students[0].post('/api/attendance/check-in', { token: code.url });
    expect(ok.status).toBe(201);
    expect(ok.body.data.record.method).toBe('QR');

    // A token from two windows ago (e.g. a photo sent to a friend) is refused and logged.
    const session = await prisma.attendanceSession.findUnique({ where: { id } });
    const stale = currentQrToken(session, new Date(Date.now() - 45_000)).token;
    const expired = await students[1].post('/api/attendance/check-in', { token: stale });
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('QR_EXPIRED');
    const forged = await students[1].post('/api/attendance/check-in', { token: `${id}.${Math.floor(Date.now() / 15000)}.AAAAAAAAAAAAAAAAAAAAAAAAAAA` });
    expect(forged.body.error.code).toBe('QR_INVALID');
    const attempts = await teacher.get(`/api/attendance/sessions/${id}/attempts`);
    expect(attempts.body.data.filter((a) => a.outcome === 'REJECTED').map((a) => a.reason).sort()).toEqual(['QR_EXPIRED', 'QR_INVALID']);
  });

  it('is useless to a student who is not enrolled', async () => {
    const { teacher, cls } = await classroom(0);
    const outsider = await actor('STUDENT');
    const id = (await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowQr: true })).body.data.id;
    const res = await outsider.post('/api/attendance/check-in', { token: (await qr(teacher, id)).token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ENROLLED');
    expect(await prisma.attendanceRecord.count({ where: { sessionId: id } })).toBe(0);
  });
});

describe('GPS-verified attendance', () => {
  it('validates the teacher\'s set-up against the administrator\'s limits', async () => {
    const { teacher, cls } = await classroom(0);
    const noLocation = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowQr: true, requireLocation: true });
    expect(noLocation.status).toBe(422);
    expect(noLocation.body.error.details.fields.location).toBeTruthy();
    expect((await startGps(teacher, cls, { radiusMeters: 5 })).body.error.details.fields.radiusMeters).toMatch(/between 10 m and 300 m/);
    expect((await startGps(teacher, cls, { radiusMeters: 301 })).status).toBe(422);
    expect((await startGps(teacher, cls, { qrRotationSeconds: 0 })).body.error.details.fields.qrRotationSeconds).toBeTruthy();
    expect((await startGps(teacher, cls, { location: { latitude: 91, longitude: 0 } })).status).toBe(422);
    const manualOnly = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { requireLocation: true, location: ROOM });
    expect(manualOnly.status).toBe(422);

    await setSetting('attendance.maxRadiusMeters', 100);
    try {
      expect((await startGps(teacher, cls, { radiusMeters: 150 })).status).toBe(422);
      expect((await startGps(teacher, cls, { radiusMeters: 100 })).status).toBe(201);
    } finally {
      await clearSetting('attendance.maxRadiusMeters');
    }
  });

  it('accepts students inside the radius and rejects the one outside (18 m, 42 m, 130 m)', async () => {
    const { teacher, cls, students } = await classroom(3);
    const created = await startGps(teacher, cls);
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.location).toMatchObject({ radiusMeters: 50, maxAccuracyMeters: 100 });
    const { token } = await qr(teacher, id);

    const a = await students[0].post('/api/attendance/check-in', { token, location: fix(18) });
    const b = await students[1].post('/api/attendance/check-in', { token, location: fix(42) });
    const c = await students[2].post('/api/attendance/check-in', { token, location: fix(130) });
    expect(a.status).toBe(201);
    expect(a.body.data.record).toMatchObject({ status: 'PRESENT', method: 'QR_GPS' });
    expect(b.status).toBe(201);
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('OUTSIDE_RADIUS');
    expect(c.body.error.details).toMatchObject({ distanceMeters: 130, radiusMeters: 50, retryable: false });

    // The teacher's monitor shows the verified distance, and the rejected attempt.
    const detail = (await teacher.get(`/api/attendance/sessions/${id}`)).body.data;
    expect(detail.counts).toMatchObject({ present: 2, unmarked: 1 });
    const row = (s) => detail.roster.find((r) => r.studentId === s.user.id);
    expect(row(students[0]).record.distanceMeters).toBe(18);
    expect(row(students[1]).record.distanceMeters).toBe(42);
    expect(row(students[2]).record).toBeNull();
    expect(detail.rejectedAttempts).toHaveLength(1);
    expect(detail.rejectedAttempts[0]).toMatchObject({ studentId: students[2].user.id, reason: 'OUTSIDE_RADIUS', distanceMeters: 130 });
  });

  it('never trusts a distance reported by the browser', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const res = await students[0].post('/api/attendance/check-in', { token, location: { ...fix(400), distance: 3, distanceMeters: 3, withinRadius: true }, distanceMeters: 3 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUTSIDE_RADIUS');
  });

  it('asks for the location after the QR is verified and completes with the ticket', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const step1 = await students[0].post('/api/attendance/check-in', { token });
    expect(step1.status).toBe(200);
    expect(step1.body.data.status).toBe('LOCATION_REQUIRED');
    expect(step1.body.data.session.radiusMeters).toBe(50);
    const { ticket } = step1.body.data;

    // The ticket belongs to the student who scanned: nobody else can use it.
    const stolen = await students[1].post('/api/attendance/check-in', { ticket, location: fix(5) });
    expect(stolen.status).toBe(422);
    expect(stolen.body.error.code).toBe('TICKET_EXPIRED');

    const step2 = await students[0].post('/api/attendance/check-in', { ticket, location: fix(5) });
    expect(step2.status).toBe(201);
    expect(step2.body.data.record.method).toBe('QR_GPS');
  });

  it('asks for a retry when the GPS reading is too vague, then accepts a better one', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const vague = await students[0].post('/api/attendance/check-in', { token, location: fix(10, 250) });
    expect(vague.status).toBe(422);
    expect(vague.body.error.code).toBe('LOW_ACCURACY');
    expect(vague.body.error.details).toMatchObject({ retryable: true, accuracyMeters: 250, requiredAccuracyMeters: 100 });
    expect(await prisma.attendanceRecord.count({ where: { sessionId: id } })).toBe(0);
    // Retry with the ticket from the rejection — no need to scan again.
    const better = await students[0].post('/api/attendance/check-in', { ticket: vague.body.error.details.ticket, location: fix(10, 15) });
    expect(better.status).toBe(201);
    const attempts = (await teacher.get(`/api/attendance/sessions/${id}/attempts`)).body.data;
    expect(attempts.map((a) => `${a.outcome}:${a.reason ?? ''}`).sort()).toEqual(['ACCEPTED:', 'REJECTED:LOW_ACCURACY']);
  });

  it('does not infer presence when the location is missing or unusable', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const noAccuracy = await students[0].post('/api/attendance/check-in', { token, location: { latitude: ROOM.latitude, longitude: ROOM.longitude } });
    expect(noAccuracy.body.error.code).toBe('LOW_ACCURACY');
    const outOfRange = await students[0].post('/api/attendance/check-in', { token, location: { latitude: 123, longitude: 500, accuracy: 5 } });
    expect(outOfRange.body.error.code).toBe('LOCATION_INVALID');
    const text = await students[0].post('/api/attendance/check-in', { token, location: { latitude: 'here', longitude: 'there' } });
    expect(text.status).toBe(422);
    expect(await prisma.attendanceRecord.count({ where: { sessionId: id } })).toBe(0);
  });

  it('prevents duplicate records under concurrent submissions', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const results = await Promise.all(Array.from({ length: 6 }, () => students[0].post('/api/attendance/check-in', { token, location: fix(8) })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || (r.status === 200 && r.body.data.status === 'ALREADY_RECORDED'))).toBe(true);
    expect(await prisma.attendanceRecord.count({ where: { sessionId: id } })).toBe(1);
  });

  it('stops accepting check-ins once the session is closed or its window ends', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    await prisma.attendanceSession.update({ where: { id }, data: { endTime: minutesFromNow(-1) } });
    const ended = await students[0].post('/api/attendance/check-in', { token, location: fix(5) });
    expect(ended.body.error.code).toBe('SESSION_ENDED');

    // The scheduler closes it and marks absences.
    expect(await autoCloseAttendance()).toBeGreaterThanOrEqual(1);
    const closed = await students[0].post('/api/attendance/check-in', { token, location: fix(5) });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'ALREADY_RECORDED', record: { status: 'ABSENT' } });
    expect((await teacher.get(`/api/attendance/sessions/${id}/qr`)).status).toBe(409);
  });

  it('throttles repeated failures', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    let last;
    for (let i = 0; i < 9; i += 1) last = await students[0].post('/api/attendance/check-in', { token, location: fix(500) });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('never stores or exposes coordinates, and shows students nothing about each other', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    const where = fix(21);
    await students[0].post('/api/attendance/check-in', { token, location: where });

    // No table has a place for a student's coordinates; only distance and accuracy are kept.
    const record = await prisma.attendanceRecord.findFirst({ where: { sessionId: id } });
    expect(Object.keys(record)).not.toEqual(expect.arrayContaining(['latitude', 'longitude']));
    expect(record.distanceMeters).toBeCloseTo(21, 0);
    const everything = JSON.stringify([
      await prisma.attendanceRecord.findMany({ where: { sessionId: id } }),
      await prisma.attendanceAttempt.findMany({ where: { sessionId: id } }),
      await prisma.auditLog.findMany({ where: { classId: cls.id } }),
    ]);
    expect(everything).not.toContain(String(where.latitude));

    // The other student sees the session without the classroom coordinates or anyone's record.
    const view = await students[1].get(`/api/attendance/sessions/${id}`);
    expect(view.status).toBe(200);
    const body = JSON.stringify(view.body);
    expect(body).not.toContain(String(ROOM.latitude));
    expect(body).not.toContain(students[0].user.id);
    expect(view.body.data.roster).toBeUndefined();
    expect(view.body.data.record).toBeNull();
    const active = await students[1].get('/api/attendance/active');
    expect(JSON.stringify(active.body)).not.toContain(String(ROOM.longitude));
    const mine = await students[1].get(`/api/attendance/mine?classId=${cls.id}`);
    expect(JSON.stringify(mine.body)).not.toContain(students[0].user.id);
    // Summary: a student gets only their own row.
    const summary = await students[1].get(`/api/classes/${cls.id}/attendance/summary`);
    expect(summary.body.data.students.map((s) => s.id)).toEqual([students[1].user.id]);
  });

  it('lets the teacher authorise an alternative, with a reason, on the record', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const body = { records: [{ studentId: students[0].user.id, status: 'PRESENT' }] };
    const noReason = await teacher.put(`/api/attendance/sessions/${id}/records`, body);
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.details.fields.reason).toMatch(/without location verification/);
    const ok = await teacher.put(`/api/attendance/sessions/${id}/records`, { ...body, reason: 'Phone has no GPS; seen in class' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.roster[0].record).toMatchObject({ status: 'PRESENT', method: 'TEACHER_OVERRIDE', overrideReason: 'Phone has no GPS; seen in class', distanceMeters: null });
    expect(await prisma.auditLog.count({ where: { action: 'attendance.record.override', classId: cls.id } })).toBe(1);
    // Marking absent needs no justification.
    const { students: [other], teacher: t2, cls: c2 } = await classroom(1);
    const id2 = (await startGps(t2, c2)).body.data.id;
    expect((await t2.put(`/api/attendance/sessions/${id2}/records`, { records: [{ studentId: other.user.id, status: 'ABSENT' }] })).status).toBe(200);
  });

  it('reuses saved classroom locations, which belong to their teacher', async () => {
    const { teacher, cls } = await classroom(0);
    const other = await actor('TEACHER');
    const saved = await teacher.post('/api/attendance/locations', { name: 'Room 204', ...ROOM, defaultRadiusMeters: 75 });
    expect(saved.status).toBe(201);
    expect((await other.get('/api/attendance/locations')).body.data).toHaveLength(0);
    expect((await other.delete(`/api/attendance/locations/${saved.body.data.id}`)).status).toBe(404);
    const otherClass = await createClass(other.user);
    const stolen = await other.post(`/api/classes/${otherClass.id}/attendance/sessions`, { allowQr: true, requireLocation: true, location: { savedLocationId: saved.body.data.id } });
    expect(stolen.status).toBe(422);

    const session = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { allowQr: true, requireLocation: true, location: { savedLocationId: saved.body.data.id } });
    expect(session.status).toBe(201);
    expect(session.body.data.location).toMatchObject({ ...ROOM, radiusMeters: 75 });
    expect((await teacher.post('/api/attendance/locations', { name: 'Too wide', ...ROOM, defaultRadiusMeters: 5000 })).status).toBe(422);
  });

  it('erases distance data after the retention period but keeps the attendance status', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await startGps(teacher, cls)).body.data.id;
    const { token } = await qr(teacher, id);
    await students[0].post('/api/attendance/check-in', { token, location: fix(30) });
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.attendanceRecord.updateMany({ where: { sessionId: id }, data: { createdAt: old } });
    await prisma.attendanceAttempt.updateMany({ where: { sessionId: id }, data: { attemptedAt: old } });
    await applyLocationRetention();
    const record = await prisma.attendanceRecord.findFirst({ where: { sessionId: id } });
    expect(record).toMatchObject({ status: 'PRESENT', distanceMeters: null, reportedAccuracyMeters: null });
    expect(await prisma.attendanceAttempt.count({ where: { sessionId: id } })).toBe(0);
  });
});

describe('correction and excuse requests', () => {
  async function closedSession() {
    const room = await classroom(2);
    const id = (await room.teacher.post(`/api/classes/${room.cls.id}/attendance/sessions`, {})).body.data.id;
    await room.teacher.put(`/api/attendance/sessions/${id}/records`, { records: [{ studentId: room.students[0].user.id, status: 'ABSENT' }], close: true });
    return { ...room, id };
  }

  it('lets a student ask, the teacher approve, and updates the record with an audit entry', async () => {
    const { teacher, cls, students, id } = await closedSession();
    const upload = await students[0].upload([{ name: 'medical.pdf', content: '%PDF-1.4 medical certificate' }]);
    const req = await students[0].post(`/api/attendance/sessions/${id}/corrections`, { type: 'EXCUSE', reason: 'I had a medical appointment; certificate attached.', fileIds: [upload.body.data[0].id] });
    expect(req.status).toBe(201);
    expect(req.body.data).toMatchObject({ status: 'PENDING', requestedStatus: 'EXCUSED' });
    expect(req.body.data.files).toHaveLength(1);
    const second = await students[0].post(`/api/attendance/sessions/${id}/corrections`, { type: 'EXCUSE', reason: 'Sending the same request again.' });
    expect(second.status).toBe(409);

    // The teacher can open the attachment; a classmate cannot.
    expect((await teacher.get(`/api/files/${upload.body.data[0].id}`)).status).toBe(200);
    expect((await students[1].get(`/api/files/${upload.body.data[0].id}`)).status).toBe(404);

    const queue = await teacher.get(`/api/attendance/corrections?classId=${cls.id}&status=PENDING`);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0]).toMatchObject({ currentStatus: 'ABSENT', student: { id: students[0].user.id } });

    const approve = await teacher.post(`/api/attendance/corrections/${req.body.data.id}/approve`, { note: 'Certificate verified' });
    expect(approve.status).toBe(200);
    const record = await prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: id, studentId: students[0].user.id } } });
    expect(record).toMatchObject({ status: 'EXCUSED', verificationMethod: 'CORRECTION_APPROVED' });
    expect(await prisma.auditLog.count({ where: { action: 'attendance.correction.approve', classId: cls.id } })).toBe(1);
    expect((await teacher.post(`/api/attendance/corrections/${req.body.data.id}/approve`, {})).status).toBe(409);
    // Excused sessions do not count against the student.
    const mine = await students[0].get(`/api/attendance/mine?classId=${cls.id}`);
    expect(mine.body.data.classes[0]).toMatchObject({ excused: 1, absent: 0, rate: null });
  });

  it('requires a note to decline, and only the class teacher may decide', async () => {
    const { teacher, students, id } = await closedSession();
    const req = await students[0].post(`/api/attendance/sessions/${id}/corrections`, { type: 'CORRECTION', requestedStatus: 'PRESENT', reason: 'I was present but arrived after the roll call.' });
    const other = await actor('TEACHER');
    expect((await other.post(`/api/attendance/corrections/${req.body.data.id}/approve`, {})).status).toBe(404);
    expect((await students[1].post(`/api/attendance/corrections/${req.body.data.id}/approve`, {})).status).toBe(403);
    expect((await teacher.post(`/api/attendance/corrections/${req.body.data.id}/reject`, {})).status).toBe(422);
    expect((await teacher.post(`/api/attendance/corrections/${req.body.data.id}/reject`, { note: 'Not on the CCTV log' })).status).toBe(200);
    const record = await prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: id, studentId: students[0].user.id } } });
    expect(record.status).toBe('ABSENT');
    // Students see only their own requests.
    expect((await students[1].get('/api/attendance/corrections')).body.data).toHaveLength(0);
    expect((await students[0].get('/api/attendance/corrections')).body.data[0]).toMatchObject({ status: 'REJECTED', reviewNote: 'Not on the CCTV log' });
  });

  it('cannot be used to request an absence or by students outside the class', async () => {
    const { students, id } = await closedSession();
    const outsider = await actor('STUDENT');
    expect((await outsider.post(`/api/attendance/sessions/${id}/corrections`, { type: 'EXCUSE', reason: 'I am not even in this class.' })).status).toBe(404);
    const bad = await students[0].post(`/api/attendance/sessions/${id}/corrections`, { type: 'CORRECTION', requestedStatus: 'ABSENT', reason: 'Please mark me absent, thank you.' });
    expect(bad.status).toBe(422);
  });
});

describe('summary and exports', () => {
  it('computes rates and exports CSV, Excel and PDF for the teacher only', async () => {
    const { teacher, cls, students } = await classroom(2);
    for (const [i, statuses] of [['PRESENT', 'ABSENT'], ['LATE', 'EXCUSED'], ['PRESENT', 'PRESENT']].entries()) {
      const s = await prisma.attendanceSession.create({
        data: { classId: cls.id, teacherId: teacher.user.id, date: new Date(`2026-11-0${i + 2}T00:00:00Z`), startTime: new Date(`2026-11-0${i + 2}T00:00:00Z`), endTime: new Date(`2026-11-0${i + 2}T01:00:00Z`), status: 'CLOSED', qrSecret: 'x' },
      });
      await prisma.attendanceRecord.createMany({ data: statuses.map((status, j) => ({ sessionId: s.id, studentId: students[j].user.id, status, verificationMethod: 'MANUAL' })) });
    }
    const summary = (await teacher.get(`/api/classes/${cls.id}/attendance/summary`)).body.data;
    const row = (s) => summary.students.find((x) => x.id === s.user.id);
    expect(row(students[0])).toMatchObject({ present: 2, late: 1, absent: 0, rate: 100 });
    expect(row(students[1])).toMatchObject({ present: 1, absent: 1, excused: 1, rate: 50 });

    const csv = await teacher.get(`/api/classes/${cls.id}/attendance/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('Student No.,Name,11-02');
    expect(csv.text).toMatch(/,P,L,P,2,1,0,0,100/);

    const xlsx = await teacher.get(`/api/classes/${cls.id}/attendance/export?format=xlsx`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(xlsx.status).toBe(200);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');
    const pdf = await teacher.get(`/api/classes/${cls.id}/attendance/export?format=pdf`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toMatch(/attachment; filename="attendance-.*\.pdf"/);

    expect((await students[0].get(`/api/classes/${cls.id}/attendance/export?format=csv`)).status).toBe(403);
    expect((await (await actor('TEACHER')).get(`/api/classes/${cls.id}/attendance/export`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.export', classId: cls.id } })).toBe(3);
  });
});
