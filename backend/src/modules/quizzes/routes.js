// Quizzes and exams: building, taking (with a server-side clock), scoring, manual grading,
// result release, analysis and export.
import { Router } from 'express';
import { z } from 'zod';
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
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { registerJob } from '../../services/scheduler.js';
import { getTimeZone } from '../../services/settings.js';
import { fileSummary, syncAttachments } from '../../services/storage.js';
import { assertClassWritable, classLabel, loadClassAccess, requireClassManager, requireWritableClassManager } from '../classes/access.js';
import { recordGrade, syncLinkedItem } from '../gradebook/service.js';
import { quizOutcome } from './attemptScore.js';
import { defaultBankFor, saveQuestion } from './banks.js';

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
  return {
    ...baseView(quiz),
    attemptsUsed: attempts.length,
    inProgressAttemptId: attempts.find((a) => a.status === 'IN_PROGRESS')?.id ?? null,
    start: startability(quiz, attempts, now),
    submitted: attempts.some((a) => FINISHED.includes(a.status)),
    resultsVisible: visible,
    awaitingGrading: Boolean(outcome?.pending),
    score: percent === null ? null : round(outcome.fraction * total, 2),
    percent,
    passed: percent === null || quiz.passingPercent === null ? null : percent >= quiz.passingPercent,
    myStatus: attempts.some((a) => a.status === 'IN_PROGRESS') ? 'IN_PROGRESS' : attempts.some((a) => FINISHED.includes(a.status)) ? 'SUBMITTED' : quiz.availableUntil && quiz.availableUntil <= now ? 'MISSING' : 'NOT_STARTED',
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
    select: { quizId: true, studentId: true, status: true, needsManualGrading: true },
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
      id: a.id, attemptNumber: a.attemptNumber, status: a.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'SUBMITTED', startedAt: a.startedAt, submittedAt: a.submittedAt, deadlineAt: a.deadlineAt,
      awaitingGrading: FINISHED.includes(a.status) && a.needsManualGrading,
      score: visible && FINISHED.includes(a.status) && !a.needsManualGrading ? a.totalScore : null,
      maxScore: a.maxScore,
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
          ['kind', 'availableFrom', 'availableUntil', 'timeLimitMinutes', 'maxAttempts', 'attemptScoring', 'passingPercent', 'shuffleQuestions', 'shuffleChoices', 'resultVisibility', 'answerVisibility', 'moduleId']
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
      shuffleQuestions: quiz.shuffleQuestions, shuffleChoices: quiz.shuffleChoices, resultVisibility: quiz.resultVisibility === 'AFTER_CLOSE' ? 'MANUAL' : quiz.resultVisibility,
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

/**
 * Close an attempt: score everything that can be scored automatically and total it.
 * Safe to call twice — an attempt that is no longer in progress is returned untouched.
 */
export async function finalizeAttempt(tx, attemptId, { auto = false, now = new Date() } = {}) {
  await lockKey(tx, `attempt:${attemptId}`);
  const attempt = await tx.quizAttempt.findUnique({ where: { id: attemptId }, include: { answers: true, quiz: true } });
  if (!attempt || attempt.status !== 'IN_PROGRESS') return attempt;
  const code = await tx.programmingSubmission.groupBy({ by: ['studentAnswerId'], where: { studentAnswerId: { in: attempt.answers.map((a) => a.id) }, status: 'COMPLETED' }, _max: { scorePercent: true } });
  const codeScore = new Map(code.map((c) => [c.studentAnswerId, c._max.scorePercent]));
  const scored = [];
  for (const answer of attempt.answers) {
    const result = scoreAnswer(answer.snapshot, answer.response, answer.points, { codeScorePercent: codeScore.get(answer.id) ?? null });
    await tx.studentAnswer.update({ where: { id: answer.id }, data: { autoScore: result.autoScore, isCorrect: result.isCorrect, needsManual: result.needsManual, score: result.autoScore } });
    scored.push({ ...result, manualScore: null });
  }
  const totals = attemptTotals(scored);
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

const isOverdue = (attempt, now) => Boolean(attempt.deadlineAt) && now.getTime() > attempt.deadlineAt.getTime() + GRACE_MS;

/** Submit attempts whose time ran out while the student was away. Run by the scheduler. */
export async function autoSubmitOverdue(now = new Date()) {
  const due = await prisma.quizAttempt.findMany({ where: { status: 'IN_PROGRESS', deadlineAt: { lt: new Date(now.getTime() - GRACE_MS) } }, select: { id: true }, take: 200 });
  let count = 0;
  for (const { id } of due) {
    try {
      await prisma.$transaction((tx) => finalizeAttempt(tx, id, { auto: true, now }));
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

quizzesRouter.post('/:quizId/attempts', requireRole('STUDENT'), validate({ params: quizParams }), async (req, res) => {
  const quiz = await loadQuiz(req.valid.params.quizId);
  const access = await loadClassAccess(req.user, quiz.classId);
  if (!access.isStudent) throw forbidden('Only students enrolled in this class can do that.');
  if (!isPublished(quiz)) throw notFound('Quiz');
  assertClassWritable(access.cls);

  const result = await prisma.$transaction(async (tx) => {
    // One attempt at a time per student: a double click cannot start two.
    await lockKey(tx, `quiz-start:${quiz.id}:${req.user.id}`);
    const now = new Date();
    let attempts = await tx.quizAttempt.findMany({ where: { quizId: quiz.id, studentId: req.user.id } });
    const running = attempts.find((a) => a.status === 'IN_PROGRESS');
    if (running) {
      if (!isOverdue(running, now)) {
        await tx.quizAttemptEvent.create({ data: { attemptId: running.id, type: 'RESUMED' } });
        return { attempt: running, resumed: true };
      }
      await finalizeAttempt(tx, running.id, { auto: true, now });
      attempts = await tx.quizAttempt.findMany({ where: { quizId: quiz.id, studentId: req.user.id } });
    }
    const can = startability(quiz, attempts, now);
    if (!can.ok) throw new AppError(409, can.code, can.reason);
    const picked = await pickQuestions(tx, quiz);
    if (picked.length === 0) throw new AppError(409, 'QUIZ_EMPTY', 'This quiz has no questions yet. Please tell your teacher.');
    const limit = quiz.timeLimitMinutes ? new Date(now.getTime() + quiz.timeLimitMinutes * 60_000) : null;
    // The clock stops at the time limit or when the quiz closes, whichever comes first.
    const deadlineAt = limit && quiz.availableUntil ? new Date(Math.min(limit.getTime(), quiz.availableUntil.getTime())) : limit ?? quiz.availableUntil ?? null;
    const attempt = await tx.quizAttempt.create({
      data: {
        quizId: quiz.id, studentId: req.user.id, attemptNumber: Math.max(0, ...attempts.map((a) => a.attemptNumber)) + 1, startedAt: now, deadlineAt,
        maxScore: round(picked.reduce((s, p) => s + p.points, 0), 2),
        answers: { create: picked.map((p, position) => ({ questionId: p.question.id, position, points: p.points, snapshot: buildSnapshot(p.question, { shuffleChoices: quiz.shuffleChoices }) })) },
        events: { create: { type: 'STARTED' } },
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
  if (attempt.status === 'IN_PROGRESS') {
    return { ...head, status: 'IN_PROGRESS', lastSavedAt: attempt.lastSavedAt, questions: answers.map((a) => reviewAnswer(a, files, { reveal: false, scores: false })) };
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
  const events = await prisma.quizAttemptEvent.findMany({ where: { attemptId: attempt.id }, orderBy: { createdAt: 'asc' }, take: 200 });
  return {
    id: attempt.id, quizId: attempt.quizId, classId: attempt.quiz.classId, attemptNumber: attempt.attemptNumber, status: attempt.status, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt,
    submittedAt: attempt.submittedAt, autoScore: attempt.autoScore, manualScore: attempt.manualScore, totalScore: attempt.totalScore, maxScore: attempt.maxScore, needsManualGrading: attempt.needsManualGrading,
    quiz: { title: attempt.quiz.title, kind: attempt.quiz.kind },
    student: { id: attempt.student.id, name: fullName(attempt.student) },
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
    await prisma.$transaction((tx) => finalizeAttempt(tx, attempt.id, { auto: true, now }));
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
    await prisma.$transaction((tx) => finalizeAttempt(tx, attempt.id, { auto: true, now }));
    throw new AppError(409, 'TIME_UP', 'Time is up. Your answers were submitted automatically.');
  }
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
  if (attempt.status === 'IN_PROGRESS') await prisma.$transaction((tx) => finalizeAttempt(tx, attempt.id, { auto: isOverdue(attempt, now), now }));
  const fresh = await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: attemptInclude });
  ok(res, await studentAttemptView(fresh, new Date()));
});

/** Integrity signals reported by the browser (leaving the tab, losing focus). Informational only. */
attemptsRouter.post(
  '/:attemptId/events',
  requireRole('STUDENT'),
  validate({ params: attemptParams, body: z.object({ type: z.enum(['TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_BLUR', 'OFFLINE', 'ONLINE']) }) }),
  async (req, res) => {
    const { attempt } = await loadAttempt(req);
    if (attempt.studentId !== req.user.id) throw notFound('Attempt');
    if (attempt.status === 'IN_PROGRESS' && (await prisma.quizAttemptEvent.count({ where: { attemptId: attempt.id } })) < 500) {
      await prisma.quizAttemptEvent.create({ data: { attemptId: attempt.id, type: req.valid.body.type } });
    }
    noContent(res);
  },
);

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
      status: mine.some((a) => a.status === 'IN_PROGRESS') ? 'IN_PROGRESS' : finished.length > 0 ? (finished.some((a) => a.needsManualGrading) ? 'NEEDS_GRADING' : 'GRADED') : quiz.availableUntil && quiz.availableUntil <= now && isPublished(quiz, now) ? 'MISSING' : 'NOT_STARTED',
      attempts: mine.map((a) => ({ id: a.id, attemptNumber: a.attemptNumber, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, totalScore: a.totalScore, maxScore: a.maxScore, needsManualGrading: a.needsManualGrading })),
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
    where: { attempt: { quizId: quiz.id, status: { in: FINISHED } } },
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
  const label = { GRADED: 'Graded', NEEDS_GRADING: 'Needs grading', IN_PROGRESS: 'In progress', MISSING: 'Missing', NOT_STARTED: 'Not started' };
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
      { header: 'Status', value: (r) => label[r.status], width: 16, pdfWidth: 1.3 },
      { header: 'Submitted', value: (r) => (r.lastSubmittedAt ? `${dateKey(r.lastSubmittedAt, tz)} ${timeKey(r.lastSubmittedAt, tz)}` : ''), width: 18, pdfWidth: 1.6 },
    ],
    rows,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
  });
});
