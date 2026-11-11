#!/usr/bin/env node
// Starts a real PostgreSQL server from the `embedded-postgres` npm package — handy when you have
// neither Docker nor a system PostgreSQL. Development and CI only; use a managed or properly
// administered PostgreSQL in production.
//
//   npm run db:embedded
//
// Environment:
//   EMBEDDED_PG_PORT      (default 5433)
//   EMBEDDED_PG_DIR       (default .local/postgres)
//   EMBEDDED_PG_DATABASE  (default edusphere)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.EMBEDDED_PG_PORT ?? 5433);
const databaseDir = path.resolve(root, process.env.EMBEDDED_PG_DIR ?? '.local/postgres');
const database = process.env.EMBEDDED_PG_DATABASE ?? 'edusphere';
const user = 'postgres';
const password = 'postgres';

const server = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  onLog: () => {},
  onError: (message) => {
    const text = String(message ?? '');
    if (/FATAL|PANIC/.test(text)) console.error(text.trim());
  },
});

if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  fs.mkdirSync(databaseDir, { recursive: true });
  await server.initialise();
}
await server.start();

const client = server.getPgClient('postgres');
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
await client.end();

console.log(`Embedded PostgreSQL is ready on port ${port}`);
console.log(`DATABASE_URL=postgresql://${user}:${password}@127.0.0.1:${port}/${database}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 2 ** 30);
