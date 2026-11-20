// Learning modules, lessons, resources, progress tracking and bookmarks.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, patchOf, round, zHtml, zId, zOptionalDateTime, zTitle } from '../../lib/http.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { isPublished, publishedWhere, resolvePublication } from '../../lib/visibility.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { aiLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { builtinCompletion } from '../../services/aiBuiltin.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { fileSummary } from '../../services/storage.js';
import { assertClassWritable, classIdsFor, classLabel, loadClassAccess, requireClassManager, requireWritableClassManager } from '../classes/access.js';
import { matchingModuleId, resolveOrCreateModule, resolveTargetClasses } from '../classes/distribute.js';

export const classContentRouter = Router({ mergeParams: true }); // /classes/:classId
classContentRouter.use(requireAuth);
// Mounted at the API root; routes.js puts requireAuth in front of each of these prefixes.
export const contentRouter = Router();
export const CONTENT_PREFIXES = ['/modules', '/lessons', '/resources', '/bookmarks'];

const classParams = idParams('classId');
const statusEnum = z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']);
const objectives = z.array(z.string().trim().min(1).max(300)).max(20);
export const LESSON_KINDS = ['LESSON', 'ACTIVITY', 'ASSESSMENT', 'SUMMARY', 'REFERENCE'];

const cleanList = (list) => (list ?? []).map((item) => plainText(item, 300)).filter(Boolean);

// ── Serialisation ────────────────────────────────────────────────────────────
const resourceView = (r, { manage }) => ({
  id: r.id,
  classId: r.classId,
  moduleId: r.moduleId,
  lessonId: r.lessonId,
  title: r.title,
  description: r.description,
  type: r.type,
  url: r.type === 'FILE' ? null : r.url,
  file: r.file ? fileSummary(r.file) : null,
  allowDownload: r.allowDownload,
  ...(manage ? { isPublished: r.isPublished } : {}),
  position: r.position,
  createdAt: r.createdAt,
});

function lessonSummary(lesson, { manage, progress, locked }) {
  return {
    id: lesson.id,
    moduleId: lesson.moduleId,
    title: lesson.title,
    kind: lesson.kind,
    position: lesson.position,
    estimatedMinutes: lesson.estimatedMinutes,
    prerequisiteLessonId: lesson.prerequisiteLessonId,
    ...(manage ? { status: lesson.status } : { completed: Boolean(progress?.completedAt), viewed: Boolean(progress), locked: Boolean(locked) }),
  };
}

const moduleInclude = (manage) => ({
  lessons: { where: { deletedAt: null, ...(manage ? {} : { status: 'PUBLISHED' }) }, orderBy: { position: 'asc' } },
  resources: { where: { lessonId: null, ...(manage ? {} : { isPublished: true }) }, orderBy: { position: 'asc' }, include: { file: true } },
  aiGenerated: { select: { id: true, reviewStatus: true } },
});

/**
 * Work out which modules and lessons are locked for a student.
 * A module is locked until every published lesson of its prerequisite module is completed;
 * a lesson is locked until its prerequisite lesson is completed.
 */
function lockState(modules, progressByLesson) {
  const done = (lesson) => Boolean(progressByLesson.get(lesson.id)?.completedAt);
  const byId = new Map(modules.map((m) => [m.id, m]));
  const moduleComplete = (m) => m.lessons.length > 0 && m.lessons.every(done);
  const locks = new Map();
  for (const m of modules) {
    const prerequisite = m.prerequisiteModuleId ? byId.get(m.prerequisiteModuleId) : null;
    // A prerequisite the student cannot see (unpublished or deleted) never blocks them.
    const moduleLocked = Boolean(prerequisite) && prerequisite.lessons.length > 0 && !moduleComplete(prerequisite);
    const lessons = new Map();
    const lessonById = new Map(m.lessons.map((l) => [l.id, l]));
    for (const l of m.lessons) {
      const pre = l.prerequisiteLessonId ? lessonById.get(l.prerequisiteLessonId) : null;
      lessons.set(l.id, moduleLocked || (Boolean(pre) && !done(pre)));
    }
    locks.set(m.id, { locked: moduleLocked, prerequisiteTitle: prerequisite?.title ?? null, lessons });
  }
  return locks;
}

async function studentProgress(studentId, lessonIds) {
  if (lessonIds.length === 0) return new Map();
  const rows = await prisma.lessonProgress.findMany({ where: { studentId, lessonId: { in: lessonIds } } });
  return new Map(rows.map((r) => [r.lessonId, r]));
}

/** Modules of a class as the given user may see them. */
export async function listModules(user, access) {
  const manage = access.canManage;
  const now = new Date();
  const modules = await prisma.learningModule.findMany({
    where: {
      classId: access.cls.id,
      deletedAt: null,
      ...(manage ? {} : { AND: [publishedWhere(now), { OR: [{ availableUntil: null }, { availableUntil: { gt: now } }] }] }),
    },
    include: moduleInclude(manage),
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  const progress = manage ? new Map() : await studentProgress(user.id, modules.flatMap((m) => m.lessons.map((l) => l.id)));
  const locks = manage ? new Map() : lockState(modules, progress);
  return modules.map((m) => {
    const lock = locks.get(m.id);
    const completed = m.lessons.filter((l) => progress.get(l.id)?.completedAt).length;
    return {
      id: m.id,
      classId: m.classId,
      title: m.title,
      description: m.description,
      objectives: m.objectives,
      position: m.position,
      prerequisiteModuleId: m.prerequisiteModuleId,
      availableUntil: m.availableUntil,
      source: m.source,
      lessonCount: m.lessons.length,
      ...(manage
        ? { status: m.status, publishAt: m.publishAt, publishedAt: m.publishedAt, isVisible: isPublished(m, now), aiReviewStatus: m.aiGenerated?.reviewStatus ?? null }
        : {
            locked: lock.locked,
            lockedReason: lock.locked ? `Complete "${lock.prerequisiteTitle}" first.` : null,
            completedLessons: completed,
            progressPercent: m.lessons.length === 0 ? 0 : round((completed / m.lessons.length) * 100, 0),
          }),
      lessons: m.lessons.map((l) => lessonSummary(l, { manage, progress: progress.get(l.id), locked: lock?.lessons.get(l.id) })),
      // Resources of a locked module are not listed until it unlocks.
      resources: !manage && lock.locked ? [] : m.resources.map((r) => resourceView(r, { manage })),
    };
  });
}

classContentRouter.get('/modules', validate({ params: classParams }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  ok(res, await listModules(req.user, access));
});

// ── Modules: create / update / delete / reorder / duplicate ─────────────────
const moduleBody = z.object({
  title: zTitle,
  description: z.string().trim().max(2000).nullable().optional(),
  objectives: objectives.optional(),
  status: statusEnum.default('DRAFT'),
  publishAt: zOptionalDateTime,
  availableUntil: zOptionalDateTime,
  prerequisiteModuleId: zId.nullable().optional(),
});

async function assertPrerequisite(classId, prerequisiteModuleId, selfId) {
  if (!prerequisiteModuleId) return;
  if (prerequisiteModuleId === selfId) throw fieldErrors({ prerequisiteModuleId: 'A module cannot require itself.' });
  // Walk the chain: the prerequisite must be in this class and must not lead back to this module.
  let cursor = prerequisiteModuleId;
  for (let hops = 0; cursor && hops < 100; hops += 1) {
    const m = await prisma.learningModule.findFirst({ where: { id: cursor, classId, deletedAt: null }, select: { id: true, prerequisiteModuleId: true } });
    if (!m) throw fieldErrors({ prerequisiteModuleId: 'Choose a module from this class.' });
    if (m.prerequisiteModuleId === selfId && selfId) throw fieldErrors({ prerequisiteModuleId: 'That would create a circular requirement.' });
    cursor = m.prerequisiteModuleId;
  }
}

async function announceModule(mod, cls) {
  await notify(await enrolledStudentIds(cls.id), {
    type: 'module.published', title: `New module in ${classLabel(cls)}: ${mod.title}`, link: `/classes/${cls.id}/modules/${mod.id}`, classId: cls.id,
  });
}

const createModuleBody = moduleBody.extend({
  targetClassIds: z.array(zId).max(50).default([]),
});

classContentRouter.post('/modules', validate({ params: classParams, body: createModuleBody }), async (req, res) => {
  const { cls } = await requireWritableClassManager(req.user, req.valid.params.classId);
  const body = req.valid.body;
  const publication = resolvePublication(body, null);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  if (body.availableUntil && publication.publishAt && body.availableUntil <= publication.publishAt) {
    throw fieldErrors({ availableUntil: 'The closing date must be after the publishing date.' });
  }
  await assertPrerequisite(cls.id, body.prerequisiteModuleId, null);
  const targets = await resolveTargetClasses(req.user, cls.id, body.targetClassIds);
  const title = plainText(body.title, 200);
  const description = body.description ? plainText(body.description, 2000) : null;
  const cleanObjectives = cleanList(body.objectives);

  const { mod, copies } = await prisma.$transaction(async (tx) => {
    const last = await tx.learningModule.aggregate({ where: { classId: cls.id, deletedAt: null }, _max: { position: true } });
    const primary = await tx.learningModule.create({
      data: {
        classId: cls.id,
        title,
        description,
        objectives: cleanObjectives,
        position: (last._max.position ?? -1) + 1,
        ...publication,
        availableUntil: body.availableUntil ?? null,
        prerequisiteModuleId: body.prerequisiteModuleId ?? null,
        createdById: req.user.id,
      },
    });
    const extra = [];
    for (const target of targets) {
      const tLast = await tx.learningModule.aggregate({ where: { classId: target.cls.id, deletedAt: null }, _max: { position: true } });
      const row = await tx.learningModule.create({
        data: {
          classId: target.cls.id,
          title,
          description,
          objectives: cleanObjectives,
          position: (tLast._max.position ?? -1) + 1,
          ...publication,
          availableUntil: body.availableUntil ?? null,
          prerequisiteModuleId: null,
          createdById: req.user.id,
        },
      });
      extra.push({ mod: row, cls: target.cls });
    }
    return { mod: primary, copies: extra };
  });

  if (mod.status === 'PUBLISHED') {
    await announceModule(mod, cls);
    for (const c of copies) await announceModule(c.mod, c.cls);
  }
  const view = (await listModules(req.user, { cls, canManage: true })).find((m) => m.id === mod.id);
  created(res, copies.length > 0 ? { ...view, createdCopies: copies.map((c) => ({ id: c.mod.id, classId: c.cls.id, classLabel: classLabel(c.cls), status: c.mod.status })) } : view);
});

async function loadModule(moduleId) {
  const mod = await prisma.learningModule.findUnique({ where: { id: moduleId } });
  if (!mod || mod.deletedAt) throw notFound('Module');
  return mod;
}

async function loadManagedModule(req, { writable = true } = {}) {
  const mod = await loadModule(req.valid.params.moduleId);
  const access = await requireClassManager(req.user, mod.classId);
  if (writable) assertClassWritable(access.cls);
  return { mod, cls: access.cls };
}

contentRouter.get('/modules/:moduleId', validate({ params: idParams('moduleId') }), async (req, res) => {
  const mod = await loadModule(req.valid.params.moduleId);
  const access = await loadClassAccess(req.user, mod.classId);
  const view = (await listModules(req.user, access)).find((m) => m.id === mod.id);
  // Unpublished modules do not exist as far as students are concerned.
  if (!view) throw notFound('Module');
  ok(res, view);
});

contentRouter.patch('/modules/:moduleId', validate({ params: idParams('moduleId'), body: patchOf(moduleBody) }), async (req, res) => {
  const { mod, cls } = await loadManagedModule(req);
  const body = req.valid.body;
  const publication = resolvePublication({ status: body.status, publishAt: body.publishAt ?? mod.publishAt }, mod);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  if (body.prerequisiteModuleId !== undefined) await assertPrerequisite(cls.id, body.prerequisiteModuleId, mod.id);
  const wasVisible = isPublished(mod);
  const updated = await prisma.learningModule.update({
    where: { id: mod.id },
    data: {
      ...(body.title !== undefined ? { title: plainText(body.title, 200) } : {}),
      ...(body.description !== undefined ? { description: body.description ? plainText(body.description, 2000) : null } : {}),
      ...(body.objectives !== undefined ? { objectives: cleanList(body.objectives) } : {}),
      ...(body.availableUntil !== undefined ? { availableUntil: body.availableUntil } : {}),
      ...(body.prerequisiteModuleId !== undefined ? { prerequisiteModuleId: body.prerequisiteModuleId } : {}),
      ...publication,
    },
  });
  if (!wasVisible && updated.status === 'PUBLISHED') {
    // AI-drafted content only reaches students through this explicit teacher action.
    if (updated.source === 'AI') {
      await prisma.aIGeneratedModule.updateMany({
        where: { moduleId: updated.id }, data: { reviewStatus: 'APPROVED', reviewedById: req.user.id, reviewedAt: new Date(), publishedAt: new Date() },
      });
      await audit(req, { action: 'ai.module.approve', entityType: 'LearningModule', entityId: updated.id, classId: cls.id, summary: `Reviewed and published AI-drafted module "${updated.title}"` });
    }
    await announceModule(updated, cls);
  }
  ok(res, (await listModules(req.user, { cls, canManage: true })).find((m) => m.id === mod.id));
});

contentRouter.delete('/modules/:moduleId', validate({ params: idParams('moduleId') }), async (req, res) => {
  const { mod, cls } = await loadManagedModule(req);
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.learningModule.update({ where: { id: mod.id }, data: { deletedAt: now } });
    await tx.lesson.updateMany({ where: { moduleId: mod.id, deletedAt: null }, data: { deletedAt: now } });
    // Modules that required this one are released.
    await tx.learningModule.updateMany({ where: { prerequisiteModuleId: mod.id }, data: { prerequisiteModuleId: null } });
    await audit(req, { action: 'module.delete', entityType: 'LearningModule', entityId: mod.id, classId: cls.id, summary: `Deleted module "${mod.title}"` }, tx);
  });
  noContent(res);
});

const reorderBody = z.object({ ids: z.array(zId).min(1).max(500) });

async function reorder(model, where, ids, tx) {
  const rows = await tx[model].findMany({ where, select: { id: true } });
  const known = new Set(rows.map((r) => r.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
    throw conflict('The list changed while you were reordering it. Reload and try again.', 'STALE_ORDER');
  }
  for (const [position, id] of ids.entries()) await tx[model].update({ where: { id }, data: { position } });
}

classContentRouter.put('/modules/order', validate({ params: classParams, body: reorderBody }), async (req, res) => {
  const { cls } = await requireWritableClassManager(req.user, req.valid.params.classId);
  await prisma.$transaction((tx) => reorder('learningModule', { classId: cls.id, deletedAt: null }, req.valid.body.ids, tx));
  ok(res, await listModules(req.user, { cls, canManage: true }));
});

contentRouter.put('/modules/:moduleId/lessons/order', validate({ params: idParams('moduleId'), body: reorderBody }), async (req, res) => {
  const { mod, cls } = await loadManagedModule(req);
  await prisma.$transaction((tx) => reorder('lesson', { moduleId: mod.id, deletedAt: null }, req.valid.body.ids, tx));
  ok(res, (await listModules(req.user, { cls, canManage: true })).find((m) => m.id === mod.id));
});

/** Copy a module (lessons and resources) into the same or another class the teacher owns. */
export async function copyModule(tx, mod, targetClassId, userId, position, { status = 'DRAFT', now = new Date() } = {}) {
  const source = await tx.learningModule.findUnique({
    where: { id: mod.id },
    include: { lessons: { where: { deletedAt: null }, orderBy: { position: 'asc' }, include: { resources: true } }, resources: { where: { lessonId: null } } },
  });
  const pub = status === 'PUBLISHED' ? { status: 'PUBLISHED', publishAt: now, publishedAt: now } : { status: 'DRAFT' };
  const copy = await tx.learningModule.create({
    data: {
      classId: targetClassId, title: source.title, description: source.description, objectives: source.objectives, position,
      ...pub, source: source.source, createdById: userId,
    },
  });
  const resourceData = (r, lessonId) => ({
    classId: targetClassId, moduleId: copy.id, lessonId, title: r.title, description: r.description, type: r.type, fileId: r.fileId, url: r.url,
    allowDownload: r.allowDownload, isPublished: r.isPublished, position: r.position, createdById: userId,
  });
  const lessonMap = new Map();
  for (const lesson of source.lessons) {
    const made = await tx.lesson.create({
      data: {
        moduleId: copy.id, title: lesson.title, contentHtml: lesson.contentHtml, objectives: lesson.objectives, kind: lesson.kind, position: lesson.position,
        estimatedMinutes: lesson.estimatedMinutes, status: lesson.status,
      },
    });
    lessonMap.set(lesson.id, made.id);
    if (lesson.resources.length > 0) await tx.learningResource.createMany({ data: lesson.resources.map((r) => resourceData(r, made.id)) });
  }
  for (const lesson of source.lessons) {
    if (lesson.prerequisiteLessonId && lessonMap.has(lesson.prerequisiteLessonId)) {
      await tx.lesson.update({ where: { id: lessonMap.get(lesson.id) }, data: { prerequisiteLessonId: lessonMap.get(lesson.prerequisiteLessonId) } });
    }
  }
  if (source.resources.length > 0) await tx.learningResource.createMany({ data: source.resources.map((r) => resourceData(r, null)) });
  return copy;
}

const copyModuleBody = z.object({
  targetClassId: zId.optional(),
  targetClassIds: z.array(zId).min(1).max(50).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
});

contentRouter.post('/modules/:moduleId/copy', validate({ params: idParams('moduleId'), body: copyModuleBody }), async (req, res) => {
  const { mod } = await loadManagedModule(req, { writable: false });
  const body = req.valid.body;
  const multiMode = Boolean(body.targetClassIds?.length);
  const rawTargets = multiMode ? [...new Set(body.targetClassIds)] : [body.targetClassId ?? mod.classId];
  const targets = [];
  for (const id of rawTargets) targets.push(await requireWritableClassManager(req.user, id));

  const now = new Date();
  const copied = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const target of targets) {
      const last = await tx.learningModule.aggregate({ where: { classId: target.cls.id, deletedAt: null }, _max: { position: true } });
      const row = await copyModule(tx, mod, target.cls.id, req.user.id, (last._max.position ?? -1) + 1, { status: body.status, now });
      if (target.cls.id === mod.classId) {
        await tx.learningModule.update({ where: { id: row.id }, data: { title: `${mod.title} (copy)`.slice(0, 200) } });
      }
      out.push({ row, cls: target.cls });
    }
    return out;
  });

  if (body.status === 'PUBLISHED') {
    for (const item of copied) await announceModule(item.row, item.cls);
  }
  const firstView = (await listModules(req.user, { cls: copied[0].cls, canManage: true })).find((m) => m.id === copied[0].row.id);
  if (!multiMode && copied.length === 1) {
    created(res, firstView);
    return;
  }
  created(res, {
    ...firstView,
    createdCopies: copied.map((item) => ({ id: item.row.id, classId: item.cls.id, classLabel: classLabel(item.cls), status: item.row.status })),
  });
});

// ── Lessons ──────────────────────────────────────────────────────────────────
const lessonBody = z.object({
  title: zTitle,
  contentHtml: zHtml.default(''),
  objectives: objectives.optional(),
  kind: z.enum(LESSON_KINDS).default('LESSON'),
  estimatedMinutes: z.number().int().min(1).max(600).nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
  prerequisiteLessonId: zId.nullable().optional(),
});

const lessonTargetSchema = z.object({ classId: zId, moduleId: zId.nullable().optional() });
const createLessonBody = lessonBody.extend({
  targetClassIds: z.array(zId).max(50).default([]),
  targets: z.array(lessonTargetSchema).max(50).default([]),
});

async function resolveLessonTargets(user, primaryClassId, { targets = [], targetClassIds = [] }) {
  const raw = targets.length > 0 ? targets : targetClassIds.map((classId) => ({ classId, moduleId: null }));
  const seen = new Set([primaryClassId]);
  const resolved = [];
  for (const t of raw) {
    if (!t?.classId || seen.has(t.classId)) continue;
    seen.add(t.classId);
    const access = await requireWritableClassManager(user, t.classId);
    if (t.moduleId) {
      const targetMod = await prisma.learningModule.findFirst({ where: { id: t.moduleId, classId: access.cls.id, deletedAt: null }, select: { id: true } });
      if (!targetMod) throw fieldErrors({ targets: `Choose an active module in ${classLabel(access.cls)}.` });
    }
    resolved.push({ cls: access.cls, moduleId: t.moduleId ?? null });
  }
  return resolved;
}

async function assertLessonPrerequisite(moduleId, prerequisiteLessonId, selfId) {
  if (!prerequisiteLessonId) return;
  if (prerequisiteLessonId === selfId) throw fieldErrors({ prerequisiteLessonId: 'A lesson cannot require itself.' });
  let cursor = prerequisiteLessonId;
  for (let hops = 0; cursor && hops < 200; hops += 1) {
    const l = await prisma.lesson.findFirst({ where: { id: cursor, moduleId, deletedAt: null }, select: { prerequisiteLessonId: true } });
    if (!l) throw fieldErrors({ prerequisiteLessonId: 'Choose a lesson from this module.' });
    if (selfId && l.prerequisiteLessonId === selfId) throw fieldErrors({ prerequisiteLessonId: 'That would create a circular requirement.' });
    cursor = l.prerequisiteLessonId;
  }
}

contentRouter.post('/modules/:moduleId/lessons', validate({ params: idParams('moduleId'), body: createLessonBody }), async (req, res) => {
  const { mod } = await loadManagedModule(req);
  const body = req.valid.body;
  await assertLessonPrerequisite(mod.id, body.prerequisiteLessonId, null);
  const targets = await resolveLessonTargets(req.user, mod.classId, body);
  const title = plainText(body.title, 200);
  const contentHtml = sanitizeRichText(body.contentHtml);
  const cleanObjectives = cleanList(body.objectives);
  const now = new Date();

  const { primary, extra } = await prisma.$transaction(async (tx) => {
    const last = await tx.lesson.aggregate({ where: { moduleId: mod.id, deletedAt: null }, _max: { position: true } });
    const row = await tx.lesson.create({
      data: {
        moduleId: mod.id,
        title,
        contentHtml,
        objectives: cleanObjectives,
        kind: body.kind,
        estimatedMinutes: body.estimatedMinutes ?? null,
        status: body.status,
        prerequisiteLessonId: body.prerequisiteLessonId ?? null,
        position: (last._max.position ?? -1) + 1,
      },
    });
    const copies = [];
    for (const target of targets) {
      let targetModuleId = target.moduleId;
      let autoMod = null;
      if (!targetModuleId) {
        const resolved = await resolveOrCreateModule(tx, mod, target.cls.id, req.user.id, now);
        targetModuleId = resolved.id;
        autoMod = resolved.created ? resolved.module : null;
      }
      const tLast = await tx.lesson.aggregate({ where: { moduleId: targetModuleId, deletedAt: null }, _max: { position: true } });
      const copy = await tx.lesson.create({
        data: {
          moduleId: targetModuleId,
          title,
          contentHtml,
          objectives: cleanObjectives,
          kind: body.kind,
          estimatedMinutes: body.estimatedMinutes ?? null,
          status: body.status,
          prerequisiteLessonId: null,
          position: (tLast._max.position ?? -1) + 1,
        },
      });
      copies.push({ lesson: copy, cls: target.cls, autoMod });
    }
    return { primary: row, extra: copies };
  });

  for (const c of extra) {
    if (c.autoMod?.status === 'PUBLISHED') await announceModule(c.autoMod, c.cls);
  }
  const detail = await lessonDetail(req.user, primary.id);
  created(res, extra.length > 0 ? { ...detail, createdCopies: extra.map((c) => ({ id: c.lesson.id, moduleId: c.lesson.moduleId, classId: c.cls.id, classLabel: classLabel(c.cls), status: c.lesson.status })) } : detail);
});

const copyLessonBody = z.object({
  targetClassId: zId.optional(),
  targetClassIds: z.array(zId).min(1).max(50).optional(),
  targets: z.array(lessonTargetSchema).min(1).max(50).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
});

contentRouter.post('/lessons/:lessonId/copy', validate({ params: idParams('lessonId'), body: copyLessonBody }), async (req, res) => {
  const source = await prisma.lesson.findUnique({
    where: { id: req.valid.params.lessonId },
    include: { module: true, resources: { orderBy: { position: 'asc' } } },
  });
  if (!source || source.deletedAt || source.module.deletedAt) throw notFound('Lesson');
  await requireClassManager(req.user, source.module.classId);
  const body = req.valid.body;
  const multiMode = Boolean(body.targets?.length || body.targetClassIds?.length);
  const rawTargets = body.targets?.length
    ? body.targets
    : body.targetClassIds?.length
      ? body.targetClassIds.map((classId) => ({ classId, moduleId: null }))
      : [{ classId: body.targetClassId ?? source.module.classId, moduleId: body.targetClassId ? null : source.moduleId }];

  const seen = new Set();
  const targets = [];
  for (const t of rawTargets) {
    const key = `${t.classId}:${t.moduleId ?? ''}`;
    if (!t.classId || seen.has(key)) continue;
    seen.add(key);
    const access = await requireWritableClassManager(req.user, t.classId);
    if (t.moduleId) {
      const m = await prisma.learningModule.findFirst({ where: { id: t.moduleId, classId: access.cls.id, deletedAt: null }, select: { id: true } });
      if (!m) throw fieldErrors({ targets: `Choose an active module in ${classLabel(access.cls)}.` });
    }
    targets.push({ cls: access.cls, moduleId: t.moduleId ?? null });
  }

  const now = new Date();
  const copied = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const target of targets) {
      let targetModuleId = target.moduleId;
      let autoMod = null;
      if (!targetModuleId) {
        if (target.cls.id === source.module.classId) {
          targetModuleId = source.moduleId;
        } else {
          const resolved = await resolveOrCreateModule(tx, source.module, target.cls.id, req.user.id, now);
          targetModuleId = resolved.id;
          autoMod = resolved.created ? resolved.module : null;
        }
      }
      const sameModule = targetModuleId === source.moduleId;
      const last = await tx.lesson.aggregate({ where: { moduleId: targetModuleId, deletedAt: null }, _max: { position: true } });
      const createdLesson = await tx.lesson.create({
        data: {
          moduleId: targetModuleId,
          title: sameModule ? `${source.title} (copy)`.slice(0, 200) : source.title,
          contentHtml: source.contentHtml,
          objectives: source.objectives,
          kind: source.kind,
          estimatedMinutes: source.estimatedMinutes,
          status: body.status ?? (sameModule ? 'DRAFT' : source.status),
          prerequisiteLessonId: null,
          position: (last._max.position ?? -1) + 1,
        },
      });
      if (source.resources.length > 0) {
        await tx.learningResource.createMany({
          data: source.resources.map((r) => ({
            classId: target.cls.id,
            moduleId: targetModuleId,
            lessonId: createdLesson.id,
            title: r.title,
            description: r.description,
            type: r.type,
            fileId: r.fileId,
            url: r.url,
            allowDownload: r.allowDownload,
            isPublished: r.isPublished,
            position: r.position,
            createdById: req.user.id,
          })),
        });
      }
      out.push({ lesson: createdLesson, cls: target.cls, autoMod });
    }
    return out;
  });

  for (const item of copied) {
    if (item.autoMod?.status === 'PUBLISHED') await announceModule(item.autoMod, item.cls);
  }
  const firstDetail = await lessonDetail(req.user, copied[0].lesson.id);
  if (!multiMode && copied.length === 1) {
    created(res, firstDetail);
    return;
  }
  created(res, {
    ...firstDetail,
    createdCopies: copied.map((item) => ({ id: item.lesson.id, moduleId: item.lesson.moduleId, classId: item.cls.id, classLabel: classLabel(item.cls), status: item.lesson.status })),
  });
});

async function loadLesson(lessonId) {
  const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, include: { module: true } });
  if (!lesson || lesson.deletedAt || lesson.module.deletedAt) throw notFound('Lesson');
  return lesson;
}

async function lessonDetail(user, lessonId, { markViewed = false } = {}) {
  const lesson = await loadLesson(lessonId);
  const access = await loadClassAccess(user, lesson.module.classId);
  const manage = access.canManage;
  const modules = await listModules(user, access);
  const mod = modules.find((m) => m.id === lesson.moduleId);
  const summary = mod?.lessons.find((l) => l.id === lesson.id);
  // Students cannot open lessons that are unpublished, in an unpublished module, or still locked.
  if (!mod || !summary) throw notFound('Lesson');
  if (!manage && summary.locked) throw forbidden('This lesson is locked. Complete the required lesson or module first.', 'LESSON_LOCKED');

  let progress = null;
  let bookmarked = false;
  if (!manage) {
    if (markViewed) {
      const now = new Date();
      progress = await prisma.lessonProgress.upsert({
        where: { lessonId_studentId: { lessonId: lesson.id, studentId: user.id } },
        create: { lessonId: lesson.id, studentId: user.id, firstViewedAt: now, lastViewedAt: now },
        update: { lastViewedAt: now },
      });
    } else {
      progress = await prisma.lessonProgress.findUnique({ where: { lessonId_studentId: { lessonId: lesson.id, studentId: user.id } } });
    }
    bookmarked = Boolean(await prisma.bookmark.findUnique({ where: { userId_lessonId: { userId: user.id, lessonId: lesson.id } } }));
  }
  const resources = await prisma.learningResource.findMany({
    where: { lessonId: lesson.id, ...(manage ? {} : { isPublished: true }) }, include: { file: true }, orderBy: { position: 'asc' },
  });
  const index = mod.lessons.findIndex((l) => l.id === lesson.id);
  const neighbour = (l) => (l ? { id: l.id, title: l.title, locked: Boolean(l.locked) } : null);
  return {
    id: lesson.id,
    classId: lesson.module.classId,
    moduleId: lesson.moduleId,
    moduleTitle: lesson.module.title,
    title: lesson.title,
    contentHtml: lesson.contentHtml,
    objectives: lesson.objectives,
    kind: lesson.kind,
    estimatedMinutes: lesson.estimatedMinutes,
    prerequisiteLessonId: lesson.prerequisiteLessonId,
    position: lesson.position,
    updatedAt: lesson.updatedAt,
    resources: resources.map((r) => resourceView(r, { manage })),
    previous: neighbour(mod.lessons[index - 1]),
    next: neighbour(mod.lessons[index + 1]),
    aiStudyCoachEnabled: Boolean(access.cls.aiStudyCoachEnabled),
    ...(manage ? { status: lesson.status } : { completed: Boolean(progress?.completedAt), completedAt: progress?.completedAt ?? null, bookmarked }),
  };
}

contentRouter.get('/lessons/:lessonId', validate({ params: idParams('lessonId') }), async (req, res) => {
  ok(res, await lessonDetail(req.user, req.valid.params.lessonId, { markViewed: true }));
});

const studyCoachBody = z
  .object({
    mode: z.enum(['summary', 'flashcards', 'practice', 'explain']).default('summary'),
    question: z.string().trim().min(2).max(600).optional(),
  })
  .refine((b) => b.mode !== 'explain' || Boolean(b.question), {
    message: 'Enter a question about this lesson.',
    path: ['question'],
  });

/**
 * Built-in zero-cost AI Study Coach for students (and previewable by the class teacher).
 * Strictly scoped to a single published/unlocked lesson's text and never hits external LLMs.
 */
contentRouter.post('/lessons/:lessonId/study-coach', aiLimiter, validate({ params: idParams('lessonId'), body: studyCoachBody }), async (req, res) => {
  const lesson = await lessonDetail(req.user, req.valid.params.lessonId, { markViewed: false });
  const manage = req.user.role === 'TEACHER' || req.user.role === 'ADMIN';
  if (!manage && !lesson.aiStudyCoachEnabled) {
    throw forbidden('The AI Study Coach is turned off for this class.', 'STUDY_COACH_DISABLED');
  }
  const b = req.valid.body;
  const out = await builtinCompletion({
    json: true,
    task: {
      kind: 'study-coach',
      input: {
        lessonTitle: lesson.title,
        moduleTitle: lesson.moduleTitle,
        contentHtml: lesson.contentHtml,
        objectives: lesson.objectives,
        mode: b.mode,
        question: b.question,
      },
    },
  });
  let payload;
  try {
    payload = JSON.parse(out.content);
  } catch {
    payload = { mode: b.mode, lessonTitle: lesson.title };
  }
  ok(res, { ...payload, model: out.model });
});

async function loadManagedLesson(req) {
  const lesson = await loadLesson(req.valid.params.lessonId);
  const access = await requireClassManager(req.user, lesson.module.classId);
  assertClassWritable(access.cls);
  return { lesson, cls: access.cls };
}

contentRouter.patch('/lessons/:lessonId', validate({ params: idParams('lessonId'), body: patchOf(lessonBody) }), async (req, res) => {
  const { lesson } = await loadManagedLesson(req);
  const body = req.valid.body;
  if (body.prerequisiteLessonId !== undefined) await assertLessonPrerequisite(lesson.moduleId, body.prerequisiteLessonId, lesson.id);
  await prisma.lesson.update({
    where: { id: lesson.id },
    data: {
      ...(body.title !== undefined ? { title: plainText(body.title, 200) } : {}),
      ...(body.contentHtml !== undefined ? { contentHtml: sanitizeRichText(body.contentHtml) } : {}),
      ...(body.objectives !== undefined ? { objectives: cleanList(body.objectives) } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.estimatedMinutes !== undefined ? { estimatedMinutes: body.estimatedMinutes } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.prerequisiteLessonId !== undefined ? { prerequisiteLessonId: body.prerequisiteLessonId } : {}),
    },
  });
  ok(res, await lessonDetail(req.user, lesson.id));
});

contentRouter.delete('/lessons/:lessonId', validate({ params: idParams('lessonId') }), async (req, res) => {
  const { lesson } = await loadManagedLesson(req);
  await prisma.$transaction(async (tx) => {
    await tx.lesson.update({ where: { id: lesson.id }, data: { deletedAt: new Date() } });
    await tx.lesson.updateMany({ where: { prerequisiteLessonId: lesson.id }, data: { prerequisiteLessonId: null } });
  });
  noContent(res);
});

// ── Progress ─────────────────────────────────────────────────────────────────
contentRouter.post('/lessons/:lessonId/complete', requireRole('STUDENT'), validate({ params: idParams('lessonId') }), async (req, res) => {
  // lessonDetail enforces visibility and locks.
  const detail = await lessonDetail(req.user, req.valid.params.lessonId);
  const access = await loadClassAccess(req.user, detail.classId);
  assertClassWritable(access.cls);
  const now = new Date();
  await prisma.lessonProgress.upsert({
    where: { lessonId_studentId: { lessonId: detail.id, studentId: req.user.id } },
    create: { lessonId: detail.id, studentId: req.user.id, firstViewedAt: now, lastViewedAt: now, completedAt: now },
    update: { completedAt: now, lastViewedAt: now },
  });
  ok(res, await lessonDetail(req.user, detail.id));
});

contentRouter.delete('/lessons/:lessonId/complete', requireRole('STUDENT'), validate({ params: idParams('lessonId') }), async (req, res) => {
  const detail = await lessonDetail(req.user, req.valid.params.lessonId);
  await prisma.lessonProgress.updateMany({ where: { lessonId: detail.id, studentId: req.user.id }, data: { completedAt: null } });
  ok(res, await lessonDetail(req.user, detail.id));
});

/** Completion per student for the teacher's progress view. */
classContentRouter.get('/modules-progress', validate({ params: classParams }), async (req, res) => {
  const { cls } = await requireClassManager(req.user, req.valid.params.classId);
  const now = new Date();
  const modules = await prisma.learningModule.findMany({
    where: { classId: cls.id, deletedAt: null, ...publishedWhere(now) },
    select: { id: true, title: true, lessons: { where: { deletedAt: null, status: 'PUBLISHED' }, select: { id: true } } },
    orderBy: { position: 'asc' },
  });
  const lessonIds = modules.flatMap((m) => m.lessons.map((l) => l.id));
  const [enrollments, progress] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: cls.id, status: 'ENROLLED' },
      select: { student: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    }),
    prisma.lessonProgress.findMany({ where: { lessonId: { in: lessonIds }, completedAt: { not: null } }, select: { lessonId: true, studentId: true } }),
  ]);
  const doneBy = new Map();
  for (const p of progress) {
    if (!doneBy.has(p.studentId)) doneBy.set(p.studentId, new Set());
    doneBy.get(p.studentId).add(p.lessonId);
  }
  ok(res, {
    modules: modules.map((m) => ({ id: m.id, title: m.title, lessonCount: m.lessons.length })),
    totalLessons: lessonIds.length,
    students: enrollments.map(({ student }) => {
      const done = doneBy.get(student.id) ?? new Set();
      return {
        id: student.id,
        name: fullName(student),
        completedLessons: done.size,
        percent: lessonIds.length === 0 ? 0 : round((done.size / lessonIds.length) * 100, 0),
        modules: Object.fromEntries(modules.map((m) => [m.id, m.lessons.filter((l) => done.has(l.id)).length])),
      };
    }),
  });
});

// ── Resources ────────────────────────────────────────────────────────────────
const EMBED_HOSTS = ['www.youtube.com', 'youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'player.vimeo.com', 'vimeo.com'];

function normalizeUrl(type, raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw fieldErrors({ url: 'Enter a complete link, for example https://example.com/page' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw fieldErrors({ url: 'Only http and https links are allowed.' });
  if (type !== 'EMBED') return url.toString();
  if (!EMBED_HOSTS.includes(url.hostname)) throw fieldErrors({ url: 'Videos can be embedded from YouTube or Vimeo. Add other sites as a link.' });
  // Convert watch/share links to their privacy-friendly embed form.
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (url.hostname.includes('youtube')) id = url.searchParams.get('v') ?? (/\/(?:embed|shorts|live)\/([\w-]+)/.exec(url.pathname)?.[1] ?? null);
  if (url.hostname.includes('youtu')) {
    if (!id || !/^[\w-]{6,20}$/.test(id)) throw fieldErrors({ url: 'That does not look like a YouTube video link.' });
    return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  const vimeo = /(\d{6,12})/.exec(url.pathname)?.[1];
  if (!vimeo) throw fieldErrors({ url: 'That does not look like a Vimeo video link.' });
  return `https://player.vimeo.com/video/${vimeo}`;
}

const resourceBody = z.object({
  title: zTitle,
  description: z.string().trim().max(1000).nullable().optional(),
  type: z.enum(['FILE', 'LINK', 'EMBED']),
  fileId: zId.optional(),
  url: z.string().trim().max(2000).optional(),
  moduleId: zId.nullable().optional(),
  lessonId: zId.nullable().optional(),
  allowDownload: z.boolean().default(true),
  isPublished: z.boolean().default(true),
});

async function resolvePlacement(classId, { moduleId, lessonId }) {
  if (lessonId) {
    const lesson = await prisma.lesson.findFirst({ where: { id: lessonId, deletedAt: null, module: { classId, deletedAt: null } }, select: { id: true, moduleId: true, title: true, module: { select: { title: true } } } });
    if (!lesson) throw fieldErrors({ lessonId: 'Choose a lesson from this class.' });
    return { moduleId: lesson.moduleId, lessonId: lesson.id, moduleTitle: lesson.module.title, lessonTitle: lesson.title };
  }
  if (moduleId) {
    const mod = await prisma.learningModule.findFirst({ where: { id: moduleId, classId, deletedAt: null }, select: { id: true, title: true } });
    if (!mod) throw fieldErrors({ moduleId: 'Choose a module from this class.' });
    return { moduleId: mod.id, lessonId: null, moduleTitle: mod.title, lessonTitle: null };
  }
  return { moduleId: null, lessonId: null, moduleTitle: null, lessonTitle: null };
}

async function resolveTargetResourcePlacement(tx, { moduleTitle, lessonTitle }, targetClassId) {
  if (!moduleTitle) return { moduleId: null, lessonId: null };
  const targetModuleId = await matchingModuleId(tx, { title: moduleTitle }, targetClassId);
  if (!targetModuleId) return { moduleId: null, lessonId: null };
  if (!lessonTitle) return { moduleId: targetModuleId, lessonId: null };
  const targetLesson = await tx.lesson.findFirst({
    where: { moduleId: targetModuleId, deletedAt: null, title: { equals: lessonTitle, mode: 'insensitive' } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return { moduleId: targetModuleId, lessonId: targetLesson?.id ?? null };
}

const createResourceBody = resourceBody.extend({
  targetClassIds: z.array(zId).max(50).default([]),
});

classContentRouter.post('/resources', validate({ params: classParams, body: createResourceBody }), async (req, res) => {
  const { cls } = await requireWritableClassManager(req.user, req.valid.params.classId);
  const body = req.valid.body;
  const placement = await resolvePlacement(cls.id, body);
  let fileId = null;
  let url = null;
  if (body.type === 'FILE') {
    if (!body.fileId) throw fieldErrors({ fileId: 'Upload a file first.' });
    // Only the teacher's own upload can become a class resource.
    const file = await prisma.file.findFirst({ where: { id: body.fileId, ownerId: req.user.id, deletedAt: null }, select: { id: true } });
    if (!file) throw fieldErrors({ fileId: 'That file is no longer available. Please upload it again.' });
    fileId = file.id;
  } else {
    url = normalizeUrl(body.type, body.url);
  }
  const targets = await resolveTargetClasses(req.user, cls.id, body.targetClassIds);
  const title = plainText(body.title, 200);
  const description = body.description ? plainText(body.description, 1000) : null;

  const { row, copies } = await prisma.$transaction(async (tx) => {
    const last = await tx.learningResource.aggregate({ where: { classId: cls.id, moduleId: placement.moduleId, lessonId: placement.lessonId }, _max: { position: true } });
    const primary = await tx.learningResource.create({
      data: {
        classId: cls.id, moduleId: placement.moduleId, lessonId: placement.lessonId, title, description,
        type: body.type, fileId, url, allowDownload: body.allowDownload, isPublished: body.isPublished, position: (last._max.position ?? -1) + 1, createdById: req.user.id,
      },
      include: { file: true },
    });
    const extra = [];
    for (const target of targets) {
      const targetPlace = await resolveTargetResourcePlacement(tx, placement, target.cls.id);
      const tLast = await tx.learningResource.aggregate({ where: { classId: target.cls.id, moduleId: targetPlace.moduleId, lessonId: targetPlace.lessonId }, _max: { position: true } });
      const copy = await tx.learningResource.create({
        data: {
          classId: target.cls.id, ...targetPlace, title, description,
          type: body.type, fileId, url, allowDownload: body.allowDownload, isPublished: body.isPublished, position: (tLast._max.position ?? -1) + 1, createdById: req.user.id,
        },
      });
      extra.push({ resource: copy, cls: target.cls });
    }
    return { row: primary, copies: extra };
  });

  const view = resourceView(row, { manage: true });
  created(res, copies.length > 0 ? { ...view, createdCopies: copies.map((c) => ({ id: c.resource.id, classId: c.cls.id, classLabel: classLabel(c.cls), moduleId: c.resource.moduleId, lessonId: c.resource.lessonId })) } : view);
});

contentRouter.post('/resources/:resourceId/copy', validate({ params: idParams('resourceId'), body: z.object({ targetClassIds: z.array(zId).min(1).max(50), isPublished: z.boolean().optional() }) }), async (req, res) => {
  const source = await prisma.learningResource.findUnique({
    where: { id: req.valid.params.resourceId },
    include: { file: true, module: { select: { title: true } }, lesson: { select: { title: true } } },
  });
  if (!source) throw notFound('Resource');
  await requireClassManager(req.user, source.classId);
  const body = req.valid.body;
  const targets = await resolveTargetClasses(req.user, source.classId, body.targetClassIds);
  if (targets.length === 0) throw fieldErrors({ targetClassIds: 'Choose at least one other class.' });
  const placementNames = { moduleTitle: source.module?.title ?? null, lessonTitle: source.lesson?.title ?? null };

  const copies = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const target of targets) {
      const targetPlace = await resolveTargetResourcePlacement(tx, placementNames, target.cls.id);
      const tLast = await tx.learningResource.aggregate({ where: { classId: target.cls.id, moduleId: targetPlace.moduleId, lessonId: targetPlace.lessonId }, _max: { position: true } });
      const copy = await tx.learningResource.create({
        data: {
          classId: target.cls.id,
          ...targetPlace,
          title: source.title,
          description: source.description,
          type: source.type,
          fileId: source.fileId,
          url: source.url,
          allowDownload: source.allowDownload,
          isPublished: body.isPublished ?? source.isPublished,
          position: (tLast._max.position ?? -1) + 1,
          createdById: req.user.id,
        },
        include: { file: true },
      });
      out.push({ copy, cls: target.cls });
    }
    return out;
  });

  created(res, {
    ...resourceView(copies[0].copy, { manage: true }),
    createdCopies: copies.map((c) => ({ id: c.copy.id, classId: c.cls.id, classLabel: classLabel(c.cls), moduleId: c.copy.moduleId, lessonId: c.copy.lessonId })),
  });
});

/** The class library: every resource a member may see, with where it lives. */
classContentRouter.get('/resources', validate({ params: classParams }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  const manage = access.canManage;
  const rows = await prisma.learningResource.findMany({
    where: { classId: access.cls.id },
    include: { file: true, module: { select: { id: true, title: true, status: true, publishAt: true, deletedAt: true, availableUntil: true } }, lesson: { select: { id: true, title: true, status: true, deletedAt: true } } },
    orderBy: [{ createdAt: 'desc' }],
  });
  const now = new Date();
  let visible = rows.filter((r) => !(r.module?.deletedAt || r.lesson?.deletedAt));
  if (!manage) {
    const locked = new Set((await listModules(req.user, access)).filter((m) => m.locked).map((m) => m.id));
    visible = visible.filter(
      (r) =>
        r.isPublished &&
        (!r.module || (isPublished(r.module, now) && (!r.module.availableUntil || r.module.availableUntil > now) && !locked.has(r.module.id))) &&
        (!r.lesson || r.lesson.status === 'PUBLISHED'),
    );
  }
  const bookmarks = new Set(
    (await prisma.bookmark.findMany({ where: { userId: req.user.id, resourceId: { in: visible.map((r) => r.id) } }, select: { resourceId: true } })).map((b) => b.resourceId),
  );
  ok(res, visible.map((r) => ({
    ...resourceView(r, { manage }),
    module: r.module ? { id: r.module.id, title: r.module.title } : null,
    lesson: r.lesson ? { id: r.lesson.id, title: r.lesson.title } : null,
    bookmarked: bookmarks.has(r.id),
  })));
});

async function loadManagedResource(req) {
  const resource = await prisma.learningResource.findUnique({ where: { id: req.valid.params.resourceId }, include: { file: true } });
  if (!resource) throw notFound('Resource');
  const access = await requireClassManager(req.user, resource.classId);
  assertClassWritable(access.cls);
  return resource;
}

contentRouter.patch(
  '/resources/:resourceId',
  validate({ params: idParams('resourceId'), body: patchOf(resourceBody.pick({ title: true, description: true, url: true, moduleId: true, lessonId: true, allowDownload: true, isPublished: true })) }),
  async (req, res) => {
    const resource = await loadManagedResource(req);
    const body = req.valid.body;
    const placement = body.moduleId !== undefined || body.lessonId !== undefined
      ? await resolvePlacement(resource.classId, { moduleId: body.moduleId ?? null, lessonId: body.lessonId ?? null })
      : {};
    const row = await prisma.learningResource.update({
      where: { id: resource.id },
      data: {
        ...placement,
        ...(body.title !== undefined ? { title: plainText(body.title, 200) } : {}),
        ...(body.description !== undefined ? { description: body.description ? plainText(body.description, 1000) : null } : {}),
        ...(body.url !== undefined && resource.type !== 'FILE' ? { url: normalizeUrl(resource.type, body.url) } : {}),
        ...(body.allowDownload !== undefined ? { allowDownload: body.allowDownload } : {}),
        ...(body.isPublished !== undefined ? { isPublished: body.isPublished } : {}),
      },
      include: { file: true },
    });
    ok(res, resourceView(row, { manage: true }));
  },
);

contentRouter.delete('/resources/:resourceId', validate({ params: idParams('resourceId') }), async (req, res) => {
  const resource = await loadManagedResource(req);
  await prisma.$transaction(async (tx) => {
    await tx.learningResource.delete({ where: { id: resource.id } });
    // The stored file goes too once nothing else links to it (a copied module may share it).
    if (resource.fileId && (await tx.learningResource.count({ where: { fileId: resource.fileId } })) === 0) {
      await tx.file.update({ where: { id: resource.fileId }, data: { deletedAt: new Date() } });
    }
  });
  noContent(res);
});

// ── Bookmarks ────────────────────────────────────────────────────────────────
const bookmarkBody = z.object({ lessonId: zId.optional(), resourceId: zId.optional() }).refine((b) => Boolean(b.lessonId) !== Boolean(b.resourceId), { message: 'Choose one lesson or one resource.' });

async function assertCanSee(user, { lessonId, resourceId }) {
  if (lessonId) {
    await lessonDetail(user, lessonId);
    return;
  }
  const resource = await prisma.learningResource.findUnique({ where: { id: resourceId }, select: { classId: true } });
  if (!resource) throw notFound('Resource');
  const access = await loadClassAccess(user, resource.classId);
  if (!access.canManage) {
    const visible = await prisma.learningResource.findFirst({ where: { id: resourceId, isPublished: true }, select: { id: true } });
    if (!visible) throw notFound('Resource');
  }
}

contentRouter.post('/bookmarks', validate({ body: bookmarkBody }), async (req, res) => {
  const body = req.valid.body;
  await assertCanSee(req.user, body);
  const existing = await prisma.bookmark.findFirst({ where: { userId: req.user.id, lessonId: body.lessonId ?? null, resourceId: body.resourceId ?? null } });
  const row = existing ?? (await prisma.bookmark.create({ data: { userId: req.user.id, lessonId: body.lessonId ?? null, resourceId: body.resourceId ?? null } }));
  created(res, { id: row.id });
});

contentRouter.delete('/bookmarks', validate({ body: bookmarkBody }), async (req, res) => {
  const body = req.valid.body;
  await prisma.bookmark.deleteMany({ where: { userId: req.user.id, lessonId: body.lessonId ?? null, resourceId: body.resourceId ?? null } });
  noContent(res);
});

contentRouter.get('/bookmarks', async (req, res) => {
  const rows = await prisma.bookmark.findMany({
    where: { userId: req.user.id },
    include: {
      lesson: { select: { id: true, title: true, deletedAt: true, status: true, contentHtml: true, module: { select: { id: true, title: true, classId: true, deletedAt: true, status: true, publishAt: true } } } },
      resource: { select: { id: true, title: true, type: true, classId: true, isPublished: true, url: true, fileId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const now = new Date();
  const myClasses = new Set(await classIdsFor(req.user));
  // Bookmarks to content that has since been unpublished or removed, or that belongs to a class
  // the user has left, are silently left out.
  const visible = rows.filter((b) =>
    b.lesson
      ? myClasses.has(b.lesson.module.classId) && !b.lesson.deletedAt && !b.lesson.module.deletedAt &&
        (req.user.role !== 'STUDENT' || (b.lesson.status === 'PUBLISHED' && isPublished(b.lesson.module, now)))
      : b.resource && myClasses.has(b.resource.classId) && (req.user.role !== 'STUDENT' || b.resource.isPublished),
  );
  ok(res, visible.map((b) => ({
    id: b.id,
    createdAt: b.createdAt,
    lesson: b.lesson ? { id: b.lesson.id, title: b.lesson.title, moduleTitle: b.lesson.module.title, classId: b.lesson.module.classId, excerpt: excerpt(b.lesson.contentHtml, 120) } : null,
    resource: b.resource ? { id: b.resource.id, title: b.resource.title, type: b.resource.type, classId: b.resource.classId, url: b.resource.type === 'FILE' ? null : b.resource.url, fileId: b.resource.fileId } : null,
  })));
});
