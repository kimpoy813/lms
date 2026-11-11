// Single PrismaClient for the process. The query engine runs as WebAssembly and talks to
// PostgreSQL through node-postgres, so no native Prisma binary is required at runtime.
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';

const adapter = new PrismaPg({
  connectionString: env.databaseUrl,
  max: env.isTest ? 5 : 15,
  idleTimeoutMillis: 30_000,
});

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
