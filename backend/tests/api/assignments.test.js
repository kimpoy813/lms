import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, createClass, defaultScale, minutesFromNow, prepare, prisma } from '../helpers/index.js';
import { publishScheduled, sendDeadlineReminders } from '../../src/jobs/publishing.js';
import { submissionWindow } from '../../src/modules/assignments/routes.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const iso = (m) => minutesFromNow(m).toISOString();
const create = (teacher, cls, body = {}) => teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Essay 1', instructionsHtml: '<p>Write 500 words.</p>', points: 50, status: 'PUBLISHED', ...body });
const submit = (student, id, body = {}) => student.put(`/api/assignments/${id}/submission`, { textContent: '<p>My answer to the essay.</p>', submit: true, ...body });
const grade = (teacher, id, student, body) => teacher.put(`/api/assignments/${id}/submissions/${student.user.id}/grade`, body);
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

describe('submission window (server clock)', () => {
  const now = new Date('2026-11-11T08:00:00Z');
  const at = (h) => new Date(now.getTime() + h * 3_600_000);
  const base = { availableFrom: null, dueAt: null, closeAt: null, allowLate: true };

  it('follows opening, due and closing times', () => {
    expect(submissionWindow(base, null, now)).toEqual({ open: true, late: false });
    expect(submissionWindow({ ...base, availableFrom: at(1) }, null, now)).toMatchObject({ open: false, code: 'NOT_OPEN' });
    expect(submissionWindow({ ...base, dueAt: at(1) }, null, now)).toEqual({ open: true, late: false });
    expect(submissionWindow({ ...base, dueAt: now }, null, now)).toEqual({ open: true, late: false }); // the due instant itself is on time
    expect(submissionWindow({ ...base, dueAt: at(-1) }, null, now)).toEqual({ open: true, late: true });
    expect(submissionWindow({ ...base, dueAt: at(-1), allowLate: false }, null, now)).toMatchObject({ open: false, code: 'CLOSED' });
    expect(submissionWindow({ ...base, dueAt: at(-2), closeAt: at(-1) }, null, now)).toMatchObject({ open: false, code: 'CLOSED' });
    expect(submissionWindow({ ...base, dueAt: at(-2), closeAt: at(1) }, null, now)).toEqual({ open: true, late: true });
  });

  it('honours a personal extension, but only until it ends', () => {
    const closed = { ...base, dueAt: at(-2), allowLate: false };
    expect(submissionWindow(closed, { reopenedUntil: at(1) }, now)).toEqual({ open: true, late: false, extended: true });
    expect(submissionWindow(closed, { reopenedUntil: at(-1) }, now).open).toBe(false);
  });
});

describe('assignments', () => {
  it('are drafts until published; scheduled ones publish on time and notify once', async () => {
    const { teacher, cls, students } = await classroom(1);
    const draft = await create(teacher, cls, { status: 'DRAFT' });
    expect(draft.status).toBe(201);
    const scheduled = await create(teacher, cls, { title: 'Later', status: 'SCHEDULED', publishAt: iso(60) });
    expect(scheduled.body.data.status).toBe('SCHEDULED');
    expect((await students[0].get(`/api/classes/${cls.id}/assignments`)).body.data).toHaveLength(0);
    expect((await students[0].get(`/api/assignments/${draft.body.data.id}`)).status).toBe(404);
    expect((await submit(students[0], draft.body.data.id)).status).toBe(404);

    await prisma.assignment.update({ where: { id: scheduled.body.data.id }, data: { publishAt: minutesFromNow(-1) } });
    await publishScheduled();
    await publishScheduled();
    expect((await students[0].get(`/api/classes/${cls.id}/assignments`)).body.data.map((a) => a.title)).toEqual(['Later']);
    await teacher.patch(`/api/assignments/${draft.body.data.id}`, { status: 'PUBLISHED' });
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'assignment.published' } })).toBe(2);
  });

  it('validates dates, points and submission types', async () => {
    const { teacher, cls } = await classroom(0);
    const fields = async (body) => (await create(teacher, cls, body)).body.error?.details?.fields ?? {};
    expect(await fields({ availableFrom: iso(60), dueAt: iso(30) })).toHaveProperty('dueAt');
    expect(await fields({ dueAt: iso(60), closeAt: iso(30) })).toHaveProperty('closeAt');
    expect(await fields({ allowText: false, allowFiles: false })).toHaveProperty('allowText');
    expect(await fields({ points: 0 })).toHaveProperty('points');
    expect(await fields({ latePenaltyType: 'PERCENT_PER_DAY', latePenaltyValue: 0 })).toHaveProperty('latePenaltyValue');
    expect(await fields({ status: 'SCHEDULED' })).toHaveProperty('publishAt');
    expect(await fields({ categoryId: 'nope' })).toHaveProperty('categoryId');
    const other = await createClass(teacher.user);
    expect(await fields({ categoryId: await categoryId(other.id) })).toHaveProperty('categoryId');
  });

  it('sanitises instructions and is managed only by the class teacher', async () => {
    const { teacher, cls, students } = await classroom(1);
    const other = await actor('TEACHER');
    const a = await create(teacher, cls, { instructionsHtml: '<p>Read</p><script>steal()</script><a href="javascript:alert(1)">x</a>' });
    expect(a.body.data.instructionsHtml).not.toMatch(/script|javascript:/);
    const id = a.body.data.id;
    for (const [who, code] of [[students[0], 403], [other, 404]]) {
      expect((await who.patch(`/api/assignments/${id}`, { title: 'x' })).status).toBe(code);
      expect((await who.delete(`/api/assignments/${id}`)).status).toBe(code);
      expect((await who.get(`/api/assignments/${id}/submissions`)).status).toBe(code);
      expect((await who.post(`/api/assignments/${id}/return`, {})).status).toBe(code);
      expect((await who.put(`/api/assignments/${id}/submissions/${students[0].user.id}/grade`, { score: 50 })).status).toBe(code);
      expect((await who.get(`/api/assignments/${id}/submissions-archive`)).status).toBe(code);
    }
    expect((await students[0].post(`/api/classes/${cls.id}/assignments`, { title: 'x' })).status).toBe(403);
    expect((await other.get(`/api/assignments/${id}`)).status).toBe(404);
    expect((await teacher.put(`/api/assignments/${id}/submission`, { textContent: 'x', submit: true })).status).toBe(403);
  });
});

describe('submitting work', () => {
  it('saves a draft, submits once, and freezes submitted work', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await create(teacher, cls, { dueAt: iso(60) })).body.data.id;
    const empty = await submit(students[0], id, { textContent: '   ' });
    expect(empty.status).toBe(422);

    const draft = await students[0].put(`/api/assignments/${id}/submission`, { textContent: '<p>Work in progress</p>' });
    expect(draft.body.data).toMatchObject({ myStatus: 'DRAFT', submission: { status: 'DRAFT', submittedAt: null, attemptNumber: 0 } });
    expect((await teacher.get(`/api/assignments/${id}/submissions`)).body.data.students[0]).toMatchObject({ status: 'NOT_SUBMITTED', submittedAt: null });

    const upload = await students[0].upload([{ name: 'essay.pdf', content: '%PDF-1.4 essay' }]);
    const done = await submit(students[0], id, { textContent: '<p>Final <script>x()</script>answer</p>', fileIds: [upload.body.data[0].id] });
    expect(done.status).toBe(200);
    expect(done.body.data.submission).toMatchObject({ status: 'SUBMITTED', isLate: false, attemptNumber: 1, penaltyPercent: 0 });
    expect(done.body.data.submission.textContent).toBe('<p>Final answer</p>');
    expect(done.body.data.submission.files.map((f) => f.name)).toEqual(['essay.pdf']);

    // A "save draft" can no longer change what was handed in.
    const sneaky = await students[0].put(`/api/assignments/${id}/submission`, { textContent: '<p>Changed after the fact</p>' });
    expect(sneaky.status).toBe(409);
    expect(sneaky.body.error.code).toBe('ALREADY_SUBMITTED');
    // Resubmitting replaces it and counts as a new attempt.
    const again = await submit(students[0], id, { textContent: '<p>Second version</p>' });
    expect(again.body.data.submission).toMatchObject({ attemptNumber: 2, textContent: '<p>Second version</p>', files: [] });
    expect(await prisma.assignmentSubmission.count({ where: { assignmentId: id } })).toBe(1);
  });

  it('never creates two submissions for a double click', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await create(teacher, cls)).body.data.id;
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(students[0], id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.assignmentSubmission.count({ where: { assignmentId: id, studentId: students[0].user.id } })).toBe(1);
  });

  it('enforces the opening time, the deadline and the late policy on the server', async () => {
    const { teacher, cls, students } = await classroom(1);
    const notOpen = (await create(teacher, cls, { availableFrom: iso(60), dueAt: iso(120) })).body.data.id;
    const early = await submit(students[0], notOpen);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NOT_OPEN');

    const strict = (await create(teacher, cls, { title: 'Strict', dueAt: iso(60), allowLate: false })).body.data.id;
    await prisma.assignment.update({ where: { id: strict }, data: { dueAt: minutesFromNow(-1) } });
    const closed = await submit(students[0], strict);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('CLOSED');
    expect((await students[0].get(`/api/assignments/${strict}`)).body.data).toMatchObject({ myStatus: 'MISSING', window: { open: false } });

    // Late work accepted with 10 % per day, capped at 30 %: two started days late → 20 %.
    const lenient = (await create(teacher, cls, { title: 'Lenient', dueAt: iso(60), latePenaltyType: 'PERCENT_PER_DAY', latePenaltyValue: 10, latePenaltyMax: 30 })).body.data.id;
    await prisma.assignment.update({ where: { id: lenient }, data: { dueAt: minutesFromNow(-(24 * 60 + 5)) } });
    const late = await submit(students[0], lenient);
    expect(late.status).toBe(200);
    expect(late.body.data.submission).toMatchObject({ isLate: true, penaltyPercent: 20 });
    // … until the hard cut-off.
    await prisma.assignment.update({ where: { id: lenient }, data: { closeAt: minutesFromNow(-1) } });
    expect((await submit(students[0], lenient)).body.error.code).toBe('CLOSED');
  });

  it('honours the allowed submission types and file limit', async () => {
    const { teacher, cls, students } = await classroom(2);
    const textOnly = (await create(teacher, cls, { allowFiles: false })).body.data.id;
    const filesOnly = (await create(teacher, cls, { title: 'Files', allowText: false, maxFiles: 1 })).body.data.id;
    const files = (await students[0].upload([{ name: 'a.pdf', content: '%PDF-1.4 a' }, { name: 'b.pdf', content: '%PDF-1.4 b' }])).body.data.map((f) => f.id);
    expect((await submit(students[0], textOnly, { fileIds: [files[0]] })).status).toBe(422);
    expect((await submit(students[0], filesOnly, { fileIds: files })).status).toBe(422);
    expect((await submit(students[0], filesOnly, { fileIds: [] })).status).toBe(422);
    expect((await submit(students[0], filesOnly, { fileIds: [files[0]] })).status).toBe(200);
    // Somebody else's upload cannot be attached.
    expect((await submit(students[1], filesOnly, { fileIds: [files[1]] })).status).toBe(400);
  });

  it('keeps each student\'s work private', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await create(teacher, cls)).body.data.id;
    const upload = await students[0].upload([{ name: 'mine.pdf', content: '%PDF-1.4 secret work' }]);
    const fileId = upload.body.data[0].id;
    await submit(students[0], id, { fileIds: [fileId] });

    expect((await students[1].get(`/api/files/${fileId}`)).status).toBe(404);
    expect((await teacher.get(`/api/files/${fileId}`)).status).toBe(200);
    expect((await (await actor('TEACHER')).get(`/api/files/${fileId}`)).status).toBe(404);
    const other = await students[1].get(`/api/assignments/${id}`);
    expect(other.body.data.submission).toBeNull();
    expect(JSON.stringify(other.body)).not.toContain(students[0].user.id);
    expect((await students[1].get(`/api/assignments/${id}/submissions/${students[0].user.id}`)).status).toBe(403);
  });
});

describe('grading and returning', () => {
  it('hides the grade until it is returned, then shows score and feedback', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await create(teacher, cls)).body.data.id;
    await submit(students[0], id);
    expect((await grade(teacher, id, students[0], { score: 51 })).status).toBe(422);
    expect((await grade(teacher, id, students[0], {})).status).toBe(422);
    const graded = await grade(teacher, id, students[0], { score: 42, feedback: '<p>Good structure.</p>' });
    expect(graded.body.data).toMatchObject({ status: 'GRADED', rawScore: 42, finalScore: 42 });

    let mine = (await students[0].get(`/api/assignments/${id}`)).body.data;
    expect(mine).toMatchObject({ myStatus: 'SUBMITTED', submission: { status: 'SUBMITTED', finalScore: null, feedback: null, rawScore: null } });
    expect((await students[0].get(`/api/classes/${cls.id}/assignments`)).body.data[0].score).toBeNull();

    expect((await teacher.post(`/api/assignments/${id}/return`, {})).body.data.returned).toBe(1);
    mine = (await students[0].get(`/api/assignments/${id}`)).body.data;
    expect(mine).toMatchObject({ myStatus: 'RETURNED', submission: { status: 'RETURNED', finalScore: 42, feedback: '<p>Good structure.</p>' } });
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'assignment.returned' } })).toBe(1);
    // Graded work cannot be silently replaced.
    expect((await submit(students[0], id)).body.error.code).toBe('ALREADY_GRADED');
  });

  it('applies the late penalty, lets the teacher waive it, and audits regrades', async () => {
    const { teacher, cls, students } = await classroom(1);
    const id = (await create(teacher, cls, { dueAt: iso(60), latePenaltyType: 'PERCENT_FLAT', latePenaltyValue: 20 })).body.data.id;
    await prisma.assignment.update({ where: { id }, data: { dueAt: minutesFromNow(-10) } });
    await submit(students[0], id);
    const graded = await grade(teacher, id, students[0], { score: 40, return: true });
    expect(graded.body.data).toMatchObject({ rawScore: 40, penaltyPercent: 20, finalScore: 32, isLate: true, status: 'RETURNED' });
    const waived = await grade(teacher, id, students[0], { score: 40, waivePenalty: true });
    expect(waived.body.data).toMatchObject({ penaltyPercent: 0, finalScore: 40, status: 'RETURNED' });
    const actions = (await prisma.auditLog.findMany({ where: { classId: cls.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['submission.regrade', 'submission.penalty.waive']));
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'assignment.returned' } })).toBe(2);
  });

  it('sends scores to the gradebook and removes the column with the assignment', async () => {
    const { teacher, cls, students } = await classroom(2);
    const category = await categoryId(cls.id, 'ASSIGNMENT');
    const made = await create(teacher, cls, { categoryId: category, dueAt: iso(60) });
    expect(made.body.data.gradeCategory).toMatchObject({ id: category, name: 'Assignments', period: 'Midterm' });
    const id = made.body.data.id;
    await submit(students[0], id);
    await grade(teacher, id, students[0], { score: 45 });

    const book = async () => (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    let data = await book();
    const item = data.structure.periods[0].categories.find((c) => c.id === category).items[0];
    expect(item).toMatchObject({ title: 'Essay 1', maxPoints: 50, source: 'ASSIGNMENT', assignmentId: id });
    const row = (d, s) => d.students.find((x) => x.id === s.user.id);
    expect(row(data, students[0]).entries[item.id]).toMatchObject({ score: 45, status: 'GRADED' });
    expect(row(data, students[0]).overall.percent).toBe(90);
    // The teacher cannot type over a linked score in the gradebook, only exempt.
    const direct = await teacher.put(`/api/classes/${cls.id}/gradebook/entries`, { entries: [{ itemId: item.id, studentId: students[0].user.id, status: 'GRADED', score: 50 }] });
    expect(direct.body.error.code).toBe('LINKED_ITEM');

    // Before it is returned the student does not see the score in their grades either.
    const mine = async () => (await students[0].get(`/api/classes/${cls.id}/gradebook/mine`)).body.data.periods[0].categories.find((c) => c.id === category).items[0];
    expect(await mine()).toMatchObject({ score: null, status: 'UNGRADED' });
    await teacher.post(`/api/assignments/${id}/return`, {});
    expect(await mine()).toMatchObject({ score: 45, status: 'GRADED' });

    // After the due date, the student who never submitted is missing (and scored zero by policy).
    await prisma.assignment.update({ where: { id }, data: { dueAt: minutesFromNow(-1) } });
    data = await book();
    expect(row(data, students[1]).entries[item.id]).toMatchObject({ status: 'MISSING', derived: true });
    expect(row(data, students[1]).overall.percent).toBe(0);
    // Exempting, then lifting the exemption, restores the assignment's score.
    const exempt = (status) => teacher.put(`/api/classes/${cls.id}/gradebook/entries`, { entries: [{ itemId: item.id, studentId: students[0].user.id, status }] });
    await exempt('EXEMPT');
    expect(row(await book(), students[0]).overall.percent).toBeNull();
    await exempt('UNGRADED');
    expect(row(await book(), students[0]).entries[item.id]).toMatchObject({ score: 45, status: 'GRADED' });

    // A locked period blocks regrading.
    const periodId = data.structure.periods[0].id;
    await teacher.post(`/api/classes/${cls.id}/gradebook/periods/${periodId}/lock`, {});
    expect((await grade(teacher, id, students[0], { score: 10 })).body.error.code).toBe('PERIOD_LOCKED');
    expect((await teacher.delete(`/api/assignments/${id}`)).body.error.code).toBe('PERIOD_LOCKED');
    await teacher.post(`/api/classes/${cls.id}/gradebook/periods/${periodId}/unlock`, { note: 'Remove a duplicate assignment' });
    expect((await teacher.delete(`/api/assignments/${id}`)).status).toBe(204);
    expect((await book()).structure.periods[0].categories.find((c) => c.id === category).items).toHaveLength(0);
    expect((await students[0].get(`/api/assignments/${id}`)).status).toBe(404);
  });

  it('grades with a rubric', async () => {
    const { teacher, cls, students } = await classroom(1);
    const rubric = await teacher.post('/api/rubrics', {
      title: 'Essay rubric',
      criteria: [
        { title: 'Content', maxPoints: 20, levels: [{ title: 'Excellent', points: 20 }, { title: 'Fair', points: 10 }] },
        { title: 'Grammar', maxPoints: 10 },
      ],
    });
    expect(rubric.status).toBe(201);
    expect(rubric.body.data.totalPoints).toBe(30);
    expect((await teacher.post('/api/rubrics', { title: 'Bad', criteria: [{ title: 'X', maxPoints: 5, levels: [{ title: 'Too much', points: 6 }] }] })).status).toBe(422);
    const [content, grammar] = rubric.body.data.criteria;

    const a = await create(teacher, cls, { rubricId: rubric.body.data.id, points: 100 });
    expect(a.body.data.points).toBe(30); // an assignment is worth what its rubric is worth
    const id = a.body.data.id;
    await submit(students[0], id);
    expect((await grade(teacher, id, students[0], { rubricScores: { [content.id]: { points: 21 }, [grammar.id]: { points: 5 } } })).status).toBe(422);
    expect((await grade(teacher, id, students[0], { rubricScores: { [content.id]: { points: 18 } } })).status).toBe(422);
    const done = await grade(teacher, id, students[0], { rubricScores: { [content.id]: { points: 18, comment: 'Clear thesis' }, [grammar.id]: { points: 7 } }, return: true });
    expect(done.body.data).toMatchObject({ rawScore: 25, finalScore: 25 });
    const mine = (await students[0].get(`/api/assignments/${id}`)).body.data;
    expect(mine.rubric.criteria.map((c) => c.title)).toEqual(['Content', 'Grammar']);
    expect(mine.submission.rubricScores[content.id]).toEqual({ points: 18, comment: 'Clear thesis' });

    // A rubric that has been used for grading keeps its criteria; another teacher cannot use it.
    const edit = await teacher.put(`/api/rubrics/${rubric.body.data.id}`, { title: 'Essay rubric', criteria: [{ title: 'Content', maxPoints: 30 }] });
    expect(edit.body.error.code).toBe('RUBRIC_IN_USE');
    expect((await teacher.delete(`/api/rubrics/${rubric.body.data.id}`)).status).toBe(409);
    expect((await teacher.post(`/api/rubrics/${rubric.body.data.id}/copy`)).body.data.title).toBe('Essay rubric (copy)');
    const stranger = await actor('TEACHER');
    expect((await stranger.get(`/api/rubrics/${rubric.body.data.id}`)).status).toBe(404);
    expect((await create(stranger, await createClass(stranger.user), { rubricId: rubric.body.data.id })).status).toBe(422);
    expect((await students[0].get('/api/rubrics')).status).toBe(403);
  });

  it('reopens an assignment for one student', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await create(teacher, cls, { dueAt: iso(60), allowLate: false })).body.data.id;
    await submit(students[0], id);
    await grade(teacher, id, students[0], { score: 20, return: true });
    await prisma.assignment.update({ where: { id }, data: { dueAt: minutesFromNow(-5) } });

    expect((await teacher.post(`/api/assignments/${id}/submissions/${students[0].user.id}/reopen`, { until: iso(-5) })).status).toBe(422);
    expect((await students[0].post(`/api/assignments/${id}/submissions/${students[0].user.id}/reopen`, { until: iso(60) })).status).toBe(403);
    expect((await teacher.post(`/api/assignments/${id}/submissions/${students[0].user.id}/reopen`, { until: iso(60), note: 'Revise the conclusion' })).status).toBe(200);

    const again = await submit(students[0], id, { textContent: '<p>Revised</p>' });
    expect(again.status).toBe(200);
    expect(again.body.data.submission).toMatchObject({ isLate: false, penaltyPercent: 0, attemptNumber: 2, reopenedUntil: null });
    // The extension was personal, and is used up.
    expect((await submit(students[1], id)).body.error.code).toBe('CLOSED');
    expect((await submit(students[0], id)).body.error.code).toBe('CLOSED');
  });

  it('gives the teacher a roster and a ZIP of all submissions', async () => {
    const { teacher, cls, students } = await classroom(3);
    const id = (await create(teacher, cls, { dueAt: iso(60) })).body.data.id;
    expect((await teacher.get(`/api/assignments/${id}/submissions-archive`)).status).toBe(409);
    const upload = await students[0].upload([{ name: 'report.pdf', content: '%PDF-1.4 the report' }]);
    await submit(students[0], id, { fileIds: [upload.body.data[0].id] });
    await students[1].put(`/api/assignments/${id}/submission`, { textContent: '<p>draft only</p>' });
    await prisma.assignment.update({ where: { id }, data: { dueAt: minutesFromNow(-1) } });

    const list = (await teacher.get(`/api/assignments/${id}/submissions`)).body.data.students;
    const statusOf = (s) => list.find((r) => r.student.id === s.user.id).status;
    expect([statusOf(students[0]), statusOf(students[1]), statusOf(students[2])]).toEqual(['SUBMITTED', 'MISSING', 'MISSING']);
    const stats = (await teacher.get(`/api/classes/${cls.id}/assignments`)).body.data[0].stats;
    expect(stats).toMatchObject({ enrolled: 3, submitted: 1, toGrade: 1, missing: 2 });

    const one = await teacher.get(`/api/assignments/${id}/submissions/${students[0].user.id}`);
    expect(one.body.data).toMatchObject({ position: expect.any(Number), total: 3, submission: { status: 'SUBMITTED' } });
    // A draft is the student's own until submitted.
    expect((await teacher.get(`/api/assignments/${id}/submissions/${students[1].user.id}`)).body.data.status).toBe('MISSING');

    const zip = await teacher.get(`/api/assignments/${id}/submissions-archive`).buffer(true).parse(binary);
    expect(zip.status).toBe(200);
    const names = Object.keys(unzipSync(new Uint8Array(zip.body)));
    expect(names).toHaveLength(2);
    expect(names.some((n) => n.endsWith('/report.pdf'))).toBe(true);
    expect(names.some((n) => n.endsWith('/answer.html'))).toBe(true);
    expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true);
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'submissions.download' } })).toBe(1);
  });

  it('reminds students who have not submitted, once', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await create(teacher, cls, { title: 'Due tomorrow', dueAt: iso(60 * 20) })).body.data.id;
    await submit(students[0], id);
    await sendDeadlineReminders();
    await sendDeadlineReminders();
    expect(await prisma.notification.count({ where: { type: 'assignment.due_soon', userId: students[1].user.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'assignment.due_soon', userId: students[0].user.id } })).toBe(0);
  });
});
