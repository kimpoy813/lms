// Password hashing with scrypt (memory-hard, built into Node — no native add-on to compile).
// Stored format:  scrypt$<log2 N>$<r>$<p>$<salt b64url>$<hash b64url>
// Parameters travel with the hash, so the work factor can be raised later and old hashes are
// transparently upgraded the next time the user signs in (see needsRehash).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const R = 8;
const P = 1;

function derive(password, salt, cost, r, p) {
  const N = 2 ** cost;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const cost = env.passwordHashCost;
  const key = await derive(password, salt, cost, R, P);
  return ['scrypt', cost, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, costRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const cost = Number(costRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(cost) || cost < 10 || cost > 20 || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashRaw, 'base64url');
  try {
    const actual = await derive(password, Buffer.from(saltRaw, 'base64url'), cost, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function needsRehash(stored) {
  const parts = String(stored).split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < env.passwordHashCost;
}

// A valid-looking hash that matches no password. Verifying against it for unknown e-mail
// addresses keeps response times uniform, so sign-in cannot be used to enumerate accounts.
let dummyHashPromise;
export function dummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('hex'));
  return dummyHashPromise;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
  '1234567890', '12345678910', '0123456789', '9876543210', 'qwertyuiop', 'qwerty12345', 'qwerty123456',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'iloveyou123', 'administrator', 'letmein12345', 'welcome12345',
  'changeme123', 'abcdefghij', 'abc1234567', 'aaaaaaaaaa', '1111111111', '0000000000', 'edusphere123',
]);

/**
 * Validate a new password. Returns null when acceptable, otherwise a message for the user.
 * Policy: 10–128 characters, not a well-known password, not derived from the account e-mail/name.
 */
export function passwordPolicyError(password, { email, firstName, lastName } = {}) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/.test(password)) return 'A password cannot be a single repeated character.';
  const personal = [email?.split('@')[0], firstName, lastName]
    .filter((s) => typeof s === 'string' && s.length >= 4)
    .map((s) => s.toLowerCase());
  if (personal.some((s) => lower.includes(s))) return 'A password should not contain your name or e-mail address.';
  return null;
}
