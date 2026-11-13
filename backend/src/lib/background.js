// Work that may finish after the response has been sent: e-mail copies of notifications, the
// "last seen" stamp of a session, background jobs triggered by a request.
//
// A server process simply keeps running. A function platform may freeze the instance as soon as
// the response is out, so it has to be told that work is still pending. The platform's entry
// point registers its "keep alive until this settles" hook here (api/index.js does so for Vercel).
import { logger } from './logger.js';

let keepAlive = null;
let canKeepAlive = null;

/**
 * @param {((promise: Promise<unknown>) => void) | null} hook asks the platform to stay awake
 *        until the promise settles
 * @param {{ available?: (() => boolean) | null }} [options] `available` tells whether the platform
 *        can be asked at this moment; without it, a hook is taken to work whenever it is called
 */
export function setBackgroundRunner(hook, { available = null } = {}) {
  keepAlive = hook;
  canKeepAlive = hook ? available : null;
}

/**
 * Will work that is started now be finished, even when the response goes out first?
 * A server process simply keeps running. On a function platform it depends on whether the
 * platform can be asked to stay awake; where it cannot, work that must not be cut short is better
 * done before the response.
 */
export function canFinishAfterResponse() {
  if (!canKeepAlive) return true;
  try {
    return canKeepAlive() !== false;
  } catch {
    return false;
  }
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
