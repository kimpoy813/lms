// In-process background jobs.
//
// Every job is written to be idempotent and safe to run concurrently from several instances:
// each one claims its work with conditional UPDATEs (e.g. "… WHERE status = 'SCHEDULED'") and only
// acts on the rows it actually changed. So no leader election is needed for correctness; running
// more than one instance only costs a few redundant queries.
import { logger } from '../lib/logger.js';

const jobs = new Map();
const timers = [];

/**
 * @param {string} name
 * @param {number} intervalMs
 * @param {() => Promise<unknown>} fn
 */
export function registerJob(name, intervalMs, fn) {
  jobs.set(name, { name, intervalMs, fn, running: false });
}

/** Run one job now (also used by the test-suite to trigger jobs deterministically). */
export async function runJob(name) {
  const job = jobs.get(name);
  if (!job) throw new Error(`unknown job: ${name}`);
  if (job.running) return undefined; // previous run still in flight — skip this tick
  job.running = true;
  try {
    return await job.fn();
  } catch (err) {
    logger.error({ err, job: name }, 'background job failed');
    return undefined;
  } finally {
    job.running = false;
  }
}

export function startScheduler() {
  for (const job of jobs.values()) {
    const timer = setInterval(() => runJob(job.name), job.intervalMs);
    timer.unref();
    timers.push(timer);
  }
  // Catch up shortly after boot (e.g. items that were scheduled to publish while the server was down).
  const boot = setTimeout(() => {
    for (const job of jobs.values()) runJob(job.name);
  }, 3_000);
  boot.unref();
  timers.push(boot);
  logger.info(`scheduler started with ${jobs.size} job(s): ${[...jobs.keys()].join(', ')}`);
}

export function stopScheduler() {
  for (const timer of timers) {
    clearInterval(timer);
    clearTimeout(timer);
  }
  timers.length = 0;
}

export const jobNames = () => [...jobs.keys()];
