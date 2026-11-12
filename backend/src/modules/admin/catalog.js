// Institution structure: departments, programs, academic years, semesters, courses, sections and
// grading scales. Administrators manage them; teachers get read-only lookups for their forms.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { created, idParams, mount, noContent, ok, pageMeta, pageQuery, paging, patchOf, zDateKey, zId } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { dateKeyToDb, dbToDateKey } from '../../lib/time.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';

const code = (max = 20) => z.string().trim().min(1, 'Required').max(max).transform((v) => v.toUpperCase().replace(/\s+/g, ' '));
const name = (max = 150) => z.string().trim().min(1, 'Required').max(max).transform((v) => plainText(v, max));
const optionalText = (max = 1000) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? plainText(v, max) : v === undefined ? undefined : null));
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  ...pageQuery,
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Build list/create/update/delete handlers for a simple catalogue entity.
 * Writes are administrator-only and audited; a delete that would orphan other records is
 * refused by the database (ON DELETE RESTRICT) and reported as a 409.
 */
function crud({ model, label, createSchema, updateSchema, searchFields = [], include, orderBy, serialize = (r) => r, check, hasActive = false, filter }) {
  const router = Router();
  const delegate = () => prisma[model];

  router.get('/', validate({ query: listQuery.extend(filter?.query ?? {}) }), async (req, res) => {
    const q = req.valid.query;
    const where = {
      ...(q.search && searchFields.length > 0
        ? { OR: searchFields.map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' } })) }
        : {}),
      ...(hasActive && q.active !== undefined ? { isActive: q.active === 'true' } : {}),
      ...(filter ? filter.where(q) : {}),
    };
    const [total, rows] = await Promise.all([
      delegate().count({ where }),
      delegate().findMany({ where, include, orderBy, ...paging(q) }),
    ]);
    ok(res, rows.map(serialize), pageMeta(q, total));
  });

  router.post('/', requireRole('ADMIN'), validate({ body: createSchema }), async (req, res) => {
    const data = check ? await check(req.valid.body, null) : req.valid.body;
    const row = await delegate().create({ data, include });
    await audit(req, { action: `${model}.create`, entityType: label, entityId: row.id, summary: `Created ${label.toLowerCase()}`, after: data });
    created(res, serialize(row));
  });

  router.patch('/:id', requireRole('ADMIN'), validate({ params: idParams('id'), body: updateSchema }), async (req, res) => {
    const existing = await delegate().findUnique({ where: { id: req.valid.params.id } });
    if (!existing) throw notFound(label);
    const data = check ? await check(req.valid.body, existing) : req.valid.body;
    const row = await delegate().update({ where: { id: existing.id }, data, include });
    await audit(req, { action: `${model}.update`, entityType: label, entityId: row.id, summary: `Updated ${label.toLowerCase()}`, before: existing, after: data });
    ok(res, serialize(row));
  });

  router.delete('/:id', requireRole('ADMIN'), validate({ params: idParams('id') }), async (req, res) => {
    const existing = await delegate().findUnique({ where: { id: req.valid.params.id } });
    if (!existing) throw notFound(label);
    try {
      await delegate().delete({ where: { id: existing.id } });
    } catch (err) {
      // Foreign keys protect records that still reference this one.
      const state = err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode;
      if (err?.code === 'P2003' || err?.code === 'P2014' || state === '23503' || state === '23001') {
        throw conflict(`This ${label.toLowerCase()} is still in use and cannot be deleted.${hasActive ? ' Mark it inactive instead.' : ''}`, 'IN_USE');
      }
      throw err;
    }
    await audit(req, { action: `${model}.delete`, entityType: label, entityId: existing.id, summary: `Deleted ${label.toLowerCase()}`, before: existing });
    noContent(res);
  });

  return router;
}

async function assertUnique(model, field, value, existing, message) {
  if (value === undefined || (existing && String(existing[field]).toLowerCase() === String(value).toLowerCase())) return;
  const clash = await prisma[model].findFirst({ where: { [field]: { equals: value, mode: 'insensitive' } }, select: { id: true } });
  if (clash) throw fieldErrors({ [field]: message });
}

async function assertExists(model, id, field, message) {
  if (!id) return;
  if (!(await prisma[model].findUnique({ where: { id }, select: { id: true } }))) throw fieldErrors({ [field]: message });
}

function dateRange(body, existing) {
  const start = body.startDate ?? (existing ? dbToDateKey(existing.startDate) : undefined);
  const end = body.endDate ?? (existing ? dbToDateKey(existing.endDate) : undefined);
  if (start && end && end < start) throw fieldErrors({ endDate: 'The end date must not be before the start date.' });
  return {
    ...(body.startDate ? { startDate: dateKeyToDb(body.startDate) } : {}),
    ...(body.endDate ? { endDate: dateKeyToDb(body.endDate) } : {}),
  };
}

// ── Departments ───────────────────────────────────────────────────────────────
const departmentFields = { code: code(), name: name(), description: optionalText(), isActive: z.boolean().optional() };
const departments = crud({
  model: 'department', label: 'Department', hasActive: true, searchFields: ['code', 'name'],
  orderBy: { code: 'asc' },
  include: { _count: { select: { programs: true, courses: true, teachers: true } } },
  createSchema: z.object(departmentFields),
  updateSchema: patchOf(z.object(departmentFields)),
  check: async (body, existing) => {
    await assertUnique('department', 'code', body.code, existing, 'This department code is already used.');
    return body;
  },
  serialize: (d) => ({ id: d.id, code: d.code, name: d.name, description: d.description, isActive: d.isActive, programCount: d._count.programs, courseCount: d._count.courses, teacherCount: d._count.teachers }),
});

// ── Programs ──────────────────────────────────────────────────────────────────
const programFields = {
  code: code(), name: name(), departmentId: zId, description: optionalText(),
  durationYears: z.number().int().min(1).max(10).nullable().optional(), isActive: z.boolean().optional(),
};
const programs = crud({
  model: 'academicProgram', label: 'Program', hasActive: true, searchFields: ['code', 'name'],
  orderBy: { code: 'asc' },
  include: { department: { select: { id: true, code: true, name: true } }, _count: { select: { students: true, sections: true } } },
  createSchema: z.object(programFields),
  updateSchema: patchOf(z.object(programFields)),
  check: async (body, existing) => {
    await assertUnique('academicProgram', 'code', body.code, existing, 'This program code is already used.');
    await assertExists('department', body.departmentId, 'departmentId', 'Choose a department.');
    return body;
  },
  serialize: (p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, durationYears: p.durationYears, isActive: p.isActive, departmentId: p.departmentId, department: p.department, studentCount: p._count.students, sectionCount: p._count.sections }),
});

// ── Academic years ────────────────────────────────────────────────────────────
const yearFields = { name: name(40), startDate: zDateKey, endDate: zDateKey, isCurrent: z.boolean().optional() };
const serializeSemester = (s) => ({
  id: s.id, name: s.name, academicYearId: s.academicYearId, academicYear: s.academicYear ? { id: s.academicYear.id, name: s.academicYear.name } : undefined,
  startDate: dbToDateKey(s.startDate), endDate: dbToDateKey(s.endDate), isCurrent: s.isCurrent, classCount: s._count?.classes,
  label: s.academicYear ? `${s.name}, ${s.academicYear.name}` : s.name,
});
const academicYears = crud({
  model: 'academicYear', label: 'Academic year', searchFields: ['name'],
  orderBy: { startDate: 'desc' },
  include: { semesters: { orderBy: { startDate: 'asc' }, include: { _count: { select: { classes: true } } } } },
  createSchema: z.object(yearFields),
  updateSchema: patchOf(z.object(yearFields)),
  check: async (body, existing) => {
    await assertUnique('academicYear', 'name', body.name, existing, 'An academic year with this name already exists.');
    const data = { ...(body.name ? { name: body.name } : {}), ...dateRange(body, existing) };
    if (body.isCurrent !== undefined) {
      data.isCurrent = body.isCurrent;
      // Only one academic year is "current" at a time.
      if (body.isCurrent) await prisma.academicYear.updateMany({ where: existing ? { id: { not: existing.id } } : {}, data: { isCurrent: false } });
    }
    return data;
  },
  serialize: (y) => ({ id: y.id, name: y.name, startDate: dbToDateKey(y.startDate), endDate: dbToDateKey(y.endDate), isCurrent: y.isCurrent, semesters: y.semesters.map(serializeSemester) }),
});

// ── Semesters ─────────────────────────────────────────────────────────────────
const semesterFields = { academicYearId: zId, name: name(60), startDate: zDateKey, endDate: zDateKey, isCurrent: z.boolean().optional() };
const semesters = crud({
  model: 'semester', label: 'Semester', searchFields: ['name'],
  orderBy: [{ startDate: 'desc' }],
  include: { academicYear: true, _count: { select: { classes: true } } },
  createSchema: z.object(semesterFields),
  updateSchema: patchOf(z.object(semesterFields)),
  check: async (body, existing) => {
    const academicYearId = body.academicYearId ?? existing?.academicYearId;
    const year = await prisma.academicYear.findUnique({ where: { id: academicYearId } });
    if (!year) throw fieldErrors({ academicYearId: 'Choose an academic year.' });
    const semesterName = body.name ?? existing?.name;
    const clash = await prisma.semester.findFirst({
      where: { academicYearId, name: { equals: semesterName, mode: 'insensitive' }, ...(existing ? { id: { not: existing.id } } : {}) },
      select: { id: true },
    });
    if (clash) throw fieldErrors({ name: 'This academic year already has a semester with that name.' });
    const data = { ...(body.academicYearId ? { academicYearId } : {}), ...(body.name ? { name: body.name } : {}), ...dateRange(body, existing) };
    const start = body.startDate ?? dbToDateKey(existing.startDate);
    const end = body.endDate ?? dbToDateKey(existing.endDate);
    if (start < dbToDateKey(year.startDate) || end > dbToDateKey(year.endDate)) {
      throw fieldErrors({ startDate: `The semester must fall inside academic year ${year.name} (${dbToDateKey(year.startDate)} to ${dbToDateKey(year.endDate)}).` });
    }
    if (body.isCurrent !== undefined) {
      data.isCurrent = body.isCurrent;
      if (body.isCurrent) await prisma.semester.updateMany({ where: existing ? { id: { not: existing.id } } : {}, data: { isCurrent: false } });
    }
    return data;
  },
  serialize: serializeSemester,
});

// ── Courses ───────────────────────────────────────────────────────────────────
const courseFields = {
  code: code(), title: name(), description: optionalText(2000), units: z.number().min(0).max(12).optional(),
  departmentId: zId.nullable().optional(), isActive: z.boolean().optional(),
};
const courses = crud({
  model: 'course', label: 'Course', hasActive: true, searchFields: ['code', 'title'],
  orderBy: { code: 'asc' },
  include: { department: { select: { id: true, code: true, name: true } }, _count: { select: { classes: true } } },
  createSchema: z.object(courseFields),
  updateSchema: patchOf(z.object(courseFields)),
  filter: { query: { departmentId: zId.optional() }, where: (q) => (q.departmentId ? { departmentId: q.departmentId } : {}) },
  check: async (body, existing) => {
    await assertUnique('course', 'code', body.code, existing, 'This course code is already used.');
    await assertExists('department', body.departmentId, 'departmentId', 'Choose a department.');
    return body;
  },
  serialize: (c) => ({ id: c.id, code: c.code, title: c.title, description: c.description, units: c.units, isActive: c.isActive, departmentId: c.departmentId, department: c.department, classCount: c._count.classes }),
});

// ── Sections ──────────────────────────────────────────────────────────────────
const sectionFields = {
  name: name(60), programId: zId.nullable().optional(), yearLevel: z.number().int().min(1).max(10).nullable().optional(), isActive: z.boolean().optional(),
};
const sections = crud({
  model: 'section', label: 'Section', hasActive: true, searchFields: ['name'],
  orderBy: { name: 'asc' },
  include: { program: { select: { id: true, code: true, name: true } }, _count: { select: { classes: true, students: true } } },
  createSchema: z.object(sectionFields),
  updateSchema: patchOf(z.object(sectionFields)),
  filter: { query: { programId: zId.optional() }, where: (q) => (q.programId ? { programId: q.programId } : {}) },
  check: async (body, existing) => {
    await assertUnique('section', 'name', body.name, existing, 'A section with this name already exists.');
    await assertExists('academicProgram', body.programId, 'programId', 'Choose a program.');
    return body;
  },
  serialize: (s) => ({ id: s.id, name: s.name, programId: s.programId, program: s.program, yearLevel: s.yearLevel, isActive: s.isActive, classCount: s._count.classes, studentCount: s._count.students }),
});

// ── Grading scales ────────────────────────────────────────────────────────────
const scaleEntry = z.object({
  minPercent: z.number().min(0).max(100),
  label: z.string().trim().min(1).max(20),
  remark: z.string().trim().max(60).nullable().optional(),
  isPassing: z.boolean(),
});
const scaleBody = z.object({
  name: name(80),
  description: optionalText(500),
  isDefault: z.boolean().optional(),
  entries: z.array(scaleEntry).min(2, 'Add at least two grade bands').max(40),
});

function checkEntries(entries) {
  const mins = entries.map((e) => e.minPercent);
  if (new Set(mins).size !== mins.length) throw fieldErrors({ entries: 'Two bands start at the same percentage.' });
  if (!mins.includes(0)) throw fieldErrors({ entries: 'One band must start at 0% so every score maps to a grade.' });
  return [...entries].sort((a, b) => b.minPercent - a.minPercent).map((e) => ({
    minPercent: e.minPercent, label: plainText(e.label, 20), remark: e.remark ? plainText(e.remark, 60) : null, isPassing: e.isPassing,
  }));
}

const serializeScale = (s) => ({
  id: s.id, name: s.name, description: s.description, isDefault: s.isDefault, classCount: s._count?.classes ?? 0,
  entries: [...s.entries].sort((a, b) => b.minPercent - a.minPercent).map((e) => ({ minPercent: e.minPercent, label: e.label, remark: e.remark, isPassing: e.isPassing })),
});
const scaleInclude = { entries: true, _count: { select: { classes: true } } };

const gradingScales = Router();
gradingScales.get('/', async (req, res) => {
  const scales = await prisma.gradingScale.findMany({ include: scaleInclude, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  ok(res, scales.map(serializeScale));
});
gradingScales.post('/', requireRole('ADMIN'), validate({ body: scaleBody }), async (req, res) => {
  const body = req.valid.body;
  await assertUnique('gradingScale', 'name', body.name, null, 'A grading scale with this name already exists.');
  const entries = checkEntries(body.entries);
  const scale = await prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.gradingScale.updateMany({ data: { isDefault: false } });
    const row = await tx.gradingScale.create({
      data: { name: body.name, description: body.description ?? null, isDefault: body.isDefault ?? false, entries: { create: entries } },
      include: scaleInclude,
    });
    await audit(req, { action: 'gradingScale.create', entityType: 'GradingScale', entityId: row.id, summary: `Created grading scale "${row.name}"`, after: { entries } }, tx);
    return row;
  });
  created(res, serializeScale(scale));
});
gradingScales.put('/:id', requireRole('ADMIN'), validate({ params: idParams('id'), body: scaleBody }), async (req, res) => {
  const body = req.valid.body;
  const existing = await prisma.gradingScale.findUnique({ where: { id: req.valid.params.id }, include: { entries: true } });
  if (!existing) throw notFound('Grading scale');
  await assertUnique('gradingScale', 'name', body.name, existing, 'A grading scale with this name already exists.');
  const entries = checkEntries(body.entries);
  const scale = await prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.gradingScale.updateMany({ where: { id: { not: existing.id } }, data: { isDefault: false } });
    await tx.gradingScaleEntry.deleteMany({ where: { scaleId: existing.id } });
    const row = await tx.gradingScale.update({
      where: { id: existing.id },
      data: { name: body.name, description: body.description ?? null, isDefault: body.isDefault ?? existing.isDefault, entries: { create: entries } },
      include: scaleInclude,
    });
    await audit(req, {
      action: 'gradingScale.update', entityType: 'GradingScale', entityId: row.id, summary: `Updated grading scale "${row.name}"`,
      before: { entries: existing.entries.map((e) => ({ minPercent: e.minPercent, label: e.label })) }, after: { entries },
    }, tx);
    return row;
  });
  ok(res, serializeScale(scale));
});
gradingScales.delete('/:id', requireRole('ADMIN'), validate({ params: idParams('id') }), async (req, res) => {
  const existing = await prisma.gradingScale.findUnique({ where: { id: req.valid.params.id }, include: { _count: { select: { classes: true } } } });
  if (!existing) throw notFound('Grading scale');
  if (existing.isDefault) throw conflict('The default grading scale cannot be deleted. Make another scale the default first.', 'IN_USE');
  if (existing._count.classes > 0) throw conflict('Classes are using this grading scale, so it cannot be deleted.', 'IN_USE');
  await prisma.gradingScale.delete({ where: { id: existing.id } });
  await audit(req, { action: 'gradingScale.delete', entityType: 'GradingScale', entityId: existing.id, summary: `Deleted grading scale "${existing.name}"` });
  noContent(res);
});

/**
 * Mounted at /api/catalog. Reads are open to teachers and administrators (teachers need the
 * lists to create classes); every write inside is restricted to administrators.
 */
export const catalogRouter = Router();
catalogRouter.use(requireAuth, requireRole('ADMIN', 'TEACHER'));
mount(catalogRouter, '/departments', departments);
mount(catalogRouter, '/programs', programs);
mount(catalogRouter, '/academic-years', academicYears);
mount(catalogRouter, '/semesters', semesters);
mount(catalogRouter, '/courses', courses);
mount(catalogRouter, '/sections', sections);
mount(catalogRouter, '/grading-scales', gradingScales);
