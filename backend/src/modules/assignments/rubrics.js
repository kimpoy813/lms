// Reusable grading rubrics. A rubric belongs to the teacher who wrote it.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { created, idParams, noContent, ok, round, zTitle } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';

export const rubricsRouter = Router();
rubricsRouter.use(requireAuth, requireRole('TEACHER', 'ADMIN'));

const level = z.object({ title: z.string().trim().min(1).max(60), points: z.number().min(0).max(1000), description: z.string().trim().max(500).optional().default('') });
const criterion = z.object({
  title: z.string().trim().min(1, 'Name the criterion').max(120),
  description: z.string().trim().max(1000).optional().default(''),
  maxPoints: z.number().positive('Points must be more than zero').max(1000),
  levels: z.array(level).max(8).default([]),
});
export const rubricBody = z.object({
  title: zTitle,
  description: z.string().trim().max(1000).nullable().optional(),
  criteria: z.array(criterion).min(1, 'Add at least one criterion').max(30),
});

export const rubricTotal = (rubric) => round((rubric?.criteria ?? []).reduce((sum, c) => sum + c.maxPoints, 0), 2);

export const rubricView = (rubric, extra = {}) => ({
  id: rubric.id,
  title: rubric.title,
  description: rubric.description,
  totalPoints: rubricTotal(rubric),
  criteria: [...rubric.criteria]
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, title: c.title, description: c.description, maxPoints: c.maxPoints, levels: Array.isArray(c.levels) ? c.levels : [] })),
  updatedAt: rubric.updatedAt,
  ...extra,
});

/** Clean and check criteria; a level can never be worth more than its criterion. */
export function normalizeCriteria(criteria) {
  return criteria.map((c, position) => {
    const levels = c.levels.map((l) => ({ title: plainText(l.title, 60), points: l.points, description: plainText(l.description ?? '', 500) })).sort((a, b) => b.points - a.points);
    if (levels.some((l) => l.points > c.maxPoints)) throw fieldErrors({ criteria: `A level of "${c.title}" is worth more than the criterion's ${c.maxPoints} points.` });
    return { title: plainText(c.title, 120), description: plainText(c.description ?? '', 1000) || null, maxPoints: c.maxPoints, levels, position };
  });
}

/** Create a rubric for a teacher (also used by the AI rubric generator after the teacher approves it). */
export async function createRubric(db, ownerId, body) {
  return db.rubric.create({
    data: { ownerId, title: plainText(body.title, 200), description: body.description ? plainText(body.description, 1000) : null, criteria: { create: normalizeCriteria(body.criteria) } },
    include: { criteria: true },
  });
}

const include = { criteria: true, _count: { select: { assignments: { where: { deletedAt: null } } } } };

async function loadOwned(req) {
  const rubric = await prisma.rubric.findUnique({ where: { id: req.valid.params.rubricId }, include });
  // Rubrics are private to their author; an administrator can see them but they stay the teacher's.
  if (!rubric || (rubric.ownerId !== req.user.id && req.user.role !== 'ADMIN')) throw notFound('Rubric');
  return rubric;
}

const usedForGrading = (rubricId) => prisma.assignmentSubmission.count({ where: { assignment: { rubricId }, rubricScores: { not: Prisma.AnyNull } } });

rubricsRouter.get('/', async (req, res) => {
  const rubrics = await prisma.rubric.findMany({ where: { ownerId: req.user.id }, include, orderBy: { updatedAt: 'desc' } });
  ok(res, rubrics.map((r) => rubricView(r, { assignmentCount: r._count.assignments })));
});

rubricsRouter.post('/', validate({ body: rubricBody }), async (req, res) => {
  created(res, rubricView(await createRubric(prisma, req.user.id, req.valid.body), { assignmentCount: 0 }));
});

rubricsRouter.get('/:rubricId', validate({ params: idParams('rubricId') }), async (req, res) => {
  const rubric = await loadOwned(req);
  ok(res, rubricView(rubric, { assignmentCount: rubric._count.assignments, locked: (await usedForGrading(rubric.id)) > 0 }));
});

rubricsRouter.put('/:rubricId', validate({ params: idParams('rubricId'), body: rubricBody }), async (req, res) => {
  const rubric = await loadOwned(req);
  const body = req.valid.body;
  const criteria = normalizeCriteria(body.criteria);
  const current = [...rubric.criteria].sort((a, b) => a.position - b.position);
  const same = current.length === criteria.length && current.every((c, i) => c.title === criteria[i].title && c.maxPoints === criteria[i].maxPoints && JSON.stringify(c.levels) === JSON.stringify(criteria[i].levels) && (c.description ?? null) === criteria[i].description);
  if (!same && (await usedForGrading(rubric.id)) > 0) {
    throw conflict('This rubric has already been used to grade submissions, so its criteria cannot change. Make a copy and edit the copy.', 'RUBRIC_IN_USE');
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (!same) {
      await tx.rubricCriterion.deleteMany({ where: { rubricId: rubric.id } });
      await tx.rubricCriterion.createMany({ data: criteria.map((c) => ({ ...c, rubricId: rubric.id })) });
      // Assignments that use the rubric are worth what the rubric is worth.
      await tx.assignment.updateMany({ where: { rubricId: rubric.id, deletedAt: null }, data: { points: round(criteria.reduce((s, c) => s + c.maxPoints, 0), 2) } });
      const items = await tx.gradeItem.findMany({ where: { assignment: { rubricId: rubric.id, deletedAt: null } }, select: { id: true } });
      if (items.length > 0) await tx.gradeItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { maxPoints: round(criteria.reduce((s, c) => s + c.maxPoints, 0), 2) } });
    }
    return tx.rubric.update({ where: { id: rubric.id }, data: { title: plainText(body.title, 200), description: body.description ? plainText(body.description, 1000) : null }, include });
  });
  ok(res, rubricView(updated, { assignmentCount: updated._count.assignments }));
});

rubricsRouter.post('/:rubricId/copy', validate({ params: idParams('rubricId') }), async (req, res) => {
  const rubric = await loadOwned(req);
  const copy = await prisma.rubric.create({
    data: {
      ownerId: req.user.id, title: `${rubric.title} (copy)`.slice(0, 200), description: rubric.description,
      criteria: { create: rubric.criteria.map((c) => ({ title: c.title, description: c.description, maxPoints: c.maxPoints, levels: c.levels, position: c.position })) },
    },
    include: { criteria: true },
  });
  created(res, rubricView(copy, { assignmentCount: 0 }));
});

rubricsRouter.delete('/:rubricId', validate({ params: idParams('rubricId') }), async (req, res) => {
  const rubric = await loadOwned(req);
  if (rubric._count.assignments > 0) throw conflict(`This rubric is attached to ${rubric._count.assignments} assignment(s). Detach it there first.`, 'RUBRIC_IN_USE');
  await prisma.$transaction(async (tx) => {
    // Deleted assignments may still point at it.
    await tx.assignment.updateMany({ where: { rubricId: rubric.id }, data: { rubricId: null } });
    await tx.rubric.delete({ where: { id: rubric.id } });
  });
  noContent(res);
});
