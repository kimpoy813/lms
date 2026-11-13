// @vitest-environment node
//
// The service worker (public/sw.js), run here with a pretend browser around it: which requests it
// answers, what it keeps, and what it must leave alone.
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://school.example';

let listeners;
let stored; // what is in the cache: key → body
let network; // path → { ok, body } or 'down'
let asked; // what went to the network

/** Starts the worker's script the way a browser would, and lets it install itself. */
async function start() {
  listeners = {};
  stored = new Map();
  asked = [];
  const cache = {
    addAll: async (paths) => { for (const path of paths) stored.set(path, `shell:${path}`); },
    put: async (key, response) => { stored.set(typeof key === 'string' ? key : new URL(key.url).pathname, response.body); },
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    match: async (key) => {
      const path = typeof key === 'string' ? key : new URL(key.url).pathname;
      return stored.has(path) ? { ok: true, body: stored.get(path), fromCache: true } : undefined;
    },
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const fetch = async (request) => {
    const path = new URL(request.url).pathname;
    asked.push(path);
    const answer = network[path] ?? network['*'];
    if (answer === 'down' || !answer) throw new TypeError('Failed to fetch');
    return { ...answer, clone() { return { ...answer }; } };
  };
  new Function('self', 'caches', 'fetch', 'URL', source)(self, caches, fetch, URL);
  let installing;
  listeners.install({ waitUntil: (promise) => { installing = promise; } });
  await installing;
  asked.length = 0;
}

/** One request through the worker. `handled: false` means the browser deals with it as if there were no worker. */
async function request(path, { mode = 'cors', method = 'GET', origin = ORIGIN } = {}) {
  let answer;
  listeners.fetch({ request: { url: `${origin}${path}`, method, mode }, respondWith: (promise) => { answer = promise; } });
  if (answer === undefined) return { handled: false };
  const response = await answer;
  await new Promise((resolve) => setTimeout(resolve, 0)); // what it keeps is written after it answers
  return { handled: true, response };
}

const page = (body) => ({ ok: true, body });

beforeEach(async () => {
  network = { '*': page('the app') };
  await start();
});

describe('the service worker', () => {
  it('keeps the app’s page for when the network is away', async () => {
    expect([...stored.keys()]).toEqual(['/', '/offline.html', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png']);
    const online = await request('/classes/abc/grades', { mode: 'navigate' });
    expect(online.response.body).toBe('the app');
    expect(stored.get('/')).toBe('the app');
    network = { '*': 'down' };
    const offline = await request('/dashboard', { mode: 'navigate' });
    expect(offline.response).toMatchObject({ body: 'the app', fromCache: true });
  });

  it('never touches the API, the live socket or other sites', async () => {
    expect(await request('/api/gradebook/classes/abc')).toEqual({ handled: false });
    expect(await request('/api/files/abc', { mode: 'navigate' })).toEqual({ handled: false });
    expect(await request('/socket.io/?EIO=4')).toEqual({ handled: false });
    expect(await request('/api/auth/login', { method: 'POST' })).toEqual({ handled: false });
    expect(await request('/tiles/1/2/3.png', { origin: 'https://tiles.example' })).toEqual({ handled: false });
    expect(asked).toEqual([]);
  });

  it('leaves the frame for Python programs to the server, and never takes it for the app’s page', async () => {
    network['/pyrunner/frame.html'] = page('the sandbox');
    // As a frame in the page, and opened by itself: both are page loads to a browser.
    expect(await request('/pyrunner/frame.html', { mode: 'navigate' })).toEqual({ handled: false });
    expect(await request('/pyrunner/frame.html')).toEqual({ handled: false });
    expect(asked).toEqual([]);
    expect(stored.get('/')).toBe('shell:/');
  });

  it('does not let a page that is a file replace the app’s page', async () => {
    await request('/dashboard', { mode: 'navigate' });
    network['/offline.html'] = page('the offline page');
    const direct = await request('/offline.html', { mode: 'navigate' });
    expect(direct.response.body).toBe('the offline page');
    expect(stored.get('/')).toBe('the app');
    // A page that failed is not kept either.
    network['*'] = { ok: false, body: 'error page' };
    await request('/dashboard', { mode: 'navigate' });
    expect(stored.get('/')).toBe('the app');
  });

  it('keeps files of the build, which never change under their name, and asks for each only once', async () => {
    network['/assets/pyodide.asm-abc123.wasm'] = page('python');
    expect((await request('/assets/pyodide.asm-abc123.wasm')).response.body).toBe('python');
    expect((await request('/assets/pyodide.asm-abc123.wasm')).response).toMatchObject({ body: 'python', fromCache: true });
    expect(asked).toEqual(['/assets/pyodide.asm-abc123.wasm']);
    // Anything else of the site goes to the network as usual.
    expect(await request('/theme-init.js')).toEqual({ handled: false });
  });
});
