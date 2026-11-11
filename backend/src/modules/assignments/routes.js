// Assignments, student submissions, grading, feedback and returning work.
import { Router } from 'express';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { Prisma, lockKey, prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { safeFilename, sendBuffer } from '../../lib/exporter.js';
import { created, fullName, idParams, noContent, ok, patchOf, round, zHtml, zId, zOptionalDateTime, zTitle } from '../../lib/http.js';
import { escapeHtml, excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { isPublished, publishedWhere, resolvePublication } from '../../lib/visibility.js';
import { assertPermission, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { fileSummary, readStoredFile, syncAttachments } from '../../services/storage.js';
import { assertClassWritable, classLabel, loadClassAccess, requireClassManager, requireWritableClassManager } from '../classes/access.js';
import { recordGrade, syncLinkedItem } from '../gradebook/service.js';
import { applyPenalty, latePenalty } from './penalty.js';
import { rubricTotal, rubricView } from './rubrics.js';

export const classAssignmentsRouter = Router({ mergeParams: true }); // /classes/:classId/assignments
classAssignmentsRouter.use(requireAuth);
export const assignmentsRouter = Router(); // /assignments
assignmentsRouter.use(requireAuth);

const classParams = idParams('classId');
const assignmentParams = idParams('assignmentId');
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

const include = {
  attachments: { where: { deletedAt: null } },
  rubric: { include: { criteria: true } },
  gradeItem: { select: { id: true, categoryId: true, category: { select: { name: true, period: { select: { name: true, lockedAt: true } } } } } },
  module: { select: { id: true, title: true } },
};

// ── Availability rules (the server clock is the only one that counts) ────────

/**
 * Can this student hand in work right now?
 * @returns {{ open: boolean, late: boolean, reason?: string, code?: string, extended?: boolean }}
 */
export function submissionWindow(assignment, submission, now = new Date()) {
  if (submission?.reopenedUntil && submission.reopenedUntil > now) return { open: true, late: false, extended: true };
  if (assignment.availableFrom && assignment.availableFrom > now) {
    return { open: false, late: false, code: 'NOT_OPEN', reason: 'This assignment is not open for submissions yet.' };
  }
  if (!assignment.dueAt || now <= assignment.dueAt) {
    if (assignment.closeAt && now > assignment.closeAt) return { open: false, late: false, code: 'CLOSED', reason: 'This assignment is closed.' };
    return { open: true, late: false };
  }
  if (!assignment.allowLate) return { open: false, late: true, code: 'CLOSED', reason: 'The deadline has passed and late submissions are not accepted.' };
  if (assignment.closeAt && now > assignment.closeAt) return { open: false, late: true, code: 'CLOSED', reason: 'The late-submission period has ended.' };
  return { open: true, late: true };
}

const hasSubmitted = (s) => Boolean(s) && s.status !== 'DRAFT';

/** Status a student sees. A grade that has not been returned yet is not revealed. */
function studentStatus(assignment, submission, now) {
  if (submission?.status === 'RETURNED') return 'RETURNED';
  if (hasSubmitted(submission)) return 'SUBMITTED';
  if (assignment.dueAt && assignment.dueAt <= now) return 'MISSING';
  return submission ? 'DRAFT' : 'NOT_SUBMITTED';
}

// ── Serialisation ────────────────────────────────────────────────────────────
function baseView(a) {
  return {
    id: a.id,
    classId: a.classId,
    title: a.title,
    points: a.points,
    availableFrom: a.availableFrom,
    dueAt: a.dueAt,
    closeAt: a.closeAt,
    allowLate: a.allowLate,
    latePenaltyType: a.latePenaltyType,
    latePenaltyValue: a.latePenaltyValue,
    latePenaltyMax: a.latePenaltyMax,
    allowText: a.allowText,
    allowFiles: a.allowFiles,
    maxFiles: a.maxFiles,
    allowResubmission: a.allowResubmission,
    module: a.module ?? null,
    gradeCategory: a.gradeItem ? { id: a.gradeItem.categoryId, name: a.gradeItem.category.name, period: a.gradeItem.category.period.name } : null,
    hasRubric: Boolean(a.rubricId),
    programmingProblemId: a.programmingProblemId,
  };
}

const detailView = (a) => ({
  ...baseView(a),
  instructionsHtml: a.instructionsHtml,
  attachments: a.attachments.map(fileSummary),
  rubric: a.rubric ? rubricView(a.rubric) : null,
});

const manageFields = (a, now) => ({ status: a.status, publishAt: a.publishAt, publishedAt: a.publishedAt, isVisible: isPublished(a, now), createdAt: a.createdAt, updatedAt: a.updatedAt });

function submissionView(s, { forStudent }) {
  if (!s) return null;
  const released = !forStudent || s.status === 'RETURNED';
  return {
    id: s.id,
    status: forStudent && ['GRADED', 'UNDER_REVIEW'].includes(s.status) ? 'SUBMITTED' : s.status,
    textContent: s.textContent,
    files: (s.files ?? []).filter((f) => !f.deletedAt).map(fileSummary),
    attemptNumber: s.attemptNumber,
    submittedAt: s.submittedAt,
    isLate: s.isLate,
    penaltyPercent: s.penaltyPercent,
    reopenedUntil: s.reopenedUntil,
    rawScore: released ? s.rawScore : null,
    finalScore: released ? s.finalScore : null,
    feedback: released ? s.feedback : null,
    rubricScores: released ? s.rubricScores : null,
    gradedAt: released ? s.gradedAt : null,
    returnedAt: s.returnedAt,
    updatedAt: s.updatedAt,
  };
}

// ── Listing ──────────────────────────────────────────────────────────────────
classAssignmentsRouter.get('/', validate({ params: classParams }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  const now = new Date();
  const assignments = await prisma.assignment.findMany({
    where: { classId: access.cls.id, deletedAt: null, ...(access.canManage ? {} : publishedWhere(now)) },
    include: { gradeItem: include.gradeItem, module: include.module },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  if (!access.canManage) {
    const mine = await prisma.assignmentSubmission.findMany({ where: { studentId: req.user.id, assignmentId: { in: assignments.map((a) => a.id) } } });
    const byAssignment = new Map(mine.map((s) => [s.assignmentId, s]));
    ok(res, assignments.map((a) => {
      const s = byAssignment.get(a.id);
      return {
        ...baseView(a),
        myStatus: studentStatus(a, s, now),
        isLate: Boolean(s?.isLate) && hasSubmitted(s),
        submittedAt: hasSubmitted(s) ? s.submittedAt : null,
        score: s?.status === 'RETURNED' ? s.finalScore : null,
        window: submissionWindow(a, s, now),
      };
    }));
    return;
  }
  const enrolled = await enrolledStudentIds(access.cls.id);
  const groups = await prisma.assignmentSubmission.groupBy({
    by: ['assignmentId', 'status', 'isLate'],
    where: { assignmentId: { in: assignments.map((a) => a.id) }, studentId: { in: enrolled } },
    _count: { _all: true },
  });
  ok(res, assignments.map((a) => {
    const mine = groups.filter((g) => g.assignmentId === a.id);
    const count = (pred) => mine.filter(pred).reduce((s, g) => s + g._count._all, 0);
    const submitted = count((g) => g.status !== 'DRAFT');
    return {
      ...baseView(a),
      ...manageFields(a, now),
      stats: {
        enrolled: enrolled.length,
        submitted,
        toGrade: count((g) => ['SUBMITTED', 'UNDER_REVIEW'].includes(g.status)),
        graded: count((g) => ['GRADED', 'RETURNED'].includes(g.status)),
        returned: count((g) => g.status === 'RETURNED'),
        late: count((g) => g.isLate && g.status !== 'DRAFT'),
        missing: a.dueAt && a.dueAt <= now && isPublished(a, now) ? Math.max(0, enrolled.length - submitted) : 0,
      },
    };
  }));
});

// ── Create / update ──────────────────────────────────────────────────────────
const body = z.object({
  title: zTitle,
  instructionsHtml: zHtml.default(''),
  points: z.number().positive('Points must be more than zero').max(10_000).default(100),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']).default('DRAFT'),
  publishAt: zOptionalDateTime,
  availableFrom: zOptionalDateTime,
  dueAt: zOptionalDateTime,
  closeAt: zOptionalDateTime,
  allowLate: z.boolean().default(true),
  latePenaltyType: z.enum(['NONE', 'PERCENT_PER_DAY', 'PERCENT_FLAT']).default('NONE'),
  latePenaltyValue: z.number().min(0).max(100).default(0),
  latePenaltyMax: z.number().min(0).max(100).default(100),
  allowText: z.boolean().default(true),
  allowFiles: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(10).default(5),
  allowResubmission: z.boolean().default(true),
  rubricId: zId.nullable().optional(),
  moduleId: zId.nullable().optional(),
  /** Grade category this assignment counts under; null = not graded. */
  categoryId: zId.nullable().optional(),
  fileIds: z.array(zId).max(10).default([]),
});

/** Cross-field rules, applied to the values the assignment will have after the change. */
function assertSchedule(a) {
  const errors = {};
  if (a.availableFrom && a.dueAt && a.dueAt <= a.availableFrom) errors.dueAt = 'The due date must be after the opening date.';
  if (a.closeAt && a.dueAt && a.closeAt < a.dueAt) errors.closeAt = 'The closing date cannot be before the due date.';
  if (a.closeAt && !a.dueAt && a.availableFrom && a.closeAt <= a.availableFrom) errors.closeAt = 'The closing date must be after the opening date.';
  if (!a.allowText && !a.allowFiles) errors.allowText = 'Allow text, file uploads, or both.';
  if (a.latePenaltyType !== 'NONE' && a.latePenaltyValue <= 0) errors.latePenaltyValue = 'Enter the deduction, or choose "no penalty".';
  if (Object.keys(errors).length > 0) throw fieldErrors(errors);
}

async function resolveLinks(user, classId, { rubricId, moduleId }) {
  let rubric = null;
  if (rubricId) {
    rubric = await prisma.rubric.findFirst({ where: { id: rubricId, ...(user.role === 'ADMIN' ? {} : { ownerId: user.id }) }, include: { criteria: true } });
    if (!rubric) throw fieldErrors({ rubricId: 'Choose one of your rubrics.' });
  }
  if (moduleId) {
    const mod = await prisma.learningModule.findFirst({ where: { id: moduleId, classId, deletedAt: null }, select: { id: true } });
    if (!mod) throw fieldErrors({ moduleId: 'Choose a module from this class.' });
  }
  return rubric;
}

async function announce(assignment, cls) {
  await notify(await enrolledStudentIds(cls.id), {
    type: 'assignment.published', title: `New assignment in ${classLabel(cls)}: ${assignment.title}`, link: `/classes/${cls.id}/assignments/${assignment.id}`, classId: cls.id,
  });
}

const fullAssignment = (id, db = prisma) => db.assignment.findUnique({ where: { id }, include });

classAssignmentsRouter.post('/', validate({ params: classParams, body }), async (req, res) => {
  const { cls } = await requireWritableClassManager(req.user, req.valid.params.classId);
  const b = req.valid.body;
  const publication = resolvePublication(b, null);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  assertSchedule(b);
  const rubric = await resolveLinks(req.user, cls.id, b);
  const points = rubric ? rubricTotal(rubric) : b.points;
  const title = plainText(b.title, 200);

  const assignment = await prisma.$transaction(async (tx) => {
    const row = await tx.assignment.create({
      data: {
        classId: cls.id, moduleId: b.moduleId ?? null, title, instructionsHtml: sanitizeRichText(b.instructionsHtml), points, ...publication,
        availableFrom: b.availableFrom ?? null, dueAt: b.dueAt ?? null, closeAt: b.closeAt ?? null, allowLate: b.allowLate,
        latePenaltyType: b.latePenaltyType, latePenaltyValue: b.latePenaltyValue, latePenaltyMax: b.latePenaltyMax,
        allowText: b.allowText, allowFiles: b.allowFiles, maxFiles: b.maxFiles, allowResubmission: b.allowResubmission,
        rubricId: rubric?.id ?? null, createdById: req.user.id,
      },
    });
    await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'assignmentId', parentId: row.id });
    if (b.categoryId) {
      const item = await syncLinkedItem(tx, { classId: cls.id, categoryId: b.categoryId, title, maxPoints: points, dueAt: b.dueAt, assignmentId: row.id });
      if (item?.error) throw fieldErrors({ categoryId: item.error });
    }
    return row;
  });
  if (assignment.status === 'PUBLISHED') await announce(assignment, cls);
  const full = await fullAssignment(assignment.id);
  created(res, { ...detailView(full), ...manageFields(full, new Date()) });
});

async function loadAssignment(assignmentId) {
  const assignment = await fullAssignment(assignmentId);
  if (!assignment || assignment.deletedAt) throw notFound('Assignment');
  return assignment;
}

async function loadManaged(req, { writable = true } = {}) {
  const assignment = await loadAssignment(req.valid.params.assignmentId);
  const access = await requireClassManager(req.user, assignment.classId);
  if (writable) assertClassWritable(access.cls);
  return { assignment, cls: access.cls };
}

/** For a student: the assignment must be published in a class they are enrolled in. */
async function loadForStudent(req) {
  const assignment = await loadAssignment(req.valid.params.assignmentId);
  const access = await loadClassAccess(req.user, assignment.classId);
  if (!access.isStudent) throw forbidden('Only students enrolled in this class can do that.');
  if (!isPublished(assignment)) throw notFound('Assignment');
  return { assignment, cls: access.cls };
}

assignmentsRouter.get('/:assignmentId', validate({ params: assignmentParams }), async (req, res) => {
  const assignment = await loadAssignment(req.valid.params.assignmentId);
  const access = await loadClassAccess(req.user, assignment.classId);
  const now = new Date();
  if (access.canManage) {
    ok(res, { ...detailView(assignment), ...manageFields(assignment, now) });
    return;
  }
  if (!isPublished(assignment, now)) throw notFound('Assignment');
  const submission = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: req.user.id } }, include: { files: { where: { deletedAt: null } } },
  });
  ok(res, {
    ...detailView(assignment),
    myStatus: studentStatus(assignment, submission, now),
    window: submissionWindow(assignment, submission, now),
    submission: submissionView(submission, { forStudent: true }),
    serverTime: now,
  });
});

assignmentsRouter.patch('/:assignmentId', validate({ params: assignmentParams, body: patchOf(body) }), async (req, res) => {
  const { assignment, cls } = await loadManaged(req);
  const b = req.valid.body;
  const next = { ...assignment, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  assertSchedule(next);
  const publication = resolvePublication({ status: b.status, publishAt: b.publishAt ?? assignment.publishAt }, assignment);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  const rubric = b.rubricId !== undefined || b.moduleId !== undefined
    ? await resolveLinks(req.user, cls.id, { rubricId: b.rubricId === undefined ? assignment.rubricId : b.rubricId, moduleId: b.moduleId === undefined ? null : b.moduleId })
    : assignment.rubric;
  const points = rubric ? rubricTotal(rubric) : next.points;
  const title = b.title !== undefined ? plainText(b.title, 200) : assignment.title;

  if (b.rubricId !== undefined && b.rubricId !== assignment.rubricId) {
    const scored = await prisma.assignmentSubmission.count({ where: { assignmentId: assignment.id, rubricScores: { not: Prisma.AnyNull } } });
    if (scored > 0) throw conflict('Submissions have already been graded with the current rubric, so it cannot be replaced.', 'RUBRIC_IN_USE');
  }
  if (points < assignment.points) {
    const above = await prisma.assignmentSubmission.count({ where: { assignmentId: assignment.id, rawScore: { gt: points } } });
    if (above > 0) throw fieldErrors({ points: `${above} submission(s) already have a score above ${points}. Lower those scores first.` });
  }
  const wasVisible = isPublished(assignment);
  const dueChanged = b.dueAt !== undefined && (b.dueAt?.getTime() ?? null) !== (assignment.dueAt?.getTime() ?? null);

  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: {
        title,
        points,
        ...(b.instructionsHtml !== undefined ? { instructionsHtml: sanitizeRichText(b.instructionsHtml) } : {}),
        ...Object.fromEntries(
          ['availableFrom', 'dueAt', 'closeAt', 'allowLate', 'latePenaltyType', 'latePenaltyValue', 'latePenaltyMax', 'allowText', 'allowFiles', 'maxFiles', 'allowResubmission', 'moduleId']
            .filter((k) => b[k] !== undefined)
            .map((k) => [k, b[k]]),
        ),
        ...(b.rubricId !== undefined ? { rubricId: rubric?.id ?? null } : {}),
        // A new deadline deserves a new reminder.
        ...(dueChanged ? { reminderSentAt: null } : {}),
        ...publication,
      },
    });
    if (b.fileIds !== undefined) await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'assignmentId', parentId: assignment.id });
    const categoryId = b.categoryId === undefined ? assignment.gradeItem?.categoryId ?? null : b.categoryId;
    const item = await syncLinkedItem(tx, { classId: cls.id, categoryId, title, maxPoints: points, dueAt: next.dueAt, assignmentId: assignment.id });
    if (item?.error) throw fieldErrors({ categoryId: item.error });
    if (item && b.categoryId !== undefined && !assignment.gradeItem) {
      // Newly added to the gradebook: bring over the scores that already exist.
      const graded = await tx.assignmentSubmission.findMany({ where: { assignmentId: assignment.id, status: { in: ['GRADED', 'RETURNED'] }, finalScore: { not: null } } });
      for (const s of graded) {
        await recordGrade(tx, { gradeItemId: item.id, studentId: s.studentId, score: s.finalScore, status: 'GRADED', isLate: s.isLate, source: 'AUTO_SYNC', changedById: req.user.id });
      }
    }
    if (dueChanged && wasVisible) {
      await audit(req, { action: 'assignment.deadline.change', entityType: 'Assignment', entityId: assignment.id, classId: cls.id, summary: `Changed the due date of "${title}"`, before: { dueAt: assignment.dueAt }, after: { dueAt: b.dueAt } }, tx);
    }
  });
  const full = await fullAssignment(assignment.id);
  if (!wasVisible && full.status === 'PUBLISHED') await announce(full, cls);
  else if (dueChanged && wasVisible && isPublished(full)) {
    await notify(await enrolledStudentIds(cls.id), { type: 'assignment.updated', title: `Due date changed: ${full.title}`, link: `/classes/${cls.id}/assignments/${full.id}`, classId: cls.id });
  }
  ok(res, { ...detailView(full), ...manageFields(full, new Date()) });
});

assignmentsRouter.delete('/:assignmentId', validate({ params: assignmentParams }), async (req, res) => {
  const { assignment, cls } = await loadManaged(req);
  await prisma.$transaction(async (tx) => {
    const submissions = await tx.assignmentSubmission.count({ where: { assignmentId: assignment.id, status: { not: 'DRAFT' } } });
    // Removes the gradebook column too — refused while its grading period is locked.
    await syncLinkedItem(tx, { classId: cls.id, categoryId: null, assignmentId: assignment.id });
    await tx.assignment.update({ where: { id: assignment.id }, data: { deletedAt: new Date() } });
    await audit(req, { action: 'assignment.delete', entityType: 'Assignment', entityId: assignment.id, classId: cls.id, summary: `Deleted assignment "${assignment.title}" (${submissions} submission(s))` }, tx);
  });
  noContent(res);
});

assignmentsRouter.post('/:assignmentId/copy', validate({ params: assignmentParams, body: z.object({ targetClassId: zId.optional() }) }), async (req, res) => {
  const { assignment } = await loadManaged(req, { writable: false });
  const target = await requireWritableClassManager(req.user, req.valid.body.targetClassId ?? assignment.classId);
  const sameClass = target.cls.id === assignment.classId;
  const copy = await prisma.assignment.create({
    data: {
      classId: target.cls.id, title: sameClass ? `${assignment.title} (copy)`.slice(0, 200) : assignment.title, instructionsHtml: assignment.instructionsHtml, points: assignment.points,
      status: 'DRAFT', allowLate: assignment.allowLate, latePenaltyType: assignment.latePenaltyType, latePenaltyValue: assignment.latePenaltyValue, latePenaltyMax: assignment.latePenaltyMax,
      allowText: assignment.allowText, allowFiles: assignment.allowFiles, maxFiles: assignment.maxFiles, allowResubmission: assignment.allowResubmission,
      rubricId: assignment.rubricId, moduleId: sameClass ? assignment.moduleId : null, createdById: req.user.id,
    },
  });
  const full = await fullAssignment(copy.id);
  created(res, { ...detailView(full), ...manageFields(full, new Date()) });
});

// ── Student: save and submit ─────────────────────────────────────────────────
const submissionBody = z.object({
  textContent: z.string().max(200_000).nullable().optional(),
  fileIds: z.array(zId).max(10).default([]),
  submit: z.boolean().default(false),
});

assignmentsRouter.put('/:assignmentId/submission', requireRole('STUDENT'), validate({ params: assignmentParams, body: submissionBody }), async (req, res) => {
  const { assignment, cls } = await loadForStudent(req);
  assertClassWritable(cls);
  const b = req.valid.body;
  const text = assignment.allowText && b.textContent ? sanitizeRichText(b.textContent) : null;
  const fileIds = assignment.allowFiles ? b.fileIds : [];
  if (!assignment.allowFiles && b.fileIds.length > 0) throw fieldErrors({ fileIds: 'This assignment does not accept file uploads.' });
  if (fileIds.length > assignment.maxFiles) throw fieldErrors({ fileIds: `You can upload at most ${assignment.maxFiles} file(s) for this assignment.` });

  const saved = await prisma.$transaction(async (tx) => {
    // One submission per student: concurrent requests (a double click, two tabs) are serialised.
    await lockKey(tx, `submission:${assignment.id}:${req.user.id}`);
    const now = new Date();
    const existing = await tx.assignmentSubmission.findUnique({ where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: req.user.id } } });
    const window = submissionWindow(assignment, existing, now);
    if (!window.open) throw new AppError(409, window.code, window.reason);

    if (hasSubmitted(existing)) {
      // Submitted work is frozen. Changing it means submitting again, under the rules below.
      if (!b.submit) throw conflict('You have already submitted this assignment. Submit again to replace your work.', 'ALREADY_SUBMITTED');
      const reviewed = ['GRADED', 'RETURNED'].includes(existing.status);
      if (reviewed && !window.extended) throw conflict('This work has already been graded. Ask your teacher to reopen it if you need to resubmit.', 'ALREADY_GRADED');
      if (!reviewed && !assignment.allowResubmission) throw conflict('Resubmission is not allowed for this assignment.', 'RESUBMISSION_NOT_ALLOWED');
    }
    if (b.submit && !excerpt(text ?? '', 5) && fileIds.length === 0) {
      throw fieldErrors({ [assignment.allowText ? 'textContent' : 'fileIds']: assignment.allowText && assignment.allowFiles ? 'Write your answer or attach a file before submitting.' : assignment.allowText ? 'Write your answer before submitting.' : 'Attach a file before submitting.' });
    }
    const penalty = b.submit && window.late
      ? latePenalty({ dueAt: assignment.dueAt, submittedAt: now, type: assignment.latePenaltyType, value: assignment.latePenaltyValue, max: assignment.latePenaltyMax })
      : { isLate: false, penaltyPercent: 0 };
    const data = b.submit
      ? {
          textContent: text, status: 'SUBMITTED', submittedAt: now, attemptNumber: (existing?.attemptNumber ?? 0) + 1,
          isLate: penalty.isLate, penaltyPercent: penalty.penaltyPercent,
          // An extension granted by the teacher is used up by this submission.
          reopenedUntil: null,
        }
      : { textContent: text };
    const row = existing
      ? await tx.assignmentSubmission.update({ where: { id: existing.id }, data })
      : await tx.assignmentSubmission.create({ data: { assignmentId: assignment.id, studentId: req.user.id, ...data } });
    await syncAttachments(tx, { fileIds, ownerId: req.user.id, field: 'submissionId', parentId: row.id, max: assignment.maxFiles });
    return tx.assignmentSubmission.findUnique({ where: { id: row.id }, include: { files: { where: { deletedAt: null } } } });
  });
  const now = new Date();
  ok(res, { submission: submissionView(saved, { forStudent: true }), myStatus: studentStatus(assignment, saved, now), window: submissionWindow(assignment, saved, now) });
});

// ── Teacher: review and grade ────────────────────────────────────────────────
const rosterStatus = (assignment, s, now) => {
  if (hasSubmitted(s)) return s.status;
  return assignment.dueAt && assignment.dueAt <= now && isPublished(assignment, now) ? 'MISSING' : 'NOT_SUBMITTED';
};

async function roster(assignment) {
  const [enrollments, submissions] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: assignment.classId, status: 'ENROLLED' },
      select: { student: { select: { id: true, firstName: true, lastName: true, avatarFileId: true, studentProfile: { select: { studentNumber: true } } } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    }),
    prisma.assignmentSubmission.findMany({ where: { assignmentId: assignment.id }, include: { _count: { select: { files: { where: { deletedAt: null } } } } } }),
  ]);
  const byStudent = new Map(submissions.map((s) => [s.studentId, s]));
  const now = new Date();
  return enrollments.map(({ student }) => {
    const s = byStudent.get(student.id);
    return {
      student: { id: student.id, name: fullName(student), firstName: student.firstName, lastName: student.lastName, avatarFileId: student.avatarFileId, studentNumber: student.studentProfile?.studentNumber ?? null },
      status: rosterStatus(assignment, s, now),
      submittedAt: hasSubmitted(s) ? s.submittedAt : null,
      isLate: Boolean(s?.isLate) && hasSubmitted(s),
      attemptNumber: s?.attemptNumber ?? 0,
      fileCount: s?._count.files ?? 0,
      rawScore: s?.rawScore ?? null,
      finalScore: s?.finalScore ?? null,
      penaltyPercent: s?.penaltyPercent ?? 0,
      returnedAt: s?.returnedAt ?? null,
      reopenedUntil: s?.reopenedUntil ?? null,
    };
  });
}

assignmentsRouter.get('/:assignmentId/submissions', validate({ params: assignmentParams }), async (req, res) => {
  const { assignment } = await loadManaged(req, { writable: false });
  ok(res, { assignment: { ...baseView(assignment), ...manageFields(assignment, new Date()) }, students: await roster(assignment) });
});

assignmentsRouter.get('/:assignmentId/submissions/:studentId', validate({ params: idParams('assignmentId', 'studentId') }), async (req, res) => {
  const { assignment } = await loadManaged(req, { writable: false });
  const students = await roster(assignment);
  const index = students.findIndex((s) => s.student.id === req.valid.params.studentId);
  if (index === -1) throw notFound('Student');
  const submission = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: req.valid.params.studentId } },
    include: { files: { where: { deletedAt: null } }, gradedBy: { select: { firstName: true, lastName: true } } },
  });
  ok(res, {
    assignment: detailView(assignment),
    student: students[index].student,
    status: students[index].status,
    submission: submission ? { ...submissionView(submission, { forStudent: false }), gradedBy: submission.gradedBy ? fullName(submission.gradedBy) : null } : null,
    previousStudentId: students[index - 1]?.student.id ?? null,
    nextStudentId: students[index + 1]?.student.id ?? null,
    position: index + 1,
    total: students.length,
  });
});

const gradeBody = z.object({
  score: z.number().min(0).max(10_000).nullable().optional(),
  rubricScores: z.record(zId, z.object({ points: z.number().min(0).max(1000), comment: z.string().trim().max(1000).optional().default('') })).optional(),
  feedback: z.string().trim().max(10_000).nullable().optional(),
  waivePenalty: z.boolean().optional(),
  return: z.boolean().default(false),
});

assignmentsRouter.put('/:assignmentId/submissions/:studentId/grade', validate({ params: idParams('assignmentId', 'studentId'), body: gradeBody }), async (req, res) => {
  const { assignment, cls } = await loadManaged(req);
  const { studentId } = req.valid.params;
  const b = req.valid.body;
  const enrollment = await prisma.enrollment.findUnique({ where: { classId_studentId: { classId: cls.id, studentId } }, select: { status: true } });
  if (enrollment?.status !== 'ENROLLED') throw notFound('Student');

  let rawScore;
  let rubricScores = null;
  if (assignment.rubric && b.rubricScores) {
    const criteria = new Map(assignment.rubric.criteria.map((c) => [c.id, c]));
    rubricScores = {};
    for (const [criterionId, value] of Object.entries(b.rubricScores)) {
      const c = criteria.get(criterionId);
      if (!c) throw fieldErrors({ rubricScores: 'The rubric changed. Reload the page and grade again.' });
      if (value.points > c.maxPoints) throw fieldErrors({ rubricScores: `"${c.title}" is worth at most ${c.maxPoints} points.` });
      rubricScores[criterionId] = { points: value.points, comment: plainText(value.comment ?? '', 1000) };
    }
    if (Object.keys(rubricScores).length !== criteria.size) throw fieldErrors({ rubricScores: 'Score every criterion of the rubric.' });
    rawScore = round(Object.values(rubricScores).reduce((s, v) => s + v.points, 0), 2);
  } else {
    if (b.score === null || b.score === undefined) throw fieldErrors({ score: assignment.rubric ? 'Score the rubric, or enter a score.' : 'Enter a score.' });
    rawScore = round(b.score, 2);
  }
  if (rawScore > assignment.points) throw fieldErrors({ score: `The score cannot be more than ${assignment.points} points.` });

  const result = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `submission:${assignment.id}:${studentId}`);
    const now = new Date();
    const existing = await tx.assignmentSubmission.findUnique({ where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } } });
    const penaltyPercent = b.waivePenalty ? 0 : existing?.penaltyPercent ?? 0;
    const finalScore = applyPenalty(rawScore, penaltyPercent);
    const returning = b.return || existing?.status === 'RETURNED';
    const data = {
      rawScore, finalScore, penaltyPercent, rubricScores: rubricScores ?? undefined,
      feedback: b.feedback === undefined ? existing?.feedback ?? null : b.feedback ? sanitizeRichText(b.feedback) : null,
      status: returning ? 'RETURNED' : 'GRADED', gradedById: req.user.id, gradedAt: now,
      ...(returning ? { returnedAt: existing?.returnedAt ?? now } : {}),
    };
    // Work handed in on paper has no online submission: grading creates the record.
    const row = existing
      ? await tx.assignmentSubmission.update({ where: { id: existing.id }, data })
      : await tx.assignmentSubmission.create({ data: { assignmentId: assignment.id, studentId, ...data } });
    if (assignment.gradeItem) {
      await recordGrade(tx, { gradeItemId: assignment.gradeItem.id, studentId, score: finalScore, status: 'GRADED', isLate: row.isLate, source: 'AUTO_SYNC', changedById: req.user.id });
    }
    const wasReleased = existing?.status === 'RETURNED';
    if (wasReleased && existing.finalScore !== finalScore) {
      await audit(req, {
        action: 'submission.regrade', entityType: 'AssignmentSubmission', entityId: row.id, classId: cls.id, summary: `Changed a returned grade for "${assignment.title}"`,
        before: { rawScore: existing.rawScore, finalScore: existing.finalScore }, after: { rawScore, finalScore },
      }, tx);
    }
    if (b.waivePenalty && (existing?.penaltyPercent ?? 0) > 0) {
      await audit(req, { action: 'submission.penalty.waive', entityType: 'AssignmentSubmission', entityId: row.id, classId: cls.id, summary: `Waived the ${existing.penaltyPercent}% late penalty for "${assignment.title}"` }, tx);
    }
    return { row, newlyReturned: returning && !wasReleased, changedAfterReturn: wasReleased && existing.finalScore !== finalScore };
  });
  if (result.newlyReturned || result.changedAfterReturn) {
    await notify([studentId], {
      type: 'assignment.returned', title: `${result.changedAfterReturn ? 'Grade updated' : 'Graded'}: ${assignment.title}`,
      body: `${classLabel(cls)} — ${result.row.finalScore} / ${assignment.points}`, link: `/classes/${cls.id}/assignments/${assignment.id}`, classId: cls.id,
    });
  }
  const saved = await prisma.assignmentSubmission.findUnique({ where: { id: result.row.id }, include: { files: { where: { deletedAt: null } } } });
  ok(res, submissionView(saved, { forStudent: false }));
});

/** Return graded work to students (all of it, or the selected students). */
assignmentsRouter.post('/:assignmentId/return', validate({ params: assignmentParams, body: z.object({ studentIds: z.array(zId).max(1000).optional() }) }), async (req, res) => {
  const { assignment, cls } = await loadManaged(req);
  const now = new Date();
  const graded = await prisma.assignmentSubmission.findMany({
    where: { assignmentId: assignment.id, status: 'GRADED', ...(req.valid.body.studentIds ? { studentId: { in: req.valid.body.studentIds } } : {}) },
    select: { id: true, studentId: true },
  });
  if (graded.length > 0) {
    await prisma.assignmentSubmission.updateMany({ where: { id: { in: graded.map((g) => g.id) }, status: 'GRADED' }, data: { status: 'RETURNED', returnedAt: now } });
    await notify(graded.map((g) => g.studentId), { type: 'assignment.returned', title: `Graded: ${assignment.title}`, body: classLabel(cls), link: `/classes/${cls.id}/assignments/${assignment.id}`, classId: cls.id });
  }
  ok(res, { returned: graded.length });
});

/** Let one student submit (again) after the deadline or after grading. */
assignmentsRouter.post(
  '/:assignmentId/submissions/:studentId/reopen',
  validate({ params: idParams('assignmentId', 'studentId'), body: z.object({ until: z.coerce.date(), note: z.string().trim().max(500).optional() }) }),
  async (req, res) => {
    const { assignment, cls } = await loadManaged(req);
    const { studentId } = req.valid.params;
    const { until, note } = req.valid.body;
    if (until <= new Date()) throw fieldErrors({ until: 'Choose a time in the future.' });
    const enrollment = await prisma.enrollment.findUnique({ where: { classId_studentId: { classId: cls.id, studentId } }, select: { status: true } });
    if (enrollment?.status !== 'ENROLLED') throw notFound('Student');
    const row = await prisma.assignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
      create: { assignmentId: assignment.id, studentId, reopenedUntil: until },
      update: { reopenedUntil: until },
    });
    await audit(req, { action: 'submission.reopen', entityType: 'AssignmentSubmission', entityId: row.id, classId: cls.id, summary: `Reopened "${assignment.title}" for one student until ${until.toISOString()}${note ? ` — ${plainText(note, 500)}` : ''}` });
    await notify([studentId], {
      type: 'assignment.reopened', title: `You can submit again: ${assignment.title}`, body: note ? plainText(note, 200) : undefined, link: `/classes/${cls.id}/assignments/${assignment.id}`, classId: cls.id,
    });
    ok(res, { reopenedUntil: row.reopenedUntil });
  },
);

/** All submitted work as one ZIP, a folder per student. */
assignmentsRouter.get('/:assignmentId/submissions-archive', validate({ params: assignmentParams }), async (req, res) => {
  const { assignment, cls } = await loadManaged(req, { writable: false });
  await assertPermission(req.user, 'submissions.download');
  const submissions = await prisma.assignmentSubmission.findMany({
    where: { assignmentId: assignment.id, status: { not: 'DRAFT' } },
    include: { files: { where: { deletedAt: null } }, student: { select: { firstName: true, lastName: true, studentProfile: { select: { studentNumber: true } } } } },
  });
  if (submissions.length === 0) throw conflict('Nobody has submitted this assignment yet.', 'NOTHING_TO_DOWNLOAD');
  const total = submissions.reduce((sum, s) => sum + s.files.reduce((x, f) => x + f.sizeBytes, 0), 0);
  if (total > MAX_ARCHIVE_BYTES) throw new AppError(413, 'ARCHIVE_TOO_LARGE', 'These submissions are too large to download together. Download them student by student.');

  const entries = {};
  const usedFolders = new Set();
  for (const s of submissions) {
    let folder = safeFilename(`${s.student.lastName}, ${s.student.firstName}${s.student.studentProfile?.studentNumber ? ` (${s.student.studentProfile.studentNumber})` : ''}`) || 'student';
    while (usedFolders.has(folder)) folder = `${folder}_`;
    usedFolders.add(folder);
    if (s.textContent) {
      const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(assignment.title)}</title><h1>${escapeHtml(assignment.title)}</h1><p><strong>${escapeHtml(fullName(s.student))}</strong> — submitted ${s.submittedAt?.toISOString() ?? ''}${s.isLate ? ' (late)' : ''}</p><hr>${s.textContent}`;
      entries[`${folder}/answer.html`] = new TextEncoder().encode(html);
    }
    const usedNames = new Set(['answer.html']);
    for (const f of s.files) {
      let name = safeFilename(f.originalName) || `file.${f.extension}`;
      while (usedNames.has(name)) name = `_${name}`;
      usedNames.add(name);
      try {
        entries[`${folder}/${name}`] = new Uint8Array(await readStoredFile(f));
      } catch {
        entries[`${folder}/${name}.MISSING.txt`] = new TextEncoder().encode('This file could not be read from storage.');
      }
    }
  }
  await audit(req, { action: 'submissions.download', entityType: 'Assignment', entityId: assignment.id, classId: cls.id, summary: `Downloaded ${submissions.length} submission(s) of "${assignment.title}"` });
  // Most uploads (PDF, DOCX, images) are already compressed, so the archive is stored, not deflated.
  sendBuffer(res, Buffer.from(zipSync(entries, { level: 0 })), `${safeFilename(`${cls.course.code}-${assignment.title}`)}-submissions.zip`, 'application/zip');
});
