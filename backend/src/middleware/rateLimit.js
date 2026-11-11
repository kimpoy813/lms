// API rate limiting (in-memory store — adequate for a single instance; use a shared store such
// as Redis when running several instances behind a load balancer).
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

// The automated test-suite fires thousands of requests from one address, so limits are bypassed
// in NODE_ENV=test unless a test explicitly opts in with this header.
const skip = (req) => env.isTest && req.get('x-test-rate-limit') !== '1';

const handler = (req, res) => {
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
  });
};

function limiter({ windowMs, limit, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    handler,
    ...(keyGenerator ? { keyGenerator } : {}),
  });
}

const byUserOrIp = (req) => (req.user ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`);

/** Everything under /api */
export const apiLimiter = limiter({ windowMs: 60_000, limit: 600, keyGenerator: byUserOrIp });

/** Sign-in, registration, password reset: slow down guessing and enumeration. */
export const authLimiter = limiter({
  windowMs: 15 * 60_000,
  limit: 30,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
});

/** Per-account sign-in attempts regardless of source address. */
export const loginLimiter = limiter({
  windowMs: 15 * 60_000,
  limit: 15,
  keyGenerator: (req) => `login:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
});

export const uploadLimiter = limiter({ windowMs: 60_000, limit: 60, keyGenerator: byUserOrIp });
export const checkInLimiter = limiter({ windowMs: 60_000, limit: 30, keyGenerator: byUserOrIp });
export const aiLimiter = limiter({ windowMs: 60_000, limit: 10, keyGenerator: byUserOrIp });
export const codeRunLimiter = limiter({ windowMs: 60_000, limit: 20, keyGenerator: byUserOrIp });
export const messageLimiter = limiter({ windowMs: 60_000, limit: 60, keyGenerator: byUserOrIp });
