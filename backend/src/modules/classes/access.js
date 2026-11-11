// Class-level authorisation. Every class-scoped endpoint starts by calling one of these helpers,
// so "who may see or change this class" is decided in exactly one place.
import { prisma } from '../../db/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';

const classInclude = {
  course: { select: { id: true, code: true, title: true, units: true } },
  section: { select: { id: true, name: true } },
  semester: { select: { id: true, name: true, startDate: true, endDate: true, academicYear: { select: { id: true, name: true } } } },
};

/**
 * Resolve what the user may do in a class.
 *   ADMIN                        → role 'ADMIN',   canManage
 *   the class's teacher          → role 'TEACHER', canManage
 *   a student with an ENROLLED   → role 'STUDENT'
 *   enrolment
 * Anyone else gets a 404 — the response does not reveal whether the class exists.
 */
export async function loadClassAccess(user, classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId }, include: classInclude });
  if (!cls) throw notFound('Class');
  if (user.role === 'ADMIN') {
    return { cls, role: 'ADMIN', canManage: true, isStudent: false, enrollment: null };
  }
  if (user.role === 'TEACHER' && cls.teacherId === user.id) {
    return { cls, role: 'TEACHER', canManage: true, isStudent: false, enrollment: null };
  }
  if (user.role === 'STUDENT') {
    const enrollment = await prisma.enrollment.findUnique({
      where: { classId_studentId: { classId, studentId: user.id } },
    });
    if (enrollment?.status === 'ENROLLED') {
      return { cls, role: 'STUDENT', canManage: false, isStudent: true, enrollment };
    }
  }
  throw notFound('Class');
}

/** The class teacher or an administrator. */
export async function requireClassManager(user, classId) {
  const access = await loadClassAccess(user, classId);
  if (!access.canManage) throw forbidden('Only the class teacher can do that.');
  return access;
}

/** A currently enrolled student. */
export async function requireClassStudent(user, classId) {
  const access = await loadClassAccess(user, classId);
  if (!access.isStudent) throw forbidden('Only students enrolled in this class can do that.');
  return access;
}

/** Archived classes are read-only. */
export function assertClassWritable(cls) {
  if (cls.status === 'ARCHIVED') {
    throw conflict('This class is archived and read-only. Restore it to make changes.', 'CLASS_ARCHIVED');
  }
}

/** Manager access to a class that is not archived — the usual guard for teacher write actions. */
export async function requireWritableClassManager(user, classId) {
  const access = await requireClassManager(user, classId);
  assertClassWritable(access.cls);
  return access;
}

/** Ids of the classes a user belongs to (taught or enrolled in). */
export async function classIdsFor(user, { includeArchived = true } = {}) {
  const statusFilter = includeArchived ? {} : { status: 'ACTIVE' };
  if (user.role === 'TEACHER') {
    const rows = await prisma.class.findMany({ where: { teacherId: user.id, ...statusFilter }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (user.role === 'STUDENT') {
    const rows = await prisma.enrollment.findMany({
      where: { studentId: user.id, status: 'ENROLLED', class: statusFilter },
      select: { classId: true },
    });
    return rows.map((r) => r.classId);
  }
  const rows = await prisma.class.findMany({ where: statusFilter, select: { id: true } });
  return rows.map((r) => r.id);
}

export const classLabel = (cls) =>
  cls ? `${cls.course.code}${cls.section ? ` · ${cls.section.name}` : ''}` : '';
