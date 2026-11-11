// Runs once before the whole suite: provides a real PostgreSQL database with the committed
// migrations applied, and removes it afterwards.
//
//   • TEST_DATABASE_URL set   → that server is used (any database on it; a throw-away database
//                               is created next to it and dropped at the end).
//   • otherwise               → a private PostgreSQL instance is started from the
//                               `embedded-postgres` package in a temp directory.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'prisma', 'migrations');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function migrationFiles() {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, file: path.join(migrationsDir, name, 'migration.sql') }));
}

export default async function setup(project) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edusphere-test-'));
  let embedded = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = await freePort();
    embedded = new EmbeddedPostgres({
      databaseDir: path.join(tmpRoot, 'pg'),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  }

  const database = `edusphere_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const databaseUrl = url.toString();

  // Apply the committed migrations exactly as they will run in production.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  for (const migration of migrationFiles()) {
    await client.query(fs.readFileSync(migration.file, 'utf8'));
  }
  await client.end();

  const storageDir = path.join(tmpRoot, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  project.provide('databaseUrl', databaseUrl);
  project.provide('adminDatabaseUrl', adminUrl);
  project.provide('storageDir', storageDir);

  return async function teardown() {
    try {
      const drop = new pg.Client({ connectionString: adminUrl });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await drop.end();
    } catch {
      // the embedded server is discarded below anyway
    }
    if (embedded) await embedded.stop().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
}
