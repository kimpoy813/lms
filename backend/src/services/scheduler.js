// Background jobs.
//
// Every job is written to be idempotent and safe to run concurrently from several instances:
// each one claims its work with conditional UPDATEs (e.g. "… WHERE status = 'SCHEDULED'") and only
// acts on the rows it actually changed. So no leader election is needed for correctness; running
// more than one instance only costs a few redundant queries.
//
// Two ways to drive them:
//   • a server process runs each job on a timer (startScheduler);
//   • function invocations have no timer, so requests drive the jobs instead (runDueJobs): the
//     first request after a job's interval has passed claims it in the JobState table and runs
//     it. With nobody using the site nothing runs — which is fine, because what the jobs change
//     is only visible to somebody using the site — and a daily scheduled call catches up.
import { prisma } from '../db/prisma.js';
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

/**
 * Run the jobs whose interval has passed since any instance last ran them.
 * The claim is one atomic statement, so two instances never both get the same turn.
 * @param {{ force?: boolean }} [options] force = run every job now (the daily scheduled call)
 * @returns {Promise<string[]>} the names of the jobs this call ran
 */
export async function runDueJobs({ force = false } = {}) {
  const all = [...jobs.values()];
  if (all.length === 0) return [];
  const claimed = await prisma.$queryRaw`
    INSERT INTO "JobState" AS s ("name", "everyMs", "lastRunAt")
    SELECT v."name", v."everyMs", now()
    FROM unnest(${all.map((j) => j.name)}::text[], ${all.map((j) => j.intervalMs)}::int[]) AS v("name", "everyMs")
    ON CONFLICT ("name") DO UPDATE SET "lastRunAt" = now(), "everyMs" = EXCLUDED."everyMs"
    WHERE ${force}::boolean OR s."lastRunAt" <= now() - (EXCLUDED."everyMs" * interval '1 millisecond')
    RETURNING s."name"`;
  const names = claimed.map((row) => row.name);
  for (const name of names) await runJob(name);
  return names;
}

// How often one instance asks the database whether a job is due. Jobs run at most as often as
// their own interval; this only bounds the cost of asking.
const DUE_CHECK_INTERVAL_MS = 20_000;
let lastDueCheckAt = 0;

/**
 * Called for every API request when the API runs as function invocations. Returns a promise when
 * this call started a check (the caller keeps the instance alive until it settles), else null.
 */
export function checkDueJobs(now = Date.now()) {
  if (now - lastDueCheckAt < DUE_CHECK_INTERVAL_MS) return null;
  lastDueCheckAt = now;
  return runDueJobs().catch((err) => {
    logger.error({ err }, 'could not check for due background jobs');
    return [];
  });
}

/** For tests: forget when this instance last asked. */
export function resetDueCheck() {
  lastDueCheckAt = 0;
}
