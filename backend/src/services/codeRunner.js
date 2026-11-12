// Code execution for programming exercises.
//
// EduSphere NEVER runs student code inside its own process or on its own host. Code is sent to a
// judge outside it. Two kinds are supported (CODE_RUNNER_PROVIDER):
//   - "vercel-sandbox": a throw-away virtual machine per submission on the Vercel account the site
//     is deployed to (services/judge/vercelSandbox.js). Nothing to host.
//   - "piston": a server you run, with a Piston-compatible HTTP API
//     (https://github.com/engineer-man/piston).
// When no judge is configured the feature reports itself as unavailable; programming answers can
// still be collected and are then graded by the teacher.
import { env } from '../config/env.js';
import { runInBackground } from '../lib/background.js';
import { AppError, unavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { JudgeUnavailable, createSandboxJudge, describeError } from './judge/vercelSandbox.js';

export const LANGUAGES = {
  PYTHON: { label: 'Python 3', piston: 'python', file: 'main.py' },
  JAVA: { label: 'Java', piston: 'java', file: 'Main.java' },
  C: { label: 'C', piston: 'c', file: 'main.c' },
  CPP: { label: 'C++', piston: 'c++', file: 'main.cpp' },
  JAVASCRIPT: { label: 'JavaScript (Node.js)', piston: 'javascript', file: 'main.js' },
};

const MAX_OUTPUT = 64_000;
const MAX_TESTS = 25;
const clip = (text) => {
  const s = String(text ?? '');
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (output truncated)` : s;
};

async function pistonTransport({ language, code, stdin, timeLimitMs, memoryLimitKb }) {
  const lang = LANGUAGES[language];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.codeRunner.timeoutMs);
  try {
    const res = await fetch(`${env.codeRunner.url}/execute`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(env.codeRunner.apiKey ? { authorization: `Bearer ${env.codeRunner.apiKey}` } : {}) },
      body: JSON.stringify({
        language: lang.piston, version: '*', files: [{ name: lang.file, content: code }], stdin: stdin ?? '',
        compile_timeout: 10_000, run_timeout: Math.min(Math.max(timeLimitMs, 500), 15_000), run_memory_limit: memoryLimitKb * 1024,
      }),
    });
    if (!res.ok) throw new Error(`judge responded with HTTP ${res.status}`);
    const body = await res.json();
    const compileFailed = body.compile && body.compile.code !== 0 && body.compile.code !== null && body.compile.code !== undefined;
    return {
      stdout: body.run?.stdout ?? '', stderr: body.run?.stderr ?? '', exitCode: body.run?.code ?? null, signal: body.run?.signal ?? null,
      compileError: compileFailed ? String(body.compile.stderr || body.compile.output || 'Compilation failed') : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

let transport = null;
/** Tests replace the judge with a fake that runs one program on one input. Pass null to restore the default. */
export function setCodeRunnerTransport(fn) {
  transport = fn;
}

let sandboxJudge = null;
/** The Vercel Sandbox judge of this installation (made on first use). */
export function vercelSandboxJudge() {
  sandboxJudge ??= createSandboxJudge({
    region: env.codeRunner.region,
    credentials: env.codeRunner.vercelAccess ? () => env.codeRunner.vercelAccess : undefined,
    log: logger,
    background: runInBackground,
  });
  return sandboxJudge;
}

const usesSandbox = () => !transport && env.codeRunner.provider === 'vercel-sandbox';

/** For tests: forget what the judge remembers between requests (an image that was not ready, the last failure). */
export function resetCodeRunner() {
  sandboxJudge = null;
  Object.assign(health, { lastSuccessAt: null, lastFailureAt: null, lastFailure: null });
}

export const codeRunnerConfigured = () => Boolean(transport) || env.codeRunner.configured;

export function codeRunnerStatus() {
  return {
    configured: codeRunnerConfigured(),
    provider: codeRunnerConfigured() ? (transport ? 'test' : env.codeRunner.provider) : 'none',
    languages: Object.entries(LANGUAGES).map(([id, l]) => ({ id, label: l.label })),
    message: codeRunnerConfigured() ? null : 'Automatic code checking is not set up on this server.',
  };
}

/** What the last attempts to reach the judge looked like, for the administrator (this process only). */
const health = { lastSuccessAt: null, lastFailureAt: null, lastFailure: null };
export const codeRunnerHealth = () => ({ ...health });

/** A judge that cannot be used right now → the error the client gets. Details go to the log, not to the student. */
function unavailableError(err) {
  const kind = err instanceof JudgeUnavailable ? err.kind : 'failed';
  health.lastFailureAt = new Date().toISOString();
  health.lastFailure = describeError(err);
  logger.warn({ kind, detail: health.lastFailure }, 'the code judge could not check a program');
  if (kind === 'busy') return new AppError(503, 'CODE_RUNNER_BUSY', 'The code checker is busy right now. Please try again in a few seconds.', { retryAfterSeconds: 4 });
  if (kind === 'preparing') return new AppError(503, 'CODE_RUNNER_PREPARING', 'The machine that runs programs is being prepared. This takes a few minutes; please try again shortly.', { retryAfterSeconds: 60 });
  return unavailable('The code checking service did not respond. Please try again in a moment.', 'CODE_RUNNER_UNAVAILABLE');
}

/**
 * Run one program on several inputs: compiled once, then started once per input.
 * Throws 503 when no judge is configured (CODE_RUNNER_UNAVAILABLE), when it is busy
 * (CODE_RUNNER_BUSY) or still being set up (CODE_RUNNER_PREPARING), or cannot be reached.
 * @returns {Promise<{ compileError: string | null, runs: { stdout, stderr, exitCode, timedOut }[] }>}
 *   `runs` has one entry per input, in order; it is empty when the program did not compile.
 */
export async function runBatch({ language, code, inputs, timeLimitMs = 3000, memoryLimitKb = 131072 }) {
  if (!LANGUAGES[language]) throw new AppError(422, 'UNSUPPORTED_LANGUAGE', 'That programming language is not supported.');
  if (!codeRunnerConfigured()) throw unavailable('Automatic code checking is not set up on this server.', 'CODE_RUNNER_UNAVAILABLE');
  try {
    let result;
    if (usesSandbox()) {
      const out = await vercelSandboxJudge().runBatch({ language, code, inputs: inputs.map((input) => input ?? ''), timeLimitMs, memoryLimitKb });
      logger.info({ language, tests: inputs.length, limits: out.limits, ...out.timings }, 'program checked in a sandbox machine');
      result = { compileError: out.compileError, runs: out.runs };
    } else {
      // One request per input. A program that does not compile says so on the first one.
      result = { compileError: null, runs: [] };
      for (const stdin of inputs) {
        const out = await (transport ?? pistonTransport)({ language, code, stdin: stdin ?? '', timeLimitMs, memoryLimitKb });
        if (out.compileError) {
          result = { compileError: out.compileError, runs: [] };
          break;
        }
        result.runs.push({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode ?? null, timedOut: out.signal === 'SIGKILL' || out.timedOut === true });
      }
    }
    health.lastSuccessAt = new Date().toISOString();
    return {
      compileError: result.compileError ? clip(result.compileError) : null,
      runs: result.runs.map((run) => ({ stdout: clip(run.stdout), stderr: clip(run.stderr), exitCode: run.exitCode ?? null, timedOut: run.timedOut === true })),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailableError(err);
  }
}

/** Run one program on one input. Throws like runBatch. */
export async function runCode({ language, code, stdin = '', timeLimitMs = 3000, memoryLimitKb = 131072 }) {
  const { compileError, runs } = await runBatch({ language, code, inputs: [stdin], timeLimitMs, memoryLimitKb });
  const run = runs[0] ?? { stdout: '', stderr: '', exitCode: null, timedOut: false };
  return { ...run, compileError };
}

/**
 * For the administrator: start a machine and run one small program in every language.
 * @returns {Promise<{ ok: boolean, provider: string, languages?: object, versions?: object, limits?: string, timings?: object, detail?: string }>}
 */
export async function checkCodeRunner() {
  if (!codeRunnerConfigured()) return { ok: false, provider: 'none', detail: 'No code runner is set up (CODE_RUNNER_PROVIDER).' };
  if (usesSandbox()) {
    try {
      const check = await vercelSandboxJudge().selfTest();
      health.lastSuccessAt = new Date().toISOString();
      return { ok: check.ok, provider: 'vercel-sandbox', languages: check.languages, versions: check.versions, limits: check.isolation?.limits, timings: check.timings };
    } catch (err) {
      const error = unavailableError(err);
      return { ok: false, provider: 'vercel-sandbox', code: error.code, detail: describeError(err) };
    }
  }
  // Another judge: one program that doubles a number.
  const provider = transport ? 'test' : env.codeRunner.provider;
  const started = Date.now();
  try {
    const run = await runCode({ language: 'PYTHON', code: 'print(int(input()) * 2)\n', stdin: '21\n' });
    const ok = !run.compileError && run.exitCode === 0 && run.stdout.trim() === '42';
    return { ok, provider, languages: { PYTHON: { ok, runMs: Date.now() - started, detail: ok ? null : (run.compileError || run.stderr || run.stdout || 'no output').slice(0, 300) } }, timings: { totalMs: Date.now() - started } };
  } catch (err) {
    return { ok: false, provider, code: err.code, detail: health.lastFailure ?? err.message };
  }
}

const lines = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

/** Compare program output with the expected output. */
export function compareOutput(actual, expected, mode = 'TRIMMED') {
  const a = lines(actual);
  const e = lines(expected);
  if (mode === 'EXACT') return a === e;
  if (mode === 'TOKENS') return a.split(/\s+/).filter(Boolean).join(' ') === e.split(/\s+/).filter(Boolean).join(' ');
  const tidy = (s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  return tidy(a) === tidy(e);
}

/** Weighted score of a set of test results (0–100). */
export function scoreResults(results, partialCredit = true) {
  const total = results.reduce((a, r) => a + r.weight, 0);
  if (total <= 0) return 0;
  const passed = results.filter((r) => r.passed).reduce((a, r) => a + r.weight, 0);
  if (!partialCredit) return passed === total ? 100 : 0;
  return Math.round((passed / total) * 10_000) / 100;
}

/**
 * Judge a program against test cases.
 * @returns {{ status: 'COMPLETED'|'ERROR', results: object[], passedCount, totalCount, scorePercent, errorMessage }}
 */
export async function judge(problem, testCases, { language, code }) {
  const cases = testCases.slice(0, MAX_TESTS);
  // Only the inputs leave this process. The expected outputs stay here and are compared here.
  const { compileError, runs } = await runBatch({ language, code, inputs: cases.map((t) => t.input), timeLimitMs: problem.timeLimitMs, memoryLimitKb: problem.memoryLimitKb });
  if (compileError) {
    return { status: 'ERROR', results: [], passedCount: 0, totalCount: cases.length, scorePercent: 0, errorMessage: compileError.slice(0, 4000) };
  }
  const results = cases.map((t, i) => {
    // A judge that answered for fewer tests than it was given: the rest count as not passed.
    const run = runs[i] ?? { stdout: '', stderr: 'This test was not run.', exitCode: null, timedOut: false };
    const passed = !run.timedOut && run.exitCode === 0 && compareOutput(run.stdout, t.expectedOutput, t.comparison);
    return {
      testCaseId: t.id, position: t.position, isHidden: t.isHidden, weight: t.weight, passed,
      outcome: passed ? 'PASSED' : run.timedOut ? 'TIME_LIMIT' : run.exitCode !== 0 ? 'RUNTIME_ERROR' : 'WRONG_ANSWER',
      input: t.input, expectedOutput: t.expectedOutput, stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000),
    };
  });
  return { status: 'COMPLETED', results, passedCount: results.filter((r) => r.passed).length, totalCount: results.length, scorePercent: scoreResults(results, problem.partialCredit), errorMessage: null };
}

/** What a student may see of a result: hidden tests show only whether they passed. */
export const maskResult = (r) => (r.isHidden ? { position: r.position, isHidden: true, passed: r.passed, outcome: r.outcome } : { position: r.position, isHidden: false, passed: r.passed, outcome: r.outcome, input: r.input, expectedOutput: r.expectedOutput, stdout: r.stdout, stderr: r.stderr });
