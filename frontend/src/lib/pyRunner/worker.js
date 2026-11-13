// The Python that runs in the student's browser, and the worker around it.
//
// This file has no imports on purpose. The page hands its text to a sandboxed frame, which starts
// it as a worker from a blob (see sandbox.js): there is nothing it could import from. It is
// started as a classic worker, with the `export` keywords taken out; the tests import
// `createRuntime` from it as the module it is and drive the same code with Pyodide under Node.js.
//
// One worker serves one program: syntax check, then one run per input, then it is thrown away.

export const STDOUT_LIMIT = 64 * 1024;
export const STDERR_LIMIT = 16 * 1024;

const SIGINT = 2;
/** Where harness.py puts the program. */
const BUILD_FOLDER = '/judge/build';

/** Bytes up to a limit; what comes after is counted, not kept. */
function collector(limit) {
  let chunks = [];
  let size = 0;
  let overflow = false;
  return {
    /** @returns {boolean} whether this write went over the limit for the first time */
    add(bytes) {
      if (overflow) return false;
      const room = limit - size;
      if (bytes.length > room) {
        if (room > 0) chunks.push(bytes.slice(0, room));
        size = limit;
        overflow = true;
        return true;
      }
      chunks.push(bytes.slice());
      size += bytes.length;
      return false;
    },
    get overflow() {
      return overflow;
    },
    get size() {
      return size;
    },
    /** The text so far, or its first `bytes` bytes. Cut-off characters become U+FFFD, as on the server. */
    text(bytes = size) {
      const all = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return new TextDecoder('utf-8').decode(all.subarray(0, Math.min(bytes, size)));
    },
    reset() {
      chunks = [];
      size = 0;
      overflow = false;
    },
  };
}

/**
 * The checker around one Pyodide interpreter.
 * @param {object} pyodide a loaded Pyodide
 * @param {string} harnessSource the text of harness.py
 * @param {{ onOverflow?: () => void, onWrite?: (stream: 'out' | 'err', bytes: Uint8Array) => void }} [hooks]
 *        told while the program runs, at once: what it writes (so that the page has it if the
 *        program never ends), and when it has written more than it may and is being stopped
 */
export function createRuntime(pyodide, harnessSource, { onOverflow, onWrite } = {}) {
  let input = new Uint8Array(0);
  let position = 0;
  const out = collector(STDOUT_LIMIT);
  const err = collector(STDERR_LIMIT);
  let stderrAtOverflow = null;
  // Writing a signal number here makes Python raise KeyboardInterrupt at its next step.
  const interrupt = new Uint8Array(1);
  pyodide.setInterruptBuffer(interrupt);

  // True while the program itself runs: only then is there something to interrupt. A program can
  // also go over the limit after its last statement, when Python writes out what it had kept back.
  let running = false;
  const overflowed = () => {
    if (stderrAtOverflow === null) {
      stderrAtOverflow = err.size;
      if (running) onOverflow?.();
    }
    if (running) interrupt[0] = SIGINT;
  };
  // After the limit the program is interrupted, again with every further write, and what it
  // writes is dropped.
  const writer = (to, stream) => ({
    isatty: false,
    write(buffer) {
      if (to.overflow) {
        overflowed();
      } else {
        const over = to.add(buffer);
        if (running) onWrite?.(stream, buffer.slice());
        if (over) overflowed();
      }
      return buffer.length;
    },
  });
  /**
   * File descriptors 0, 1 and 2, opened anew: a program may have closed them (`open(0).read()`
   * does), which ends with its process on the server and must not reach the next run here.
   * Pyodide reopens all three whenever one of them is set.
   */
  const connect = () => {
    pyodide.setStdin({
      isatty: false,
      read(buffer) {
        const count = Math.min(buffer.length, input.length - position);
        buffer.set(input.subarray(position, position + count));
        position += count;
        return count;
      },
    });
    pyodide.setStdout(writer(out, 'out'));
    pyodide.setStderr(writer(err, 'err'));
  };
  connect();

  // The built-in exec, called from here so that the program has no frame of the harness below it.
  const pyExec = pyodide.runPython('__import__("builtins").exec');
  const namespace = pyodide.runPython('dict(__name__="edusphere_harness")');
  pyodide.runPython(harnessSource, { globals: namespace, filename: 'harness.py' });
  const pyCheck = namespace.get('check');
  const pyBegin = namespace.get('begin');
  const pyFinish = namespace.get('finish');
  const heapBytes = () => pyodide._module.HEAPU8.length;

  return {
    heapBytes,
    /** @returns {{ compileError: string | null, serverOnly: string | null }} */
    check(source) {
      return JSON.parse(pyCheck(source));
    },
    /**
     * The program once, with this text as its standard input.
     * @returns {{ stdout: string, stderr: string, exitCode: number, outputLimit: boolean, exception: string | null, doubt: boolean, serverOnly: string | null, heapBytes: number }}
     *   `exception` names what the program did not catch; `doubt` says the failure may be the
     *   browser's rather than the program's; `serverOnly` is a reason found while running.
     */
    run(index, stdin) {
      input = new TextEncoder().encode(stdin ?? '');
      position = 0;
      out.reset();
      err.reset();
      stderrAtOverflow = null;
      interrupt[0] = 0;
      connect();
      const prepared = pyBegin(index);
      const program = prepared.get(0);
      const scope = prepared.get(1);
      let raised = false;
      running = true;
      try {
        pyExec(program, scope);
      } catch (error) {
        // An exception of the program. Anything else is the interpreter itself failing.
        if (!(error instanceof pyodide.ffi.PythonError)) throw error;
        raised = true;
      } finally {
        running = false;
        interrupt[0] = 0;
        program.destroy();
        scope.destroy();
        prepared.destroy();
      }
      const report = JSON.parse(pyFinish(index, raised));
      const outputLimit = stderrAtOverflow !== null;
      return {
        stdout: out.text(),
        // A program stopped for printing too much left no trace of being stopped on the server.
        // The folder of the program is not part of its name there either.
        stderr: (outputLimit ? err.text(stderrAtOverflow) : err.text()).split(`${BUILD_FOLDER}/`).join(''),
        exitCode: report.exitCode,
        outputLimit,
        exception: report.exception,
        doubt: report.doubt,
        serverOnly: report.serverOnly,
        heapBytes: heapBytes(),
      };
    },
  };
}

/**
 * Inside the worker: Pyodide from the files the page sent along. Nothing is fetched from the
 * network; the frame this worker lives in is not allowed to.
 */
async function loadInterpreter({ loader, asm, wasm, stdlib, lock }, progress) {
  const moduleUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const base = 'https://pyodide.invalid/';
  const served = { [`${base}pyodide.asm.wasm`]: [wasm, 'application/wasm'], [`${base}python_stdlib.zip`]: [stdlib, 'application/zip'] };
  // Pyodide asks for its two binary files with fetch(). They are answered from memory, and every
  // other request is refused.
  self.fetch = async (resource) => {
    const url = String(resource?.url ?? resource);
    const file = served[url];
    if (!file) throw new TypeError(`This program runs without a network: ${url.slice(0, 80)}`);
    return new Response(file[0], { status: 200, headers: { 'content-type': file[1] } });
  };
  self.XMLHttpRequest = undefined;
  self.WebSocket = undefined;
  self.EventSource = undefined;
  // Nothing may be loaded from outside. Pyodide also takes a worker in which importScripts()
  // works for one it cannot run in; this one can import modules, which is all it needs.
  self.importScripts = undefined;
  const [{ loadPyodide, version }, { default: createPyodideModule }] = await Promise.all([import(moduleUrl(loader)), import(moduleUrl(asm))]);
  progress('starting the interpreter');
  const pyodide = await loadPyodide({ indexURL: base, packageBaseUrl: base, lockFileContents: lock, createPyodideModule, checkAPIVersion: true });
  return { pyodide, version };
}

function startWorker() {
  let port = null;
  let runtime = null;
  const send = (message) => port?.postMessage(message);

  self.onmessage = async ({ data }) => {
    if (data?.type !== 'boot' || port) return;
    port = data.port;
    const started = performance.now();
    // Said along the way, so that a start that fails or never ends can be told where it was.
    const progress = (step) => send({ type: 'progress', step });
    try {
      progress('loading Python');
      const { pyodide, version } = await loadInterpreter(data.assets, progress);
      progress('preparing the checker');
      let current = null;
      runtime = createRuntime(pyodide, data.harness, {
        onOverflow: () => send({ type: 'overflow', ...current }),
        onWrite: (stream, bytes) => send({ type: 'output', ...current, stream, bytes }),
      });
      const python = pyodide.runPython('import platform as _p\n_p.python_version()');
      port.onmessage = ({ data: job }) => {
        if (job?.type !== 'batch') return;
        const { id, code, inputs } = job;
        try {
          const checked = runtime.check(code);
          send({ type: 'checked', id, ...checked });
          if (checked.compileError || checked.serverOnly) return send({ type: 'done', id });
          for (let index = 0; index < inputs.length; index += 1) {
            current = { id, index };
            send({ type: 'test-start', id, index });
            const begun = performance.now();
            const run = runtime.run(index, inputs[index]);
            send({ type: 'test-done', id, index, run: { ...run, ms: Math.round(performance.now() - begun) } });
            // After this the interpreter cannot be trusted to behave like a new process.
            if (run.serverOnly) break;
          }
          send({ type: 'done', id });
        } catch (error) {
          // The interpreter itself failed (out of memory, stack overflow, os._exit, …).
          send({ type: 'fatal', id, message: String(error?.message ?? error).slice(0, 300) });
        }
      };
      send({ type: 'ready', bootMs: Math.round(performance.now() - started), pyodide: version, python, heapBytes: runtime.heapBytes() });
    } catch (error) {
      send({ type: 'boot-failed', message: String(error?.message ?? error).slice(0, 300) });
    }
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) startWorker();
