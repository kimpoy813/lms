// Hosting details that are easy to break without noticing: how a database URL turns into
// connection options, and whether vercel.json still matches what the application does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { pgFieldsFromUrl, pgOptionsFromUrl } from '../../src/db/connection.js';
import { PYTHON_SANDBOX_PREFIX, pythonSandboxHeaders, webAppFileHeaders } from '../../src/lib/pythonSandbox.js';
import { isDatabaseUnavailable, isSchemaOutOfDate } from '../../src/middleware/errors.js';
import { allowsRequireOfEsModules, findRequiredEsModules } from '../../../scripts/required-es-modules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('database connection options', () => {
  it('leaves a plain local URL alone', () => {
    const url = 'postgresql://postgres:postgres@127.0.0.1:5433/edusphere';
    expect(pgOptionsFromUrl(url)).toEqual({ connectionString: url });
  });

  it('encrypts and checks the certificate when a hosted database asks for sslmode=require', () => {
    const options = pgOptionsFromUrl('postgresql://app:secret@ep-quiet-1.eu.aws.neon.tech/neondb?sslmode=require&channel_binding=require&connect_timeout=15');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.enableChannelBinding).toBe(true);
    // The TLS decisions are made here; node-postgres must not read them a second time.
    expect(options.connectionString).toBe('postgresql://app:secret@ep-quiet-1.eu.aws.neon.tech/neondb?connect_timeout=15');
  });

  it('skips the certificate check only when told to, and uses no TLS when told to', () => {
    expect(pgOptionsFromUrl('postgresql://u:p@db.internal/app?sslmode=no-verify').ssl).toEqual({ rejectUnauthorized: false });
    expect(pgOptionsFromUrl('postgresql://u:p@db.internal/app?sslmode=verify-full').ssl).toEqual({ rejectUnauthorized: true });
    expect(pgOptionsFromUrl('postgresql://u:p@db.internal/app?sslmode=disable').ssl).toBeUndefined();
    // Channel binding only means something on an encrypted connection.
    expect(pgOptionsFromUrl('postgresql://u:p@db.internal/app?channel_binding=require').enableChannelBinding).toBeUndefined();
  });

  it('passes unusual URLs through untouched', () => {
    const clientCert = 'postgresql://u:p@db.internal/app?sslmode=verify-full&sslcert=/etc/client.crt&sslkey=/etc/client.key';
    expect(pgOptionsFromUrl(clientCert)).toEqual({ connectionString: clientCert });
    expect(pgOptionsFromUrl('not a url')).toEqual({ connectionString: 'not a url' });
    const socket = 'postgresql:///app?host=/var/run/postgresql';
    expect(pgOptionsFromUrl(socket)).toEqual({ connectionString: socket });
  });

  it('gives the migration tool the same connection as separate fields', () => {
    expect(pgFieldsFromUrl('postgresql://app%40team:p%2Fss%3Aword@db.example.org:6543/school%20db?sslmode=require')).toEqual({
      host: 'db.example.org', port: 6543, user: 'app@team', password: 'p/ss:word', database: 'school db', ssl: { rejectUnauthorized: true },
    });
    expect(pgFieldsFromUrl('postgresql://postgres:postgres@127.0.0.1/edusphere')).toEqual({ host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'edusphere' });
  });
});

describe('a database that is away', () => {
  // The shapes are what Prisma, its PostgreSQL adapter and node-postgres really throw.
  const adapterError = (cause) => ({ code: 'P2010', meta: { driverAdapterError: { name: 'DriverAdapterError', cause } } });

  it('is recognised however the failure is reported', () => {
    expect(isDatabaseUnavailable({ code: 'P1001', message: "Can't reach database server at db:5432" })).toBe(true);
    expect(isDatabaseUnavailable({ code: 'P2024', message: 'Timed out fetching a new connection from the connection pool.' })).toBe(true);
    expect(isDatabaseUnavailable(adapterError({ kind: 'DatabaseNotReachable', host: 'db', port: 5432 }))).toBe(true);
    expect(isDatabaseUnavailable(adapterError({ kind: 'ConnectionClosed' }))).toBe(true);
    expect(isDatabaseUnavailable(adapterError({ kind: 'TooManyConnections', cause: 'sorry, too many clients already' }))).toBe(true);
    // PostgreSQL itself: "the database system is starting up", an administrator's shutdown, a lost connection.
    expect(isDatabaseUnavailable(adapterError({ kind: 'postgres', originalCode: '57P03' }))).toBe(true);
    expect(isDatabaseUnavailable(adapterError({ kind: 'postgres', originalCode: '57P01' }))).toBe(true);
    expect(isDatabaseUnavailable(adapterError({ kind: 'postgres', originalCode: '08006' }))).toBe(true);
    expect(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDatabaseUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('is not confused with a mistake in the request or in the configuration', () => {
    expect(isDatabaseUnavailable(adapterError({ kind: 'UniqueConstraintViolation', originalCode: '23505' }))).toBe(false);
    expect(isDatabaseUnavailable(adapterError({ kind: 'TableDoesNotExist', originalCode: '42P01', table: 'User' }))).toBe(false);
    // These do not go away by trying again, so they stay server errors with the cause in the log.
    expect(isDatabaseUnavailable(adapterError({ kind: 'AuthenticationFailed', originalCode: '28P01', user: 'app' }))).toBe(false);
    expect(isDatabaseUnavailable(adapterError({ kind: 'TlsConnectionError', reason: 'self-signed certificate' }))).toBe(false);
    expect(isDatabaseUnavailable({ code: 'P2025', message: 'Record not found' })).toBe(false);
    expect(isDatabaseUnavailable(new Error('boom'))).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
  });

  it('is told apart from a database whose tables were never created or updated', () => {
    const missingTable = adapterError({ kind: 'TableDoesNotExist', originalCode: '42P01', table: 'SystemSetting' });
    expect(isSchemaOutOfDate(missingTable)).toBe(true);
    expect(isSchemaOutOfDate(adapterError({ kind: 'ColumnNotFound', originalCode: '42703', column: 'runtime' }))).toBe(true);
    expect(isSchemaOutOfDate({ code: 'P2021', message: 'The table `public.User` does not exist in the current database.' })).toBe(true);
    expect(isSchemaOutOfDate(adapterError({ kind: 'UniqueConstraintViolation', originalCode: '23505' }))).toBe(false);
    expect(isSchemaOutOfDate(adapterError({ kind: 'DatabaseNotReachable' }))).toBe(false);
    expect(isSchemaOutOfDate(new Error('boom'))).toBe(false);
  });
});

describe('readiness', () => {
  it('means the database answers and has the tables this version needs', async () => {
    const res = await request(createApp()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', databaseMs: expect.any(Number) });
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const staticHeaders = Object.fromEntries(config.headers[0].headers.map((h) => [h.key.toLowerCase(), h.value]));

  it('gives the web app the same security headers the API sends', async () => {
    // On Vercel the pages come from the CDN, not from the API, so the headers are repeated in
    // vercel.json. This fails when one side changes without the other.
    const res = await request(createApp()).get('/healthz');
    const fromApi = Object.fromEntries(
      Object.entries(res.headers).filter(([name]) => /^(content-security-policy|permissions-policy|referrer-policy|origin-agent-cluster|cross-origin-|x-(?!request-id))/.test(name)),
    );
    expect(Object.keys(fromApi).length).toBeGreaterThanOrEqual(10);
    expect(staticHeaders).toEqual(fromApi);
  });

  it('keeps those headers away from API responses, which set their own', () => {
    // A stored file is served with a stricter policy than a page; a blanket header would undo it.
    // The frame for Python programs has a rule of its own (below).
    expect(config.headers[0].source).toBe('/((?!api$|api/|healthz$|readyz$|pyrunner/).*)');
  });

  it('shuts the frame that runs students’ Python programs off from the site, as the API does when it serves the web app', () => {
    const rule = config.headers[1];
    expect(rule.source).toBe(`${PYTHON_SANDBOX_PREFIX}(.*)`);
    const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    // A page's headers, with the sandbox's own in place of three of them.
    expect(Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]))).toEqual({ ...staticHeaders, ...lower(pythonSandboxHeaders()) });
    expect(Object.keys(pythonSandboxHeaders()).sort()).toEqual(['Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy']);

    const policy = Object.fromEntries(pythonSandboxHeaders()['Content-Security-Policy'].split(';').map((directive) => { const [name, ...values] = directive.trim().split(/\s+/); return [name, values]; }));
    expect(policy.sandbox).toEqual(['allow-scripts']); // an origin of its own: no cookies, no storage, no same-origin anything
    expect(policy['default-src']).toEqual(["'none'"]);
    expect(policy['connect-src']).toEqual(["'none'"]); // no network for the program
    expect(policy['script-src']).not.toContain("'self'"); // nothing of the site is loaded as a script
    expect(policy['frame-ancestors']).toEqual(["'self'"]);
    expect(pythonSandboxHeaders('https://school.example')['Content-Security-Policy']).toContain('frame-ancestors https://school.example;');

    // Exactly the files below pyrunner/ get them, whatever the separator of the system.
    for (const file of ['pyrunner/frame.html', 'pyrunner\\frame.html']) expect(webAppFileHeaders(file, "'self'")).toEqual({ 'Cache-Control': 'no-cache', ...pythonSandboxHeaders() });
    expect(webAppFileHeaders('index.html', "'self'")).toEqual({ 'Cache-Control': 'no-cache' });
    expect(webAppFileHeaders('pyrunner.html', "'self'")).toEqual({ 'Cache-Control': 'no-cache' });
    expect(webAppFileHeaders('assets/pyodide.asm-abc123.wasm', "'self'")).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
    expect(webAppFileHeaders('img/assets/logo.svg', "'self'")).toEqual({ 'Cache-Control': 'no-cache' });

    // And the frame is where both sides expect it.
    expect(fs.existsSync(path.join(root, 'frontend', 'public', PYTHON_SANDBOX_PREFIX, 'frame.html'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'frontend', 'src', 'lib', 'pyRunner', 'sandbox.js'), 'utf8')).toContain('`${import.meta.env.BASE_URL}pyrunner/frame.html`');
  });

  it('sends the API paths and the health checks to the one function', () => {
    expect(config.rewrites.slice(0, 3)).toEqual([
      { source: '/api/(.*)', destination: '/api?__path=api/$1' },
      { source: '/healthz', destination: '/api?__path=healthz' },
      { source: '/readyz', destination: '/api?__path=readyz' },
    ]);
    expect(fs.existsSync(path.join(root, 'api', 'index.js'))).toBe(true);
    expect(Object.keys(config.functions)).toEqual(['api/index.js']);
  });

  it('ships the file the database client reads at run time but does not import', () => {
    // Vercel copies what the code imports. The query compiler is read from disk by its path, so
    // it has to be named; without it no query works.
    expect(config.functions['api/index.js'].includeFiles).toBe('node_modules/.prisma/client/query_compiler_bg.wasm');
    expect(fs.existsSync(path.join(root, config.functions['api/index.js'].includeFiles))).toBe(true);
  });

  it('schedules a call that the API answers', async () => {
    expect(config.crons).toEqual([{ path: '/api/internal/cron', schedule: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    const res = await request(createApp()).get(config.crons[0].path);
    expect(res.status).not.toBe(404);
  });

  it('leaves .env files out of the function', () => {
    // A build made on somebody's own computer (`vercel build`) finds the developer's .env next to
    // the code, because the configuration names that path. It must not travel with the function.
    const excluded = /^\{(.+)\}$/.exec(config.functions['api/index.js'].excludeFiles)[1].split(',');
    expect(excluded).toEqual(expect.arrayContaining(['.env', '.env.*', 'backend/.env', 'backend/.env.*']));
    // Nothing the function needs is under these.
    expect(excluded.filter((pattern) => !pattern.includes('.env'))).toEqual(['frontend/**', 'e2e/**', 'docs/**']);
  });
});

describe('.env files', () => {
  const before = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL };
  afterEach(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Which files the configuration reads when it is loaded in this environment. */
  async function filesRead(vars) {
    Object.assign(process.env, vars);
    const read = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.resetModules();
    await import('../../src/config/env.js');
    return read.mock.calls.map(([file]) => path.relative(root, file));
  }

  it('are read on a server, the one of the API first', async () => {
    delete process.env.VERCEL;
    expect(await filesRead({ NODE_ENV: 'development' })).toEqual([path.join('backend', '.env'), '.env']);
  });

  it('are never read on Vercel, where the project’s settings are the configuration', async () => {
    // Also not one that came along inside the function: with development settings in it
    // (cookies without "Secure", a folder for uploads that cannot be written) it would undo the site.
    expect(await filesRead({ NODE_ENV: 'development', VERCEL: '1' })).toEqual([]);
    expect(await filesRead({ NODE_ENV: 'production', VERCEL: '1' })).toEqual([]);
  });

  it('are not read by the tests', async () => {
    delete process.env.VERCEL;
    expect(await filesRead({ NODE_ENV: 'test' })).toEqual([]);
  });
});

describe('dependencies that load an ES module with require()', () => {
  // Vercel's Node.js runtime refuses that unless NODE_OPTIONS=--experimental-require-module is
  // set; a function that needs it does not start. The build step stops on what this finds.
  function install(dir, files) {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    }
  }

  it('finds them among what a package installs for running, and nothing else', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'required-es-modules-'));
    try {
      install(app, {
        'package.json': { name: 'app', type: 'module', dependencies: { old: '*', modern: '*' }, devDependencies: { tool: '*' } },
        // CommonJS that requires: an ES-module-only package (twice), one with a CommonJS build,
        // a CommonJS one, and one that is not installed.
        'node_modules/old/package.json': { name: 'old', dependencies: { modern: '*', both: '*', plain: '*' } },
        'node_modules/old/index.js': "require('modern'); require('both'); require('plain'); require('missing'); module.exports = require('./lib/more');",
        'node_modules/old/lib/more.js': 'const again = require("modern"); const part = require("modern/part.js");',
        'node_modules/old/lib/imports.mjs': "import 'modern';",
        'node_modules/modern/package.json': { name: 'modern', type: 'module', main: 'index.js' },
        'node_modules/modern/index.js': 'export const x = 1;',
        'node_modules/modern/part.js': 'export const y = 2;',
        'node_modules/both/package.json': { name: 'both', type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
        'node_modules/both/index.js': 'export const z = 3;',
        'node_modules/both/index.cjs': 'exports.z = 3;',
        'node_modules/plain/package.json': { name: 'plain' },
        'node_modules/plain/index.js': 'module.exports = 4;',
        // A development tool doing the same is not part of what runs.
        'node_modules/tool/package.json': { name: 'tool', dependencies: { modern: '*' } },
        'node_modules/tool/index.js': "require('modern');",
      });
      expect(findRequiredEsModules(app)).toEqual([
        { package: 'old', file: 'index.js', requires: 'modern' },
        { package: 'old', file: path.join('lib', 'more.js'), requires: 'modern/part.js' },
      ]);
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });

  it('recognises the setting that allows it', () => {
    expect(allowsRequireOfEsModules('--experimental-require-module')).toBe(true);
    expect(allowsRequireOfEsModules('--max-old-space-size=2048 --require-module')).toBe(true);
    expect(allowsRequireOfEsModules('--no-experimental-require-module')).toBe(false);
    expect(allowsRequireOfEsModules('')).toBe(false);
  });

  it('is documented for as long as this project needs it', () => {
    const found = findRequiredEsModules(path.join(root, 'backend'));
    const guide = fs.readFileSync(path.join(root, 'docs', 'DEPLOYMENT.md'), 'utf8');
    // When this list becomes empty, NODE_OPTIONS can leave the guide and the Vercel project.
    if (found.length > 0) expect(guide).toContain('NODE_OPTIONS=--experimental-require-module');
    for (const entry of found) expect(guide).toContain(entry.package);
  });
});
