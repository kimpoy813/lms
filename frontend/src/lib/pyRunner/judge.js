// What the server's checker does with the output of a run, done here for a run in the browser:
// the same comparison, the same limits, the same wording (backend/src/lib/judging.js,
// services/codeRunner.js and services/judge/vercelSandbox.js). A test holds the two together
// (judge.test.js, which reads the server's own code).

const MAX_OUTPUT = 64_000;

/** As on the server: at most this many test cases are run at a time. */
export const MAX_TESTS = 25;

/** Long output is cut the way the server cuts it. */
export function clip(text) {
  const s = String(text ?? '');
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (output truncated)` : s;
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

const note = (text, addition) => (text && text.trim() ? `${text.replace(/\n+$/, '')}\n${addition}` : addition);

const seconds = (ms) => {
  const s = Math.round(ms / 100) / 10;
  return `${s} ${s === 1 ? 'second' : 'seconds'}`;
};

/**
 * What the worker reports about one run → the run as the server would describe it.
 * @param {{ stdout: string, stderr: string, exitCode: number, outputLimit: boolean, exception: string | null }} raw
 */
export function toRun(raw) {
  const out = { stdout: clip(raw.stdout), stderr: clip(raw.stderr), exitCode: raw.exitCode ?? null, timedOut: false };
  if (raw.outputLimit) return { ...out, exitCode: 1, stderr: clip(note(raw.stderr, 'Output limit exceeded: the program printed more than 64 KB.')) };
  // The interpreter ends an uncaught KeyboardInterrupt by stopping itself with that signal.
  if (raw.exception === 'KeyboardInterrupt') return { ...out, exitCode: 1, stderr: clip(note(raw.stderr, 'The program was stopped by SIGINT.')) };
  return out;
}

/** A run that was stopped here because it took too long, and the runs after it that were not started. */
export const stoppedRun = ({ stdout = '', stderr = '', budgetMs, timeLimitMs }) => ({
  stdout: clip(stdout), exitCode: null, timedOut: true,
  stderr: clip(note(stderr, `Stopped after ${seconds(budgetMs)} on this device. On the server a test may take ${seconds(timeLimitMs)}.`)),
});
export const notRun = () => ({ stdout: '', exitCode: null, timedOut: true, stderr: 'Not run: an earlier test took too long.' });

/**
 * Judge runs against test cases, as the server's `judge` does.
 * @param {{ id?: string, input: string, expectedOutput: string, comparison?: string, isHidden?: boolean, weight?: number }[]} cases
 * @param {{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean }[]} runs one per case, in order
 */
export function judgeRuns(cases, runs) {
  const results = cases.map((t, position) => {
    const run = runs[position] ?? { stdout: '', stderr: 'This test was not run.', exitCode: null, timedOut: false };
    const passed = !run.timedOut && run.exitCode === 0 && compareOutput(run.stdout, t.expectedOutput, t.comparison);
    return {
      testCaseId: t.id, position, isHidden: t.isHidden === true, weight: t.weight ?? 1, passed,
      outcome: passed ? 'PASSED' : run.timedOut ? 'TIME_LIMIT' : run.exitCode !== 0 ? 'RUNTIME_ERROR' : 'WRONG_ANSWER',
      input: t.input, expectedOutput: t.expectedOutput, stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000),
    };
  });
  return { status: 'COMPLETED', errorMessage: null, results, passedCount: results.filter((r) => r.passed).length, totalCount: results.length };
}

const tokens = (text) => String(text ?? '').match(/[^\s,;:()[\]{}<>'"=]+/g) ?? [];
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** The same words and numbers, in another order: what a set printed by a 32-bit and by a 64-bit Python looks like. */
function sameInAnotherOrder(a, e) {
  const left = tokens(a);
  const right = tokens(e);
  if (left.length === 0 || left.length !== right.length || left.every((token, i) => token === right[i])) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((token, i) => token === sorted[i]);
}

/** The same text but for the last digits of some decimal numbers: two machines' mathematics libraries. */
function sameButForLastDigits(a, e) {
  const left = tokens(a);
  const right = tokens(e);
  if (left.length === 0 || left.length !== right.length) return false;
  let numbersDiffer = false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    if (!NUMBER.test(left[i]) || !NUMBER.test(right[i])) return false;
    const x = Number(left[i]);
    const y = Number(right[i]);
    if (!(Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)))) return false;
    numbersDiffer = true;
  }
  return numbersDiffer;
}

/**
 * A wrong answer that may not be one: the output differs from the expected output only in ways
 * the browser's Python differs from the server's. The server is then asked instead.
 */
export function mayBeTheBrowser(actual, expected) {
  return sameInAnotherOrder(actual, expected) || sameButForLastDigits(actual, expected);
}
