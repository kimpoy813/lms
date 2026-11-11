// Programming problems with automatic checking through an external judge (see services/codeRunner.js).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, patchOf, zHtml, zId, zTitle } from '../../lib/http.js';
import { plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { isPublished } from '../../lib/visibility.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { codeRunLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { LANGUAGES, codeRunnerStatus, judge, maskResult, runCode } from '../../services/codeRunner.js';
import { classLabel, loadClassAccess, requireWritableClassManager } from '../classes/access.js';

export const programmingRouter = Router();
programmingRouter.use(requireAuth);

const languageIds = Object.keys(LANGUAGES);
const zLanguage = z.enum(languageIds);
const zCode = z.string().min(1).max(100_000);

programmingRouter.get('/status', (req, res) => ok(res, codeRunnerStatus()));

const caseBody = z.object({
  input: z.string().max(20_000).default(''),
  expectedOutput: z.string().max(20_000),
  isHidden: z.boolean().default(false),
  weight: z.number().min(0).max(100).default(1),
  comparison: z.enum(['EXACT', 'TRIMMED', 'TOKENS']).default('TRIMMED'),
});
const problemBody = z.object({
  title: zTitle,
  statementHtml: zHtml.default(''),
  classId: zId.nullable().optional(),
  allowedLanguages: z.array(zLanguage).min(1).max(languageIds.length).default(['PYTHON']),
  // partialRecord: starter code is optional per language (z.record with an enum key would demand every language).
  starterCode: z.partialRecord(zLanguage, z.string().max(20_000)).default({}),
  timeLimitMs: z.number().int().min(500).max(15_000).default(3000),
  memoryLimitKb: z.number().int().min(16_384).max(524_288).default(131_072),
  partialCredit: z.boolean().default(true),
  testCases: z.array(caseBody).min(1).max(25),
});

const include = { testCases: { orderBy: { position: 'asc' } }, class: { include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } } };

function problemView(p, forStudent) {
  const cases = forStudent ? p.testCases.filter((t) => !t.isHidden) : p.testCases;
  return {
    id: p.id, title: p.title, statementHtml: p.statementHtml, classId: p.classId, classLabel: p.class ? classLabel(p.class) : null,
    allowedLanguages: p.allowedLanguages, starterCode: p.starterCode ?? {}, timeLimitMs: p.timeLimitMs, memoryLimitKb: p.memoryLimitKb,
    testCases: cases.map((t) => ({ id: t.id, input: t.input, expectedOutput: t.expectedOutput, ...(forStudent ? {} : { isHidden: t.isHidden, weight: t.weight, comparison: t.comparison }) })),
    hiddenTestCount: p.testCases.filter((t) => t.isHidden).length,
    ...(forStudent ? {} : { partialCredit: p.partialCredit, updatedAt: p.updatedAt }),
  };
}

/**
 * Load a problem for the signed-in user.
 * Students reach a problem through (a) a class it is shared with as practice, (b) a published
 * assignment, or (c) a question of a quiz attempt that is still running.
 */
async function loadProblem(user, problemId, { studentAnswerId } = {}) {
  const problem = await prisma.programmingProblem.findFirst({ where: { id: problemId, deletedAt: null }, include });
  if (!problem) throw notFound('Programming problem');
  if (user.role === 'ADMIN' || problem.ownerId === user.id) return { problem, manage: true, answer: null };
  if (user.role !== 'STUDENT') throw notFound('Programming problem');

  if (studentAnswerId) {
    const answer = await prisma.studentAnswer.findFirst({ where: { id: studentAnswerId, attempt: { studentId: user.id } }, include: { attempt: { select: { status: true, deadlineAt: true } } } });
    if (!answer || answer.snapshot?.programmingProblemId !== problem.id) throw notFound('Programming problem');
    return { problem, manage: false, answer };
  }
  const enrolled = async (classId) => Boolean(await prisma.enrollment.findFirst({ where: { classId, studentId: user.id, status: 'ENROLLED' }, select: { id: true } }));
  if (problem.classId && (await enrolled(problem.classId))) return { problem, manage: false, answer: null };
  const assignments = await prisma.assignment.findMany({ where: { programmingProblemId: problem.id, deletedAt: null }, select: { classId: true, status: true, publishAt: true } });
  for (const a of assignments) if (isPublished(a) && (await enrolled(a.classId))) return { problem, manage: false, answer: null };
  const inAttempt = await prisma.studentAnswer.findFirst({ where: { attempt: { studentId: user.id }, snapshot: { path: ['programmingProblemId'], equals: problem.id } }, select: { id: true } });
  if (inAttempt) return { problem, manage: false, answer: null };
  throw notFound('Programming problem');
}

programmingRouter.get('/problems', validate({ query: z.object({ classId: zId.optional(), search: z.string().trim().max(80).optional() }) }), async (req, res) => {
  const { classId, search } = req.valid.query;
  const text = search ? { title: { contains: search, mode: 'insensitive' } } : {};
  if (req.user.role === 'STUDENT') {
    // Practice problems shared with the student's classes.
    const classIds = classId ? [(await loadClassAccess(req.user, classId)).cls.id] : (await prisma.enrollment.findMany({ where: { studentId: req.user.id, status: 'ENROLLED' }, select: { classId: true } })).map((e) => e.classId);
    const problems = await prisma.programmingProblem.findMany({ where: { deletedAt: null, classId: { in: classIds }, ...text }, include, orderBy: { createdAt: 'desc' }, take: 200 });
    const best = await prisma.programmingSubmission.groupBy({ by: ['problemId'], where: { studentId: req.user.id, problemId: { in: problems.map((p) => p.id) }, status: 'COMPLETED' }, _max: { scorePercent: true } });
    const bestOf = new Map(best.map((b) => [b.problemId, b._max.scorePercent]));
    return ok(res, problems.map((p) => ({ id: p.id, title: p.title, classId: p.classId, classLabel: p.class ? classLabel(p.class) : null, allowedLanguages: p.allowedLanguages, bestScore: bestOf.get(p.id) ?? null })));
  }
  const problems = await prisma.programmingProblem.findMany({
    where: { deletedAt: null, ...(req.user.role === 'ADMIN' ? {} : { ownerId: req.user.id }), ...(classId ? { classId } : {}), ...text },
    include: { ...include, _count: { select: { submissions: true } } }, orderBy: { updatedAt: 'desc' }, take: 300,
  });
  return ok(res, problems.map((p) => ({ id: p.id, title: p.title, classId: p.classId, classLabel: p.class ? classLabel(p.class) : null, allowedLanguages: p.allowedLanguages, testCases: p.testCases.length, submissions: p._count.submissions, updatedAt: p.updatedAt })));
});

function checkProblem(b) {
  if (b.testCases && !b.testCases.some((t) => t.weight > 0)) throw fieldErrors({ testCases: 'At least one test case must count towards the score.' });
  if (b.starterCode && b.allowedLanguages) {
    for (const lang of Object.keys(b.starterCode)) if (!b.allowedLanguages.includes(lang)) throw fieldErrors({ starterCode: `Starter code was given for ${LANGUAGES[lang].label}, which is not an allowed language.` });
  }
}

programmingRouter.post('/problems', requireRole('TEACHER', 'ADMIN'), validate({ body: problemBody }), async (req, res) => {
  const b = req.valid.body;
  checkProblem(b);
  if (b.classId) await requireWritableClassManager(req.user, b.classId);
  const problem = await prisma.programmingProblem.create({
    data: {
      ownerId: req.user.id, classId: b.classId ?? null, title: plainText(b.title, 200), statementHtml: sanitizeRichText(b.statementHtml), allowedLanguages: [...new Set(b.allowedLanguages)],
      starterCode: b.starterCode, timeLimitMs: b.timeLimitMs, memoryLimitKb: b.memoryLimitKb, partialCredit: b.partialCredit,
      testCases: { create: b.testCases.map((t, position) => ({ ...t, position })) },
    },
    include,
  });
  created(res, problemView(problem, false));
});

programmingRouter.get('/problems/:problemId', validate({ params: idParams('problemId'), query: z.object({ studentAnswerId: zId.optional() }) }), async (req, res) => {
  const { problem, manage } = await loadProblem(req.user, req.valid.params.problemId, req.valid.query);
  ok(res, { ...problemView(problem, !manage), runner: codeRunnerStatus() });
});

programmingRouter.patch('/problems/:problemId', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('problemId'), body: patchOf(problemBody) }), async (req, res) => {
  const { problem } = await loadProblem(req.user, req.valid.params.problemId);
  const b = req.valid.body;
  checkProblem({ ...b, allowedLanguages: b.allowedLanguages ?? problem.allowedLanguages });
  if (b.classId) await requireWritableClassManager(req.user, b.classId);
  const updated = await prisma.$transaction(async (tx) => {
    if (b.testCases) {
      await tx.programmingTestCase.deleteMany({ where: { problemId: problem.id } });
      await tx.programmingTestCase.createMany({ data: b.testCases.map((t, position) => ({ ...t, position, problemId: problem.id })) });
    }
    return tx.programmingProblem.update({
      where: { id: problem.id },
      data: {
        ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
        ...(b.statementHtml !== undefined ? { statementHtml: sanitizeRichText(b.statementHtml) } : {}),
        ...(b.classId !== undefined ? { classId: b.classId } : {}),
        ...(b.allowedLanguages !== undefined ? { allowedLanguages: [...new Set(b.allowedLanguages)] } : {}),
        ...(b.starterCode !== undefined ? { starterCode: b.starterCode } : {}),
        ...(b.timeLimitMs !== undefined ? { timeLimitMs: b.timeLimitMs } : {}),
        ...(b.memoryLimitKb !== undefined ? { memoryLimitKb: b.memoryLimitKb } : {}),
        ...(b.partialCredit !== undefined ? { partialCredit: b.partialCredit } : {}),
      },
      include,
    });
  });
  ok(res, problemView(updated, false));
});

programmingRouter.delete('/problems/:problemId', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('problemId') }), async (req, res) => {
  const { problem } = await loadProblem(req.user, req.valid.params.problemId);
  const used = await prisma.question.count({ where: { programmingProblemId: problem.id, deletedAt: null } });
  if (used > 0) throw conflict('This problem is used by a question. Remove the question first.', 'PROBLEM_IN_USE');
  await prisma.programmingProblem.update({ where: { id: problem.id }, data: { deletedAt: new Date() } });
  noContent(res);
});

const runBody = z.object({ language: zLanguage, code: zCode, stdin: z.string().max(20_000).optional(), studentAnswerId: zId.optional() });

function assertLanguage(problem, language) {
  if (!problem.allowedLanguages.includes(language)) throw fieldErrors({ language: `This problem accepts: ${problem.allowedLanguages.map((l) => LANGUAGES[l].label).join(', ')}.` });
}

function assertAttemptOpen(answer) {
  if (!answer) return;
  const { status, deadlineAt } = answer.attempt;
  if (status !== 'IN_PROGRESS' || (deadlineAt && deadlineAt.getTime() + 5000 < Date.now())) throw conflict('This attempt has ended.', 'ATTEMPT_CLOSED');
}

/** Try the code: with your own input, or against the visible sample tests. Nothing is recorded. */
programmingRouter.post('/problems/:problemId/run', codeRunLimiter, validate({ params: idParams('problemId'), body: runBody }), async (req, res) => {
  const b = req.valid.body;
  const { problem, manage, answer } = await loadProblem(req.user, req.valid.params.problemId, b);
  assertLanguage(problem, b.language);
  assertAttemptOpen(answer);
  if (b.stdin !== undefined) {
    const run = await runCode({ language: b.language, code: b.code, stdin: b.stdin, timeLimitMs: problem.timeLimitMs, memoryLimitKb: problem.memoryLimitKb });
    return ok(res, { mode: 'CUSTOM', ...run });
  }
  const cases = manage ? problem.testCases : problem.testCases.filter((t) => !t.isHidden);
  const result = await judge(problem, cases, b);
  return ok(res, { mode: 'SAMPLES', status: result.status, errorMessage: result.errorMessage, passedCount: result.passedCount, totalCount: result.totalCount, results: result.results.map(manage ? (r) => r : maskResult) });
});

/** Check the code against every test case and record the result. */
programmingRouter.post('/problems/:problemId/submit', requireRole('STUDENT'), codeRunLimiter, validate({ params: idParams('problemId'), body: runBody.omit({ stdin: true }) }), async (req, res) => {
  const b = req.valid.body;
  const { problem, answer } = await loadProblem(req.user, req.valid.params.problemId, b);
  assertLanguage(problem, b.language);
  assertAttemptOpen(answer);
  const result = await judge(problem, problem.testCases, b);
  const row = await prisma.programmingSubmission.create({
    data: {
      problemId: problem.id, studentId: req.user.id, studentAnswerId: answer?.id ?? null, language: b.language, code: b.code,
      status: result.status, results: result.results, passedCount: result.passedCount, totalCount: result.totalCount, scorePercent: result.scorePercent, errorMessage: result.errorMessage,
    },
  });
  // Inside a quiz the checked code also becomes the saved answer of that question.
  if (answer) await prisma.studentAnswer.update({ where: { id: answer.id }, data: { response: { language: b.language, code: b.code }, answeredAt: new Date() } });
  created(res, { id: row.id, status: row.status, errorMessage: row.errorMessage, passedCount: row.passedCount, totalCount: row.totalCount, scorePercent: row.scorePercent, results: result.results.map(maskResult), createdAt: row.createdAt });
});

programmingRouter.get('/problems/:problemId/submissions', validate({ params: idParams('problemId'), query: z.object({ studentId: zId.optional() }) }), async (req, res) => {
  const { problem, manage } = await loadProblem(req.user, req.valid.params.problemId);
  const rows = await prisma.programmingSubmission.findMany({
    where: { problemId: problem.id, ...(manage ? (req.valid.query.studentId ? { studentId: req.valid.query.studentId } : {}) : { studentId: req.user.id }) },
    include: { student: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 200,
  });
  ok(res, rows.map((r) => ({
    id: r.id, student: manage ? { id: r.student.id, name: fullName(r.student) } : undefined, language: r.language, code: r.code, status: r.status, errorMessage: r.errorMessage,
    passedCount: r.passedCount, totalCount: r.totalCount, scorePercent: r.scorePercent, createdAt: r.createdAt,
    results: (Array.isArray(r.results) ? r.results : []).map(manage ? (x) => x : maskResult),
  })));
});
