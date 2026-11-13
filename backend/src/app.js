// Express application factory. Importing this module has no side effects besides configuration,
// which lets the integration tests exercise the app without opening a port.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { Prisma, prisma } from './db/prisma.js';
import { runInBackground } from './lib/background.js';
import { logger } from './lib/logger.js';
import { webAppFileHeaders } from './lib/pythonSandbox.js';
import { csrfProtection, loadSession } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { apiRouter } from './routes.js';
import { checkDueJobs } from './services/scheduler.js';

function corsMiddleware(req, res, next) {
  const origin = req.get('origin');
  if (origin && env.corsOrigins.includes(origin.replace(/\/+$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
  }
  return next();
}

function securityHeaders() {
  const frameAncestors = env.frameAncestors.split(/\s+/).filter(Boolean);
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Editors, charts and maps position elements with inline style attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Lessons may reference images hosted elsewhere; map tiles are remote too.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors,
      },
    },
    // X-Frame-Options cannot express an allow-list; frame-ancestors above is authoritative.
    frameguard: frameAncestors.length === 1 && frameAncestors[0] === "'self'" ? { action: 'sameorigin' } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: env.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
}

/**
 * @param {{ prelude?: import('express').RequestHandler[] }} [options] `prelude` runs before
 *        everything else; a hosting platform's entry point uses it to undo what the platform did
 *        to the request (see api/index.js).
 */
export function createApp({ prelude = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);
  app.set('query parser', 'simple');
  for (const middleware of prelude) app.use(middleware);

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=()');
    next();
  });

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.id,
        autoLogging: { ignore: (req) => !req.url.startsWith('/api') },
        customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  app.use(securityHeaders());
  app.use(compression());

  // Liveness / readiness probes (no authentication, no sensitive data).
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  // Ready = the database answers and has every table this version of the code uses.
  const tables = Prisma.dmmf.datamodel.models.map((model) => model.dbName ?? model.name);
  app.get('/readyz', async (req, res) => {
    const started = performance.now();
    try {
      const [{ missing }] = await prisma.$queryRaw`
        SELECT count(*)::int AS "missing" FROM unnest(${tables}::text[]) AS t("name")
        WHERE to_regclass(format('%I.%I', current_schema(), t."name")) IS NULL`;
      if (missing > 0) return res.status(503).json({ status: 'database not set up' });
      // The round trip tells whether the API and the database sit in the same region.
      return res.json({ status: 'ready', databaseMs: Math.round(performance.now() - started) });
    } catch (err) {
      // The answer stays terse (anybody can ask); the reason goes to the log.
      logger.warn({ err }, 'readiness check failed');
      return res.status(503).json({ status: 'database unavailable' });
    }
  });

  if (env.corsOrigins.length > 0) app.use('/api', corsMiddleware);

  // No timer survives between function invocations, so requests drive the background jobs.
  if (env.serverless && env.schedulerEnabled) {
    app.use('/api', (req, res, next) => {
      const pending = checkDueJobs();
      if (pending) runInBackground(() => pending, 'background jobs');
      next();
    });
  }

  app.use(
    '/api',
    (req, res, next) => {
      // API responses carry personal data: never store them in shared or browser caches.
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    express.json({ limit: '2mb' }),
    loadSession,
    apiLimiter,
    csrfProtection,
    apiRouter,
    notFoundHandler,
  );

  if (env.serveFrontend) {
    const indexFile = path.join(env.frontendDist, 'index.html');
    if (!fs.existsSync(indexFile)) {
      logger.warn({ dir: env.frontendDist }, 'SERVE_FRONTEND is on but the build was not found — run "npm run build"');
    } else {
      app.use(
        express.static(env.frontendDist, {
          index: false,
          setHeaders(res, filePath) {
            // Long caching for hashed files; the frame students' Python programs run in is shut
            // off from the site (lib/pythonSandbox.js).
            for (const [name, value] of Object.entries(webAppFileHeaders(path.relative(env.frontendDist, filePath), env.frameAncestors))) res.setHeader(name, value);
          },
        }),
      );
      // Single-page-app fallback for client-side routes.
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
        if (path.extname(req.path)) return next(); // a missing asset should 404, not return HTML
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(indexFile);
      });
    }
  }

  app.use((req, res) => notFoundHandler(req, res));
  app.use(errorHandler);
  return app;
}
