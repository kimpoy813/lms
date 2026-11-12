import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** SHA-256 hex digest. Tokens are stored hashed so a database leak does not expose live tokens. */
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A value that unlocks one thing for whoever operates the site, derived from a secret they
 * already have. The secret itself never has to travel in a URL, and a value that leaks opens
 * nothing but its own purpose.
 */
export function operatorToken(secret, purpose) {
  return createHmac('sha256', String(secret)).update(`edusphere ${purpose}`).digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const hmacSha256 = (secret, message) =>
  createHmac('sha256', secret).update(message).digest('base64url');

// No 0/O, 1/I/L — codes are read off a projector and typed on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Human-friendly random code, e.g. a class enrolment code. */
export function randomCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Numeric code for attendance check-in. */
export function randomDigits(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(10));
  return out;
}

export const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
