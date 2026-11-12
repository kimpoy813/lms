// Failed migrations, and how to let one run again.
//
// Prisma records every migration in the table _prisma_migrations. One that stopped with an error
// stays there as "failed", and from then on `prisma migrate deploy` applies nothing at all
// (error P3009) until a person has said what to do with it. The command meant for that,
// `prisma migrate resolve`, needs Prisma's native engine — which the build on Vercel does not have.
//
// This project applies each migration as a single transaction (backend/prisma/js-engine-adapter.js),
// so a failed one left nothing behind and can simply run again once its cause is gone.
// markForRetry() records that decision exactly as `prisma migrate resolve --rolled-back <name>`
// would. scripts/vercel-build.mjs uses both functions; MIGRATE_RETRY_FAILED names the migration.

/**
 * Migrations the database records as started but neither finished nor rolled back.
 * @param {{ query: Function }} client a connected node-postgres client
 * @returns {Promise<{ name: string, startedAt: Date, logs: string | null }[]>}
 */
export async function failedMigrations(client) {
  // A database that was never migrated has no such table yet.
  const table = await client.query("SELECT to_regclass('_prisma_migrations') AS name");
  if (!table.rows[0].name) return [];
  const { rows } = await client.query(
    'SELECT migration_name AS name, started_at AS "startedAt", logs FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at',
  );
  return rows;
}

/**
 * Lets `prisma migrate deploy` apply the named failed migration again.
 * @returns {Promise<number>} how many records were changed (0 when there was no such failure)
 */
export async function markForRetry(client, name) {
  const result = await client.query(
    'UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL',
    [name],
  );
  return result.rowCount;
}

/** The first lines of what the database said, for the build log. */
export function summariseLogs(logs, lines = 3) {
  return String(logs ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(' — ');
}
