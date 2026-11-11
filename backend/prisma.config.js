// Prisma CLI configuration (schema location, migrations, seed, database connection).
//
// The connection string comes from DATABASE_URL. Two migration engines are supported:
//   • default            – Prisma's native schema engine (downloaded from binaries.prisma.sh).
//                          Use this for normal development, including `prisma migrate dev`.
//   • PRISMA_SCHEMA_ENGINE=js – the WebAssembly engine, for networks that block that download.
//                          Supports migrate deploy / status / reset / diff (not `migrate dev`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// The Prisma CLI does not load .env files once a config file exists, so do it here.
// Variables already present in the environment always win.
for (const file of [path.join(here, '.env'), path.join(here, '..', '.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // .env files are optional
  }
}

// `prisma generate` does not need a database, so a missing DATABASE_URL must not crash the config.
// The placeholder cannot connect anywhere, which makes a forgotten variable fail fast on migrate.
process.env.DATABASE_URL ??= 'postgresql://DATABASE_URL-is-not-set@localhost:1/none';
const databaseUrl = process.env.DATABASE_URL;

const base = {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'node prisma/seed.js',
  },
};

export default defineConfig(
  process.env.PRISMA_SCHEMA_ENGINE === 'js'
    ? {
        ...base,
        experimental: { adapter: true },
        engine: 'js',
        adapter: async () => {
          const { createMigrationAdapter } = await import('./prisma/js-engine-adapter.js');
          return createMigrationAdapter(databaseUrl);
        },
      }
    : {
        ...base,
        engine: 'classic',
        datasource: { url: databaseUrl },
      },
);
