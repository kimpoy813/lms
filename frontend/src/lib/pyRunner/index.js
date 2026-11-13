// Python programs run in the student's own browser when they are only being tried: the sample
// tests and "Try my own input". Nothing is sent to the server's code runner for those, so they
// are not limited by its allowance and answer faster.
//
// What counts is still checked on the server: "Submit for checking" never comes through here.
// And whenever the browser may not behave like the server's Python, the answer of this module is
// `{ where: 'server' }` and the caller asks the server as before:
//   - the browser cannot run Python, or Python did not start;
//   - the program uses something the browser's Python does differently (files, threads, the
//     size of numbers on the machine, …) — harness.py names the reason;
//   - the program failed in a way that can be the browser's own (memory, very deep recursion);
//   - an answer looks wrong only by the order of a set or the last digits of a decimal number.
import harness from './harness.py?raw';
import { MAX_TESTS, judgeRuns, mayBeTheBrowser, notRun, stoppedRun, toRun } from './judge.js';
import { SandboxError, loadFiles, openSandbox } from './sandbox.js';

const STDOUT_LIMIT = 64 * 1024;
const STDERR_LIMIT = 16 * 1024;

/** How long one test may take here before it is stopped: a browser is slower than the server. */
export const localBudgetMs = (timeLimitMs) => Math.min(30_000, Math.max(3_000, timeLimitMs * 3));

export function pythonInBrowserSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof MessageChannel === 'function' && typeof Blob === 'function' && typeof URL?.createObjectURL === 'function';
}

// The same list harness.py checks against, read from it so that there is only one.
const ALLOWED_MODULES = new Set((/ALLOWED_MODULES = frozenset\(\s*"""([\s\S]*?)"""/.exec(harness)?.[1] ?? '').split(/\s+/).filter(Boolean));

/**
 * A first look without Python: a module that is certainly left to the server. Saves starting
 * Python (and, the first time, downloading it) for a program that will not run here anyway.
 * Lines that only look like imports err on the side of the server, which is always right.
 */
export function importedElsewhere(code) {
  if (ALLOWED_MODULES.size === 0) return null;
  for (const line of String(code).split('\n')) {
    const found = /^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/.exec(line);
    if (!found) continue;
    const names = /^\s*import\s/.test(line) ? line.replace(/^\s*import\s+/, '').split('#')[0].split(',').map((part) => part.trim().split(/\s+/)[0]) : [found[1]];
    for (const name of names) {
      const top = name.split('.')[0];
      if (top && /^[A-Za-z_]\w*$/.test(top) && !ALLOWED_MODULES.has(top)) return top;
    }
  }
  return null;
}

const onServer = (reason) => ({ where: 'server', reason });

// Starting Python takes a second or two, most of a run's time. While somebody is working on a
// program, the next sandbox is therefore started as soon as one has been used, and waits. It is
// given up when the page is hidden, when nothing was run for a while, and when the editor is
// left (discardSpare): a waiting Python holds some tens of megabytes.
const SPARE_KEPT_MS = 3 * 60_000;
let spare = null;
let spareTimer = null;

async function freshSandbox(onStatus) {
  onStatus?.({ phase: 'download', bytes: 0 });
  const files = await loadFiles((bytes) => onStatus?.({ phase: 'download', bytes }));
  onStatus?.({ phase: 'start' });
  return openSandbox(files);
}

export function discardSpare() {
  const waiting = spare;
  spare = null;
  clearTimeout(spareTimer);
  waiting?.then((sandbox) => sandbox.dispose()).catch(() => {});
}

function prepareSpare() {
  if (spare || typeof document === 'undefined' || document.hidden || (typeof navigator !== 'undefined' && navigator.deviceMemory <= 2)) return;
  const starting = freshSandbox();
  spare = starting;
  starting.catch(() => {
    if (spare === starting) spare = null;
  });
  clearTimeout(spareTimer);
  spareTimer = setTimeout(discardSpare, SPARE_KEPT_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) discardSpare();
  });
}

/** A sandbox with Python started: the one that was waiting, or a new one. */
async function takeSandbox(onStatus) {
  const waiting = spare;
  spare = null;
  clearTimeout(spareTimer);
  if (waiting) {
    onStatus?.({ phase: 'start' });
    try {
      return await waiting;
    } catch {
      // It did not start; try once more, from the beginning.
    }
  }
  return freshSandbox(onStatus);
}

const decode = (chunks, limit) => {
  const size = Math.min(limit, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= size) break;
    const part = chunk.subarray(0, size - at);
    all.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
};

/**
 * One program on several inputs, as the server's `runBatch`.
 * @param {object} job
 * @param {string} job.code
 * @param {string[]} job.inputs
 * @param {number} job.timeLimitMs the problem's limit per test
 * @param {number} job.memoryLimitKb
 * @param {(status: { phase: 'download' | 'start' | 'run', bytes?: number, index?: number, total?: number }) => void} [job.onStatus]
 * @returns {Promise<{ where: 'browser', compileError: string | null, runs: object[] } | { where: 'server', reason: string }>}
 */
export async function runBatchInBrowser({ code, inputs, timeLimitMs = 3000, memoryLimitKb = 131072, onStatus }) {
  if (!pythonInBrowserSupported()) return onServer('this browser cannot run Python');
  const elsewhere = importedElsewhere(code);
  if (elsewhere) return onServer(`it imports ${elsewhere}`);

  let sandbox;
  try {
    sandbox = await takeSandbox(onStatus);
  } catch (error) {
    // Not the student's concern when the server takes over; said here for whoever looks into it.
    console.warn('Python could not be started in this browser:', error instanceof SandboxError ? error.message : error);
    return onServer('Python could not be started in this browser');
  }

  const budgetMs = localBudgetMs(timeLimitMs);
  const bootHeap = sandbox.info.heapBytes ?? 0;
  return new Promise((resolve) => {
    const runs = [];
    let timer = null;
    let written = { out: [], err: [] };
    let overflow = false;
    const finish = (answer) => {
      clearTimeout(timer);
      sandbox.dispose();
      // Whoever ran a program here is likely to run the next one soon.
      if (answer.where === 'browser') prepareSpare();
      resolve(answer);
    };
    sandbox.run({ code, inputs }, (message) => {
      if (message.type === 'checked') {
        if (message.serverOnly) return finish(onServer(message.serverOnly));
        // The server joins what the compiler wrote and trims it.
        if (message.compileError) return finish({ where: 'browser', compileError: message.compileError.trim(), runs: [] });
        return undefined;
      }
      if (message.type === 'test-start') {
        written = { out: [], err: [] };
        overflow = false;
        onStatus?.({ phase: 'run', index: message.index, total: inputs.length });
        timer = setTimeout(() => {
          // Still running: the frame is removed, and the program with it.
          const partial = { stdout: decode(written.out, STDOUT_LIMIT), stderr: decode(written.err, STDERR_LIMIT) };
          runs.push(overflow ? toRun({ ...partial, exitCode: 1, outputLimit: true, exception: null }) : stoppedRun({ ...partial, budgetMs, timeLimitMs }));
          while (runs.length < inputs.length) runs.push(notRun());
          finish({ where: 'browser', compileError: null, runs });
        }, budgetMs);
        return undefined;
      }
      if (message.type === 'output') {
        written[message.stream]?.push(message.bytes);
        return undefined;
      }
      if (message.type === 'overflow') {
        overflow = true;
        return undefined;
      }
      if (message.type === 'test-done') {
        clearTimeout(timer);
        const { run } = message;
        if (run.serverOnly) return finish(onServer(run.serverOnly));
        if (run.doubt) return finish(onServer(`it stopped with ${run.exception}, which can be this browser’s doing`));
        // Memory the browser's Python took and never gives back: near the problem's limit the
        // server may stop the program where the browser did not.
        if (run.heapBytes - bootHeap > memoryLimitKb * 1024 * 0.75) return finish(onServer('it uses a lot of memory'));
        runs.push(toRun(run));
        return undefined;
      }
      if (message.type === 'done') return finish({ where: 'browser', compileError: null, runs });
      if (message.type === 'fatal') return finish(onServer('Python stopped working in this browser'));
      return undefined;
    });
  });
}

/** "Try my own input": the answer has the shape of POST …/run with `stdin`. */
export async function runCustomInBrowser(problem, { code, stdin, onStatus }) {
  const answer = await runBatchInBrowser({ code, inputs: [stdin ?? ''], timeLimitMs: problem.timeLimitMs, memoryLimitKb: problem.memoryLimitKb, onStatus });
  if (answer.where !== 'browser') return answer;
  const run = answer.runs[0] ?? { stdout: '', stderr: '', exitCode: null, timedOut: false };
  return { where: 'browser', result: { mode: 'CUSTOM', ...run, compileError: answer.compileError } };
}

/**
 * "Run sample tests": the answer has the shape of POST …/run without `stdin`.
 * @param {object} problem as GET /programming/problems/:id returns it (the test cases a student sees, or all of them for the teacher)
 */
export async function runSamplesInBrowser(problem, { code, onStatus }) {
  const cases = problem.testCases.slice(0, MAX_TESTS);
  const answer = await runBatchInBrowser({ code, inputs: cases.map((t) => t.input ?? ''), timeLimitMs: problem.timeLimitMs, memoryLimitKb: problem.memoryLimitKb, onStatus });
  if (answer.where !== 'browser') return answer;
  if (answer.compileError) {
    return { where: 'browser', result: { mode: 'SAMPLES', status: 'ERROR', errorMessage: answer.compileError.slice(0, 4000), passedCount: 0, totalCount: cases.length, results: [] } };
  }
  const judged = judgeRuns(cases, answer.runs);
  const doubtful = judged.results.find((r) => r.outcome === 'WRONG_ANSWER' && mayBeTheBrowser(r.stdout, r.expectedOutput));
  if (doubtful) return onServer('an answer differs from the expected one only in a way this browser’s Python differs from the server’s');
  return { where: 'browser', result: { mode: 'SAMPLES', ...judged } };
}
