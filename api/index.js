// The whole EduSphere API as one Vercel Function.
//
// vercel.json sends /api/*, /healthz and /readyz here; Vercel's CDN serves everything else (the
// built web app). Nothing in this file is used when the API runs as an ordinary server
// (backend/src/server.js). See docs/DEPLOYMENT.md, "Vercel and Neon".
import { createApp } from '../backend/src/app.js';
import { pool } from '../backend/src/db/prisma.js';
import { setBackgroundRunner } from '../backend/src/lib/background.js';
import { logger } from '../backend/src/lib/logger.js';
import { closeIdleConnectionsBeforeFreeze, keepAliveUntil, restoreRequestUrl } from '../backend/src/lib/vercel.js';

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

const app = createApp({
  prelude: [
    (req, res, next) => {
      restoreRequestUrl(req);
      req.originalUrl = req.url;
      next();
    },
  ],
});

// The Express application itself is the export, not a function wrapped around it. Vercel only
// leaves the request alone (does not read the body or replace res.json, res.send and res.status
// with its own helpers) when the export looks like a server, which it tells by its listen().
export default app;
