// Class analytics and "at-risk" indicators.
//
// The indicators are deliberately simple, explainable rules with administrator-set thresholds —
// not a prediction. Every flag comes with the reason that raised it, and it is shown to the class
// teacher (and administrators) only, never to other students.
import { prisma } from '../../db/prisma.js';
import { round } from '../../lib/http.js';
import { isPublished } from '../../lib/visibility.js';
import { getSettings } from '../../services/settings.js';
import { computeClassGrades } from '../gradebook/service.js';

export async function riskThresholds() {
  const s = await getSettings();
  return { gradeBelow: s['analytics.atRiskGradeBelow'], attendanceBelow: s['analytics.atRiskAttendanceBelow'], missingAtLeast: s['analytics.atRiskMissingAtLeast'] };
}

/** Overdue work nobody handed in, per student: Map(studentId → [{ kind, id, title, dueAt }]). */
export async function missingWork(classId, studentIds, now = new Date()) {
  const [assignments, quizzes] = await Promise.all([
    prisma.assignment.findMany({ where: { classId, deletedAt: null, dueAt: { lte: now } }, select: { id: true, title: true, dueAt: true, status: true, publishAt: true } }),
    prisma.quiz.findMany({ where: { classId, deletedAt: null, availableUntil: { lte: now }, kind: { not: 'PRACTICE' } }, select: { id: true, title: true, availableUntil: true, status: true, publishAt: true } }),
  ]);
  const liveAssignments = assignments.filter((a) => isPublished(a, now));
  const liveQuizzes = quizzes.filter((q) => isPublished(q, now));
  const [submitted, attempted] = await Promise.all([
    liveAssignments.length === 0 ? [] : prisma.assignmentSubmission.findMany({ where: { assignmentId: { in: liveAssignments.map((a) => a.id) }, studentId: { in: studentIds }, status: { not: 'DRAFT' } }, select: { assignmentId: true, studentId: true } }),
    liveQuizzes.length === 0 ? [] : prisma.quizAttempt.findMany({ where: { quizId: { in: liveQuizzes.map((q) => q.id) }, studentId: { in: studentIds } }, select: { quizId: true, studentId: true }, distinct: ['quizId', 'studentId'] }),
  ]);
  const done = new Set([...submitted.map((s) => `a:${s.assignmentId}:${s.studentId}`), ...attempted.map((a) => `q:${a.quizId}:${a.studentId}`)]);
  const result = new Map();
  for (const studentId of studentIds) {
    const items = [
      ...liveAssignments.filter((a) => !done.has(`a:${a.id}:${studentId}`)).map((a) => ({ kind: 'ASSIGNMENT', id: a.id, title: a.title, dueAt: a.dueAt })),
      ...liveQuizzes.filter((q) => !done.has(`q:${q.id}:${studentId}`)).map((q) => ({ kind: 'QUIZ', id: q.id, title: q.title, dueAt: q.availableUntil })),
    ].sort((a, b) => b.dueAt - a.dueAt);
    result.set(studentId, items);
  }
  return result;
}

export async function attendanceTotals(classId, studentIds) {
  const rows = await prisma.attendanceRecord.groupBy({
    by: ['studentId', 'status'], where: { studentId: { in: studentIds }, session: { classId, status: 'CLOSED' } }, _count: { _all: true },
  });
  const map = new Map(studentIds.map((id) => [id, { present: 0, late: 0, absent: 0, excused: 0 }]));
  for (const r of rows) map.get(r.studentId)[r.status.toLowerCase()] = r._count._all;
  return map;
}

export const rateOf = ({ present, late, absent }) => (present + late + absent === 0 ? null : round(((present + late) / (present + late + absent)) * 100, 1));

/** Apply the thresholds to one student's numbers. */
export function assessRisk({ percent, attendanceRate, missing }, thresholds) {
  const reasons = [];
  if (percent !== null && percent !== undefined && percent < thresholds.gradeBelow) reasons.push({ code: 'LOW_GRADE', text: `Running grade ${percent}% is below ${thresholds.gradeBelow}%` });
  if (attendanceRate !== null && attendanceRate !== undefined && attendanceRate < thresholds.attendanceBelow) reasons.push({ code: 'LOW_ATTENDANCE', text: `Attendance ${attendanceRate}% is below ${thresholds.attendanceBelow}%` });
  if (missing >= thresholds.missingAtLeast) reasons.push({ code: 'MISSING_WORK', text: `${missing} missing submission(s)` });
  return { level: reasons.length >= 2 ? 'HIGH' : reasons.length === 1 ? 'MEDIUM' : 'NONE', reasons };
}

/** Every enrolled student of a class with their indicators. */
export async function classRisk(cls) {
  const thresholds = await riskThresholds();
  const { students, periods } = await computeClassGrades(cls);
  const ids = students.map((s) => s.student.id);
  const [attendance, missing] = await Promise.all([attendanceTotals(cls.id, ids), missingWork(cls.id, ids)]);
  const rows = students.map(({ student, result }) => {
    const totals = attendance.get(student.id);
    const attendanceRate = rateOf(totals);
    const missingItems = missing.get(student.id) ?? [];
    const percent = result.overall.percent;
    return {
      id: student.id, name: student.name, studentNumber: student.studentNumber,
      percent, label: result.overall.label, isPassing: result.overall.isPassing,
      attendanceRate, absences: totals.absent, lates: totals.late,
      missing: missingItems.length, missingItems: missingItems.slice(0, 5),
      risk: assessRisk({ percent, attendanceRate, missing: missingItems.length }, thresholds),
    };
  });
  return { thresholds, students: rows, periods };
}

/** Charts for the teacher's analytics page. */
export async function classAnalytics(cls) {
  const { thresholds, students } = await classRisk(cls);
  const bins = [[90, 100], [80, 89.99], [75, 79.99], [60, 74.99], [0, 59.99]].map(([min, max]) => ({ label: `${min}–${Math.round(max)}`, min, max, count: 0 }));
  for (const s of students) {
    if (s.percent === null) continue;
    bins.find((b) => s.percent >= b.min && s.percent <= b.max + 0.01).count += 1;
  }
  const sessions = await prisma.attendanceSession.findMany({
    where: { classId: cls.id, status: 'CLOSED' }, orderBy: { startTime: 'asc' }, take: 60,
    select: { id: true, date: true, title: true, records: { select: { status: true } } },
  });
  const items = await prisma.gradeItem.findMany({
    where: { classId: cls.id }, orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, maxPoints: true, source: true, entries: { where: { status: 'GRADED', score: { not: null } }, select: { score: true } } },
  });
  const [submissions, lessons, progress] = await Promise.all([
    prisma.assignmentSubmission.groupBy({ by: ['isLate'], where: { assignment: { classId: cls.id, deletedAt: null }, status: { not: 'DRAFT' }, studentId: { in: students.map((s) => s.id) } }, _count: { _all: true } }),
    prisma.lesson.count({ where: { deletedAt: null, status: 'PUBLISHED', module: { classId: cls.id, deletedAt: null, status: 'PUBLISHED' } } }),
    prisma.lessonProgress.count({ where: { completedAt: { not: null }, studentId: { in: students.map((s) => s.id) }, lesson: { deletedAt: null, status: 'PUBLISHED', module: { classId: cls.id, deletedAt: null, status: 'PUBLISHED' } } } }),
  ]);
  const graded = students.filter((s) => s.percent !== null);
  const rates = students.filter((s) => s.attendanceRate !== null);
  return {
    thresholds,
    summary: {
      students: students.length,
      averageGrade: graded.length === 0 ? null : round(graded.reduce((a, s) => a + s.percent, 0) / graded.length, 1),
      averageAttendance: rates.length === 0 ? null : round(rates.reduce((a, s) => a + s.attendanceRate, 0) / rates.length, 1),
      atRisk: students.filter((s) => s.risk.level !== 'NONE').length,
      highRisk: students.filter((s) => s.risk.level === 'HIGH').length,
      lessonCompletion: lessons === 0 || students.length === 0 ? null : round((progress / (lessons * students.length)) * 100, 1),
      onTime: submissions.find((g) => !g.isLate)?._count._all ?? 0,
      late: submissions.find((g) => g.isLate)?._count._all ?? 0,
      missing: students.reduce((a, s) => a + s.missing, 0),
    },
    gradeDistribution: bins.map(({ label, count }) => ({ label, count })),
    attendanceTrend: sessions.map((s) => {
      const counted = s.records.filter((r) => r.status !== 'EXCUSED').length;
      const attended = s.records.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;
      return { date: s.date.toISOString().slice(0, 10), title: s.title, rate: counted === 0 ? null : round((attended / counted) * 100, 1) };
    }),
    assessments: items.filter((i) => i.entries.length > 0).map((i) => ({
      id: i.id, title: i.title, source: i.source, graded: i.entries.length,
      average: round((i.entries.reduce((a, e) => a + e.score, 0) / i.entries.length / i.maxPoints) * 100, 1),
    })),
    students: students.sort((a, b) => b.risk.reasons.length - a.risk.reasons.length || (a.percent ?? 101) - (b.percent ?? 101)),
  };
}
