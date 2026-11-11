import { beforeAll, describe, expect, it } from 'vitest';
import {
  actor, anonymous, classroom, createClass, createCourse, createSemester, createUser, enroll, loginAs, prepare, prisma, setSetting, clearSetting, uid,
} from '../helpers/index.js';

beforeAll(prepare);

const schedule = [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:30', room: 'Rm 204' }];

describe('creating a class', () => {
  it('lets a teacher create a class with a new course and section and returns its code', async () => {
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    const code = uid('IT').toUpperCase();
    const res = await teacher.post('/api/classes', {
      newCourse: { code, title: 'Web Systems', units: 3 }, newSectionName: uid('BSIT-3'), semesterId: semester.id, schedules: schedule, room: 'Lab 2',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.course.code).toBe(code);
    expect(res.body.data.enrollmentCode).toMatch(/^[A-Z2-9]{7}$/);
    expect(res.body.data.myRole).toBe('TEACHER');
    // A default gradebook structure exists and its category weights total 100 %.
    const periods = await prisma.gradingPeriod.findMany({ where: { classId: res.body.data.id }, include: { categories: true } });
    expect(periods.length).toBeGreaterThan(0);
    for (const p of periods) expect(p.categories.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(100, 5);
    expect(periods.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(100, 5);
    expect(await prisma.auditLog.count({ where: { action: 'class.create', entityId: res.body.data.id } })).toBe(1);
  });

  it('refuses a duplicate class and invalid schedules', async () => {
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    const course = await createCourse();
    const body = { courseId: course.id, semesterId: semester.id, schedules: schedule };
    expect((await teacher.post('/api/classes', body)).status).toBe(201);
    const dup = await teacher.post('/api/classes', body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_CLASS');
    const backwards = await teacher.post('/api/classes', { ...body, courseId: (await createCourse()).id, schedules: [{ dayOfWeek: 2, startTime: '10:00', endTime: '09:00' }] });
    expect(backwards.status).toBe(422);
    const overlapping = await teacher.post('/api/classes', {
      ...body, courseId: (await createCourse()).id,
      schedules: [{ dayOfWeek: 2, startTime: '09:00', endTime: '10:00' }, { dayOfWeek: 2, startTime: '09:30', endTime: '10:30' }],
    });
    expect(overlapping.status).toBe(422);
  });

  it('warns about clashes with the teacher\'s other classes', async () => {
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    await teacher.post('/api/classes', { courseId: (await createCourse()).id, semesterId: semester.id, schedules: schedule });
    const res = await teacher.post('/api/classes', { courseId: (await createCourse()).id, semesterId: semester.id, schedules: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.scheduleConflicts).toHaveLength(1);
  });

  it('is not available to students or anonymous visitors', async () => {
    const student = await actor('STUDENT');
    const semester = await createSemester();
    const course = await createCourse();
    expect((await student.post('/api/classes', { courseId: course.id, semesterId: semester.id, schedules: [] })).status).toBe(403);
    expect((await anonymous().get('/api/classes')).status).toBe(401);
  });

  it('respects the administrator\'s permission switch', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    const off = await admin.put('/api/admin/permissions', { role: 'TEACHER', key: 'class.create', granted: false });
    expect(off.status).toBe(200);
    try {
      const res = await teacher.post('/api/classes', { courseId: (await createCourse()).id, semesterId: semester.id, schedules: [] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await admin.put('/api/admin/permissions', { role: 'TEACHER', key: 'class.create', granted: true });
    }
  });
});

describe('class visibility', () => {
  it('lists only the classes a user belongs to', async () => {
    const a = await classroom(1);
    const b = await classroom(1);
    const listA = await a.teacher.get('/api/classes');
    expect(listA.body.data.map((c) => c.id)).toEqual([a.cls.id]);
    const studentList = await b.students[0].get('/api/classes');
    expect(studentList.body.data.map((c) => c.id)).toEqual([b.cls.id]);
    expect(studentList.body.data[0].enrollmentCode).toBeUndefined();
  });

  it('answers 404 to outsiders so class ids cannot be probed', async () => {
    const { cls } = await classroom(0);
    const otherTeacher = await actor('TEACHER');
    const stranger = await actor('STUDENT');
    for (const who of [otherTeacher, stranger]) {
      expect((await who.get(`/api/classes/${cls.id}`)).status).toBe(404);
      expect((await who.get(`/api/classes/${cls.id}/people`)).status).toBe(404);
    }
    expect((await otherTeacher.patch(`/api/classes/${cls.id}`, { room: 'Hacked' })).status).toBe(404);
    expect((await otherTeacher.post(`/api/classes/${cls.id}/archive`)).status).toBe(404);
  });

  it('never gives the enrolment code to students', async () => {
    const { cls, students } = await classroom(1);
    const res = await students[0].get(`/api/classes/${cls.id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(cls.enrollmentCode);
  });

  it('does not let students change class settings', async () => {
    const { cls, students } = await classroom(1);
    expect((await students[0].patch(`/api/classes/${cls.id}`, { room: 'X' })).status).toBe(403);
    expect((await students[0].post(`/api/classes/${cls.id}/enrollment-code/regenerate`)).status).toBe(403);
  });
});

describe('joining with a class code', () => {
  it('enrols the student immediately, and the student then appears on the roster', async () => {
    const { teacher, cls } = await classroom(0);
    const student = await actor('STUDENT');
    const res = await student.post('/api/enrollments/join', { code: ` ${cls.enrollmentCode.toLowerCase().slice(0, 3)}-${cls.enrollmentCode.toLowerCase().slice(3)} ` });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ENROLLED');
    expect((await student.get(`/api/classes/${cls.id}`)).status).toBe(200);
    const roster = await teacher.get(`/api/classes/${cls.id}/people`);
    expect(roster.body.data.students.map((s) => s.id)).toContain(student.user.id);
    // The teacher is told.
    expect(await prisma.notification.count({ where: { userId: teacher.user.id, type: 'enrollment.joined' } })).toBe(1);
    // Joining twice is refused.
    const again = await student.post('/api/enrollments/join', { code: cls.enrollmentCode });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_ENROLLED');
  });

  it('gives one answer for unknown codes, disabled codes and archived classes', async () => {
    const student = await actor('STUDENT');
    const teacher = await actor('TEACHER');
    const disabled = await createClass(teacher.user, { enrollmentCodeEnabled: false });
    const archived = await createClass(teacher.user, { status: 'ARCHIVED', archivedAt: new Date() });
    const answers = [];
    for (const code of ['ZZZZZZZ', disabled.enrollmentCode, archived.enrollmentCode]) {
      const res = await student.post('/api/enrollments/join', { code });
      expect(res.status).toBe(404);
      answers.push(res.body.error);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it('is only for students', async () => {
    const { cls } = await classroom(0);
    const teacher = await actor('TEACHER');
    expect((await teacher.post('/api/enrollments/join', { code: cls.enrollmentCode })).status).toBe(403);
  });

  it('stops working for the old code after the teacher regenerates it', async () => {
    const { teacher, cls } = await classroom(0);
    const res = await teacher.post(`/api/classes/${cls.id}/enrollment-code/regenerate`);
    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentCode).not.toBe(cls.enrollmentCode);
    const student = await actor('STUDENT');
    expect((await student.post('/api/enrollments/join', { code: cls.enrollmentCode })).status).toBe(404);
    expect((await student.post('/api/enrollments/join', { code: res.body.data.enrollmentCode })).status).toBe(201);
  });
});

describe('enrolment requests', () => {
  it('waits for the teacher: approve grants access, reject does not', async () => {
    const { teacher, cls } = await classroom(0, { enrollmentRequiresApproval: true });
    const approved = await actor('STUDENT');
    const rejected = await actor('STUDENT');
    for (const s of [approved, rejected]) {
      const res = await s.post('/api/enrollments/join', { code: cls.enrollmentCode });
      expect(res.body.data.status).toBe('PENDING');
      expect((await s.get(`/api/classes/${cls.id}`)).status).toBe(404); // no access while pending
    }
    const pendingAgain = await approved.post('/api/enrollments/join', { code: cls.enrollmentCode });
    expect(pendingAgain.body.error.code).toBe('REQUEST_PENDING');

    const people = await teacher.get(`/api/classes/${cls.id}/people`);
    const idOf = (user) => people.body.data.students.find((s) => s.id === user.id).enrollmentId;
    expect(people.body.data.students.every((s) => s.status === 'PENDING')).toBe(true);

    // Another teacher cannot decide these requests.
    const outsider = await actor('TEACHER');
    expect((await outsider.post(`/api/classes/${cls.id}/people/${idOf(approved.user)}/approve`)).status).toBe(404);

    expect((await teacher.post(`/api/classes/${cls.id}/people/${idOf(approved.user)}/approve`)).status).toBe(200);
    expect((await teacher.post(`/api/classes/${cls.id}/people/${idOf(rejected.user)}/reject`, { note: 'Not on the official list' })).status).toBe(200);
    expect((await approved.get(`/api/classes/${cls.id}`)).status).toBe(200);
    expect((await rejected.get(`/api/classes/${cls.id}`)).status).toBe(404);

    const mine = await rejected.get('/api/enrollments/mine');
    expect(mine.body.data.enrollments[0]).toMatchObject({ status: 'REJECTED', note: 'Not on the official list' });
    expect(await prisma.notification.count({ where: { userId: approved.user.id, type: 'enrollment.approved' } })).toBe(1);
    // A decision cannot be made twice.
    expect((await teacher.post(`/api/classes/${cls.id}/people/${idOf(approved.user)}/approve`)).status).toBe(409);
  });

  it('removes access when a student is dropped and restores it on reinstatement', async () => {
    const { teacher, cls, students } = await classroom(1);
    const people = await teacher.get(`/api/classes/${cls.id}/people`);
    const enrollmentId = people.body.data.students[0].enrollmentId;
    expect((await teacher.post(`/api/classes/${cls.id}/people/${enrollmentId}/drop`, { note: 'Officially dropped' })).status).toBe(200);
    expect((await students[0].get(`/api/classes/${cls.id}`)).status).toBe(404);
    expect((await teacher.post(`/api/classes/${cls.id}/people/${enrollmentId}/reinstate`)).status).toBe(200);
    expect((await students[0].get(`/api/classes/${cls.id}`)).status).toBe(200);
  });
});

describe('bulk enrolment and invitations', () => {
  it('enrols existing students, invites unknown addresses and reports bad ones', async () => {
    const { teacher, cls } = await classroom(0);
    const existing = await createUser('STUDENT');
    const notAStudent = await createUser('TEACHER');
    const newcomer = `${uid('new')}@test.edu`;
    const res = await teacher.post(`/api/classes/${cls.id}/people/bulk`, {
      emails: [existing.email.toUpperCase(), existing.email, newcomer, 'not-an-email', notAStudent.email, ''],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.enrolled.map((e) => e.email)).toEqual([existing.email]);
    expect(res.body.data.invited.map((e) => e.email)).toEqual([newcomer]);
    expect(res.body.data.invalid.map((e) => e.email).sort()).toEqual([notAStudent.email, 'not-an-email'].sort());

    // Repeating the same request changes nothing.
    const again = await teacher.post(`/api/classes/${cls.id}/people/bulk`, { emails: [existing.email, newcomer] });
    expect(again.body.data.enrolled).toHaveLength(0);
    expect(again.body.data.alreadyEnrolled).toHaveLength(1);
    expect(again.body.data.alreadyInvited).toHaveLength(1);
    expect(await prisma.enrollment.count({ where: { classId: cls.id } })).toBe(1);
  });

  it('lets an invited person accept after registering, but nobody else', async () => {
    const { teacher, cls } = await classroom(0);
    const email = `${uid('inv')}@test.edu`;
    await teacher.post(`/api/classes/${cls.id}/people/bulk`, { emails: [email] });
    const invited = await loginAs(await createUser('STUDENT', { email }));
    const other = await actor('STUDENT');

    const mine = await invited.get('/api/enrollments/mine');
    expect(mine.body.data.invitations).toHaveLength(1);
    const invitationId = mine.body.data.invitations[0].id;
    expect((await other.get('/api/enrollments/mine')).body.data.invitations).toHaveLength(0);
    expect((await other.post(`/api/enrollments/invitations/${invitationId}/accept`)).status).toBe(404);

    expect((await invited.post(`/api/enrollments/invitations/${invitationId}/accept`)).status).toBe(200);
    expect((await invited.get(`/api/classes/${cls.id}`)).status).toBe(200);
    expect((await invited.post(`/api/enrollments/invitations/${invitationId}/accept`)).status).toBe(409);
  });
});

describe('roster privacy', () => {
  it('shows classmates by name only, and hides them when the class says so', async () => {
    const { teacher, cls, students } = await classroom(2);
    const visible = await students[0].get(`/api/classes/${cls.id}/people`);
    expect(visible.body.data.students).toHaveLength(2);
    expect(JSON.stringify(visible.body.data.students)).not.toContain('@test.edu');
    expect(visible.body.data.students[0].studentNumber).toBeUndefined();
    expect(visible.body.data.teacher.email).toBe(teacher.user.email);

    expect((await teacher.patch(`/api/classes/${cls.id}`, { classmatesVisible: false })).status).toBe(200);
    const hidden = await students[0].get(`/api/classes/${cls.id}/people`);
    expect(hidden.body.data.students).toHaveLength(0);
  });

  it('honours the institution-wide permission', async () => {
    const admin = await actor('ADMIN');
    const { cls, students } = await classroom(2);
    await admin.put('/api/admin/permissions', { role: 'STUDENT', key: 'class.view_classmates', granted: false });
    try {
      expect((await students[0].get(`/api/classes/${cls.id}/people`)).body.data.students).toHaveLength(0);
    } finally {
      await admin.put('/api/admin/permissions', { role: 'STUDENT', key: 'class.view_classmates', granted: true });
    }
  });
});

describe('archiving', () => {
  it('makes the class read-only, and restoring makes it editable again', async () => {
    const { teacher, cls, students } = await classroom(1);
    expect((await teacher.post(`/api/classes/${cls.id}/archive`)).status).toBe(200);
    // Still readable by its members …
    expect((await students[0].get(`/api/classes/${cls.id}`)).body.data.status).toBe('ARCHIVED');
    // … but not writable, and hidden from the default list.
    const edit = await teacher.patch(`/api/classes/${cls.id}`, { room: 'New room' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('CLASS_ARCHIVED');
    expect((await teacher.get('/api/classes')).body.data).toHaveLength(0);
    expect((await teacher.get('/api/classes?status=ARCHIVED')).body.data).toHaveLength(1);

    expect((await teacher.post(`/api/classes/${cls.id}/restore`)).status).toBe(200);
    expect((await teacher.patch(`/api/classes/${cls.id}`, { room: 'New room' })).status).toBe(200);
  });

  it('only deletes classes that have no students or content', async () => {
    const { teacher, cls } = await classroom(1);
    expect((await teacher.delete(`/api/classes/${cls.id}`)).status).toBe(409);
    const empty = await createClass(teacher.user);
    expect((await teacher.delete(`/api/classes/${empty.id}`)).status).toBe(204);
    expect(await prisma.class.findUnique({ where: { id: empty.id } })).toBeNull();
  });
});

describe('administrator enrolment tools', () => {
  it('creates a class for a teacher, enrols and transfers a student atomically', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    const made = await admin.post('/api/classes', { courseId: (await createCourse()).id, semesterId: semester.id, teacherId: teacher.user.id, schedules: [] });
    expect(made.status).toBe(201);
    expect(made.body.data.teacher.id).toBe(teacher.user.id);
    const missingTeacher = await admin.post('/api/classes', { courseId: (await createCourse()).id, semesterId: semester.id, schedules: [] });
    expect(missingTeacher.status).toBe(422);

    const from = made.body.data.id;
    const to = (await createClass(teacher.user)).id;
    const student = await actor('STUDENT');
    expect((await admin.post('/api/admin/enrollments', { classId: from, studentId: student.user.id })).status).toBe(200);
    expect((await admin.post('/api/admin/enrollments', { classId: from, studentId: student.user.id })).status).toBe(409);

    const transfer = await admin.post('/api/admin/enrollments/transfer', { studentId: student.user.id, fromClassId: from, toClassId: to, note: 'Schedule conflict' });
    expect(transfer.status).toBe(200);
    expect((await student.get(`/api/classes/${from}`)).status).toBe(404);
    expect((await student.get(`/api/classes/${to}`)).status).toBe(200);
    const rows = await prisma.enrollment.findMany({ where: { studentId: student.user.id } });
    expect(rows.find((r) => r.classId === from).status).toBe('DROPPED');
    expect(rows.find((r) => r.classId === to).status).toBe('ENROLLED');

    // Not available to teachers.
    expect((await teacher.post('/api/admin/enrollments', { classId: to, studentId: student.user.id })).status).toBe(403);
  });

  it('rolls the whole transfer back when the destination is invalid', async () => {
    const admin = await actor('ADMIN');
    const { cls, students } = await classroom(1);
    const res = await admin.post('/api/admin/enrollments/transfer', { studentId: students[0].user.id, fromClassId: cls.id, toClassId: 'doesnotexist' });
    expect(res.status).toBe(422);
    expect((await students[0].get(`/api/classes/${cls.id}`)).status).toBe(200);
  });
});
