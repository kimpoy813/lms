// Classes: create/manage, schedules, enrolment codes, archive/restore.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import {
  created, fullName, idParams, noContent, ok, pageMeta, pageQuery, paging, userSelect, zHtml, zId, zTime,
} from '../../lib/http.js';
import { plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { minutesOf } from '../../lib/time.js';
import { randomCode } from '../../lib/tokens.js';
import { assertPermission, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { hasPermission } from '../../services/permissions.js';
import { getSetting } from '../../services/settings.js';
import { createDefaultGradeSetup } from '../gradebook/defaults.js';
import { loadClassAccess, requireClassManager, requireWritableClassManager } from './access.js';

export const classesRouter = Router();
classesRouter.use(requireAuth);

export const CLASS_COLORS = ['indigo', 'violet', 'sky', 'teal', 'emerald', 'amber', 'rose', 'slate'];

const listInclude = {
  course: { select: { id: true, code: true, title: true, units: true } },
  section: { select: { id: true, name: true } },
  semester: { select: { id: true, name: true, startDate: true, endDate: true, isCurrent: true, academicYear: { select: { id: true, name: true } } } },
  teacher: { select: { ...userSelect, email: true } },
  schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
};

export function serializeClass(cls, { role, counts } = {}) {
  const manage = role === 'TEACHER' || role === 'ADMIN';
  return {
    id: cls.id,
    course: cls.course,
    section: cls.section,
    semester: cls.semester
      ? { id: cls.semester.id, name: cls.semester.name, isCurrent: cls.semester.isCurrent, academicYear: cls.semester.academicYear }
      : undefined,
    teacher: cls.teacher
      ? { id: cls.teacher.id, name: fullName(cls.teacher), avatarFileId: cls.teacher.avatarFileId, email: cls.teacher.email }
      : undefined,
    title: `${cls.course.code} — ${cls.course.title}`,
    description: cls.description,
    room: cls.room,
    color: cls.color,
    status: cls.status,
    archivedAt: cls.archivedAt,
    schedules: (cls.schedules ?? []).map((s) => ({ id: s.id, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, room: s.room })),
    enrollmentRequiresApproval: cls.enrollmentRequiresApproval,
    classmatesVisible: cls.classmatesVisible,
    gradesFinalizedAt: cls.gradesFinalizedAt,
    myRole: role,
    // The enrolment code is a secret shared by the teacher — students never receive it from the API.
    ...(manage ? { enrollmentCode: cls.enrollmentCode, enrollmentCodeEnabled: cls.enrollmentCodeEnabled } : {}),
    ...(counts ?? {}),
    createdAt: cls.createdAt,
  };
}

async function uniqueEnrollmentCode(tx) {
  for (let i = 0; i < 20; i += 1) {
    const code = randomCode(7);
    if (!(await tx.class.findUnique({ where: { enrollmentCode: code }, select: { id: true } }))) return code;
  }
  throw new Error('could not generate a unique enrolment code');
}

const scheduleSchema = z
  .object({ dayOfWeek: z.number().int().min(0).max(6), startTime: zTime, endTime: zTime, room: z.string().trim().max(60).nullable().optional() })
  .refine((s) => minutesOf(s.endTime) > minutesOf(s.startTime), { message: 'End time must be after the start time', path: ['endTime'] });

function assertNoScheduleOverlap(schedules) {
  for (let i = 0; i < schedules.length; i += 1) {
    for (let j = i + 1; j < schedules.length; j += 1) {
      const a = schedules[i];
      const b = schedules[j];
      if (a.dayOfWeek === b.dayOfWeek && minutesOf(a.startTime) < minutesOf(b.endTime) && minutesOf(b.startTime) < minutesOf(a.endTime)) {
        throw fieldErrors({ schedules: 'Two of the meeting times overlap on the same day.' });
      }
    }
  }
}

/**
 * Meetings of the teacher's other active classes (same semester) that collide with the given
 * schedule. Returned as a warning — a teacher may deliberately merge two sections.
 */
async function teacherScheduleConflicts(teacherId, semesterId, schedules, excludeClassId) {
  if (schedules.length === 0) return [];
  const others = await prisma.classSchedule.findMany({
    where: { class: { teacherId, semesterId, status: 'ACTIVE', ...(excludeClassId ? { id: { not: excludeClassId } } : {}) } },
    include: { class: { select: { id: true, course: { select: { code: true } }, section: { select: { name: true } } } } },
  });
  const conflicts = [];
  for (const s of schedules) {
    for (const o of others) {
      if (s.dayOfWeek === o.dayOfWeek && minutesOf(s.startTime) < minutesOf(o.endTime) && minutesOf(o.startTime) < minutesOf(s.endTime)) {
        conflicts.push({
          dayOfWeek: s.dayOfWeek,
          startTime: o.startTime,
          endTime: o.endTime,
          classId: o.class.id,
          className: `${o.class.course.code}${o.class.section ? ` · ${o.class.section.name}` : ''}`,
        });
      }
    }
  }
  return conflicts;
}

// ── List ──────────────────────────────────────────────────────────────────────
classesRouter.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
      semesterId: zId.optional(),
      search: z.string().trim().max(100).optional(),
      teacherId: zId.optional(),
      ...pageQuery,
      pageSize: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = {
      ...(q.status === 'ALL' ? {} : { status: q.status }),
      ...(q.semesterId ? { semesterId: q.semesterId } : {}),
      ...(q.search
        ? {
            OR: [
              { course: { code: { contains: q.search, mode: 'insensitive' } } },
              { course: { title: { contains: q.search, mode: 'insensitive' } } },
              { section: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    if (req.user.role === 'TEACHER') where.teacherId = req.user.id;
    else if (req.user.role === 'STUDENT') where.enrollments = { some: { studentId: req.user.id, status: 'ENROLLED' } };
    else if (q.teacherId) where.teacherId = q.teacherId;

    const [total, classes] = await Promise.all([
      prisma.class.count({ where }),
      prisma.class.findMany({
        where,
        include: listInclude,
        orderBy: [{ status: 'asc' }, { semester: { startDate: 'desc' } }, { course: { code: 'asc' } }],
        ...paging(q),
      }),
    ]);
    const ids = classes.map((c) => c.id);
    const grouped = ids.length
      ? await prisma.enrollment.groupBy({ by: ['classId', 'status'], where: { classId: { in: ids } }, _count: { _all: true } })
      : [];
    const countOf = (classId, status) => grouped.find((g) => g.classId === classId && g.status === status)?._count._all ?? 0;
    const role = req.user.role;
    ok(
      res,
      classes.map((c) =>
        serializeClass(c, {
          role,
          counts: {
            studentCount: countOf(c.id, 'ENROLLED'),
            ...(role !== 'STUDENT' ? { pendingCount: countOf(c.id, 'PENDING') } : {}),
          },
        }),
      ),
      pageMeta(q, total),
    );
  },
);

// ── Create ────────────────────────────────────────────────────────────────────
const classBody = z.object({
  courseId: zId.optional(),
  newCourse: z
    .object({
      code: z.string().trim().min(2).max(20),
      title: z.string().trim().min(2).max(150),
      units: z.number().min(0).max(12).default(3),
    })
    .optional(),
  sectionId: zId.nullable().optional(),
  newSectionName: z.string().trim().min(1).max(60).optional(),
  semesterId: zId,
  teacherId: zId.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  room: z.string().trim().max(60).nullable().optional(),
  color: z.enum(CLASS_COLORS).optional(),
  schedules: z.array(scheduleSchema).max(14).default([]),
  enrollmentRequiresApproval: z.boolean().optional(),
  classmatesVisible: z.boolean().optional(),
});

classesRouter.post('/', requireRole('TEACHER', 'ADMIN'), validate({ body: classBody }), async (req, res) => {
  const body = req.valid.body;
  await assertPermission(req.user, 'class.create');
  if (!body.courseId && !body.newCourse) throw fieldErrors({ courseId: 'Choose a course or enter a new one.' });
  if ((body.newCourse || body.newSectionName) && !(await hasPermission(req.user.role, 'catalog.create'))) {
    throw forbidden('Only the administrator can add new courses or sections. Choose one from the list.', 'PERMISSION_DENIED');
  }
  assertNoScheduleOverlap(body.schedules);

  let teacherId = req.user.id;
  if (req.user.role === 'ADMIN') {
    if (!body.teacherId) throw fieldErrors({ teacherId: 'Choose the teacher for this class.' });
    const teacher = await prisma.user.findFirst({ where: { id: body.teacherId, role: 'TEACHER', status: 'ACTIVE' }, select: { id: true } });
    if (!teacher) throw fieldErrors({ teacherId: 'Choose an active teacher account.' });
    teacherId = teacher.id;
  }
  const semester = await prisma.semester.findUnique({ where: { id: body.semesterId } });
  if (!semester) throw fieldErrors({ semesterId: 'Choose a semester.' });
  const classmatesDefault = await getSetting('privacy.classmatesVisibleDefault');

  const cls = await prisma.$transaction(async (tx) => {
    let courseId = body.courseId;
    if (courseId) {
      const course = await tx.course.findFirst({ where: { id: courseId, isActive: true }, select: { id: true } });
      if (!course) throw fieldErrors({ courseId: 'Choose a course from the list.' });
    } else {
      const code = plainText(body.newCourse.code, 20).toUpperCase().replace(/\s+/g, ' ');
      const title = plainText(body.newCourse.title, 150);
      if (!code || !title) throw fieldErrors({ 'newCourse.code': 'Enter a subject code and title.' });
      const existing = await tx.course.findFirst({ where: { code: { equals: code, mode: 'insensitive' } } });
      courseId = existing ? existing.id : (await tx.course.create({ data: { code, title, units: body.newCourse.units } })).id;
    }

    let sectionId = body.sectionId ?? null;
    if (sectionId) {
      if (!(await tx.section.findUnique({ where: { id: sectionId }, select: { id: true } }))) {
        throw fieldErrors({ sectionId: 'Choose a section from the list.' });
      }
    } else if (body.newSectionName) {
      const name = plainText(body.newSectionName, 60);
      const existing = await tx.section.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
      sectionId = existing ? existing.id : (await tx.section.create({ data: { name } })).id;
    }

    const duplicate = await tx.class.findFirst({
      where: { courseId, sectionId, semesterId: body.semesterId, teacherId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (duplicate) {
      throw conflict('You already have an active class for this course, section and semester.', 'DUPLICATE_CLASS');
    }

    const row = await tx.class.create({
      data: {
        courseId,
        sectionId,
        semesterId: body.semesterId,
        teacherId,
        description: body.description ? plainText(body.description, 2000) : null,
        room: body.room ? plainText(body.room, 60) : null,
        color: body.color ?? CLASS_COLORS[Math.floor(Math.random() * CLASS_COLORS.length)],
        enrollmentCode: await uniqueEnrollmentCode(tx),
        enrollmentRequiresApproval: body.enrollmentRequiresApproval ?? false,
        classmatesVisible: body.classmatesVisible ?? classmatesDefault,
        schedules: { create: body.schedules.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, room: s.room || null })) },
      },
      include: listInclude,
    });
    await createDefaultGradeSetup(tx, row.id);
    await audit(req, { action: 'class.create', entityType: 'Class', entityId: row.id, classId: row.id, summary: `Created class ${row.course.code}` }, tx);
    return row;
  });

  const conflicts = await teacherScheduleConflicts(teacherId, body.semesterId, body.schedules, cls.id);
  created(res, { ...serializeClass(cls, { role: req.user.role, counts: { studentCount: 0, pendingCount: 0 } }), scheduleConflicts: conflicts });
});

// ── Read ──────────────────────────────────────────────────────────────────────
classesRouter.get('/:classId', validate({ params: idParams('classId') }), async (req, res) => {
  const { classId } = req.valid.params;
  const access = await loadClassAccess(req.user, classId);
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: { ...listInclude, teacher: { select: { ...userSelect, email: true, teacherProfile: { select: { consultationHours: true, position: true } } } } },
  });
  const [studentCount, pendingCount] = await Promise.all([
    prisma.enrollment.count({ where: { classId, status: 'ENROLLED' } }),
    access.canManage ? prisma.enrollment.count({ where: { classId, status: 'PENDING' } }) : Promise.resolve(undefined),
  ]);
  ok(res, {
    ...serializeClass(cls, { role: access.role, counts: { studentCount, ...(access.canManage ? { pendingCount } : {}) } }),
    teacher: {
      id: cls.teacher.id,
      name: fullName(cls.teacher),
      email: cls.teacher.email,
      avatarFileId: cls.teacher.avatarFileId,
      position: cls.teacher.teacherProfile?.position ?? null,
      consultationHours: cls.teacher.teacherProfile?.consultationHours ?? null,
    },
    syllabusHtml: cls.syllabusHtml ?? '',
    learningOutcomes: Array.isArray(cls.learningOutcomes) ? cls.learningOutcomes : [],
  });
});

// ── Update ────────────────────────────────────────────────────────────────────
const updateBody = z.object({
  description: z.string().trim().max(2000).nullable().optional(),
  room: z.string().trim().max(60).nullable().optional(),
  color: z.enum(CLASS_COLORS).optional(),
  sectionId: zId.nullable().optional(),
  schedules: z.array(scheduleSchema).max(14).optional(),
  enrollmentCodeEnabled: z.boolean().optional(),
  enrollmentRequiresApproval: z.boolean().optional(),
  classmatesVisible: z.boolean().optional(),
  syllabusHtml: zHtml.optional(),
  learningOutcomes: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  // Administrators may reassign a class to another teacher.
  teacherId: zId.optional(),
});

classesRouter.patch('/:classId', validate({ params: idParams('classId'), body: updateBody }), async (req, res) => {
  const { classId } = req.valid.params;
  const body = req.valid.body;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const data = {};
  if (body.description !== undefined) data.description = body.description ? plainText(body.description, 2000) : null;
  if (body.room !== undefined) data.room = body.room ? plainText(body.room, 60) : null;
  if (body.color !== undefined) data.color = body.color;
  if (body.enrollmentCodeEnabled !== undefined) data.enrollmentCodeEnabled = body.enrollmentCodeEnabled;
  if (body.enrollmentRequiresApproval !== undefined) data.enrollmentRequiresApproval = body.enrollmentRequiresApproval;
  if (body.classmatesVisible !== undefined) data.classmatesVisible = body.classmatesVisible;
  if (body.syllabusHtml !== undefined) data.syllabusHtml = sanitizeRichText(body.syllabusHtml);
  if (body.learningOutcomes !== undefined) data.learningOutcomes = body.learningOutcomes.map((o) => plainText(o, 500)).filter(Boolean);
  if (body.sectionId !== undefined) {
    if (body.sectionId && !(await prisma.section.findUnique({ where: { id: body.sectionId }, select: { id: true } }))) {
      throw fieldErrors({ sectionId: 'Choose a section from the list.' });
    }
    data.sectionId = body.sectionId;
  }
  if (body.teacherId !== undefined && body.teacherId !== cls.teacherId) {
    if (req.user.role !== 'ADMIN') throw forbidden('Only an administrator can reassign a class.');
    const teacher = await prisma.user.findFirst({ where: { id: body.teacherId, role: 'TEACHER', status: 'ACTIVE' }, select: { id: true } });
    if (!teacher) throw fieldErrors({ teacherId: 'Choose an active teacher account.' });
    data.teacherId = teacher.id;
  }
  if (body.schedules) assertNoScheduleOverlap(body.schedules);

  const updated = await prisma.$transaction(async (tx) => {
    if (body.schedules) {
      await tx.classSchedule.deleteMany({ where: { classId } });
      await tx.classSchedule.createMany({
        data: body.schedules.map((s) => ({ classId, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, room: s.room || null })),
      });
    }
    const row = await tx.class.update({ where: { id: classId }, data, include: listInclude });
    await audit(req, {
      action: data.teacherId ? 'class.reassign' : 'class.update',
      entityType: 'Class',
      entityId: classId,
      classId,
      summary: data.teacherId ? 'Class reassigned to another teacher' : 'Class settings updated',
      after: { ...data, syllabusHtml: undefined, schedules: body.schedules },
    }, tx);
    return row;
  });
  const conflicts = body.schedules ? await teacherScheduleConflicts(updated.teacherId, updated.semesterId, body.schedules, classId) : [];
  ok(res, { ...serializeClass(updated, { role: req.user.role }), scheduleConflicts: conflicts });
});

// ── Enrolment code ────────────────────────────────────────────────────────────
classesRouter.post('/:classId/enrollment-code/regenerate', validate({ params: idParams('classId') }), async (req, res) => {
  const { classId } = req.valid.params;
  await requireWritableClassManager(req.user, classId);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.class.update({
      where: { id: classId },
      data: { enrollmentCode: await uniqueEnrollmentCode(tx), enrollmentCodeEnabled: true },
      select: { enrollmentCode: true, enrollmentCodeEnabled: true },
    });
    await audit(req, { action: 'class.code_regenerated', entityType: 'Class', entityId: classId, classId, summary: 'Enrolment code regenerated' }, tx);
    return row;
  });
  ok(res, updated);
});

// ── Archive / restore ─────────────────────────────────────────────────────────
classesRouter.post('/:classId/archive', validate({ params: idParams('classId') }), async (req, res) => {
  const { classId } = req.valid.params;
  const { cls } = await requireClassManager(req.user, classId);
  if (cls.status === 'ARCHIVED') throw conflict('This class is already archived.', 'ALREADY_ARCHIVED');
  await prisma.$transaction(async (tx) => {
    await tx.class.update({ where: { id: classId }, data: { status: 'ARCHIVED', archivedAt: new Date(), enrollmentCodeEnabled: false } });
    // Open attendance sessions cannot stay open in a read-only class.
    await tx.attendanceSession.updateMany({ where: { classId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
    await audit(req, { action: 'class.archive', entityType: 'Class', entityId: classId, classId, summary: 'Class archived' }, tx);
  });
  ok(res, { status: 'ARCHIVED' });
});

classesRouter.post('/:classId/restore', validate({ params: idParams('classId') }), async (req, res) => {
  const { classId } = req.valid.params;
  const { cls } = await requireClassManager(req.user, classId);
  if (cls.status !== 'ARCHIVED') throw conflict('This class is not archived.', 'NOT_ARCHIVED');
  await prisma.$transaction(async (tx) => {
    await tx.class.update({ where: { id: classId }, data: { status: 'ACTIVE', archivedAt: null } });
    await audit(req, { action: 'class.restore', entityType: 'Class', entityId: classId, classId, summary: 'Class restored from the archive' }, tx);
  });
  ok(res, { status: 'ACTIVE' });
});

// ── Delete (only a class that never had students or records) ────────────────
classesRouter.delete('/:classId', validate({ params: idParams('classId') }), async (req, res) => {
  const { classId } = req.valid.params;
  await requireClassManager(req.user, classId);
  const counts = await prisma.class.findUnique({
    where: { id: classId },
    select: {
      _count: {
        select: {
          enrollments: true, attendanceSessions: true, modules: true, assignments: true, quizzes: true,
          announcements: true, discussionThreads: true, gradeItems: true, resources: true,
        },
      },
    },
  });
  if (!counts) throw notFound('Class');
  const used = Object.values(counts._count).some((n) => n > 0);
  if (used) {
    throw conflict('This class already has students or content, so it cannot be deleted. Archive it instead — archived classes keep all records.', 'CLASS_IN_USE');
  }
  await prisma.$transaction(async (tx) => {
    await tx.gradeCategory.deleteMany({ where: { period: { classId } } });
    await tx.gradingPeriod.deleteMany({ where: { classId } });
    await tx.class.delete({ where: { id: classId } });
    await audit(req, { action: 'class.delete', entityType: 'Class', entityId: classId, summary: 'Empty class deleted' }, tx);
  });
  noContent(res);
});
