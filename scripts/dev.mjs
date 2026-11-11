#!/usr/bin/env node
// One command for local development:  npm run dev
//
//   1. creates backend/.env from .env.example when it is missing
//   2. starts the embedded PostgreSQL when DATABASE_URL points at it and nothing is listening
//   3. applies migrations and seeds the demo data (both are safe to repeat)
//   4. runs the API (http://localhost:4000) and the web app (http://localhost:5173) with reload
//
// Flags:  --no-seed   skip seeding      --api-only   do not start the web app
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');
const flags = new Set(process.argv.slice(2));

/**
 * The JavaScript entry point of an installed command-line tool. Tools are started with the running
 * Node binary instead of their npx/npm shims, which also works on Windows without a shell.
 */
function cli(workspace, ...parts) {
  for (const base of [workspace, root]) {
    const file = path.join(base, 'node_modules', ...parts);
    if (fs.existsSync(file)) return file;
  }
  console.error(`Cannot find ${parts.join('/')} — run "npm install" in ${root} first.`);
  process.exit(1);
}
const children = [];
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (text) => console.log(color('1;36', `[dev] ${text}`));

let stopping = false;
/** Ask every child to finish, give the database a moment to shut down cleanly, then exit. */
function stop(code = 0) {
  if (!stopping) {
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    const deadline = Date.now() + 8000;
    const timer = setInterval(() => {
      if (children.every((child) => child.exitCode !== null || child.signalCode !== null) || Date.now() > deadline) {
        clearInterval(timer);
        process.exit(code);
      }
    }, 100);
  }
  return new Promise(() => {}); // never resolves: the process exits from the timer above
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

/** Run a command to completion, echoing its output with a prefix. */
function run(label, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    pipe(child, label);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))));
  });
}

function pipe(child, label, tint = '2') {
  const prefix = color(tint, `[${label}] `);
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.trim()) console.log(prefix + line);
    });
  }
}

/** Start a long-running process; when it stops, everything stops. */
function start(label, command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(child, label, options.tint);
  child.on('error', (err) => {
    console.error(color('31', `[dev] could not start ${label}: ${err.message}`));
    stop(1);
  });
  child.on('exit', (code) => {
    if (stopping) return;
    if (code !== null && code !== 0) console.error(color('31', `[dev] ${label} stopped (exit code ${code}).`));
    stop(code ?? 0);
  });
  children.push(child);
  return child;
}

/** Resolves true when the child prints a line matching `pattern`, false when it exits or time runs out. */
function sawLine(child, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let seen = '';
    const finish = (value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(value);
    };
    const onData = (chunk) => {
      seen = (seen + chunk).slice(-4000);
      if (pattern.test(seen)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout.on('data', onData);
    child.once('exit', () => finish(false));
  });
}

const reachable = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });

// 1. Configuration
const envFile = path.join(backend, '.env');
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, fs.readFileSync(path.join(backend, '.env.example'), 'utf8').replace('PASSWORD_HASH_COST=15', 'PASSWORD_HASH_COST=12'));
  say('created backend/.env from .env.example');
}
try {
  process.loadEnvFile(envFile);
} catch (err) {
  console.error(`Cannot read backend/.env: ${err.message}`);
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in backend/.env');
  process.exit(1);
}
process.env.PRISMA_SCHEMA_ENGINE ??= 'js';
process.env.CHECKPOINT_DISABLE ??= '1';

// 2. Database
const db = new URL(databaseUrl);
const dbPort = Number(db.port || 5432);
if (!(await reachable(db.hostname, dbPort))) {
  const local = ['127.0.0.1', 'localhost', '::1'].includes(db.hostname);
  if (!local) {
    console.error(`The database at ${db.hostname}:${dbPort} is not reachable. Check DATABASE_URL in backend/.env.`);
    process.exit(1);
  }
  say(`no database on port ${dbPort} — starting the embedded PostgreSQL that ships with the npm packages`);
  const server = start('db', process.execPath, ['scripts/embedded-postgres.mjs'], { env: { EMBEDDED_PG_PORT: String(dbPort), EMBEDDED_PG_DATABASE: decodeURIComponent(db.pathname.slice(1)) || 'edusphere' }, tint: '35' });
  // The helper prints this line once the server accepts connections and the database exists.
  const ready = await sawLine(server, /Embedded PostgreSQL is ready/, 120_000);
  if (!ready) {
    console.error(color('31', '[dev] The embedded PostgreSQL did not start — see the [db] lines above. To use your own PostgreSQL, set DATABASE_URL in backend/.env.'));
    await stop(1);
  }
}

// 3. Schema and data
const prisma = cli(backend, 'prisma', 'build', 'index.js');
try {
  if (!fs.existsSync(path.join(root, 'node_modules', '.prisma', 'client', 'client.js'))) await run('prisma', process.execPath, [prisma, 'generate'], { cwd: backend });
  await run('prisma', process.execPath, [prisma, 'migrate', 'deploy'], { cwd: backend });
  if (!flags.has('--no-seed')) await run('seed', process.execPath, ['prisma/seed.js'], { cwd: backend });
} catch (err) {
  console.error(color('31', `[dev] ${err.message}`));
  await stop(1);
}

// 4. Servers
const apiPort = process.env.PORT ?? '4000';
start('api', process.execPath, ['--watch', 'src/server.js'], { cwd: backend, tint: '32' });
if (!flags.has('--api-only')) {
  // The dev server forwards /api and /socket.io to the API, so the browser only ever talks to one origin.
  start('web', process.execPath, [cli(frontend, 'vite', 'bin', 'vite.js')], { cwd: frontend, env: { VITE_API_PROXY: process.env.VITE_API_PROXY ?? `http://127.0.0.1:${apiPort}` }, tint: '34' });
}
say(flags.has('--api-only') ? `API on http://localhost:${apiPort}` : `open http://localhost:5173 (the API listens on port ${apiPort})`);
