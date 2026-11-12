#!/usr/bin/env node
// Build step on Vercel (vercel.json → buildCommand). See docs/DEPLOYMENT.md, "Vercel and Neon".
//
//   1. generate the database client
//   2. build the web app into frontend/dist (served by Vercel's CDN)
//   3. production deployments only: create or update the database tables, then make sure the
//      essentials exist (role permissions, default grading scale, first administrator)
//
// Preview deployments leave the database alone: a project usually has one database for previews
// and production, and a branch must not change the tables the live site is using. Set
// MIGRATE_ON_BUILD=true on a deployment whose database may be migrated regardless (for example
// when previews get their own database branch), or MIGRATE_ON_BUILD=false to never migrate here.
//
// A migration that failed in an earlier build blocks every later one until it is allowed to run
// again: MIGRATE_RETRY_FAILED=<name of the migration> does that (see scripts/failed-migrations.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgOptionsFromUrl } from '../backend/src/db/connection.js';
import { failedMigrations, markForRetry, summariseLogs } from './failed-migrations.mjs';
import { allowsRequireOfEsModules, findRequiredEsModules } from './required-es-modules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function tool(...segments) {
  const file = path.join(root, 'node_modules', ...segments);
  if (!fs.existsSync(file)) fail(`${path.relative(root, file)} is missing — did "npm install" run?`);
  return file;
}

function run(label, args, { cwd = root, env = {} } = {}) {
  console.log(`\n▸ ${label}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) fail(`"${label}" failed${result.signal ? ` (${result.signal})` : ''}.`);
}

const firstSet = (...names) => names.map((name) => process.env[name]?.trim()).find(Boolean);

// The project runs Prisma with its JavaScript engines, so nothing has to be downloaded.
const prismaEnv = { PRISMA_SCHEMA_ENGINE: 'js', CHECKPOINT_DISABLE: '1' };
const prisma = tool('prisma', 'build', 'index.js');

run('Generating the database client', [prisma, 'generate'], { cwd: backend, env: prismaEnv });
run('Building the web app', [tool('vite', 'bin', 'vite.js'), 'build'], { cwd: frontend });
if (!fs.existsSync(path.join(frontend, 'dist', 'index.html'))) fail('The web app build produced no index.html.');

// The address that e-mail links and attendance QR codes will point to.
const publicUrl = process.env.APP_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
if (publicUrl) console.log(`\n▸ Public address of the site: ${publicUrl}`);
else console.warn('\n! The public address of the site is unknown. Set APP_URL in the project settings, or links in e-mails and QR codes will be wrong.');

// Dependencies that load an ES module with require(). Node.js allows that; Vercel's Node.js
// runtime only does when NODE_OPTIONS says so, and otherwise the function ends before its first
// request while this build still counts as a success. Better to stop here, where the previous
// deployment stays live and the reason can be read.
const requiredEsModules = findRequiredEsModules(backend);
if (requiredEsModules.length > 0) {
  const list = requiredEsModules.map((found) => `${found.package} (${found.file}) requires ${found.requires}`).join('; ');
  if (allowsRequireOfEsModules()) {
    console.log(`\n▸ Loaded with require() although they are ES modules, which NODE_OPTIONS allows: ${list}.`);
  } else if (process.env.VERCEL === '1') {
    fail(
      `The API would not start on Vercel: ${list}. That is an ES module, and Vercel's Node.js runtime refuses to require() one ` +
        'unless the project has the environment variable NODE_OPTIONS=--experimental-require-module. ' +
        'Add it for Production and Preview (Project → Settings → Environment Variables) and deploy again. See docs/DEPLOYMENT.md, "Vercel and Neon".',
    );
  }
}

// How far the database is from the functions. A function pays for that distance on every query,
// and one page of the app asks for several. Only the region is read from the database's address
// (Neon puts it in the host name); the address itself is not printed.
const NEAREST_VERCEL_REGION = {
  'us-east-1': 'iad1',
  'us-east-2': 'cle1',
  'us-west-2': 'pdx1',
  'eu-central-1': 'fra1',
  'eu-west-2': 'lhr1',
  'ap-southeast-1': 'sin1',
  'ap-southeast-2': 'syd1',
  'sa-east-1': 'gru1',
};
let databaseHost = '';
try {
  databaseHost = new URL(firstSet('DATABASE_URL', 'POSTGRES_URL') ?? '').hostname;
} catch {
  // No address, or not a URL: the application says so when it starts.
}
const databaseRegion = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(databaseHost)?.[1];
const nearestRegion = NEAREST_VERCEL_REGION[databaseRegion];
if (nearestRegion) {
  const functionRegion = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).regions?.[0];
  if (functionRegion === nearestRegion) {
    console.log(`\n▸ Database in ${databaseRegion}, functions in ${functionRegion}: next to each other.`);
  } else if (functionRegion) {
    console.warn(`\n! The database is in ${databaseRegion} and vercel.json runs the functions in ${functionRegion}: every query travels between the two. The Vercel region next to the database is ${nearestRegion}.`);
  } else if (nearestRegion !== 'iad1') {
    console.warn(`\n! The database is in ${databaseRegion}. Functions run in iad1 (Washington, D.C.) unless told otherwise, and every query then travels between the two. Add "regions": ["${nearestRegion}"] to vercel.json.`);
  }
}

/**
 * Stops with an explanation when the database records a failed migration — Prisma would only
 * answer "P3009" — unless MIGRATE_RETRY_FAILED names it, in which case it is allowed to run again.
 */
async function settleFailedMigrations(databaseUrl) {
  // node-postgres belongs to the API; resolve it from there, wherever npm put it.
  const pg = createRequire(path.join(backend, 'package.json'))('pg');
  const client = new pg.Client({ ...pgOptionsFromUrl(databaseUrl), connectionTimeoutMillis: 20_000 });
  try {
    await client.connect();
  } catch {
    return; // Unreachable or misconfigured: the migration step that follows reports it properly.
  }
  try {
    const retry = process.env.MIGRATE_RETRY_FAILED?.trim();
    for (const failed of await failedMigrations(client)) {
      if (retry === failed.name) {
        await markForRetry(client, failed.name);
        console.log(`\n▸ MIGRATE_RETRY_FAILED: the migration ${failed.name}, which failed earlier, will run again. Remove the variable once this build has succeeded.`);
        continue;
      }
      fail(
        `The database records the migration ${failed.name} as failed (started ${new Date(failed.startedAt).toISOString()}): ${summariseLogs(failed.logs) || 'no details were kept'}.\n` +
          '  Nothing newer is applied until that is settled. Each migration runs as one transaction, so a failed one left nothing behind: once its cause is gone it can simply run again.\n' +
          `  To allow that, add the environment variable MIGRATE_RETRY_FAILED=${failed.name} for Production (Project → Settings → Environment Variables), deploy again, and remove the variable afterwards.\n` +
          '  The site keeps running on the previous deployment meanwhile. See docs/DEPLOYMENT.md, "If a migration fails".',
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const target = process.env.VERCEL_ENV ?? 'local';
const override = process.env.MIGRATE_ON_BUILD?.trim().toLowerCase();
const migrate = override ? override === 'true' || override === '1' : target === 'production';

if (!migrate) {
  console.log(`\n▸ Database left as it is (${target} build${override ? ', MIGRATE_ON_BUILD is off' : ''}).`);
} else {
  // Migrations need the direct address of the database, not the pooled one the functions use.
  const databaseUrl = firstSet('DIRECT_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL', 'POSTGRES_URL');
  if (!databaseUrl) {
    fail('No database is connected. Add a PostgreSQL database to the Vercel project (it must provide DATABASE_URL) and deploy again.');
  }
  await settleFailedMigrations(databaseUrl);
  // NODE_ENV is set here on purpose: outside production the seed would load the demo school.
  const env = { ...prismaEnv, DATABASE_URL: databaseUrl, NODE_ENV: 'production' };
  run('Creating or updating the database tables', [prisma, 'migrate', 'deploy'], { cwd: backend, env });
  run('Role permissions, default grading scale, first administrator', ['prisma/seed.js'], { cwd: backend, env });
}

// TEMPORARY, for this branch only: see scripts/judge-probe.mjs.
if (process.env.EDUSPHERE_JUDGE_PROBE === '1' && target !== 'production') {
  console.log('\n▸ Exploring Vercel Sandbox for running programs (temporary)');
  spawnSync(process.execPath, ['scripts/judge-probe.mjs'], { cwd: root, stdio: 'inherit', timeout: 25 * 60_000 });
}

console.log('\n✓ Build finished.');
