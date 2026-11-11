// Attendance API: sessions (manual, code, QR, QR + GPS), student check-in, corrections, exports.
import { Router } from 'express';
import { env } from '../../config/env.js';
import { z } from 'zod';
import { lockKey, prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { exportFormat, sendTable } from '../../lib/exporter.js';
import { created, fullName, idParams, noContent, ok, patchOf, round, zDateKey, zId, zTime } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { addDays, atTime, dateKey, dateKeyToDb, timeKey } from '../../lib/time.js';
import { randomDigits, randomToken } from '../../lib/tokens.js';
import { assertPermission, requireAuth, requireRole } from '../../middleware/auth.js';
import { checkInLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { emitToRoom } from '../../services/realtime.js';
import { getTimeZone } from '../../services/settings.js';
import { attachFiles, fileSummary } from '../../services/storage.js';
import { assertClassWritable, classIdsFor, classLabel, loadClassAccess, requireClassManager, requireWritableClassManager } from '../classes/access.js';
import {
  STATUSES, attendancePolicy, attendanceRate, checkIn, classAttendanceSummary, closeSession, currentQrToken, recordView,
  sessionCounts, studentSessionView, teacherRecordView,
} from './service.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);
export const classAttendanceRouter = Router({ mergeParams: true });
classAttendanceRouter.use(requireAuth);

const classParams = idParams('classId');
const sessionParams = idParams('sessionId');
const statusEnum = z.enum(STATUSES);

const METHOD_LABELS = {
  MANUAL: 'Marked by teacher', CODE: 'Attendance code', QR: 'QR code', QR_GPS: 'QR code + location',
  TEACHER_OVERRIDE: 'Teacher override', CORRECTION_APPROVED: 'Approved correction', AUTO_ABSENT: 'Not checked in',
};

// ── Policy and saved classroom locations ─────────────────────────────────────
// Limits for location checks, plus the map tiles the browser should use when a teacher picks a spot.
attendanceRouter.get('/policy', async (req, res) => ok(res, { ...(await attendancePolicy()), map: env.map }));

const locationBody = z.object({
  name: z.string().trim().min(1, 'Give this location a name').max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  defaultRadiusMeters: z.number().int().optional(),
  classId: zId.nullable().optional(),
});

const locationView = (l) => ({
  id: l.id, name: l.name, latitude: l.latitude, longitude: l.longitude, defaultRadiusMeters: l.defaultRadiusMeters, classId: l.classId,
});

async function assertRadius(radius, field = 'radiusMeters') {
  const policy = await attendancePolicy();
  if (radius < policy.minRadiusMeters || radius > policy.maxRadiusMeters) {
    throw fieldErrors({ [field]: `Choose a radius between ${policy.minRadiusMeters} m and ${policy.maxRadiusMeters} m (set by the administrator).` });
  }
  return policy;
}

attendanceRouter.get('/locations', requireRole('TEACHER', 'ADMIN'), async (req, res) => {
  const rows = await prisma.classroomLocation.findMany({ where: { teacherId: req.user.id }, orderBy: { name: 'asc' } });
  ok(res, rows.map(locationView));
});

attendanceRouter.post('/locations', requireRole('TEACHER', 'ADMIN'), validate({ body: locationBody }), async (req, res) => {
  const body = req.valid.body;
  const policy = await attendancePolicy();
  const radius = body.defaultRadiusMeters ?? policy.defaultRadiusMeters;
  await assertRadius(radius, 'defaultRadiusMeters');
  if (body.classId) await requireClassManager(req.user, body.classId);
  const row = await prisma.classroomLocation.create({
    data: { teacherId: req.user.id, classId: body.classId ?? null, name: plainText(body.name, 80), latitude: body.latitude, longitude: body.longitude, defaultRadiusMeters: radius },
  });
  created(res, locationView(row));
});

attendanceRouter.patch('/locations/:locationId', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('locationId'), body: patchOf(locationBody) }), async (req, res) => {
  const existing = await prisma.classroomLocation.findUnique({ where: { id: req.valid.params.locationId } });
  if (!existing || existing.teacherId !== req.user.id) throw notFound('Location');
  const body = req.valid.body;
  if (body.defaultRadiusMeters !== undefined) await assertRadius(body.defaultRadiusMeters, 'defaultRadiusMeters');
  if (body.classId) await requireClassManager(req.user, body.classId);
  const row = await prisma.classroomLocation.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined ? { name: plainText(body.name, 80) } : {}),
      ...(body.latitude !== undefined ? { latitude: body.latitude } : {}),
      ...(body.longitude !== undefined ? { longitude: body.longitude } : {}),
      ...(body.defaultRadiusMeters !== undefined ? { defaultRadiusMeters: body.defaultRadiusMeters } : {}),
      ...(body.classId !== undefined ? { classId: body.classId } : {}),
    },
  });
  ok(res, locationView(row));
});

attendanceRouter.delete('/locations/:locationId', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('locationId') }), async (req, res) => {
  const existing = await prisma.classroomLocation.findUnique({ where: { id: req.valid.params.locationId } });
  if (!existing || existing.teacherId !== req.user.id) throw notFound('Location');
  // Sessions keep their own copy of the coordinates, so removing a saved place never alters history.
  await prisma.classroomLocation.delete({ where: { id: existing.id } });
  noContent(res);
});

// ── Sessions ─────────────────────────────────────────────────────────────────
const sessionListView = (s, counts) => ({
  id: s.id,
  classId: s.classId,
  classLabel: s.class ? classLabel(s.class) : undefined,
  title: s.title,
  date: s.date.toISOString().slice(0, 10),
  startTime: s.startTime,
  endTime: s.endTime,
  lateAfter: s.lateAfter,
  status: s.status,
  allowCode: s.allowCode,
  allowQr: s.allowQr,
  requireLocation: s.requireLocation,
  radiusMeters: s.radiusMeters,
  closedAt: s.closedAt,
  cancelReason: s.cancelReason,
  ...(counts ? { counts } : {}),
});

async function countsFor(sessions) {
  if (sessions.length === 0) return new Map();
  const grouped = await prisma.attendanceRecord.groupBy({
    by: ['sessionId', 'status'], where: { sessionId: { in: sessions.map((s) => s.id) } }, _count: { _all: true },
  });
  const map = new Map(sessions.map((s) => [s.id, { present: 0, late: 0, absent: 0, excused: 0 }]));
  for (const g of grouped) map.get(g.sessionId)[g.status.toLowerCase()] = g._count._all;
  return map;
}

const classInclude = { class: { include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } } };

// Teacher / admin: sessions across the classes they manage.
attendanceRouter.get(
  '/sessions',
  requireRole('TEACHER', 'ADMIN'),
  validate({ query: z.object({ classId: zId.optional(), status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }) }),
  async (req, res) => {
    const q = req.valid.query;
    const classIds = q.classId ? [(await requireClassManager(req.user, q.classId)).cls.id] : await classIdsFor(req.user);
    const sessions = await prisma.attendanceSession.findMany({
      where: { classId: { in: classIds }, ...(q.status ? { status: q.status } : {}) },
      include: classInclude,
      orderBy: { startTime: 'desc' },
      take: q.limit,
    });
    const counts = await countsFor(sessions);
    ok(res, sessions.map((s) => sessionListView(s, counts.get(s.id))));
  },
);

classAttendanceRouter.get('/sessions', validate({ params: classParams }), async (req, res) => {
  const { classId } = req.valid.params;
  await requireClassManager(req.user, classId);
  const sessions = await prisma.attendanceSession.findMany({ where: { classId }, orderBy: { startTime: 'desc' }, take: 300 });
  const counts = await countsFor(sessions);
  ok(res, sessions.map((s) => sessionListView(s, counts.get(s.id))));
});

const createBody = z.object({
  title: z.string().trim().max(120).optional(),
  date: zDateKey.optional(),
  startTime: zTime.optional(),
  endTime: zTime.optional(),
  durationMinutes: z.number().int().min(5, 'At least 5 minutes').max(720).optional(),
  lateAfterMinutes: z.number().int().min(0).max(720).nullable().optional(),
  allowCode: z.boolean().default(false),
  allowQr: z.boolean().default(false),
  requireLocation: z.boolean().default(false),
  codeTtlMinutes: z.number().int().min(1).max(720).nullable().optional(),
  qrRotationSeconds: z.number().int().optional(),
  location: z
    .object({
      savedLocationId: zId.optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      name: z.string().trim().max(80).optional(),
      save: z.boolean().optional(),
    })
    .optional(),
  radiusMeters: z.number().int().optional(),
  notes: z.string().trim().max(1000).optional(),
});

classAttendanceRouter.post('/sessions', validate({ params: classParams, body: createBody }), async (req, res) => {
  const { classId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const body = req.valid.body;
  const policy = await attendancePolicy();
  const tz = await getTimeZone();
  const now = new Date();

  // ── When ──
  const today = dateKey(now, tz);
  const date = body.date ?? today;
  if (date > addDays(today, 60) || date < addDays(today, -400)) throw fieldErrors({ date: 'Choose a date closer to today.' });
  const startTime = body.startTime ? atTime(date, body.startTime, tz) : date === today ? now : atTime(date, '08:00', tz);
  let endTime;
  if (body.endTime) {
    endTime = atTime(date, body.endTime, tz);
    if (endTime <= startTime) throw fieldErrors({ endTime: 'The end time must be after the start time.' });
  } else {
    endTime = new Date(startTime.getTime() + (body.durationMinutes ?? 60) * 60_000);
  }
  let lateAfter = null;
  if (body.lateAfterMinutes !== undefined && body.lateAfterMinutes !== null) {
    lateAfter = new Date(startTime.getTime() + body.lateAfterMinutes * 60_000);
    if (lateAfter >= endTime) throw fieldErrors({ lateAfterMinutes: 'The late cut-off must fall before the session ends.' });
  }

  // ── How ──
  const selfCheckIn = body.allowCode || body.allowQr;
  if (selfCheckIn && endTime <= now) {
    throw fieldErrors({ endTime: 'This session has already ended, so students could not check in. Record it manually instead.' });
  }
  if (body.requireLocation && !selfCheckIn) {
    throw fieldErrors({ requireLocation: 'Location verification needs a QR code or an attendance code for students to check in with.' });
  }
  let qrRotationSeconds = 0;
  if (body.allowQr) {
    qrRotationSeconds = body.qrRotationSeconds ?? (policy.qrRotationSeconds || (body.requireLocation ? 20 : 0));
    const valid = qrRotationSeconds === 0 ? !body.requireLocation : qrRotationSeconds >= 15 && qrRotationSeconds <= 60;
    if (!valid) {
      throw fieldErrors({ qrRotationSeconds: body.requireLocation ? 'With location verification the QR code must rotate every 15–60 seconds.' : 'Use 0 (fixed code) or 15–60 seconds.' });
    }
  }

  // ── Where ──
  let geo = { latitude: null, longitude: null, radiusMeters: null, maxAccuracyMeters: null, classroomLocationId: null };
  let saveLocationAs = null;
  if (body.requireLocation) {
    const loc = body.location ?? {};
    let latitude = loc.latitude;
    let longitude = loc.longitude;
    let radius = body.radiusMeters;
    let classroomLocationId = null;
    if (loc.savedLocationId) {
      const saved = await prisma.classroomLocation.findUnique({ where: { id: loc.savedLocationId } });
      if (!saved || saved.teacherId !== cls.teacherId) throw fieldErrors({ location: 'Choose one of your saved locations.' });
      ({ latitude, longitude } = saved);
      radius ??= saved.defaultRadiusMeters;
      classroomLocationId = saved.id;
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      throw fieldErrors({ location: 'Set the classroom location on the map, use your current location, or choose a saved location.' });
    }
    radius ??= policy.defaultRadiusMeters;
    await assertRadius(radius);
    geo = { latitude, longitude, radiusMeters: radius, maxAccuracyMeters: policy.maxAccuracyMeters, classroomLocationId };
    if (loc.save && !loc.savedLocationId) saveLocationAs = plainText(loc.name ?? '', 80) || `${classLabel(cls)} classroom`;
  }

  const session = await prisma.$transaction(async (tx) => {
    // Serialise "start attendance" per class so a double click cannot create two sessions.
    await lockKey(tx, `attendance:${classId}`);
    const overlap = await tx.attendanceSession.findFirst({
      where: { classId, status: { not: 'CANCELLED' }, startTime: { lt: endTime }, endTime: { gt: startTime } },
      select: { id: true, status: true, startTime: true },
    });
    if (overlap) {
      throw conflict(
        overlap.status === 'OPEN'
          ? 'An attendance session for this class is already open at that time. Close it before starting another.'
          : 'There is already an attendance session for this class at that time.',
        'SESSION_OVERLAP',
        { sessionId: overlap.id },
      );
    }
    if (saveLocationAs) {
      const saved = await tx.classroomLocation.create({
        data: { teacherId: cls.teacherId, classId, name: saveLocationAs, latitude: geo.latitude, longitude: geo.longitude, defaultRadiusMeters: geo.radiusMeters },
      });
      geo.classroomLocationId = saved.id;
    }
    const row = await tx.attendanceSession.create({
      data: {
        classId,
        teacherId: req.user.id,
        title: body.title ? plainText(body.title, 120) : null,
        date: dateKeyToDb(date),
        startTime,
        endTime,
        lateAfter,
        allowCode: body.allowCode,
        code: body.allowCode ? randomDigits(6) : null,
        codeExpiresAt: body.allowCode && body.codeTtlMinutes ? new Date(Math.max(now.getTime(), startTime.getTime()) + body.codeTtlMinutes * 60_000) : null,
        allowQr: body.allowQr,
        // Every session has a secret: it signs QR tokens and check-in tickets.
        qrSecret: randomToken(32),
        qrRotationSeconds,
        requireLocation: body.requireLocation,
        ...geo,
        notes: body.notes ? plainText(body.notes, 1000) : null,
      },
    });
    await audit(req, {
      action: 'attendance.session.create', entityType: 'AttendanceSession', entityId: row.id, classId,
      summary: `Started attendance (${[body.allowQr && 'QR', body.allowCode && 'code', body.requireLocation && `GPS ${geo.radiusMeters} m`].filter(Boolean).join(' + ') || 'manual'})`,
    }, tx);
    return row;
  });

  if (selfCheckIn && startTime <= new Date(now.getTime() + 15 * 60_000)) {
    await notify(await enrolledStudentIds(classId), {
      type: 'attendance.open',
      title: `Attendance is open for ${classLabel(cls)}`,
      body: body.requireLocation ? 'Scan the QR code shown by your teacher. Your location will be verified.' : 'Check in with the code or QR shown by your teacher.',
      link: '/attendance/scan',
      classId,
    });
  }
  created(res, await teacherSessionDetail(session.id));
});

// ── Session detail ───────────────────────────────────────────────────────────
async function loadSession(sessionId) {
  const session = await prisma.attendanceSession.findUnique({ where: { id: sessionId }, include: classInclude });
  if (!session) throw notFound('Attendance session');
  return session;
}

/** Load a session the user manages (404 for everyone else). */
async function loadManagedSession(req, { writable = false } = {}) {
  const session = await loadSession(req.valid.params.sessionId);
  const access = await requireClassManager(req.user, session.classId);
  if (writable) assertClassWritable(access.cls);
  return session;
}

async function teacherSessionDetail(sessionId) {
  const session = await loadSession(sessionId);
  const [enrollments, records, attempts, pendingCorrections, counts] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: session.classId, status: 'ENROLLED' },
      select: { student: { select: { id: true, firstName: true, lastName: true, avatarFileId: true, studentProfile: { select: { studentNumber: true } } } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    }),
    prisma.attendanceRecord.findMany({
      where: { sessionId },
      include: { student: { select: { id: true, firstName: true, lastName: true, avatarFileId: true, studentProfile: { select: { studentNumber: true } } } } },
    }),
    prisma.attendanceAttempt.findMany({
      where: { sessionId, outcome: 'REJECTED' },
      include: { student: { select: { firstName: true, lastName: true } } },
      orderBy: { attemptedAt: 'desc' },
      take: 100,
    }),
    prisma.attendanceCorrectionRequest.count({ where: { sessionId, status: 'PENDING' } }),
    sessionCounts(sessionId, session.classId),
  ]);
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));
  const people = new Map(enrollments.map((e) => [e.student.id, e.student]));
  // Students who have a record but are no longer enrolled still appear, so history stays complete.
  for (const r of records) if (!people.has(r.studentId)) people.set(r.studentId, r.student);
  const rejectedByStudent = new Map();
  for (const a of attempts) rejectedByStudent.set(a.studentId, (rejectedByStudent.get(a.studentId) ?? 0) + 1);

  return {
    ...sessionListView(session, counts),
    notes: session.notes,
    code: session.allowCode ? session.code : null,
    codeExpiresAt: session.codeExpiresAt,
    qrRotationSeconds: session.qrRotationSeconds,
    // The classroom location belongs to the teacher and is only ever sent to the class's teacher.
    location: session.requireLocation
      ? { latitude: session.latitude, longitude: session.longitude, radiusMeters: session.radiusMeters, maxAccuracyMeters: session.maxAccuracyMeters, savedLocationId: session.classroomLocationId }
      : null,
    counts,
    pendingCorrections,
    roster: [...people.values()].map((s) => ({
      studentId: s.id,
      name: fullName(s),
      lastName: s.lastName,
      avatarFileId: s.avatarFileId,
      studentNumber: s.studentProfile?.studentNumber ?? null,
      record: teacherRecordView(recordByStudent.get(s.id)),
      rejectedAttempts: rejectedByStudent.get(s.id) ?? 0,
    })),
    rejectedAttempts: attempts.map((a) => ({
      id: a.id,
      studentId: a.studentId,
      studentName: fullName(a.student),
      attemptedAt: a.attemptedAt,
      method: a.method,
      reason: a.rejectionReason,
      distanceMeters: a.distanceMeters === null ? null : round(a.distanceMeters, 0),
      accuracyMeters: a.accuracyMeters === null ? null : round(a.accuracyMeters, 0),
    })),
  };
}

attendanceRouter.get('/sessions/:sessionId', validate({ params: sessionParams }), async (req, res) => {
  const session = await loadSession(req.valid.params.sessionId);
  const access = await loadClassAccess(req.user, session.classId);
  if (access.canManage) return ok(res, await teacherSessionDetail(session.id));
  const [record, corrections] = await Promise.all([
    prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: session.id, studentId: req.user.id } } }),
    prisma.attendanceCorrectionRequest.findMany({ where: { sessionId: session.id, studentId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { files: { where: { deletedAt: null } } } }),
  ]);
  return ok(res, { ...studentSessionView(session, session.class), record: recordView(record), corrections: corrections.map(correctionView) });
});

const patchBody = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  extendMinutes: z.number().int().min(1).max(240).optional(),
  radiusMeters: z.number().int().optional(),
});

attendanceRouter.patch('/sessions/:sessionId', validate({ params: sessionParams, body: patchBody }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  const body = req.valid.body;
  const data = {};
  if (body.title !== undefined) data.title = body.title ? plainText(body.title, 120) : null;
  if (body.notes !== undefined) data.notes = body.notes ? plainText(body.notes, 1000) : null;
  if (body.extendMinutes !== undefined || body.radiusMeters !== undefined) {
    if (session.status !== 'OPEN') throw conflict('Only an open session can be extended or have its radius changed.', 'SESSION_NOT_OPEN');
  }
  if (body.extendMinutes !== undefined) {
    const base = Math.max(session.endTime.getTime(), Date.now());
    data.endTime = new Date(base + body.extendMinutes * 60_000);
    const overlap = await prisma.attendanceSession.findFirst({
      where: { classId: session.classId, id: { not: session.id }, status: { not: 'CANCELLED' }, startTime: { lt: data.endTime }, endTime: { gt: session.startTime } },
      select: { id: true },
    });
    if (overlap) throw conflict('Extending would overlap another attendance session of this class.', 'SESSION_OVERLAP');
  }
  if (body.radiusMeters !== undefined) {
    if (!session.requireLocation) throw fieldErrors({ radiusMeters: 'This session does not verify location.' });
    await assertRadius(body.radiusMeters);
    data.radiusMeters = body.radiusMeters;
  }
  await prisma.attendanceSession.update({ where: { id: session.id }, data });
  if (data.radiusMeters !== undefined || data.endTime !== undefined) {
    await audit(req, {
      action: 'attendance.session.update', entityType: 'AttendanceSession', entityId: session.id, classId: session.classId,
      summary: 'Changed the session window or radius', before: { endTime: session.endTime, radiusMeters: session.radiusMeters }, after: { endTime: data.endTime ?? session.endTime, radiusMeters: data.radiusMeters ?? session.radiusMeters },
    });
  }
  ok(res, await teacherSessionDetail(session.id));
});

attendanceRouter.post('/sessions/:sessionId/close', validate({ params: sessionParams }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  if (session.status === 'CANCELLED') throw conflict('This session was cancelled.', 'SESSION_CANCELLED');
  await closeSession(session.id, req);
  ok(res, await teacherSessionDetail(session.id));
});

attendanceRouter.post('/sessions/:sessionId/reopen', validate({ params: sessionParams, body: z.object({ minutes: z.number().int().min(1).max(240).default(15) }) }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  if (session.status !== 'CLOSED') throw conflict('Only a closed session can be reopened.', 'SESSION_NOT_CLOSED');
  const endTime = new Date(Date.now() + req.valid.body.minutes * 60_000);
  await prisma.$transaction(async (tx) => {
    const overlap = await tx.attendanceSession.findFirst({
      where: { classId: session.classId, id: { not: session.id }, status: { not: 'CANCELLED' }, startTime: { lt: endTime }, endTime: { gt: session.startTime } },
      select: { id: true },
    });
    if (overlap) throw conflict('Reopening would overlap another attendance session of this class.', 'SESSION_OVERLAP');
    await tx.attendanceSession.update({ where: { id: session.id }, data: { status: 'OPEN', closedAt: null, endTime } });
    // Students who were only absent because they had not checked in get another chance.
    await tx.attendanceRecord.deleteMany({ where: { sessionId: session.id, verificationMethod: 'AUTO_ABSENT' } });
    await audit(req, { action: 'attendance.session.reopen', entityType: 'AttendanceSession', entityId: session.id, classId: session.classId, summary: `Reopened attendance for ${req.valid.body.minutes} minutes` }, tx);
  });
  ok(res, await teacherSessionDetail(session.id));
});

attendanceRouter.post('/sessions/:sessionId/cancel', validate({ params: sessionParams, body: z.object({ reason: z.string().trim().min(3, 'Say why the session is being cancelled').max(300) }) }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  if (session.status === 'CANCELLED') throw conflict('This session is already cancelled.', 'SESSION_CANCELLED');
  await prisma.$transaction(async (tx) => {
    await tx.attendanceSession.update({ where: { id: session.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.valid.body.reason } });
    await audit(req, { action: 'attendance.session.cancel', entityType: 'AttendanceSession', entityId: session.id, classId: session.classId, summary: `Cancelled attendance session: ${req.valid.body.reason}` }, tx);
  });
  emitToRoom(`attendance:${session.id}`, 'attendance:update', { sessionId: session.id, type: 'closed' });
  ok(res, await teacherSessionDetail(session.id));
});

// The QR code content. Only the class teacher can fetch it; it changes every rotation window.
attendanceRouter.get('/sessions/:sessionId/qr', validate({ params: sessionParams }), async (req, res) => {
  const session = await loadManagedSession(req);
  if (!session.allowQr) throw conflict('QR check-in is not enabled for this session.', 'QR_DISABLED');
  if (session.status !== 'OPEN') throw conflict('This session is not open.', 'SESSION_NOT_OPEN');
  res.setHeader('Cache-Control', 'no-store');
  ok(res, { ...currentQrToken(session), serverTime: new Date(), endTime: session.endTime });
});

attendanceRouter.post('/sessions/:sessionId/code', validate({ params: sessionParams, body: z.object({ ttlMinutes: z.number().int().min(1).max(720).nullable().optional() }) }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  if (session.status !== 'OPEN') throw conflict('This session is not open.', 'SESSION_NOT_OPEN');
  const ttl = req.valid.body.ttlMinutes;
  const updated = await prisma.attendanceSession.update({
    where: { id: session.id },
    data: { allowCode: true, code: randomDigits(6), codeExpiresAt: ttl ? new Date(Date.now() + ttl * 60_000) : null },
  });
  ok(res, { code: updated.code, codeExpiresAt: updated.codeExpiresAt });
});

// ── Manual marking and corrections by the teacher ────────────────────────────
const recordsBody = z.object({
  records: z.array(z.object({ studentId: zId, status: statusEnum, remarks: z.string().trim().max(300).nullable().optional() })).min(1).max(500),
  reason: z.string().trim().max(300).optional(),
  close: z.boolean().optional(),
});

attendanceRouter.put('/sessions/:sessionId/records', validate({ params: sessionParams, body: recordsBody }), async (req, res) => {
  const session = await loadManagedSession(req, { writable: true });
  if (session.status === 'CANCELLED') throw conflict('This session was cancelled.', 'SESSION_CANCELLED');
  const { records, reason, close } = req.valid.body;
  const ids = [...new Set(records.map((r) => r.studentId))];
  if (ids.length !== records.length) throw fieldErrors({ records: 'A student appears more than once.' });

  const [enrolled, existingRows] = await Promise.all([
    prisma.enrollment.findMany({ where: { classId: session.classId, studentId: { in: ids }, status: 'ENROLLED' }, select: { studentId: true } }),
    prisma.attendanceRecord.findMany({ where: { sessionId: session.id, studentId: { in: ids } } }),
  ]);
  const enrolledIds = new Set(enrolled.map((e) => e.studentId));
  const existing = new Map(existingRows.map((r) => [r.studentId, r]));
  for (const r of records) {
    if (!enrolledIds.has(r.studentId) && !existing.has(r.studentId)) throw fieldErrors({ records: 'One of the students is not enrolled in this class.' });
  }

  const now = new Date();
  const changes = [];
  for (const r of records) {
    const before = existing.get(r.studentId);
    const remarks = r.remarks === undefined ? (before?.remarks ?? null) : r.remarks ? plainText(r.remarks, 300) : null;
    if (before && before.status === r.status && (before.remarks ?? null) === remarks) continue;
    const statusChanged = !before || before.status !== r.status;
    const attending = r.status === 'PRESENT' || r.status === 'LATE';
    // Marking someone present by hand in a location-verified session bypasses the GPS check,
    // so it must be a deliberate, explained and audited decision.
    const isOverride = statusChanged && session.requireLocation && attending;
    // Changing a record after the session closed is a correction and also needs a reason.
    const isCorrection = statusChanged && Boolean(before) && session.status === 'CLOSED' && before.verificationMethod !== 'AUTO_ABSENT';
    if ((isOverride || isCorrection) && (!reason || reason.length < 5)) {
      throw fieldErrors({
        reason: isOverride
          ? 'Explain why you are marking this student present without location verification (at least 5 characters).'
          : 'Give a reason for changing a recorded attendance status (at least 5 characters).',
      });
    }
    changes.push({ studentId: r.studentId, before, status: r.status, remarks, statusChanged, isOverride, isCorrection, attending });
  }

  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      const method = c.statusChanged ? (c.isOverride ? 'TEACHER_OVERRIDE' : 'MANUAL') : c.before.verificationMethod;
      const data = {
        status: c.status,
        remarks: c.remarks,
        verificationMethod: method,
        ...(c.statusChanged
          ? {
              verifiedById: req.user.id,
              overrideReason: c.isOverride || c.isCorrection ? reason : null,
              checkInTime: c.attending ? (c.before?.checkInTime ?? now) : null,
              // A hand-entered status carries no location evidence.
              distanceMeters: null,
              reportedAccuracyMeters: null,
            }
          : {}),
      };
      const row = c.before
        ? await tx.attendanceRecord.update({ where: { id: c.before.id }, data })
        : await tx.attendanceRecord.create({ data: { sessionId: session.id, studentId: c.studentId, ...data, verifiedById: req.user.id } });
      if (c.before ? c.statusChanged : c.isOverride) {
        await audit(req, {
          action: c.isOverride ? 'attendance.record.override' : 'attendance.record.correct',
          entityType: 'AttendanceRecord', entityId: row.id, classId: session.classId,
          summary: `${c.before ? `Changed attendance from ${c.before.status} to ${c.status}` : `Marked ${c.status} without location verification`}${reason ? ` — ${reason}` : ''}`,
          before: c.before ? { status: c.before.status, method: c.before.verificationMethod } : undefined,
          after: { status: c.status, method },
        }, tx);
      }
    }
    if (changes.length > 0 && !changes.some((c) => c.before || c.isOverride)) {
      await audit(req, { action: 'attendance.record.mark', entityType: 'AttendanceSession', entityId: session.id, classId: session.classId, summary: `Marked attendance for ${changes.length} student${changes.length === 1 ? '' : 's'}` }, tx);
    }
  });

  if (close && session.status === 'OPEN') await closeSession(session.id, req);
  else if (changes.length > 0) {
    emitToRoom(`attendance:${session.id}`, 'attendance:update', { sessionId: session.id, type: 'refresh', counts: await sessionCounts(session.id, session.classId) });
  }

  // Tell students whose recorded status was changed after the fact.
  const corrected = changes.filter((c) => c.before && c.statusChanged && session.status === 'CLOSED');
  for (const c of corrected) {
    await notify([c.studentId], {
      type: 'attendance.corrected', title: `Your attendance for ${classLabel(session.class)} was updated`,
      body: `${session.date.toISOString().slice(0, 10)}: ${c.before.status.toLowerCase()} → ${c.status.toLowerCase()}`, link: `/classes/${session.classId}/attendance`, classId: session.classId,
    });
  }
  ok(res, await teacherSessionDetail(session.id));
});

attendanceRouter.get('/sessions/:sessionId/attempts', validate({ params: sessionParams }), async (req, res) => {
  const session = await loadManagedSession(req);
  const attempts = await prisma.attendanceAttempt.findMany({
    where: { sessionId: session.id },
    include: { student: { select: { firstName: true, lastName: true } } },
    orderBy: { attemptedAt: 'desc' },
    take: 500,
  });
  ok(res, attempts.map((a) => ({
    id: a.id, studentId: a.studentId, studentName: fullName(a.student), attemptedAt: a.attemptedAt, method: a.method, outcome: a.outcome, reason: a.rejectionReason,
    distanceMeters: a.distanceMeters === null ? null : round(a.distanceMeters, 0), accuracyMeters: a.accuracyMeters === null ? null : round(a.accuracyMeters, 0),
  })));
});

// ── Student: check in ────────────────────────────────────────────────────────
attendanceRouter.get('/active', requireRole('STUDENT'), async (req, res) => {
  const now = new Date();
  const sessions = await prisma.attendanceSession.findMany({
    where: {
      status: 'OPEN', startTime: { lte: now }, endTime: { gte: now },
      OR: [{ allowCode: true }, { allowQr: true }],
      class: { status: 'ACTIVE', enrollments: { some: { studentId: req.user.id, status: 'ENROLLED' } } },
    },
    include: { ...classInclude, records: { where: { studentId: req.user.id } } },
    orderBy: { startTime: 'desc' },
  });
  ok(res, sessions.map((s) => ({ ...studentSessionView(s, s.class), record: recordView(s.records[0]) })));
});

const checkInBody = z
  .object({
    token: z.string().max(600).optional(),
    code: z.string().max(20).optional(),
    ticket: z.string().max(300).optional(),
    // Coordinates are read as plain numbers; range and accuracy are judged by the geofence check
    // so that a bad reading is answered with a helpful, logged rejection instead of a 422.
    location: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().nullable().optional() }).optional(),
  })
  .refine((b) => b.token || b.code || b.ticket, { message: 'Scan the QR code or enter the attendance code.' });

attendanceRouter.post('/check-in', requireRole('STUDENT'), checkInLimiter, validate({ body: checkInBody }), async (req, res) => {
  const result = await checkIn(req.user, req.valid.body, req);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status === 'RECORDED' ? 201 : 200).json({ data: result });
});

attendanceRouter.get('/mine', requireRole('STUDENT'), validate({ query: z.object({ classId: zId.optional() }) }), async (req, res) => {
  const { classId } = req.valid.query;
  const classIds = classId ? [(await loadClassAccess(req.user, classId)).cls.id] : await classIdsFor(req.user);
  const [classes, records, corrections] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds } }, include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } }),
    prisma.attendanceRecord.findMany({
      where: { studentId: req.user.id, session: { classId: { in: classIds }, status: { not: 'CANCELLED' } } },
      include: { session: { select: { id: true, classId: true, title: true, date: true, startTime: true, endTime: true, status: true } } },
      orderBy: { session: { startTime: 'desc' } },
    }),
    prisma.attendanceCorrectionRequest.findMany({
      where: { studentId: req.user.id, session: { classId: { in: classIds } } },
      include: { files: { where: { deletedAt: null } }, session: { select: { classId: true, date: true, title: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const overall = { present: 0, late: 0, absent: 0, excused: 0 };
  const perClass = classes.map((cls) => {
    const mine = records.filter((r) => r.session.classId === cls.id);
    const totals = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const r of mine) {
      totals[r.status.toLowerCase()] += 1;
      overall[r.status.toLowerCase()] += 1;
    }
    return {
      classId: cls.id, classLabel: classLabel(cls), courseTitle: cls.course.title, ...totals, rate: attendanceRate(totals),
      records: mine.map((r) => ({
        sessionId: r.session.id, title: r.session.title, date: r.session.date.toISOString().slice(0, 10), startTime: r.session.startTime, sessionStatus: r.session.status,
        ...recordView(r), methodLabel: METHOD_LABELS[r.verificationMethod],
      })),
    };
  });
  ok(res, { overall: { ...overall, rate: attendanceRate(overall) }, classes: perClass, corrections: corrections.map(correctionView) });
});

// ── Correction and excuse requests ───────────────────────────────────────────
function correctionView(c) {
  return {
    id: c.id,
    sessionId: c.sessionId,
    classId: c.session?.classId,
    sessionDate: c.session?.date ? c.session.date.toISOString().slice(0, 10) : undefined,
    sessionTitle: c.session?.title,
    type: c.type,
    requestedStatus: c.requestedStatus,
    reason: c.reason,
    status: c.status,
    reviewNote: c.reviewNote,
    reviewedAt: c.reviewedAt,
    createdAt: c.createdAt,
    student: c.student ? { id: c.student.id, name: fullName(c.student) } : undefined,
    currentStatus: c.currentStatus,
    files: (c.files ?? []).map(fileSummary),
  };
}

const correctionBody = z.object({
  type: z.enum(['CORRECTION', 'EXCUSE']),
  requestedStatus: statusEnum.optional(),
  reason: z.string().trim().min(10, 'Please explain in at least 10 characters').max(1000),
  fileIds: z.array(zId).max(5).default([]),
});

attendanceRouter.post('/sessions/:sessionId/corrections', requireRole('STUDENT'), validate({ params: sessionParams, body: correctionBody }), async (req, res) => {
  const session = await loadSession(req.valid.params.sessionId);
  const access = await loadClassAccess(req.user, session.classId);
  assertClassWritable(access.cls);
  if (session.status === 'CANCELLED') throw conflict('This session was cancelled; there is nothing to correct.', 'SESSION_CANCELLED');
  const body = req.valid.body;
  const requestedStatus = body.type === 'EXCUSE' ? 'EXCUSED' : (body.requestedStatus ?? 'PRESENT');
  if (body.type === 'CORRECTION' && !['PRESENT', 'LATE'].includes(requestedStatus)) {
    throw fieldErrors({ requestedStatus: 'Ask to be marked present or late. To be excused, submit an excuse letter instead.' });
  }
  const current = await prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: session.id, studentId: req.user.id } } });
  if (current?.status === requestedStatus) throw conflict(`You are already marked ${requestedStatus.toLowerCase()} for this session.`, 'NOTHING_TO_CORRECT');

  const request = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `correction:${session.id}:${req.user.id}`);
    const pending = await tx.attendanceCorrectionRequest.findFirst({ where: { sessionId: session.id, studentId: req.user.id, status: 'PENDING' }, select: { id: true } });
    if (pending) throw conflict('You already have a request waiting for your teacher for this session.', 'REQUEST_PENDING');
    const row = await tx.attendanceCorrectionRequest.create({
      data: { sessionId: session.id, studentId: req.user.id, type: body.type, requestedStatus, reason: plainText(body.reason, 1000) },
    });
    await attachFiles(tx, { fileIds: body.fileIds, ownerId: req.user.id, field: 'correctionRequestId', parentId: row.id, max: 5 });
    return tx.attendanceCorrectionRequest.findUnique({ where: { id: row.id }, include: { files: true, session: { select: { classId: true, date: true, title: true } } } });
  });
  await notify([access.cls.teacherId], {
    type: 'attendance.correction_requested',
    title: `${fullName(req.user)} ${body.type === 'EXCUSE' ? 'submitted an excuse letter' : 'asked for an attendance correction'}`,
    body: `${classLabel(access.cls)} · ${session.date.toISOString().slice(0, 10)}`,
    link: `/classes/${session.classId}/attendance?tab=requests`,
    classId: session.classId,
  });
  created(res, correctionView(request));
});

attendanceRouter.get(
  '/corrections',
  validate({ query: z.object({ classId: zId.optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }) }),
  async (req, res) => {
    const q = req.valid.query;
    if (req.user.role === 'STUDENT') {
      const rows = await prisma.attendanceCorrectionRequest.findMany({
        where: { studentId: req.user.id, ...(q.status ? { status: q.status } : {}), ...(q.classId ? { session: { classId: q.classId } } : {}) },
        include: { files: { where: { deletedAt: null } }, session: { select: { classId: true, date: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return ok(res, rows.map(correctionView));
    }
    const classIds = q.classId ? [(await requireClassManager(req.user, q.classId)).cls.id] : await classIdsFor(req.user);
    const rows = await prisma.attendanceCorrectionRequest.findMany({
      where: { session: { classId: { in: classIds } }, ...(q.status ? { status: q.status } : {}) },
      include: {
        files: { where: { deletedAt: null } },
        session: { select: { classId: true, date: true, title: true, records: { select: { studentId: true, status: true } } } },
        student: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });
    return ok(res, rows.map((c) => correctionView({ ...c, currentStatus: c.session.records.find((r) => r.studentId === c.studentId)?.status ?? null })));
  },
);

async function decideCorrection(req, approve) {
  const request = await prisma.attendanceCorrectionRequest.findUnique({
    where: { id: req.valid.params.correctionId },
    include: { session: { include: classInclude }, student: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!request) throw notFound('Request');
  const access = await requireClassManager(req.user, request.session.classId);
  assertClassWritable(access.cls);
  const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
  if (!approve && !note) throw fieldErrors({ note: 'Tell the student why the request was not approved.' });

  await prisma.$transaction(async (tx) => {
    // Only one decision can win.
    const claimed = await tx.attendanceCorrectionRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedById: req.user.id, reviewedAt: new Date(), reviewNote: note },
    });
    if (claimed.count === 0) throw conflict('This request has already been decided.', 'ALREADY_DECIDED');
    if (approve) {
      const before = await tx.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: request.sessionId, studentId: request.studentId } } });
      const attending = request.requestedStatus === 'PRESENT' || request.requestedStatus === 'LATE';
      const data = {
        status: request.requestedStatus,
        verificationMethod: 'CORRECTION_APPROVED',
        verifiedById: req.user.id,
        overrideReason: `Approved ${request.type === 'EXCUSE' ? 'excuse' : 'correction'} request${note ? `: ${note}` : ''}`.slice(0, 300),
        checkInTime: attending ? (before?.checkInTime ?? null) : null,
        distanceMeters: null,
        reportedAccuracyMeters: null,
      };
      const row = before
        ? await tx.attendanceRecord.update({ where: { id: before.id }, data })
        : await tx.attendanceRecord.create({ data: { sessionId: request.sessionId, studentId: request.studentId, ...data } });
      await audit(req, {
        action: 'attendance.correction.approve', entityType: 'AttendanceRecord', entityId: row.id, classId: request.session.classId,
        summary: `Approved ${request.type.toLowerCase()} request of ${fullName(request.student)}: ${before?.status ?? 'unmarked'} → ${request.requestedStatus}`,
        before: before ? { status: before.status, method: before.verificationMethod } : undefined,
        after: { status: request.requestedStatus, method: 'CORRECTION_APPROVED' },
      }, tx);
    } else {
      await audit(req, {
        action: 'attendance.correction.reject', entityType: 'AttendanceCorrectionRequest', entityId: request.id, classId: request.session.classId,
        summary: `Declined ${request.type.toLowerCase()} request of ${fullName(request.student)}`,
      }, tx);
    }
  });
  await notify([request.studentId], {
    type: approve ? 'attendance.correction_approved' : 'attendance.correction_rejected',
    title: `Your ${request.type === 'EXCUSE' ? 'excuse letter' : 'attendance correction'} was ${approve ? 'approved' : 'not approved'}`,
    body: `${classLabel(request.session.class)} · ${request.session.date.toISOString().slice(0, 10)}${note ? ` — ${note}` : ''}`,
    link: `/classes/${request.session.classId}/attendance`,
    classId: request.session.classId,
  });
  emitToRoom(`attendance:${request.sessionId}`, 'attendance:update', { sessionId: request.sessionId, type: 'refresh' });
}

const decisionBody = z.object({ note: z.string().trim().max(500).optional() });
attendanceRouter.post('/corrections/:correctionId/approve', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('correctionId'), body: decisionBody }), async (req, res) => {
  await decideCorrection(req, true);
  ok(res, { status: 'APPROVED' });
});
attendanceRouter.post('/corrections/:correctionId/reject', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('correctionId'), body: decisionBody }), async (req, res) => {
  await decideCorrection(req, false);
  ok(res, { status: 'REJECTED' });
});

// ── Summary and exports ──────────────────────────────────────────────────────
classAttendanceRouter.get('/summary', validate({ params: classParams }), async (req, res) => {
  const { classId } = req.valid.params;
  const access = await loadClassAccess(req.user, classId);
  // A student receives only their own row.
  const summary = await classAttendanceSummary(classId, access.isStudent ? { studentId: req.user.id } : {});
  ok(res, summary);
});

const LETTER = { PRESENT: 'P', LATE: 'L', ABSENT: 'A', EXCUSED: 'E' };

classAttendanceRouter.get('/export', validate({ params: classParams, query: z.object({ format: exportFormat }) }), async (req, res) => {
  const { classId } = req.valid.params;
  const { cls } = await requireClassManager(req.user, classId);
  await assertPermission(req.user, 'attendance.export');
  const { format } = req.valid.query;
  const tz = await getTimeZone();
  const summary = await classAttendanceSummary(classId);
  // A PDF page cannot hold one column per meeting for a whole term, so it carries the totals;
  // the spreadsheet formats include every session.
  const perSession = format !== 'pdf' || summary.sessions.length <= 10;
  const columns = [
    { header: 'Student No.', value: (s) => s.studentNumber ?? '', pdfWidth: 1.3 },
    { header: 'Name', value: (s) => `${s.lastName}, ${s.firstName}`, width: 28, pdfWidth: 2.6 },
    ...(perSession
      ? summary.sessions.map((session) => ({
          header: `${session.date.slice(5)} ${timeKey(session.startTime, tz)}`,
          value: (s) => LETTER[s.statuses[session.id]] ?? '',
          width: 12, pdfWidth: 0.9, align: 'center',
        }))
      : []),
    { header: 'Present', value: (s) => s.present, pdfWidth: 0.9, align: 'right' },
    { header: 'Late', value: (s) => s.late, pdfWidth: 0.8, align: 'right' },
    { header: 'Absent', value: (s) => s.absent, pdfWidth: 0.9, align: 'right' },
    { header: 'Excused', value: (s) => s.excused, pdfWidth: 0.9, align: 'right' },
    { header: 'Rate %', value: (s) => s.rate ?? '', pdfWidth: 0.9, align: 'right' },
  ];
  await audit(req, { action: 'attendance.export', entityType: 'Class', entityId: classId, classId, summary: `Exported attendance (${format.toUpperCase()})` });
  await sendTable(res, format, {
    filename: `attendance-${cls.course.code}${cls.section ? `-${cls.section.name}` : ''}`,
    title: `Attendance — ${classLabel(cls)}`,
    subtitle: `${cls.course.title} · ${cls.semester.name}, ${cls.semester.academicYear.name}`,
    meta: [`${summary.sessions.length} session(s) · ${summary.students.length} student(s) · P = present, L = late, A = absent, E = excused`, `Generated ${dateKey(new Date(), tz)} (${tz})`],
    columns,
    rows: summary.students,
    landscape: perSession && summary.sessions.length > 3,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
    summary: ['Rate = (present + late) ÷ (present + late + absent). Excused sessions are not counted.'],
  });
});

attendanceRouter.get('/sessions/:sessionId/export', validate({ params: sessionParams, query: z.object({ format: exportFormat }) }), async (req, res) => {
  const session = await loadManagedSession(req);
  await assertPermission(req.user, 'attendance.export');
  const tz = await getTimeZone();
  const detail = await teacherSessionDetail(session.id);
  const { format } = req.valid.query;
  await audit(req, { action: 'attendance.export', entityType: 'AttendanceSession', entityId: session.id, classId: session.classId, summary: `Exported an attendance session (${format.toUpperCase()})` });
  await sendTable(res, format, {
    filename: `attendance-${session.class.course.code}-${detail.date}`,
    title: `Attendance — ${classLabel(session.class)} — ${detail.date}`,
    subtitle: `${session.title ? `${session.title} · ` : ''}${timeKey(session.startTime, tz)}–${timeKey(session.endTime, tz)} (${tz})`,
    meta: [`Present ${detail.counts.present} · Late ${detail.counts.late} · Absent ${detail.counts.absent} · Excused ${detail.counts.excused} · Not marked ${detail.counts.unmarked}`],
    columns: [
      { header: 'Student No.', value: (r) => r.studentNumber ?? '', pdfWidth: 1.2 },
      { header: 'Name', value: (r) => r.name, width: 28, pdfWidth: 2.4 },
      { header: 'Status', value: (r) => r.record?.status ?? 'NOT MARKED', pdfWidth: 1.1 },
      { header: 'Time', value: (r) => (r.record?.checkInTime ? timeKey(r.record.checkInTime, tz) : ''), pdfWidth: 0.8 },
      { header: 'Method', value: (r) => (r.record ? METHOD_LABELS[r.record.method] : ''), width: 22, pdfWidth: 1.7 },
      ...(session.requireLocation ? [{ header: 'Distance (m)', value: (r) => r.record?.distanceMeters ?? '', pdfWidth: 1, align: 'right' }] : []),
      { header: 'Remarks', value: (r) => r.record?.remarks ?? r.record?.overrideReason ?? '', width: 30, pdfWidth: 2 },
    ],
    rows: detail.roster,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
  });
});
