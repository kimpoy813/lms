// Single PrismaClient for the process. The query engine runs as WebAssembly and talks to
// PostgreSQL through node-postgres, so no native Prisma binary is required at runtime.
import pg from 'pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { pgOptionsFromUrl } from './connection.js';

/**
 * The connection pool behind Prisma. It is created here (rather than by the adapter) so that a
 * function platform can register it for clean-up before an instance is frozen (see api/index.js).
 *
 * Hosted databases that pause when idle (Neon) drop idle connections; the adapter listens for
 * those errors, and a dropped connection is simply replaced on the next query.
 */
export const pool = new pg.Pool({
  ...pgOptionsFromUrl(env.databaseUrl),
  max: env.databasePoolMax,
  idleTimeoutMillis: env.databasePoolIdleMs,
  // Long enough for a paused database to wake up, short enough to fail a request with an answer.
  connectionTimeoutMillis: 15_000,
});

const adapter = new PrismaPg(pool, { disposeExternalPool: true });

export const prisma = new PrismaClient({
  adapter,
  // Query errors are not logged here: expected ones (e.g. a unique-constraint race that the code
  // handles) would only be noise, and unexpected ones are logged once by the error middleware.
  log: env.isDevelopment ? ['warn'] : [],
  transactionOptions: { maxWait: 5_000, timeout: 15_000 },
});

export { Prisma };

/**
 * Take a transaction-scoped PostgreSQL advisory lock derived from a string key.
 * Concurrent transactions asking for the same key run one after another; the lock is released
 * automatically at commit / rollback. Used to serialise "check then insert" sequences such as
 * starting a quiz attempt or recording a check-in.
 */
export async function lockKey(tx, key) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export async function disconnect() {
  await prisma.$disconnect();
}
