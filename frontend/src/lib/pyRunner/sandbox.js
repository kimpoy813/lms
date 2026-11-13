// The sandbox a student's Python program runs in, seen from the page.
//
//   page ──► <iframe sandbox="allow-scripts"> (public/pyrunner/frame.html) ──► worker (worker.js)
//
// The frame has an origin of its own and may not use the network: the program in it cannot read
// the site's cookies, call its API or reach any other site, whoever wrote the program (a teacher's
// starter code runs in a student's browser too). Because the frame cannot fetch anything, the page
// fetches Python's files — the browser keeps them in its cache — and hands them in.
import asmUrl from 'pyodide/pyodide.asm.mjs?url';
import wasmUrl from 'pyodide/pyodide.asm.wasm?url';
import lockUrl from 'pyodide/pyodide-lock.json?url';
import loaderUrl from 'pyodide/pyodide.mjs?url';
import stdlibUrl from 'pyodide/python_stdlib.zip?url';
import harness from './harness.py?raw';
import workerSource from './worker.js?raw';

const FRAME_URL = `${import.meta.env.BASE_URL}pyrunner/frame.html`;

/**
 * worker.js as the text of a classic worker script: the same file without its `export` keywords.
 * A frame with an origin of its own can start a classic worker from a blob, but not a module
 * worker (Chromium refuses that), and a classic script may not export anything.
 */
export const classicWorkerSource = (moduleSource) => moduleSource.replace(/^export (?=(?:async )?function |const |class )/gm, '');

export class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxError';
  }
}

async function download(url, { binary, onBytes }) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new SandboxError(`${url.split('/').pop()} answered ${response.status}`);
  if (!response.body?.getReader) {
    const whole = binary ? await response.arrayBuffer() : await response.text();
    onBytes?.(binary ? whole.byteLength : whole.length);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onBytes?.(value.byteLength);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return binary ? all.buffer : new TextDecoder('utf-8').decode(all);
}

// The three small text files are kept; the two large binary ones are handed over to the sandbox
// and asked for again next time, which the browser answers from its cache.
let texts = null;

/**
 * Python's files, ready to hand to a sandbox.
 * @param {(bytes: number) => void} [onProgress] total bytes received so far
 */
export async function loadFiles(onProgress) {
  let received = 0;
  const onBytes = (count) => {
    received += count;
    onProgress?.(received);
  };
  texts ??= Promise.all([download(loaderUrl, { onBytes }), download(asmUrl, { onBytes }), download(lockUrl, { onBytes })]).catch((error) => {
    texts = null;
    throw error;
  });
  const [[loader, asm, lock], wasm, stdlib] = await Promise.all([texts, download(wasmUrl, { binary: true, onBytes }), download(stdlibUrl, { binary: true, onBytes })]);
  return { loader, asm, lock, wasm, stdlib };
}

let nextBatch = 1;

/**
 * Start a sandbox and Python in it.
 * @param {{ loader: string, asm: string, lock: string, wasm: ArrayBuffer, stdlib: ArrayBuffer }} files (the two buffers are given away)
 * @returns {Promise<{ info: object, run: Function, dispose: Function }>} rejects with SandboxError when Python does not start
 */
export function openSandbox(files, { bootTimeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'Python sandbox';
    frame.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;visibility:hidden';
    const channel = new MessageChannel();
    let settled = false;
    let listener = null;
    let step = 'loading the sandbox';

    const dispose = () => {
      window.removeEventListener('message', onWindowMessage);
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      frame.remove(); // ends the worker with it, whatever the program is doing
    };
    const fail = (message) => {
      if (settled) return listener?.({ type: 'fatal', message });
      settled = true;
      dispose();
      return reject(new SandboxError(message));
    };
    const timer = setTimeout(() => fail(`Python took too long to start (it was ${step})`), bootTimeoutMs);

    function onWindowMessage(event) {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === 'sandbox-ready') {
        step = 'starting the worker';
        frame.contentWindow.postMessage({ type: 'boot', workerSource: classicWorkerSource(workerSource), harness, port: channel.port2, assets: files }, '*', [channel.port2, files.wasm, files.stdlib]);
      } else if (event.data?.type === 'sandbox-failed') {
        fail(`${event.data.message || 'The sandbox could not start Python'} (it was ${step})`);
      }
    }
    window.addEventListener('message', onWindowMessage);

    channel.port1.onmessage = ({ data }) => {
      if (data?.type === 'ready' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          info: data,
          dispose,
          /**
           * One program on several inputs. `onMessage` gets what the worker says about it:
           * checked, test-start, overflow, test-done, done, fatal.
           */
          run({ code, inputs }, onMessage) {
            const id = nextBatch++;
            listener = (message) => {
              if (message.id === undefined || message.id === id) onMessage(message);
            };
            channel.port1.postMessage({ type: 'batch', id, code, inputs });
          },
        });
      } else if (data?.type === 'progress') {
        step = data.step;
      } else if (data?.type === 'boot-failed') {
        fail(`${data.message || 'Python could not be started'} (it was ${step})`);
      } else {
        listener?.(data);
      }
    };
    frame.addEventListener('error', () => fail('The sandbox could not be loaded.'));
    frame.src = FRAME_URL;
    document.body.appendChild(frame);
  });
}
