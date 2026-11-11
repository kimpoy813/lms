// Loads and validates configuration from the environment exactly once.
// Nothing else in the code base reads process.env directly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Real environment variables always take precedence over .env files.
if (process.env.NODE_ENV !== 'test') {
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
  APP_URL: z.string().url().default('http://localhost:5173'),
  /** Extra origins allowed to call the API with credentials (comma separated). */
  CORS_ORIGINS: optionalString,
  /** Express "trust proxy" setting: false, true, or a hop count. */
  TRUST_PROXY: z.string().default('false'),

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
  STORAGE_DIR: z.string().default(path.join(backendRoot, 'storage')),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(500).default(25),
  SCHEDULER_ENABLED: bool(true),

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.string().default('EduSphere <no-reply@edusphere.local>'),

  /** Map tiles shown in the attendance geofence picker (Leaflet URL template). */
  MAP_TILE_URL: z.string().default('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_TILE_ATTRIBUTION: z.string().default('&copy; OpenStreetMap contributors'),

  AI_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: optionalString,
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  AI_INPUT_COST_PER_1K: z.coerce.number().min(0).default(0),
  AI_OUTPUT_COST_PER_1K: z.coerce.number().min(0).default(0),

  CODE_RUNNER_PROVIDER: z.enum(['none', 'piston']).default('none'),
  CODE_RUNNER_URL: optionalString,
  CODE_RUNNER_API_KEY: optionalString,
  CODE_RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  console.error('See backend/.env.example for the full list of variables.');
  process.exit(1);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';
const isTest = raw.NODE_ENV === 'test';

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : value;
}

if (isProduction && raw.COOKIE_SAMESITE === 'none' && raw.COOKIE_SECURE === 'false') {
  console.error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true.');
  process.exit(1);
}

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: raw.NODE_ENV === 'development',
  host: raw.HOST,
  port: raw.PORT,
  databaseUrl: raw.DATABASE_URL,
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
  // Relative paths are relative to the backend folder, whatever the working directory is.
  storageDir: path.resolve(backendRoot, raw.STORAGE_DIR),
  maxUploadBytes: Math.round(raw.MAX_UPLOAD_MB * 1024 * 1024),
  schedulerEnabled: raw.SCHEDULER_ENABLED && !isTest,

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
    baseUrl: raw.AI_BASE_URL.replace(/\/+$/, ''),
    apiKey: raw.AI_API_KEY,
    model: raw.AI_MODEL,
    timeoutMs: raw.AI_TIMEOUT_MS,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
    inputCostPer1k: raw.AI_INPUT_COST_PER_1K,
    outputCostPer1k: raw.AI_OUTPUT_COST_PER_1K,
    /** True only when a provider and a key are both configured. */
    configured: raw.AI_PROVIDER !== 'none' && Boolean(raw.AI_API_KEY),
  },

  codeRunner: {
    provider: raw.CODE_RUNNER_PROVIDER,
    url: raw.CODE_RUNNER_URL?.replace(/\/+$/, ''),
    apiKey: raw.CODE_RUNNER_API_KEY,
    timeoutMs: raw.CODE_RUNNER_TIMEOUT_MS,
    configured: raw.CODE_RUNNER_PROVIDER !== 'none' && Boolean(raw.CODE_RUNNER_URL),
  },
});
