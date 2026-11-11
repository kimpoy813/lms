// Small helpers shared by route handlers.
import { z } from 'zod';

/** Standard success envelope: { data, meta? } */
export const ok = (res, data, meta) => res.json(meta ? { data, meta } : { data });
export const created = (res, data) => res.status(201).json({ data });
export const noContent = (res) => res.status(204).end();

/** Query-string schema for paginated lists. */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export function paging({ page = 1, pageSize = 20 } = {}) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function pageMeta({ page = 1, pageSize = 20 } = {}, total) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * parent.use(path, child) that also remembers the path. Express 5 does not keep the mount path of
 * a nested router, and the API reference generator needs it.
 */
export function mount(parent, path, child) {
  parent.use(path, child);
  (parent.mounted ??= []).push({ path, router: child });
}

/**
 * Schema for a PATCH body derived from a create schema: every field becomes optional and loses
 * its default. (zod's own `.partial()` keeps applying defaults, which would silently reset every
 * field the client did not send.)
 */
export function patchOf(schema) {
  const shape = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let inner = field;
    while (inner instanceof z.ZodDefault) inner = inner.unwrap();
    shape[key] = inner.optional();
  }
  return z.object(shape);
}

// Reusable field schemas ---------------------------------------------------

export const zId = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');
export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid e-mail address'));
export const zName = z.string().trim().min(1, 'Required').max(80);
export const zTitle = z.string().trim().min(1, 'Required').max(200);
export const zText = (max = 5000) => z.string().trim().max(max);
export const zHtml = z.string().max(500_000);
export const zDateTime = z.coerce.date();
export const zOptionalDateTime = z.union([z.coerce.date(), z.null()]).optional();
export const zDateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
export const zBoolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const idParams = (...names) => z.object(Object.fromEntries(names.map((n) => [n, zId])));

/** Round to a fixed number of decimals without binary floating-point surprises (1.005 → 1.01). */
export function round(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export const fullName = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() : '';

/** Fields of a user that are safe to show to other members of a class. */
export const publicUser = (user) =>
  user
    ? {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: fullName(user),
        role: user.role,
        avatarFileId: user.avatarFileId ?? null,
      }
    : null;

export const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  avatarFileId: true,
};
