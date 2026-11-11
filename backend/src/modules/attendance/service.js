// Attendance domain logic: rotating QR tokens, check-in tickets, server-side location
// verification, closing sessions and attendance summaries.
//
// Privacy by design: a student's coordinates are used once, in memory, to compute the distance
// to the classroom and are then discarded. Only the distance and the reported accuracy are
// stored (and those are erased after the retention period).
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { evaluateGeofence } from '../../lib/geo.js';
import { fullName, round } from '../../lib/http.js';
import { hmacSha256, normalizeCode, safeEqual } from '../../lib/tokens.js';
import { audit } from '../../services/audit.js';
import { emitToRoom } from '../../services/realtime.js';
import { getSettings } from '../../services/settings.js';
import { classLabel } from '../classes/access.js';

export const STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
const TICKET_TTL_SECONDS = 180;
const MAX_REJECTED_PER_MINUTE = 8;

export async function attendancePolicy() {
  const s = await getSettings();
  return {
    defaultRadiusMeters: s['attendance.defaultRadiusMeters'],
    minRadiusMeters: s['attendance.minRadiusMeters'],
    maxRadiusMeters: s['attendance.maxRadiusMeters'],
    maxAccuracyMeters: s['attendance.maxAccuracyMeters'],
    qrRotationSeconds: s['attendance.qrRotationSeconds'],
    radiusPresets: [25, 50, 100, 150, 200].filter(
      (r) => r >= s['attendance.minRadiusMeters'] && r <= s['attendance.maxRadiusMeters'],
    ),
  };
}

// ── Rotating QR tokens ───────────────────────────────────────────────────────
// token = <sessionId>.<window counter>.<HMAC(sessionSecret, sessionId.counter)>
// The secret never leaves the server, so a token cannot be forged or predicted, and a
// photographed code stops working once its window (plus one window of grace for slow scans) ends.
const sign = (secret, message) => hmacSha256(secret, message).slice(0, 27);

function secretOf(session) {
  if (!session.qrSecret) throw new Error('attendance session has no signing secret');
  return session.qrSecret;
}

const windowCounter = (session, now) =>
  session.qrRotationSeconds > 0 ? Math.floor(now.getTime() / (session.qrRotationSeconds * 1000)) : 0;

export function currentQrToken(session, now = new Date()) {
  const counter = windowCounter(session, now);
  const token = `${session.id}.${counter}.${sign(session.qrSecret, `qr.${session.id}.${counter}`)}`;
  const rotation = session.qrRotationSeconds;
  const expiresAt = rotation > 0 ? new Date((counter + 1) * rotation * 1000) : session.endTime;
  return {
    token,
    // Scanning with the phone's own camera opens the app on the check-in screen.
    url: `${env.appUrl}/attendance/scan?t=${encodeURIComponent(token)}`,
    rotationSeconds: rotation,
    expiresAt,
    expiresInMs: Math.max(0, expiresAt.getTime() - now.getTime()),
  };
}

/** Accept either the bare token or the full URL encoded in the QR image. */
export function extractQrToken(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let token = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      token = new URL(text).searchParams.get('t') ?? '';
    } catch {
      return null;
    }
  }
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, counter, signature] = parts;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(sessionId) || !/^\d{1,15}$/.test(counter) || !/^[A-Za-z0-9_-]{10,60}$/.test(signature)) return null;
  return { sessionId, counter: Number(counter), signature };
}

/** @returns {'OK' | 'INVALID' | 'EXPIRED'} */
export function checkQrToken(session, parsed, now = new Date()) {
  if (!session.allowQr || !session.qrSecret) return 'INVALID';
  const expected = sign(session.qrSecret, `qr.${session.id}.${parsed.counter}`);
  if (!safeEqual(expected, parsed.signature)) return 'INVALID';
  const current = windowCounter(session, now);
  // One previous window is tolerated so a code scanned just before it rotated still works.
  if (parsed.counter === current || (session.qrRotationSeconds > 0 && parsed.counter === current - 1)) return 'OK';
  return 'EXPIRED';
}

// ── Check-in tickets ─────────────────────────────────────────────────────────
// After the QR code (or class code) has been verified, the student gets a short-lived ticket
// bound to their own account. It lets the browser obtain a GPS fix — which can take longer than
// one QR window — and retry a vague reading without scanning again. A ticket is useless to
// anyone else because the student id is part of the signed payload.
export function issueTicket(session, studentId, via, now = new Date()) {
  const exp = Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS;
  const payload = `${session.id}.${studentId}.${via}.${exp}`;
  return { ticket: `${payload}.${sign(secretOf(session), `ticket.${payload}`)}`, expiresInSeconds: TICKET_TTL_SECONDS };
}

export function parseTicket(raw) {
  const parts = String(raw ?? '').split('.');
  if (parts.length !== 5) return null;
  const [sessionId, studentId, via, exp, signature] = parts;
  if (!['QR', 'CODE'].includes(via) || !/^\d{1,12}$/.test(exp)) return null;
  return { sessionId, studentId, via, exp: Number(exp), signature };
}

/** @returns {'OK' | 'INVALID' | 'EXPIRED'} */
export function checkTicket(session, parsed, studentId, now = new Date()) {
  const payload = `${parsed.sessionId}.${parsed.studentId}.${parsed.via}.${parsed.exp}`;
  const expected = sign(secretOf(session), `ticket.${payload}`);
  if (!safeEqual(expected, parsed.signature) || parsed.studentId !== studentId || parsed.sessionId !== session.id) return 'INVALID';
  return parsed.exp * 1000 >= now.getTime() ? 'OK' : 'EXPIRED';
}

// ── Serialisation ────────────────────────────────────────────────────────────
/** What a student may know about a session: never the classroom coordinates. */
export const studentSessionView = (session, cls) => ({
  id: session.id,
  classId: session.classId,
  classLabel: cls ? classLabel(cls) : undefined,
  courseTitle: cls?.course?.title,
  title: session.title,
  date: session.date.toISOString().slice(0, 10),
  startTime: session.startTime,
  endTime: session.endTime,
  lateAfter: session.lateAfter,
  status: session.status,
  allowCode: session.allowCode,
  allowQr: session.allowQr,
  requireLocation: session.requireLocation,
  radiusMeters: session.requireLocation ? session.radiusMeters : null,
});

export const recordView = (record) =>
  record
    ? {
        id: record.id,
        status: record.status,
        checkInTime: record.checkInTime,
        method: record.verificationMethod,
        remarks: record.remarks,
        updatedAt: record.updatedAt,
      }
    : null;

/** Teacher view of a record: includes the verified distance, never coordinates (none are stored). */
export const teacherRecordView = (record) =>
  record
    ? {
        ...recordView(record),
        distanceMeters: record.distanceMeters === null ? null : round(record.distanceMeters, 0),
        accuracyMeters: record.reportedAccuracyMeters === null ? null : round(record.reportedAccuracyMeters, 0),
        overrideReason: record.overrideReason,
        verifiedById: record.verifiedById,
      }
    : null;

export async function sessionCounts(sessionId, classId, db = prisma) {
  const [grouped, enrolled] = await Promise.all([
    db.attendanceRecord.groupBy({ by: ['status'], where: { sessionId }, _count: { _all: true } }),
    db.enrollment.count({ where: { classId, status: 'ENROLLED' } }),
  ]);
  const counts = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
  for (const g of grouped) counts[g.status] = g._count._all;
  const marked = counts.PRESENT + counts.LATE + counts.ABSENT + counts.EXCUSED;
  return {
    present: counts.PRESENT,
    late: counts.LATE,
    absent: counts.ABSENT,
    excused: counts.EXCUSED,
    enrolled,
    unmarked: Math.max(0, enrolled - marked),
  };
}

// ── Check-in ─────────────────────────────────────────────────────────────────
const REJECTION_MESSAGES = {
  QR_INVALID: 'This QR code is not valid. Scan the code currently shown by your teacher.',
  QR_EXPIRED: 'This QR code has expired. Scan the code currently shown on your teacher\'s screen.',
  CODE_INVALID: 'That attendance code is not valid for any of your open classes.',
  CODE_EXPIRED: 'That attendance code has expired. Ask your teacher for the current code.',
  TICKET_EXPIRED: 'Verification took too long. Please scan the QR code or enter the code again.',
  NOT_ENROLLED: 'This attendance session is not for one of your classes.',
  SESSION_CLOSED: 'This attendance session is closed.',
  NOT_STARTED: 'This attendance session has not started yet.',
  SESSION_ENDED: 'The check-in period for this session has ended.',
  METHOD_NOT_ALLOWED: 'Your teacher has not enabled this way of checking in for the session.',
  LOCATION_REQUIRED: 'Your location is required to confirm that you are in the classroom. Allow location access and try again.',
  LOCATION_INVALID: 'Your device sent an unusable location. Please try again.',
  LOW_ACCURACY: 'Your location accuracy is too low. Move near a window or outdoors, turn on precise location and try again.',
  OUTSIDE_RADIUS: 'You appear to be outside the allowed attendance area for this class.',
  TOO_MANY_ATTEMPTS: 'Too many failed attempts. Wait a minute, then try again or ask your teacher for help.',
};

class CheckInRejection extends AppError {
  constructor(code, details, status = 422) {
    super(status, code, REJECTION_MESSAGES[code] ?? 'Attendance could not be recorded.', details);
  }
}

const sessionInclude = { class: { include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } } };

async function logAttempt(session, studentId, method, outcome, reason, verdict) {
  const attempt = await prisma.attendanceAttempt.create({
    data: {
      sessionId: session.id,
      studentId,
      method,
      outcome,
      rejectionReason: reason ?? null,
      distanceMeters: verdict?.distanceMeters ?? null,
      accuracyMeters: verdict?.accuracyMeters ?? null,
    },
  });
  return attempt;
}

const attemptView = (attempt, student) => ({
  id: attempt.id,
  studentId: attempt.studentId,
  studentName: student ? fullName(student) : undefined,
  attemptedAt: attempt.attemptedAt,
  method: attempt.method,
  outcome: attempt.outcome,
  reason: attempt.rejectionReason,
  distanceMeters: attempt.distanceMeters === null ? null : round(attempt.distanceMeters, 0),
  accuracyMeters: attempt.accuracyMeters === null ? null : round(attempt.accuracyMeters, 0),
});

async function broadcast(session, payload) {
  try {
    const counts = await sessionCounts(session.id, session.classId);
    emitToRoom(`attendance:${session.id}`, 'attendance:update', { sessionId: session.id, counts, ...payload });
  } catch {
    // the live monitor is best effort; the record itself is already stored
  }
}

async function reject(session, student, method, code, verdict, details) {
  const attempt = await logAttempt(session, student.id, method, 'REJECTED', code, verdict);
  await broadcast(session, { type: 'attempt', attempt: attemptView(attempt, student) });
  throw new CheckInRejection(code, details);
}

/**
 * Record a student's own attendance.
 *
 * body: { token?, code?, ticket?, location?: { latitude, longitude, accuracy } }
 *   token  — the content of the teacher's QR code
 *   code   — the numeric attendance code
 *   ticket — returned by a previous call that still needed a location
 *
 * Returns { status: 'RECORDED' | 'ALREADY_RECORDED' | 'LOCATION_REQUIRED', … }.
 * Throws a 4xx AppError with a specific code for every rejection.
 */
export async function checkIn(student, body, ctx) {
  const now = new Date();
  let session;
  let via;

  if (body.ticket) {
    const parsed = parseTicket(body.ticket);
    if (!parsed) throw new CheckInRejection('TICKET_EXPIRED');
    session = await prisma.attendanceSession.findUnique({ where: { id: parsed.sessionId }, include: sessionInclude });
    if (!session) throw new CheckInRejection('TICKET_EXPIRED');
    const verdict = checkTicket(session, parsed, student.id, now);
    if (verdict !== 'OK') throw new CheckInRejection('TICKET_EXPIRED');
    via = parsed.via;
  } else if (body.token) {
    const parsed = extractQrToken(body.token);
    if (!parsed) throw new CheckInRejection('QR_INVALID');
    session = await prisma.attendanceSession.findUnique({ where: { id: parsed.sessionId }, include: sessionInclude });
    if (!session) throw new CheckInRejection('QR_INVALID');
    via = 'QR';
    const enrolled = await isEnrolled(session.classId, student.id);
    // Do not confirm to outsiders that a session exists.
    if (!enrolled) throw new CheckInRejection('NOT_ENROLLED', undefined, 403);
    await assertNotThrottled(session, student);
    const verdict = checkQrToken(session, parsed, now);
    if (verdict === 'INVALID') await reject(session, student, 'QR', 'QR_INVALID');
    if (verdict === 'EXPIRED') await reject(session, student, 'QR', 'QR_EXPIRED');
  } else if (body.code) {
    const code = normalizeCode(body.code);
    if (code.length < 4) throw new CheckInRejection('CODE_INVALID');
    // The code is only looked up among open sessions of the student's own classes.
    const candidates = await prisma.attendanceSession.findMany({
      where: {
        status: 'OPEN', allowCode: true, code,
        class: { status: 'ACTIVE', enrollments: { some: { studentId: student.id, status: 'ENROLLED' } } },
      },
      include: sessionInclude,
      orderBy: { startTime: 'desc' },
    });
    session = candidates.find((s) => s.startTime <= now && s.endTime >= now) ?? candidates[0] ?? null;
    if (!session) throw new CheckInRejection('CODE_INVALID');
    via = 'CODE';
    await assertNotThrottled(session, student);
    if (session.codeExpiresAt && session.codeExpiresAt < now) await reject(session, student, 'CODE', 'CODE_EXPIRED');
  } else {
    throw new CheckInRejection('QR_INVALID');
  }

  const method = via === 'QR' ? (session.requireLocation ? 'QR_GPS' : 'QR') : 'CODE';
  if (!(await isEnrolled(session.classId, student.id))) throw new CheckInRejection('NOT_ENROLLED', undefined, 403);

  // Already recorded? Tell the student, do not create a second record or a noisy attempt.
  const existing = await prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: session.id, studentId: student.id } } });
  if (existing) {
    return { status: 'ALREADY_RECORDED', record: recordView(existing), session: studentSessionView(session, session.class) };
  }

  if (session.status !== 'OPEN') await reject(session, student, method, 'SESSION_CLOSED');
  if (via === 'QR' && !session.allowQr) await reject(session, student, method, 'METHOD_NOT_ALLOWED');
  if (via === 'CODE' && !session.allowCode) await reject(session, student, method, 'METHOD_NOT_ALLOWED');
  if (now < session.startTime) await reject(session, student, method, 'NOT_STARTED');
  if (now > session.endTime) await reject(session, student, method, 'SESSION_ENDED');

  let verdict = null;
  if (session.requireLocation) {
    if (!body.location) {
      // Credential accepted; now the browser must supply a location. Not a failed attempt.
      return {
        status: 'LOCATION_REQUIRED',
        ...issueTicket(session, student.id, via, now),
        session: studentSessionView(session, session.class),
      };
    }
    await assertNotThrottled(session, student);
    // The distance is computed here, on the server. Nothing the client says about distance is used.
    verdict = evaluateGeofence(
      { latitude: session.latitude, longitude: session.longitude, radiusMeters: session.radiusMeters, maxAccuracyMeters: session.maxAccuracyMeters },
      body.location,
    );
    if (!verdict.ok) {
      const details = { retryable: verdict.reason !== 'OUTSIDE_RADIUS' };
      if (verdict.reason === 'LOW_ACCURACY') {
        details.requiredAccuracyMeters = session.maxAccuracyMeters;
        if (verdict.accuracyMeters) details.accuracyMeters = Math.round(verdict.accuracyMeters);
      }
      if (verdict.reason === 'OUTSIDE_RADIUS') {
        details.distanceMeters = Math.round(verdict.distanceMeters);
        details.radiusMeters = session.radiusMeters;
      }
      // A ticket lets the student retry without scanning again while the reading improves.
      Object.assign(details, issueTicket(session, student.id, via, now));
      await reject(session, student, method, verdict.reason, verdict, details);
    }
  }

  const status = session.lateAfter && now > session.lateAfter ? 'LATE' : 'PRESENT';
  let record;
  try {
    record = await prisma.$transaction(async (tx) => {
      const row = await tx.attendanceRecord.create({
        data: {
          sessionId: session.id,
          studentId: student.id,
          status,
          checkInTime: now,
          verificationMethod: method,
          distanceMeters: verdict?.distanceMeters ?? null,
          reportedAccuracyMeters: verdict?.accuracyMeters ?? null,
        },
      });
      await tx.attendanceAttempt.create({
        data: {
          sessionId: session.id, studentId: student.id, method, outcome: 'ACCEPTED',
          distanceMeters: verdict?.distanceMeters ?? null, accuracyMeters: verdict?.accuracyMeters ?? null,
        },
      });
      return row;
    });
  } catch (err) {
    // Two requests raced (double tap, two devices): the unique index let exactly one through.
    if (err?.code === 'P2002') {
      const winner = await prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: session.id, studentId: student.id } } });
      return { status: 'ALREADY_RECORDED', record: recordView(winner), session: studentSessionView(session, session.class) };
    }
    throw err;
  }

  await audit(ctx, {
    action: 'attendance.check_in', entityType: 'AttendanceRecord', entityId: record.id, classId: session.classId,
    summary: `Checked in ${status.toLowerCase()} via ${method}`,
  });
  await broadcast(session, {
    type: 'record',
    record: { studentId: student.id, studentName: fullName(student), ...teacherRecordView(record) },
  });
  return { status: 'RECORDED', record: recordView(record), session: studentSessionView(session, session.class) };
}

async function isEnrolled(classId, studentId) {
  const e = await prisma.enrollment.findUnique({ where: { classId_studentId: { classId, studentId } }, select: { status: true } });
  return e?.status === 'ENROLLED';
}

async function assertNotThrottled(session, student) {
  const recent = await prisma.attendanceAttempt.count({
    where: { sessionId: session.id, studentId: student.id, outcome: 'REJECTED', attemptedAt: { gt: new Date(Date.now() - 60_000) } },
  });
  if (recent >= MAX_REJECTED_PER_MINUTE) throw new CheckInRejection('TOO_MANY_ATTEMPTS', { retryAfterSeconds: 60 }, 429);
}

// ── Closing ──────────────────────────────────────────────────────────────────
/**
 * Close a session: everyone enrolled who has no record becomes ABSENT, in one transaction.
 * Safe to call twice — only the caller that flips OPEN → CLOSED marks the absences.
 */
export async function closeSession(sessionId, ctx, { automatic = false } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.attendanceSession.updateMany({ where: { id: sessionId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
    if (claimed.count === 0) return null;
    const session = await tx.attendanceSession.findUnique({ where: { id: sessionId } });
    const enrolled = await tx.enrollment.findMany({ where: { classId: session.classId, status: 'ENROLLED' }, select: { studentId: true } });
    const marked = await tx.attendanceRecord.findMany({ where: { sessionId }, select: { studentId: true } });
    const have = new Set(marked.map((m) => m.studentId));
    const absent = enrolled.filter((e) => !have.has(e.studentId));
    if (absent.length > 0) {
      await tx.attendanceRecord.createMany({
        data: absent.map((e) => ({ sessionId, studentId: e.studentId, status: 'ABSENT', verificationMethod: 'AUTO_ABSENT' })),
        skipDuplicates: true,
      });
    }
    await audit(ctx, {
      action: automatic ? 'attendance.session.auto_close' : 'attendance.session.close', entityType: 'AttendanceSession', entityId: sessionId, classId: session.classId,
      summary: `Closed attendance session; ${absent.length} student${absent.length === 1 ? '' : 's'} marked absent`,
    }, tx);
    return { session, absentCount: absent.length };
  });
  if (result) await broadcast(result.session, { type: 'closed' });
  return result;
}

// ── Summaries ────────────────────────────────────────────────────────────────
/**
 * Attendance rate = (present + late) ÷ (present + late + absent).
 * Excused sessions are left out of both sides, so an approved excuse never lowers the rate.
 */
export function attendanceRate({ present = 0, late = 0, absent = 0 }) {
  const counted = present + late + absent;
  return counted === 0 ? null : round(((present + late) / counted) * 100, 1);
}

/** Per-student totals for a class over its closed (and open) sessions. */
export async function classAttendanceSummary(classId, { studentId } = {}) {
  const sessions = await prisma.attendanceSession.findMany({
    where: { classId, status: { not: 'CANCELLED' } },
    orderBy: [{ startTime: 'asc' }],
    select: { id: true, title: true, date: true, startTime: true, endTime: true, status: true, requireLocation: true },
  });
  const enrollments = await prisma.enrollment.findMany({
    where: { classId, status: 'ENROLLED', ...(studentId ? { studentId } : {}) },
    select: { student: { select: { id: true, firstName: true, lastName: true, studentProfile: { select: { studentNumber: true } } } } },
    orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
  });
  const records = await prisma.attendanceRecord.findMany({
    where: { session: { classId, status: { not: 'CANCELLED' } }, ...(studentId ? { studentId } : {}) },
    select: { sessionId: true, studentId: true, status: true, checkInTime: true, verificationMethod: true, remarks: true },
  });
  const byStudent = new Map();
  for (const r of records) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, new Map());
    byStudent.get(r.studentId).set(r.sessionId, r);
  }
  const students = enrollments.map(({ student }) => {
    const mine = byStudent.get(student.id) ?? new Map();
    const totals = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const r of mine.values()) totals[r.status.toLowerCase()] += 1;
    return {
      id: student.id,
      name: fullName(student),
      lastName: student.lastName,
      firstName: student.firstName,
      studentNumber: student.studentProfile?.studentNumber ?? null,
      ...totals,
      rate: attendanceRate(totals),
      statuses: Object.fromEntries([...mine.entries()].map(([sid, r]) => [sid, r.status])),
    };
  });
  return {
    sessions: sessions.map((s) => ({ ...s, date: s.date.toISOString().slice(0, 10) })),
    students,
  };
}
