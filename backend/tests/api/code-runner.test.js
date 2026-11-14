// Programs checked in Vercel Sandbox machines, seen from the API: a student's request ends in one
// machine per submission, the expected outputs stay on the server, and a judge that is busy, being
// prepared or out of its allowance is reported in a way the web app and the administrator can act
// on. Vercel's SDK is replaced by a pretend account (tests/helpers/fakeSandbox.js).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Before any application module loads (imports are hoisted; this is hoisted above them).
vi.hoisted(() => {
  process.env.CODE_RUNNER_PROVIDER = 'vercel-sandbox';
  process.env.CODE_RUNNER_REGION = 'sin1';
  // Not on Vercel here, so the judge needs an access token to count as set up.
  process.env.VERCEL_TOKEN = 'vcp_test_token';
  process.env.VERCEL_TEAM_ID = 'team_test';
  process.env.VERCEL_PROJECT_ID = 'prj_test';
  process.env.CRON_SECRET = 'secret-of-the-operator';
});

const { actor, anonymous, classroom, prepare, prisma } = await import('../helpers/index.js');
const { apiError, fakeSandboxAccount, okReport } = await import('../helpers/fakeSandbox.js');
const { env } = await import('../../src/config/env.js');
const { resetJudgeBackoff } = await import('../../src/modules/quizzes/routes.js');
const { resetCodeRunner } = await import('../../src/services/codeRunner.js');
const { operatorToken } = await import('../../src/lib/tokens.js');
const { IMAGE_TAG, imageName, setSandboxSdk } = await import('../../src/services/judge/vercelSandbox.js');

const NAME = imageName('sin1');

/**
 * What the runner in the machine would report for the little programs used here:
 * `print(int(input()) * N)`; "syntax error" does not compile; and a program that reads its
 * behaviour from the input ("loop", "crash", "memory", "flood") for mixed results.
 */
function pretendRunner(job) {
  if (job.selfTest) {
    const languages = Object.fromEntries(['PYTHON', 'JAVASCRIPT', 'C', 'CPP', 'JAVA'].map((id) => [id, { ok: true, compileMs: 50, runMs: 20, peakKb: 3000, detail: null }]));
    return { ...okReport(job), selfTest: { languages, versions: { PYTHON: 'Python 3.14.4', JAVA: 'javac 25.0.5' } } };
  }
  if (job.source.includes('syntax error')) return { ...okReport(job), compile: { ok: false, output: 'File "main.py", line 1\nSyntaxError: invalid syntax', timedOut: false, ms: 30 }, runs: [] };
  const factor = Number(/\* (\d+)/.exec(job.source)?.[1] ?? 1);
  const blank = { exitCode: null, signal: null, processLimit: false, stdout: '', stderr: '', ms: 5, peakKb: 3000 };
  const runs = job.tests.map((input) => {
    if (!job.source.includes('by input')) return { ...blank, status: 'ok', exitCode: 0, stdout: `${Number(input) * factor}\n` };
    if (input === '5') return { ...blank, status: 'timeout', signal: 'SIGKILL', ms: job.timeLimitMs };
    if (input === '7') return { ...blank, status: 'memory-limit', signal: 'SIGKILL' };
    if (input === '9') return { ...blank, status: 'ok', exitCode: 1, stderr: 'Traceback (most recent call last):\n  File "main.py", line 3\nZeroDivisionError: division by zero\n' };
    return { ...blank, status: 'ok', exitCode: 0, stdout: `${Number(input) * 2}\n` };
  });
  return { ...okReport(job), runs };
}

let fake;
const useAccount = (options = {}) => {
  fake = fakeSandboxAccount(NAME, { report: pretendRunner, ...options });
  setSandboxSdk(fake);
  return fake;
};
const forks = () => fake.calls.filter((c) => c[0] === 'fork').length;
/** Background work of the judge (stopping machines, looking after the image) has no handle here; give it a moment. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeAll(prepare);
beforeEach(() => {
  useAccount();
  resetJudgeBackoff();
  resetCodeRunner();
});
afterAll(() => setSandboxSdk(null));

const problemInput = (extra = {}) => ({
  title: 'Double it', statementHtml: '<p>Read a number and print twice its value.</p>', allowedLanguages: ['PYTHON', 'JAVA'],
  testCases: [
    { input: '2', expectedOutput: '4' },
    { input: '5', expectedOutput: 'SECRET-EXPECTED-TEN', isHidden: true },
    { input: '7', expectedOutput: 'SECRET-EXPECTED-FOURTEEN', isHidden: true, weight: 2 },
  ],
  ...extra,
});
const double = { language: 'PYTHON', code: 'print(int(input()) * 2)' };

async function room(testCases) {
  const made = await classroom(1);
  const body = testCases ? problemInput({ classId: made.cls.id, testCases }) : problemInput({ classId: made.cls.id, testCases: [{ input: '2', expectedOutput: '4' }, { input: '5', expectedOutput: '10', isHidden: true }, { input: '7', expectedOutput: '14', isHidden: true, weight: 2 }] });
  const created = await made.teacher.post('/api/programming/problems', body);
  expect(created.status).toBe(201);
  return { ...made, student: made.students[0], problemId: created.body.data.id };
}

describe('the configuration', () => {
  it('counts as set up, with the region the machines run in', async () => {
    expect(env.codeRunner).toMatchObject({ provider: 'vercel-sandbox', configured: true, region: 'sin1', vercelAccess: { token: 'vcp_test_token', teamId: 'team_test', projectId: 'prj_test' } });
    const { student } = await room();
    expect((await student.get('/api/programming/status')).body.data).toMatchObject({ configured: true, provider: 'vercel-sandbox', message: null });
  });
});

describe('a student’s program', () => {
  it('is checked in one machine, however many tests there are', async () => {
    const { student, problemId } = await room();
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, double);
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 3, totalCount: 3, scorePercent: 100 });
    expect(forks()).toBe(1);
    const fork = fake.calls.find((c) => c[0] === 'fork')[1];
    expect(fork).toMatchObject({ sourceSandbox: NAME, region: 'sin1', networkPolicy: 'deny-all', persistent: false, token: 'vcp_test_token', teamId: 'team_test', projectId: 'prj_test' });
    await settle();
    expect(fake.names().slice(-2)).toEqual(['stop', 'delete']);
  });

  it('never has the expected outputs near it: only the inputs are uploaded', async () => {
    const { student, problemId } = await room(problemInput().testCases);
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, double);
    expect(sent.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 1, totalCount: 3 });
    const uploaded = JSON.stringify(fake.machines[0].files);
    expect(uploaded).toContain('print(int(input()) * 2)');
    expect(uploaded).not.toMatch(/SECRET-EXPECTED/);
    expect(fake.machines[0].job).toMatchObject({ language: 'PYTHON', tests: ['2', '5', '7'], timeLimitMs: 3000, memoryLimitKb: 131072 });
    // Nor does the student get to see them, or the inputs of hidden tests.
    expect(JSON.stringify(sent.body)).not.toMatch(/SECRET-EXPECTED/);
    expect(sent.body.data.results.filter((r) => r.isHidden).every((r) => r.input === undefined && r.stdout === undefined)).toBe(true);
  });

  it('gets a verdict per test: too slow, out of memory, crashed', async () => {
    const { student, teacher, problemId } = await room([
      { input: '2', expectedOutput: '4' }, { input: '5', expectedOutput: '10' }, { input: '7', expectedOutput: '14' }, { input: '9', expectedOutput: '18' },
    ]);
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, { language: 'PYTHON', code: '# by input\nprint(int(input()) * 2)' });
    expect(sent.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 1, totalCount: 4, scorePercent: 25 });
    expect(sent.body.data.results.map((r) => r.outcome)).toEqual(['PASSED', 'TIME_LIMIT', 'RUNTIME_ERROR', 'RUNTIME_ERROR']);
    expect(sent.body.data.results[2].stderr).toBe('Memory limit exceeded (128 MB).');
    expect(sent.body.data.results[3].stderr).toMatch(/ZeroDivisionError/);
    // The teacher sees the same in the list of submissions.
    const listed = (await teacher.get(`/api/programming/problems/${problemId}/submissions`)).body.data;
    expect(listed[0]).toMatchObject({ passedCount: 1, totalCount: 4, status: 'COMPLETED' });
  });

  it('is told once when it does not compile', async () => {
    const { student, problemId } = await room();
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, { language: 'PYTHON', code: 'syntax error' });
    expect(sent.body.data).toMatchObject({ status: 'ERROR', passedCount: 0, totalCount: 3, scorePercent: 0, results: [] });
    expect(sent.body.data.errorMessage).toMatch(/SyntaxError: invalid syntax/);
    expect(forks()).toBe(1);
  });

  it('can be tried on the student’s own input, and on the samples only', async () => {
    const { student, problemId } = await room();
    const custom = await student.post(`/api/programming/problems/${problemId}/run`, { ...double, stdin: '21' });
    expect(custom.body.data).toMatchObject({ mode: 'CUSTOM', stdout: '42\n', exitCode: 0, timedOut: false, compileError: null });
    expect(fake.machines[0].job.tests).toEqual(['21']);
    const samples = await student.post(`/api/programming/problems/${problemId}/run`, double);
    expect(samples.body.data).toMatchObject({ mode: 'SAMPLES', passedCount: 1, totalCount: 1 });
    // A student's "run" sends the visible tests only; the hidden inputs stay behind.
    expect(fake.machines[1].job.tests).toEqual(['2']);
    expect(await prisma.programmingSubmission.count({ where: { problemId } })).toBe(0);
  });

  it('is refused in a language the problem does not allow, before any machine is started', async () => {
    const { student, problemId } = await room();
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, { language: 'C', code: 'int main(void) { return 0; }' });
    expect(sent.status).toBe(422);
    expect(sent.body.error.details.fields.language).toMatch(/Python 3, Java/);
    expect(fake.calls).toEqual([]);
  });
});

describe('a judge that cannot check right now', () => {
  it('says "busy" with a hint when to ask again, and records nothing', async () => {
    const { student, problemId } = await room();
    useAccount({ forkError: apiError(429, 'rate_limited', 'Too many sandboxes') });
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, double);
    expect(sent.status).toBe(503);
    expect(sent.body.error).toMatchObject({ code: 'CODE_RUNNER_BUSY', details: { retryAfterSeconds: 4 } });
    expect(sent.body.error.message).toMatch(/busy right now/);
    expect(JSON.stringify(sent.body)).not.toMatch(/rate_limited|Too many sandboxes/);
    expect(await prisma.programmingSubmission.count({ where: { problemId } })).toBe(0);
  });

  it('prepares its image when that is missing and tells the student to come back', async () => {
    const { student, problemId } = await room();
    useAccount({ image: 'missing' });
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, double);
    expect(sent.status).toBe(503);
    expect(sent.body.error).toMatchObject({ code: 'CODE_RUNNER_PREPARING', details: { retryAfterSeconds: 60 } });
    await settle();
    expect(fake.calls.find((c) => c[0] === 'create')[1]).toMatchObject({ name: NAME, region: 'sin1', persistent: true });
    expect(fake.calls.some((c) => c[0] === 'runCommand' && c[3].detached)).toBe(true);
  });

  it('keeps the reason for the administrator when the plan’s allowance is used up', async () => {
    const { student, problemId } = await room();
    const admin = await actor('ADMIN');
    useAccount({ forkError: apiError(402, 'payment_required', 'Sandbox creation is paused until the next cycle') });
    const sent = await student.post(`/api/programming/problems/${problemId}/submit`, double);
    expect(sent.status).toBe(503);
    expect(sent.body.error.code).toBe('CODE_RUNNER_UNAVAILABLE');
    expect(JSON.stringify(sent.body)).not.toMatch(/payment_required|paused/);
    const status = (await admin.get('/api/admin/status')).body.data.codeRunner;
    expect(status).toMatchObject({ configured: true, provider: 'vercel-sandbox', region: 'sin1' });
    expect(status.lastFailure).toMatch(/allowance for running programs is used up.*HTTP 402 payment_required: Sandbox creation is paused/);
    expect(Date.parse(status.lastFailureAt)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('the administrator’s check', () => {
  it('runs a small program in every language and shows what came back', async () => {
    const admin = await actor('ADMIN');
    const checked = await admin.post('/api/admin/code-runner/check', {});
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ ok: true, provider: 'vercel-sandbox', region: 'sin1', identity: 'access token', limits: 'cgroup', versions: { PYTHON: 'Python 3.14.4' } });
    expect(Object.keys(checked.body.data.languages)).toEqual(['PYTHON', 'JAVASCRIPT', 'C', 'CPP', 'JAVA']);
    expect(checked.body.data.timings.totalMs).toEqual(expect.any(Number));
    expect(fake.machines[0].job).toMatchObject({ selfTest: true });
    expect(forks()).toBe(1);
    expect(Date.parse((await admin.get('/api/admin/status')).body.data.codeRunner.lastSuccessAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('gives the reason in full when it fails, unlike what a student is told', async () => {
    const admin = await actor('ADMIN');
    useAccount({ forkError: apiError(401, 'unauthorized', 'The OIDC token is not valid for this project') });
    const checked = await admin.post('/api/admin/code-runner/check', {});
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ ok: false, provider: 'vercel-sandbox', code: 'CODE_RUNNER_UNAVAILABLE' });
    expect(checked.body.data.detail).toMatch(/not allowed to start machines.*HTTP 401 unauthorized: The OIDC token is not valid/);
  });

  it('is for administrators only', async () => {
    const { teacher, student } = await room();
    expect((await teacher.post('/api/admin/code-runner/check', {})).status).toBe(403);
    expect((await student.post('/api/admin/code-runner/check', {})).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });
});

describe('the operator’s check, without signing in', () => {
  const address = (token) => `/api/internal/code-runner-check${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`;

  it('answers whoever holds the value derived from the operator’s secret', async () => {
    const answer = await anonymous().get(address(operatorToken('secret-of-the-operator', 'code runner check')));
    expect(answer.status).toBe(200);
    expect(answer.body.data).toMatchObject({ ok: true, provider: 'vercel-sandbox', region: 'sin1', identity: 'access token', limits: 'cgroup' });
    expect(Object.keys(answer.body.data.languages)).toHaveLength(5);
    expect(forks()).toBe(1);
  });

  it('does not exist for anybody else, and starts nothing', async () => {
    for (const token of [undefined, '', 'secret-of-the-operator', operatorToken('another secret', 'code runner check'), operatorToken('secret-of-the-operator', 'start-up report')]) {
      const answer = await anonymous().get(address(token));
      expect(answer.status, String(token)).toBe(404);
    }
    const signedIn = await actor('ADMIN');
    expect((await signedIn.get(address())).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });
});

describe('a program in a quiz that was never checked', () => {
  async function codingQuiz() {
    const made = await room();
    const quiz = (await made.teacher.post(`/api/classes/${made.cls.id}/quizzes`, { title: 'Coding quiz', resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES' })).body.data;
    expect((await made.teacher.post(`/api/quizzes/${quiz.id}/questions`, { question: { type: 'PROGRAMMING', points: 10, text: '<p>Double the number.</p>', programmingProblemId: made.problemId } })).status).toBe(201);
    expect((await made.teacher.patch(`/api/quizzes/${quiz.id}`, { status: 'PUBLISHED' })).status).toBe(200);
    const started = await made.student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true });
    expect(started.status).toBe(201);
    const attempt = (await made.student.get(`/api/attempts/${started.body.data.attemptId}`)).body.data;
    expect((await made.student.put(`/api/attempts/${attempt.id}/answers/0`, { response: double })).status).toBe(200);
    return { ...made, attempt };
  }

  it('is checked when the quiz is handed in, waiting a little for a busy judge', async () => {
    const { student, attempt } = await codingQuiz();
    // Busy twice, as when a whole class hands in in the same minute; then there is room.
    let refusals = 2;
    const fork = fake.Sandbox.fork;
    fake.Sandbox.fork = async (params) => {
      if (refusals > 0) {
        refusals -= 1;
        fake.calls.push(['fork-refused']);
        throw apiError(429, 'rate_limited', 'Too many sandboxes');
      }
      return fork(params);
    };
    const handedIn = await student.post(`/api/attempts/${attempt.id}/submit`);
    expect(handedIn.status).toBe(200);
    expect(handedIn.body.data).toMatchObject({ status: 'SUBMITTED', awaitingGrading: false, totalScore: 10 });
    expect(fake.calls.filter((c) => c[0] === 'fork-refused')).toHaveLength(2);
    expect(await prisma.programmingSubmission.count({ where: { studentAnswerId: attempt.questions[0].answerId } })).toBe(1);
  });

  it('is left for the teacher when the judge stays busy, and handing in still works', async () => {
    const { student, attempt } = await codingQuiz();
    useAccount({ forkError: apiError(429, 'rate_limited', 'Too many sandboxes') });
    const handedIn = await student.post(`/api/attempts/${attempt.id}/submit`);
    expect(handedIn.status).toBe(200);
    expect(handedIn.body.data).toMatchObject({ status: 'SUBMITTED', awaitingGrading: true });
    // Asked three times in all, then gave up.
    expect(forks()).toBe(3);
    expect(await prisma.programmingSubmission.count({ where: { studentAnswerId: attempt.questions[0].answerId } })).toBe(0);
  });
});

describe('the image tag', () => {
  it('is what the pretend runner reports, so these tests would notice a recipe that is not checked', () => {
    expect(okReport({ tests: [] }).image).toBe(IMAGE_TAG);
  });
});
