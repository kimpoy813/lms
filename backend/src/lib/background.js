// Work that may finish after the response has been sent: e-mail copies of notifications, the
// "last seen" stamp of a session, background jobs triggered by a request.
//
// A server process simply keeps running. A function platform may freeze the instance as soon as
// the response is out, so it has to be told that work is still pending. The platform's entry
// point registers its "keep alive until this settles" hook here (api/index.js does so for Vercel).
import { logger } from './logger.js';

let keepAlive = null;

/** @param {((promise: Promise<unknown>) => void) | null} hook */
export function setBackgroundRunner(hook) {
  keepAlive = hook;
}

/**
 * Start `task` without making the caller wait. Failures are logged, never thrown.
 * @param {() => unknown | Promise<unknown>} task
 * @param {string} [label] what the task does, for the log line when it fails
 * @returns {Promise<void>} settles when the task is over (tests await it)
 */
export function runInBackground(task, label = 'background task') {
  const promise = Promise.resolve()
    .then(task)
    .then(
      () => {},
      (err) => {
        logger.error({ err }, `${label} failed`);
      },
    );
  try {
    keepAlive?.(promise);
  } catch (err) {
    logger.warn({ err }, 'could not register background work with the platform');
  }
  return promise;
}
