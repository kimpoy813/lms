import { beforeAll, describe, expect, it } from 'vitest';
import {
  actor, anonymous, classroom, createClass, createCourse, createSemester, createUser, defaultScale, loginAs, prepare, prisma, uid,
} from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const schedule = [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:30', room: 'Rm 204' }];

describe('creating a class', () => {
  it('lets a teacher create a class with a new course and section and returns its code', async () => {
    const teacher = await actor('TEACHER');
    const semester = await createSemester();
    const code = uid('IT').toUpperCase();
    const res = await teacher.post('/api/classes', {
      newCourse: { code, title: 'Web Systems', units: 4.25 }, newSectionName: uid('BSIT-3'), semesterId: semester.id, schedules: schedule, room: 'Lab 2',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.course.code).toBe(code);
    expect(res.body.data.course.units).toBe(4.25);
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

  it('keeps a dropped student on the teacher roster, gradebook, work, and attendance until removed', async () => {
    const admin = await actor('ADMIN');
    const { teacher, cls, students } = await classroom(2);
    const [s0, s1] = students;
    const peopleBefore = await teacher.get(`/api/classes/${cls.id}/people`);
    const enroll0 = peopleBefore.body.data.students.find((s) => s.id === s0.user.id).enrollmentId;

    // Set up a simple gradebook, assignment submission, quiz attempt, and attendance record.
    const structureRes = await teacher.put(`/api/classes/${cls.id}/gradebook/structure`, {
      periods: [
        {
          name: 'Midterm',
          weight: 50,
          categories: [{ name: 'Quizzes', kind: 'QUIZ', weight: 100 }],
        },
        {
          name: 'Final',
          weight: 50,
          categories: [{ name: 'Exam', kind: 'EXAM', weight: 100 }],
        },
      ],
    });
    expect(structureRes.status).toBe(200);
    const [midterm, finals] = structureRes.body.data.structure.periods;
    const itemMid = (await teacher.post(`/api/classes/${cls.id}/gradebook/items`, {
      categoryId: midterm.categories[0].id,
      title: 'Recitation 1',
      maxPoints: 100,
    })).body.data;
    const itemFin = (await teacher.post(`/api/classes/${cls.id}/gradebook/items`, {
      categoryId: finals.categories[0].id,
      title: 'Final Paper',
      maxPoints: 100,
    })).body.data;
    await teacher.put(`/api/classes/${cls.id}/gradebook/entries`, {
      entries: [
        { itemId: itemMid.id, studentId: s0.user.id, status: 'GRADED', score: 88 },
        { itemId: itemMid.id, studentId: s1.user.id, status: 'GRADED', score: 94 },
        { itemId: itemFin.id, studentId: s1.user.id, status: 'GRADED', score: 92 },
      ],
    });

    const assignment = (await teacher.post(`/api/classes/${cls.id}/assignments`, {
      title: 'Homework 1',
      points: 20,
      status: 'PUBLISHED',
      submissionType: 'TEXT',
    })).body.data;
    expect((await s0.put(`/api/assignments/${assignment.id}/submission`, { textContent: 'My homework', submit: true })).status).toBe(200);

    const createdQuiz = await teacher.post(`/api/classes/${cls.id}/quizzes`, {
      title: 'Short Quiz',
      resultVisibility: 'IMMEDIATE',
      answerVisibility: 'RESPONSES',
    });
    expect(createdQuiz.status).toBe(201);
    const quizId = createdQuiz.body.data.id;
    expect((await teacher.post(`/api/quizzes/${quizId}/questions`, {
      question: { type: 'MULTIPLE_CHOICE', text: '<p>1+1?</p>', points: 1, choices: [{ text: '2', isCorrect: true }, { text: '3', isCorrect: false }] },
    })).status).toBe(201);
    const quiz = (await teacher.patch(`/api/quizzes/${quizId}`, { status: 'PUBLISHED' })).body.data;
    const startRes = await s0.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true });
    expect([200, 201]).toContain(startRes.status);
    await s0.post(`/api/attempts/${startRes.body.data.attemptId}/submit`, {});

    const day = new Date(Date.UTC(2026, 9, 10));
    const session = await prisma.attendanceSession.create({
      data: { classId: cls.id, teacherId: teacher.user.id, date: day, startTime: day, endTime: new Date(day.getTime() + 3_600_000), status: 'CLOSED' },
    });
    await prisma.attendanceRecord.create({
      data: { sessionId: session.id, studentId: s0.user.id, status: 'PRESENT', verificationMethod: 'MANUAL' },
    });

    // Drop s0: active access ends, but teacher keeps s0 on roster, gradebook, assignments, quizzes, and attendance.
    const dropRes = await teacher.post(`/api/classes/${cls.id}/people/${enroll0}/drop`, { note: 'Needs final grade later' });
    expect(dropRes.status).toBe(200);
    expect((await s0.get(`/api/classes/${cls.id}`)).status).toBe(404);
    expect((await s0.post('/api/enrollments/join', { code: cls.enrollmentCode })).body.error.code).toBe('ENROLLED_DROPPED');

    const peopleAfterDrop = (await teacher.get(`/api/classes/${cls.id}/people`)).body.data.students;
    expect(peopleAfterDrop.find((s) => s.id === s0.user.id)).toMatchObject({ status: 'DROPPED', note: 'Needs final grade later' });

    const gb = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    expect(gb.stats.students).toBe(1);
    expect(gb.stats.dropped).toBe(1);
    const s0Row = gb.students.find((s) => s.id === s0.user.id);
    expect(s0Row).toMatchObject({ enrollmentStatus: 'DROPPED', overall: { percent: 88 } });

    // Teacher can still inspect & update a dropped student's grade and export CSV with Status column.
    expect((await teacher.get(`/api/classes/${cls.id}/gradebook/students/${s0.user.id}`)).body.data.student.enrollmentStatus).toBe('DROPPED');
    expect((await teacher.put(`/api/classes/${cls.id}/gradebook/entries`, {
      entries: [{ itemId: itemMid.id, studentId: s0.user.id, status: 'GRADED', score: 90 }],
    })).status).toBe(200);

    const csv = await teacher.get(`/api/classes/${cls.id}/gradebook/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Status');
    expect(csv.text).toContain('Dropped');

    // Assignment submission, quiz results, and attendance summary still include the dropped student.
    const subRoster = (await teacher.get(`/api/assignments/${assignment.id}/submissions`)).body.data.students;
    expect(subRoster.find((r) => r.student.id === s0.user.id).student.enrollmentStatus).toBe('DROPPED');
    expect((await teacher.put(`/api/assignments/${assignment.id}/submissions/${s0.user.id}/grade`, { score: 18 })).status).toBe(200);

    const quizRows = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data.students;
    expect(quizRows.find((r) => r.student.id === s0.user.id)).toMatchObject({ status: 'GRADED', student: { enrollmentStatus: 'DROPPED' } });

    const attSummary = (await teacher.get(`/api/classes/${cls.id}/attendance/summary`)).body.data.students;
    expect(attSummary.find((r) => r.id === s0.user.id)).toMatchObject({ enrollmentStatus: 'DROPPED', present: 1 });

    // Dropped students are excluded from active rankings & analytics, and admin tools see droppedClasses & academic record.
    const ranking = (await teacher.get(`/api/classes/${cls.id}/gradebook/ranking`)).body.data;
    expect(ranking.namedEntries.map((e) => e.studentId)).toEqual([s1.user.id]);
    const analytics = (await teacher.get(`/api/classes/${cls.id}/analytics`)).body.data;
    expect(analytics.summary.students).toBe(1);
    const adminStudents = (await admin.get(`/api/admin/students?search=${encodeURIComponent(s0.user.email)}`)).body.data;
    expect(adminStudents[0].droppedClasses).toHaveLength(1);
    const adminRec = (await admin.get(`/api/grades/students/${s0.user.id}`)).body.data;
    expect(adminRec.classes.find((c) => c.classId === cls.id)).toMatchObject({ enrollmentStatus: 'DROPPED' });
    expect((await s0.get('/api/grades/mine')).body.data).toHaveLength(0);

    // Finalizing succeeds without treating dropped student's incomplete future period as blocking, and stores FinalGrade for s0 too.
    expect((await teacher.post(`/api/classes/${cls.id}/gradebook/finalize`, {})).status).toBe(200);
    expect(await prisma.finalGrade.count({ where: { classId: cls.id, studentId: s0.user.id, scope: 'OVERALL' } })).toBe(1);

    // Removing while finalized is blocked until reopened.
    const blockedRemove = await teacher.post(`/api/classes/${cls.id}/people/${enroll0}/remove`, { note: 'Remove attempt' });
    expect(blockedRemove.status).toBe(409);
    expect(blockedRemove.body.error.code).toBe('GRADES_FINALIZED');

    expect((await teacher.post(`/api/classes/${cls.id}/gradebook/reopen`, { reason: 'Need to remove withdrawn student' })).status).toBe(200);

    // Also enroll s0 in another class to ensure removing from cls does NOT touch other classes.
    const otherClass = await createClass(teacher.user);
    await admin.post('/api/admin/enrollments', { classId: otherClass.id, studentId: s0.user.id });

    // Remove s0 completely from cls.
    const removeRes = await teacher.post(`/api/classes/${cls.id}/people/${enroll0}/remove`, { note: 'Enrolled by mistake' });
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.data).toMatchObject({ removed: true, studentId: s0.user.id, previousStatus: 'DROPPED' });

    const peopleAfterRemove = (await teacher.get(`/api/classes/${cls.id}/people`)).body.data.students;
    expect(peopleAfterRemove.some((s) => s.id === s0.user.id)).toBe(false);
    const gbAfterRemove = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    expect(gbAfterRemove.students.some((s) => s.id === s0.user.id)).toBe(false);
    expect(await prisma.gradeEntry.count({ where: { studentId: s0.user.id, gradeItem: { classId: cls.id } } })).toBe(0);
    expect(await prisma.finalGrade.count({ where: { classId: cls.id, studentId: s0.user.id } })).toBe(0);
    expect(await prisma.assignmentSubmission.count({ where: { assignmentId: assignment.id, studentId: s0.user.id } })).toBe(0);
    expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id, studentId: s0.user.id } })).toBe(0);
    expect(await prisma.attendanceRecord.count({ where: { sessionId: session.id, studentId: s0.user.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'enrollment.remove' } })).toBe(1);

    // Other class enrollment remains intact, and student can rejoin cls cleanly if needed later.
    expect((await s0.get(`/api/classes/${otherClass.id}`)).status).toBe(200);
    expect((await s0.post('/api/enrollments/join', { code: cls.enrollmentCode })).status).toBe(201);
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
