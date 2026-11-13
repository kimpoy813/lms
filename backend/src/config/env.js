// Loads and validates configuration from the environment exactly once.
// Nothing else in the code base reads process.env directly.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { aiTarget } from '../services/aiProvider.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Vercel runs the API as a function: no process that stays up, no disk that keeps files, no
// WebSockets. It announces itself with VERCEL=1, and the defaults below follow from it. Every one
// of them can still be set explicitly. See docs/DEPLOYMENT.md, "Vercel and Neon".
const onVercel = process.env.VERCEL === '1';
const onVercelPreview = onVercel && Boolean(process.env.VERCEL_ENV) && process.env.VERCEL_ENV !== 'production';
if (onVercel) {
  // A function must never come up in development mode (demo accounts, the development mailbox).
  process.env.NODE_ENV ||= 'production';
  // Database integrations do not agree on the variable name.
  process.env.DATABASE_URL ||= process.env.POSTGRES_URL ?? '';
}

// Real environment variables always take precedence over .env files. On Vercel no file is read:
// the configuration is the project's settings alone. A .env that a build on somebody's own
// computer swept into the function, with its development settings, must not take part.
if (process.env.NODE_ENV !== 'test' && !onVercel) {
  for (const file of [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // .env files are optional
    }
  }
}

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

  /** Public URL of the web app. Used in e-mail links and as a trusted origin. */
  APP_URL: z
    .string()
    .url()
    .default(onVercel && process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:5173'),
  /** Extra origins allowed to call the API with credentials (comma separated). */
  CORS_ORIGINS: optionalString,
  /** Express "trust proxy" setting: false, true, or a hop count. Vercel always sits in front. */
  TRUST_PROXY: z.string().default(onVercel ? 'true' : 'false'),

  /**
   * true = the API runs as short-lived function invocations instead of one process that stays up.
   * Background jobs then run when a request comes in, and real-time push is off.
   */
  SERVERLESS: bool(onVercel),
  /** Live updates over WebSockets. Needs a process that stays up, so it is off when SERVERLESS. */
  REALTIME_ENABLED: bool(true),
  /** Most database connections one process (or one function instance) keeps open. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).optional(),
  /** How long an unused database connection is kept, in milliseconds. Default 30000; 1000 when SERVERLESS. */
  DATABASE_POOL_IDLE_MS: z.coerce.number().int().min(100).max(600_000).optional(),
  /** When set, GET /api/internal/cron requires "Authorization: Bearer <this value>". */
  CRON_SECRET: optionalString,

  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_PARTITIONED: bool(false),
  /** Content-Security-Policy frame-ancestors value. Keep 'self' in production. */
  FRAME_ANCESTORS: z.string().default("'self'"),
  /** scrypt work factor exponent (N = 2^cost). 15 ≈ 32 MB per hash. */
  PASSWORD_HASH_COST: z.coerce.number().int().min(10).max(20).default(15),

  SERVE_FRONTEND: bool(false),
  FRONTEND_DIST: z.string().default(path.join(backendRoot, '..', 'frontend', 'dist')),
  /**
   * Where uploaded files are kept: `disk` (STORAGE_DIR) or `database` (a table in PostgreSQL, for
   * hosts whose disk does not survive a restart). Default: database when SERVERLESS, else disk.
   */
  STORAGE_DRIVER: z.enum(['disk', 'database']).optional(),
  /** With the disk driver: the files. With the database driver: only short-lived temporary files. */
  STORAGE_DIR: optionalString,
  /** Largest single upload. Default 25; 4 when SERVERLESS (Vercel refuses request bodies over 4.5 MB). */
  MAX_UPLOAD_MB: z.coerce.number().positive().max(500).optional(),
  /** Total space for uploads in megabytes, 0 = no limit. Default: 300 with the database driver, else 0. */
  STORAGE_QUOTA_MB: z.coerce.number().min(0).optional(),
  /**
   * Photos (JPEG, PNG, WebP) larger than this many megabytes are made smaller by the browser before
   * they are sent. Default: 1 with the database driver, where space is short; otherwise the upload
   * limit, so that only a photo that would be refused is touched. 0 = never.
   */
  REDUCE_PHOTOS_OVER_MB: z.coerce.number().min(0).max(500).optional(),
  /**
   * Background jobs (auto-submit quizzes, close attendance, scheduled publishing, reminders).
   * Off by default on Vercel preview deployments: they usually share the production database, and
   * code from a branch should not act on live data by itself.
   */
  SCHEDULER_ENABLED: bool(!onVercelPreview),

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.string().default('EduSphere <no-reply@edusphere.local>'),

  /** Map tiles shown in the attendance geofence picker (Leaflet URL template). */
  MAP_TILE_URL: z.string().default('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_TILE_ATTRIBUTION: z.string().default('&copy; OpenStreetMap contributors'),

  // openai-compatible: any service with an OpenAI-style API and a key (AI_BASE_URL, AI_API_KEY, AI_MODEL).
  // vercel-ai-gateway: Vercel's AI Gateway; on Vercel no key is needed, the project's identity is used.
  AI_PROVIDER: z.enum(['none', 'openai-compatible', 'vercel-ai-gateway']).default('none'),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: optionalString,
  AI_MODEL: optionalString,
  // For the whole exchange with the service. On Vercel a request is cut off after 120 s
  // (vercel.json), so the default there leaves time to tell the teacher what happened.
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(onVercel ? 100000 : 120000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  AI_INPUT_COST_PER_1K: z.coerce.number().min(0).default(0),
  AI_OUTPUT_COST_PER_1K: z.coerce.number().min(0).default(0),

  CODE_RUNNER_PROVIDER: z.enum(['none', 'piston', 'vercel-sandbox']).default('none'),
  CODE_RUNNER_URL: optionalString,
  CODE_RUNNER_API_KEY: optionalString,
  CODE_RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // vercel-sandbox: where the machines run. On Vercel the region of the function is used.
  CODE_RUNNER_REGION: z.string().regex(/^[a-z]{3}\d$/, 'a Vercel region code such as sin1').optional(),
  // vercel-sandbox from a server that is not on Vercel: an access token and what it belongs to.
  VERCEL_TOKEN: optionalString,
  VERCEL_TEAM_ID: optionalString,
  VERCEL_PROJECT_ID: optionalString,
});

/**
 * The configuration cannot be used. A server says why and stops. A function that exits answers
 * nothing and leaves its visitor with the platform's error page, so there the reason is thrown
 * instead, and the function's entry point (api/index.js) reports it.
 */
function refuse(message) {
  if (onVercel) throw new Error(message);
  console.error(message);
  process.exit(1);
}

// A variable that is present but empty ("PORT=" in an .env file) means "not set".
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')));
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
  refuse(`Invalid environment configuration:\n${lines.join('\n')}\nSee backend/.env.example for the full list of variables.`);
}

const raw = parsed.data;
if (onVercel && !process.env.APP_URL && !process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  console.warn('APP_URL is not set and Vercel did not provide the address of the site: links in e-mails and QR codes will be wrong.');
}
const isProduction = raw.NODE_ENV === 'production';
const isTest = raw.NODE_ENV === 'test';
const serverless = raw.SERVERLESS;
const storageDriver = raw.STORAGE_DRIVER ?? (serverless ? 'database' : 'disk');

// Vercel answers 413 itself when a request body exceeds 4.5 MB, before the API sees it. A larger
// setting could only produce uploads that fail without a useful message.
const VERCEL_MAX_UPLOAD_MB = 4;
let maxUploadMb = raw.MAX_UPLOAD_MB ?? (serverless ? VERCEL_MAX_UPLOAD_MB : 25);
if (onVercel && maxUploadMb > VERCEL_MAX_UPLOAD_MB) {
  console.warn(`MAX_UPLOAD_MB=${maxUploadMb} is more than Vercel accepts in one request; using ${VERCEL_MAX_UPLOAD_MB}.`);
  maxUploadMb = VERCEL_MAX_UPLOAD_MB;
}

// A photo from a phone is several megabytes; a page of handwriting stays readable at a tenth of that.
const reducePhotosOverMb = Math.min(raw.REDUCE_PHOTOS_OVER_MB ?? (storageDriver === 'database' ? 1 : maxUploadMb), maxUploadMb);

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : value;
}

if (isProduction && raw.COOKIE_SAMESITE === 'none' && raw.COOKIE_SECURE === 'false') {
  refuse('COOKIE_SAMESITE=none requires COOKIE_SECURE=true.');
}

// Vercel's AI Gateway is asked with the project's own identity when no key is set.
const aiGateway = raw.AI_PROVIDER === 'vercel-ai-gateway';

// Programs checked in Vercel Sandbox machines. On Vercel the project's own identity starts them and
// they run where the function runs; elsewhere an access token and a region have to be given.
const vercelAccess = raw.VERCEL_TOKEN && raw.VERCEL_TEAM_ID && raw.VERCEL_PROJECT_ID ? Object.freeze({ token: raw.VERCEL_TOKEN, teamId: raw.VERCEL_TEAM_ID, projectId: raw.VERCEL_PROJECT_ID }) : null;
const vercelRegion = /^[a-z]{3}\d$/.test(process.env.VERCEL_REGION ?? '') ? process.env.VERCEL_REGION : undefined;
const sandboxRegion = raw.CODE_RUNNER_REGION ?? (onVercel ? vercelRegion : undefined) ?? 'iad1';
if (raw.CODE_RUNNER_PROVIDER === 'vercel-sandbox' && !onVercel && !vercelAccess) {
  console.warn('CODE_RUNNER_PROVIDER=vercel-sandbox needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID when the server does not run on Vercel. Programs will not be run.');
}

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: raw.NODE_ENV === 'development',
  /** 'vercel' or 'node' — for log lines and the administrator's system page only. */
  platform: onVercel ? 'vercel' : 'node',
  serverless,
  /** WebSocket push. Without it the web app refreshes its live screens on a timer. */
  realtime: raw.REALTIME_ENABLED && !serverless,
  host: raw.HOST,
  port: raw.PORT,
  databaseUrl: raw.DATABASE_URL,
  databasePoolMax: raw.DATABASE_POOL_MAX ?? (isTest || serverless ? 5 : 15),
  // A server keeps connections warm. A function instance stays awake (and is counted as running)
  // until its idle connections are closed, so there they are kept just long enough to serve the
  // burst of requests one page makes.
  databasePoolIdleMs: raw.DATABASE_POOL_IDLE_MS ?? (serverless ? 1_000 : 30_000),
  cronSecret: raw.CRON_SECRET,
  logLevel: raw.LOG_LEVEL ?? (isTest ? 'silent' : isProduction ? 'info' : 'debug'),

  appUrl: raw.APP_URL.replace(/\/+$/, ''),
  corsOrigins: (raw.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  trustProxy: parseTrustProxy(raw.TRUST_PROXY),

  sessionTtlMs: raw.SESSION_TTL_HOURS * 60 * 60 * 1000,
  cookieSecure: raw.COOKIE_SECURE,
  cookieSameSite: raw.COOKIE_SAMESITE,
  cookiePartitioned: raw.COOKIE_PARTITIONED,
  frameAncestors: raw.FRAME_ANCESTORS,
  passwordHashCost: raw.PASSWORD_HASH_COST,

  serveFrontend: raw.SERVE_FRONTEND,
  frontendDist: path.resolve(backendRoot, raw.FRONTEND_DIST),
  storageDriver,
  // Relative paths are relative to the backend folder, whatever the working directory is.
  // A function may write only below the system's temporary folder.
  storageDir: path.resolve(backendRoot, raw.STORAGE_DIR ?? (serverless ? path.join(os.tmpdir(), 'edusphere') : 'storage')),
  maxUploadBytes: Math.round(maxUploadMb * 1024 * 1024),
  /** The web app shrinks photos above this size before sending them. 0 = it never does. */
  reducePhotosOverBytes: Math.round(reducePhotosOverMb * 1024 * 1024),
  /** 0 = unlimited. */
  storageQuotaBytes: Math.round((raw.STORAGE_QUOTA_MB ?? (storageDriver === 'database' ? 300 : 0)) * 1024 * 1024),
  /** Run background jobs by themselves (on a timer, or driven by requests). Never in the test-suite. */
  schedulerEnabled: raw.SCHEDULER_ENABLED && !isTest,
  /** SCHEDULER_ENABLED as configured: whether an explicit scheduled call may run the jobs here. */
  jobsAllowed: raw.SCHEDULER_ENABLED,

  /** Demo accounts exist only outside production. This cannot be overridden. */
  demoAccountsEnabled: !isProduction,

  smtp: raw.SMTP_HOST
    ? {
        host: raw.SMTP_HOST,
        port: raw.SMTP_PORT,
        secure: raw.SMTP_SECURE,
        auth: raw.SMTP_USER ? { user: raw.SMTP_USER, pass: raw.SMTP_PASS ?? '' } : undefined,
      }
    : null,
  mailFrom: raw.MAIL_FROM,

  map: { tileUrl: raw.MAP_TILE_URL, attribution: raw.MAP_TILE_ATTRIBUTION },

  ai: {
    provider: raw.AI_PROVIDER,
    /** `baseUrl` and `model`: what was set, or the defaults of the provider (services/aiProvider.js). */
    ...aiTarget({ provider: raw.AI_PROVIDER, baseUrl: raw.AI_BASE_URL, model: raw.AI_MODEL }),
    apiKey: raw.AI_API_KEY,
    /** Asked with the identity of the Vercel project instead of a key (see services/ai.js). */
    usesProjectIdentity: aiGateway && !raw.AI_API_KEY,
    timeoutMs: raw.AI_TIMEOUT_MS,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
    inputCostPer1k: raw.AI_INPUT_COST_PER_1K,
    outputCostPer1k: raw.AI_OUTPUT_COST_PER_1K,
    /** True when a provider is chosen and there is something to ask it with: a key, or on Vercel the project's identity. */
    configured: raw.AI_PROVIDER !== 'none' && (Boolean(raw.AI_API_KEY) || (aiGateway && onVercel)),
  },

  codeRunner: {
    provider: raw.CODE_RUNNER_PROVIDER,
    url: raw.CODE_RUNNER_URL?.replace(/\/+$/, ''),
    apiKey: raw.CODE_RUNNER_API_KEY,
    timeoutMs: raw.CODE_RUNNER_TIMEOUT_MS,
    region: sandboxRegion,
    /** Only outside Vercel; on Vercel the project's own identity is used and nothing is stored. */
    vercelAccess,
    configured: raw.CODE_RUNNER_PROVIDER === 'piston' ? Boolean(raw.CODE_RUNNER_URL) : raw.CODE_RUNNER_PROVIDER === 'vercel-sandbox' ? onVercel || Boolean(vercelAccess) : false,
  },
});
