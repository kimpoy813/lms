#!/usr/bin/env node
// Deletes EVERYTHING in the database, re-creates the tables from the migrations and loads the
// demo data again. For development and test databases only.
//
//   npm run db:reset              asks for confirmation
//   npm run db:reset -- --yes     no question (scripts, CI)
//   npm run db:reset -- --empty   do not load the demo data afterwards
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));

for (const file of [path.join(backend, '.env'), path.join(backend, '..', '.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // .env files are optional
  }
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (see backend/.env.example).');
if (process.env.NODE_ENV === 'production') fail('Refusing to reset the database while NODE_ENV=production.');

let target;
try {
  const url = new URL(process.env.DATABASE_URL);
  target = `${decodeURIComponent(url.pathname.slice(1))} on ${url.hostname}:${url.port || 5432}`;
} catch {
  fail('DATABASE_URL is not a valid connection URL.');
}

if (!flags.has('--yes')) {
  if (!process.stdin.isTTY) fail(`This deletes all data in "${target}". Run it again with "-- --yes" to confirm.`);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`This deletes ALL data in "${target}". Type "reset" to continue: `);
  prompt.close();
  if (answer.trim().toLowerCase() !== 'reset') fail('Nothing was changed.');
}

function cli(...parts) {
  for (const base of [backend, path.join(backend, '..')]) {
    const file = path.join(base, 'node_modules', ...parts);
    if (fs.existsSync(file)) return file;
  }
  return fail(`Cannot find ${parts.join('/')} — run "npm install" first.`);
}

function step(label, args) {
  console.log(`\n› ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: backend, stdio: 'inherit', env: process.env });
  if (result.status !== 0) fail(`${label} failed.`);
}

step('Dropping and re-creating the tables', [cli('prisma', 'build', 'index.js'), 'migrate', 'reset', '--force', '--skip-seed', '--skip-generate']);
if (!flags.has('--empty')) step('Loading the demo data', [path.join('prisma', 'seed.js')]);
console.log('\nDone. Restart the API if it is running (it caches settings and permissions).');
