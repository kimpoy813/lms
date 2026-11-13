import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { askAgainWhileBusy, browserRunStatus, PYTHON_IN_BROWSER_BYTES, runnerProblem, totalTimeHint } from './codeRunner.js';
import { classicWorkerSource } from './pyRunner/sandbox.js';

const busy = (retryAfterSeconds) => Object.assign(new Error('busy'), { code: 'CODE_RUNNER_BUSY', details: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds } });

describe('askAgainWhileBusy', () => {
  it('asks again after the wait the server suggested, a little longer each time', async () => {
    const waits = [];
    let calls = 0;
    const result = await askAgainWhileBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw busy(4);
        return 'checked';
      },
      { wait: async (ms) => { waits.push(ms); } },
    );
    expect(result).toBe('checked');
    expect(calls).toBe(3);
    expect(waits).toEqual([4000, 6000]);
  });

  it('gives up after the allowed number of tries and passes the last answer on', async () => {
    let calls = 0;
    const seen = [];
    await expect(askAgainWhileBusy(async () => { calls += 1; throw busy(); }, { retries: 2, wait: async () => {}, onWait: (attempt, seconds) => seen.push([attempt, seconds]) })).rejects.toMatchObject({ code: 'CODE_RUNNER_BUSY' });
    expect(calls).toBe(3);
    expect(seen).toEqual([[1, 4], [2, 6]]);
  });

  it('never waits longer than ten seconds, whatever the server says', async () => {
    const waits = [];
    let calls = 0;
    await askAgainWhileBusy(async () => { calls += 1; if (calls === 1) throw busy(600); return 1; }, { wait: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([10_000]);
  });

  it('does not repeat a request that failed for another reason', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('no'), { code: 'CODE_RUNNER_UNAVAILABLE' });
    await expect(askAgainWhileBusy(async () => { calls += 1; throw failure; }, { wait: async () => {} })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('stops when nobody is waiting for the answer any more', async () => {
    let calls = 0;
    let wanted = true;
    await expect(askAgainWhileBusy(async () => { calls += 1; throw busy(1); }, { wait: async () => { wanted = false; }, stillWanted: () => wanted })).rejects.toMatchObject({ code: 'CODE_RUNNER_BUSY' });
    expect(calls).toBe(1);
  });
});

describe('runnerProblem', () => {
  it('tells a student in a quiz that the code is kept', () => {
    expect(runnerProblem({ code: 'CODE_RUNNER_PREPARING' }, { inQuiz: true })).toMatch(/being prepared.*saved with your answer/);
    expect(runnerProblem({ code: 'CODE_RUNNER_UNAVAILABLE' }, { inQuiz: true })).toMatch(/your teacher will mark it/);
    expect(runnerProblem({ code: 'CODE_RUNNER_BUSY' })).toMatch(/busy.*try again in a minute/);
  });

  it('shows the message for a field, then the server’s own message', () => {
    expect(runnerProblem({ code: 'VALIDATION_ERROR', fields: { language: 'This problem accepts: Python 3.' }, message: 'Please correct the highlighted fields.' })).toBe('This problem accepts: Python 3.');
    expect(runnerProblem({ code: 'ATTEMPT_CLOSED', message: 'This attempt has ended.' })).toBe('This attempt has ended.');
  });
});

describe('totalTimeHint', () => {
  it('says nothing while every test can use its full time', () => {
    expect(totalTimeHint(50_000, 10, 3000)).toBeUndefined();
    expect(totalTimeHint(50_000, 25, 2000)).toBeUndefined();
    expect(totalTimeHint(null, 25, 15_000)).toBeUndefined();
    expect(totalTimeHint(50_000, 0, 3000)).toBeUndefined();
  });

  it('tells how many tests a slow program gets through', () => {
    expect(totalTimeHint(50_000, 25, 3000)).toBe('The checker gives one program 50 seconds for all its tests together. A program that needs the full 3 s every time gets through about 16 of these 25 tests; the rest then count as too slow.');
    expect(totalTimeHint(50_000, 5, 15_000)).toMatch(/full 15 s every time gets through about 3 of these 5 tests/);
    expect(totalTimeHint(50_000, 2, 60_000)).toMatch(/about 1 of these 2 tests/);
  });
});

describe('Python in the browser', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const pyodide = path.resolve(here, '..', '..', 'node_modules', 'pyodide');
  const installed = fs.existsSync(pyodide) ? pyodide : path.resolve(here, '..', '..', '..', 'node_modules', 'pyodide');

  it('says what is happening while a program is run', () => {
    expect(browserRunStatus({ phase: 'download', bytes: 0 })).toBe('Getting Python ready… 0%');
    expect(browserRunStatus({ phase: 'download', bytes: PYTHON_IN_BROWSER_BYTES / 2 })).toBe('Getting Python ready… 50%');
    // Never "100%" while something is still to come.
    expect(browserRunStatus({ phase: 'download', bytes: PYTHON_IN_BROWSER_BYTES * 2 })).toBe('Getting Python ready… 99%');
    expect(browserRunStatus({ phase: 'start' })).toBe('Starting Python…');
    expect(browserRunStatus({ phase: 'run', index: 0, total: 1 })).toBe('Running your program…');
    expect(browserRunStatus({ phase: 'run', index: 1, total: 3 })).toBe('Running test 2 of 3…');
    expect(browserRunStatus({ phase: 'something else' })).toBeNull();
    expect(browserRunStatus()).toBeNull();
  });

  it('knows how much there is to download, so that the percentage is true', () => {
    // The five files lib/pyRunner/sandbox.js fetches. A new version of Pyodide changes the sum.
    const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
    expect(files.reduce((sum, name) => sum + fs.statSync(path.join(installed, name)).size, 0)).toBe(PYTHON_IN_BROWSER_BYTES);
    const sandbox = fs.readFileSync(path.join(here, 'pyRunner', 'sandbox.js'), 'utf8');
    expect([...sandbox.matchAll(/from 'pyodide\/([^'?]+)\?url'/g)].map((m) => m[1]).sort()).toEqual([...files].sort());
  });

  it('pins the version of Python, which the recorded answers of the server were compared with', () => {
    const wanted = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8')).dependencies.pyodide;
    expect(wanted).toMatch(/^\d+\.\d+\.\d+$/); // exact, no range
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version).toBe(wanted);
  });

  it('turns the worker into a classic script, which is the kind a sandboxed frame can start', () => {
    const source = fs.readFileSync(path.join(here, 'pyRunner', 'worker.js'), 'utf8');
    expect(source).toMatch(/^export /m);
    // A classic script cannot import anything: everything the worker needs is handed to it.
    expect(source).not.toMatch(/^\s*import\s/m);
    const classic = classicWorkerSource(source);
    expect(classic).not.toMatch(/^export /m);
    expect(classic.length).toBeGreaterThan(source.length - 200);
    // It has to be valid as a plain script (this only compiles it).
    expect(() => new Function(classic)).not.toThrow();
    expect(() => new Function(source)).toThrow(SyntaxError);
    expect(classicWorkerSource('export function a() {}\nexport async function b() {}\nexport const c = 1;\nexport class D {}\n  // export const inside = 2;\n')).toBe('function a() {}\nasync function b() {}\nconst c = 1;\nclass D {}\n  // export const inside = 2;\n');
  });
});
