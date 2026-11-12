// The whole EduSphere API as one Vercel Function.
//
// vercel.json sends /api/*, /healthz and /readyz here; Vercel's CDN serves everything else (the
// built web app). Nothing in this file is used when the API runs as an ordinary server
// (backend/src/server.js). See docs/DEPLOYMENT.md, "Vercel and Neon".
//
// The application is not imported at the top of this file. A launcher may load the file with
// require(), and require() refuses a module whose imports contain a top-level await anywhere;
// and whatever else stops the application from loading would stop this file with it, leaving the
// platform's error page and no answer. So only a helper without dependencies is imported here,
// and the application is brought in by `load` below, where a failure can be caught and reported.
import { closeIdleConnectionsBeforeFreeze, createFunctionHandler, keepAliveUntil, restoreRequestUrl } from '../backend/src/lib/vercel.js';

// For the start-up report: Node's synchronous loader on the stack means this file came in through require().
const loadedWith = /ModuleJobSync|importSyncForRequire|loadESMFromCJS/.test(new Error().stack ?? '') ? 'require()' : 'import()';

async function load() {
  const [{ createApp }, { pool }, { setBackgroundRunner }, { logger }] = await Promise.all([
    import('../backend/src/app.js'),
    import('../backend/src/db/prisma.js'),
    import('../backend/src/lib/background.js'),
    import('../backend/src/lib/logger.js'),
  ]);

  // An instance is frozen between requests. Idle database connections are closed first: a frozen
  // instance cannot notice that the database dropped one, and would fail its next request with it.
  closeIdleConnectionsBeforeFreeze(pool);

  // Work that finishes after the response (background jobs, e-mail copies) keeps the instance awake.
  let warned = false;
  setBackgroundRunner((promise) => {
    if (keepAliveUntil(promise) || warned) return;
    warned = true;
    logger.warn('the platform offers no way to finish work after a response; background jobs and e-mail copies may be cut short');
  });

  return createApp({
    prelude: [
      (req, res, next) => {
        restoreRequestUrl(req);
        req.originalUrl = req.url;
        next();
      },
    ],
  });
}

export default createFunctionHandler({ load, reportSecret: process.env.CRON_SECRET, loadedWith });
