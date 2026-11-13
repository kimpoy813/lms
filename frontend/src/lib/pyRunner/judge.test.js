// @vitest-environment node
import { describe, expect, it } from 'vitest';
// The server's own comparison: the two must never drift apart.
import { MAX_TESTS as SERVER_MAX_TESTS, clip as serverClip, compareOutput as serverCompare } from '../../../../backend/src/lib/judging.js';
import { MAX_TESTS, clip, compareOutput, judgeRuns, mayBeTheBrowser, notRun, stoppedRun, toRun } from './judge.js';

describe('comparing output the way the server does', () => {
  const outputs = ['', 'a', 'a\n', 'a \n', ' a', 'a\r\n', 'a\rb', 'a\n\n\n', 'a  b', 'a b', 'a\tb\n', 'A', '1\n2\n', '1 2', '1\n 2\n', '  ', '\n', 'x\n\ny', 'x\ny', 'x \n y \n'];

  it.each(['EXACT', 'TRIMMED', 'TOKENS', undefined])('agrees with the server for every pair of outputs (%s)', (mode) => {
    for (const actual of outputs) for (const expected of outputs) expect([actual, expected, compareOutput(actual, expected, mode)]).toEqual([actual, expected, serverCompare(actual, expected, mode)]);
  });

  it('means what the problem editor says it means', () => {
    expect(compareOutput('a \n\n', 'a')).toBe(true); // TRIMMED: spaces at the end of a line and empty lines at the end do not count
    expect(compareOutput(' a', 'a')).toBe(false);
    expect(compareOutput('a\n', 'a', 'EXACT')).toBe(false);
    expect(compareOutput('1\n2', '1   2\n', 'TOKENS')).toBe(true);
  });

  it('cuts long output where the server cuts it', () => {
    for (const text of ['short', 'x'.repeat(64_000), 'x'.repeat(64_001), null, undefined, 12]) expect(clip(text)).toBe(serverClip(text));
    expect(clip('x'.repeat(70_000))).toHaveLength(64_000 + '\n… (output truncated)'.length);
  });

  it('runs as many test cases as the server would', () => {
    expect(MAX_TESTS).toBe(SERVER_MAX_TESTS);
    expect(MAX_TESTS).toBe(25);
  });
});

describe('a run in the browser, said the way the server says it', () => {
  const raw = (extra) => ({ stdout: 'out\n', stderr: '', exitCode: 0, outputLimit: false, exception: null, ...extra });

  it('leaves an ordinary run as it is', () => {
    expect(toRun(raw())).toEqual({ stdout: 'out\n', stderr: '', exitCode: 0, timedOut: false });
    expect(toRun(raw({ exitCode: 3, stderr: 'boom\n' }))).toEqual({ stdout: 'out\n', stderr: 'boom\n', exitCode: 3, timedOut: false });
  });

  it('reports a program that printed too much as the server does', () => {
    expect(toRun(raw({ outputLimit: true, exitCode: 130, exception: 'KeyboardInterrupt' }))).toEqual({ stdout: 'out\n', stderr: 'Output limit exceeded: the program printed more than 64 KB.', exitCode: 1, timedOut: false });
    expect(toRun(raw({ outputLimit: true, stderr: 'warning\n' })).stderr).toBe('warning\nOutput limit exceeded: the program printed more than 64 KB.');
  });

  it('reports an interruption the program raised itself as the signal it ends with', () => {
    expect(toRun(raw({ exitCode: 130, exception: 'KeyboardInterrupt', stderr: 'Traceback…\nKeyboardInterrupt\n' }))).toEqual({ stdout: 'out\n', stderr: 'Traceback…\nKeyboardInterrupt\nThe program was stopped by SIGINT.', exitCode: 1, timedOut: false });
  });

  it('says honestly where a program was stopped for taking too long', () => {
    expect(stoppedRun({ stdout: 'before\n', budgetMs: 9000, timeLimitMs: 3000 })).toEqual({ stdout: 'before\n', exitCode: null, timedOut: true, stderr: 'Stopped after 9 seconds on this device. On the server a test may take 3 seconds.' });
    expect(stoppedRun({ budgetMs: 3000, timeLimitMs: 1000 }).stderr).toBe('Stopped after 3 seconds on this device. On the server a test may take 1 second.');
    expect(stoppedRun({ stderr: 'careful\n', budgetMs: 4500, timeLimitMs: 1500 }).stderr).toBe('careful\nStopped after 4.5 seconds on this device. On the server a test may take 1.5 seconds.');
    expect(notRun()).toEqual({ stdout: '', exitCode: null, timedOut: true, stderr: 'Not run: an earlier test took too long.' });
  });
});

describe('judging runs against test cases', () => {
  const cases = [
    { id: 'a', input: '1\n', expectedOutput: '2', comparison: 'TRIMMED' },
    { id: 'b', input: '2\n', expectedOutput: '4', comparison: 'EXACT', isHidden: true, weight: 3 },
    { id: 'c', input: '3\n', expectedOutput: '6' },
    { id: 'd', input: '4\n', expectedOutput: '8' },
    { id: 'e', input: '5\n', expectedOutput: '10' },
  ];
  const run = (stdout, extra) => ({ stdout, stderr: '', exitCode: 0, timedOut: false, ...extra });

  it('gives each test the outcome the server would give it', () => {
    const judged = judgeRuns(cases, [run('2\n'), run('4\n'), run('7\n'), run('', { exitCode: 1, stderr: 'ZeroDivisionError' }), run('', { exitCode: null, timedOut: true })]);
    expect(judged.results.map((r) => r.outcome)).toEqual(['PASSED', 'WRONG_ANSWER', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'TIME_LIMIT']);
    expect(judged).toMatchObject({ status: 'COMPLETED', errorMessage: null, passedCount: 1, totalCount: 5 });
    expect(judged.results[1]).toEqual({ testCaseId: 'b', position: 1, isHidden: true, weight: 3, passed: false, outcome: 'WRONG_ANSWER', input: '2\n', expectedOutput: '4', stdout: '4\n', stderr: '' });
    expect(judged.results[0]).toMatchObject({ isHidden: false, weight: 1 });
  });

  it('does not let a right answer pass when the program ended badly', () => {
    expect(judgeRuns([cases[0]], [run('2\n', { exitCode: 1 })]).results[0]).toMatchObject({ passed: false, outcome: 'RUNTIME_ERROR' });
    expect(judgeRuns([cases[0]], [run('2\n', { timedOut: true, exitCode: null })]).results[0]).toMatchObject({ passed: false, outcome: 'TIME_LIMIT' });
  });

  it('counts a test without a run as not passed, and keeps what is shown short', () => {
    const judged = judgeRuns(cases.slice(0, 2), [run('x'.repeat(5000), { stderr: 'e'.repeat(3000) })]);
    expect(judged.results[0].stdout).toHaveLength(4000);
    expect(judged.results[0].stderr).toHaveLength(2000);
    expect(judged.results[1]).toMatchObject({ passed: false, outcome: 'RUNTIME_ERROR', stderr: 'This test was not run.' });
  });
});

describe('a wrong answer that may be the browser’s Python and not the program', () => {
  it.each([
    // What the two really printed, from fixtures/reference.json and a run under Pyodide.
    ['a set of negative numbers', '{0, 3, -2, -5, -100, -1}\n', '{0, 3, -1, -5, -100, -2}\n'],
    ['a set of decimal numbers', '{1.5, 2.25, 100.75, 3.14159, 0.3, 0.2, 0.1}\n', '{0.1, 1.5, 2.25, 0.3, 0.2, 100.75, 3.14159}\n'],
    ['a set of pairs', '{(0, 0), (1, 2), (5, 6), (3, 4), (2, 1)}\n(2, 2)\n(1, 1)\n(3, 3)\n', '{(1, 2), (2, 1), (3, 4), (0, 0), (5, 6)}\n(1, 1)\n(3, 3)\n(2, 2)\n'],
    ['the last digit of a cube root', '1.2599210498948732\n', '1.2599210498948734\n'],
    ['the last digit of a power, among other text', 'Balance after 11 years: 1731.2736294213546 (rate 1.887748625363387)', 'Balance after 11 years: 1731.2736294213546 (rate 1.8877486253633868)'],
    ['a number written with an exponent', 'x = 9.99994433575849e-161', 'x = 9.999944335758491e-161'],
  ])('%s', (what, here, expected) => {
    expect(mayBeTheBrowser(here, expected)).toBe(true);
  });

  it.each([
    ['another answer', 'ODD\n', 'EVEN\n'],
    ['another number', '41\n', '42\n'],
    ['a number that is close but not the same', '3.14\n', '3.15\n'],
    ['a rounded number where an exact one is expected', '0.33\n', '0.3333333333333333\n'],
    ['a missing line', '1\n2\n', '1\n2\n3\n'],
    ['an extra word', 'total 5 items\n', 'total 5\n'],
    ['other words around the same numbers', 'sum = 5\n', 'total = 5\n'],
    ['nothing at all', '', '42\n'],
    ['the same text', '42\n', '42\n'],
  ])('is not claimed for %s', (what, here, expected) => {
    expect(mayBeTheBrowser(here, expected)).toBe(false);
  });

  it('also takes a list in the wrong order to the server, which says it is wrong', () => {
    // It cannot be told from a set here; the server's answer is the same as before this existed.
    expect(mayBeTheBrowser('3 1 2\n', '1 2 3\n')).toBe(true);
  });
});
