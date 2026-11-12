// Helpers for running as a Vercel Function (see /api/index.js and /vercel.json).
//
// This file imports nothing from the project, on purpose: the function's entry point loads it
// before the application, and must be able to do so whatever state the application is in.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

/** Name of the query parameter in which vercel.json hands the original path to the function. */
export const FORWARDED_PATH_PARAM = '__path';

/** The function's own address, in every spelling the platform could pass on. None is a route of the API. */
const FUNCTION_PATHS = new Set(['/api', '/api/', '/api/index', '/api/index.js']);

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
  if (FUNCTION_PATHS.has(url.pathname)) {
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

/** Query parameter that asks the function for its start-up report. */
export const STARTUP_REPORT_PARAM = 'startup-report';

/**
 * The value that unlocks the start-up report. It is derived from a secret the operator already
 * has (CRON_SECRET), so that the secret itself never travels in a URL.
 * @param {string} secret
 */
export function startupReportToken(secret) {
  return createHmac('sha256', secret).update('edusphere start-up report').digest('base64url');
}

function asksForReport(req, token) {
  let given;
  try {
    given = new URL(req.url ?? '/', 'http://internal').searchParams.get(STARTUP_REPORT_PARAM);
  } catch {
    return false;
  }
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function answer(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * The request handler that is handed to the platform.
 *
 * `load` brings in the application and returns its request handler. It is started at once, but
 * nothing here depends on it succeeding. When the application cannot start (a setting it rejects,
 * a file missing from the bundle, a module the platform cannot load), the instance would
 * otherwise die and the platform would show its own error page, with the reason only in a log.
 * Here every request is then answered with 503 STARTUP_FAILED and the reason is written to the
 * function log.
 *
 * Visitors are not told the reason. Whoever knows `reportSecret` can ask for it, and for a few
 * facts about how the platform runs the function, with
 * `?startup-report=<startupReportToken(reportSecret)>` on any URL the function serves
 * (`npm run smoke` does, given CRON_SECRET).
 *
 * @param {object} options
 * @param {() => Promise<(req: http.IncomingMessage, res: http.ServerResponse) => unknown>} options.load
 * @param {string} [options.reportSecret]
 * @param {string} [options.loadedWith] how the platform loaded the entry point, for the report
 */
export function createFunctionHandler({ load, reportSecret, loadedWith }) {
  const token = reportSecret ? startupReportToken(reportSecret) : null;
  const starting = Promise.resolve()
    .then(load)
    .then(
      (app) => ({ app }),
      (error) => {
        console.error('EduSphere could not start:', error);
        return { error };
      },
    );

  async function handler(req, res) {
    const { app, error } = await starting;
    if (token && asksForReport(req, token)) {
      return answer(res, 200, {
        data: {
          started: !error,
          ...(error
            ? { reason: { name: error?.name, code: error?.code, message: String(error?.message ?? error).slice(0, 2000), stack: String(error?.stack ?? '').split('\n').slice(0, 8) } }
            : {}),
          loadedWith,
          node: process.version,
          region: process.env.VERCEL_REGION,
          // The URL as the platform passed it on, and whether it added request helpers of its own.
          url: req.url,
          platformHelpers: typeof res.json === 'function',
        },
      });
    }
    if (app) return app(req, res);
    return answer(res, 503, { error: { code: 'STARTUP_FAILED', message: 'The application could not start. The reason is in the function log.' } });
  }

  // Vercel adds helpers of its own to each request (they read the body before the application
  // can) unless what it is given can also listen like a server, as an Express application can.
  handler.listen = (...args) => http.createServer(handler).listen(...args);
  return handler;
}
