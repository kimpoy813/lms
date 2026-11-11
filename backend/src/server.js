// Process entry point: HTTP server, Socket.IO, background jobs and graceful shutdown.
import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { disconnect, prisma } from './db/prisma.js';
import { logger } from './lib/logger.js';
import { attachRealtime, closeRealtime } from './services/realtime.js';
import { syncPermissionCatalog } from './services/permissions.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { ensureStorage } from './services/storage.js';

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    logger.fatal({ err }, 'cannot connect to PostgreSQL — check DATABASE_URL and that the server is running');
    process.exit(1);
  }
  try {
    await syncPermissionCatalog();
  } catch (err) {
    logger.fatal({ err }, 'database schema is missing or out of date — run "npm run db:deploy"');
    process.exit(1);
  }
  await ensureStorage();

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  if (env.schedulerEnabled) startScheduler();

  server.listen(env.port, env.host, () => {
    logger.info(`EduSphere API listening on http://${env.host}:${env.port} (${env.nodeEnv})`);
    if (env.demoAccountsEnabled) logger.info('Demo accounts are ENABLED (non-production mode).');
    if (!env.ai.configured) logger.info('AI authoring is not configured (set AI_PROVIDER and AI_API_KEY to enable it).');
    if (!env.codeRunner.configured) logger.info('Code execution is not configured (set CODE_RUNNER_PROVIDER and CODE_RUNNER_URL to enable it).');
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    stopScheduler();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await closeRealtime().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    await disconnect().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled promise rejection');
});

main();
