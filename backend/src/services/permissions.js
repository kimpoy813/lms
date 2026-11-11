// Configurable role permissions.
//
// Coarse access (who is an administrator, teacher or student, and who owns or is enrolled in a
// class) is enforced in code. On top of that, the capabilities below can be switched on or off
// per role by an administrator. Administrators always hold every permission.
import { prisma } from '../db/prisma.js';

/**
 * `roles`    — roles the permission is meaningful for (shown as toggles in the admin UI)
 * `defaults` — roles that hold it on a fresh installation
 */
export const PERMISSION_CATALOG = [
  { key: 'class.create', category: 'Classes', description: 'Create classes and manage their own classes', roles: ['TEACHER'], defaults: ['TEACHER'] },
  { key: 'catalog.create', category: 'Classes', description: 'Add a new course or section to the catalogue while creating a class', roles: ['TEACHER'], defaults: ['TEACHER'] },
  { key: 'class.view_classmates', category: 'Privacy', description: 'See the list of classmates (when the class allows it)', roles: ['STUDENT'], defaults: ['STUDENT'] },
  { key: 'messaging.student_to_teacher', category: 'Messaging', description: 'Send direct messages to teachers of enrolled classes', roles: ['STUDENT'], defaults: ['STUDENT'] },
  { key: 'messaging.student_to_student', category: 'Messaging', description: 'Send direct messages to classmates', roles: ['STUDENT'], defaults: [] },
  { key: 'discussion.create_thread', category: 'Discussions', description: 'Start new discussion threads', roles: ['STUDENT'], defaults: ['STUDENT'] },
  { key: 'grades.export', category: 'Records', description: 'Export grade sheets', roles: ['TEACHER'], defaults: ['TEACHER'] },
  { key: 'attendance.export', category: 'Records', description: 'Export attendance records', roles: ['TEACHER'], defaults: ['TEACHER'] },
  { key: 'submissions.download', category: 'Records', description: 'Download all submissions of an assignment as one archive', roles: ['TEACHER'], defaults: ['TEACHER'] },
  { key: 'records.download', category: 'Records', description: 'Download their own grade report', roles: ['STUDENT'], defaults: ['STUDENT'] },
  { key: 'ai.use', category: 'AI', description: 'Use AI-assisted module and assessment authoring', roles: ['TEACHER'], defaults: ['TEACHER'] },
];

const CATALOG_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
const CACHE_TTL_MS = 10_000;
let cache = null;
let cachedAt = 0;

export function invalidatePermissions() {
  cache = null;
}

async function load() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  const rows = await prisma.rolePermission.findMany();
  const map = { ADMIN: new Set(CATALOG_KEYS), TEACHER: new Set(), STUDENT: new Set() };
  for (const row of rows) {
    if (CATALOG_KEYS.has(row.permissionKey)) map[row.role]?.add(row.permissionKey);
  }
  cache = map;
  cachedAt = Date.now();
  return map;
}

export async function hasPermission(role, key) {
  if (role === 'ADMIN') return true;
  return (await load())[role]?.has(key) ?? false;
}

export async function permissionsFor(role) {
  if (role === 'ADMIN') return [...CATALOG_KEYS];
  return [...((await load())[role] ?? [])];
}

/**
 * Make the Permission table match the catalogue. New permissions receive their default roles;
 * existing grants chosen by an administrator are left untouched. Safe to run on every start.
 */
export async function syncPermissionCatalog() {
  const existing = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  for (const perm of PERMISSION_CATALOG) {
    if (existing.has(perm.key)) {
      await prisma.permission.update({
        where: { key: perm.key },
        data: { description: perm.description, category: perm.category },
      });
    } else {
      await prisma.permission.create({
        data: {
          key: perm.key,
          description: perm.description,
          category: perm.category,
          roles: { create: perm.defaults.map((role) => ({ role })) },
        },
      });
    }
  }
  await prisma.permission.deleteMany({ where: { key: { notIn: [...CATALOG_KEYS] } } });
  invalidatePermissions();
}

/** Matrix for the admin UI. */
export async function permissionMatrix() {
  const map = await load();
  return PERMISSION_CATALOG.map((perm) => ({
    key: perm.key,
    category: perm.category,
    description: perm.description,
    roles: perm.roles,
    granted: perm.roles.filter((role) => map[role].has(perm.key)),
  }));
}

export async function setRolePermission(role, key, granted) {
  const perm = PERMISSION_CATALOG.find((p) => p.key === key);
  if (!perm || !perm.roles.includes(role)) return false;
  if (granted) {
    await prisma.rolePermission.upsert({
      where: { role_permissionKey: { role, permissionKey: key } },
      create: { role, permissionKey: key },
      update: {},
    });
  } else {
    await prisma.rolePermission.deleteMany({ where: { role, permissionKey: key } });
  }
  invalidatePermissions();
  return true;
}
