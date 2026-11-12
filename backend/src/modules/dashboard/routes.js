// Role dashboards: one request that answers "what needs my attention today?".
import { Router } from 'express';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { fullName, ok, round } from '../../lib/http.js';
import { excerpt } from '../../lib/sanitize.js';
import { addDays, dateKey, startOfDay, weekdayOf } from '../../lib/time.js';
import { publishedWhere, quizResultsVisible } from '../../lib/visibility.js';
import { requireAuth } from '../../middleware/auth.js';
import { mailAvailable, mailConfigured } from '../../services/mail.js';
import { getSetting, getTimeZone, SETTING_DEFINITIONS } from '../../services/settings.js';
import { assessRisk, attendanceTotals, missingWork, rateOf, riskThresholds } from '../analytics/service.js';
import { classLabel } from '../classes/access.js';
import { computeClassGrades } from '../gradebook/service.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const classInclude = {
  course: { select: { code: true, title: true } },
  section: { select: { name: true } },
  semester: { select: { name: true } },
  schedules: true,
  teacher: { select: { firstName: true, lastName: true } },
};

/** Today's meetings of the given classes, in the institution's timezone. */
function todaysSchedule(classes, tz, now) {
  const today = dateKey(now, tz);
  const weekday = weekdayOf(today);
  return classes
    .flatMap((cls) => cls.schedules.filter((s) => s.dayOfWeek === weekday).map((s) => ({ classId: cls.id, label: classLabel(cls), title: cls.course.title, color: cls.color, startTime: s.startTime, endTime: s.endTime, room: s.room ?? cls.room ?? null })))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

async function latestAnnouncements(user, classIds, now) {
  const rows = await prisma.announcement.findMany({
    where: {
      deletedAt: null,
      AND: [
        publishedWhere(now),
        {
          OR: [
            { audience: 'INSTITUTION' },
            ...(user.role === 'STUDENT'
              ? [{ classId: { in: classIds }, audience: 'CLASS' }, { classId: { in: classIds }, audience: 'SELECTED', recipients: { some: { studentId: user.id } } }]
              : [{ classId: { in: classIds } }]),
          ],
        },
      ],
    },
    include: { class: { select: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } }, author: { select: { firstName: true, lastName: true } } },
    orderBy: [{ publishedAt: 'desc' }],
    take: 5,
  });
  return rows.map((a) => ({ id: a.id, classId: a.classId, classLabel: a.class ? classLabel(a.class) : 'Institution', title: a.title, excerpt: excerpt(a.contentHtml, 140), priority: a.priority, publishedAt: a.publishedAt, author: fullName(a.author) }));
}

// ── Student ──────────────────────────────────────────────────────────────────
async function studentDashboard(user) {
  const now = new Date();
  const tz = await getTimeZone();
  const enrollments = await prisma.enrollment.findMany({ where: { studentId: user.id, status: 'ENROLLED', class: { status: 'ACTIVE' } }, include: { class: { include: classInclude } } });
  const classes = enrollments.map((e) => e.class);
  const classIds = classes.map((c) => c.id);
  const labelOf = new Map(classes.map((c) => [c.id, classLabel(c)]));
  const soon = new Date(now.getTime() + WEEK_MS);

  const [assignments, quizzes, submissions, attempts, sessions, pendingJoin, invitations, lessonTotals, lessonDone] = await Promise.all([
    prisma.assignment.findMany({ where: { classId: { in: classIds }, deletedAt: null, ...publishedWhere(now) }, select: { id: true, classId: true, title: true, dueAt: true, closeAt: true, allowLate: true, points: true, availableFrom: true } }),
    prisma.quiz.findMany({ where: { classId: { in: classIds }, deletedAt: null, ...publishedWhere(now) }, select: { id: true, classId: true, title: true, kind: true, availableFrom: true, availableUntil: true, maxAttempts: true, timeLimitMinutes: true, resultVisibility: true, resultsPublishedAt: true } }),
    prisma.assignmentSubmission.findMany({ where: { studentId: user.id, assignment: { classId: { in: classIds } } }, select: { assignmentId: true, status: true, finalScore: true, returnedAt: true, isLate: true } }),
    prisma.quizAttempt.findMany({ where: { studentId: user.id, quiz: { classId: { in: classIds } } }, select: { id: true, quizId: true, status: true, totalScore: true, maxScore: true, needsManualGrading: true, submittedAt: true, deadlineAt: true } }),
    prisma.attendanceSession.findMany({
      where: { classId: { in: classIds }, status: 'OPEN', startTime: { lte: now }, endTime: { gte: now }, OR: [{ allowCode: true }, { allowQr: true }] },
      select: { id: true, classId: true, title: true, endTime: true, allowCode: true, allowQr: true, requireLocation: true, records: { where: { studentId: user.id }, select: { status: true } } },
    }),
    prisma.enrollment.count({ where: { studentId: user.id, status: 'PENDING' } }),
    prisma.classInvitation.count({ where: { email: user.email, status: 'PENDING', expiresAt: { gt: now } } }),
    prisma.lesson.groupBy({ by: ['moduleId'], where: { deletedAt: null, status: 'PUBLISHED', module: { classId: { in: classIds }, deletedAt: null, ...publishedWhere(now) } }, _count: { _all: true } }),
    prisma.lessonProgress.findMany({ where: { studentId: user.id, completedAt: { not: null }, lesson: { deletedAt: null, status: 'PUBLISHED', module: { classId: { in: classIds }, deletedAt: null, ...publishedWhere(now) } } }, select: { lesson: { select: { module: { select: { classId: true } } } } } }),
  ]);
  const moduleClass = new Map((await prisma.learningModule.findMany({ where: { id: { in: lessonTotals.map((l) => l.moduleId) } }, select: { id: true, classId: true } })).map((m) => [m.id, m.classId]));
  const submissionOf = new Map(submissions.map((s) => [s.assignmentId, s]));
  const attemptsOf = (quizId) => attempts.filter((a) => a.quizId === quizId);

  const todo = [];
  const missing = [];
  for (const a of assignments) {
    const s = submissionOf.get(a.id);
    if (s && s.status !== 'DRAFT') continue;
    const item = { kind: 'ASSIGNMENT', id: a.id, classId: a.classId, classLabel: labelOf.get(a.classId), title: a.title, dueAt: a.dueAt, points: a.points, link: `/classes/${a.classId}/assignments/${a.id}` };
    if (a.dueAt && a.dueAt <= now) {
      const stillOpen = a.allowLate && (!a.closeAt || a.closeAt > now);
      missing.push({ ...item, canStillSubmit: stillOpen });
    } else if (!a.dueAt || a.dueAt <= soon) {
      if (!a.availableFrom || a.availableFrom <= now) todo.push(item);
    }
  }
  for (const q of quizzes) {
    const mine = attemptsOf(q.id);
    const running = mine.find((a) => a.status === 'IN_PROGRESS');
    const item = { kind: q.kind, id: q.id, classId: q.classId, classLabel: labelOf.get(q.classId), title: q.title, dueAt: q.availableUntil, timeLimitMinutes: q.timeLimitMinutes, link: `/classes/${q.classId}/quizzes/${q.id}`, inProgress: Boolean(running) };
    if (running) todo.push(item);
    else if (mine.length > 0) continue;
    else if (q.availableUntil && q.availableUntil <= now) {
      if (q.kind !== 'PRACTICE') missing.push({ ...item, canStillSubmit: false });
    } else if ((!q.availableFrom || q.availableFrom <= now) && (!q.availableUntil || q.availableUntil <= soon)) todo.push(item);
  }
  todo.sort((a, b) => Number(b.inProgress ?? false) - Number(a.inProgress ?? false) || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
  missing.sort((a, b) => b.dueAt - a.dueAt);

  const recentGrades = [
    ...submissions.filter((s) => s.status === 'RETURNED').map((s) => {
      const a = assignments.find((x) => x.id === s.assignmentId);
      return a ? { kind: 'ASSIGNMENT', id: a.id, classId: a.classId, classLabel: labelOf.get(a.classId), title: a.title, score: s.finalScore, maxScore: a.points, at: s.returnedAt, link: `/classes/${a.classId}/assignments/${a.id}` } : null;
    }),
    ...attempts.filter((a) => a.status !== 'IN_PROGRESS' && !a.needsManualGrading).map((a) => {
      const q = quizzes.find((x) => x.id === a.quizId);
      return q && quizResultsVisible(q, now) ? { kind: q.kind, id: q.id, classId: q.classId, classLabel: labelOf.get(q.classId), title: q.title, score: a.totalScore, maxScore: a.maxScore, at: a.submittedAt, link: `/classes/${q.classId}/quizzes/${q.id}` } : null;
    }),
  ].filter(Boolean).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0)).slice(0, 6);

  const attendance = new Map();
  if (classIds.length > 0) {
    const rows = await prisma.attendanceRecord.findMany({ where: { studentId: user.id, session: { classId: { in: classIds }, status: 'CLOSED' } }, select: { status: true, session: { select: { classId: true } } } });
    for (const r of rows) {
      const t = attendance.get(r.session.classId) ?? { present: 0, late: 0, absent: 0, excused: 0 };
      t[r.status.toLowerCase()] += 1;
      attendance.set(r.session.classId, t);
    }
  }
  const overall = [...attendance.values()].reduce((a, t) => ({ present: a.present + t.present, late: a.late + t.late, absent: a.absent + t.absent }), { present: 0, late: 0, absent: 0 });

  return {
    role: 'STUDENT',
    date: dateKey(now, tz),
    stats: { classes: classes.length, dueThisWeek: todo.length, missing: missing.length, attendanceRate: rateOf(overall), pendingEnrollments: pendingJoin, invitations },
    today: todaysSchedule(classes, tz, now),
    checkIns: sessions.map((s) => ({ sessionId: s.id, classId: s.classId, classLabel: labelOf.get(s.classId), title: s.title, endTime: s.endTime, allowCode: s.allowCode, allowQr: s.allowQr, requireLocation: s.requireLocation, recorded: s.records[0]?.status ?? null })),
    todo: todo.slice(0, 10),
    missing: missing.slice(0, 8),
    recentGrades,
    announcements: await latestAnnouncements(user, classIds, now),
    classes: classes.map((cls) => {
      const total = lessonTotals.filter((l) => moduleClass.get(l.moduleId) === cls.id).reduce((a, l) => a + l._count._all, 0);
      const done = lessonDone.filter((p) => p.lesson.module.classId === cls.id).length;
      const t = attendance.get(cls.id);
      return {
        id: cls.id, label: classLabel(cls), title: cls.course.title, color: cls.color, teacher: fullName(cls.teacher), semester: cls.semester.name,
        lessonProgress: total === 0 ? null : round((done / total) * 100, 0),
        attendanceRate: t ? rateOf(t) : null,
        openWork: todo.filter((x) => x.classId === cls.id).length + missing.filter((x) => x.classId === cls.id && x.canStillSubmit).length,
      };
    }),
  };
}

// ── Teacher ──────────────────────────────────────────────────────────────────
async function teacherDashboard(user) {
  const now = new Date();
  const tz = await getTimeZone();
  const classes = await prisma.class.findMany({ where: { teacherId: user.id, status: 'ACTIVE' }, include: { ...classInclude, _count: { select: { enrollments: { where: { status: 'ENROLLED' } } } } }, orderBy: { createdAt: 'asc' } });
  const classIds = classes.map((c) => c.id);
  const labelOf = new Map(classes.map((c) => [c.id, classLabel(c)]));
  const soon = new Date(now.getTime() + WEEK_MS);

  const [toGradeGroups, quizGrading, pendingEnrollments, correctionRows, appealGroups, upcomingAssignments, upcomingQuizzes, openSessions, drafts] = await Promise.all([
    prisma.assignmentSubmission.groupBy({ by: ['assignmentId'], where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] }, assignment: { classId: { in: classIds }, deletedAt: null } }, _count: { _all: true } }),
    prisma.quizAttempt.groupBy({ by: ['quizId'], where: { needsManualGrading: true, status: { not: 'IN_PROGRESS' }, quiz: { classId: { in: classIds }, deletedAt: null } }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['classId'], where: { classId: { in: classIds }, status: 'PENDING' }, _count: { _all: true } }),
    prisma.attendanceCorrectionRequest.findMany({ where: { status: 'PENDING', session: { classId: { in: classIds } } }, select: { session: { select: { classId: true } } } }),
    prisma.gradeAppeal.groupBy({ by: ['classId'], where: { status: 'PENDING', classId: { in: classIds } }, _count: { _all: true } }),
    prisma.assignment.findMany({ where: { classId: { in: classIds }, deletedAt: null, status: 'PUBLISHED', dueAt: { gt: now, lte: soon } }, select: { id: true, classId: true, title: true, dueAt: true, _count: { select: { submissions: { where: { status: { not: 'DRAFT' } } } } } }, orderBy: { dueAt: 'asc' }, take: 8 }),
    prisma.quiz.findMany({ where: { classId: { in: classIds }, deletedAt: null, status: 'PUBLISHED', availableUntil: { gt: now, lte: soon } }, select: { id: true, classId: true, title: true, kind: true, availableUntil: true }, orderBy: { availableUntil: 'asc' }, take: 8 }),
    prisma.attendanceSession.findMany({ where: { classId: { in: classIds }, status: 'OPEN' }, select: { id: true, classId: true, title: true, startTime: true, endTime: true, _count: { select: { records: true } } }, orderBy: { startTime: 'desc' }, take: 5 }),
    Promise.all([
      prisma.assignment.count({ where: { classId: { in: classIds }, deletedAt: null, status: 'DRAFT' } }),
      prisma.quiz.count({ where: { classId: { in: classIds }, deletedAt: null, status: 'DRAFT' } }),
      prisma.learningModule.count({ where: { classId: { in: classIds }, deletedAt: null, status: 'DRAFT' } }),
    ]),
  ]);
  const [assignmentTitles, quizTitles] = await Promise.all([
    prisma.assignment.findMany({ where: { id: { in: toGradeGroups.map((g) => g.assignmentId) } }, select: { id: true, title: true, classId: true } }),
    prisma.quiz.findMany({ where: { id: { in: quizGrading.map((g) => g.quizId) } }, select: { id: true, title: true, classId: true } }),
  ]);
  const toGrade = [
    ...toGradeGroups.map((g) => {
      const a = assignmentTitles.find((x) => x.id === g.assignmentId);
      return { kind: 'ASSIGNMENT', id: a.id, classId: a.classId, classLabel: labelOf.get(a.classId), title: a.title, count: g._count._all, link: `/classes/${a.classId}/assignments/${a.id}/submissions` };
    }),
    ...quizGrading.map((g) => {
      const q = quizTitles.find((x) => x.id === g.quizId);
      return { kind: 'QUIZ', id: q.id, classId: q.classId, classLabel: labelOf.get(q.classId), title: q.title, count: g._count._all, link: `/classes/${q.classId}/quizzes/${q.id}/results` };
    }),
  ].sort((a, b) => b.count - a.count);

  // At-risk students across classes (bounded: the gradebook is computed per class).
  const thresholds = await riskThresholds();
  const atRisk = [];
  for (const cls of classes.slice(0, 12)) {
    const { students } = await computeClassGrades(cls);
    if (students.length === 0) continue;
    const ids = students.map((s) => s.student.id);
    const [attendance, missing] = await Promise.all([attendanceTotals(cls.id, ids), missingWork(cls.id, ids, now)]);
    for (const { student, result } of students) {
      const numbers = { percent: result.overall.percent, attendanceRate: rateOf(attendance.get(student.id)), missing: (missing.get(student.id) ?? []).length };
      const risk = assessRisk(numbers, thresholds);
      if (risk.level !== 'NONE') atRisk.push({ studentId: student.id, name: student.name, classId: cls.id, classLabel: classLabel(cls), ...numbers, level: risk.level, reasons: risk.reasons.map((r) => r.text) });
    }
  }
  atRisk.sort((a, b) => b.reasons.length - a.reasons.length || (a.percent ?? 101) - (b.percent ?? 101));

  const pendingByClass = new Map(pendingEnrollments.map((p) => [p.classId, p._count._all]));
  // Per class, so that the dashboard can link straight to the class that has something waiting.
  const correctionsByClass = new Map();
  for (const row of correctionRows) correctionsByClass.set(row.session.classId, (correctionsByClass.get(row.session.classId) ?? 0) + 1);
  const appealsByClass = new Map(appealGroups.map((g) => [g.classId, g._count._all]));
  const corrections = correctionRows.length;
  const appeals = appealGroups.reduce((a, g) => a + g._count._all, 0);
  const students = classes.reduce((a, c) => a + c._count.enrollments, 0);
  return {
    role: 'TEACHER',
    date: dateKey(now, tz),
    stats: {
      classes: classes.length, students, toGrade: toGrade.reduce((a, t) => a + t.count, 0),
      pendingRequests: [...pendingByClass.values()].reduce((a, b) => a + b, 0) + corrections + appeals, atRisk: atRisk.length,
    },
    today: todaysSchedule(classes, tz, now),
    openSessions: openSessions.map((s) => ({ sessionId: s.id, classId: s.classId, classLabel: labelOf.get(s.classId), title: s.title, startTime: s.startTime, endTime: s.endTime, recorded: s._count.records })),
    toGrade: toGrade.slice(0, 8),
    requests: { enrollments: [...pendingByClass.values()].reduce((a, b) => a + b, 0), attendanceCorrections: corrections, gradeAppeals: appeals },
    upcoming: [
      ...upcomingAssignments.map((a) => ({ kind: 'ASSIGNMENT', id: a.id, classId: a.classId, classLabel: labelOf.get(a.classId), title: a.title, dueAt: a.dueAt, submitted: a._count.submissions, enrolled: classes.find((c) => c.id === a.classId)._count.enrollments, link: `/classes/${a.classId}/assignments/${a.id}` })),
      ...upcomingQuizzes.map((q) => ({ kind: q.kind, id: q.id, classId: q.classId, classLabel: labelOf.get(q.classId), title: q.title, dueAt: q.availableUntil, link: `/classes/${q.classId}/quizzes/${q.id}` })),
    ].sort((a, b) => a.dueAt - b.dueAt).slice(0, 8),
    drafts: { assignments: drafts[0], quizzes: drafts[1], modules: drafts[2] },
    atRisk: atRisk.slice(0, 8),
    thresholds,
    announcements: await latestAnnouncements(user, classIds, now),
    classes: classes.map((cls) => ({
      id: cls.id, label: classLabel(cls), title: cls.course.title, color: cls.color, semester: cls.semester.name, students: cls._count.enrollments,
      pendingEnrollments: pendingByClass.get(cls.id) ?? 0, pendingCorrections: correctionsByClass.get(cls.id) ?? 0, pendingAppeals: appealsByClass.get(cls.id) ?? 0,
      toGrade: toGrade.filter((t) => t.classId === cls.id).reduce((a, t) => a + t.count, 0),
    })),
  };
}

// ── Administrator ────────────────────────────────────────────────────────────
/** The name the first administrator is created with, until they put their own on the account. */
const PLACEHOLDER_ADMIN = { firstName: 'System', lastName: 'Administrator' };

async function adminDashboard(user) {
  const now = new Date();
  const tz = await getTimeZone();
  const since = startOfDay(addDays(dateKey(now, tz), -13), tz);
  const [byRole, byStatus, classes, enrollments, pendingUsers, recentAudit, logins, lockedOut, storage, attendance, semesters, courses, institutionName, registrationOpen] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], where: { anonymizedAt: null }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ['status'], where: { anonymizedAt: null }, _count: { _all: true } }),
    prisma.class.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.enrollment.count({ where: { status: 'ENROLLED', class: { status: 'ACTIVE' } } }),
    prisma.user.findMany({ where: { status: 'PENDING' }, select: { id: true, firstName: true, lastName: true, email: true, role: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 6 }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { actor: { select: { firstName: true, lastName: true } } } }),
    prisma.session.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, userId: true } }),
    prisma.user.count({ where: { lockedUntil: { gt: now } } }),
    prisma.file.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true }, _count: { _all: true } }),
    prisma.attendanceRecord.groupBy({ by: ['status'], where: { session: { status: 'CLOSED', startTime: { gte: since } } }, _count: { _all: true } }),
    prisma.semester.findMany({ where: { isCurrent: true }, select: { id: true, name: true, academicYear: { select: { name: true } } }, take: 1 }),
    prisma.course.count(),
    getSetting('institution.name'),
    getSetting('registration.allowStudentSelfSignup'),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => addDays(dateKey(now, tz), i - 13));
  const perDay = new Map(days.map((d) => [d, new Set()]));
  for (const s of logins) perDay.get(dateKey(s.createdAt, tz))?.add(s.userId);
  const count = (rows, key, value) => rows.find((r) => r[key] === value)?._count._all ?? 0;
  const att = Object.fromEntries(attendance.map((a) => [a.status.toLowerCase(), a._count._all]));
  // What a new installation needs before the first class can meet, in the order it is needed.
  // Each step is read from the data, so the guide ticks itself off and disappears when all is done.
  const steps = [
    { key: 'institution', done: institutionName !== SETTING_DEFINITIONS['institution.name'].default },
    { key: 'profile', done: !(user.firstName === PLACEHOLDER_ADMIN.firstName && user.lastName === PLACEHOLDER_ADMIN.lastName) },
    { key: 'semester', done: semesters.length > 0 },
    { key: 'courses', done: courses > 0 },
    { key: 'teachers', done: count(byRole, 'role', 'TEACHER') > 0 },
    { key: 'classes', done: classes.some((c) => c._count._all > 0) },
    { key: 'students', done: count(byRole, 'role', 'STUDENT') > 0 },
  ];
  return {
    role: 'ADMIN',
    date: dateKey(now, tz),
    stats: {
      students: count(byRole, 'role', 'STUDENT'), teachers: count(byRole, 'role', 'TEACHER'), admins: count(byRole, 'role', 'ADMIN'),
      activeClasses: count(classes, 'status', 'ACTIVE'), archivedClasses: count(classes, 'status', 'ARCHIVED'), enrollments,
      pendingApprovals: count(byStatus, 'status', 'PENDING'), suspended: count(byStatus, 'status', 'SUSPENDED'), lockedOut,
    },
    currentSemester: semesters[0] ? `${semesters[0].name}, ${semesters[0].academicYear.name}` : null,
    signIns: days.map((d) => ({ date: d, users: perDay.get(d).size })),
    attendance14d: { ...att, rate: rateOf({ present: att.present ?? 0, late: att.late ?? 0, absent: att.absent ?? 0 }) },
    pendingUsers: pendingUsers.map((u) => ({ id: u.id, name: fullName(u), email: u.email, role: u.role, createdAt: u.createdAt })),
    recentAudit: recentAudit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actor: a.actor ? fullName(a.actor) : 'System', at: a.createdAt })),
    setup: { steps, complete: steps.every((s) => s.done) },
    system: {
      environment: env.nodeEnv,
      mailConfigured: mailConfigured(),
      /** False where nothing can be e-mailed: forgotten passwords are then replaced by an administrator. */
      mailAvailable: mailAvailable(),
      aiConfigured: env.ai.configured,
      codeRunnerConfigured: env.codeRunner.configured,
      storageBytes: storage._sum.sizeBytes ?? 0,
      storedFiles: storage._count._all,
      registrationOpen: Boolean(registrationOpen),
    },
  };
}

dashboardRouter.get('/', async (req, res) => {
  if (req.user.role === 'ADMIN') ok(res, await adminDashboard(req.user));
  else if (req.user.role === 'TEACHER') ok(res, await teacherDashboard(req.user));
  else ok(res, await studentDashboard(req.user));
});

