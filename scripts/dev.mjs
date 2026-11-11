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
const flags = new Set(process.argv.slice(2));
const children = [];
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (text) => console.log(color('1;36', `[dev] ${text}`));

function stop(code = 0) {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
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
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(color('31', `[dev] ${label} stopped (exit code ${code}).`));
    stop(code ?? 0);
  });
  children.push(child);
  return child;
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
  say(`no database on port ${dbPort} — starting the embedded PostgreSQL (first start downloads nothing, it ships with npm)`);
  start('db', process.execPath, ['scripts/embedded-postgres.mjs'], { env: { EMBEDDED_PG_PORT: String(dbPort), EMBEDDED_PG_DATABASE: db.pathname.slice(1) || 'edusphere' }, tint: '35' });
  for (let i = 0; i < 120 && !(await reachable(db.hostname, dbPort)); i += 1) await new Promise((r) => setTimeout(r, 500));
  if (!(await reachable(db.hostname, dbPort))) {
    console.error('The embedded PostgreSQL did not start.');
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 1500)); // let it create the database
}

// 3. Schema and data
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  if (!fs.existsSync(path.join(root, 'node_modules', '.prisma', 'client', 'client.js'))) await run('prisma', npx, ['prisma', 'generate'], { cwd: backend });
  await run('prisma', npx, ['prisma', 'migrate', 'deploy'], { cwd: backend });
  if (!flags.has('--no-seed')) await run('seed', process.execPath, ['prisma/seed.js'], { cwd: backend });
} catch (err) {
  console.error(color('31', `[dev] ${err.message}`));
  stop(1);
}

// 4. Servers
start('api', process.execPath, ['--watch', 'src/server.js'], { cwd: backend, tint: '32' });
if (!flags.has('--api-only')) start('web', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '-w', 'frontend'], { tint: '34' });
say(flags.has('--api-only') ? 'API on http://localhost:4000' : 'API on http://localhost:4000 · web app on http://localhost:5173');
