// Session authentication (opaque token in an HTTP-only cookie, stored hashed in PostgreSQL),
// CSRF protection, and role / permission guards.
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { forbidden, unauthorized, AppError } from '../lib/errors.js';
import { randomToken, safeEqual, sha256 } from '../lib/tokens.js';
import { hasPermission } from '../services/permissions.js';

const COOKIE_PLAIN = 'es_sid';
// The __Host- prefix makes browsers refuse the cookie unless it is Secure, has Path=/ and no Domain.
const COOKIE_SECURE = '__Host-es_sid';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

function useSecureCookie(req) {
  if (env.cookieSecure === 'true') return true;
  if (env.cookieSecure === 'false') return false;
  return Boolean(req.secure);
}

function cookieOptions(req) {
  const secure = useSecureCookie(req);
  return {
    httpOnly: true,
    secure,
    sameSite: env.cookieSameSite,
    path: '/',
    ...(env.cookiePartitioned && secure ? { partitioned: true } : {}),
  };
}

export function readSessionToken(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return cookies[COOKIE_SECURE] ?? cookies[COOKIE_PLAIN] ?? null;
}

/** Create a session row and set the cookie. Returns the CSRF token for the client. */
export async function startSession(req, res, user) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: sha256(token),
      csrfToken,
      userAgent: String(req.get('user-agent') ?? '').slice(0, 300) || null,
      ipAddress: req.ip ?? null,
      expiresAt: new Date(Date.now() + env.sessionTtlMs),
    },
  });
  const secure = useSecureCookie(req);
  res.cookie(secure ? COOKIE_SECURE : COOKIE_PLAIN, token, { ...cookieOptions(req), maxAge: env.sessionTtlMs });
  return { session, csrfToken };
}

export function clearSessionCookie(req, res) {
  const options = cookieOptions(req);
  res.clearCookie(COOKIE_SECURE, { ...options, secure: true });
  res.clearCookie(COOKIE_PLAIN, { ...options, secure: false, partitioned: undefined });
}

export async function revokeSession(sessionId) {
  await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId, exceptSessionId) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

/** Resolve a session token to its user, or null. Shared by HTTP requests and Socket.IO. */
export async function resolveSession(token) {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { studentProfile: true, teacherProfile: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  const { user } = session;
  if (user.status !== 'ACTIVE') return null;
  if (user.isDemo && !env.demoAccountsEnabled) return null;
  return session;
}

/** Populates req.user / req.session when a valid session cookie is present. Never rejects. */
export async function loadSession(req, res, next) {
  req.user = null;
  req.session = null;
  const token = readSessionToken(req.headers.cookie);
  if (!token) return next();
  const session = await resolveSession(token);
  if (!session) {
    clearSessionCookie(req, res);
    return next();
  }
  req.user = session.user;
  req.session = session;
  // An administrator-issued temporary password only opens the door to replacing it: until the
  // owner has chosen their own password, nothing but the /auth endpoints is reachable.
  if (session.user.mustChangePassword && !req.path.startsWith('/auth/')) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue.');
  }
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    // Sliding expiry: an active session keeps extending itself.
    prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + env.sessionTtlMs) } })
      .catch(() => {});
  }
  return next();
}

function trustedOrigins(req) {
  const origins = new Set([env.appUrl, ...env.corsOrigins]);
  const host = req.get('host');
  if (host) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }
  if (env.trustProxy) {
    const forwarded = req.get('x-forwarded-host');
    if (forwarded) {
      for (const h of forwarded.split(',')) {
        origins.add(`http://${h.trim()}`);
        origins.add(`https://${h.trim()}`);
      }
    }
  }
  return origins;
}

export function isTrustedOrigin(req, origin) {
  return trustedOrigins(req).has(String(origin).replace(/\/+$/, ''));
}

/**
 * CSRF defence for cookie-authenticated requests:
 *   1. state-changing requests carrying an Origin header must come from a trusted origin, and
 *   2. authenticated state-changing requests must echo the session's CSRF token in X-CSRF-Token
 *      (a value a cross-site page cannot read).
 */
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== 'null' && !isTrustedOrigin(req, origin)) {
    throw forbidden('This request came from an untrusted site and was blocked.', 'BAD_ORIGIN');
  }
  if (req.session) {
    const header = req.get('x-csrf-token');
    if (!header || !safeEqual(header, req.session.csrfToken)) {
      throw forbidden('Your security token is missing or out of date. Reload the page and try again.', 'BAD_CSRF_TOKEN');
    }
  }
  return next();
}

export function requireAuth(req, res, next) {
  if (!req.user) throw unauthorized();
  return next();
}

/** requireRole('TEACHER', 'ADMIN') */
export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    return next();
  };
}

/** requirePermission('grades.export') — administrators always pass. */
export function requirePermission(key) {
  return async function permissionGuard(req, res, next) {
    if (!req.user) throw unauthorized();
    if (!(await hasPermission(req.user.role, key))) {
      throw forbidden('This action has been disabled for your role by the administrator.', 'PERMISSION_DENIED');
    }
    return next();
  };
}

export async function assertPermission(user, key) {
  if (!(await hasPermission(user.role, key))) {
    throw forbidden('This action has been disabled for your role by the administrator.', 'PERMISSION_DENIED');
  }
}
