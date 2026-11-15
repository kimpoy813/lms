// Question banks: a teacher's reusable questions, the import preview for questions that exist
// already (a test paper, or JSON), and their download as JSON.
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Prisma, prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { sendBuffer } from '../../lib/exporter.js';
import { created, idParams, noContent, ok, pageMeta, pageQuery, paging, patchOf, zId, zTitle } from '../../lib/http.js';
import { extractImportText, MAX_IMPORT_CHARS, parseImport } from '../../lib/questionImport.js';
import { CUT_OFF_NOTE, QuestionImportError, questionsToJson } from '../../lib/questionJson.js';
import { QUESTION_TYPES, normalizeQuestion, toEditorShape } from '../../lib/quizScoring.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';

export const banksRouter = Router();
banksRouter.use(requireAuth, requireRole('TEACHER', 'ADMIN'));

const bankParams = idParams('bankId');
// A document to import questions from. Never more than the server accepts as a single upload
// (function platforms cap the size of a request).
const MAX_IMPORT_BYTES = Math.min(10 * 1024 * 1024, env.maxUploadBytes);
// The uploaded paper is parsed in memory and discarded; it is never stored.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }).single('file');

/** A bank the user owns. Banks are private to their author. */
export async function loadBank(user, bankId, db = prisma) {
  const bank = await db.questionBank.findFirst({ where: { id: bankId, deletedAt: null } });
  if (!bank || bank.ownerId !== user.id) throw notFound('Question bank');
  return bank;
}

const questionSummary = (q) => ({ ...toEditorShape(q), excerpt: excerpt(q.text, 160), usedInQuizzes: q._count?.quizQuestions ?? 0 });

/** A validated question as its row is written: the text made safe, the explanation plain. */
const storedForm = (data) => ({ ...data, text: sanitizeRichText(data.text), explanation: data.explanation ? plainText(data.explanation, 5000) : null });

const sorted = (value) => (Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);

/**
 * What makes two questions the same question: what a student sees and how the answer is
 * scored. Points, difficulty and topic are not part of it. Takes a stored Question with its
 * choices, or `normalizeQuestion(input)` (its `data` and `choices`).
 */
export function questionFingerprint(question, choices = question.choices ?? []) {
  const row = question.data ? storedForm(question.data) : question;
  return JSON.stringify(sorted({
    type: row.type, text: row.text, explanation: row.explanation || null, answerKey: row.answerKey ?? null, settings: row.settings ?? {}, programmingProblemId: row.programmingProblemId ?? null,
    choices: [...choices].sort((a, b) => a.position - b.position).map((c) => [c.text, c.matchText ?? null, c.isCorrect === true]),
  }));
}

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
  const row = { ...storedForm(data), answerKey: data.answerKey ?? undefined };
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
    prisma.question.findMany({ where, include: { choices: true, _count: { select: { quizQuestions: { where: { quiz: { deletedAt: null } } } } } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], ...paging(q) }),
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

const NOT_YOUR_PROBLEM = 'A programming question belongs to a problem in your own account, and this one is not there. Choose one of your programming problems in the editor.';

/**
 * What is still wrong with each of these questions: [{ index, errors }], empty when all can be
 * saved. A programming question has to name a problem of this teacher.
 */
export async function questionProblems(user, questions, db = prisma) {
  const checked = questions.map((q) => normalizeQuestion(q));
  const wanted = [...new Set(checked.map((c) => c.data?.programmingProblemId).filter(Boolean))];
  const mine = wanted.length === 0 ? [] : await db.programmingProblem.findMany({ where: { id: { in: wanted.filter((id) => typeof id === 'string') }, ownerId: user.id, deletedAt: null }, select: { id: true } });
  const owned = new Set(mine.map((p) => p.id));
  return checked
    .map((c, index) => ({ index, errors: c.errors.length > 0 ? c.errors : c.data.programmingProblemId && !owned.has(c.data.programmingProblemId) ? [NOT_YOUR_PROBLEM] : [] }))
    .filter((p) => p.errors.length > 0);
}

/** Save many questions at once (after reviewing an import or an AI draft). All or nothing. */
banksRouter.post('/:bankId/questions/bulk', validate({ params: bankParams, body: z.object({ questions: z.array(questionInput).min(1).max(300) }) }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const problems = await questionProblems(req.user, req.valid.body.questions);
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
  const question = await prisma.question.findFirst({ where: { id: req.valid.params.questionId, deletedAt: null }, include: { choices: true, bank: true, _count: { select: { quizQuestions: { where: { quiz: { deletedAt: null } } } } } } });
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
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new AppError(413, 'FILE_TOO_LARGE', `The document is larger than ${Math.floor(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`));
      return reject(new AppError(400, 'UPLOAD_FAILED', 'The file could not be uploaded.'));
    });
  });
}

/**
 * The questions in what was sent — a file (JSON, Word, PDF, text) or pasted text — as drafts.
 * Nothing is saved.
 *
 * @param {(drafts: object[]) => void | Promise<void>} [mark] sets `duplicate: true` on the
 *        drafts that are there already, before they are counted
 * @returns {Promise<{ source: string, format: 'json' | 'text', questions: object[], summary: { found: number, ready: number, needsReview: number, duplicates: number, sections: string[] }, notes: string[] }>}
 *          each question in editor shape, with `number`, `warnings` and `errors`
 */
export async function readImportRequest(req, res, mark) {
  let text;
  let source;
  let filename = '';
  if (req.is('multipart/form-data')) {
    await runImportUpload(req, res);
    if (!req.file) throw fieldErrors({ file: 'Choose a file to import.' });
    filename = req.file.originalname;
    source = plainText(filename, 200);
    try {
      // One character more than is read, to know whether there was more.
      text = await extractImportText(req.file.buffer, filename, { limit: MAX_IMPORT_CHARS + 1 });
    } catch (err) {
      throw new AppError(422, 'IMPORT_UNREADABLE', err.message);
    }
  } else {
    text = typeof req.body?.text === 'string' ? req.body.text : '';
    source = 'Pasted text';
    if (!text.trim()) throw fieldErrors({ text: 'Paste the questions, or choose a file.' });
  }
  const cut = text.length > MAX_IMPORT_CHARS;
  let result;
  try {
    result = parseImport(text.slice(0, MAX_IMPORT_CHARS), { filename });
  } catch (err) {
    if (err instanceof QuestionImportError) throw new AppError(422, 'IMPORT_UNREADABLE', err.message);
    throw err;
  }
  // Said first: questions are missing, and this is why.
  if (cut) {
    result.notes = [
      `This is longer than ${MAX_IMPORT_CHARS.toLocaleString('en-US')} characters, the most that one import reads. Only the beginning was read: split it into parts and import each part.`,
      ...result.notes.filter((note) => note !== CUT_OFF_NOTE),
    ];
  }
  // A programming question names a problem in the account it was written in.
  for (const problem of await questionProblems(req.user, result.questions)) {
    const draft = result.questions[problem.index];
    if (draft.errors.length === 0) draft.errors = problem.errors;
  }
  await mark?.(result.questions);
  // Three groups that add up to what was found: one that is there already counts as that only.
  const fresh = result.questions.filter((q) => !q.duplicate);
  result.summary.duplicates = result.questions.length - fresh.length;
  result.summary.ready = fresh.filter((q) => q.errors.length === 0 && q.warnings.length === 0).length;
  result.summary.needsReview = fresh.length - result.summary.ready;
  return { source, ...result };
}

/** The text of a question as it is compared to find one that is there already. */
export const questionTextKey = (html) => excerpt(html, 500).toLowerCase();

/**
 * Read a file or pasted text into draft questions: JSON, or a test paper as a Word, PDF or text
 * document (docs/QUESTION-IMPORT.md). Nothing is saved: the teacher reviews and corrects the
 * drafts, then saves them with POST /:bankId/questions/bulk.
 *
 * Send the file as multipart field `file`, or pasted text as { text }.
 * Answers: { source, format: 'json' | 'text', questions, summary: { found, ready, needsReview, duplicates, sections }, notes }.
 * Each question is in editor shape with `number`, `warnings` (read, but worth a look), `errors`
 * (cannot be saved until corrected) and `duplicate: true` when the bank already has a question
 * with the same text. In the summary, found = ready + needsReview + duplicates.
 */
banksRouter.post('/:bankId/import/preview', uploadLimiter, validate({ params: bankParams }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const result = await readImportRequest(req, res, async (drafts) => {
    // Questions the bank already has: marked, for the teacher to leave out.
    const existing = await prisma.question.findMany({ where: { bankId: bank.id, deletedAt: null }, select: { text: true } });
    const have = new Set(existing.map((q) => questionTextKey(q.text)));
    for (const q of drafts) if (have.has(questionTextKey(q.text))) q.duplicate = true;
  });
  ok(res, result);
});

/**
 * The questions of a bank as a JSON file, answers included, in the format the import reads
 * (docs/QUESTION-IMPORT.md): a copy to keep, or to hand to a colleague.
 */
banksRouter.get('/:bankId/export', validate({ params: bankParams }), async (req, res) => {
  const bank = await loadBank(req.user, req.valid.params.bankId);
  const questions = await prisma.question.findMany({ where: { bankId: bank.id, deletedAt: null }, include: { choices: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  const file = questionsToJson(questions.map(toEditorShape), { title: bank.title });
  // The answers leave the system with this file: who took them, and when, is kept.
  await audit(req, { action: 'question_bank.export', entityType: 'QuestionBank', entityId: bank.id, summary: `Downloaded the ${questions.length} question(s) of the bank "${bank.title}" with their answers` });
  sendBuffer(res, Buffer.from(`${JSON.stringify(file, null, 2)}\n`), `${bank.title} questions.json`, 'application/json; charset=utf-8');
});
