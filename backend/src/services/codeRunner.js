// Code execution for programming exercises.
//
// EduSphere NEVER runs student code inside its own process or on its own host. Code is sent to an
// external, sandboxed judge service (a Piston-compatible HTTP API: https://github.com/engineer-man/piston).
// When no judge is configured the feature reports itself as unavailable; programming answers can
// still be collected and are then graded by the teacher.
import { env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

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
/** Tests replace the HTTP transport with a fake judge. Pass null to restore the default. */
export function setCodeRunnerTransport(fn) {
  transport = fn;
}

export const codeRunnerConfigured = () => Boolean(transport) || env.codeRunner.configured;

export function codeRunnerStatus() {
  return {
    configured: codeRunnerConfigured(),
    provider: codeRunnerConfigured() ? (transport ? 'test' : env.codeRunner.provider) : 'none',
    languages: Object.entries(LANGUAGES).map(([id, l]) => ({ id, label: l.label })),
    message: codeRunnerConfigured() ? null : 'Automatic code checking is not set up on this server. Answers are saved and checked by the teacher.',
  };
}

/** Run one program. Throws 503 CODE_RUNNER_UNAVAILABLE when no judge is configured or reachable. */
export async function runCode({ language, code, stdin = '', timeLimitMs = 3000, memoryLimitKb = 131072 }) {
  if (!LANGUAGES[language]) throw new AppError(422, 'UNSUPPORTED_LANGUAGE', 'That programming language is not supported.');
  if (!codeRunnerConfigured()) throw unavailable('Automatic code checking is not set up on this server.', 'CODE_RUNNER_UNAVAILABLE');
  try {
    const out = await (transport ?? pistonTransport)({ language, code, stdin, timeLimitMs, memoryLimitKb });
    const timedOut = out.signal === 'SIGKILL' || out.timedOut === true;
    return { stdout: clip(out.stdout), stderr: clip(out.stderr), exitCode: out.exitCode ?? null, timedOut, compileError: out.compileError ? clip(out.compileError) : null };
  } catch (err) {
    logger.warn({ err: err.message }, 'code runner request failed');
    throw unavailable('The code checking service did not respond. Please try again in a moment.', 'CODE_RUNNER_UNAVAILABLE');
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
  const results = [];
  for (const t of cases) {
    const run = await runCode({ language, code, stdin: t.input, timeLimitMs: problem.timeLimitMs, memoryLimitKb: problem.memoryLimitKb });
    if (run.compileError) {
      return { status: 'ERROR', results: [], passedCount: 0, totalCount: cases.length, scorePercent: 0, errorMessage: run.compileError.slice(0, 4000) };
    }
    const passed = !run.timedOut && run.exitCode === 0 && compareOutput(run.stdout, t.expectedOutput, t.comparison);
    results.push({
      testCaseId: t.id, position: t.position, isHidden: t.isHidden, weight: t.weight, passed,
      outcome: passed ? 'PASSED' : run.timedOut ? 'TIME_LIMIT' : run.exitCode !== 0 ? 'RUNTIME_ERROR' : 'WRONG_ANSWER',
      input: t.input, expectedOutput: t.expectedOutput, stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000),
    });
  }
  return { status: 'COMPLETED', results, passedCount: results.filter((r) => r.passed).length, totalCount: results.length, scorePercent: scoreResults(results, problem.partialCredit), errorMessage: null };
}

/** What a student may see of a result: hidden tests show only whether they passed. */
export const maskResult = (r) => (r.isHidden ? { position: r.position, isHidden: true, passed: r.passed, outcome: r.outcome } : { position: r.position, isHidden: false, passed: r.passed, outcome: r.outcome, input: r.input, expectedOutput: r.expectedOutput, stdout: r.stdout, stderr: r.stderr });
