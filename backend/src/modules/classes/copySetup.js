// Copy gradebook weights/policy, syllabus, and learning outcomes from one class to existing classes.
import { lockKey } from '../../db/prisma.js';
import { AppError, conflict } from '../../lib/errors.js';
import { plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { audit } from '../../services/audit.js';
import { validateStructure } from '../gradebook/compute.js';
import { classLabel } from './access.js';

function matchSourceCategory(cat, periodName, sourcePeriods) {
  const pNorm = periodName.trim().toLowerCase();
  const cNorm = cat.name.trim().toLowerCase();

  // Never remap attendance work onto non-attendance categories or vice versa.
  const compatible = (sc) => (cat.kind === 'ATTENDANCE' ? sc.kind === 'ATTENDANCE' : sc.kind !== 'ATTENDANCE');

  // 1. Same period name & same category name.
  for (const sp of sourcePeriods) {
    if (sp.name.trim().toLowerCase() !== pNorm) continue;
    const match = sp.categories.find((sc) => compatible(sc) && sc.name.trim().toLowerCase() === cNorm);
    if (match) return match;
  }
  // 2. Any period, same category name & same kind.
  for (const sp of sourcePeriods) {
    const match = sp.categories.find((sc) => compatible(sc) && sc.name.trim().toLowerCase() === cNorm && sc.kind === cat.kind);
    if (match) return match;
  }
  // 3. Any period, same category name.
  for (const sp of sourcePeriods) {
    const match = sp.categories.find((sc) => compatible(sc) && sc.name.trim().toLowerCase() === cNorm);
    if (match) return match;
  }
  // 4. Same period name & same non-CUSTOM kind.
  if (cat.kind !== 'CUSTOM') {
    for (const sp of sourcePeriods) {
      if (sp.name.trim().toLowerCase() !== pNorm) continue;
      const match = sp.categories.find((sc) => compatible(sc) && sc.kind === cat.kind);
      if (match) return match;
    }
  }
  return null;
}

export async function copyClassSetup({ tx, req, source, targets, options, allowAttendanceInGrades }) {
  const { gradeWeights, gradePolicy, syllabus, learningOutcomes } = options;
  let sourcePeriods = [];

  if (gradeWeights) {
    sourcePeriods = await tx.gradingPeriod.findMany({
      where: { classId: source.id },
      orderBy: { position: 'asc' },
      include: { categories: { orderBy: { position: 'asc' } } },
    });
    const structureErrors = validateStructure(sourcePeriods);
    if (sourcePeriods.length === 0 || structureErrors.length > 0) {
      throw conflict(structureErrors[0] ?? `${classLabel(source)} has no valid gradebook weights to copy.`, 'INVALID_STRUCTURE');
    }
    for (const p of sourcePeriods) {
      if (p.categories.filter((c) => c.kind === 'ATTENDANCE').length > 1) {
        throw new AppError(422, 'INVALID_STRUCTURE', `"${p.name}" can have only one attendance category.`);
      }
    }
    if (sourcePeriods.some((p) => p.categories.some((c) => c.kind === 'ATTENDANCE')) && !allowAttendanceInGrades) {
      throw new AppError(
        422,
        'ATTENDANCE_NOT_GRADED',
        'Your institution does not include attendance in grades. Remove the attendance category from the source class or ask an administrator to change the policy.',
      );
    }
  }

  // Acquire per-class advisory locks in deterministic ID order so concurrent copies never deadlock.
  const orderedTargets = [...targets].sort((a, b) => a.id.localeCompare(b.id));
  const copied = [];
  for (const targetMeta of orderedTargets) {
    if (gradeWeights || gradePolicy) {
      await lockKey(tx, `gradebook:${targetMeta.id}`);
    }
    const target = await tx.class.findUnique({
      where: { id: targetMeta.id },
      include: { course: { select: { code: true } }, section: { select: { name: true } } },
    });
    const label = classLabel(target);

    if (gradeWeights || gradePolicy) {
      if (target.gradesFinalizedAt) {
        throw conflict(`Grades for ${label} are finalised. Reopen the gradebook before changing weights or policy.`, 'GRADES_FINALIZED');
      }
      const locked = await tx.gradingPeriod.findFirst({ where: { classId: target.id, lockedAt: { not: null } }, select: { name: true } });
      if (locked) {
        throw conflict(`"${locked.name}" in ${label} is locked. Unlock its grading periods before changing weights or policy.`, 'PERIOD_LOCKED');
      }
    }

    const classPatch = {};
    if (syllabus) classPatch.syllabusHtml = source.syllabusHtml ? sanitizeRichText(source.syllabusHtml) : null;
    if (learningOutcomes) {
      classPatch.learningOutcomes = Array.isArray(source.learningOutcomes)
        ? source.learningOutcomes.map((o) => plainText(String(o), 500)).filter(Boolean)
        : [];
    }
    if (gradePolicy) {
      classPatch.gradingScaleId = source.gradingScaleId;
      classPatch.transmutationBase = source.transmutationBase;
      classPatch.gradeRounding = source.gradeRounding;
      classPatch.treatMissingAsZero = source.treatMissingAsZero;
      classPatch.attendanceLateCredit = source.attendanceLateCredit;
    }
    if (Object.keys(classPatch).length > 0) {
      await tx.class.update({ where: { id: target.id }, data: classPatch });
    }

    let remappedItems = 0;
    if (gradeWeights) {
      const existingPeriods = await tx.gradingPeriod.findMany({
        where: { classId: target.id },
        include: { categories: { include: { _count: { select: { items: true } } } } },
        orderBy: { position: 'asc' },
      });

      const remap = [];
      for (const ep of existingPeriods) {
        for (const ec of ep.categories) {
          if (ec._count.items === 0) continue;
          const match = matchSourceCategory(ec, ep.name, sourcePeriods);
          if (!match) {
            throw conflict(
              `${label} already has ${ec._count.items} graded item(s) in "${ec.name}" (${ep.name}), which does not match any category in ${classLabel(source)}'s weights.`,
              'GRADEBOOK_IN_USE',
            );
          }
          remap.push({ oldCategoryId: ec.id, sourceCategoryId: match.id, count: ec._count.items });
          remappedItems += ec._count.items;
        }
      }

      // Free unique period & category names before creating the mirrored structure.
      for (const ep of existingPeriods) {
        await tx.gradingPeriod.update({ where: { id: ep.id }, data: { name: `~${ep.id}` } });
        for (const ec of ep.categories) {
          await tx.gradeCategory.update({ where: { id: ec.id }, data: { name: `~${ec.id}` } });
        }
      }

      const sourceCatToNewCat = new Map();
      for (const [pIndex, sp] of sourcePeriods.entries()) {
        const createdPeriod = await tx.gradingPeriod.create({
          data: { classId: target.id, name: sp.name, weight: sp.weight, position: pIndex },
        });
        for (const [cIndex, sc] of sp.categories.entries()) {
          const createdCat = await tx.gradeCategory.create({
            data: { periodId: createdPeriod.id, name: sc.name, kind: sc.kind, weight: sc.weight, position: cIndex },
          });
          sourceCatToNewCat.set(sc.id, createdCat.id);
        }
      }

      for (const r of remap) {
        await tx.gradeItem.updateMany({
          where: { categoryId: r.oldCategoryId },
          data: { categoryId: sourceCatToNewCat.get(r.sourceCategoryId) },
        });
      }

      const oldPeriodIds = existingPeriods.map((p) => p.id);
      const oldCategoryIds = existingPeriods.flatMap((p) => p.categories.map((c) => c.id));
      await tx.gradeOverride.updateMany({
        where: { classId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (oldCategoryIds.length > 0) {
        await tx.gradeCategory.deleteMany({ where: { id: { in: oldCategoryIds } } });
      }
      if (oldPeriodIds.length > 0) {
        await tx.gradingPeriod.deleteMany({ where: { id: { in: oldPeriodIds } } });
      }
    }

    const copiedParts = [
      gradeWeights && 'category weights',
      gradePolicy && 'grading policy',
      syllabus && 'syllabus',
      learningOutcomes && 'learning outcomes',
    ].filter(Boolean);

    await audit(req, {
      action: 'class.copy_setup',
      entityType: 'Class',
      entityId: target.id,
      classId: target.id,
      summary: `Copied ${copiedParts.join(', ')} from ${classLabel(source)}`,
      after: { sourceClassId: source.id, ...options, remappedItems },
    }, tx);

    copied.push({ id: target.id, label, remappedItems });
  }

  return copied;
}
