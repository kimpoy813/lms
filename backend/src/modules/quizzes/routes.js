// Quizzes and exams: building, taking (with a server-side clock and, when the teacher wants them,
// strict rules whose violations end the attempt), scoring, manual grading, result release,
// analysis and export.
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Prisma, lockKey, prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { exportFormat, sendTable } from '../../lib/exporter.js';
import { created, fullName, idParams, noContent, ok, patchOf, round, zHtml, zId, zOptionalDateTime, zTitle } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { attemptTotals, buildSnapshot, correctAnswer, isAnswered, publicQuestion, sanitizeResponse, scoreAnswer, shuffle, toEditorShape } from '../../lib/quizScoring.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { dateKey, timeKey } from '../../lib/time.js';
import { isPublished, publishedWhere, quizResultsVisible, resolvePublication } from '../../lib/visibility.js';
import { assertPermission, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { LANGUAGES, codeRunnerConfigured, judge } from '../../services/codeRunner.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { registerJob } from '../../services/scheduler.js';
import { getTimeZone } from '../../services/settings.js';
import { fileSummary, syncAttachments } from '../../services/storage.js';
import { assertClassWritable, classLabel, loadClassAccess, requireClassManager, requireWritableClassManager } from '../classes/access.js';
import { recordGrade, syncLinkedItem } from '../gradebook/service.js';
import { quizOutcome } from './attemptScore.js';
import { defaultBankFor, saveQuestion } from './banks.js';
import { LEAVING_KINDS, MAX_WARNINGS, VIOLATION_KINDS, durationText, pageOpening, reopenClock, rulesApply, secondsLeftWhenEnded, violationOutcome, violationText } from './rules.js';

export const classQuizzesRouter = Router({ mergeParams: true }); // /classes/:classId/quizzes
classQuizzesRouter.use(requireAuth);
export const quizzesRouter = Router(); // /quizzes
quizzesRouter.use(requireAuth);
export const attemptsRouter = Router(); // /attempts
attemptsRouter.use(requireAuth);

const classParams = idParams('classId');
const quizParams = idParams('quizId');
const attemptParams = idParams('attemptId');
/** Answers and submissions arriving this long after the deadline are still accepted (network latency). */
export const GRACE_MS = 5_000;
const FINISHED = ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'];

const quizInclude = {
  gradeItem: { select: { id: true, categoryId: true, maxPoints: true, category: { select: { name: true, period: { select: { name: true } } } } } },
  module: { select: { id: true, title: true } },
  questions: { orderBy: { position: 'asc' }, include: { question: { include: { choices: true } } } },
  pools: { orderBy: { position: 'asc' }, include: { bank: { select: { id: true, title: true, ownerId: true, deletedAt: true } } } },
  _count: { select: { attempts: true } },
};

const totalPoints = (quiz) => round(quiz.questions.reduce((s, q) => s + q.points, 0) + quiz.pools.reduce((s, p) => s + p.count * p.pointsEach, 0), 2);
const questionCount = (quiz) => quiz.questions.length + quiz.pools.reduce((s, p) => s + p.count, 0);

// ── Serialisation ────────────────────────────────────────────────────────────
function baseView(quiz) {
  return {
    id: quiz.id,
    classId: quiz.classId,
    title: quiz.title,
    kind: quiz.kind,
    availableFrom: quiz.availableFrom,
    availableUntil: quiz.availableUntil,
    timeLimitMinutes: quiz.timeLimitMinutes,
    maxAttempts: quiz.maxAttempts,
    attemptScoring: quiz.attemptScoring,
    passingPercent: quiz.passingPercent,
    // Strict rules while answering, and how many violations only draw a warning.
    strictMode: quiz.strictMode,
    violationWarnings: quiz.violationWarnings,
    questionCount: questionCount(quiz),
    totalPoints: totalPoints(quiz),
    module: quiz.module ?? null,
    gradeCategory: quiz.gradeItem ? { id: quiz.gradeItem.categoryId, name: quiz.gradeItem.category.name, period: quiz.gradeItem.category.period.name } : null,
  };
}

const manageView = (quiz, now) => ({
  ...baseView(quiz),
  instructionsHtml: quiz.instructionsHtml,
  status: quiz.status,
  publishAt: quiz.publishAt,
  publishedAt: quiz.publishedAt,
  isVisible: isPublished(quiz, now),
  shuffleQuestions: quiz.shuffleQuestions,
  shuffleChoices: quiz.shuffleChoices,
  resultVisibility: quiz.resultVisibility,
  answerVisibility: quiz.answerVisibility,
  resultsPublishedAt: quiz.resultsPublishedAt,
  attemptCount: quiz._count.attempts,
  locked: quiz._count.attempts > 0,
  questions: quiz.questions.map((qq) => ({ ...toEditorShape(qq.question), points: qq.points, bankPoints: qq.question.points, removed: Boolean(qq.question.deletedAt) })),
  pools: quiz.pools.map((p) => ({ id: p.id, bankId: p.bankId, bankTitle: p.bank.title, topic: p.topic, difficulty: p.difficulty, type: p.type, count: p.count, pointsEach: p.pointsEach })),
  createdAt: quiz.createdAt,
  updatedAt: quiz.updatedAt,
});

/** Can this student start (or continue) an attempt now? */
export function startability(quiz, attempts, now = new Date()) {
  if (attempts.some((a) => a.status === 'IN_PROGRESS')) return { ok: true, resume: true };
  // An attempt that was ended for a rule violation stands until the teacher decides about it:
  // a student cannot simply walk past it into the next attempt.
  if (attempts.some((a) => a.terminatedAt)) return { ok: false, code: 'TERMINATED', reason: 'Your attempt was ended because a rule of this quiz was broken. Only your teacher can reopen it.' };
  if (quiz.availableFrom && quiz.availableFrom > now) return { ok: false, code: 'NOT_OPEN', reason: 'This quiz is not open yet.' };
  if (quiz.availableUntil && quiz.availableUntil <= now) return { ok: false, code: 'CLOSED', reason: 'This quiz is closed.' };
  if (attempts.length >= quiz.maxAttempts) return { ok: false, code: 'NO_ATTEMPTS_LEFT', reason: quiz.maxAttempts === 1 ? 'You have already taken this quiz.' : 'You have used all your attempts.' };
  return { ok: true, resume: false };
}

/** May correct answers be shown? Not while classmates can still take the quiz. */
const answersReleasable = (quiz, now) => !quiz.availableUntil || quiz.availableUntil <= now;

function studentQuizSummary(quiz, attempts, now) {
  const visible = quizResultsVisible(quiz, now);
  const outcome = quizOutcome(attempts, quiz.attemptScoring);
  const total = totalPoints(quiz);
  const percent = visible && outcome && outcome.fraction !== null ? round(outcome.fraction * 100, 1) : null;
  const running = attempts.find((a) => a.status === 'IN_PROGRESS');
  const ended = attempts.find((a) => a.terminatedAt);
  return {
    ...baseView(quiz),
    attemptsUsed: attempts.length,
    inProgressAttemptId: running?.id ?? null,
    // Ended for a rule violation and waiting for the teacher. Said at once, whatever the rule for showing scores.
    terminated: ended ? { attemptId: ended.id, at: ended.terminatedAt, kind: ended.terminationKind, text: violationText(ended.terminationKind) } : null,
    // Reopened by the teacher. `seconds` is the time the student gets once they continue (null: the
    // clock already runs, or there is none); `deadlineAt` is until when they may continue or finish.
    reopened: running?.reopenedAt ? { at: running.reopenedAt, seconds: running.resumeSeconds, deadlineAt: running.deadlineAt } : null,
    start: startability(quiz, attempts, now),
    submitted: attempts.some((a) => FINISHED.includes(a.status)),
    resultsVisible: visible,
    awaitingGrading: Boolean(outcome?.pending),
    score: percent === null ? null : round(outcome.fraction * total, 2),
    percent,
    passed: percent === null || quiz.passingPercent === null ? null : percent >= quiz.passingPercent,
    myStatus: running ? 'IN_PROGRESS' : ended ? 'TERMINATED' : attempts.some((a) => FINISHED.includes(a.status)) ? 'SUBMITTED' : quiz.availableUntil && quiz.availableUntil <= now ? 'MISSING' : 'NOT_STARTED',
  };
}

// ── Lists ────────────────────────────────────────────────────────────────────
classQuizzesRouter.get('/', validate({ params: classParams }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  const now = new Date();
  const quizzes = await prisma.quiz.findMany({
    where: { classId: access.cls.id, deletedAt: null, ...(access.canManage ? {} : publishedWhere(now)) },
    include: quizInclude,
    orderBy: [{ availableUntil: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  if (!access.canManage) {
    const mine = await prisma.quizAttempt.findMany({ where: { studentId: req.user.id, quizId: { in: quizzes.map((q) => q.id) } } });
    ok(res, quizzes.map((quiz) => studentQuizSummary(quiz, mine.filter((a) => a.quizId === quiz.id), now)));
    return;
  }
  const enrolled = await enrolledStudentIds(access.cls.id);
  const attempts = await prisma.quizAttempt.findMany({
    where: { quizId: { in: quizzes.map((q) => q.id) }, studentId: { in: enrolled } },
    select: { quizId: true, studentId: true, status: true, needsManualGrading: true, terminatedAt: true },
  });
  ok(res, quizzes.map((quiz) => {
    const mine = attempts.filter((a) => a.quizId === quiz.id);
    const takers = new Set(mine.filter((a) => FINISHED.includes(a.status)).map((a) => a.studentId));
    return {
      ...baseView(quiz),
      status: quiz.status, publishAt: quiz.publishAt, isVisible: isPublished(quiz, now), resultVisibility: quiz.resultVisibility, resultsPublishedAt: quiz.resultsPublishedAt,
      stats: {
        enrolled: enrolled.length,
        submitted: takers.size,
        inProgress: new Set(mine.filter((a) => a.status === 'IN_PROGRESS').map((a) => a.studentId)).size,
        toGrade: mine.filter((a) => FINISHED.includes(a.status) && a.needsManualGrading).length,
        // Attempts ended for a rule violation, waiting for the teacher to reopen, count or leave them.
        violations: mine.filter((a) => a.terminatedAt).length,
        missing: quiz.availableUntil && quiz.availableUntil <= now && isPublished(quiz, now) ? enrolled.filter((id) => !mine.some((a) => a.studentId === id)).length : 0,
      },
    };
  }));
});

// ── Create / update ──────────────────────────────────────────────────────────
const body = z.object({
  title: zTitle,
  instructionsHtml: zHtml.default(''),
  kind: z.enum(['QUIZ', 'EXAM', 'PRACTICE']).default('QUIZ'),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']).default('DRAFT'),
  publishAt: zOptionalDateTime,
  availableFrom: zOptionalDateTime,
  availableUntil: zOptionalDateTime,
  timeLimitMinutes: z.number().int().min(1).max(600).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(50).default(1),
  attemptScoring: z.enum(['HIGHEST', 'LATEST', 'AVERAGE']).default('HIGHEST'),
  passingPercent: z.number().min(0).max(100).nullable().optional(),
  shuffleQuestions: z.boolean().default(false),
  shuffleChoices: z.boolean().default(false),
  /** Strict rules while answering. Left out when a quiz is created: on, except for practice. */
  strictMode: z.boolean().optional(),
  /** Violations that only draw a warning before the attempt is ended. */
  violationWarnings: z.number().int().min(0).max(MAX_WARNINGS).default(0),
  resultVisibility: z.enum(['IMMEDIATE', 'AFTER_CLOSE', 'MANUAL', 'NEVER']).default('MANUAL'),
  answerVisibility: z.enum(['SCORE_ONLY', 'RESPONSES', 'CORRECT_ANSWERS']).default('SCORE_ONLY'),
  moduleId: zId.nullable().optional(),
  /** Grade category this quiz counts under; null = not graded (e.g. practice). */
  categoryId: zId.nullable().optional(),
});

function assertSchedule(q) {
  const errors = {};
  if (q.availableFrom && q.availableUntil && q.availableUntil <= q.availableFrom) errors.availableUntil = 'The closing time must be after the opening time.';
  if (q.resultVisibility === 'AFTER_CLOSE' && !q.availableUntil) errors.resultVisibility = 'Set a closing time, or choose another way to release results.';
  if (Object.keys(errors).length > 0) throw fieldErrors(errors);
}

async function assertModule(classId, moduleId) {
  if (!moduleId) return;
  const mod = await prisma.learningModule.findFirst({ where: { id: moduleId, classId, deletedAt: null }, select: { id: true } });
  if (!mod) throw fieldErrors({ moduleId: 'Choose a module from this class.' });
}

/** A quiz must be takeable before students can see it. */
async function assertPublishable(quiz) {
  if (questionCount(quiz) === 0) throw new AppError(422, 'QUIZ_EMPTY', 'Add at least one question before publishing.');
  if (quiz.questions.some((qq) => qq.question.deletedAt)) throw new AppError(422, 'QUIZ_INVALID', 'A question in this quiz was deleted from its bank. Remove it from the quiz.');
  const used = quiz.questions.map((qq) => qq.questionId);
  for (const pool of quiz.pools) {
    const available = await prisma.question.count({
      where: { bankId: pool.bankId, deletedAt: null, id: { notIn: used }, ...(pool.topic ? { topic: pool.topic } : {}), ...(pool.difficulty ? { difficulty: pool.difficulty } : {}), ...(pool.type ? { type: pool.type } : {}) },
    });
    if (pool.bank.deletedAt || available < pool.count) {
      throw new AppError(422, 'POOL_TOO_SMALL', `The random pool from "${pool.bank.title}" asks for ${pool.count} question(s) but only ${available} match.`);
    }
  }
}

const fullQuiz = (id, db = prisma) => db.quiz.findUnique({ where: { id }, include: quizInclude });

async function announce(quiz, cls) {
  await notify(await enrolledStudentIds(cls.id), {
    type: 'quiz.published', title: `New ${quiz.kind.toLowerCase()} in ${classLabel(cls)}: ${quiz.title}`, link: `/classes/${cls.id}/quizzes/${quiz.id}`, classId: cls.id,
  });
}

classQuizzesRouter.post('/', validate({ params: classParams, body }), async (req, res) => {
  const { cls } = await requireWritableClassManager(req.user, req.valid.params.classId);
  const b = req.valid.body;
  // A new quiz has no questions yet, so it always starts as a draft.
  if (b.status !== 'DRAFT') throw new AppError(422, 'QUIZ_EMPTY', 'Add at least one question before publishing.');
  assertSchedule(b);
  await assertModule(cls.id, b.moduleId);
  const title = plainText(b.title, 200);
  const quiz = await prisma.$transaction(async (tx) => {
    const row = await tx.quiz.create({
      data: {
        classId: cls.id, moduleId: b.moduleId ?? null, title, instructionsHtml: sanitizeRichText(b.instructionsHtml), kind: b.kind, status: 'DRAFT',
        availableFrom: b.availableFrom ?? null, availableUntil: b.availableUntil ?? null, timeLimitMinutes: b.timeLimitMinutes ?? null, maxAttempts: b.maxAttempts,
        attemptScoring: b.attemptScoring, passingPercent: b.passingPercent ?? null, shuffleQuestions: b.shuffleQuestions, shuffleChoices: b.shuffleChoices,
        // Practice is for trying things out: no strict rules unless the teacher asks for them.
        strictMode: b.strictMode ?? b.kind !== 'PRACTICE', violationWarnings: b.violationWarnings,
        resultVisibility: b.resultVisibility, answerVisibility: b.answerVisibility, createdById: req.user.id,
      },
    });
    if (b.categoryId) {
      // The column is created now with a placeholder total and follows the questions from here on.
      const item = await syncLinkedItem(tx, { classId: cls.id, categoryId: b.categoryId, title, maxPoints: 1, dueAt: b.availableUntil, quizId: row.id });
      if (item?.error) throw fieldErrors({ categoryId: item.error });
    }
    return row;
  });
  created(res, manageView(await fullQuiz(quiz.id), new Date()));
});

async function loadQuiz(quizId) {
  const quiz = await fullQuiz(quizId);
  if (!quiz || quiz.deletedAt) throw notFound('Quiz');
  return quiz;
}

async function loadManaged(req, { writable = true } = {}) {
  const quiz = await loadQuiz(req.valid.params.quizId);
  const access = await requireClassManager(req.user, quiz.classId);
  if (writable) assertClassWritable(access.cls);
  return { quiz, cls: access.cls };
}

/** Keep the gradebook column's title, total and due date in step with the quiz. */
async function syncColumn(tx, quiz, categoryId) {
  const fresh = await fullQuiz(quiz.id, tx);
  const target = categoryId === undefined ? fresh.gradeItem?.categoryId ?? null : categoryId;
  const item = await syncLinkedItem(tx, { classId: fresh.classId, categoryId: target, title: fresh.title, maxPoints: Math.max(totalPoints(fresh), 0.01), dueAt: fresh.availableUntil, quizId: fresh.id });
  if (item?.error) throw fieldErrors({ categoryId: item.error });
  return item;
}

quizzesRouter.get('/:quizId', validate({ params: quizParams }), async (req, res) => {
  const quiz = await loadQuiz(req.valid.params.quizId);
  const access = await loadClassAccess(req.user, quiz.classId);
  const now = new Date();
  if (access.canManage) {
    ok(res, manageView(quiz, now));
    return;
  }
  if (!isPublished(quiz, now)) throw notFound('Quiz');
  const attempts = await prisma.quizAttempt.findMany({ where: { quizId: quiz.id, studentId: req.user.id }, orderBy: { attemptNumber: 'asc' } });
  const visible = quizResultsVisible(quiz, now);
  ok(res, {
    ...studentQuizSummary(quiz, attempts, now),
    instructionsHtml: quiz.instructionsHtml,
    resultVisibility: quiz.resultVisibility,
    attempts: attempts.map((a) => ({
      id: a.id, attemptNumber: a.attemptNumber, status: a.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : a.terminatedAt ? 'TERMINATED' : 'SUBMITTED', startedAt: a.startedAt, submittedAt: a.submittedAt, deadlineAt: a.deadlineAt,
      awaitingGrading: FINISHED.includes(a.status) && a.needsManualGrading,
      score: visible && FINISHED.includes(a.status) && !a.needsManualGrading && !a.terminatedAt ? a.totalScore : null,
      maxScore: a.maxScore,
      terminated: a.terminatedAt ? { at: a.terminatedAt, kind: a.terminationKind, text: violationText(a.terminationKind) } : null,
      reopened: Boolean(a.reopenedAt),
    })),
    serverTime: now,
  });
});

quizzesRouter.patch('/:quizId', validate({ params: quizParams, body: patchOf(body) }), async (req, res) => {
  const { quiz, cls } = await loadManaged(req);
  const b = req.valid.body;
  const next = { ...quiz, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  assertSchedule(next);
  if (b.moduleId) await assertModule(cls.id, b.moduleId);
  const publication = resolvePublication({ status: b.status, publishAt: b.publishAt ?? quiz.publishAt }, quiz);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  if (publication.status === 'PUBLISHED' || publication.status === 'SCHEDULED') await assertPublishable(quiz);
  if (quiz._count.attempts > 0 && (b.shuffleQuestions !== undefined || b.shuffleChoices !== undefined) && (next.shuffleQuestions !== quiz.shuffleQuestions || next.shuffleChoices !== quiz.shuffleChoices)) {
    throw conflict('Students have already started this quiz, so its shuffling cannot change.', 'QUIZ_HAS_ATTEMPTS');
  }
  const wasVisible = isPublished(quiz);
  const closeChanged = b.availableUntil !== undefined && (b.availableUntil?.getTime() ?? null) !== (quiz.availableUntil?.getTime() ?? null);
  await prisma.$transaction(async (tx) => {
    await tx.quiz.update({
      where: { id: quiz.id },
      data: {
        ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
        ...(b.instructionsHtml !== undefined ? { instructionsHtml: sanitizeRichText(b.instructionsHtml) } : {}),
        ...Object.fromEntries(
          ['kind', 'availableFrom', 'availableUntil', 'timeLimitMinutes', 'maxAttempts', 'attemptScoring', 'passingPercent', 'shuffleQuestions', 'shuffleChoices', 'strictMode', 'violationWarnings', 'resultVisibility', 'answerVisibility', 'moduleId']
            .filter((k) => b[k] !== undefined)
            .map((k) => [k, b[k]]),
        ),
        ...(closeChanged ? { reminderSentAt: null } : {}),
        ...publication,
      },
    });
    await syncColumn(tx, quiz, b.categoryId);
    if (b.attemptScoring !== undefined && b.attemptScoring !== quiz.attemptScoring && quiz._count.attempts > 0) {
      // A different rule for "which attempt counts" changes existing grades.
      const students = await tx.quizAttempt.findMany({ where: { quizId: quiz.id }, distinct: ['studentId'], select: { studentId: true } });
      const fresh = await tx.quiz.findUnique({ where: { id: quiz.id } });
      for (const s of students) await syncQuizGrade(tx, fresh, s.studentId, req.user.id);
      await audit(req, { action: 'quiz.scoring.change', entityType: 'Quiz', entityId: quiz.id, classId: cls.id, summary: `Changed which attempt counts for "${quiz.title}"`, before: { attemptScoring: quiz.attemptScoring }, after: { attemptScoring: b.attemptScoring } }, tx);
    }
    const rulesBefore = { strictMode: quiz.strictMode, violationWarnings: quiz.violationWarnings };
    const rulesAfter = { strictMode: b.strictMode ?? quiz.strictMode, violationWarnings: b.violationWarnings ?? quiz.violationWarnings };
    if (quiz._count.attempts > 0 && (rulesAfter.strictMode !== rulesBefore.strictMode || rulesAfter.violationWarnings !== rulesBefore.violationWarnings)) {
      // The rules changed while students had already started: later questions about "why was I
      // stopped and my classmate was not" are answered by this entry.
      await audit(req, { action: 'quiz.rules.change', entityType: 'Quiz', entityId: quiz.id, classId: cls.id, summary: `Changed the strict rules of "${quiz.title}" after students had started`, before: rulesBefore, after: rulesAfter }, tx);
    }
  });
  const full = await fullQuiz(quiz.id);
  if (!wasVisible && full.status === 'PUBLISHED') await announce(full, cls);
  ok(res, manageView(full, new Date()));
});

quizzesRouter.delete('/:quizId', validate({ params: quizParams }), async (req, res) => {
  const { quiz, cls } = await loadManaged(req);
  await prisma.$transaction(async (tx) => {
    await syncLinkedItem(tx, { classId: cls.id, categoryId: null, quizId: quiz.id });
    await tx.quiz.update({ where: { id: quiz.id }, data: { deletedAt: new Date() } });
    await audit(req, { action: 'quiz.delete', entityType: 'Quiz', entityId: quiz.id, classId: cls.id, summary: `Deleted ${quiz.kind.toLowerCase()} "${quiz.title}" (${quiz._count.attempts} attempt(s))` }, tx);
  });
  noContent(res);
});

quizzesRouter.post('/:quizId/copy', validate({ params: quizParams, body: z.object({ targetClassId: zId.optional() }) }), async (req, res) => {
  const { quiz } = await loadManaged(req, { writable: false });
  const target = await requireWritableClassManager(req.user, req.valid.body.targetClassId ?? quiz.classId);
  const same = target.cls.id === quiz.classId;
  const copy = await prisma.quiz.create({
    data: {
      classId: target.cls.id, title: same ? `${quiz.title} (copy)`.slice(0, 200) : quiz.title, instructionsHtml: quiz.instructionsHtml, kind: quiz.kind, status: 'DRAFT',
      timeLimitMinutes: quiz.timeLimitMinutes, maxAttempts: quiz.maxAttempts, attemptScoring: quiz.attemptScoring, passingPercent: quiz.passingPercent,
      shuffleQuestions: quiz.shuffleQuestions, shuffleChoices: quiz.shuffleChoices, strictMode: quiz.strictMode, violationWarnings: quiz.violationWarnings,
      resultVisibility: quiz.resultVisibility === 'AFTER_CLOSE' ? 'MANUAL' : quiz.resultVisibility,
      answerVisibility: quiz.answerVisibility, moduleId: same ? quiz.moduleId : null, createdById: req.user.id,
      questions: { create: quiz.questions.filter((qq) => !qq.question.deletedAt).map((qq) => ({ questionId: qq.questionId, points: qq.points, position: qq.position })) },
      pools: { create: quiz.pools.filter((p) => !p.bank.deletedAt).map((p) => ({ bankId: p.bankId, topic: p.topic, difficulty: p.difficulty, type: p.type, count: p.count, pointsEach: p.pointsEach, position: p.position })) },
    },
  });
  created(res, manageView(await fullQuiz(copy.id), new Date()));
});

// ── Questions of a quiz ──────────────────────────────────────────────────────
function assertEditable(quiz) {
  if (quiz._count.attempts > 0) {
    throw conflict('Students have already started this quiz, so its questions cannot change. Duplicate the quiz to make a new version.', 'QUIZ_HAS_ATTEMPTS');
  }
}

const itemsBody = z.object({ items: z.array(z.object({ questionId: zId, points: z.number().positive().max(1000) })).max(300) });

quizzesRouter.put('/:quizId/questions', validate({ params: quizParams, body: itemsBody }), async (req, res) => {
  const { quiz } = await loadManaged(req);
  assertEditable(quiz);
  const { items } = req.valid.body;
  const ids = items.map((i) => i.questionId);
  if (new Set(ids).size !== ids.length) throw fieldErrors({ items: 'A question appears twice.' });
  // Only questions from the teacher's own banks.
  const owned = await prisma.question.count({ where: { id: { in: ids }, deletedAt: null, bank: { ownerId: req.user.id, deletedAt: null } } });
  if (owned !== ids.length) throw fieldErrors({ items: 'Choose questions from your own question banks.' });
  if (quiz.status !== 'DRAFT' && items.length + quiz.pools.reduce((s, p) => s + p.count, 0) === 0) throw new AppError(422, 'QUIZ_EMPTY', 'A published quiz needs at least one question. Unpublish it first.');
  await prisma.$transaction(async (tx) => {
    await tx.quizQuestion.deleteMany({ where: { quizId: quiz.id } });
    if (items.length > 0) await tx.quizQuestion.createMany({ data: items.map((i, position) => ({ quizId: quiz.id, questionId: i.questionId, points: round(i.points, 2), position })) });
    await syncColumn(tx, quiz);
  });
  ok(res, manageView(await fullQuiz(quiz.id), new Date()));
});

/** Write a new question straight into the quiz (it is also kept in a question bank for reuse). */
quizzesRouter.post('/:quizId/questions', validate({ params: quizParams, body: z.object({ bankId: zId.optional(), question: z.object({ type: z.string() }).passthrough() }) }), async (req, res) => {
  const { quiz, cls } = await loadManaged(req);
  assertEditable(quiz);
  await prisma.$transaction(async (tx) => {
    let bankId = req.valid.body.bankId;
    if (bankId) {
      const bank = await tx.questionBank.findFirst({ where: { id: bankId, ownerId: req.user.id, deletedAt: null }, select: { id: true } });
      if (!bank) throw fieldErrors({ bankId: 'Choose one of your question banks.' });
    } else {
      bankId = (await defaultBankFor(tx, req.user, cls)).id;
    }
    const last = await tx.question.aggregate({ where: { bankId, deletedAt: null }, _max: { position: true } });
    const question = await saveQuestion(tx, req.user, bankId, req.valid.body.question, { position: (last._max.position ?? -1) + 1 });
    const lastInQuiz = await tx.quizQuestion.aggregate({ where: { quizId: quiz.id }, _max: { position: true } });
    await tx.quizQuestion.create({ data: { quizId: quiz.id, questionId: question.id, points: question.points, position: (lastInQuiz._max.position ?? -1) + 1 } });
    await syncColumn(tx, quiz);
  });
  created(res, manageView(await fullQuiz(quiz.id), new Date()));
});

const poolsBody = z.object({
  pools: z.array(z.object({
    bankId: zId,
    topic: z.string().trim().max(120).nullable().optional(),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).nullable().optional(),
    type: z.string().max(40).nullable().optional(),
    count: z.number().int().min(1).max(200),
    pointsEach: z.number().positive().max(1000),
  })).max(20),
});

quizzesRouter.put('/:quizId/pools', validate({ params: quizParams, body: poolsBody }), async (req, res) => {
  const { quiz } = await loadManaged(req);
  assertEditable(quiz);
  const { pools } = req.valid.body;
  const banks = await prisma.questionBank.findMany({ where: { id: { in: pools.map((p) => p.bankId) }, ownerId: req.user.id, deletedAt: null }, select: { id: true, title: true } });
  const used = quiz.questions.map((qq) => qq.questionId);
  for (const pool of pools) {
    const bank = banks.find((x) => x.id === pool.bankId);
    if (!bank) throw fieldErrors({ pools: 'Choose one of your question banks.' });
    const available = await prisma.question.count({
      where: { bankId: pool.bankId, deletedAt: null, id: { notIn: used }, ...(pool.topic ? { topic: pool.topic } : {}), ...(pool.difficulty ? { difficulty: pool.difficulty } : {}), ...(pool.type ? { type: pool.type } : {}) },
    });
    if (available < pool.count) throw fieldErrors({ pools: `"${bank.title}" has only ${available} matching question(s), but ${pool.count} were requested.` });
  }
  await prisma.$transaction(async (tx) => {
    await tx.quizQuestionPool.deleteMany({ where: { quizId: quiz.id } });
    if (pools.length > 0) {
      await tx.quizQuestionPool.createMany({
        data: pools.map((p, position) => ({ quizId: quiz.id, bankId: p.bankId, topic: p.topic || null, difficulty: p.difficulty ?? null, type: p.type || null, count: p.count, pointsEach: round(p.pointsEach, 2), position })),
      });
    }
    await syncColumn(tx, quiz);
  });
  ok(res, manageView(await fullQuiz(quiz.id), new Date()));
});

// ── Scoring and the gradebook ────────────────────────────────────────────────

/** Write the student's quiz result to the gradebook column, if the quiz has one. */
export async function syncQuizGrade(tx, quiz, studentId, changedById = null, { tolerateLock = false } = {}) {
  const item = await tx.gradeItem.findUnique({ where: { quizId: quiz.id } });
  if (!item) return;
  const attempts = await tx.quizAttempt.findMany({ where: { quizId: quiz.id, studentId } });
  const outcome = quizOutcome(attempts, quiz.attemptScoring);
  const graded = outcome && outcome.fraction !== null;
  const existing = await tx.gradeEntry.findUnique({ where: { gradeItemId_studentId: { gradeItemId: item.id, studentId } } });
  if (!graded && !existing) return;
  if (existing?.status === 'EXEMPT') return;
  try {
    await recordGrade(tx, { gradeItemId: item.id, studentId, score: graded ? round(outcome.fraction * item.maxPoints, 2) : null, status: graded ? 'GRADED' : 'UNGRADED', source: 'AUTO_SYNC', changedById });
  } catch (err) {
    // A student handing in a quiz is never turned away because the teacher locked the gradebook;
    // the score is brought over when the period is unlocked.
    if (tolerateLock && err instanceof AppError && ['PERIOD_LOCKED', 'GRADES_FINALIZED'].includes(err.code)) return;
    throw err;
  }
}

/** Mark every answer of an attempt that can be marked automatically. Returns the totals. */
async function scoreAnswers(tx, attempt) {
  const code = await tx.programmingSubmission.groupBy({ by: ['studentAnswerId'], where: { studentAnswerId: { in: attempt.answers.map((a) => a.id) }, status: 'COMPLETED' }, _max: { scorePercent: true } });
  const codeScore = new Map(code.map((c) => [c.studentAnswerId, c._max.scorePercent]));
  const scored = [];
  for (const answer of attempt.answers) {
    const result = scoreAnswer(answer.snapshot, answer.response, answer.points, { codeScorePercent: codeScore.get(answer.id) ?? null });
    await tx.studentAnswer.update({ where: { id: answer.id }, data: { autoScore: result.autoScore, isCorrect: result.isCorrect, needsManual: result.needsManual, score: result.autoScore } });
    scored.push({ ...result, manualScore: null });
  }
  return attemptTotals(scored);
}

/**
 * Close an attempt: score everything that can be scored automatically and total it.
 * Safe to call twice — an attempt that is no longer in progress is returned untouched.
 */
export async function finalizeAttempt(tx, attemptId, { auto = false, now = new Date() } = {}) {
  await lockKey(tx, `attempt:${attemptId}`);
  const attempt = await tx.quizAttempt.findUnique({ where: { id: attemptId }, include: { answers: true, quiz: true } });
  if (!attempt || attempt.status !== 'IN_PROGRESS') return attempt;
  const totals = await scoreAnswers(tx, attempt);
  // Time is counted up to the deadline, never beyond it.
  const submittedAt = attempt.deadlineAt && now > attempt.deadlineAt ? attempt.deadlineAt : now;
  const updated = await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: { status: auto ? 'AUTO_SUBMITTED' : 'SUBMITTED', submittedAt, autoScore: totals.autoScore, manualScore: 0, totalScore: totals.totalScore, needsManualGrading: totals.needsManualGrading },
  });
  await tx.quizAttemptEvent.create({ data: { attemptId: attempt.id, type: auto ? 'AUTO_SUBMITTED' : 'SUBMITTED' } });
  await syncQuizGrade(tx, attempt.quiz, attempt.studentId, null, { tolerateLock: true });
  return { ...updated, quiz: attempt.quiz };
}

/**
 * End an attempt because a rule of the quiz was broken. It is closed and scores 0. The answers
 * stay exactly as they were, unmarked: the teacher may still reopen the attempt (the student
 * continues from them) or count them (they are then marked like any handed-in attempt).
 * The caller holds the attempt's lock and has checked that it is in progress.
 */
async function terminateAttempt(tx, attempt, quiz, { kind, at, count }) {
  const updated = await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'AUTO_SUBMITTED', submittedAt: attempt.deadlineAt && at > attempt.deadlineAt ? attempt.deadlineAt : at, terminatedAt: at, terminationKind: kind, violationCount: count,
      autoScore: 0, manualScore: 0, totalScore: 0, needsManualGrading: false, resumeSeconds: null,
    },
  });
  await syncQuizGrade(tx, quiz, attempt.studentId, null, { tolerateLock: true });
  return updated;
}

// After the judge failed, do not keep every closing attempt waiting for it.
const JUDGE_RETRY_AFTER_MS = 60_000;
let judgeUnreachableUntil = 0;

// A judge that says "busy" has too many programs at once, which is what the minute a quiz closes
// looks like. That passes within seconds, so a closing attempt waits a little and asks again
// before it leaves the program to the teacher.
const BUSY_WAITS_MS = env.isTest ? [5, 5] : [2500, 5000];
async function judgePatiently(problem, testCases, program) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await judge(problem, testCases, program);
    } catch (err) {
      if (err.code !== 'CODE_RUNNER_BUSY' || attempt >= BUSY_WAITS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAITS_MS[attempt]));
    }
  }
}

/**
 * A student may hand in a quiz without pressing "Submit for checking" on a program. Before an
 * attempt is closed, a saved program that was never checked is sent to the judge, so that it is
 * scored like any other checked program. When no judge is set up or it cannot be reached, the
 * answer is simply left for the teacher to mark — handing in never fails because of the judge.
 *
 * Runs outside the closing transaction: the judge is a slow external service.
 * @returns {Promise<number>} how many programs were checked
 */
export async function checkUncheckedPrograms(attemptId, now = Date.now(), { terminated = false } = {}) {
  if (!codeRunnerConfigured() || now < judgeUnreachableUntil) return 0;
  const answers = await prisma.studentAnswer.findMany({
    // `terminated`: the answers of an attempt that was ended for a violation are about to be counted.
    where: { attemptId, attempt: terminated ? { terminatedAt: { not: null } } : { status: 'IN_PROGRESS' }, snapshot: { path: ['type'], equals: 'PROGRAMMING' } },
    select: { id: true, snapshot: true, response: true, attempt: { select: { studentId: true } } },
  });
  let checked = 0;
  for (const answer of answers) {
    const { language, code } = answer.response ?? {};
    const problemId = answer.snapshot?.programmingProblemId;
    if (!problemId || typeof code !== 'string' || !code.trim() || !Object.hasOwn(LANGUAGES, language)) continue;
    try {
      const last = await prisma.programmingSubmission.findFirst({ where: { studentAnswerId: answer.id }, orderBy: { createdAt: 'desc' }, select: { language: true, code: true } });
      if (last && last.code === code && last.language === language) continue; // exactly this program was checked already
      const problem = await prisma.programmingProblem.findUnique({ where: { id: problemId }, include: { testCases: { orderBy: { position: 'asc' } } } });
      if (!problem || !problem.allowedLanguages.includes(language)) continue;
      const result = await judgePatiently(problem, problem.testCases, { language, code });
      await prisma.programmingSubmission.create({
        data: {
          problemId: problem.id, studentId: answer.attempt.studentId, studentAnswerId: answer.id, language, code,
          status: result.status, results: result.results, passedCount: result.passedCount, totalCount: result.totalCount, scorePercent: result.scorePercent, errorMessage: result.errorMessage,
        },
      });
      checked += 1;
    } catch (err) {
      // Still busy after waiting: the next closing attempt may try again soon. Anything else keeps
      // the judge out of the way for a minute.
      judgeUnreachableUntil = Date.now() + (err.code === 'CODE_RUNNER_BUSY' ? 5000 : JUDGE_RETRY_AFTER_MS);
      logger.warn({ err, attemptId, answerId: answer.id }, 'the code judge could not check a program while a quiz attempt was closing; it is left for manual grading');
      break;
    }
  }
  return checked;
}

/** For tests: forget that the judge was unreachable. */
export function resetJudgeBackoff() {
  judgeUnreachableUntil = 0;
}

/** Close an attempt from outside a transaction: check pending programs, then score and total. */
async function closeAttempt(attemptId, options) {
  await checkUncheckedPrograms(attemptId);
  return prisma.$transaction((tx) => finalizeAttempt(tx, attemptId, options));
}

const isOverdue = (attempt, now) => Boolean(attempt.deadlineAt) && now.getTime() > attempt.deadlineAt.getTime() + GRACE_MS;

/** Submit attempts whose time ran out while the student was away. Run by the scheduler. */
export async function autoSubmitOverdue(now = new Date()) {
  const due = await prisma.quizAttempt.findMany({ where: { status: 'IN_PROGRESS', deadlineAt: { lt: new Date(now.getTime() - GRACE_MS) } }, select: { id: true }, take: 200 });
  let count = 0;
  for (const { id } of due) {
    try {
      await closeAttempt(id, { auto: true, now });
      count += 1;
    } catch (err) {
      logger.error({ err, attemptId: id }, 'failed to auto-submit a quiz attempt');
    }
  }
  return count;
}

registerJob('quiz.autoSubmit', 30_000, async () => {
  const count = await autoSubmitOverdue();
  if (count > 0) logger.info(`auto-submitted ${count} quiz attempt(s) whose time ran out`);
});

// ── Taking a quiz ────────────────────────────────────────────────────────────
async function pickQuestions(tx, quiz) {
  const fixed = await tx.quizQuestion.findMany({ where: { quizId: quiz.id, question: { deletedAt: null } }, orderBy: { position: 'asc' }, include: { question: { include: { choices: true } } } });
  let list = fixed.map((qq) => ({ question: qq.question, points: qq.points }));
  const used = new Set(list.map((x) => x.question.id));
  const pools = await tx.quizQuestionPool.findMany({ where: { quizId: quiz.id }, orderBy: { position: 'asc' } });
  for (const pool of pools) {
    const candidates = await tx.question.findMany({
      where: { bankId: pool.bankId, deletedAt: null, id: { notIn: [...used] }, ...(pool.topic ? { topic: pool.topic } : {}), ...(pool.difficulty ? { difficulty: pool.difficulty } : {}), ...(pool.type ? { type: pool.type } : {}) },
      include: { choices: true },
    });
    for (const question of shuffle(candidates).slice(0, pool.count)) {
      used.add(question.id);
      list.push({ question, points: pool.pointsEach });
    }
  }
  if (quiz.shuffleQuestions) list = shuffle(list);
  return list;
}

/**
 * Start an attempt, or continue the one in progress.
 *
 * A quiz with strict rules is only started with `acceptRules: true`: the web app sends it after
 * showing the rules. A copy of the web app from before the rules existed does not send it and is
 * told to reload — nobody starts under rules they were never shown.
 */
quizzesRouter.post('/:quizId/attempts', requireRole('STUDENT'), validate({ params: quizParams, body: z.object({ acceptRules: z.boolean().optional() }) }), async (req, res) => {
  const quiz = await loadQuiz(req.valid.params.quizId);
  const access = await loadClassAccess(req.user, quiz.classId);
  if (!access.isStudent) throw forbidden('Only students enrolled in this class can do that.');
  if (!isPublished(quiz)) throw notFound('Quiz');
  assertClassWritable(access.cls);

  // An earlier attempt whose time ran out is closed inside the transaction below; its programs are checked first.
  const stale = await prisma.quizAttempt.findFirst({ where: { quizId: quiz.id, studentId: req.user.id, status: 'IN_PROGRESS' }, select: { id: true, deadlineAt: true } });
  if (stale && isOverdue(stale, new Date())) await checkUncheckedPrograms(stale.id);

  const result = await prisma.$transaction(async (tx) => {
    // One attempt at a time per student: a double click cannot start two.
    await lockKey(tx, `quiz-start:${quiz.id}:${req.user.id}`);
    const now = new Date();
    let attempts = await tx.quizAttempt.findMany({ where: { quizId: quiz.id, studentId: req.user.id } });
    const running = attempts.find((a) => a.status === 'IN_PROGRESS');
    if (running) {
      if (!isOverdue(running, now)) {
        if (running.resumeSeconds !== null) {
          // Reopened by the teacher: the student's time starts now, with this press of
          // "Continue" — not when the teacher reopened it, which may have been hours ago.
          await tx.quizAttempt.update({ where: { id: running.id }, data: { deadlineAt: new Date(now.getTime() + running.resumeSeconds * 1000), resumeSeconds: null } });
          await tx.quizAttemptEvent.create({ data: { attemptId: running.id, type: 'CONTINUED', meta: { seconds: running.resumeSeconds } } });
        } else {
          await tx.quizAttemptEvent.create({ data: { attemptId: running.id, type: 'RESUMED' } });
        }
        return { attempt: running, resumed: true };
      }
      await finalizeAttempt(tx, running.id, { auto: true, now });
      attempts = await tx.quizAttempt.findMany({ where: { quizId: quiz.id, studentId: req.user.id } });
    }
    const can = startability(quiz, attempts, now);
    if (!can.ok) throw new AppError(409, can.code, can.reason);
    if (quiz.strictMode && req.valid.body.acceptRules !== true) {
      throw new AppError(409, 'RULES_NOT_ACCEPTED', 'This quiz has strict rules that you need to read first. Reload the page, read the rules, then start again.');
    }
    const picked = await pickQuestions(tx, quiz);
    if (picked.length === 0) throw new AppError(409, 'QUIZ_EMPTY', 'This quiz has no questions yet. Please tell your teacher.');
    const limit = quiz.timeLimitMinutes ? new Date(now.getTime() + quiz.timeLimitMinutes * 60_000) : null;
    // The clock stops at the time limit or when the quiz closes, whichever comes first.
    const deadlineAt = limit && quiz.availableUntil ? new Date(Math.min(limit.getTime(), quiz.availableUntil.getTime())) : limit ?? quiz.availableUntil ?? null;
    const attempt = await tx.quizAttempt.create({
      data: {
        quizId: quiz.id, studentId: req.user.id, attemptNumber: Math.max(0, ...attempts.map((a) => a.attemptNumber)) + 1, startedAt: now, deadlineAt,
        rulesAcceptedAt: quiz.strictMode ? now : null,
        maxScore: round(picked.reduce((s, p) => s + p.points, 0), 2),
        answers: { create: picked.map((p, position) => ({ questionId: p.question.id, position, points: p.points, snapshot: buildSnapshot(p.question, { shuffleChoices: quiz.shuffleChoices }) })) },
        events: { create: { type: 'STARTED', ...(quiz.strictMode ? { meta: { rules: { warnings: quiz.violationWarnings } } } : {}) } },
      },
    });
    return { attempt, resumed: false };
  });
  (result.resumed ? ok : created)(res, { attemptId: result.attempt.id, resumed: result.resumed });
});

async function answerFiles(answerIds) {
  if (answerIds.length === 0) return new Map();
  const files = await prisma.file.findMany({ where: { studentAnswerId: { in: answerIds }, deletedAt: null } });
  const map = new Map();
  for (const f of files) map.set(f.studentAnswerId, [...(map.get(f.studentAnswerId) ?? []), fileSummary(f)]);
  return map;
}

/** One answer as shown in a review. `reveal` adds the key and the explanation. */
function reviewAnswer(answer, files, { reveal, scores }) {
  return {
    answerId: answer.id,
    position: answer.position,
    points: answer.points,
    question: publicQuestion(answer.snapshot),
    response: answer.response,
    files: files.get(answer.id) ?? [],
    flagged: answer.flagged,
    answered: isAnswered(answer.response),
    ...(scores ? { score: answer.score, autoScore: answer.autoScore, manualScore: answer.manualScore, isCorrect: answer.isCorrect, needsManual: answer.needsManual && answer.manualScore === null, feedback: answer.feedback } : {}),
    ...(reveal ? { correct: correctAnswer(answer.snapshot), explanation: answer.snapshot.explanation ?? null } : {}),
  };
}

async function studentAttemptView(attempt, now) {
  const quiz = attempt.quiz;
  const answers = [...attempt.answers].sort((a, b) => a.position - b.position);
  const files = await answerFiles(answers.map((a) => a.id));
  const head = {
    id: attempt.id, quizId: quiz.id, classId: quiz.classId, attemptNumber: attempt.attemptNumber, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt, submittedAt: attempt.submittedAt,
    quiz: { title: quiz.title, kind: quiz.kind, instructionsHtml: quiz.instructionsHtml, timeLimitMinutes: quiz.timeLimitMinutes },
    maxScore: attempt.maxScore,
    serverTime: now,
  };
  if (attempt.status === 'IN_PROGRESS' && attempt.resumeSeconds !== null) {
    // Reopened by the teacher and not continued yet. The questions come with the press of
    // "Continue" (POST /quizzes/:quizId/attempts), which is also what starts the clock.
    return { ...head, status: 'REOPENED', reopened: { at: attempt.reopenedAt, seconds: attempt.resumeSeconds, continueBy: attempt.deadlineAt }, strictRules: rulesApply(quiz, attempt) ? { warnings: quiz.violationWarnings } : null, questions: null };
  }
  if (attempt.status === 'IN_PROGRESS') {
    return {
      ...head, status: 'IN_PROGRESS', lastSavedAt: attempt.lastSavedAt,
      // The strict rules as they bind this attempt: how many violations only draw a warning, and how many were used.
      rules: rulesApply(quiz, attempt) ? { warnings: quiz.violationWarnings, used: attempt.violationCount } : null,
      reopened: Boolean(attempt.reopenedAt),
      questions: answers.map((a) => reviewAnswer(a, files, { reveal: false, scores: false })),
    };
  }
  if (attempt.terminatedAt) {
    // Ended for a rule violation. Neither the questions nor a score are shown: the teacher may
    // still reopen the attempt, and the student should not study the paper in the meantime.
    return {
      ...head, status: 'TERMINATED', autoSubmitted: false,
      terminated: { at: attempt.terminatedAt, kind: attempt.terminationKind, text: violationText(attempt.terminationKind) },
      resultsVisible: false, awaitingGrading: false, resultVisibility: quiz.resultVisibility, totalScore: null, percent: null, passed: null, questions: null, answersPending: false,
    };
  }
  const visible = quizResultsVisible(quiz, now);
  const complete = !attempt.needsManualGrading;
  const showScore = visible && complete;
  const showQuestions = visible && quiz.answerVisibility !== 'SCORE_ONLY';
  const percent = showScore && attempt.maxScore > 0 ? round((attempt.totalScore / attempt.maxScore) * 100, 1) : null;
  return {
    ...head,
    status: 'SUBMITTED',
    autoSubmitted: attempt.status === 'AUTO_SUBMITTED',
    resultsVisible: visible,
    awaitingGrading: !complete,
    resultVisibility: quiz.resultVisibility,
    totalScore: showScore ? attempt.totalScore : null,
    percent,
    passed: percent === null || quiz.passingPercent === null ? null : percent >= quiz.passingPercent,
    questions: showQuestions ? answers.map((a) => reviewAnswer(a, files, { scores: true, reveal: quiz.answerVisibility === 'CORRECT_ANSWERS' && answersReleasable(quiz, now) })) : null,
    answersPending: showQuestions && quiz.answerVisibility === 'CORRECT_ANSWERS' && !answersReleasable(quiz, now),
  };
}

async function teacherAttemptView(attempt) {
  const answers = [...attempt.answers].sort((a, b) => a.position - b.position);
  const files = await answerFiles(answers.map((a) => a.id));
  // Everything that was recorded: an attempt keeps at most 500 signals, plus its violations.
  const events = await prisma.quizAttemptEvent.findMany({ where: { attemptId: attempt.id }, orderBy: { createdAt: 'asc' }, take: 700 });
  const quiz = attempt.quiz;
  return {
    id: attempt.id, quizId: attempt.quizId, classId: quiz.classId, attemptNumber: attempt.attemptNumber, status: attempt.status, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt,
    submittedAt: attempt.submittedAt, autoScore: attempt.autoScore, manualScore: attempt.manualScore, totalScore: attempt.totalScore, maxScore: attempt.maxScore, needsManualGrading: attempt.needsManualGrading,
    quiz: { title: quiz.title, kind: quiz.kind, timeLimitMinutes: quiz.timeLimitMinutes, availableUntil: quiz.availableUntil, strictMode: quiz.strictMode, violationWarnings: quiz.violationWarnings },
    student: { id: attempt.student.id, name: fullName(attempt.student) },
    // Did the student start under the strict rules? (An attempt from before they existed did not.)
    underRules: Boolean(attempt.rulesAcceptedAt),
    violationCount: attempt.violationCount,
    // Standing as failed for a rule violation. `secondsLeft` is what the clock showed (null: no clock).
    terminated: attempt.terminatedAt ? { at: attempt.terminatedAt, kind: attempt.terminationKind, text: violationText(attempt.terminationKind), secondsLeft: secondsLeftWhenEnded(attempt) } : null,
    // Reopened by a teacher. While `resumeSeconds` is set the student has not continued yet.
    reopened: attempt.reopenedAt ? { at: attempt.reopenedAt, resumeSeconds: attempt.resumeSeconds } : null,
    serverTime: new Date(),
    questions: attempt.status === 'IN_PROGRESS' ? null : answers.map((a) => reviewAnswer(a, files, { reveal: true, scores: true })),
    events: events.map((e) => ({ type: e.type, at: e.createdAt, meta: e.meta })),
  };
}

const attemptInclude = { answers: true, quiz: true, student: { select: { id: true, firstName: true, lastName: true } } };

/** Load an attempt for whoever is asking: its student, or the teacher of its class. */
async function loadAttempt(req) {
  const attempt = await prisma.quizAttempt.findUnique({ where: { id: req.valid.params.attemptId }, include: attemptInclude });
  if (!attempt || attempt.quiz.deletedAt) throw notFound('Attempt');
  const access = await loadClassAccess(req.user, attempt.quiz.classId);
  // Another student's attempt does not exist as far as this student is concerned.
  if (!access.canManage && attempt.studentId !== req.user.id) throw notFound('Attempt');
  return { attempt, access };
}

attemptsRouter.get('/:attemptId', validate({ params: attemptParams }), async (req, res) => {
  let { attempt, access } = await loadAttempt(req);
  const now = new Date();
  if (attempt.status === 'IN_PROGRESS' && isOverdue(attempt, now)) {
    await closeAttempt(attempt.id, { auto: true, now });
    ({ attempt, access } = await loadAttempt(req));
  }
  ok(res, access.canManage ? await teacherAttemptView(attempt) : await studentAttemptView(attempt, now));
});

const answerBody = z.object({ response: z.unknown().optional(), flagged: z.boolean().optional() });

/** Autosave one answer. Refused once the time is up. */
attemptsRouter.put('/:attemptId/answers/:position', requireRole('STUDENT'), validate({ params: z.object({ attemptId: zId, position: z.coerce.number().int().min(0).max(1000) }), body: answerBody }), async (req, res) => {
  const { attempt, access } = await loadAttempt(req);
  if (attempt.studentId !== req.user.id) throw notFound('Attempt');
  assertClassWritable(access.cls);
  const now = new Date();
  if (attempt.status !== 'IN_PROGRESS') throw new AppError(409, 'ATTEMPT_CLOSED', 'This attempt has already been submitted.');
  if (isOverdue(attempt, now)) {
    await closeAttempt(attempt.id, { auto: true, now });
    throw new AppError(409, 'TIME_UP', 'Time is up. Your answers were submitted automatically.');
  }
  // Reopened, but the student has not pressed "Continue": the clock starts with that, not with an answer.
  if (attempt.resumeSeconds !== null) throw new AppError(409, 'ATTEMPT_NOT_CONTINUED', 'Your teacher reopened this attempt. Open the quiz again to continue.');
  const answer = attempt.answers.find((a) => a.position === req.valid.params.position);
  if (!answer) throw notFound('Question');
  const data = { answeredAt: now };
  if (req.valid.body.flagged !== undefined) data.flagged = req.valid.body.flagged;
  let response;
  if (req.valid.body.response !== undefined) {
    response = sanitizeResponse(answer.snapshot, req.valid.body.response);
    // A cleared answer is stored as SQL NULL, i.e. "not answered".
    data.response = response ?? Prisma.DbNull;
  }
  await prisma.$transaction(async (tx) => {
    // Re-check under the row lock so that an answer can never land after the attempt closed.
    const current = await tx.quizAttempt.updateMany({ where: { id: attempt.id, status: 'IN_PROGRESS' }, data: { lastSavedAt: now } });
    if (current.count === 0) throw new AppError(409, 'ATTEMPT_CLOSED', 'This attempt has already been submitted.');
    await tx.studentAnswer.update({ where: { id: answer.id }, data });
    if (answer.snapshot.type === 'FILE_UPLOAD' && req.valid.body.response !== undefined) {
      await syncAttachments(tx, { fileIds: response?.fileIds ?? [], ownerId: req.user.id, field: 'studentAnswerId', parentId: answer.id, max: 5 });
    }
  });
  ok(res, { position: answer.position, savedAt: now, answered: isAnswered(response === undefined ? answer.response : response), deadlineAt: attempt.deadlineAt, serverTime: now });
});

attemptsRouter.post('/:attemptId/submit', requireRole('STUDENT'), validate({ params: attemptParams }), async (req, res) => {
  const { attempt, access } = await loadAttempt(req);
  if (attempt.studentId !== req.user.id) throw notFound('Attempt');
  assertClassWritable(access.cls);
  const now = new Date();
  // Submitting twice (double click, retry after a timeout) simply returns the result.
  if (attempt.status === 'IN_PROGRESS') await closeAttempt(attempt.id, { auto: isOverdue(attempt, now), now });
  const fresh = await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: attemptInclude });
  ok(res, await studentAttemptView(fresh, new Date()));
});

/**
 * Signals reported by the browser that decide nothing: the connection dropping, the file chooser
 * being opened, the list of a drop-down taking the focus on a touch screen (PICKER), the device
 * sleeping with the page open (SUSPENDED), a browser that turned out not to know whether the
 * quiz window is the active one (FOCUS_UNKNOWN) and — in a quiz without strict rules — leaving
 * the tab. They are shown to the teacher next to the attempt. `awayMs` says how long the
 * student had been away when they came back.
 */
attemptsRouter.post(
  '/:attemptId/events',
  requireRole('STUDENT'),
  validate({
    params: attemptParams,
    body: z.object({ type: z.enum(['TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_BLUR', 'WINDOW_FOCUS', 'OFFLINE', 'ONLINE', 'FILE_DIALOG', 'PICKER', 'SUSPENDED', 'FOCUS_UNKNOWN']), awayMs: z.number().int().min(0).max(7 * 24 * 3600 * 1000).optional() }),
  }),
  async (req, res) => {
    const { attempt } = await loadAttempt(req);
    if (attempt.studentId !== req.user.id) throw notFound('Attempt');
    const { type, awayMs } = req.valid.body;
    // After an attempt was ended for leaving, the moment the student came back is still worth
    // keeping: two seconds away and ten minutes away are different stories for the teacher.
    const back = ['TAB_VISIBLE', 'WINDOW_FOCUS'].includes(type);
    const cameBack = Boolean(attempt.terminatedAt) && awayMs !== undefined && back;
    if ((attempt.status === 'IN_PROGRESS' || cameBack) && (await prisma.quizAttemptEvent.count({ where: { attemptId: attempt.id } })) < 500) {
      await prisma.quizAttemptEvent.create({ data: { attemptId: attempt.id, type, ...(awayMs !== undefined ? { meta: { awayMs } } : {}) } });
    }
    // Seen back on the page: if it is opened anew from here on, it was closed without a word (see /open).
    if (back && attempt.awaySince) await prisma.quizAttempt.updateMany({ where: { id: attempt.id, status: 'IN_PROGRESS' }, data: { awaySince: null } });
    noContent(res);
  },
);

/**
 * The browser reports that a rule of the quiz was broken (see rules.js for the kinds).
 *
 * The server decides what follows: a warning while the quiz still allows one, otherwise the
 * attempt is ended — closed with a score of 0, its answers kept unmarked — and stays that way
 * until the class teacher reopens it, counts its answers or removes it.
 *
 *   key     chosen by the browser; a report that is sent twice (it is kept and sent again when
 *           the connection was down) is counted once
 *   agoMs   how long ago it happened by the browser's clock, for a report that could not be sent at once
 *
 * Answers: { outcome, kind, text, number, allowed, warningsLeft }
 *   outcome  TERMINATED  the attempt was ended
 *            WARNING     counted; `warningsLeft` more before the attempt is ended
 *            CLOSED      the attempt was no longer in progress
 *            IGNORED     the strict rules do not bind this attempt, the report is older than its
 *                        reopening, or it tells of leaving a page that has been opened anew since
 *                        (that was settled when the new page was opened: see /open)
 */
attemptsRouter.post(
  '/:attemptId/violations',
  requireRole('STUDENT'),
  validate({
    params: attemptParams,
    body: z.object({
      kind: z.enum(VIOLATION_KINDS),
      key: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/, 'Invalid key').optional(),
      agoMs: z.number().int().min(0).max(7 * 24 * 3600 * 1000).default(0),
      detail: z.string().trim().max(80).optional(),
    }),
  }),
  async (req, res) => {
    const { attempt, access } = await loadAttempt(req);
    if (attempt.studentId !== req.user.id) throw notFound('Attempt');
    const { kind, key = null, agoMs, detail } = req.valid.body;
    const quiz = attempt.quiz;
    const now = new Date();
    // When it happened, as far as the server can tell: never before the attempt started.
    const at = new Date(Math.max(attempt.startedAt.getTime(), now.getTime() - agoMs));
    const base = { kind, text: violationText(kind) };

    // Time had already run out when it happened: the attempt is simply handed in.
    if (attempt.status === 'IN_PROGRESS' && isOverdue(attempt, at)) {
      await closeAttempt(attempt.id, { auto: true, now });
      return ok(res, { ...base, outcome: 'CLOSED' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockKey(tx, `attempt:${attempt.id}`);
      const current = await tx.quizAttempt.findUnique({ where: { id: attempt.id } });
      if (!current) throw notFound('Attempt');
      if (key) {
        // The same report again: answer what was decided the first time.
        const seen = await tx.quizAttemptEvent.findUnique({ where: { attemptId_clientKey: { attemptId: current.id, clientKey: key } } });
        if (seen) {
          const m = seen.meta ?? {};
          return { ...base, kind: m.kind ?? kind, text: violationText(m.kind ?? kind), outcome: m.outcome === 'LATE' ? 'CLOSED' : m.outcome === 'SUPERSEDED' ? 'IGNORED' : m.outcome ?? 'IGNORED', number: m.number, allowed: m.allowed, warningsLeft: Math.max(0, (m.allowed ?? 0) - (m.number ?? 0)) };
        }
      }
      if (!rulesApply(quiz, current)) return { ...base, outcome: 'IGNORED' };
      if (current.status !== 'IN_PROGRESS') {
        // Handed in before the report arrived (the connection was down and time ran out). It is
        // kept for the teacher to see; it no longer changes anything.
        if (!current.terminatedAt && current.submittedAt && at < current.submittedAt && (await tx.quizAttemptEvent.count({ where: { attemptId: current.id, type: 'VIOLATION' } })) < 50) {
          await tx.quizAttemptEvent.create({ data: { attemptId: current.id, type: 'VIOLATION', clientKey: key, createdAt: at, meta: { kind, outcome: 'LATE', ...(detail ? { detail } : {}) } } });
        }
        return { ...base, outcome: 'CLOSED' };
      }
      // A report from before the teacher reopened the attempt is not held against the new start.
      if (current.resumeSeconds !== null || (current.reopenedAt && at < current.reopenedAt)) return { ...base, outcome: 'IGNORED' };
      // The student left a page that has been opened anew since, and this report of it arrives
      // only now (it waited in another browser, or its connection was down). What became of the
      // old page was settled when the new one was opened: counted then, unless leaving had been
      // counted before. One act is not counted twice; the teacher still sees it.
      if (LEAVING_KINDS.includes(kind) && current.pageOpenedAt && at < current.pageOpenedAt) {
        if ((await tx.quizAttemptEvent.count({ where: { attemptId: current.id, type: 'VIOLATION' } })) < 50) {
          await tx.quizAttemptEvent.create({ data: { attemptId: current.id, type: 'VIOLATION', clientKey: key, createdAt: at, meta: { kind, outcome: 'SUPERSEDED', ...(detail ? { detail } : {}), reportedAt: now } } });
        }
        return { ...base, outcome: 'IGNORED' };
      }
      return countViolation(tx, req, { current, quiz, classId: access.cls.id, kind, key, at, detail, late: agoMs > 30_000 ? now : null });
    });

    if (result.ended) await announceTermination({ attempt, quiz, cls: access.cls, student: req.user, kind });
    const { ended: _ended, ...answer } = result;
    ok(res, answer);
  },
);

/**
 * Count one violation against an attempt that is in progress under the rules, inside the
 * caller's transaction (which holds the attempt's lock): a warning, or the end of the attempt.
 */
async function countViolation(tx, req, { current, quiz, classId, kind, key = null, at, detail, late = null }) {
  const o = violationOutcome(quiz, current);
  await tx.quizAttemptEvent.create({
    data: { attemptId: current.id, type: 'VIOLATION', clientKey: key, createdAt: at, meta: { kind, number: o.number, allowed: o.allowed, outcome: o.terminate ? 'TERMINATED' : 'WARNING', ...(detail ? { detail } : {}), ...(late ? { reportedAt: late } : {}) } },
  });
  const base = { kind, text: violationText(kind), number: o.number, allowed: o.allowed };
  if (!o.terminate) {
    // Gone from the page until a sign of life says otherwise (see /open).
    await tx.quizAttempt.update({ where: { id: current.id }, data: { violationCount: o.number, ...(LEAVING_KINDS.includes(kind) ? { awaySince: at } : {}) } });
    return { ...base, outcome: 'WARNING', warningsLeft: o.warningsLeft };
  }
  await terminateAttempt(tx, current, quiz, { kind, at, count: o.number });
  await audit(req, {
    action: 'quiz.attempt.terminate', entityType: 'QuizAttempt', entityId: current.id, classId,
    summary: `Attempt ${current.attemptNumber} in "${quiz.title}" was ended automatically: ${fullName(req.user)} ${violationText(kind)}`,
    after: { kind, violation: o.number, warningsAllowed: o.allowed },
  }, tx);
  return { ...base, outcome: 'TERMINATED', warningsLeft: 0, ended: true };
}

/** Tell the teacher and the student that an attempt was ended. */
async function announceTermination({ attempt, quiz, cls, student, kind }) {
  const link = `/classes/${cls.id}/quizzes/${quiz.id}`;
  await notify([cls.teacherId], {
    type: 'quiz.attempt.terminated', title: `Attempt ended for a rule violation: ${quiz.title}`,
    body: `${fullName(student)} ${violationText(kind)}. The attempt counts as failed unless you reopen it or count its answers.`,
    link: `${link}/results?attempt=${attempt.id}`, classId: cls.id,
  });
  await notify([attempt.studentId], {
    type: 'quiz.attempt.terminated', title: `Your attempt was ended: ${quiz.title}`,
    body: `It was recorded that you ${violationText(kind)}. The attempt counts as failed. Only your teacher can reopen it.`,
    link, classId: cls.id,
  });
}

/**
 * The quiz page tells the server that it has opened the attempt, once for every time the page is
 * loaded. Under strict rules a page that is opened a second time was closed or reloaded in
 * between; if nothing was reported about that, it is counted now (rules.js, `pageOpening`).
 *
 * Answers: { outcome } — OPENED (nothing more is held against the student; `warned` carries the
 * warning that was counted when they left, for the new page to show), IGNORED (the rules do not
 * bind this attempt), CLOSED (it is no longer in progress), or WARNING / TERMINATED with the
 * fields of a violation.
 */
attemptsRouter.post('/:attemptId/open', requireRole('STUDENT'), validate({ params: attemptParams, body: z.object({}).passthrough() }), async (req, res) => {
  const { attempt, access } = await loadAttempt(req);
  if (attempt.studentId !== req.user.id) throw notFound('Attempt');
  const quiz = attempt.quiz;
  const now = new Date();
  const kind = 'CLOSED_PAGE';
  if (attempt.status === 'IN_PROGRESS' && isOverdue(attempt, now)) {
    await closeAttempt(attempt.id, { auto: true, now });
    return ok(res, { outcome: 'CLOSED' });
  }
  const result = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `attempt:${attempt.id}`);
    const current = await tx.quizAttempt.findUnique({ where: { id: attempt.id } });
    if (!current) throw notFound('Attempt');
    if (current.status !== 'IN_PROGRESS') return { outcome: 'CLOSED' };
    if (!rulesApply(quiz, current) || current.resumeSeconds !== null) return { outcome: 'IGNORED' };
    const opening = pageOpening(current);
    await tx.quizAttempt.update({ where: { id: current.id }, data: { pageOpenedAt: now, awaySince: null } });
    if (opening === 'FIRST') return { outcome: 'OPENED' };
    if (opening === 'AFTER_LEAVING') {
      if ((await tx.quizAttemptEvent.count({ where: { attemptId: current.id } })) < 500) await tx.quizAttemptEvent.create({ data: { attemptId: current.id, type: 'PAGE_REOPENED', meta: { awayMs: now.getTime() - current.awaySince.getTime() } } });
      // The new page shows the warning that the old one could no longer show.
      const last = await tx.quizAttemptEvent.findFirst({ where: { attemptId: current.id, type: 'VIOLATION' }, orderBy: { createdAt: 'desc' } });
      const m = last?.meta ?? {};
      return { outcome: 'OPENED', ...(m.outcome === 'WARNING' ? { warned: { kind: m.kind, text: violationText(m.kind), number: m.number, allowed: m.allowed, at: last.createdAt } } : {}) };
    }
    return countViolation(tx, req, { current, quiz, classId: access.cls.id, kind, at: now, detail: 'opened again without a report that it was closed' });
  });
  if (result.ended) await announceTermination({ attempt, quiz, cls: access.cls, student: req.user, kind });
  const { ended: _ended, ...answer } = result;
  return ok(res, answer);
});

// ── Teacher: results, manual grading, release ────────────────────────────────
async function resultRows(quiz) {
  const [enrollments, attempts] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: quiz.classId, status: 'ENROLLED' },
      select: { student: { select: { id: true, firstName: true, lastName: true, studentProfile: { select: { studentNumber: true } } } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    }),
    prisma.quizAttempt.findMany({ where: { quizId: quiz.id }, orderBy: { attemptNumber: 'asc' } }),
  ]);
  const total = totalPoints(quiz);
  const now = new Date();
  return enrollments.map(({ student }) => {
    const mine = attempts.filter((a) => a.studentId === student.id);
    const outcome = quizOutcome(mine, quiz.attemptScoring);
    const percent = outcome && outcome.fraction !== null ? round(outcome.fraction * 100, 1) : null;
    const finished = mine.filter((a) => FINISHED.includes(a.status));
    return {
      student: { id: student.id, name: fullName(student), firstName: student.firstName, lastName: student.lastName, studentNumber: student.studentProfile?.studentNumber ?? null },
      // TERMINATED: an attempt was ended for a rule violation and waits for the teacher's decision.
      status: mine.some((a) => a.status === 'IN_PROGRESS') ? 'IN_PROGRESS' : mine.some((a) => a.terminatedAt) ? 'TERMINATED' : finished.length > 0 ? (finished.some((a) => a.needsManualGrading) ? 'NEEDS_GRADING' : 'GRADED') : quiz.availableUntil && quiz.availableUntil <= now && isPublished(quiz, now) ? 'MISSING' : 'NOT_STARTED',
      attempts: mine.map((a) => ({
        id: a.id, attemptNumber: a.attemptNumber, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, totalScore: a.totalScore, maxScore: a.maxScore, needsManualGrading: a.needsManualGrading,
        terminated: a.terminatedAt ? { at: a.terminatedAt, kind: a.terminationKind, text: violationText(a.terminationKind) } : null,
        // Reopened by a teacher; `waiting` until the student continues.
        reopened: a.reopenedAt ? { at: a.reopenedAt, waiting: a.status === 'IN_PROGRESS' && a.resumeSeconds !== null } : null,
        violationCount: a.violationCount,
      })),
      countedAttemptId: outcome?.attemptId ?? null,
      score: percent === null ? null : round(outcome.fraction * total, 2),
      percent,
      passed: percent === null || quiz.passingPercent === null ? null : percent >= quiz.passingPercent,
      lastSubmittedAt: finished.length > 0 ? finished[finished.length - 1].submittedAt : null,
    };
  });
}

quizzesRouter.get('/:quizId/results', validate({ params: quizParams }), async (req, res) => {
  const { quiz } = await loadManaged(req, { writable: false });
  const rows = await resultRows(quiz);
  const scored = rows.filter((r) => r.percent !== null);
  ok(res, {
    quiz: { ...baseView(quiz), status: quiz.status, resultVisibility: quiz.resultVisibility, answerVisibility: quiz.answerVisibility, resultsPublishedAt: quiz.resultsPublishedAt },
    students: rows,
    stats: {
      submitted: rows.filter((r) => r.attempts.some((a) => FINISHED.includes(a.status))).length,
      needsGrading: rows.filter((r) => r.status === 'NEEDS_GRADING').length,
      // Students with an attempt that was ended for a rule violation and not yet decided on.
      violations: rows.filter((r) => r.attempts.some((a) => a.terminated)).length,
      average: scored.length === 0 ? null : round(scored.reduce((s, r) => s + r.percent, 0) / scored.length, 1),
      highest: scored.length === 0 ? null : Math.max(...scored.map((r) => r.percent)),
      lowest: scored.length === 0 ? null : Math.min(...scored.map((r) => r.percent)),
      passed: scored.filter((r) => r.passed === true).length,
    },
  });
});

attemptsRouter.put(
  '/:attemptId/answers/:position/grade',
  validate({ params: z.object({ attemptId: zId, position: z.coerce.number().int().min(0).max(1000) }), body: z.object({ score: z.number().min(0).max(1000), feedback: z.string().trim().max(5000).nullable().optional() }) }),
  async (req, res) => {
    const { attempt, access } = await loadAttempt(req);
    if (!access.canManage) throw forbidden('Only the class teacher can do that.');
    assertClassWritable(access.cls);
    if (attempt.status === 'IN_PROGRESS') throw conflict('This attempt has not been submitted yet.', 'ATTEMPT_IN_PROGRESS');
    // Its answers are not marked while it stands as failed: marking one would half-count it.
    if (attempt.terminatedAt) throw conflict('This attempt was ended for a rule violation. Count its answers or reopen it first.', 'ATTEMPT_TERMINATED');
    const answer = attempt.answers.find((a) => a.position === req.valid.params.position);
    if (!answer) throw notFound('Question');
    const { score, feedback } = req.valid.body;
    if (score > answer.points) throw fieldErrors({ score: `This question is worth ${answer.points} point(s).` });
    await prisma.$transaction(async (tx) => {
      await lockKey(tx, `attempt:${attempt.id}`);
      const now = new Date();
      await tx.studentAnswer.update({
        where: { id: answer.id },
        data: { manualScore: round(score, 2), score: round(score, 2), needsManual: false, gradedById: req.user.id, gradedAt: now, ...(feedback !== undefined ? { feedback: feedback ? plainText(feedback, 5000) : null } : {}) },
      });
      const answers = await tx.studentAnswer.findMany({ where: { attemptId: attempt.id } });
      const totals = attemptTotals(answers);
      await tx.quizAttempt.update({
        where: { id: attempt.id },
        data: { ...totals, ...(totals.needsManualGrading ? {} : { status: 'GRADED', gradedById: req.user.id, gradedAt: now }) },
      });
      // Overruling the automatic score of an objective question is worth a trace.
      if (!answer.needsManual && answer.autoScore !== null && answer.autoScore !== round(score, 2)) {
        await audit(req, {
          action: 'quiz.answer.override', entityType: 'QuizAttempt', entityId: attempt.id, classId: access.cls.id,
          summary: `Changed the score of question ${answer.position + 1} in "${attempt.quiz.title}"`, before: { score: answer.score }, after: { score: round(score, 2) },
        }, tx);
      }
      await syncQuizGrade(tx, attempt.quiz, attempt.studentId, req.user.id);
    });
    ok(res, await teacherAttemptView(await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: attemptInclude })));
  },
);

const decisionNote = z.string().trim().max(500).nullable().optional();

/**
 * Reopen an attempt that was ended for a rule violation. The student continues the same attempt
 * with the answers they had given; the count of violations starts again.
 *
 *   minutes     the time the student gets, counted from the moment they continue.
 *               Left out: what was left on the clock when the attempt was ended (no timer for an untimed quiz).
 *   continueBy  until when the student may continue (with no timer: until when they may work).
 *               Left out: when the quiz closes. Required once the quiz has closed.
 */
attemptsRouter.post(
  '/:attemptId/reopen',
  validate({ params: attemptParams, body: z.object({ minutes: z.number().int().min(1).max(600).nullable().optional(), continueBy: zOptionalDateTime, note: decisionNote }) }),
  async (req, res) => {
    const { attempt, access } = await loadAttempt(req);
    if (!access.canManage) throw forbidden('Only the class teacher can do that.');
    assertClassWritable(access.cls);
    const quiz = attempt.quiz;
    const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
    const now = new Date();
    const clock = await prisma.$transaction(async (tx) => {
      // The same order as starting an attempt: first the student's place in the quiz, then the attempt.
      await lockKey(tx, `quiz-start:${quiz.id}:${attempt.studentId}`);
      await lockKey(tx, `attempt:${attempt.id}`);
      const current = await tx.quizAttempt.findUnique({ where: { id: attempt.id } });
      if (!current?.terminatedAt) throw conflict('Only an attempt that was ended for a rule violation can be reopened.', 'ATTEMPT_NOT_TERMINATED');
      if ((await tx.quizAttempt.count({ where: { quizId: quiz.id, studentId: attempt.studentId, status: 'IN_PROGRESS' } })) > 0) throw conflict('This student has another attempt in progress.', 'ATTEMPT_IN_PROGRESS');
      const set = reopenClock(quiz, current, { minutes: req.valid.body.minutes ?? null, continueBy: req.valid.body.continueBy ?? null }, now);
      if (set.errors) throw fieldErrors(set.errors);
      await tx.quizAttempt.update({
        where: { id: current.id },
        data: {
          status: 'IN_PROGRESS', submittedAt: null, terminatedAt: null, terminationKind: null, violationCount: 0,
          autoScore: 0, manualScore: 0, totalScore: null, needsManualGrading: false,
          reopenedAt: now, reopenedById: req.user.id, resumeSeconds: set.resumeSeconds, deadlineAt: set.deadlineAt,
          pageOpenedAt: null, awaySince: null,
        },
      });
      await tx.quizAttemptEvent.create({ data: { attemptId: current.id, type: 'REOPENED', meta: { by: fullName(req.user), seconds: set.resumeSeconds, until: set.deadlineAt, ...(note ? { note } : {}) } } });
      await audit(req, {
        action: 'quiz.attempt.reopen', entityType: 'QuizAttempt', entityId: current.id, classId: access.cls.id,
        summary: `Reopened attempt ${current.attemptNumber} of ${fullName(attempt.student)} in "${quiz.title}"${note ? ` — ${note}` : ''}`,
        before: { endedAt: current.terminatedAt, violation: current.terminationKind }, after: { seconds: set.resumeSeconds, until: set.deadlineAt },
      }, tx);
      await syncQuizGrade(tx, quiz, attempt.studentId, req.user.id);
      return set;
    });
    const tz = await getTimeZone();
    const until = clock.deadlineAt ? `${dateKey(clock.deadlineAt, tz)} ${timeKey(clock.deadlineAt, tz)}` : null;
    const time = clock.resumeSeconds !== null
      ? `You have ${durationText(clock.resumeSeconds)} from the moment you continue${until ? `. Continue before ${until}` : ''}.`
      : until ? `You can work on it until ${until}.` : 'You can continue from where you stopped.';
    await notify([attempt.studentId], {
      type: 'quiz.attempt.reopened', title: `Your attempt was reopened: ${quiz.title}`,
      body: `${time} The rules of the quiz still apply.${note ? ` Note from your teacher: ${note}` : ''}`,
      link: `/classes/${access.cls.id}/quizzes/${quiz.id}`, classId: access.cls.id,
    });
    ok(res, await teacherAttemptView(await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: attemptInclude })));
  },
);

/**
 * Count the answers of an attempt that was ended for a rule violation: it becomes an ordinary
 * handed-in attempt, marked on what the student had answered by then.
 */
attemptsRouter.post('/:attemptId/count-answers', validate({ params: attemptParams, body: z.object({ note: decisionNote }) }), async (req, res) => {
  const { attempt, access } = await loadAttempt(req);
  if (!access.canManage) throw forbidden('Only the class teacher can do that.');
  assertClassWritable(access.cls);
  if (!attempt.terminatedAt) throw conflict('Only an attempt that was ended for a rule violation needs this.', 'ATTEMPT_NOT_TERMINATED');
  const quiz = attempt.quiz;
  const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
  // Programs that were written but never checked go to the judge first (slow, so before the transaction).
  await checkUncheckedPrograms(attempt.id, Date.now(), { terminated: true });
  await prisma.$transaction(async (tx) => {
    await lockKey(tx, `attempt:${attempt.id}`);
    const current = await tx.quizAttempt.findUnique({ where: { id: attempt.id }, include: { answers: true } });
    if (!current?.terminatedAt) throw conflict('Only an attempt that was ended for a rule violation needs this.', 'ATTEMPT_NOT_TERMINATED');
    const totals = await scoreAnswers(tx, current);
    await tx.quizAttempt.update({
      where: { id: current.id },
      data: { status: 'SUBMITTED', terminatedAt: null, terminationKind: null, autoScore: totals.autoScore, manualScore: 0, totalScore: totals.totalScore, needsManualGrading: totals.needsManualGrading },
    });
    await tx.quizAttemptEvent.create({ data: { attemptId: current.id, type: 'COUNTED', meta: { by: fullName(req.user), ...(note ? { note } : {}) } } });
    await audit(req, {
      action: 'quiz.attempt.count', entityType: 'QuizAttempt', entityId: current.id, classId: access.cls.id,
      summary: `Counted the answers of attempt ${current.attemptNumber} of ${fullName(attempt.student)} in "${quiz.title}", which had been ended for a rule violation${note ? ` — ${note}` : ''}`,
      before: { endedAt: current.terminatedAt, violation: current.terminationKind, totalScore: 0 }, after: { totalScore: totals.totalScore, needsManualGrading: totals.needsManualGrading },
    }, tx);
    await syncQuizGrade(tx, quiz, attempt.studentId, req.user.id);
  });
  await notify([attempt.studentId], {
    type: 'quiz.attempt.counted', title: `Your answers will count: ${quiz.title}`,
    body: `Your teacher decided to count the answers you had given before the attempt was ended.${note ? ` Note from your teacher: ${note}` : ''}`,
    link: `/classes/${access.cls.id}/quizzes/${quiz.id}`, classId: access.cls.id,
  });
  ok(res, await teacherAttemptView(await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: attemptInclude })));
});

/** Void an attempt (for example after a power cut) so that the student can take the quiz again. */
attemptsRouter.delete('/:attemptId', validate({ params: attemptParams, body: z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500) }) }), async (req, res) => {
  const { attempt, access } = await loadAttempt(req);
  if (!access.canManage) throw forbidden('Only the class teacher can do that.');
  assertClassWritable(access.cls);
  const reason = plainText(req.valid.body.reason, 500);
  await prisma.$transaction(async (tx) => {
    await lockKey(tx, `attempt:${attempt.id}`);
    const answerIds = attempt.answers.map((a) => a.id);
    await tx.file.updateMany({ where: { studentAnswerId: { in: answerIds } }, data: { studentAnswerId: null, deletedAt: new Date() } });
    await tx.programmingSubmission.updateMany({ where: { studentAnswerId: { in: answerIds } }, data: { studentAnswerId: null } });
    await tx.studentAnswer.deleteMany({ where: { attemptId: attempt.id } });
    await tx.quizAttempt.delete({ where: { id: attempt.id } });
    await audit(req, {
      action: 'quiz.attempt.void', entityType: 'QuizAttempt', entityId: attempt.id, classId: access.cls.id,
      summary: `Voided attempt ${attempt.attemptNumber} of ${fullName(attempt.student)} in "${attempt.quiz.title}" — ${reason}`,
      before: { status: attempt.status, totalScore: attempt.totalScore, maxScore: attempt.maxScore },
    }, tx);
    await syncQuizGrade(tx, attempt.quiz, attempt.studentId, req.user.id);
  });
  await notify([attempt.studentId], { type: 'quiz.attempt.reset', title: `You can retake: ${attempt.quiz.title}`, body: reason, link: `/classes/${access.cls.id}/quizzes/${attempt.quizId}`, classId: access.cls.id });
  noContent(res);
});

const release = (publish) => async (req, res) => {
  const { quiz, cls } = await loadManaged(req);
  if (publish) {
    const pending = await prisma.quizAttempt.count({ where: { quizId: quiz.id, status: { in: FINISHED }, needsManualGrading: true } });
    if (pending > 0 && !req.valid.body.confirmPending) {
      throw new AppError(409, 'GRADING_PENDING', `${pending} attempt(s) still have answers to grade. Those students will see "awaiting grading". Release anyway?`, { pending });
    }
  }
  await prisma.quiz.update({ where: { id: quiz.id }, data: { resultsPublishedAt: publish ? new Date() : null } });
  await audit(req, { action: publish ? 'quiz.results.publish' : 'quiz.results.withhold', entityType: 'Quiz', entityId: quiz.id, classId: cls.id, summary: `${publish ? 'Released' : 'Withdrew'} the results of "${quiz.title}"` });
  if (publish && !quiz.resultsPublishedAt && quiz.resultVisibility === 'MANUAL') {
    const takers = await prisma.quizAttempt.findMany({ where: { quizId: quiz.id, status: { in: FINISHED } }, distinct: ['studentId'], select: { studentId: true } });
    await notify(takers.map((t) => t.studentId), { type: 'quiz.results', title: `Results are available: ${quiz.title}`, body: classLabel(cls), link: `/classes/${cls.id}/quizzes/${quiz.id}`, classId: cls.id });
  }
  ok(res, manageView(await fullQuiz(quiz.id), new Date()));
};

quizzesRouter.post('/:quizId/results/publish', validate({ params: quizParams, body: z.object({ confirmPending: z.boolean().default(false) }) }), release(true));
quizzesRouter.post('/:quizId/results/withhold', validate({ params: quizParams, body: z.object({}).passthrough() }), release(false));

/** How each question performed, across every submitted attempt. */
quizzesRouter.get('/:quizId/analysis', validate({ params: quizParams }), async (req, res) => {
  const { quiz } = await loadManaged(req, { writable: false });
  const answers = await prisma.studentAnswer.findMany({
    // An attempt that stands as failed for a rule violation has answers that were never marked.
    where: { attempt: { quizId: quiz.id, status: { in: FINISHED }, terminatedAt: null } },
    select: { questionId: true, snapshot: true, response: true, score: true, points: true, isCorrect: true, needsManual: true, manualScore: true },
  });
  const byQuestion = new Map();
  for (const a of answers) {
    const key = a.questionId ?? a.snapshot.questionId ?? excerpt(a.snapshot.text, 80);
    if (!byQuestion.has(key)) byQuestion.set(key, { questionId: a.questionId, type: a.snapshot.type, text: excerpt(a.snapshot.text, 200), responses: 0, answered: 0, correct: 0, pending: 0, earned: 0, possible: 0, choices: new Map() });
    const row = byQuestion.get(key);
    row.responses += 1;
    if (isAnswered(a.response)) row.answered += 1;
    if (a.needsManual && a.manualScore === null) {
      row.pending += 1;
      continue;
    }
    if (a.isCorrect === true || (a.score !== null && a.score === a.points)) row.correct += 1;
    row.earned += a.score ?? 0;
    row.possible += a.points;
    if (['MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTIPLE_RESPONSE'].includes(a.snapshot.type)) {
      const picked = a.response?.choiceIds ?? (a.response?.choiceId ? [a.response.choiceId] : []);
      for (const c of a.snapshot.choices ?? []) {
        if (!row.choices.has(c.text)) row.choices.set(c.text, { text: c.text, isCorrect: c.isCorrect, count: 0 });
        if (picked.includes(c.id)) row.choices.get(c.text).count += 1;
      }
    }
  }
  ok(res, [...byQuestion.values()].map((r) => ({
    questionId: r.questionId, type: r.type, text: r.text, responses: r.responses, answered: r.answered, pending: r.pending,
    correctPercent: r.responses - r.pending === 0 ? null : round((r.correct / (r.responses - r.pending)) * 100, 1),
    averagePercent: r.possible === 0 ? null : round((r.earned / r.possible) * 100, 1),
    choices: [...r.choices.values()],
  })));
});

quizzesRouter.get('/:quizId/export', validate({ params: quizParams, query: z.object({ format: exportFormat }) }), async (req, res) => {
  const { quiz, cls } = await loadManaged(req, { writable: false });
  await assertPermission(req.user, 'grades.export');
  const { format } = req.valid.query;
  const tz = await getTimeZone();
  const rows = await resultRows(quiz);
  const label = { GRADED: 'Graded', NEEDS_GRADING: 'Needs grading', IN_PROGRESS: 'In progress', TERMINATED: 'Ended: rule violation', MISSING: 'Missing', NOT_STARTED: 'Not started' };
  await audit(req, { action: 'quiz.export', entityType: 'Quiz', entityId: quiz.id, classId: cls.id, summary: `Exported the results of "${quiz.title}" (${format.toUpperCase()})` });
  await sendTable(res, format, {
    filename: `${cls.course.code}-${quiz.title}-results`,
    title: `${quiz.title} — results`,
    subtitle: `${classLabel(cls)} · ${cls.course.title}`,
    meta: [`${totalPoints(quiz)} point(s) · ${questionCount(quiz)} question(s) · counted attempt: ${quiz.attemptScoring.toLowerCase()}`, `Generated ${dateKey(new Date(), tz)} (${tz})`],
    columns: [
      { header: 'Student No.', value: (r) => r.student.studentNumber ?? '', pdfWidth: 1.3 },
      { header: 'Name', value: (r) => `${r.student.lastName}, ${r.student.firstName}`, width: 28, pdfWidth: 2.6 },
      { header: 'Attempts', value: (r) => r.attempts.length, pdfWidth: 0.9, align: 'right' },
      { header: 'Score', value: (r) => r.score ?? '', pdfWidth: 0.9, align: 'right' },
      { header: '%', value: (r) => r.percent ?? '', pdfWidth: 0.8, align: 'right' },
      { header: 'Status', value: (r) => label[r.status], width: 22, pdfWidth: 1.7 },
      { header: 'Submitted', value: (r) => (r.lastSubmittedAt ? `${dateKey(r.lastSubmittedAt, tz)} ${timeKey(r.lastSubmittedAt, tz)}` : ''), width: 18, pdfWidth: 1.6 },
    ],
    rows,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
  });
});
