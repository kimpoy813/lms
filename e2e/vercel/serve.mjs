#!/usr/bin/env node
// A local stand-in for Vercel's edge: serves the result of `vercel build` (.vercel/output) the
// way Vercel would route it, so the deployment can be exercised before it is deployed.
//
//   npx vercel build                      # writes .vercel/output
//   node e2e/vercel/serve.mjs             # http://localhost:3900
//   npm run smoke -- http://localhost:3900
//
// What it reproduces: the route table Vercel generated from vercel.json (headers, rewrites, the
// single-page fallback), static files, the function running from only the files that were traced
// into it, from a read-only folder, the 4.5 MB limit on request bodies, and Vercel's refusal to
// require() an ES module unless NODE_OPTIONS=--experimental-require-module is set (pass it to
// this script as it is set in the Vercel project).
// What it cannot reproduce: the rest of Vercel's own launcher, instances being frozen between
// requests (the function simply keeps running here, so waitUntil always "works"), and several
// instances at once. It is a test tool, not a way to host the application.
//
// Options (environment variables):
//   PORT, HOST          where to listen (default 127.0.0.1:3900)
//   VERCEL_OUTPUT       path of the build output (default .vercel/output)
//   EMULATE_URL         "original" (default, and what Vercel does): the function sees the URL the
//                       browser asked for, with the rewrite's query parameters added;
//                       "rewritten": it sees the URL the rewrite points to. Vercel does not
//                       document this, so the application works with both.
//   NODE_OPTIONS        with --experimental-require-module, the function may require() ES
//                       modules, as on Vercel when the project sets the same variable.
//   Everything else is passed on to the function (DATABASE_URL, NODE_ENV, …).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const output = path.resolve(process.env.VERCEL_OUTPUT ?? path.join('.vercel', 'output'));
const project = path.resolve(output, '..', '..');
const port = Number(process.env.PORT ?? 3900);
const host = process.env.HOST ?? '127.0.0.1';
const urlMode = process.env.EMULATE_URL === 'rewritten' ? 'rewritten' : 'original';
const requireOfEsModules = /(^|\s)--(experimental-)?require-module(\s|$)/.test(process.env.NODE_OPTIONS ?? '');
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

if (!fs.existsSync(path.join(output, 'config.json'))) {
  console.error(`No build output at ${output}. Run "npx vercel build" first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
const staticDir = path.join(output, 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.wasm': 'application/wasm', '.zip': 'application/zip',
};

// ── The function: only the traced files, in a folder that cannot be written to ─────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
}

function findFunctions(dir, base = '') {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.func')) found.push({ route: `${base}/${entry.name.slice(0, -5)}`, dir: path.join(dir, entry.name) });
    else found.push(...findFunctions(path.join(dir, entry.name), `${base}/${entry.name}`));
  }
  return found;
}

// PORT and HOST say where this stand-in listens; they mean nothing to the function.
const { PORT: _port, HOST: _host, ...functionEnv } = process.env;

async function startFunction(fn) {
  const meta = JSON.parse(fs.readFileSync(path.join(fn.dir, '.vc-config.json'), 'utf8'));
  const task = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-task-'));
  fs.cpSync(fn.dir, task, { recursive: true });
  // Files added with includeFiles are listed by reference, not copied into the .func folder.
  for (const [inFunction, inProject] of Object.entries(meta.filePathMap ?? {})) {
    fs.mkdirSync(path.dirname(path.join(task, inFunction)), { recursive: true });
    fs.copyFileSync(path.join(project, inProject), path.join(task, inFunction));
  }
  const runner = path.join(os.tmpdir(), `vercel-runner-${process.pid}.cjs`);
  fs.writeFileSync(
    runner,
    `const http = require('node:http');
const { pathToFileURL } = require('node:url');
// Vercel publishes the request in progress under this symbol; code uses it to keep an instance
// awake until work that outlives the response has finished (waitUntil).
globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (promise) => { Promise.resolve(promise).catch(() => {}); } }) };
(async () => {
  // As seen on Vercel: the entry point is loaded with require() where that works for an ES
  // module, which is only with NODE_OPTIONS=--experimental-require-module, and with import()
  // otherwise. Under require(), a top-level await anywhere in what the file imports statically
  // stops the function before its first request (see api/index.js).
  let listener;
  try {
    listener = require(process.argv[2]);
  } catch (err) {
    if (err.code !== 'ERR_REQUIRE_ESM') throw err;
    listener = await import(pathToFileURL(process.argv[2]).href);
  }
  for (let i = 0; i < 5 && listener.default; i += 1) listener = listener.default;
  if (typeof listener !== 'function') throw new Error('the function has no default export that handles requests');
  // Vercel adds request helpers unless told not to, or unless the export can listen like a
  // server. They read the body before the function does; only that effect is reproduced here.
  const helpers = process.argv[4] === 'helpers' && typeof listener.listen !== 'function';
  http
    .createServer(async (req, res) => {
      if (helpers && req.headers['content-type'] !== undefined) for await (const chunk of req) void chunk;
      listener(req, res);
    })
    .listen(Number(process.argv[3]), '127.0.0.1', () => process.send?.('ready'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
  );
  // /var/task is read-only on Vercel; only the temporary folder can be written.
  fs.chmodSync(task, 0o555);
  for (const entry of fs.readdirSync(task, { recursive: true })) fs.chmodSync(path.join(task, entry), fs.statSync(path.join(task, entry)).isDirectory() ? 0o555 : 0o444);

  const functionPort = await freePort();
  // Vercel's Node.js runtime refuses to require() an ES module unless NODE_OPTIONS allows it.
  const nodeFlags = requireOfEsModules ? [] : ['--no-experimental-require-module'];
  const child = spawn(process.execPath, [...nodeFlags, runner, path.join(task, meta.handler), String(functionPort), meta.shouldAddHelpers ? 'helpers' : 'no-helpers'], {
    cwd: task,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...functionEnv, VERCEL: '1', VERCEL_ENV: process.env.VERCEL_ENV ?? 'production', VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? `localhost:${port}` },
  });
  const cleanup = () => {
    child.kill('SIGTERM');
    try {
      for (const entry of fs.readdirSync(task, { recursive: true })) fs.chmodSync(path.join(task, entry), 0o755);
      fs.chmodSync(task, 0o755);
      fs.rmSync(task, { recursive: true, force: true });
      fs.rmSync(runner, { force: true });
    } catch {
      // best effort
    }
  };
  try {
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', (code) => reject(new Error(`the function exited while starting (code ${code})`)));
    });
  } catch (err) {
    cleanup();
    throw err;
  }
  child.on('exit', (code) => {
    console.error(`[vercel-local] the function stopped (code ${code})`);
    process.exit(1);
  });
  return { ...fn, port: functionPort, maxDuration: meta.maxDuration, runtime: meta.runtime, files: fs.readdirSync(task, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length, cleanup };
}

const functions = [];
for (const fn of findFunctions(path.join(output, 'functions'))) functions.push(await startFunction(fn));
// /api/index is reachable as /api as well.
const functionFor = (pathname) => functions.find((f) => f.route === pathname || f.route === `${pathname.replace(/\/$/, '')}/index`);

// ── Routing ─────────────────────────────────────────────────────────────────────────────────────
function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.join(staticDir, decoded);
  if (!file.startsWith(staticDir)) return null;
  for (const candidate of [file, path.join(file, 'index.html')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const substitute = (template, match) => template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? '');

function sendStatic(res, file, headers, status = 200) {
  const body = fs.readFileSync(file);
  res.writeHead(status, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=0, must-revalidate', ...headers, 'content-length': body.length });
  res.end(body);
}

function proxy(req, res, fn, url) {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_BODY_BYTES) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n');
    req.resume();
    return;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: fn.port, method: req.method, path: url, headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'http', 'x-vercel-id': `local::${Date.now().toString(36)}` } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`FUNCTION_INVOCATION_FAILED\n${err.message}\n`);
  });
  req.pipe(upstream);
}

function handle(req, res) {
  const asked = new URL(req.url, 'http://local');
  const headers = {};

  /** Serve `target` (a path, possibly with a query string) if a file or a function is there. */
  const serve = (target, rewritten) => {
    const dest = new URL(target, 'http://local');
    const fn = functionFor(dest.pathname);
    if (fn) {
      // The query of the rewrite target and the query the browser sent are merged.
      const query = new URLSearchParams(dest.search);
      for (const [key, value] of asked.searchParams) query.append(key, value);
      const search = query.size > 0 ? `?${query}` : '';
      proxy(req, res, fn, `${rewritten && urlMode === 'original' ? asked.pathname : dest.pathname}${search}`);
      return true;
    }
    const file = staticFile(dest.pathname);
    if (file) {
      sendStatic(res, file, headers);
      return true;
    }
    return false;
  };

  for (const route of config.routes ?? []) {
    if (route.handle === 'filesystem') {
      if (serve(asked.pathname + asked.search, false)) return;
      continue;
    }
    if (route.handle) break; // "error" and "miss": nothing matched
    const match = new RegExp(route.src).exec(asked.pathname);
    if (!match) continue;
    for (const [name, value] of Object.entries(route.headers ?? {})) headers[name.toLowerCase()] = substitute(value, match);
    if (route.dest) {
      if (serve(substitute(route.dest, match), true)) return;
      if (!route.continue) continue;
    }
    if (route.status && !route.dest) {
      res.writeHead(route.status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(`${route.status}\n`);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end('The page could not be found\n\nNOT_FOUND\n');
}

const server = http.createServer(handle);
server.listen(port, host, () => {
  console.log(`[vercel-local] http://localhost:${port} — ${functions.length} function(s), URL mode "${urlMode}", require() of ES modules ${requireOfEsModules ? 'allowed by NODE_OPTIONS' : 'refused (Vercel\'s default)'}`);
  for (const fn of functions) console.log(`[vercel-local]   ${fn.route}  ${fn.runtime}, ${fn.files} files, read-only`);
});

function stop() {
  server.close();
  for (const fn of functions) fn.cleanup();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
