// Gradebook data access: loads a class's structure and scores and feeds them to the pure
// computation in compute.js. Assignments and quizzes write their scores here through
// `recordGrade`, so there is exactly one place where a grade changes — and where its history
// is written.
import { prisma } from '../../db/prisma.js';
import { conflict } from '../../lib/errors.js';
import { fullName } from '../../lib/http.js';
import { quizResultsVisible } from '../../lib/visibility.js';
import { getSetting } from '../../services/settings.js';
import { OVERALL_SCOPE, computeStudentGrades, explainGrades, validateStructure } from './compute.js';

const structureInclude = {
  categories: {
    orderBy: { position: 'asc' },
    include: {
      items: {
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        include: {
          assignment: { select: { id: true, dueAt: true, status: true, publishAt: true, deletedAt: true } },
          quiz: { select: { id: true, availableUntil: true, status: true, publishAt: true, deletedAt: true, resultVisibility: true, resultsPublishedAt: true } },
        },
      },
    },
  },
};

export async function loadStructure(classId, db = prisma) {
  return db.gradingPeriod.findMany({ where: { classId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: structureInclude });
}

/** Settings object consumed by compute.js. */
export async function gradingSettings(cls, db = prisma) {
  const scale = cls.gradingScaleId
    ? await db.gradingScale.findUnique({ where: { id: cls.gradingScaleId }, include: { entries: true } })
    : await db.gradingScale.findFirst({ where: { isDefault: true }, include: { entries: true } });
  return {
    treatMissingAsZero: cls.treatMissingAsZero,
    transmutationBase: cls.transmutationBase,
    gradeRounding: cls.gradeRounding,
    attendanceLateCredit: cls.attendanceLateCredit,
    attendanceCounts: Boolean(await getSetting('grading.allowAttendanceInGrades')),
    scaleEntries: (scale?.entries ?? []).map((e) => ({ minPercent: e.minPercent, label: e.label, remark: e.remark, isPassing: e.isPassing })),
    scale: scale ? { id: scale.id, name: scale.name } : null,
  };
}

const isLive = (record, now) => record && !record.deletedAt && (record.status === 'PUBLISHED' || (record.status === 'SCHEDULED' && record.publishAt && record.publishAt <= now));

/**
 * Score entries of a class, completed with what can be derived at read time:
 * an assignment past its due date with nothing submitted, or a closed quiz with no attempt, is
 * MISSING without anybody having to mark it.
 *
 * @returns {Map<string, Map<string, object>>} studentId → (gradeItemId → entry)
 */
export async function loadEntries(classId, periods, studentIds, db = prisma, now = new Date()) {
  const items = periods.flatMap((p) => p.categories.flatMap((c) => c.items));
  const result = new Map(studentIds.map((id) => [id, new Map()]));
  if (items.length === 0 || studentIds.length === 0) return result;

  const entries = await db.gradeEntry.findMany({ where: { gradeItemId: { in: items.map((i) => i.id) }, studentId: { in: studentIds } } });
  for (const e of entries) result.get(e.studentId)?.set(e.gradeItemId, e);

  const dueAssignments = items.filter((i) => i.assignment && isLive(i.assignment, now) && i.assignment.dueAt && i.assignment.dueAt <= now);
  const closedQuizzes = items.filter((i) => i.quiz && isLive(i.quiz, now) && i.quiz.availableUntil && i.quiz.availableUntil <= now);
  const [submitted, attempted] = await Promise.all([
    dueAssignments.length === 0
      ? []
      : db.assignmentSubmission.findMany({
          where: { assignmentId: { in: dueAssignments.map((i) => i.assignmentId) }, studentId: { in: studentIds }, status: { not: 'DRAFT' } },
          select: { assignmentId: true, studentId: true },
        }),
    closedQuizzes.length === 0
      ? []
      : db.quizAttempt.findMany({ where: { quizId: { in: closedQuizzes.map((i) => i.quizId) }, studentId: { in: studentIds } }, select: { quizId: true, studentId: true }, distinct: ['quizId', 'studentId'] }),
  ]);
  const done = new Set([...submitted.map((s) => `a:${s.assignmentId}:${s.studentId}`), ...attempted.map((a) => `q:${a.quizId}:${a.studentId}`)]);
  for (const item of [...dueAssignments, ...closedQuizzes]) {
    const key = item.assignmentId ? `a:${item.assignmentId}` : `q:${item.quizId}`;
    for (const studentId of studentIds) {
      const mine = result.get(studentId);
      const existing = mine.get(item.id);
      if (existing && existing.status !== 'UNGRADED') continue;
      if (!done.has(`${key}:${studentId}`)) mine.set(item.id, { ...(existing ?? { gradeItemId: item.id, studentId, score: null, isLate: false, feedback: null }), status: 'MISSING', derived: true });
    }
  }
  return result;
}

async function loadOverrides(classId, studentIds, db = prisma) {
  const rows = await db.gradeOverride.findMany({ where: { classId, revokedAt: null, studentId: { in: studentIds } }, orderBy: { createdAt: 'desc' } });
  const map = new Map();
  for (const o of rows) {
    if (!map.has(o.studentId)) map.set(o.studentId, []);
    // Newest first: only the most recent active override per scope applies.
    if (!map.get(o.studentId).some((x) => x.scope === o.scope)) map.get(o.studentId).push(o);
  }
  return map;
}

async function loadAttendanceTotals(classId, periods, studentIds, db = prisma) {
  const map = new Map();
  if (!periods.some((p) => p.categories.some((c) => c.kind === 'ATTENDANCE'))) return map;
  const rows = await db.attendanceRecord.groupBy({
    by: ['studentId', 'status'],
    where: { studentId: { in: studentIds }, session: { classId, status: 'CLOSED' } },
    _count: { _all: true },
  });
  for (const r of rows) {
    if (!map.has(r.studentId)) map.set(r.studentId, { present: 0, late: 0, absent: 0, excused: 0 });
    map.get(r.studentId)[r.status.toLowerCase()] = r._count._all;
  }
  return map;
}

const toComputePeriods = (periods) =>
  periods.map((p) => ({
    id: p.id, name: p.name, weight: p.weight,
    categories: p.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, weight: c.weight, items: c.items.map((i) => ({ id: i.id, title: i.title, maxPoints: i.maxPoints })) })),
  }));

/**
 * Everything needed to show or export a class's grades.
 * @returns {{ periods, settings, structureErrors, students: Array<{ student, entries: Map, result }> }}
 */
export async function computeClassGrades(cls, { studentIds, db = prisma } = {}) {
  const periods = await loadStructure(cls.id, db);
  const settings = await gradingSettings(cls, db);
  const enrollments = await db.enrollment.findMany({
    where: { classId: cls.id, status: 'ENROLLED', ...(studentIds ? { studentId: { in: studentIds } } : {}) },
    select: { student: { select: { id: true, firstName: true, lastName: true, email: true, studentProfile: { select: { studentNumber: true } } } } },
    orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
  });
  const ids = enrollments.map((e) => e.student.id);
  const [entries, overrides, attendance] = await Promise.all([
    loadEntries(cls.id, periods, ids, db),
    loadOverrides(cls.id, ids, db),
    loadAttendanceTotals(cls.id, periods, ids, db),
  ]);
  const computePeriods = toComputePeriods(periods);
  const students = enrollments.map(({ student }) => ({
    student: { id: student.id, name: fullName(student), firstName: student.firstName, lastName: student.lastName, email: student.email, studentNumber: student.studentProfile?.studentNumber ?? null },
    entries: entries.get(student.id),
    result: computeStudentGrades({
      periods: computePeriods, entries: entries.get(student.id), settings, attendance: attendance.get(student.id) ?? null, overrides: overrides.get(student.id) ?? [],
    }),
  }));
  return { periods, settings, structureErrors: validateStructure(periods), students };
}

/** Is this item's score already released to the student outside the gradebook? */
function releasedOutsideGradebook(item, submissionStatus, now) {
  if (item.assignmentId) return submissionStatus === 'RETURNED';
  if (item.quizId) return quizResultsVisible(item.quiz, now);
  return false;
}

/**
 * A student's own view of their grades in a class.
 *
 * Computed period grades appear once the teacher publishes the period; the overall grade once
 * every period is published (or the class is finalised). Before that, the student still sees
 * the scores that were already released to them: returned assignments and quizzes whose results
 * are visible.
 */
export async function studentGradeView(cls, studentId, now = new Date()) {
  if (cls.gradesFinalizedAt) {
    const final = await prisma.finalGrade.findUnique({ where: { classId_studentId_scope: { classId: cls.id, studentId, scope: OVERALL_SCOPE } } });
    if (final) return { finalized: true, finalizedAt: cls.gradesFinalizedAt, ...final.breakdown };
  }
  const { periods, settings, students } = await computeClassGrades(cls, { studentIds: [studentId] });
  const mine = students[0];
  if (!mine) return null;
  const submissions = await prisma.assignmentSubmission.findMany({ where: { studentId, assignment: { classId: cls.id } }, select: { assignmentId: true, status: true } });
  const submissionStatus = new Map(submissions.map((s) => [s.assignmentId, s.status]));
  const itemById = new Map(periods.flatMap((p) => p.categories.flatMap((c) => c.items.map((i) => [i.id, i]))));
  const allPublished = periods.length > 0 && periods.every((p) => p.publishedAt);

  const viewPeriods = mine.result.periods.map((computed, index) => {
    const period = periods[index];
    const published = Boolean(period.publishedAt);
    return {
      id: period.id,
      name: period.name,
      weight: period.weight,
      published,
      ...(published
        ? { percent: computed.percent, computedPercent: computed.computedPercent, rawPercent: computed.rawPercent, label: computed.label, remark: computed.remark, isPassing: computed.isPassing, isOverridden: computed.isOverridden, overrideReason: computed.override?.reason ?? null, isComplete: computed.isComplete }
        : { percent: null, label: null, remark: null, isPassing: null, isOverridden: false, isComplete: false }),
      categories: computed.categories.map((category) => ({
        id: category.id,
        name: category.name,
        kind: category.kind,
        weight: category.weight,
        percent: published ? category.percent : null,
        earned: published ? category.earned : null,
        possible: published ? category.possible : null,
        attendance: published ? category.attendance ?? null : null,
        items: category.items.map((item) => {
          const source = itemById.get(item.id);
          const visible = published || releasedOutsideGradebook(source, submissionStatus.get(source.assignmentId), now);
          const entry = mine.entries.get(item.id);
          return {
            id: item.id,
            title: item.title,
            maxPoints: item.maxPoints,
            source: source.source,
            assignmentId: source.assignmentId,
            quizId: source.quizId,
            dueAt: source.dueAt,
            // A grade that is not released yet looks exactly like one that does not exist yet.
            status: item.status === 'GRADED' && !visible ? 'UNGRADED' : item.status,
            score: visible ? item.score : null,
            isLate: item.isLate,
            counted: published ? item.counted : null,
            feedback: visible ? entry?.feedback ?? null : null,
          };
        }),
      })),
    };
  });

  const publishedResult = { periods: mine.result.periods.filter((_, i) => periods[i].publishedAt), overall: mine.result.overall };
  return {
    finalized: false,
    finalizedAt: null,
    scale: settings.scale ? { ...settings.scale, entries: settings.scaleEntries } : null,
    policy: { treatMissingAsZero: settings.treatMissingAsZero, transmutationBase: settings.transmutationBase, gradeRounding: settings.gradeRounding },
    periods: viewPeriods,
    overall: allPublished
      ? { percent: mine.result.overall.percent, computedPercent: mine.result.overall.computedPercent, label: mine.result.overall.label, remark: mine.result.overall.remark, isPassing: mine.result.overall.isPassing, isOverridden: mine.result.overall.isOverridden, overrideReason: mine.result.overall.override?.reason ?? null, isComplete: mine.result.overall.isComplete }
      : null,
    explanation: publishedResult.periods.length === 0 ? [] : explainGrades(allPublished ? mine.result : { periods: publishedResult.periods, overall: { ...mine.result.overall, isOverridden: false, label: null } }, settings),
  };
}

/** Snapshot stored in FinalGrade.breakdown — the complete, self-contained record of a final grade. */
export function finalSnapshot(row, periods, settings) {
  const itemById = new Map(periods.flatMap((p) => p.categories.flatMap((c) => c.items.map((i) => [i.id, i]))));
  const pick = (g) => ({ percent: g.percent, computedPercent: g.computedPercent, rawPercent: g.rawPercent, label: g.label, remark: g.remark, isPassing: g.isPassing, isOverridden: g.isOverridden, overrideReason: g.override?.reason ?? null, isComplete: g.isComplete });
  return {
    scale: settings.scale ? { ...settings.scale, entries: settings.scaleEntries } : null,
    policy: { treatMissingAsZero: settings.treatMissingAsZero, transmutationBase: settings.transmutationBase, gradeRounding: settings.gradeRounding },
    periods: row.result.periods.map((p) => ({
      id: p.id, name: p.name, weight: p.weight, published: true, ...pick(p),
      categories: p.categories.map((c) => ({
        id: c.id, name: c.name, kind: c.kind, weight: c.weight, percent: c.percent, earned: c.earned, possible: c.possible, attendance: c.attendance ?? null,
        items: c.items.map((i) => {
          const source = itemById.get(i.id);
          return { id: i.id, title: i.title, maxPoints: i.maxPoints, source: source.source, assignmentId: source.assignmentId, quizId: source.quizId, dueAt: source.dueAt, status: i.status, score: i.score, isLate: i.isLate, counted: i.counted, feedback: row.entries.get(i.id)?.feedback ?? null };
        }),
      })),
    })),
    overall: pick(row.result.overall),
    explanation: explainGrades(row.result, settings),
  };
}

// ── Writing grades ───────────────────────────────────────────────────────────

/** Refuse changes to grades that are locked or finalised. */
export async function assertItemOpen(db, gradeItemId) {
  const item = await db.gradeItem.findUnique({
    where: { id: gradeItemId },
    select: { id: true, maxPoints: true, title: true, classId: true, class: { select: { gradesFinalizedAt: true } }, category: { select: { period: { select: { name: true, lockedAt: true } } } } },
  });
  if (!item) return null;
  if (item.class.gradesFinalizedAt) throw conflict('Grades for this class are finalised. Reopen the gradebook to change them.', 'GRADES_FINALIZED');
  if (item.category.period.lockedAt) throw conflict(`Grades for "${item.category.period.name}" are locked. Unlock the period to change them.`, 'PERIOD_LOCKED');
  return item;
}

/**
 * Create or update one student's entry for a grade item and append the change to its history.
 * Returns the stored entry, or null when the value did not change.
 */
export async function recordGrade(tx, { gradeItemId, studentId, score, status, isLate, feedback, source, changedById = null, reason = null }) {
  await assertItemOpen(tx, gradeItemId);
  const existing = await tx.gradeEntry.findUnique({ where: { gradeItemId_studentId: { gradeItemId, studentId } } });
  const next = {
    score: status === 'GRADED' ? score : null,
    status,
    isLate: isLate ?? existing?.isLate ?? false,
    feedback: feedback === undefined ? existing?.feedback ?? null : feedback,
  };
  const scoreChanged = !existing || existing.score !== next.score || existing.status !== next.status;
  if (existing && !scoreChanged && existing.isLate === next.isLate && existing.feedback === next.feedback) return null;
  const graded = status === 'GRADED' ? { gradedById: changedById, gradedAt: new Date() } : {};
  const entry = existing
    ? await tx.gradeEntry.update({ where: { id: existing.id }, data: { ...next, ...graded } })
    : await tx.gradeEntry.create({ data: { gradeItemId, studentId, ...next, ...graded } });
  if (scoreChanged) {
    await tx.gradeHistory.create({
      data: { gradeEntryId: entry.id, oldScore: existing?.score ?? null, newScore: next.score, oldStatus: existing?.status ?? null, newStatus: next.status, source, reason, changedById },
    });
  }
  return entry;
}

/** Create, update or remove the gradebook column that mirrors an assignment or a quiz. */
export async function syncLinkedItem(tx, { classId, categoryId, title, maxPoints, dueAt, assignmentId = null, quizId = null }) {
  const where = assignmentId ? { assignmentId } : { quizId };
  const existing = await tx.gradeItem.findUnique({ where });
  if (!categoryId) {
    // "Not graded": the column disappears, together with the scores it held.
    if (existing) {
      await assertItemOpen(tx, existing.id);
      await tx.gradeHistory.deleteMany({ where: { gradeEntry: { gradeItemId: existing.id } } });
      await tx.gradeEntry.deleteMany({ where: { gradeItemId: existing.id } });
      await tx.gradeAppeal.updateMany({ where: { gradeItemId: existing.id }, data: { gradeItemId: null } });
      await tx.gradeItem.delete({ where: { id: existing.id } });
    }
    return null;
  }
  const category = await tx.gradeCategory.findFirst({ where: { id: categoryId, period: { classId } }, select: { id: true, kind: true } });
  if (!category) return { error: 'Choose a grade category from this class.' };
  if (category.kind === 'ATTENDANCE') return { error: 'The attendance category is computed from attendance records and cannot hold graded work.' };
  if (existing) {
    if (existing.categoryId !== category.id || existing.maxPoints !== maxPoints) await assertItemOpen(tx, existing.id);
    return tx.gradeItem.update({ where: { id: existing.id }, data: { categoryId: category.id, title, maxPoints, dueAt: dueAt ?? null } });
  }
  const last = await tx.gradeItem.aggregate({ where: { categoryId: category.id }, _max: { position: true } });
  return tx.gradeItem.create({
    data: { classId, categoryId: category.id, title, maxPoints, dueAt: dueAt ?? null, source: assignmentId ? 'ASSIGNMENT' : 'QUIZ', assignmentId, quizId, position: (last._max.position ?? -1) + 1 },
  });
}

/** Grade categories a teacher can file graded work under, for pickers. */
export async function categoryOptions(classId) {
  const periods = await prisma.gradingPeriod.findMany({
    where: { classId }, orderBy: { position: 'asc' },
    select: { id: true, name: true, lockedAt: true, categories: { where: { kind: { not: 'ATTENDANCE' } }, orderBy: { position: 'asc' }, select: { id: true, name: true, kind: true, weight: true } } },
  });
  return periods.map((p) => ({ id: p.id, name: p.name, locked: Boolean(p.lockedAt), categories: p.categories }));
}
