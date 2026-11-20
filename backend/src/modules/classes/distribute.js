// Shared helpers for posting or copying learning materials across multiple classes owned by a teacher.
import { removeStoredFile } from '../../services/storage.js';
import { requireWritableClassManager } from './access.js';

/**
 * Deduplicate `targetClassIds`, skip `primaryClassId`, and verify the user manages and can write
 * to each target class (active, not archived).
 */
export async function resolveTargetClasses(user, primaryClassId, targetClassIds = []) {
  const unique = [...new Set((targetClassIds ?? []).filter(Boolean))].filter((id) => id !== primaryClassId);
  const targets = [];
  for (const id of unique) targets.push(await requireWritableClassManager(user, id));
  return targets;
}

/** Find an active module in `targetClassId` with the same title as `sourceModule` (case-insensitive). */
export async function matchingModuleId(tx, sourceModuleOrId, targetClassId) {
  if (!sourceModuleOrId) return null;
  const source = typeof sourceModuleOrId === 'string'
    ? await tx.learningModule.findUnique({ where: { id: sourceModuleOrId }, select: { id: true, title: true } })
    : sourceModuleOrId;
  if (!source?.title) return null;
  const match = await tx.learningModule.findFirst({
    where: { classId: targetClassId, deletedAt: null, title: { equals: source.title, mode: 'insensitive' } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return match?.id ?? null;
}

/**
 * Find a module with the same title in `targetClassId`, or create a matching shell module there
 * so lessons/resources posted to multiple classes always have a home.
 */
export async function resolveOrCreateModule(tx, sourceModule, targetClassId, userId, now = new Date()) {
  const existingId = await matchingModuleId(tx, sourceModule, targetClassId);
  if (existingId) return { id: existingId, created: false, module: null };

  const last = await tx.learningModule.aggregate({ where: { classId: targetClassId, deletedAt: null }, _max: { position: true } });
  let status = 'DRAFT';
  let publishAt = null;
  let publishedAt = null;
  if (sourceModule.status === 'PUBLISHED') {
    status = 'PUBLISHED';
    publishAt = sourceModule.publishAt ?? now;
    publishedAt = sourceModule.publishedAt ?? now;
  } else if (sourceModule.status === 'SCHEDULED' && sourceModule.publishAt && sourceModule.publishAt > now) {
    status = 'SCHEDULED';
    publishAt = sourceModule.publishAt;
  }
  const availableUntil = sourceModule.availableUntil && sourceModule.availableUntil > now ? sourceModule.availableUntil : null;

  const created = await tx.learningModule.create({
    data: {
      classId: targetClassId,
      title: sourceModule.title,
      description: sourceModule.description ?? null,
      objectives: sourceModule.objectives ?? [],
      position: (last._max.position ?? -1) + 1,
      status,
      publishAt,
      publishedAt,
      availableUntil,
      source: sourceModule.source ?? 'MANUAL',
      createdById: userId,
    },
  });
  return { id: created.id, created: true, module: created };
}

/**
 * Find the matching unlocked gradebook category in `targetClassId` by (period name, category name)
 * so cross-posted assignments and quizzes automatically connect to the target class's gradebook
 * when its structure matches. Returns null if the target class is finalised, locked, or differs.
 */
export async function matchingCategoryId(tx, sourceCategoryId, targetClassId) {
  if (!sourceCategoryId) return null;
  const [source, targetCls] = await Promise.all([
    tx.gradeCategory.findUnique({
      where: { id: sourceCategoryId },
      select: { name: true, period: { select: { name: true } } },
    }),
    tx.class.findUnique({ where: { id: targetClassId }, select: { gradesFinalizedAt: true } }),
  ]);
  if (!source || !targetCls || targetCls.gradesFinalizedAt) return null;
  const match = await tx.gradeCategory.findFirst({
    where: {
      name: { equals: source.name, mode: 'insensitive' },
      kind: { not: 'ATTENDANCE' },
      period: {
        classId: targetClassId,
        lockedAt: null,
        name: { equals: source.period.name, mode: 'insensitive' },
      },
    },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  return match?.id ?? null;
}

/** Best-effort cleanup of non-database stored files if an outer transaction fails. */
export async function cleanupStoredFiles(storedNames) {
  if (!storedNames || storedNames.length === 0) return;
  await Promise.allSettled(storedNames.map((name) => removeStoredFile(name)));
}
