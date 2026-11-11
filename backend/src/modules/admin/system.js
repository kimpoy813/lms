// Administrator: system settings, role permissions, audit log, and enrolment tools.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { sendCsv, toCsv } from '../../lib/csv.js';
import { fullName, ok, pageMeta, pageQuery, paging, zId } from '../../lib/http.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { mailConfigured } from '../../services/mail.js';
import { notify } from '../../services/notifications.js';
import { permissionMatrix, setRolePermission } from '../../services/permissions.js';
import { getSettings, SETTING_DEFINITIONS, updateSettings } from '../../services/settings.js';
import { storageUsage } from '../../services/storage.js';
import { classLabel } from '../classes/access.js';

export const adminSystemRouter = Router();
adminSystemRouter.use(requireRole('ADMIN'));

// ── Settings ──────────────────────────────────────────────────────────────────
function settingType(def) {
  if (typeof def.default === 'boolean') return 'boolean';
  if (typeof def.default === 'number') return 'number';
  return 'string';
}

adminSystemRouter.get('/settings', async (req, res) => {
  const values = await getSettings();
  ok(res, {
    values,
    definitions: Object.entries(SETTING_DEFINITIONS).map(([key, def]) => ({
      key, group: def.group, label: def.label, help: def.help ?? null, type: settingType(def), default: def.default,
    })),
  });
});

adminSystemRouter.patch('/settings', validate({ body: z.object({ values: z.record(z.string(), z.unknown()) }) }), async (req, res) => {
  const before = await getSettings();
  const values = await updateSettings(req.valid.body.values, req.user.id);
  const changed = Object.keys(req.valid.body.values).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(values[k]));
  if (changed.length > 0) {
    await audit(req, {
      action: 'settings.update', entityType: 'SystemSetting', summary: `Changed ${changed.length} system setting${changed.length === 1 ? '' : 's'}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, values[k]])),
    });
  }
  ok(res, { values });
});

adminSystemRouter.get('/status', async (req, res) => {
  ok(res, {
    environment: env.nodeEnv,
    demoAccountsEnabled: env.demoAccountsEnabled,
    mailConfigured: mailConfigured(),
    ai: { configured: env.ai.configured, provider: env.ai.provider, model: env.ai.configured ? env.ai.model : null },
    codeRunner: { configured: env.codeRunner.configured, provider: env.codeRunner.provider },
    maxUploadBytes: env.maxUploadBytes,
    // How the API is hosted, and what follows from it.
    platform: env.platform,
    serverless: env.serverless,
    realtime: env.realtime,
    storage: await storageUsage(),
  });
});

// ── Role permissions ──────────────────────────────────────────────────────────
adminSystemRouter.get('/permissions', async (req, res) => {
  ok(res, await permissionMatrix());
});

adminSystemRouter.put(
  '/permissions',
  validate({ body: z.object({ role: z.enum(['TEACHER', 'STUDENT']), key: z.string().max(80), granted: z.boolean() }) }),
  async (req, res) => {
    const { role, key, granted } = req.valid.body;
    if (!(await setRolePermission(role, key, granted))) throw fieldErrors({ key: 'This permission does not apply to that role.' });
    await audit(req, {
      action: 'permission.update', entityType: 'Permission', entityId: key,
      summary: `${granted ? 'Granted' : 'Revoked'} "${key}" ${granted ? 'to' : 'from'} ${role.toLowerCase()}s`,
    });
    ok(res, await permissionMatrix());
  },
);

// ── Audit log (read-only) ─────────────────────────────────────────────────────
const auditQuery = z.object({
  search: z.string().trim().max(100).optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
  actorId: zId.optional(),
  classId: zId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

function auditWhere(q) {
  return {
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.classId ? { classId: q.classId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    ...(q.search
      ? {
          OR: [
            { summary: { contains: q.search, mode: 'insensitive' } },
            { action: { contains: q.search, mode: 'insensitive' } },
            { actor: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { email: { contains: q.search, mode: 'insensitive' } }] } },
          ],
        }
      : {}),
  };
}

const auditInclude = { actor: { select: { id: true, firstName: true, lastName: true, email: true } } };
export const serializeAudit = (a) => ({
  id: a.id, createdAt: a.createdAt, action: a.action, entityType: a.entityType, entityId: a.entityId, classId: a.classId,
  summary: a.summary, actorRole: a.actorRole, actor: a.actor ? { id: a.actor.id, name: fullName(a.actor), email: a.actor.email } : null,
  ipAddress: a.ipAddress, before: a.before, after: a.after,
});

adminSystemRouter.get('/audit-logs', validate({ query: auditQuery }), async (req, res) => {
  const q = req.valid.query;
  const where = auditWhere(q);
  const [total, rows, actions] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: auditInclude, orderBy: { createdAt: 'desc' }, ...paging(q) }),
    prisma.auditLog.groupBy({ by: ['entityType'], _count: { _all: true }, orderBy: { entityType: 'asc' } }),
  ]);
  ok(res, rows.map(serializeAudit), { ...pageMeta(q, total), entityTypes: actions.map((a) => a.entityType) });
});

adminSystemRouter.get('/audit-logs/export', validate({ query: auditQuery }), async (req, res) => {
  const rows = await prisma.auditLog.findMany({ where: auditWhere(req.valid.query), include: auditInclude, orderBy: { createdAt: 'desc' }, take: 10_000 });
  await audit(req, { action: 'audit.export', entityType: 'AuditLog', summary: `Exported ${rows.length} audit log entries` });
  sendCsv(res, 'audit-log.csv', toCsv(
    [
      { header: 'Time (UTC)', value: (r) => r.createdAt.toISOString() },
      { header: 'Actor', value: (r) => (r.actor ? fullName(r.actor) : 'System') },
      { header: 'Actor e-mail', value: (r) => r.actor?.email ?? '' },
      { header: 'Role', value: (r) => r.actorRole ?? '' },
      { header: 'Action', value: (r) => r.action },
      { header: 'Record type', value: (r) => r.entityType },
      { header: 'Record id', value: (r) => r.entityId ?? '' },
      { header: 'Summary', value: (r) => r.summary ?? '' },
      { header: 'IP address', value: (r) => r.ipAddress ?? '' },
    ],
    rows,
  ));
});

// ── Enrolment tools ───────────────────────────────────────────────────────────
const classInclude = { course: { select: { code: true, title: true } }, section: { select: { name: true } } };

async function loadActiveStudent(studentId) {
  const student = await prisma.user.findFirst({ where: { id: studentId, role: 'STUDENT' }, select: { id: true, status: true, firstName: true, lastName: true } });
  if (!student) throw fieldErrors({ studentId: 'Choose a student account.' });
  if (student.status !== 'ACTIVE') throw fieldErrors({ studentId: 'This student account is not active.' });
  return student;
}

async function loadActiveClass(classId, field) {
  const cls = await prisma.class.findUnique({ where: { id: classId }, include: classInclude });
  if (!cls) throw fieldErrors({ [field]: 'Choose a class.' });
  if (cls.status !== 'ACTIVE') throw fieldErrors({ [field]: 'This class is archived.' });
  return cls;
}

async function enrollIn(tx, req, cls, student) {
  const now = new Date();
  const data = { status: 'ENROLLED', source: 'ADMIN', enrolledAt: now, decidedAt: now, decidedById: req.user.id, droppedAt: null, note: null };
  return tx.enrollment.upsert({
    where: { classId_studentId: { classId: cls.id, studentId: student.id } },
    create: { classId: cls.id, studentId: student.id, ...data },
    update: data,
  });
}

adminSystemRouter.post('/enrollments', validate({ body: z.object({ classId: zId, studentId: zId }) }), async (req, res) => {
  const { classId, studentId } = req.valid.body;
  const [cls, student] = [await loadActiveClass(classId, 'classId'), await loadActiveStudent(studentId)];
  const existing = await prisma.enrollment.findUnique({ where: { classId_studentId: { classId, studentId } } });
  if (existing?.status === 'ENROLLED') throw conflict('This student is already enrolled in that class.', 'ALREADY_ENROLLED');
  const enrollment = await prisma.$transaction(async (tx) => {
    const row = await enrollIn(tx, req, cls, student);
    await audit(req, { action: 'enrollment.admin_enroll', entityType: 'Enrollment', entityId: row.id, classId, summary: `Enrolled ${fullName(student)} in ${classLabel(cls)}` }, tx);
    return row;
  });
  await notify([studentId], { type: 'enrollment.approved', title: `You were enrolled in ${classLabel(cls)}`, link: `/classes/${classId}`, classId });
  ok(res, { id: enrollment.id, status: enrollment.status });
});

adminSystemRouter.post(
  '/enrollments/transfer',
  validate({ body: z.object({ studentId: zId, fromClassId: zId, toClassId: zId, note: z.string().trim().max(500).optional() }) }),
  async (req, res) => {
    const { studentId, fromClassId, toClassId, note } = req.valid.body;
    if (fromClassId === toClassId) throw fieldErrors({ toClassId: 'Choose a different class to transfer to.' });
    const student = await loadActiveStudent(studentId);
    const from = await prisma.class.findUnique({ where: { id: fromClassId }, include: classInclude });
    if (!from) throw notFound('Class');
    const to = await loadActiveClass(toClassId, 'toClassId');
    const current = await prisma.enrollment.findUnique({ where: { classId_studentId: { classId: fromClassId, studentId } } });
    if (current?.status !== 'ENROLLED') throw fieldErrors({ fromClassId: 'The student is not enrolled in that class.' });

    // Both halves succeed or neither does: a student is never left in both or in neither class.
    await prisma.$transaction(async (tx) => {
      await tx.enrollment.update({
        where: { id: current.id },
        data: { status: 'DROPPED', droppedAt: new Date(), decidedById: req.user.id, note: `Transferred to ${classLabel(to)}${note ? ` — ${note}` : ''}`.slice(0, 500) },
      });
      const row = await enrollIn(tx, req, to, student);
      await audit(req, {
        action: 'enrollment.transfer', entityType: 'Enrollment', entityId: row.id, classId: toClassId,
        summary: `Transferred ${fullName(student)} from ${classLabel(from)} to ${classLabel(to)}`,
        after: { fromClassId, toClassId, note: note ?? null },
      }, tx);
    });
    await notify([studentId], {
      type: 'enrollment.transferred', title: `You were transferred to ${classLabel(to)}`,
      body: `You are no longer enrolled in ${classLabel(from)}.`, link: `/classes/${toClassId}`, classId: toClassId,
    });
    await notify([from.teacherId, to.teacherId], {
      type: 'enrollment.transferred', title: `${fullName(student)} was transferred from ${classLabel(from)} to ${classLabel(to)}`, link: `/classes/${toClassId}/people`,
    });
    ok(res, { message: `${fullName(student)} was transferred to ${classLabel(to)}.` });
  },
);

// Lookup used by the enrolment tools: students with their current enrolments.
adminSystemRouter.get('/students', validate({ query: z.object({ search: z.string().trim().max(100).optional(), ...pageQuery }) }), async (req, res) => {
  const q = req.valid.query;
  const where = {
    role: 'STUDENT',
    anonymizedAt: null,
    ...(q.search
      ? {
          OR: [
            { firstName: { contains: q.search, mode: 'insensitive' } },
            { lastName: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
            { studentProfile: { studentNumber: { contains: q.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [total, students] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true, firstName: true, lastName: true, email: true, status: true,
        studentProfile: { select: { studentNumber: true, yearLevel: true, program: { select: { code: true } }, section: { select: { name: true } } } },
        enrollments: {
          where: { status: 'ENROLLED', class: { status: 'ACTIVE' } },
          select: { id: true, class: { select: { id: true, course: { select: { code: true, title: true } }, section: { select: { name: true } } } } },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      ...paging(q),
    }),
  ]);
  ok(
    res,
    students.map((s) => ({
      id: s.id, name: fullName(s), email: s.email, status: s.status,
      studentNumber: s.studentProfile?.studentNumber ?? null, program: s.studentProfile?.program?.code ?? null,
      section: s.studentProfile?.section?.name ?? null, yearLevel: s.studentProfile?.yearLevel ?? null,
      classes: s.enrollments.map((e) => ({ enrollmentId: e.id, classId: e.class.id, label: classLabel(e.class), title: e.class.course.title })),
    })),
    pageMeta(q, total),
  );
});
