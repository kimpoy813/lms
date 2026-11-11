import { beforeAll, describe, expect, it } from 'vitest';
import { actor, anonymous, categoryId, classroom, createUser, defaultScale, loginAs, minutesFromNow, prepare, prisma } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const iso = (minutes) => minutesFromNow(minutes).toISOString();

async function seedWork(teacher, cls) {
  const due = await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Essay due soon', instructionsHtml: '<p>Write.</p>', points: 20, dueAt: iso(60 * 24), status: 'PUBLISHED', categoryId: await categoryId(cls.id, 'ASSIGNMENT') });
  const overdue = await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Overdue lab', instructionsHtml: '<p>Lab.</p>', points: 10, dueAt: iso(60), status: 'PUBLISHED' });
  expect([due.status, overdue.status]).toEqual([201, 201]);
  await prisma.assignment.update({ where: { id: overdue.body.data.id }, data: { dueAt: minutesFromNow(-60) } });
  return { due: due.body.data, overdue: overdue.body.data };
}

describe('student dashboard', () => {
  it('lists what is due, what is missing and where a check-in is open', async () => {
    const { teacher, cls, students } = await classroom(2);
    const { due, overdue } = await seedWork(teacher, cls);
    const session = await teacher.post(`/api/classes/${cls.id}/attendance/sessions`, { title: 'Today', allowCode: true });
    expect(session.status).toBe(201);
    await teacher.post('/api/announcements', { classId: cls.id, title: 'Welcome', contentHtml: '<p>Hello class</p>' });

    const res = await students[0].get('/api/dashboard');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.role).toBe('STUDENT');
    expect(d.stats).toMatchObject({ classes: 1, dueThisWeek: 1, missing: 1 });
    expect(d.todo.map((t) => t.id)).toEqual([due.id]);
    expect(d.missing.map((t) => t.id)).toEqual([overdue.id]);
    expect(d.checkIns).toHaveLength(1);
    expect(d.checkIns[0]).toMatchObject({ classId: cls.id, recorded: null });
    expect(d.announcements[0].title).toBe('Welcome');
    expect(d.classes[0]).toMatchObject({ id: cls.id, openWork: 2 }); // one due soon + one overdue that still accepts late work
    // Nothing that would let a student check in without the teacher's code.
    expect(JSON.stringify(d)).not.toMatch(/qrSecret|"code"|latitude/);

    // Handing the work in clears it from the list.
    expect((await students[0].put(`/api/assignments/${due.id}/submission`, { textContent: '<p>Done</p>', submit: true })).status).toBe(200);
    const after = (await students[0].get('/api/dashboard')).body.data;
    expect(after.todo).toHaveLength(0);
    expect(after.stats.dueThisWeek).toBe(0);
  });

  it('shows returned scores only', async () => {
    const { teacher, cls, students } = await classroom(1);
    const { due } = await seedWork(teacher, cls);
    await students[0].put(`/api/assignments/${due.id}/submission`, { textContent: '<p>Mine</p>', submit: true });
    await teacher.put(`/api/assignments/${due.id}/submissions/${students[0].user.id}/grade`, { score: 17, feedback: 'Good' });
    expect((await students[0].get('/api/dashboard')).body.data.recentGrades).toHaveLength(0);
    await teacher.post(`/api/assignments/${due.id}/return`, {});
    const grades = (await students[0].get('/api/dashboard')).body.data.recentGrades;
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ title: 'Essay due soon', score: 17, maxScore: 20 });
  });
});

describe('teacher dashboard', () => {
  it('counts work to grade, requests and at-risk students of own classes only', async () => {
    const { teacher, cls, students } = await classroom(3);
    const other = await classroom(1);
    const { due } = await seedWork(teacher, cls);
    await seedWork(other.teacher, other.cls);
    await students[0].put(`/api/assignments/${due.id}/submission`, { textContent: '<p>Mine</p>', submit: true });
    await students[1].put(`/api/assignments/${due.id}/submission`, { textContent: '<p>Mine too</p>', submit: true });
    await teacher.put(`/api/assignments/${due.id}/submissions/${students[1].user.id}/grade`, { score: 4 });
    await teacher.post(`/api/assignments/${due.id}/return`, {});
    const joiner = await loginAs(await createUser('STUDENT'));
    await prisma.class.update({ where: { id: cls.id }, data: { enrollmentRequiresApproval: true } });
    const code = (await prisma.class.findUnique({ where: { id: cls.id } })).enrollmentCode;
    expect((await joiner.post('/api/enrollments/join', { code })).status).toBeLessThan(300);

    const d = (await teacher.get('/api/dashboard')).body.data;
    expect(d.role).toBe('TEACHER');
    expect(d.stats).toMatchObject({ classes: 1, students: 3, toGrade: 1 });
    expect(d.requests.enrollments).toBe(1);
    expect(d.toGrade[0]).toMatchObject({ id: due.id, count: 1 });
    expect(d.upcoming.map((u) => u.id)).toContain(due.id);
    // 4/20 = 20% → low grade; everyone misses the overdue lab but one item is under the threshold of 2.
    const flagged = d.atRisk.find((r) => r.studentId === students[1].user.id);
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(' ')).toMatch(/Running grade 20% is below 75%/);
    expect(d.atRisk.every((r) => r.classId === cls.id)).toBe(true);
    expect(JSON.stringify(d)).not.toContain(other.cls.id);
  });
});

describe('administrator dashboard', () => {
  it('summarises the institution', async () => {
    const admin = await actor('ADMIN');
    await classroom(2);
    const d = (await admin.get('/api/dashboard')).body.data;
    expect(d.role).toBe('ADMIN');
    expect(d.stats.students).toBeGreaterThanOrEqual(2);
    expect(d.stats.activeClasses).toBeGreaterThanOrEqual(1);
    expect(d.signIns).toHaveLength(14);
    expect(d.signIns.at(-1).users).toBeGreaterThanOrEqual(1);
    expect(d.system).toMatchObject({ aiConfigured: false, codeRunnerConfigured: false, mailConfigured: false });
    expect(d.recentAudit.length).toBeGreaterThan(0);
  });

  it('needs a session', async () => {
    expect((await anonymous().get('/api/dashboard')).status).toBe(401);
  });
});

describe('class analytics', () => {
  it('is for the class teacher, explains each flag and exports a report', async () => {
    const { teacher, cls, students } = await classroom(2);
    const { due } = await seedWork(teacher, cls);
    await students[0].put(`/api/assignments/${due.id}/submission`, { textContent: '<p>Mine</p>', submit: true });
    await teacher.put(`/api/assignments/${due.id}/submissions/${students[0].user.id}/grade`, { score: 19 });
    await teacher.post(`/api/assignments/${due.id}/return`, {});

    expect((await students[0].get(`/api/classes/${cls.id}/analytics`)).status).toBe(403);
    const outsider = await actor('TEACHER');
    expect((await outsider.get(`/api/classes/${cls.id}/analytics`)).status).toBe(404);

    const a = (await teacher.get(`/api/classes/${cls.id}/analytics`)).body.data;
    expect(a.summary).toMatchObject({ students: 2, averageGrade: 95, onTime: 1, late: 0 });
    expect(a.gradeDistribution.find((b) => b.label === '90–100').count).toBe(1);
    expect(a.assessments[0]).toMatchObject({ title: 'Essay due soon', average: 95, graded: 1 });
    const good = a.students.find((s) => s.id === students[0].user.id);
    expect(good.risk.level).toBe('NONE');
    expect(good.missing).toBe(1);

    const csv = await teacher.get(`/api/classes/${cls.id}/analytics/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Indicators');
    const pdf = await teacher.get(`/api/classes/${cls.id}/analytics/export?format=pdf`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
