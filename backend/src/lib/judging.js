// What the checker does with the output of a program, apart from running it: cut it to size,
// compare it with the expected output, turn test results into a score.
//
// Nothing else is imported here, so that scripts can use it without the application's
// configuration. The web app checks sample tests of Python programs itself and has the same
// comparison and the same limits (frontend/src/lib/pyRunner/judge.js); a test holds the two
// together (frontend/src/lib/pyRunner/judge.test.js).

const MAX_OUTPUT = 64_000;

/** One run or one submission checks at most this many test cases; any further ones are left out. */
export const MAX_TESTS = 25;

/** Long output is cut before it is stored or sent. */
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

/** Weighted score of a set of test results (0–100). */
export function scoreResults(results, partialCredit = true) {
  const total = results.reduce((a, r) => a + r.weight, 0);
  if (total <= 0) return 0;
  const passed = results.filter((r) => r.passed).reduce((a, r) => a + r.weight, 0);
  if (!partialCredit) return passed === total ? 100 : 0;
  return Math.round((passed / total) * 10_000) / 100;
}
