// Shared helpers for the API integration tests: an in-process app, authenticated clients and
// small factories that create fixtures straight in the database.
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { hashPassword } from '../../src/lib/password.js';
import { randomCode } from '../../src/lib/tokens.js';
import { createDefaultGradeSetup } from '../../src/modules/gradebook/defaults.js';
import { syncPermissionCatalog } from '../../src/services/permissions.js';
import { invalidateSettings } from '../../src/services/settings.js';
import { ensureStorage } from '../../src/services/storage.js';

export { prisma };
export const app = createApp();
export const PASSWORD = 'Correct-Horse-42';

let counter = 0;
const stamp = `${process.pid}${Date.now().toString(36)}`;
/** A string that is unique across the whole test run. */
export const uid = (prefix = 'x') => `${prefix}${stamp}${(counter += 1)}`;

let passwordHashPromise;
const sharedPasswordHash = () => (passwordHashPromise ??= hashPassword(PASSWORD));

let prepared;
/** One-time preparation each test file performs in beforeAll. */
export function prepare() {
  prepared ??= (async () => {
    await ensureStorage();
    await syncPermissionCatalog();
  })();
  return prepared;
}

export async function createUser(role, overrides = {}) {
  const id = uid(role[0].toLowerCase());
  const { studentNumber, ...rest } = overrides;
  return prisma.user.create({
    data: {
      email: `${id}@test.edu`,
      passwordHash: await sharedPasswordHash(),
      role,
      status: 'ACTIVE',
      firstName: role === 'TEACHER' ? 'Tess' : role === 'ADMIN' ? 'Ada' : 'Sam',
      lastName: id,
      emailVerifiedAt: new Date(),
      ...(role === 'STUDENT' ? { studentProfile: { create: { studentNumber: studentNumber ?? `SN-${id}` } } } : {}),
      ...(role === 'TEACHER' ? { teacherProfile: { create: {} } } : {}),
      ...rest,
    },
  });
}

/**
 * A signed-in API client. Cookies persist across calls and every state-changing request carries
 * the session's CSRF token, exactly like the web app.
 */
export async function loginAs(user, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  const withCsrf = (req) => req.set('x-csrf-token', csrf);
  return {
    user,
    csrf,
    agent,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url)).send(body ?? {}),
    put: (url, body) => withCsrf(agent.put(url)).send(body ?? {}),
    patch: (url, body) => withCsrf(agent.patch(url)).send(body ?? {}),
    delete: (url, body) => withCsrf(agent.delete(url)).send(body ?? {}),
    /** multipart upload: files = [{ name, content: Buffer | string }] */
    upload: (files, url = '/api/files') => {
      let req = withCsrf(agent.post(url));
      for (const f of files) req = req.attach('files', Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content), f.name);
      return req;
    },
  };
}

export const anonymous = () => request(app);

/** Create a user and sign in. */
export async function actor(role, overrides) {
  const user = await createUser(role, overrides);
  return loginAs(user);
}

export async function createSemester() {
  const year = await prisma.academicYear.create({
    data: { name: uid('AY'), startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31') },
  });
  return prisma.semester.create({
    data: { academicYearId: year.id, name: 'First Semester', startDate: new Date('2026-08-01'), endDate: new Date('2026-12-20') },
  });
}

export async function createCourse(overrides = {}) {
  const code = uid('CS').toUpperCase();
  return prisma.course.create({ data: { code, title: `Course ${code}`, units: 3, ...overrides } });
}

/** A class owned by `teacher`, created directly in the database (with the default gradebook). */
export async function createClass(teacher, overrides = {}) {
  const semester = overrides.semesterId ? null : await createSemester();
  const course = overrides.courseId ? null : await createCourse();
  return prisma.$transaction(async (tx) => {
    const cls = await tx.class.create({
      data: {
        courseId: overrides.courseId ?? course.id,
        semesterId: overrides.semesterId ?? semester.id,
        teacherId: teacher.id,
        enrollmentCode: randomCode(7),
        ...Object.fromEntries(Object.entries(overrides).filter(([k]) => !['courseId', 'semesterId'].includes(k))),
      },
      include: { course: true },
    });
    await createDefaultGradeSetup(tx, cls.id);
    return cls;
  });
}

export async function enroll(cls, student, status = 'ENROLLED') {
  return prisma.enrollment.create({
    data: { classId: cls.id, studentId: student.id, status, source: 'ADMIN', enrolledAt: status === 'ENROLLED' ? new Date() : null },
  });
}

/** A teacher with a class and `n` enrolled students, all signed in. */
export async function classroom(n = 2, classOverrides = {}) {
  const teacher = await actor('TEACHER');
  const cls = await createClass(teacher.user, classOverrides);
  const students = [];
  for (let i = 0; i < n; i += 1) {
    const student = await actor('STUDENT');
    await enroll(cls, student.user);
    students.push(student);
  }
  return { teacher, cls, students };
}

export async function setSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettings();
}

export async function clearSetting(key) {
  await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateSettings();
}

/** Id of the first grade category of a class whose kind matches. */
export async function categoryId(classId, kind = 'ASSIGNMENT') {
  const category = await prisma.gradeCategory.findFirst({ where: { kind, period: { classId } }, orderBy: [{ period: { position: 'asc' } }, { position: 'asc' }] });
  return category.id;
}

/** The institution's default grading scale (a 1.00–5.00 scale), created on first use. */
export async function defaultScale() {
  const existing = await prisma.gradingScale.findFirst({ where: { isDefault: true }, include: { entries: true } });
  if (existing) return existing;
  const bands = [[97, '1.00', 'Excellent'], [94, '1.25', 'Very Good'], [91, '1.50', 'Very Good'], [88, '1.75', 'Good'], [85, '2.00', 'Good'], [82, '2.25', 'Satisfactory'], [79, '2.50', 'Satisfactory'], [76, '2.75', 'Fair'], [75, '3.00', 'Passed']];
  try {
    return await prisma.gradingScale.create({
      data: {
        name: 'Test 1.00–5.00', isDefault: true,
        entries: { create: [...bands.map(([minPercent, label, remark]) => ({ minPercent, label, remark, isPassing: true })), { minPercent: 0, label: '5.00', remark: 'Failed', isPassing: false }] },
      },
      include: { entries: true },
    });
  } catch {
    // Another test file created it at the same moment.
    return prisma.gradingScale.findFirst({ where: { isDefault: true }, include: { entries: true } });
  }
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
