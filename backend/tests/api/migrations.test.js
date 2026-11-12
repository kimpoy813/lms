// Migrations: how they are applied, what happens when one fails, and what the data-only ones do.
//
// Production applies migrations with Prisma's JavaScript engine through the adapter in
// prisma/js-engine-adapter.js (see scripts/vercel-build.mjs). The other tests create their schema
// with one plain query, so only this file notices when that adapter treats a file differently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createClass, createUser, prepare, prisma } from '../helpers/index.js';
import { createMigrationAdapter } from '../../prisma/js-engine-adapter.js';
import { pgOptionsFromUrl } from '../../src/db/connection.js';
import { failedMigrations, markForRetry, summariseLogs } from '../../../scripts/failed-migrations.mjs';

beforeAll(prepare);

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations');

describe('migrations', () => {
  const url = inject('databaseUrl');
  const schema = `mig_${process.pid}`;
  let client;
  let connection;

  beforeAll(async () => {
    // These tests run SQL of their own: only ever against the throw-away database of this run.
    expect(new URL(url).pathname).toMatch(/^\/edusphere_test_/);
    client = new pg.Client(pgOptionsFromUrl(url));
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    // The adapter Prisma's JavaScript engine applies migrations with — the one production uses.
    connection = await createMigrationAdapter(url).connect();
  });
  afterAll(async () => {
    await connection?.dispose();
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it('are applied whole: a semicolon in a comment or in quoted text is not the end of a statement', async () => {
    await connection.executeScript(`
      -- A comment may contain a semicolon; so may text.
      CREATE TABLE "${schema}"."note" ("id" SERIAL PRIMARY KEY, "text" TEXT NOT NULL);
      /* another; comment */
      INSERT INTO "${schema}"."note" ("text") VALUES ('first; second'), ('third');
    `);
    const rows = await client.query(`SELECT "text" FROM "${schema}"."note" ORDER BY "id"`);
    expect(rows.rows.map((r) => r.text)).toEqual(['first; second', 'third']);
  });

  it('are applied completely or not at all', async () => {
    await expect(
      connection.executeScript(`
        CREATE TABLE "${schema}"."half" ("id" INT);
        INSERT INTO "${schema}"."half" VALUES (1);
        INSERT INTO "${schema}"."no_such_table" VALUES (1);
      `),
    ).rejects.toThrow();
    // The table created by the first statement is gone again: nothing was left half-way.
    const left = await client.query('SELECT to_regclass($1) AS name', [`"${schema}"."half"`]);
    expect(left.rows[0].name).toBeNull();
  });

  it('every committed migration is one that can run in a single transaction', () => {
    const files = fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(migrationsDir, d.name, 'migration.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sql = fs.readFileSync(file, 'utf8');
      // These cannot run inside a transaction; one of them would need a migration of its own.
      expect(sql, file).not.toMatch(/\bCONCURRENTLY\b|\bVACUUM\b|\bCREATE\s+DATABASE\b/i);
    }
  });

  it('a failed one is found, explained and can be let through again', async () => {
    // Prisma's own bookkeeping table, in a schema of its own so that the real one is not touched.
    await client.query(`SET search_path TO "${schema}"`);
    try {
      expect(await failedMigrations(client)).toEqual([]); // no table yet: a database that was never migrated
      await client.query(`CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
      await client.query(`INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name") VALUES ('1', 'a', now(), '20260101000000_init')`);
      await client.query(`INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "logs") VALUES ('2', 'b', '20260202000000_broken', E'external connector error\\nERROR: syntax error at or near "the"\\n   0: sql_schema_connector')`);

      const failed = await failedMigrations(client);
      expect(failed.map((m) => m.name)).toEqual(['20260202000000_broken']);
      expect(summariseLogs(failed[0].logs, 2)).toBe('external connector error — ERROR: syntax error at or near "the"');

      expect(await markForRetry(client, 'not_the_failed_one')).toBe(0);
      expect(await failedMigrations(client)).toHaveLength(1);
      expect(await markForRetry(client, '20260202000000_broken')).toBe(1);
      expect(await failedMigrations(client)).toEqual([]);
      // The finished migration was not touched.
      const kept = await client.query(`SELECT "rolled_back_at" FROM "_prisma_migrations" WHERE "id" = '1'`);
      expect(kept.rows[0].rolled_back_at).toBeNull();
    } finally {
      await client.query('RESET search_path');
    }
  });

  it('the repair of dates stored as 1970 clears exactly those', async () => {
    const teacher = await createUser('TEACHER');
    const cls = await createClass(teacher);
    const epoch = new Date(0);
    const real = new Date('2026-12-01T09:00:00Z');
    const stuck = await prisma.learningModule.create({ data: { classId: cls.id, title: 'Closed in 1970', position: 1, status: 'PUBLISHED', availableUntil: epoch, createdById: teacher.id } });
    const dated = await prisma.learningModule.create({ data: { classId: cls.id, title: 'Closes in December', position: 2, status: 'PUBLISHED', availableUntil: real, createdById: teacher.id } });
    const assignment = await prisma.assignment.create({ data: { classId: cls.id, title: 'Essay', points: 10, status: 'PUBLISHED', availableFrom: epoch, dueAt: real, closeAt: epoch, createdById: teacher.id } });

    const sql = fs.readFileSync(path.join(migrationsDir, '20261112120000_clear_dates_stored_as_1970', 'migration.sql'), 'utf8');
    await connection.executeScript(sql);

    expect((await prisma.learningModule.findUnique({ where: { id: stuck.id } })).availableUntil).toBeNull();
    expect((await prisma.learningModule.findUnique({ where: { id: dated.id } })).availableUntil).toEqual(real);
    expect(await prisma.assignment.findUnique({ where: { id: assignment.id } })).toMatchObject({ availableFrom: null, dueAt: real, closeAt: null });
  });
});
