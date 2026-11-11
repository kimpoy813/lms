// Gradebook API: structure, scores, overrides, publishing, locking, finalisation, exports,
// student view and grade appeals.
import { Router } from 'express';
import { z } from 'zod';
import { lockKey, prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { exportFormat, sendTable } from '../../lib/exporter.js';
import { created, fullName, idParams, noContent, ok, patchOf, round, zId, zOptionalDateTime, zTitle } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { dateKey } from '../../lib/time.js';
import { assertPermission, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { getSetting, getTimeZone } from '../../services/settings.js';
import { assertClassWritable, classLabel, loadClassAccess, requireClassManager, requireClassStudent } from '../classes/access.js';
import { quizOutcome } from '../quizzes/attemptScore.js';
import { OVERALL_SCOPE, validateStructure } from './compute.js';
import { STRUCTURE_TEMPLATES } from './defaults.js';
import { assertItemOpen, categoryOptions, computeClassGrades, finalSnapshot, loadStructure, recordGrade, studentGradeView } from './service.js';

export const classGradebookRouter = Router({ mergeParams: true }); // /classes/:classId/gradebook
classGradebookRouter.use(requireAuth);
export const gradesRouter = Router(); // /grades
gradesRouter.use(requireAuth);

const classParams = idParams('classId');
const CATEGORY_KINDS = ['QUIZ', 'ASSIGNMENT', 'ACTIVITY', 'LABORATORY', 'PROJECT', 'EXAM', 'PARTICIPATION', 'ATTENDANCE', 'CUSTOM'];
const reasonField = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);

async function managed(req, { writable = true } = {}) {
  const access = await requireClassManager(req.user, req.valid.params.classId);
  if (writable) assertClassWritable(access.cls);
  return access.cls;
}

function assertNotFinalized(cls) {
  if (cls.gradesFinalizedAt) throw conflict('Grades for this class are finalised. Reopen the gradebook to change them.', 'GRADES_FINALIZED');
}

/** Changes that alter how every grade is computed are refused while any period is locked. */
async function assertUnlocked(cls, db = prisma) {
  assertNotFinalized(cls);
  const locked = await db.gradingPeriod.findFirst({ where: { classId: cls.id, lockedAt: { not: null } }, select: { name: true } });
  if (locked) throw conflict(`"${locked.name}" is locked. Unlock the grading periods before changing how grades are computed.`, 'PERIOD_LOCKED');
}

// ── Views ────────────────────────────────────────────────────────────────────
const periodHead = (p) => ({
  id: p.id, name: p.name, weight: p.weight, position: p.position, publishedAt: p.publishedAt, lockedAt: p.lockedAt,
  categories: p.categories.map((c) => ({
    id: c.id, name: c.name, kind: c.kind, weight: c.weight,
    items: c.items.map((i) => ({ id: i.id, title: i.title, maxPoints: i.maxPoints, source: i.source, assignmentId: i.assignmentId, quizId: i.quizId, dueAt: i.dueAt })),
  })),
});

const gradeCell = (g) => ({ percent: g.percent, computedPercent: g.computedPercent, label: g.label, remark: g.remark, isPassing: g.isPassing, isOverridden: g.isOverridden, isComplete: g.isComplete, overrideId: g.override?.id ?? null, overrideReason: g.override?.reason ?? null });

async function classSettingsView(cls, settings) {
  return {
    treatMissingAsZero: cls.treatMissingAsZero,
    transmutationBase: cls.transmutationBase,
    gradeRounding: cls.gradeRounding,
    attendanceLateCredit: cls.attendanceLateCredit,
    gradingScale: settings.scale ? { ...settings.scale, entries: [...settings.scaleEntries].sort((a, b) => b.minPercent - a.minPercent) } : null,
    usesDefaultScale: !cls.gradingScaleId,
    attendanceAllowed: settings.attendanceCounts,
    finalizedAt: cls.gradesFinalizedAt,
  };
}

/** When grades are finalised the stored record is what counts, not a fresh computation. */
async function overlayFinal(cls, rows) {
  if (!cls.gradesFinalizedAt) return rows;
  const finals = await prisma.finalGrade.findMany({ where: { classId: cls.id }, select: { studentId: true, scope: true, percent: true, label: true, remark: true, isPassing: true, isOverridden: true } });
  const byKey = new Map(finals.map((f) => [`${f.studentId}:${f.scope}`, f]));
  const apply = (studentId, scope, cell) => {
    const f = byKey.get(`${studentId}:${scope}`);
    return f ? { ...cell, percent: f.percent, label: f.label, remark: f.remark, isPassing: f.isPassing, isOverridden: f.isOverridden } : cell;
  };
  return rows.map((r) => ({
    ...r,
    periods: Object.fromEntries(Object.entries(r.periods).map(([id, cell]) => [id, apply(r.id, id, cell)])),
    overall: apply(r.id, OVERALL_SCOPE, r.overall),
  }));
}

async function matrix(cls) {
  const { periods, settings, structureErrors, students } = await computeClassGrades(cls);
  const rows = await overlayFinal(cls, students.map(({ student, entries, result }) => ({
    id: student.id,
    name: student.name,
    firstName: student.firstName,
    lastName: student.lastName,
    studentNumber: student.studentNumber,
    entries: Object.fromEntries([...entries.entries()].map(([itemId, e]) => [itemId, { score: e.score, status: e.status, isLate: e.isLate, feedback: e.feedback ?? null, derived: Boolean(e.derived) }])),
    periods: Object.fromEntries(result.periods.map((p) => [p.id, gradeCell(p)])),
    overall: gradeCell(result.overall),
    missingCount: [...entries.values()].filter((e) => e.status === 'MISSING').length,
  })));
  const graded = rows.filter((r) => r.overall.percent !== null);
  return {
    class: { id: cls.id, label: classLabel(cls), title: cls.course.title, status: cls.status, ...(await classSettingsView(cls, settings)) },
    structure: { valid: structureErrors.length === 0, errors: structureErrors, periods: periods.map(periodHead) },
    students: rows,
    stats: {
      students: rows.length,
      graded: graded.length,
      average: graded.length === 0 ? null : round(graded.reduce((s, r) => s + r.overall.percent, 0) / graded.length, 2),
      highest: graded.length === 0 ? null : Math.max(...graded.map((r) => r.overall.percent)),
      lowest: graded.length === 0 ? null : Math.min(...graded.map((r) => r.overall.percent)),
      passing: graded.filter((r) => r.overall.isPassing === true).length,
      failing: graded.filter((r) => r.overall.isPassing === false).length,
    },
  };
}

classGradebookRouter.get('/', validate({ params: classParams }), async (req, res) => {
  const cls = await managed(req, { writable: false });
  ok(res, await matrix(cls));
});

classGradebookRouter.get('/categories', validate({ params: classParams }), async (req, res) => {
  const cls = await managed(req, { writable: false });
  ok(res, await categoryOptions(cls.id));
});

classGradebookRouter.get('/templates', validate({ params: classParams }), async (req, res) => {
  await managed(req, { writable: false });
  ok(res, STRUCTURE_TEMPLATES.map((t) => ({ key: t.key, label: t.label, periods: t.periods.map((p) => ({ name: p.name, weight: p.weight, categories: p.categories })) })));
});

/** A student's own grades. */
classGradebookRouter.get('/mine', validate({ params: classParams }), async (req, res) => {
  const { cls } = await requireClassStudent(req.user, req.valid.params.classId);
  const view = await studentGradeView(cls, req.user.id);
  ok(res, { class: { id: cls.id, label: classLabel(cls), title: cls.course.title }, ...view });
});

/** One student's full breakdown, for the teacher. */
classGradebookRouter.get('/students/:studentId', validate({ params: idParams('classId', 'studentId') }), async (req, res) => {
  const cls = await managed(req, { writable: false });
  const { periods, settings, students } = await computeClassGrades(cls, { studentIds: [req.valid.params.studentId] });
  const row = students[0];
  if (!row) throw notFound('Student');
  const snapshot = finalSnapshot(row, periods, settings);
  const [history, overrides] = await Promise.all([
    prisma.gradeHistory.findMany({
      where: { gradeEntry: { studentId: row.student.id, gradeItem: { classId: cls.id } } },
      include: { gradeEntry: { select: { gradeItem: { select: { title: true } } } }, changedBy: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.gradeOverride.findMany({ where: { classId: cls.id, studentId: row.student.id }, include: { createdBy: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } }),
  ]);
  ok(res, {
    student: row.student,
    ...snapshot,
    periods: snapshot.periods.map((p, i) => ({ ...p, published: Boolean(periods[i].publishedAt), locked: Boolean(periods[i].lockedAt) })),
    overrides: overrides.map((o) => ({
      id: o.id, scope: o.scope, scopeName: o.scope === OVERALL_SCOPE ? 'Overall grade' : periods.find((p) => p.id === o.scope)?.name ?? 'Removed period',
      computedPercent: o.computedPercent, overridePercent: o.overridePercent, reason: o.reason, createdAt: o.createdAt, revokedAt: o.revokedAt, by: fullName(o.createdBy),
    })),
    history: history.map((h) => ({ id: h.id, item: h.gradeEntry.gradeItem.title, oldScore: h.oldScore, newScore: h.newScore, oldStatus: h.oldStatus, newStatus: h.newStatus, source: h.source, reason: h.reason, by: h.changedBy ? fullName(h.changedBy) : null, at: h.createdAt })),
  });
});

// ── Structure ────────────────────────────────────────────────────────────────
const structureBody = z.object({
  periods: z
    .array(
      z.object({
        id: zId.optional(),
        name: z.string().trim().min(1, 'Name the grading period').max(60),
        weight: z.number().min(0).max(100),
        categories: z
          .array(z.object({ id: zId.optional(), name: z.string().trim().min(1, 'Name the category').max(60), kind: z.enum(CATEGORY_KINDS).default('CUSTOM'), weight: z.number().min(0).max(100) }))
          .max(20),
      }),
    )
    .max(8),
});

const structureSummary = (periods) => periods.map((p) => ({ name: p.name, weight: p.weight, categories: p.categories.map((c) => ({ name: c.name, kind: c.kind, weight: c.weight })) }));

classGradebookRouter.put('/structure', validate({ params: classParams, body: structureBody }), async (req, res) => {
  const cls = await managed(req);
  const wanted = req.valid.body.periods.map((p) => ({ ...p, name: plainText(p.name, 60), categories: p.categories.map((c) => ({ ...c, name: plainText(c.name, 60) })) }));
  const errors = validateStructure(wanted);
  if (errors.length > 0) throw new AppError(422, 'INVALID_STRUCTURE', errors[0], { errors });
  for (const p of wanted) {
    if (p.categories.filter((c) => c.kind === 'ATTENDANCE').length > 1) throw new AppError(422, 'INVALID_STRUCTURE', `"${p.name}" can have only one attendance category.`, { errors: [`"${p.name}" can have only one attendance category.`] });
  }
  if (wanted.some((p) => p.categories.some((c) => c.kind === 'ATTENDANCE')) && !(await getSetting('grading.allowAttendanceInGrades'))) {
    throw new AppError(422, 'ATTENDANCE_NOT_GRADED', 'Your institution does not include attendance in grades. Remove the attendance category or ask an administrator to change the policy.');
  }

  await prisma.$transaction(async (tx) => {
    await lockKey(tx, `gradebook:${cls.id}`);
    await assertUnlocked(await tx.class.findUnique({ where: { id: cls.id } }), tx);
    const existing = await tx.gradingPeriod.findMany({ where: { classId: cls.id }, include: { categories: { include: { _count: { select: { items: true } } } } } });
    const existingPeriods = new Map(existing.map((p) => [p.id, p]));
    const existingCategories = new Map(existing.flatMap((p) => p.categories.map((c) => [c.id, c])));
    const keptPeriodIds = new Set();
    const keptCategoryIds = new Set();
    for (const p of wanted) {
      if (p.id) {
        if (!existingPeriods.has(p.id) || keptPeriodIds.has(p.id)) throw conflict('The gradebook structure changed while you were editing it. Reload and try again.', 'STALE_STRUCTURE');
        keptPeriodIds.add(p.id);
      }
      for (const c of p.categories) {
        if (!c.id) continue;
        const current = existingCategories.get(c.id);
        if (!current || keptCategoryIds.has(c.id)) throw conflict('The gradebook structure changed while you were editing it. Reload and try again.', 'STALE_STRUCTURE');
        if (c.kind === 'ATTENDANCE' && current._count.items > 0) throw conflict(`"${current.name}" contains graded work, so it cannot become the attendance category.`, 'CATEGORY_IN_USE');
        keptCategoryIds.add(c.id);
      }
    }
    for (const c of existingCategories.values()) {
      if (!keptCategoryIds.has(c.id) && c._count.items > 0) {
        throw conflict(`"${c.name}" still contains ${c._count.items} graded item(s). Move or delete them before removing the category.`, 'CATEGORY_IN_USE');
      }
    }

    // Free every name first so that swapping two names never trips the unique constraints.
    for (const p of existing) await tx.gradingPeriod.update({ where: { id: p.id }, data: { name: `~${p.id}` } });
    for (const c of existingCategories.values()) await tx.gradeCategory.update({ where: { id: c.id }, data: { name: `~${c.id}` } });

    for (const [pIndex, p] of wanted.entries()) {
      const period = p.id
        ? await tx.gradingPeriod.update({ where: { id: p.id }, data: { name: p.name, weight: p.weight, position: pIndex } })
        : await tx.gradingPeriod.create({ data: { classId: cls.id, name: p.name, weight: p.weight, position: pIndex } });
      for (const [cIndex, c] of p.categories.entries()) {
        const data = { periodId: period.id, name: c.name, kind: c.kind, weight: c.weight, position: cIndex };
        if (c.id) await tx.gradeCategory.update({ where: { id: c.id }, data });
        else await tx.gradeCategory.create({ data });
      }
    }
    const removedCategories = [...existingCategories.keys()].filter((id) => !keptCategoryIds.has(id));
    if (removedCategories.length > 0) await tx.gradeCategory.deleteMany({ where: { id: { in: removedCategories } } });
    const removedPeriods = [...existingPeriods.keys()].filter((id) => !keptPeriodIds.has(id));
    if (removedPeriods.length > 0) {
      await tx.gradeOverride.updateMany({ where: { classId: cls.id, scope: { in: removedPeriods }, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.gradingPeriod.deleteMany({ where: { id: { in: removedPeriods } } });
    }
    await audit(req, {
      action: 'gradebook.structure.update', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: 'Changed grading periods, categories or weights',
      before: structureSummary(existing.map((p) => ({ ...p, categories: [...p.categories].sort((a, b) => a.position - b.position) })).sort((a, b) => a.position - b.position)), after: structureSummary(wanted),
    }, tx);
  });
  ok(res, await matrix(cls));
});

classGradebookRouter.post('/structure/template', validate({ params: classParams, body: z.object({ key: z.string().max(40) }) }), async (req, res) => {
  const cls = await managed(req);
  const template = STRUCTURE_TEMPLATES.find((t) => t.key === req.valid.body.key);
  if (!template) throw fieldErrors({ key: 'Unknown template.' });
  await prisma.$transaction(async (tx) => {
    await lockKey(tx, `gradebook:${cls.id}`);
    await assertUnlocked(await tx.class.findUnique({ where: { id: cls.id } }), tx);
    if ((await tx.gradeItem.count({ where: { classId: cls.id } })) > 0) {
      throw conflict('A template can only be applied while the gradebook has no graded items. Edit the structure instead.', 'GRADEBOOK_IN_USE');
    }
    const before = await loadStructure(cls.id, tx);
    await tx.gradeOverride.updateMany({ where: { classId: cls.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.gradeCategory.deleteMany({ where: { period: { classId: cls.id } } });
    await tx.gradingPeriod.deleteMany({ where: { classId: cls.id } });
    for (const [pIndex, p] of template.periods.entries()) {
      await tx.gradingPeriod.create({
        data: { classId: cls.id, name: p.name, weight: p.weight, position: pIndex, categories: { create: p.categories.map((c, cIndex) => ({ name: c.name, kind: c.kind, weight: c.weight, position: cIndex })) } },
      });
    }
    await audit(req, { action: 'gradebook.structure.template', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: `Applied gradebook template "${template.label}"`, before: structureSummary(before), after: structureSummary(template.periods) }, tx);
  });
  ok(res, await matrix(cls));
});

const settingsBody = z.object({
  gradingScaleId: zId.nullable().optional(),
  transmutationBase: z.number().int().min(0).max(90).optional(),
  gradeRounding: z.number().int().min(0).max(2).optional(),
  treatMissingAsZero: z.boolean().optional(),
  attendanceLateCredit: z.number().min(0).max(1).optional(),
});

classGradebookRouter.patch('/settings', validate({ params: classParams, body: settingsBody }), async (req, res) => {
  const cls = await managed(req);
  await assertUnlocked(cls);
  const body = req.valid.body;
  if (body.gradingScaleId) {
    const scale = await prisma.gradingScale.findUnique({ where: { id: body.gradingScaleId }, select: { id: true } });
    if (!scale) throw fieldErrors({ gradingScaleId: 'Choose one of the institution\'s grading scales.' });
  }
  const keys = ['gradingScaleId', 'transmutationBase', 'gradeRounding', 'treatMissingAsZero', 'attendanceLateCredit'];
  const data = Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const updated = await prisma.class.update({ where: { id: cls.id }, data });
  await audit(req, {
    action: 'gradebook.settings.update', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: 'Changed grade computation settings',
    before: Object.fromEntries(Object.keys(data).map((k) => [k, cls[k]])), after: data,
  });
  ok(res, await matrix({ ...cls, ...updated }));
});

// ── Manual grade items ───────────────────────────────────────────────────────
const itemBody = z.object({ categoryId: zId, title: zTitle, maxPoints: z.number().positive('Points must be more than zero').max(10_000), dueAt: zOptionalDateTime });

async function loadCategory(db, classId, categoryId) {
  const category = await db.gradeCategory.findFirst({ where: { id: categoryId, period: { classId } }, include: { period: { select: { name: true, lockedAt: true } } } });
  if (!category) throw fieldErrors({ categoryId: 'Choose a category from this class.' });
  if (category.kind === 'ATTENDANCE') throw fieldErrors({ categoryId: 'The attendance category is computed from attendance records and cannot hold graded work.' });
  if (category.period.lockedAt) throw conflict(`Grades for "${category.period.name}" are locked. Unlock the period to change them.`, 'PERIOD_LOCKED');
  return category;
}

classGradebookRouter.post('/items', validate({ params: classParams, body: itemBody }), async (req, res) => {
  const cls = await managed(req);
  assertNotFinalized(cls);
  const body = req.valid.body;
  const category = await loadCategory(prisma, cls.id, body.categoryId);
  const last = await prisma.gradeItem.aggregate({ where: { categoryId: category.id }, _max: { position: true } });
  const item = await prisma.gradeItem.create({
    data: { classId: cls.id, categoryId: category.id, title: plainText(body.title, 200), maxPoints: body.maxPoints, dueAt: body.dueAt ?? null, source: 'MANUAL', position: (last._max.position ?? -1) + 1 },
  });
  created(res, { id: item.id, title: item.title, maxPoints: item.maxPoints, categoryId: item.categoryId, source: item.source, dueAt: item.dueAt });
});

async function loadItem(req, cls) {
  const item = await prisma.gradeItem.findFirst({ where: { id: req.valid.params.itemId, classId: cls.id } });
  if (!item) throw notFound('Grade item');
  return item;
}

classGradebookRouter.patch('/items/:itemId', validate({ params: idParams('classId', 'itemId'), body: patchOf(itemBody) }), async (req, res) => {
  const cls = await managed(req);
  const item = await loadItem(req, cls);
  const body = req.valid.body;
  await assertItemOpen(prisma, item.id);
  if (item.source !== 'MANUAL' && (body.title !== undefined || body.maxPoints !== undefined || body.dueAt !== undefined)) {
    throw conflict(`This column follows its ${item.source === 'QUIZ' ? 'quiz' : 'assignment'}. Change the title, points or due date there.`, 'LINKED_ITEM');
  }
  if (body.categoryId !== undefined && body.categoryId !== item.categoryId) await loadCategory(prisma, cls.id, body.categoryId);
  if (body.maxPoints !== undefined && body.maxPoints < item.maxPoints) {
    const above = await prisma.gradeEntry.count({ where: { gradeItemId: item.id, score: { gt: body.maxPoints } } });
    if (above > 0) throw fieldErrors({ maxPoints: `${above} student(s) already have a score above ${body.maxPoints}. Lower those scores first.` });
  }
  const updated = await prisma.gradeItem.update({
    where: { id: item.id },
    data: {
      ...(body.title !== undefined ? { title: plainText(body.title, 200) } : {}),
      ...(body.maxPoints !== undefined ? { maxPoints: body.maxPoints } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
    },
  });
  if (body.maxPoints !== undefined && body.maxPoints !== item.maxPoints) {
    await audit(req, { action: 'gradebook.item.update', entityType: 'GradeItem', entityId: item.id, classId: cls.id, summary: `Changed the points of "${item.title}"`, before: { maxPoints: item.maxPoints }, after: { maxPoints: body.maxPoints } });
  }
  ok(res, { id: updated.id, title: updated.title, maxPoints: updated.maxPoints, categoryId: updated.categoryId, source: updated.source, dueAt: updated.dueAt });
});

classGradebookRouter.delete('/items/:itemId', validate({ params: idParams('classId', 'itemId') }), async (req, res) => {
  const cls = await managed(req);
  const item = await loadItem(req, cls);
  if (item.source !== 'MANUAL') throw conflict(`This column belongs to ${item.source === 'QUIZ' ? 'a quiz' : 'an assignment'}. Remove it from the gradebook there.`, 'LINKED_ITEM');
  await prisma.$transaction(async (tx) => {
    await assertItemOpen(tx, item.id);
    const scores = await tx.gradeEntry.count({ where: { gradeItemId: item.id, status: 'GRADED' } });
    await tx.gradeHistory.deleteMany({ where: { gradeEntry: { gradeItemId: item.id } } });
    await tx.gradeEntry.deleteMany({ where: { gradeItemId: item.id } });
    await tx.gradeAppeal.updateMany({ where: { gradeItemId: item.id }, data: { gradeItemId: null } });
    await tx.gradeItem.delete({ where: { id: item.id } });
    await audit(req, { action: 'gradebook.item.delete', entityType: 'GradeItem', entityId: item.id, classId: cls.id, summary: `Deleted grade item "${item.title}" with ${scores} recorded score(s)` }, tx);
  });
  noContent(res);
});

// ── Scores ───────────────────────────────────────────────────────────────────
const entriesBody = z.object({
  entries: z
    .array(z.object({
      itemId: zId,
      studentId: zId,
      status: z.enum(['GRADED', 'MISSING', 'EXEMPT', 'UNGRADED']),
      score: z.number().min(0).nullable().optional(),
      feedback: z.string().trim().max(2000).nullable().optional(),
    }))
    .min(1)
    .max(2000),
  reason: z.string().trim().max(500).optional(),
});

/** Score of a linked column as its assignment or quiz currently has it. */
async function sourceGrade(tx, item, studentId) {
  if (item.assignmentId) {
    const s = await tx.assignmentSubmission.findUnique({ where: { assignmentId_studentId: { assignmentId: item.assignmentId, studentId } } });
    if (s && s.finalScore !== null && ['GRADED', 'RETURNED'].includes(s.status)) return { status: 'GRADED', score: s.finalScore, isLate: s.isLate };
    return { status: 'UNGRADED', score: null, isLate: Boolean(s?.isLate) };
  }
  const quiz = await tx.quiz.findUnique({ where: { id: item.quizId }, select: { attemptScoring: true } });
  const attempts = await tx.quizAttempt.findMany({ where: { quizId: item.quizId, studentId } });
  const outcome = quizOutcome(attempts, quiz.attemptScoring);
  if (outcome && outcome.fraction !== null) return { status: 'GRADED', score: round(outcome.fraction * item.maxPoints, 2), isLate: false };
  return { status: 'UNGRADED', score: null, isLate: false };
}

classGradebookRouter.put('/entries', validate({ params: classParams, body: entriesBody }), async (req, res) => {
  const cls = await managed(req);
  assertNotFinalized(cls);
  const { entries, reason } = req.valid.body;
  const seen = new Set();
  for (const e of entries) {
    const key = `${e.itemId}:${e.studentId}`;
    if (seen.has(key)) throw fieldErrors({ entries: 'The same student and item appear twice.' });
    seen.add(key);
  }
  const items = new Map((await prisma.gradeItem.findMany({ where: { classId: cls.id, id: { in: [...new Set(entries.map((e) => e.itemId))] } } })).map((i) => [i.id, i]));
  const enrolled = new Set(await enrolledStudentIds(cls.id));
  for (const e of entries) {
    const item = items.get(e.itemId);
    if (!item) throw fieldErrors({ entries: 'One of the grade items does not belong to this class.' });
    if (!enrolled.has(e.studentId)) throw fieldErrors({ entries: 'One of the students is not enrolled in this class.' });
    if (item.source !== 'MANUAL' && !['EXEMPT', 'UNGRADED'].includes(e.status)) {
      throw conflict(`"${item.title}" is scored in its ${item.source === 'QUIZ' ? 'quiz' : 'assignment'}. Here you can only exempt a student from it.`, 'LINKED_ITEM');
    }
    if (e.status === 'GRADED') {
      if (e.score === null || e.score === undefined) throw fieldErrors({ entries: `Enter a score for "${item.title}".` });
      if (e.score > item.maxPoints) throw fieldErrors({ entries: `A score of ${e.score} is more than the ${item.maxPoints} points of "${item.title}".` });
    }
  }
  const source = entries.length > 1 ? 'BULK' : 'MANUAL';
  const changed = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const e of entries) {
      const item = items.get(e.itemId);
      // Clearing an exemption on a linked column restores the score from the assignment or quiz.
      const value = item.source !== 'MANUAL' && e.status === 'UNGRADED' ? await sourceGrade(tx, item, e.studentId) : { status: e.status, score: e.status === 'GRADED' ? round(e.score, 2) : null };
      const saved = await recordGrade(tx, {
        gradeItemId: item.id, studentId: e.studentId, score: value.score, status: value.status, isLate: value.isLate,
        feedback: e.feedback === undefined ? undefined : e.feedback ? plainText(e.feedback, 2000) : null,
        source, changedById: req.user.id, reason: reason || null,
      });
      if (saved) count += 1;
    }
    return count;
  }, { timeout: 30_000 });
  ok(res, { changed });
});

// ── Overrides ────────────────────────────────────────────────────────────────
const overrideBody = z.object({ studentId: zId, scope: z.string().min(1).max(40), percent: z.number().min(0).max(100), reason: reasonField });

classGradebookRouter.post('/overrides', validate({ params: classParams, body: overrideBody }), async (req, res) => {
  const cls = await managed(req);
  assertNotFinalized(cls);
  const body = req.valid.body;
  let scopeName = 'overall grade';
  if (body.scope !== OVERALL_SCOPE) {
    const period = await prisma.gradingPeriod.findFirst({ where: { id: body.scope, classId: cls.id } });
    if (!period) throw fieldErrors({ scope: 'Choose a grading period of this class, or the overall grade.' });
    if (period.lockedAt) throw conflict(`Grades for "${period.name}" are locked. Unlock the period to change them.`, 'PERIOD_LOCKED');
    scopeName = `${period.name} grade`;
  }
  const { students } = await computeClassGrades(cls, { studentIds: [body.studentId] });
  const row = students[0];
  if (!row) throw fieldErrors({ studentId: 'That student is not enrolled in this class.' });
  const current = body.scope === OVERALL_SCOPE ? row.result.overall : row.result.periods.find((p) => p.id === body.scope);
  const reason = plainText(body.reason, 500);
  const override = await prisma.$transaction(async (tx) => {
    await tx.gradeOverride.updateMany({ where: { classId: cls.id, studentId: body.studentId, scope: body.scope, revokedAt: null }, data: { revokedAt: new Date() } });
    const made = await tx.gradeOverride.create({
      data: { classId: cls.id, studentId: body.studentId, scope: body.scope, computedPercent: current.computedPercent, overridePercent: body.percent, reason, createdById: req.user.id },
    });
    await audit(req, {
      action: 'grade.override', entityType: 'GradeOverride', entityId: made.id, classId: cls.id,
      summary: `Set the ${scopeName} of ${row.student.name} to ${body.percent}% — ${reason}`,
      before: { percent: current.percent, computedPercent: current.computedPercent }, after: { percent: body.percent, reason },
    }, tx);
    return made;
  });
  created(res, { id: override.id, scope: override.scope, overridePercent: override.overridePercent, computedPercent: override.computedPercent, reason: override.reason });
});

classGradebookRouter.delete('/overrides/:overrideId', validate({ params: idParams('classId', 'overrideId') }), async (req, res) => {
  const cls = await managed(req);
  assertNotFinalized(cls);
  const override = await prisma.gradeOverride.findFirst({ where: { id: req.valid.params.overrideId, classId: cls.id, revokedAt: null }, include: { student: { select: { firstName: true, lastName: true } } } });
  if (!override) throw notFound('Override');
  if (override.scope !== OVERALL_SCOPE) {
    const period = await prisma.gradingPeriod.findUnique({ where: { id: override.scope }, select: { name: true, lockedAt: true } });
    if (period?.lockedAt) throw conflict(`Grades for "${period.name}" are locked. Unlock the period to change them.`, 'PERIOD_LOCKED');
  }
  await prisma.$transaction(async (tx) => {
    await tx.gradeOverride.update({ where: { id: override.id }, data: { revokedAt: new Date() } });
    await audit(req, {
      action: 'grade.override.revoke', entityType: 'GradeOverride', entityId: override.id, classId: cls.id,
      summary: `Removed the grade override of ${fullName(override.student)}; the computed grade applies again`, before: { percent: override.overridePercent, reason: override.reason },
    }, tx);
  });
  noContent(res);
});

// ── Publishing and locking ───────────────────────────────────────────────────
const periodAction = (action, { needsReason = false } = {}) => [
  validate({ params: idParams('classId', 'periodId'), body: z.object({ note: needsReason ? reasonField : z.string().trim().max(500).optional() }) }),
  async (req, res) => {
    const cls = await managed(req);
    assertNotFinalized(cls);
    const period = await prisma.gradingPeriod.findFirst({ where: { id: req.valid.params.periodId, classId: cls.id } });
    if (!period) throw notFound('Grading period');
    const now = new Date();
    const change = { publish: { publishedAt: period.publishedAt ?? now }, unpublish: { publishedAt: null }, lock: { lockedAt: period.lockedAt ?? now }, unlock: { lockedAt: null } }[action];
    const record = { publish: 'PUBLISHED', unpublish: 'WITHHELD', lock: 'LOCKED', unlock: 'UNLOCKED' }[action];
    if (action === 'publish') {
      const errors = validateStructure(await loadStructure(cls.id));
      if (errors.length > 0) throw new AppError(422, 'INVALID_STRUCTURE', `Fix the gradebook weights before publishing grades: ${errors[0]}`, { errors });
    }
    const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
    const wasPublished = Boolean(period.publishedAt);
    await prisma.$transaction(async (tx) => {
      await tx.gradingPeriod.update({ where: { id: period.id }, data: change });
      await tx.gradePublishingRecord.create({ data: { classId: cls.id, scope: period.id, action: record, note, performedById: req.user.id } });
      await audit(req, { action: `grades.${action}`, entityType: 'GradingPeriod', entityId: period.id, classId: cls.id, summary: `${record[0]}${record.slice(1).toLowerCase()} ${period.name} grades${note ? ` — ${note}` : ''}` }, tx);
    });
    if (action === 'publish' && !wasPublished) {
      await notify(await enrolledStudentIds(cls.id), { type: 'grades.published', title: `${period.name} grades are available — ${classLabel(cls)}`, link: `/classes/${cls.id}/grades`, classId: cls.id });
    }
    ok(res, periodHead((await loadStructure(cls.id)).find((p) => p.id === period.id)));
  },
];

classGradebookRouter.post('/periods/:periodId/publish', ...periodAction('publish'));
classGradebookRouter.post('/periods/:periodId/unpublish', ...periodAction('unpublish'));
classGradebookRouter.post('/periods/:periodId/lock', ...periodAction('lock'));
classGradebookRouter.post('/periods/:periodId/unlock', ...periodAction('unlock', { needsReason: true }));

// ── Finalisation ─────────────────────────────────────────────────────────────
classGradebookRouter.post('/finalize', validate({ params: classParams, body: z.object({ confirmIncomplete: z.boolean().default(false) }) }), async (req, res) => {
  const cls = await managed(req);
  assertNotFinalized(cls);
  const result = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `gradebook:${cls.id}`);
    const fresh = await tx.class.findUnique({ where: { id: cls.id } });
    assertNotFinalized(fresh);
    const { periods, settings, structureErrors, students } = await computeClassGrades(fresh, { db: tx });
    if (structureErrors.length > 0) throw new AppError(422, 'INVALID_STRUCTURE', `Fix the gradebook weights before finalising: ${structureErrors[0]}`, { errors: structureErrors });
    if (settings.scaleEntries.length === 0) throw new AppError(422, 'NO_GRADING_SCALE', 'Choose a grading scale before finalising grades.');
    const incomplete = students.filter((s) => !s.result.overall.isComplete && !s.result.overall.isOverridden);
    if (incomplete.length > 0 && !req.valid.body.confirmIncomplete) {
      throw new AppError(409, 'INCOMPLETE_GRADES', `${incomplete.length} student(s) still have work that is not graded. Finalise anyway?`, { count: incomplete.length, students: incomplete.slice(0, 20).map((s) => s.student.name) });
    }
    const now = new Date();
    await tx.finalGrade.deleteMany({ where: { classId: fresh.id } });
    const rows = [];
    for (const row of students) {
      const snapshot = finalSnapshot(row, periods, settings);
      const o = row.result.overall;
      rows.push({ classId: fresh.id, studentId: row.student.id, scope: OVERALL_SCOPE, percent: o.percent, label: o.label, remark: o.remark, isPassing: o.isPassing, isOverridden: o.isOverridden, breakdown: snapshot, finalizedById: req.user.id, finalizedAt: now });
      for (const [i, p] of row.result.periods.entries()) {
        rows.push({ classId: fresh.id, studentId: row.student.id, scope: p.id, percent: p.percent, label: p.label, remark: p.remark, isPassing: p.isPassing, isOverridden: p.isOverridden, breakdown: snapshot.periods[i], finalizedById: req.user.id, finalizedAt: now });
      }
    }
    if (rows.length > 0) await tx.finalGrade.createMany({ data: rows });
    for (const p of periods) await tx.gradingPeriod.update({ where: { id: p.id }, data: { publishedAt: p.publishedAt ?? now, lockedAt: p.lockedAt ?? now } });
    await tx.class.update({ where: { id: fresh.id }, data: { gradesFinalizedAt: now } });
    await tx.gradePublishingRecord.create({ data: { classId: fresh.id, scope: OVERALL_SCOPE, action: 'FINALIZED', performedById: req.user.id, note: incomplete.length > 0 ? `${incomplete.length} student(s) had ungraded work` : null } });
    await audit(req, {
      action: 'grades.finalize', entityType: 'Class', entityId: fresh.id, classId: fresh.id,
      summary: `Finalised grades for ${students.length} student(s)`,
      after: { students: students.length, passing: students.filter((s) => s.result.overall.isPassing === true).length, failing: students.filter((s) => s.result.overall.isPassing === false).length, incomplete: incomplete.length },
    }, tx);
    return { studentIds: students.map((s) => s.student.id), finalizedAt: now };
  }, { timeout: 60_000 });
  await notify(result.studentIds, { type: 'grades.finalized', title: `Final grades are available — ${classLabel(cls)}`, link: `/classes/${cls.id}/grades`, classId: cls.id });
  ok(res, await matrix({ ...cls, gradesFinalizedAt: result.finalizedAt }));
});

classGradebookRouter.post('/reopen', validate({ params: classParams, body: z.object({ reason: reasonField }) }), async (req, res) => {
  const cls = await managed(req);
  if (!cls.gradesFinalizedAt) throw conflict('Grades for this class are not finalised.', 'NOT_FINALIZED');
  const reason = plainText(req.valid.body.reason, 500);
  await prisma.$transaction(async (tx) => {
    await tx.class.update({ where: { id: cls.id }, data: { gradesFinalizedAt: null } });
    await tx.gradePublishingRecord.create({ data: { classId: cls.id, scope: OVERALL_SCOPE, action: 'REOPENED', note: reason, performedById: req.user.id } });
    await audit(req, { action: 'grades.reopen', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: `Reopened finalised grades — ${reason}`, before: { finalizedAt: cls.gradesFinalizedAt } }, tx);
  });
  ok(res, await matrix({ ...cls, gradesFinalizedAt: null }));
});

classGradebookRouter.get('/publishing-log', validate({ params: classParams }), async (req, res) => {
  const cls = await managed(req, { writable: false });
  const [rows, periods] = await Promise.all([
    prisma.gradePublishingRecord.findMany({ where: { classId: cls.id }, include: { performedBy: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.gradingPeriod.findMany({ where: { classId: cls.id }, select: { id: true, name: true } }),
  ]);
  const names = new Map(periods.map((p) => [p.id, p.name]));
  ok(res, rows.map((r) => ({ id: r.id, action: r.action, scope: r.scope === OVERALL_SCOPE ? 'All grades' : names.get(r.scope) ?? 'Removed period', note: r.note, by: fullName(r.performedBy), at: r.createdAt })));
});

// ── Export ───────────────────────────────────────────────────────────────────
classGradebookRouter.get('/export', validate({ params: classParams, query: z.object({ format: exportFormat }) }), async (req, res) => {
  const cls = await managed(req, { writable: false });
  await assertPermission(req.user, 'grades.export');
  const { format } = req.valid.query;
  const data = await matrix(cls);
  const tz = await getTimeZone();
  const cell = (entry) => (!entry ? '' : entry.status === 'GRADED' ? entry.score : entry.status === 'MISSING' ? 'M' : entry.status === 'EXEMPT' ? 'EX' : '');
  // A PDF page cannot hold one column per graded item, so it carries period and overall grades.
  const detailed = format !== 'pdf';
  const multiPeriod = data.structure.periods.length > 1;
  const columns = [
    { header: 'Student No.', value: (s) => s.studentNumber ?? '', pdfWidth: 1.3 },
    { header: 'Name', value: (s) => `${s.lastName}, ${s.firstName}`, width: 28, pdfWidth: 2.8 },
    ...data.structure.periods.flatMap((p) => [
      ...(detailed
        ? p.categories.flatMap((c) => c.items.map((i) => ({ header: `${multiPeriod ? `${p.name} · ` : ''}${i.title} (${i.maxPoints})`, value: (s) => cell(s.entries[i.id]), width: 16, align: 'right' })))
        : []),
      ...(multiPeriod ? [{ header: `${p.name} %`, value: (s) => s.periods[p.id]?.percent ?? '', width: 12, pdfWidth: 1, align: 'right' }] : []),
    ]),
    { header: 'Final %', value: (s) => s.overall.percent ?? '', width: 10, pdfWidth: 1, align: 'right' },
    { header: 'Grade', value: (s) => s.overall.label ?? '', width: 8, pdfWidth: 0.8, align: 'center' },
    { header: 'Remark', value: (s) => `${s.overall.remark ?? ''}${s.overall.isOverridden ? ' (override)' : ''}`, width: 16, pdfWidth: 1.4 },
  ];
  await audit(req, { action: 'grades.export', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: `Exported the gradebook (${format.toUpperCase()})` });
  await sendTable(res, format, {
    filename: `grades-${cls.course.code}${cls.section ? `-${cls.section.name}` : ''}`,
    title: `Grades — ${classLabel(cls)}`,
    subtitle: `${cls.course.title} · ${cls.semester.name}, ${cls.semester.academicYear.name}`,
    meta: [
      `${data.students.length} student(s) · ${cls.gradesFinalizedAt ? `Finalised ${dateKey(cls.gradesFinalizedAt, tz)}` : 'NOT FINAL — grades may still change'}`,
      `Scale: ${data.class.gradingScale?.name ?? 'none'} · M = missing, EX = exempt · Generated ${dateKey(new Date(), tz)} (${tz})`,
    ],
    columns,
    rows: data.students,
    landscape: multiPeriod,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
    summary: [
      ...data.structure.periods.map((p) => `${p.name} (${p.weight}%): ${p.categories.map((c) => `${c.name} ${c.weight}%`).join(', ')}`),
      data.class.transmutationBase > 0 ? `Transmutation base ${data.class.transmutationBase}.` : 'No transmutation.',
      data.class.treatMissingAsZero ? 'Missing work counts as zero.' : 'Missing work is not counted.',
    ],
  });
});

// ── Grade appeals ────────────────────────────────────────────────────────────
const appealView = (a) => ({
  id: a.id, classId: a.classId, status: a.status, reason: a.reason, response: a.response, createdAt: a.createdAt, resolvedAt: a.resolvedAt,
  item: a.gradeItem ? { id: a.gradeItem.id, title: a.gradeItem.title } : null,
  student: a.student ? { id: a.student.id, name: fullName(a.student) } : undefined,
});
const appealInclude = { gradeItem: { select: { id: true, title: true } }, student: { select: { id: true, firstName: true, lastName: true } } };

classGradebookRouter.post(
  '/appeals',
  requireRole('STUDENT'),
  validate({ params: classParams, body: z.object({ gradeItemId: zId.optional(), reason: z.string().trim().min(10, 'Explain your concern (at least 10 characters)').max(2000) }) }),
  async (req, res) => {
    const { cls } = await requireClassStudent(req.user, req.valid.params.classId);
    assertClassWritable(cls);
    const body = req.valid.body;
    if (body.gradeItemId) {
      const item = await prisma.gradeItem.findFirst({ where: { id: body.gradeItemId, classId: cls.id }, select: { id: true } });
      if (!item) throw fieldErrors({ gradeItemId: 'Choose a graded item from this class.' });
    }
    const appeal = await prisma.$transaction(async (tx) => {
      await lockKey(tx, `appeal:${cls.id}:${req.user.id}`);
      const pending = await tx.gradeAppeal.findFirst({ where: { classId: cls.id, studentId: req.user.id, gradeItemId: body.gradeItemId ?? null, status: 'PENDING' } });
      if (pending) throw conflict('You already have a pending request about this. Your teacher will respond to it.', 'APPEAL_PENDING');
      return tx.gradeAppeal.create({ data: { classId: cls.id, studentId: req.user.id, gradeItemId: body.gradeItemId ?? null, reason: plainText(body.reason, 2000) }, include: appealInclude });
    });
    await notify([cls.teacherId], { type: 'grade.appeal', title: `${fullName(req.user)} asked for a grade review — ${classLabel(cls)}`, link: `/classes/${cls.id}/gradebook?tab=appeals`, classId: cls.id });
    created(res, appealView(appeal));
  },
);

classGradebookRouter.get('/appeals', validate({ params: classParams }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  const rows = await prisma.gradeAppeal.findMany({
    where: { classId: access.cls.id, ...(access.canManage ? {} : { studentId: req.user.id }) }, include: appealInclude, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200,
  });
  ok(res, rows.map(appealView));
});

classGradebookRouter.post(
  '/appeals/:appealId/resolve',
  validate({ params: idParams('classId', 'appealId'), body: z.object({ status: z.enum(['APPROVED', 'REJECTED']), response: z.string().trim().min(3, 'Write a response for the student').max(2000) }) }),
  async (req, res) => {
    const cls = await managed(req);
    const appeal = await prisma.gradeAppeal.findFirst({ where: { id: req.valid.params.appealId, classId: cls.id } });
    if (!appeal) throw notFound('Request');
    const done = await prisma.gradeAppeal.updateMany({
      where: { id: appeal.id, status: 'PENDING' },
      data: { status: req.valid.body.status, response: plainText(req.valid.body.response, 2000), resolvedById: req.user.id, resolvedAt: new Date() },
    });
    if (done.count === 0) throw conflict('This request has already been answered.', 'ALREADY_RESOLVED');
    await audit(req, { action: 'grade.appeal.resolve', entityType: 'GradeAppeal', entityId: appeal.id, classId: cls.id, summary: `${req.valid.body.status === 'APPROVED' ? 'Accepted' : 'Declined'} a grade review request` });
    await notify([appeal.studentId], { type: 'grade.appeal.resolved', title: `Your grade review request was ${req.valid.body.status === 'APPROVED' ? 'accepted' : 'declined'} — ${classLabel(cls)}`, link: `/classes/${cls.id}/grades`, classId: cls.id });
    ok(res, appealView(await prisma.gradeAppeal.findUnique({ where: { id: appeal.id }, include: appealInclude })));
  },
);

// ── Academic record across classes ───────────────────────────────────────────
async function academicRecord(studentId) {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, status: 'ENROLLED' },
    include: { class: { include: { course: { select: { id: true, code: true, title: true, units: true } }, section: { select: { id: true, name: true } }, semester: { select: { id: true, name: true, startDate: true, endDate: true, academicYear: { select: { id: true, name: true } } } }, teacher: { select: { firstName: true, lastName: true } } } } },
    orderBy: { class: { semester: { startDate: 'desc' } } },
  });
  const rows = [];
  for (const { class: cls } of enrollments) {
    const view = await studentGradeView(cls, studentId);
    const final = cls.gradesFinalizedAt ? await prisma.finalGrade.findUnique({ where: { classId_studentId_scope: { classId: cls.id, studentId, scope: OVERALL_SCOPE } } }) : null;
    const overall = final ? { percent: final.percent, label: final.label, remark: final.remark, isPassing: final.isPassing } : view?.overall ?? null;
    rows.push({
      classId: cls.id,
      code: cls.course.code,
      title: cls.course.title,
      units: cls.course.units,
      section: cls.section?.name ?? null,
      semester: cls.semester.name,
      academicYear: cls.semester.academicYear.name,
      teacher: fullName(cls.teacher),
      classStatus: cls.status,
      finalized: Boolean(final),
      overall: overall ? { percent: overall.percent, label: overall.label, remark: overall.remark, isPassing: overall.isPassing } : null,
      periods: (view?.periods ?? final?.breakdown?.periods ?? []).map((p) => ({ name: p.name, published: p.published !== false, percent: p.percent, label: p.label })),
    });
  }
  return rows;
}

gradesRouter.get('/mine', requireRole('STUDENT'), async (req, res) => {
  ok(res, await academicRecord(req.user.id));
});

gradesRouter.get('/students/:studentId', requireRole('ADMIN'), validate({ params: idParams('studentId') }), async (req, res) => {
  const student = await prisma.user.findFirst({ where: { id: req.valid.params.studentId, role: 'STUDENT' }, select: { id: true, firstName: true, lastName: true, email: true, studentProfile: { select: { studentNumber: true } } } });
  if (!student) throw notFound('Student');
  await audit(req, { action: 'records.view', entityType: 'User', entityId: student.id, summary: `Viewed the academic record of ${fullName(student)}` });
  ok(res, { student: { id: student.id, name: fullName(student), email: student.email, studentNumber: student.studentProfile?.studentNumber ?? null }, classes: await academicRecord(student.id) });
});
