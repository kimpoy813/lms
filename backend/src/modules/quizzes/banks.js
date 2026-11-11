// Question banks: a teacher's reusable questions, and the import preview for existing test papers.
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma, prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { created, idParams, noContent, ok, pageMeta, pageQuery, paging, patchOf, zId, zTitle } from '../../lib/http.js';
import { extractImportText, parseQuestions } from '../../lib/questionImport.js';
import { QUESTION_TYPES, normalizeQuestion, toEditorShape } from '../../lib/quizScoring.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';

export const banksRouter = Router();
banksRouter.use(requireAuth, requireRole('TEACHER', 'ADMIN'));

const bankParams = idParams('bankId');
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
// The uploaded paper is parsed in memory and discarded; it is never stored.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }).single('file');

/** A bank the user owns. Banks are private to their author. */
export async function loadBank(user, bankId, db = prisma) {
  const bank = await db.questionBank.findFirst({ where: { id: bankId, deletedAt: null } });
  if (!bank || bank.ownerId !== user.id) throw notFound('Question bank');
  return bank;
}

const questionSummary = (q) => ({ ...toEditorShape(q), excerpt: excerpt(q.text, 160), usedInQuizzes: q._count?.quizQuestions ?? 0 });

/**
 * Validate and store one question.
 * @returns the created or updated Question with its choices
 */
export async function saveQuestion(tx, user, bankId, input, { questionId = null, position = 0 } = {}) {
  const { errors, data, choices } = normalizeQuestion(input);
  if (errors.length > 0) throw new AppError(422, 'INVALID_QUESTION', errors[0], { errors });
  if (data.programmingProblemId) {
    const problem = await tx.programmingProblem.findFirst({ where: { id: data.programmingProblemId, ownerId: user.id, deletedAt: null }, select: { id: true } });
    if (!problem) throw new AppError(422, 'INVALID_QUESTION', 'Choose one of your programming problems.', { errors: ['Choose one of your programming problems.'] });
  }
  const row = { ...data, text: sanitizeRichText(data.text), explanation: data.explanation ? plainText(data.explanation, 5000) : null, answerKey: data.answerKey ?? undefined };
  if (questionId) {
    await tx.answerChoice.deleteMany({ where: { questionId } });
    return tx.question.update({ where: { id: questionId }, data: { ...row, answerKey: data.answerKey ?? Prisma.DbNull, choices: { create: choices } }, include: { choices: true } });
  }
  return tx.question.create({ data: { ...row, bankId, position, choices: { create: choices } }, include: { choices: true } });
}

/** The bank used when a teacher writes a question straight into a quiz. */
export async function defaultBankFor(tx, user, cls) {
  const title = `${cls.course.code} question bank`;
  const existing = await tx.questionBank.findFirst({ where: { ownerId: user.id, title, deletedAt: null } });
  return existing ?? tx.questionBank.create({ data: { ownerId: user.id, title, subject: cls.course.title } });
}

// ── Banks ────────────────────────────────────────────────────────────────────
banksRouter.get('/', async (req, res) => {
  const banks = await prisma.questionBank.findMany({ where: { ownerId: req.user.id, deletedAt: null }, orderBy: { updatedAt: 'desc' } });
  const counts = await prisma.question.groupBy({ by: ['bankId', 'type'], where: { bankId: { in: banks.map((b) => b.id) }, deletedAt: null }, _count: { _all: true } });
  ok(res, banks.map((b) => {
    const mine = counts.filter((c) => c.bankId === b.id);
    return {
      id: b.id, title: b.title, subject: b.subject, description: b.description, updatedAt: b.updatedAt,
      questionCount: mine.reduce((s, c) => s + c._count._all, 0),
      byType: Object.fromEntries(mine.map((c) => [c.type, c._count._all])),
    };
  }));
});

const bankBody = z.object({ title: zTitle, subject: z.string().trim().max(120).nullable().optional(), description: z.string().trim().max(1000).nullable().optional() });
const bankData = (b) => ({
  ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
  ...(b.subject !== undefined ? { subject: b.subject ? plainText(b.subject, 120) : null } : {}),
  ...(b.description !== undefined ? { description: b.description ? plainText(b.description, 1000) : null } : {}),
});

banksRouter.post('/', validate({ body: bankBody }), async (req, res) => {
  const bank = await prisma.questionBank.create({ data: { ownerId: req.user.id, ...bankData(req.valid.body) } });
  created(res, { id: bank.id, title: bank.title, subject: bank.subject, description: bank.description, questionCount: 0, byType: {}, updatedAt: bank.updatedAt });
});

banksRouter.patch('/:bankId', validate({ params: bankParams, body: patchOf(bankBody) }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const updated = await prisma.questionBank.update({ where: { id: bank.id }, data: bankData(req.valid.body) });
  ok(res, { id: updated.id, title: updated.title, subject: updated.subject, description: updated.description, updatedAt: updated.updatedAt });
});

banksRouter.delete('/:bankId', validate({ params: bankParams }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const pools = await prisma.quizQuestionPool.count({ where: { bankId: bank.id, quiz: { deletedAt: null } } });
  if (pools > 0) throw conflict(`${pools} quiz(zes) draw random questions from this bank. Remove those question pools first.`, 'BANK_IN_USE');
  // Questions already placed in quizzes stay usable there; the bank just disappears from the list.
  await prisma.questionBank.update({ where: { id: bank.id }, data: { deletedAt: new Date() } });
  noContent(res);
});

// ── Questions ────────────────────────────────────────────────────────────────
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  topic: z.string().trim().max(120).optional(),
  ...pageQuery,
});

banksRouter.get('/:bankId/questions', validate({ params: bankParams, query: listQuery }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const q = req.valid.query;
  const where = {
    bankId: bank.id, deletedAt: null,
    ...(q.type ? { type: q.type } : {}),
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    ...(q.topic ? { topic: q.topic } : {}),
    ...(q.search ? { text: { contains: q.search, mode: 'insensitive' } } : {}),
  };
  const [total, rows, topics] = await Promise.all([
    prisma.question.count({ where }),
    prisma.question.findMany({ where, include: { choices: true, _count: { select: { quizQuestions: true } } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], ...paging(q) }),
    prisma.question.findMany({ where: { bankId: bank.id, deletedAt: null, topic: { not: null } }, distinct: ['topic'], select: { topic: true }, orderBy: { topic: 'asc' } }),
  ]);
  ok(res, rows.map(questionSummary), { ...pageMeta(q, total), topics: topics.map((t) => t.topic) });
});

const questionInput = z.object({ type: z.string() }).passthrough();

banksRouter.post('/:bankId/questions', validate({ params: bankParams, body: questionInput }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const question = await prisma.$transaction(async (tx) => {
    const last = await tx.question.aggregate({ where: { bankId: bank.id, deletedAt: null }, _max: { position: true } });
    return saveQuestion(tx, req.user, bank.id, req.valid.body, { position: (last._max.position ?? -1) + 1 });
  });
  created(res, questionSummary(question));
});

/** Save many questions at once (after reviewing an import or an AI draft). All or nothing. */
banksRouter.post('/:bankId/questions/bulk', validate({ params: bankParams, body: z.object({ questions: z.array(questionInput).min(1).max(300) }) }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const problems = req.valid.body.questions.map((q, index) => ({ index, errors: normalizeQuestion(q).errors })).filter((p) => p.errors.length > 0);
  if (problems.length > 0) {
    throw new AppError(422, 'INVALID_QUESTIONS', `${problems.length} question(s) still need to be fixed before they can be saved.`, { questions: problems });
  }
  const saved = await prisma.$transaction(async (tx) => {
    const last = await tx.question.aggregate({ where: { bankId: bank.id, deletedAt: null }, _max: { position: true } });
    let position = (last._max.position ?? -1) + 1;
    const rows = [];
    for (const q of req.valid.body.questions) {
      rows.push(await saveQuestion(tx, req.user, bank.id, q, { position }));
      position += 1;
    }
    return rows;
  }, { timeout: 60_000 });
  created(res, { saved: saved.length, questionIds: saved.map((q) => q.id) });
});

async function loadQuestion(req) {
  const question = await prisma.question.findFirst({ where: { id: req.valid.params.questionId, deletedAt: null }, include: { choices: true, bank: true, _count: { select: { quizQuestions: true } } } });
  if (!question || question.bank.ownerId !== req.user.id || question.bank.deletedAt) throw notFound('Question');
  return question;
}

banksRouter.get('/questions/:questionId', validate({ params: idParams('questionId') }), async (req, res) => {
  ok(res, questionSummary(await loadQuestion(req)));
});

banksRouter.put('/questions/:questionId', validate({ params: idParams('questionId'), body: questionInput }), async (req, res) => {
  const question = await loadQuestion(req);
  // Attempts keep their own copy of each question, so editing never changes a quiz already taken.
  const updated = await prisma.$transaction((tx) => saveQuestion(tx, req.user, question.bankId, req.valid.body, { questionId: question.id }));
  ok(res, questionSummary({ ...updated, _count: question._count }));
});

banksRouter.post('/questions/:questionId/copy', validate({ params: idParams('questionId'), body: z.object({ bankId: zId.optional() }) }), async (req, res) => {
  const question = await loadQuestion(req);
  const target = req.valid.body.bankId ? await loadBank(req.user, req.valid.body.bankId) : question.bank;
  const copy = await prisma.$transaction(async (tx) => {
    const last = await tx.question.aggregate({ where: { bankId: target.id, deletedAt: null }, _max: { position: true } });
    return saveQuestion(tx, req.user, target.id, toEditorShape(question), { position: (last._max.position ?? -1) + 1 });
  });
  created(res, questionSummary(copy));
});

banksRouter.delete('/questions/:questionId', validate({ params: idParams('questionId') }), async (req, res) => {
  const question = await loadQuestion(req);
  const inDrafts = await prisma.quizQuestion.count({ where: { questionId: question.id, quiz: { deletedAt: null } } });
  if (inDrafts > 0) throw conflict(`This question is used in ${inDrafts} quiz(zes). Remove it from them first.`, 'QUESTION_IN_USE');
  await prisma.question.update({ where: { id: question.id }, data: { deletedAt: new Date() } });
  noContent(res);
});

// ── Import preview ───────────────────────────────────────────────────────────
function runImportUpload(req, res) {
  return new Promise((resolve, reject) => {
    importUpload(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new AppError(413, 'FILE_TOO_LARGE', 'The document is larger than 10 MB.'));
      return reject(new AppError(400, 'UPLOAD_FAILED', 'The file could not be uploaded.'));
    });
  });
}

/**
 * Parse a document into draft questions. Nothing is saved: the teacher reviews and corrects the
 * drafts, then saves them with POST /:bankId/questions/bulk.
 */
banksRouter.post('/:bankId/import/preview', uploadLimiter, validate({ params: bankParams }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  let text;
  let source;
  if (req.is('multipart/form-data')) {
    await runImportUpload(req, res);
    if (!req.file) throw fieldErrors({ file: 'Choose a file to import.' });
    source = plainText(req.file.originalname, 200);
    try {
      text = await extractImportText(req.file.buffer, req.file.originalname);
    } catch (err) {
      throw new AppError(422, 'IMPORT_UNREADABLE', err.message);
    }
  } else {
    text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 400_000) : '';
    source = 'Pasted text';
    if (!text.trim()) throw fieldErrors({ text: 'Paste the questions, or choose a file.' });
  }
  const result = parseQuestions(text);
  // Warn about questions the bank already has.
  const existing = await prisma.question.findMany({ where: { bankId: bank.id, deletedAt: null }, select: { text: true } });
  const have = new Set(existing.map((q) => excerpt(q.text, 500).toLowerCase()));
  for (const q of result.questions) {
    if (have.has(excerpt(q.text, 500).toLowerCase())) q.warnings.push('A question with the same text is already in this bank.');
  }
  result.summary.ready = result.questions.filter((q) => q.errors.length === 0 && q.warnings.length === 0).length;
  result.summary.needsReview = result.questions.length - result.summary.ready;
  ok(res, { source, ...result });
});
