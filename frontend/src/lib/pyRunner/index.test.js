// Deciding between the browser and the server, with the sandbox played by the test: what the
// worker says is fed in by hand. The real sandbox is exercised in e2e/tests/python-in-browser.spec.js,
// the real Python in runtime.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxes = [];
const control = { loadFails: false, openFails: false };

vi.mock('./sandbox.js', () => {
  class SandboxError extends Error {}
  return {
    SandboxError,
    loadFiles: vi.fn(async (onProgress) => {
      if (control.loadFails) throw new SandboxError('pyodide.asm.wasm answered 404');
      onProgress?.(1000);
      onProgress?.(5000);
      return { loader: '', asm: '', lock: '', wasm: new ArrayBuffer(0), stdlib: new ArrayBuffer(0) };
    }),
    openSandbox: vi.fn(async () => {
      if (control.openFails) throw new SandboxError('Python took too long to start (it was loading Python)');
      const sandbox = { info: { heapBytes: 30 * 1024 * 1024 }, dispose: vi.fn(), job: null, say: null, run(job, onMessage) { this.job = job; this.say = onMessage; } };
      sandboxes.push(sandbox);
      return sandbox;
    }),
  };
});

const { loadFiles, openSandbox } = await import('./sandbox.js');
const { discardSpare, importedElsewhere, localBudgetMs, pythonInBrowserSupported, runBatchInBrowser, runCustomInBrowser, runSamplesInBrowser } = await import('./index.js');

const MB = 1024 * 1024;
const done = (extra = {}) => ({ stdout: '', stderr: '', exitCode: 0, outputLimit: false, exception: null, doubt: false, serverOnly: null, heapBytes: 31 * MB, ms: 5, ...extra });
/** Lets the code under test get as far as it can without the sandbox saying anything. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
/** Starts a batch and waits until the program has been handed to a (pretend) sandbox. */
const handed = new Set();
async function start(job, run = runBatchInBrowser) {
  const answer = run(job);
  let sandbox;
  for (let i = 0; i < 50 && !sandbox; i += 1) {
    await Promise.resolve();
    sandbox = sandboxes.find((candidate) => candidate.say && !handed.has(candidate));
  }
  handed.add(sandbox);
  return { answer, sandbox };
}

beforeEach(() => {
  vi.stubGlobal('Worker', function Worker() {});
  vi.stubGlobal('MessageChannel', function MessageChannel() {});
  sandboxes.length = 0;
  handed.clear();
  control.loadFails = false;
  control.openFails = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  discardSpare();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('whether the browser is asked at all', () => {
  it('is not when the browser lacks what Python needs', async () => {
    vi.stubGlobal('Worker', undefined);
    expect(pythonInBrowserSupported()).toBe(false);
    expect(await runBatchInBrowser({ code: 'print(1)', inputs: [''] })).toEqual({ where: 'server', reason: 'this browser cannot run Python' });
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it('is not for a program that imports what only the server has, without even starting Python', async () => {
    expect(await runBatchInBrowser({ code: 'import numpy as np\nprint(1)\n', inputs: [''] })).toEqual({ where: 'server', reason: 'it imports numpy' });
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it('reads the list of modules from the checker inside Python, so that there is one list', () => {
    expect(importedElsewhere('import math\nimport sys, os\nfrom collections import Counter\nimport os.path as p\n')).toBeNull();
    expect(importedElsewhere('import math, threading\n')).toBe('threading');
    expect(importedElsewhere('    from socket import socket  # inside a function\n')).toBe('socket');
    expect(importedElsewhere('import numpy.linalg as la\n')).toBe('numpy');
    expect(importedElsewhere('text = "import numpy"\nimportant = 1\n')).toBeNull();
    // A line of a long string that reads like an import goes to the server too, which is always right.
    expect(importedElsewhere('"""\nimport antigravity\n"""\n')).toBe('antigravity');
  });

  it('hands the program to the server when Python cannot be fetched or does not start', async () => {
    control.loadFails = true;
    expect(await runBatchInBrowser({ code: 'print(1)', inputs: [''] })).toEqual({ where: 'server', reason: 'Python could not be started in this browser' });
    control.loadFails = false;
    control.openFails = true;
    expect(await runBatchInBrowser({ code: 'print(1)', inputs: [''] })).toEqual({ where: 'server', reason: 'Python could not be started in this browser' });
    expect(console.warn).toHaveBeenCalledWith('Python could not be started in this browser:', 'Python took too long to start (it was loading Python)');
  });
});

describe('a batch in the browser', () => {
  it('runs every input and tells what it is doing', async () => {
    const seen = [];
    const { answer, sandbox } = await start({ code: 'print(input())', inputs: ['a', 'b'], onStatus: (status) => seen.push(status) });
    expect(sandbox.job).toEqual({ code: 'print(input())', inputs: ['a', 'b'] });
    sandbox.say({ type: 'checked', compileError: null, serverOnly: null });
    sandbox.say({ type: 'test-start', index: 0 });
    sandbox.say({ type: 'test-done', index: 0, run: done({ stdout: 'a\n' }) });
    sandbox.say({ type: 'test-start', index: 1 });
    sandbox.say({ type: 'test-done', index: 1, run: done({ stdout: '', stderr: 'Traceback…\n', exitCode: 1, exception: 'ValueError' }) });
    sandbox.say({ type: 'done' });
    expect(await answer).toEqual({
      where: 'browser', compileError: null,
      runs: [{ stdout: 'a\n', stderr: '', exitCode: 0, timedOut: false }, { stdout: '', stderr: 'Traceback…\n', exitCode: 1, timedOut: false }],
    });
    expect(sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { phase: 'download', bytes: 0 }, { phase: 'download', bytes: 1000 }, { phase: 'download', bytes: 5000 }, { phase: 'start' },
      { phase: 'run', index: 0, total: 2 }, { phase: 'run', index: 1, total: 2 },
    ]);
  });

  it('reports a program that does not compile, trimmed as the server trims it', async () => {
    const { answer, sandbox } = await start({ code: 'print(', inputs: [''] });
    sandbox.say({ type: 'checked', compileError: '  File "main.py", line 1\n    print(\n         ^\nSyntaxError: \'(\' was never closed\n', serverOnly: null });
    expect(await answer).toEqual({ where: 'browser', compileError: 'File "main.py", line 1\n    print(\n         ^\nSyntaxError: \'(\' was never closed', runs: [] });
    expect(sandbox.dispose).toHaveBeenCalled();
  });

  it.each([
    ['Python finds a reason before running', [{ type: 'checked', compileError: null, serverOnly: 'it uses sys.maxsize' }], 'it uses sys.maxsize'],
    ['a reason turns up while running', [{ type: 'checked' }, { type: 'test-start', index: 0 }, { type: 'test-done', index: 0, run: done({ serverOnly: "it imports 'socket'", exitCode: 1 }) }], "it imports 'socket'"],
    ['the failure may be the browser’s', [{ type: 'checked' }, { type: 'test-start', index: 0 }, { type: 'test-done', index: 0, run: done({ exitCode: 1, exception: 'MemoryError', doubt: true }) }], 'it stopped with MemoryError, which can be this browser’s doing'],
    ['the program took most of the memory it may use', [{ type: 'checked' }, { type: 'test-start', index: 0 }, { type: 'test-done', index: 0, run: done({ heapBytes: (30 + 100) * MB }) }], 'it uses a lot of memory'],
    ['Python itself broke down', [{ type: 'checked' }, { type: 'test-start', index: 0 }, { type: 'fatal', message: 'RangeError: Maximum call stack size exceeded' }], 'Python stopped working in this browser'],
  ])('asks the server when %s', async (what, messages, reason) => {
    const { answer, sandbox } = await start({ code: 'x = 1', inputs: ['', ''], memoryLimitKb: 131072 });
    for (const message of messages) sandbox.say(message);
    expect(await answer).toEqual({ where: 'server', reason });
    expect(sandbox.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not mind a program that uses a little memory', async () => {
    const { answer, sandbox } = await start({ code: 'x = 1', inputs: [''], memoryLimitKb: 131072 });
    for (const message of [{ type: 'checked' }, { type: 'test-start', index: 0 }, { type: 'test-done', index: 0, run: done({ heapBytes: (30 + 90) * MB }) }, { type: 'done' }]) sandbox.say(message);
    expect((await answer).where).toBe('browser');
  });
});

describe('a program that does not end', () => {
  it('gives a test three times the problem’s limit, within sensible bounds', () => {
    expect(localBudgetMs(3000)).toBe(9000);
    expect(localBudgetMs(500)).toBe(3000);
    expect(localBudgetMs(15_000)).toBe(30_000);
  });

  it('is stopped by taking the sandbox away, keeps what it had printed, and leaves the later tests alone', async () => {
    vi.useFakeTimers();
    const { answer, sandbox } = await start({ code: 'while True: pass', inputs: ['1', '2', '3'], timeLimitMs: 2000 });
    sandbox.say({ type: 'checked' });
    sandbox.say({ type: 'test-start', index: 0 });
    sandbox.say({ type: 'test-done', index: 0, run: done({ stdout: 'ok\n' }) });
    sandbox.say({ type: 'test-start', index: 1 });
    sandbox.say({ type: 'output', index: 1, stream: 'out', bytes: new TextEncoder().encode('before ') });
    sandbox.say({ type: 'output', index: 1, stream: 'out', bytes: new TextEncoder().encode('the loop\n') });
    sandbox.say({ type: 'output', index: 1, stream: 'err', bytes: new TextEncoder().encode('careful\n') });
    await vi.advanceTimersByTimeAsync(5999);
    expect(sandbox.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(await answer).toEqual({
      where: 'browser', compileError: null,
      runs: [
        { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false },
        { stdout: 'before the loop\n', exitCode: null, timedOut: true, stderr: 'careful\nStopped after 6 seconds on this device. On the server a test may take 2 seconds.' },
        { stdout: '', exitCode: null, timedOut: true, stderr: 'Not run: an earlier test took too long.' },
      ],
    });
  });

  it('does not stop a test that finished in time when the next one is slow to start', async () => {
    vi.useFakeTimers();
    const { answer, sandbox } = await start({ code: 'x', inputs: ['1'], timeLimitMs: 1000 });
    sandbox.say({ type: 'checked' });
    sandbox.say({ type: 'test-start', index: 0 });
    await vi.advanceTimersByTimeAsync(2500);
    sandbox.say({ type: 'test-done', index: 0, run: done({ stdout: 'late\n' }) });
    await vi.advanceTimersByTimeAsync(60_000);
    sandbox.say({ type: 'done' });
    expect((await answer).runs).toEqual([{ stdout: 'late\n', stderr: '', exitCode: 0, timedOut: false }]);
  });

  it('is reported as printing too much when that is why it was being stopped', async () => {
    vi.useFakeTimers();
    const { answer, sandbox } = await start({ code: 'while True: print(1)', inputs: [''], timeLimitMs: 1000 });
    sandbox.say({ type: 'checked' });
    sandbox.say({ type: 'test-start', index: 0 });
    sandbox.say({ type: 'output', index: 0, stream: 'out', bytes: new Uint8Array(70_000).fill(120) });
    sandbox.say({ type: 'overflow', index: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    const [run] = (await answer).runs;
    expect(run).toMatchObject({ exitCode: 1, timedOut: false, stderr: 'Output limit exceeded: the program printed more than 64 KB.' });
    expect(run.stdout.startsWith('xxxx')).toBe(true);
    expect(run.stdout).toHaveLength(64_000 + '\n… (output truncated)'.length);
  });
});

describe('the Python kept ready for the next run', () => {
  it('is started after a run and used by the next one', async () => {
    const first = await start({ code: 'x', inputs: [''] });
    first.sandbox.say({ type: 'checked' });
    first.sandbox.say({ type: 'done' });
    await first.answer;
    await settle();
    expect(openSandbox).toHaveBeenCalledTimes(2); // the one that ran, and the one now waiting
    expect(sandboxes[1].say).toBeNull();

    const seen = [];
    const second = runBatchInBrowser({ code: 'y', inputs: [''], onStatus: (status) => seen.push(status.phase) });
    await settle();
    expect(sandboxes[1].job).toEqual({ code: 'y', inputs: [''] });
    expect(seen).toEqual(['start']); // nothing to download this time
    sandboxes[1].say({ type: 'checked' });
    sandboxes[1].say({ type: 'done' });
    await second;
  });

  it('is not started after a program that went to the server', async () => {
    const { answer, sandbox } = await start({ code: 'x', inputs: [''] });
    sandbox.say({ type: 'checked', compileError: null, serverOnly: 'it opens a file' });
    await answer;
    await settle();
    expect(openSandbox).toHaveBeenCalledTimes(1);
  });

  it('is given up when the editor is left or the page is hidden', async () => {
    const { answer, sandbox } = await start({ code: 'x', inputs: [''] });
    sandbox.say({ type: 'checked' });
    sandbox.say({ type: 'done' });
    await answer;
    await settle();
    discardSpare();
    await settle();
    expect(sandboxes[1].dispose).toHaveBeenCalledTimes(1);

    const again = await start({ code: 'x', inputs: [''] });
    again.sandbox.say({ type: 'checked' });
    again.sandbox.say({ type: 'done' });
    await again.answer;
    await settle();
    const waiting = sandboxes.at(-1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(waiting.dispose).toHaveBeenCalledTimes(1);
  });

  it('is replaced by a new one when it failed to start', async () => {
    const first = await start({ code: 'x', inputs: [''] });
    control.openFails = true; // the spare will fail
    first.sandbox.say({ type: 'checked' });
    first.sandbox.say({ type: 'done' });
    await first.answer;
    await settle();
    control.openFails = false;
    const second = await start({ code: 'y', inputs: [''] });
    expect(second.sandbox.job).toEqual({ code: 'y', inputs: [''] });
    second.sandbox.say({ type: 'checked' });
    second.sandbox.say({ type: 'done' });
    expect((await second.answer).where).toBe('browser');
  });
});

describe('the two buttons of the editor', () => {
  const problem = {
    timeLimitMs: 2000, memoryLimitKb: 65536,
    testCases: [{ id: 't1', input: '7\n', expectedOutput: 'ODD', comparison: 'TRIMMED' }, { id: 't2', input: '10\n', expectedOutput: 'EVEN', comparison: 'TRIMMED' }],
  };
  const play = async (sandbox, runs) => {
    sandbox.say({ type: 'checked' });
    runs.forEach((run, index) => {
      sandbox.say({ type: 'test-start', index });
      sandbox.say({ type: 'test-done', index, run: done(run) });
    });
    sandbox.say({ type: 'done' });
  };

  it('“Run sample tests” answers in the shape the server uses', async () => {
    const { answer, sandbox } = await start({ code: 'print("ODD")' }, (job) => runSamplesInBrowser(problem, job));
    expect(sandbox.job.inputs).toEqual(['7\n', '10\n']);
    await play(sandbox, [{ stdout: 'ODD\n' }, { stdout: 'ODD\n' }]);
    expect(await answer).toEqual({
      where: 'browser',
      result: {
        mode: 'SAMPLES', status: 'COMPLETED', errorMessage: null, passedCount: 1, totalCount: 2,
        results: [
          { testCaseId: 't1', position: 0, isHidden: false, weight: 1, passed: true, outcome: 'PASSED', input: '7\n', expectedOutput: 'ODD', stdout: 'ODD\n', stderr: '' },
          { testCaseId: 't2', position: 1, isHidden: false, weight: 1, passed: false, outcome: 'WRONG_ANSWER', input: '10\n', expectedOutput: 'EVEN', stdout: 'ODD\n', stderr: '' },
        ],
      },
    });
  });

  it('“Run sample tests” reports a program that does not compile as the server does', async () => {
    const { answer, sandbox } = await start({ code: 'print(' }, (job) => runSamplesInBrowser(problem, job));
    sandbox.say({ type: 'checked', compileError: 'SyntaxError: nope\n', serverOnly: null });
    expect(await answer).toEqual({ where: 'browser', result: { mode: 'SAMPLES', status: 'ERROR', errorMessage: 'SyntaxError: nope', passedCount: 0, totalCount: 2, results: [] } });
  });

  it('“Run sample tests” asks the server when an answer is wrong only the way the browser’s Python differs', async () => {
    const sets = { ...problem, testCases: [{ id: 's', input: '', expectedOutput: '{0, 3, -1, -5, -100, -2}', comparison: 'TRIMMED' }] };
    const { answer, sandbox } = await start({ code: 'print({-1, -2, -5, 3, 0, -100})' }, (job) => runSamplesInBrowser(sets, job));
    await play(sandbox, [{ stdout: '{0, 3, -2, -5, -100, -1}\n' }]);
    expect(await answer).toEqual({ where: 'server', reason: 'an answer differs from the expected one only in a way this browser’s Python differs from the server’s' });
  });

  it('“Run sample tests” runs at most as many tests as the server would', async () => {
    const many = { ...problem, testCases: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, input: `${i}`, expectedOutput: `${i}` })) };
    const { sandbox } = await start({ code: 'print(input())' }, (job) => runSamplesInBrowser(many, job));
    expect(sandbox.job.inputs).toHaveLength(25);
    sandbox.say({ type: 'fatal' });
  });

  it('“Try my own input” answers in the shape the server uses', async () => {
    const { answer, sandbox } = await start({ code: 'print(input())', stdin: 'Ana\n' }, (job) => runCustomInBrowser(problem, job));
    expect(sandbox.job.inputs).toEqual(['Ana\n']);
    await play(sandbox, [{ stdout: 'Ana\n' }]);
    expect(await answer).toEqual({ where: 'browser', result: { mode: 'CUSTOM', stdout: 'Ana\n', stderr: '', exitCode: 0, timedOut: false, compileError: null } });

    const broken = await start({ code: 'print(', stdin: '' }, (job) => runCustomInBrowser(problem, job));
    broken.sandbox.say({ type: 'checked', compileError: 'SyntaxError: nope', serverOnly: null });
    expect(await broken.answer).toEqual({ where: 'browser', result: { mode: 'CUSTOM', stdout: '', stderr: '', exitCode: null, timedOut: false, compileError: 'SyntaxError: nope' } });
  });

  it('passes the server’s turn on unchanged', async () => {
    expect(await runCustomInBrowser(problem, { code: 'import threading\n', stdin: '' })).toEqual({ where: 'server', reason: 'it imports threading' });
    expect(await runSamplesInBrowser(problem, { code: 'import threading\n' })).toEqual({ where: 'server', reason: 'it imports threading' });
  });
});
