// Helpers for running as a Vercel Function (see /api/index.js and /vercel.json).

/** Name of the query parameter in which vercel.json hands the original path to the function. */
export const FORWARDED_PATH_PARAM = '__path';

/**
 * vercel.json sends several paths to the one function at /api:
 *
 *     /api/classes/42   is rewritten to   /api?__path=api/classes/42
 *
 * Vercel's documentation does not promise which of the two the function then sees as the request
 * URL, so this works with both: when the request arrives as /api the original path is restored
 * from the parameter, and in either case the parameter is removed so the application never sees it.
 *
 * Nothing is gained by sending the parameter by hand: /api?__path=api/x is answered exactly as
 * /api/x would be, with the same checks.
 *
 * @param {{ url?: string }} req
 */
export function restoreRequestUrl(req) {
  const raw = req.url ?? '/';
  if (!raw.includes(`${FORWARDED_PATH_PARAM}=`)) return;
  const url = new URL(raw, 'http://internal');
  const forwarded = url.searchParams.get(FORWARDED_PATH_PARAM);
  if (forwarded === null) return;
  url.searchParams.delete(FORWARDED_PATH_PARAM);
  if (url.pathname === '/api' || url.pathname === '/api/') {
    // Build the path from segments so that nothing in the parameter can smuggle in a query string.
    url.pathname = `/${forwarded.replace(/^\/+/, '')}`;
  }
  req.url = `${url.pathname}${url.search}`;
}

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/**
 * Ask Vercel to keep this function instance running until `promise` settles, even though the
 * response has been sent. Without it the instance may be frozen in the middle of the work.
 *
 * The platform publishes the request in progress under a well-known symbol; this is the contract
 * behind `waitUntil` in Vercel's own @vercel/functions package. That package is not used: its
 * main entry loads about 150 modules at every cold start and installs a set of command-line
 * helpers, for two small functions.
 *
 * @param {Promise<unknown>} promise
 * @returns {boolean} false when there is no platform to ask (the caller may want to say so once)
 */
export function keepAliveUntil(promise) {
  const context = globalThis[REQUEST_CONTEXT]?.get?.();
  if (typeof context?.waitUntil !== 'function') return false;
  context.waitUntil(promise);
  return true;
}

/**
 * Keep the instance awake until the database pool has closed its unused connections.
 *
 * A frozen instance cannot run the pool's idle timer, and cannot notice when the database closes
 * a connection from its side (a hosted database that pauses does exactly that). It would wake up
 * holding a dead connection and fail its next request with it. So after each query the instance
 * stays up for the pool's idle time plus a moment, by which time the connection is closed
 * properly — or another request has come in and is using it.
 *
 * (The same thing `attachDatabasePool` from @vercel/functions does.)
 *
 * @param {import('pg').Pool} pool
 */
export function closeIdleConnectionsBeforeFreeze(pool) {
  const wait = (pool.options?.idleTimeoutMillis ?? 10_000) + 100;
  let timer = null;
  let settle = () => {};
  pool.on('release', () => {
    clearTimeout(timer);
    settle();
    const closed = new Promise((resolve) => {
      settle = resolve;
    });
    timer = setTimeout(settle, wait);
    keepAliveUntil(closed);
  });
}
