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
let skipCalls;

/** Starts the worker's script the way a browser would, and lets it install itself. */
async function start() {
  listeners = {};
  stored = new Map();
  asked = [];
  skipCalls = 0;
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
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    skipWaiting: async () => { skipCalls += 1; },
    clients: { claim: async () => {} },
  };
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
  it('keeps the app’s shell and offline fallback for when the network is away', async () => {
    expect([...stored.keys()]).toEqual(['/', '/offline.html', '/theme-init.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
    const online = await request('/classes/abc/grades', { mode: 'navigate' });
    expect(online.response.body).toBe('the app');
    expect(stored.get('/')).toBe('the app');
    network = { '*': 'down' };
    const offline = await request('/dashboard', { mode: 'navigate' });
    expect(offline.response).toMatchObject({ body: 'the app', fromCache: true });

    // If '/' was cleared from cache, falls back to /offline.html
    stored.delete('/');
    const offlineFallback = await request('/dashboard', { mode: 'navigate' });
    expect(offlineFallback.response).toMatchObject({ body: 'shell:/offline.html', fromCache: true });
  });

  it('never touches the API, health checks, assetlinks, the live socket or other sites', async () => {
    expect(await request('/api/gradebook/classes/abc')).toEqual({ handled: false });
    expect(await request('/api/files/abc', { mode: 'navigate' })).toEqual({ handled: false });
    expect(await request('/socket.io/?EIO=4')).toEqual({ handled: false });
    expect(await request('/.well-known/assetlinks.json')).toEqual({ handled: false });
    expect(await request('/healthz')).toEqual({ handled: false });
    expect(await request('/readyz')).toEqual({ handled: false });
    expect(await request('/api/auth/login', { method: 'POST' })).toEqual({ handled: false });
    expect(await request('/tiles/1/2/3.png', { origin: 'https://tiles.example' })).toEqual({ handled: false });
    expect(asked).toEqual([]);
  });

  it('leaves the frame for Python programs to the server, and never takes it for the app’s page', async () => {
    network['/pyrunner/frame.html'] = page('the sandbox');
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
    network['*'] = { ok: false, body: 'error page' };
    await request('/dashboard', { mode: 'navigate' });
    expect(stored.get('/')).toBe('the app');
  });

  it('caches static build assets, icons, and screenshots cache-first and keeps shell subresources offline-ready', async () => {
    network['/assets/pyodide.asm-abc123.wasm'] = page('python');
    expect((await request('/assets/pyodide.asm-abc123.wasm')).response.body).toBe('python');
    expect((await request('/assets/pyodide.asm-abc123.wasm')).response).toMatchObject({ body: 'python', fromCache: true });

    network['/screenshots/desktop-wide.png'] = page('wide-png');
    expect((await request('/screenshots/desktop-wide.png')).response.body).toBe('wide-png');
    expect((await request('/screenshots/desktop-wide.png')).response).toMatchObject({ body: 'wide-png', fromCache: true });

    // Shell files stay network-first online and fall back to cache offline
    network['/theme-init.js'] = page('fresh-theme');
    expect((await request('/theme-init.js')).response.body).toBe('fresh-theme');
    network = { '*': 'down' };
    expect((await request('/theme-init.js')).response).toMatchObject({ body: 'fresh-theme', fromCache: true });

    // Non-shell arbitrary root files stay unhandled
    expect(await request('/robots.txt')).toEqual({ handled: false });
  });

  it('supports SKIP_WAITING messages for immediate worker updates', () => {
    const before = skipCalls;
    listeners.message({ data: { type: 'SKIP_WAITING' } });
    expect(skipCalls).toBe(before + 1);
  });
});
