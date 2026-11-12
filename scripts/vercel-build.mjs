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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Which database the functions will use (the host only) and how far it is from them. A function
// pays for that distance on every query, and one page of the app asks for several.
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
const runtimeDatabaseUrl = firstSet('DATABASE_URL', 'POSTGRES_URL');
if (runtimeDatabaseUrl) {
  let host = '';
  try {
    host = new URL(runtimeDatabaseUrl).hostname;
  } catch {
    // The application will say what is wrong with the URL when it starts.
  }
  if (host) console.log(`\n▸ Database: ${host}`);
  const databaseRegion = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host)?.[1];
  const nearest = NEAREST_VERCEL_REGION[databaseRegion];
  if (nearest) {
    const configured = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).regions?.[0];
    if (configured && configured !== nearest) {
      console.warn(`! The database is in ${databaseRegion} and vercel.json runs the functions in ${configured}: every query travels between the two. The Vercel region next to the database is ${nearest}.`);
    } else if (!configured && nearest !== 'iad1') {
      console.warn(`! The database is in ${databaseRegion}. Functions run in iad1 (Washington, D.C.) unless told otherwise, and every query then travels between the two. Add "regions": ["${nearest}"] to vercel.json.`);
    }
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
  // NODE_ENV is set here on purpose: outside production the seed would load the demo school.
  const env = { ...prismaEnv, DATABASE_URL: databaseUrl, NODE_ENV: 'production' };
  run('Creating or updating the database tables', [prisma, 'migrate', 'deploy'], { cwd: backend, env });
  run('Role permissions, default grading scale, first administrator', ['prisma/seed.js'], { cwd: backend, env });
}

console.log('\n✓ Build finished.');
