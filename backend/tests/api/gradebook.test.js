import { beforeAll, describe, expect, it } from 'vitest';
import { actor, classroom, clearSetting, defaultScale, prepare, prisma, setSetting } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const gb = (cls) => `/api/classes/${cls.id}/gradebook`;

/** One period, two categories (Quizzes 40 %, Exam 60 %), so expected values are easy to follow. */
async function simpleBook(n = 2) {
  const room = await classroom(n);
  const res = await room.teacher.put(`${gb(room.cls)}/structure`, {
    periods: [{ name: 'Term', weight: 100, categories: [{ name: 'Quizzes', kind: 'QUIZ', weight: 40 }, { name: 'Exam', kind: 'EXAM', weight: 60 }] }],
  });
  expect(res.status).toBe(200);
  const period = res.body.data.structure.periods[0];
  const item = async (categoryName, title, maxPoints) =>
    (await room.teacher.post(`${gb(room.cls)}/items`, { categoryId: period.categories.find((c) => c.name === categoryName).id, title, maxPoints })).body.data;
  const quiz = await item('Quizzes', 'Quiz 1', 50);
  const exam = await item('Exam', 'Final exam', 100);
  const grade = (studentIndex, itemId, score, status = 'GRADED') =>
    room.teacher.put(`${gb(room.cls)}/entries`, { entries: [{ itemId, studentId: room.students[studentIndex].user.id, status, score }] });
  return { ...room, period, quiz, exam, grade };
}

describe('gradebook structure', () => {
  it('starts every class with a valid default that the teacher can replace', async () => {
    const { teacher, cls } = await classroom(0);
    const book = (await teacher.get(gb(cls))).body.data;
    expect(book.structure.valid).toBe(true);
    expect(book.structure.periods.map((p) => [p.name, p.weight])).toEqual([['Midterm', 50], ['Final', 50]]);
    expect(book.class.gradingScale.entries[0]).toMatchObject({ label: '1.00', minPercent: 97 });

    const templates = (await teacher.get(`${gb(cls)}/templates`)).body.data;
    expect(templates.map((t) => t.key)).toContain('prelim-midterm-final');
    const applied = await teacher.post(`${gb(cls)}/structure/template`, { key: 'prelim-midterm-final' });
    expect(applied.body.data.structure.periods.map((p) => p.weight)).toEqual([30, 30, 40]);
  });

  it('rejects weights that do not total 100 %', async () => {
    const { teacher, cls } = await classroom(0);
    const bad = await teacher.put(`${gb(cls)}/structure`, { periods: [{ name: 'A', weight: 60, categories: [{ name: 'X', weight: 100 }] }, { name: 'B', weight: 30, categories: [{ name: 'Y', weight: 80 }] }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_STRUCTURE');
    expect(bad.body.error.details.errors.join(' ')).toMatch(/period weights must total 100% \(currently 90%\).*"B" must total 100% \(currently 80%\)/);
    // Nothing was changed.
    expect((await teacher.get(gb(cls))).body.data.structure.periods).toHaveLength(2);
  });

  it('renames, re-weights and swaps names while keeping graded items attached', async () => {
    const { teacher, cls, quiz, period } = await simpleBook(1);
    const [quizzes, exam] = period.categories;
    const res = await teacher.put(`${gb(cls)}/structure`, {
      periods: [
        { id: period.id, name: 'Midterm', weight: 40, categories: [{ id: quizzes.id, name: 'Exam', kind: 'QUIZ', weight: 30 }, { id: exam.id, name: 'Quizzes', kind: 'EXAM', weight: 70 }] },
        { name: 'Final', weight: 60, categories: [{ name: 'Project', kind: 'PROJECT', weight: 100 }] },
      ],
    });
    expect(res.status).toBe(200);
    const first = res.body.data.structure.periods[0];
    expect(first.categories.map((c) => [c.name, c.weight])).toEqual([['Exam', 30], ['Quizzes', 70]]);
    expect(first.categories[0].items.map((i) => i.id)).toEqual([quiz.id]);
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'gradebook.structure.update' } })).toBe(2);
  });

  it('refuses to remove a category that still holds graded work', async () => {
    const { teacher, cls, period } = await simpleBook(1);
    const res = await teacher.put(`${gb(cls)}/structure`, { periods: [{ id: period.id, name: 'Term', weight: 100, categories: [{ name: 'Everything', weight: 100 }] }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_IN_USE');
    expect((await teacher.post(`${gb(cls)}/structure/template`, { key: 'single' })).body.error.code).toBe('GRADEBOOK_IN_USE');
  });

  it('includes attendance only when the institution allows it', async () => {
    const { teacher, cls, students } = await classroom(1);
    const body = { periods: [{ name: 'Term', weight: 100, categories: [{ name: 'Work', weight: 80 }, { name: 'Attendance', kind: 'ATTENDANCE', weight: 20 }] }] };
    await setSetting('grading.allowAttendanceInGrades', false);
    try {
      expect((await teacher.put(`${gb(cls)}/structure`, body)).body.error.code).toBe('ATTENDANCE_NOT_GRADED');
      await setSetting('grading.allowAttendanceInGrades', true);
      const ok = await teacher.put(`${gb(cls)}/structure`, body);
      expect(ok.status).toBe(200);
      const work = ok.body.data.structure.periods[0].categories[0];
      const attendanceCategory = ok.body.data.structure.periods[0].categories[1];
      const item = (await teacher.post(`${gb(cls)}/items`, { categoryId: work.id, title: 'Paper', maxPoints: 10 })).body.data;
      expect((await teacher.post(`${gb(cls)}/items`, { categoryId: attendanceCategory.id, title: 'Nope', maxPoints: 10 })).status).toBe(422);
      await teacher.put(`${gb(cls)}/entries`, { entries: [{ itemId: item.id, studentId: students[0].user.id, status: 'GRADED', score: 7 }] });

      // 3 present, 1 late (half credit), 1 absent, 1 excused (ignored) → 3.5 / 5 = 70 %
      for (const [i, status] of ['PRESENT', 'PRESENT', 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED'].entries()) {
        const day = new Date(Date.UTC(2026, 9, 1 + i));
        const s = await prisma.attendanceSession.create({ data: { classId: cls.id, teacherId: teacher.user.id, date: day, startTime: day, endTime: new Date(day.getTime() + 3_600_000), status: 'CLOSED' } });
        await prisma.attendanceRecord.create({ data: { sessionId: s.id, studentId: students[0].user.id, status, verificationMethod: 'MANUAL' } });
      }
      const row = (await teacher.get(gb(cls))).body.data.students[0];
      expect(row.overall.percent).toBe(70); // 70 × .8 + 70 × .2
      const detail = (await teacher.get(`${gb(cls)}/students/${students[0].user.id}`)).body.data;
      expect(detail.periods[0].categories[1]).toMatchObject({ kind: 'ATTENDANCE', percent: 70, attendance: { present: 3, late: 1, absent: 1, excused: 1 } });

      // Policy switched off again: the category is ignored and its weight redistributed.
      await setSetting('grading.allowAttendanceInGrades', false);
      expect((await teacher.get(gb(cls))).body.data.students[0].overall.percent).toBe(70);
      expect((await teacher.get(`${gb(cls)}/students/${students[0].user.id}`)).body.data.periods[0].categories[1].percent).toBeNull();
    } finally {
      await clearSetting('grading.allowAttendanceInGrades');
    }
  });
});

describe('scores and computed grades', () => {
  it('computes weighted grades and keeps a history of every change', async () => {
    const { teacher, cls, students, quiz, exam, grade } = await simpleBook(2);
    expect((await grade(0, quiz.id, 40)).body.data.changed).toBe(1);
    await grade(0, exam.id, 90);
    await grade(0, quiz.id, 45); // corrected
    expect((await grade(0, quiz.id, 45)).body.data.changed).toBe(0); // same value: no new history

    const book = (await teacher.get(gb(cls))).body.data;
    const row = book.students.find((s) => s.id === students[0].user.id);
    // Quiz 45/50 = 90 %, exam 90 % → 90 × .4 + 90 × .6 = 90
    expect(row.overall).toMatchObject({ percent: 90, label: '1.75', isPassing: true, isComplete: true });
    expect(row.entries[quiz.id]).toMatchObject({ score: 45, status: 'GRADED' });
    expect(book.students.find((s) => s.id === students[1].user.id).overall.percent).toBeNull();
    expect(book.stats).toMatchObject({ students: 2, graded: 1, average: 90, passing: 1, failing: 0 });

    const detail = (await teacher.get(`${gb(cls)}/students/${students[0].user.id}`)).body.data;
    expect(detail.history.filter((h) => h.item === 'Quiz 1').map((h) => [h.oldScore, h.newScore])).toEqual([[40, 45], [null, 40]]);
    expect(detail.explanation.join('\n')).toContain('Term: (Quizzes 90% × 40% + Exam 90% × 60%) ÷ 100% = 90%.');
  });

  it('validates scores and who they are for', async () => {
    const { teacher, cls, students, quiz } = await simpleBook(1);
    const outsider = await actor('STUDENT');
    const put = (entries) => teacher.put(`${gb(cls)}/entries`, { entries });
    expect((await put([{ itemId: quiz.id, studentId: students[0].user.id, status: 'GRADED', score: 51 }])).status).toBe(422);
    expect((await put([{ itemId: quiz.id, studentId: students[0].user.id, status: 'GRADED', score: -1 }])).status).toBe(422);
    expect((await put([{ itemId: quiz.id, studentId: students[0].user.id, status: 'GRADED' }])).status).toBe(422);
    expect((await put([{ itemId: quiz.id, studentId: outsider.user.id, status: 'GRADED', score: 5 }])).status).toBe(422);
    const other = await simpleBook(1);
    expect((await put([{ itemId: other.quiz.id, studentId: students[0].user.id, status: 'GRADED', score: 5 }])).status).toBe(422);
    expect(await prisma.gradeEntry.count({ where: { gradeItemId: quiz.id } })).toBe(0);
  });

  it('distinguishes missing, exempt and ungraded work, following the class policy', async () => {
    const { teacher, cls, students, quiz, exam, grade } = await simpleBook(1);
    await grade(0, exam.id, 80);
    await grade(0, quiz.id, null, 'MISSING');
    const overall = async () => (await teacher.get(gb(cls))).body.data.students[0].overall;
    expect((await overall()).percent).toBe(48); // 0 × .4 + 80 × .6
    await grade(0, quiz.id, null, 'EXEMPT');
    expect(await overall()).toMatchObject({ percent: 80, isComplete: false });
    await grade(0, quiz.id, null, 'MISSING');
    await teacher.patch(`${gb(cls)}/settings`, { treatMissingAsZero: false });
    expect((await overall()).percent).toBe(80);
    expect((await teacher.get(gb(cls))).body.data.students[0].missingCount).toBe(1);
    expect(students).toHaveLength(1);
  });

  it('applies transmutation and rounding settings and audits the change', async () => {
    const { teacher, cls, quiz, exam, grade } = await simpleBook(1);
    await grade(0, quiz.id, 25);
    await grade(0, exam.id, 50);
    const overall = async () => (await teacher.get(gb(cls))).body.data.students[0].overall;
    expect(await overall()).toMatchObject({ percent: 50, label: '5.00', isPassing: false });
    expect((await teacher.patch(`${gb(cls)}/settings`, { transmutationBase: 50 })).status).toBe(200);
    expect(await overall()).toMatchObject({ percent: 75, label: '3.00', isPassing: true });
    expect((await teacher.patch(`${gb(cls)}/settings`, { transmutationBase: 95 })).status).toBe(422);
    expect((await teacher.patch(`${gb(cls)}/settings`, { gradingScaleId: 'nope' })).status).toBe(422);
    const log = await prisma.auditLog.findFirst({ where: { classId: cls.id, action: 'gradebook.settings.update' } });
    expect(log.before).toEqual({ transmutationBase: 0 });
    expect(log.after).toEqual({ transmutationBase: 50 });
  });

  it('requires a reason for an override, shows it, and can be undone', async () => {
    const { teacher, cls, students, quiz, exam, grade } = await simpleBook(1);
    await grade(0, quiz.id, 40);
    await grade(0, exam.id, 70);
    const body = { studentId: students[0].user.id, scope: 'OVERALL', percent: 75 };
    expect((await teacher.post(`${gb(cls)}/overrides`, body)).status).toBe(422);
    expect((await teacher.post(`${gb(cls)}/overrides`, { ...body, reason: 'x' })).status).toBe(422);
    expect((await teacher.post(`${gb(cls)}/overrides`, { ...body, scope: 'nope', reason: 'Valid reason' })).status).toBe(422);
    const made = await teacher.post(`${gb(cls)}/overrides`, { ...body, reason: 'Completion exam passed' });
    expect(made.status).toBe(201);
    expect(made.body.data.computedPercent).toBe(74);

    let row = (await teacher.get(gb(cls))).body.data.students[0];
    expect(row.overall).toMatchObject({ percent: 75, computedPercent: 74, isOverridden: true, label: '3.00', overrideReason: 'Completion exam passed' });
    const log = await prisma.auditLog.findFirst({ where: { classId: cls.id, action: 'grade.override' } });
    expect(log.summary).toContain('Completion exam passed');
    expect(log.before).toMatchObject({ percent: 74 });

    expect((await teacher.delete(`${gb(cls)}/overrides/${made.body.data.id}`)).status).toBe(204);
    row = (await teacher.get(gb(cls))).body.data.students[0];
    expect(row.overall).toMatchObject({ percent: 74, isOverridden: false, label: '5.00' });
  });
});

describe('publishing, locking and finalising', () => {
  it('shows a student only what has been published, and only their own grades', async () => {
    const { teacher, cls, students, quiz, exam, grade, period } = await simpleBook(2);
    await grade(0, quiz.id, 45);
    await grade(0, exam.id, 90);
    await grade(1, quiz.id, 10);

    let mine = (await students[0].get(`${gb(cls)}/mine`)).body.data;
    expect(mine.periods[0]).toMatchObject({ published: false, percent: null, label: null });
    expect(mine.periods[0].categories[0].items[0]).toMatchObject({ title: 'Quiz 1', score: null, status: 'UNGRADED' });
    expect(mine.overall).toBeNull();
    expect(mine.explanation).toEqual([]);

    const published = await teacher.post(`${gb(cls)}/periods/${period.id}/publish`, {});
    expect(published.body.data.publishedAt).toBeTruthy();
    mine = (await students[0].get(`${gb(cls)}/mine`)).body.data;
    expect(mine.periods[0]).toMatchObject({ published: true, percent: 90, label: '1.75' });
    expect(mine.periods[0].categories[0].items[0]).toMatchObject({ score: 45, status: 'GRADED', counted: true });
    expect(mine.overall).toMatchObject({ percent: 90, label: '1.75' });
    expect(mine.explanation.join(' ')).toContain('Quizzes 90% × 40%');
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'grades.published' } })).toBe(1);

    // Nobody else's numbers are in a student's response, and the teacher views are off limits.
    expect(JSON.stringify(mine)).not.toContain(students[1].user.id);
    expect((await students[1].get(`${gb(cls)}/mine`)).body.data.periods[0].categories[0].items[0].score).toBe(10);
    for (const path of ['', `/students/${students[1].user.id}`, `/students/${students[0].user.id}`, '/export', '/publishing-log', '/categories']) {
      expect((await students[0].get(`${gb(cls)}${path}`)).status, path).toBe(403);
    }
    expect((await students[0].put(`${gb(cls)}/entries`, { entries: [{ itemId: quiz.id, studentId: students[0].user.id, status: 'GRADED', score: 50 }] })).status).toBe(403);
    expect((await students[0].post(`${gb(cls)}/overrides`, { studentId: students[0].user.id, scope: 'OVERALL', percent: 100, reason: 'Because I said so' })).status).toBe(403);
    const other = await actor('TEACHER');
    expect((await other.get(gb(cls))).status).toBe(404);
    expect((await (await actor('STUDENT')).get(`${gb(cls)}/mine`)).status).toBe(404);

    await teacher.post(`${gb(cls)}/periods/${period.id}/unpublish`, {});
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.overall).toBeNull();
  });

  it('locks a period against changes until it is unlocked with a reason', async () => {
    const { teacher, cls, students, quiz, grade, period } = await simpleBook(1);
    await grade(0, quiz.id, 30);
    expect((await teacher.post(`${gb(cls)}/periods/${period.id}/lock`, {})).status).toBe(200);
    const blocked = await grade(0, quiz.id, 35);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PERIOD_LOCKED');
    expect((await teacher.post(`${gb(cls)}/overrides`, { studentId: students[0].user.id, scope: period.id, percent: 99, reason: 'Trying anyway' })).status).toBe(409);
    expect((await teacher.patch(`${gb(cls)}/settings`, { transmutationBase: 50 })).status).toBe(409);
    expect((await teacher.delete(`${gb(cls)}/items/${quiz.id}`)).status).toBe(409);
    expect((await teacher.post(`${gb(cls)}/periods/${period.id}/unlock`, {})).status).toBe(422);
    expect((await teacher.post(`${gb(cls)}/periods/${period.id}/unlock`, { note: 'Encoding error in quiz 1' })).status).toBe(200);
    expect((await grade(0, quiz.id, 35)).status).toBe(200);
    const log = (await teacher.get(`${gb(cls)}/publishing-log`)).body.data;
    expect(log.map((l) => l.action)).toEqual(['UNLOCKED', 'LOCKED']);
    expect(log[0].note).toBe('Encoding error in quiz 1');
  });

  it('finalises grades into a permanent record and reopens only with a reason', async () => {
    const { teacher, cls, students, quiz, exam, grade } = await simpleBook(2);
    await grade(0, quiz.id, 45);
    await grade(0, exam.id, 90);
    await grade(1, quiz.id, 20);

    const warn = await teacher.post(`${gb(cls)}/finalize`, {});
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe('INCOMPLETE_GRADES');
    expect(warn.body.error.details.count).toBe(1);
    const done = await teacher.post(`${gb(cls)}/finalize`, { confirmIncomplete: true });
    expect(done.status).toBe(200);
    expect(done.body.data.class.finalizedAt).toBeTruthy();
    expect(done.body.data.structure.periods[0].lockedAt).toBeTruthy();

    const finals = await prisma.finalGrade.findMany({ where: { classId: cls.id, scope: 'OVERALL' } });
    expect(finals).toHaveLength(2);
    const record = finals.find((f) => f.studentId === students[0].user.id);
    expect(record).toMatchObject({ percent: 90, label: '1.75', isPassing: true });
    expect(record.breakdown.periods[0].categories[0].items[0]).toMatchObject({ title: 'Quiz 1', score: 45 });

    // Everything is frozen.
    expect((await grade(0, quiz.id, 50)).body.error.code).toBe('GRADES_FINALIZED');
    expect((await teacher.post(`${gb(cls)}/items`, { categoryId: done.body.data.structure.periods[0].categories[0].id, title: 'Late', maxPoints: 5 })).status).toBe(409);
    expect((await teacher.post(`${gb(cls)}/finalize`, {})).status).toBe(409);

    // The student sees the official record, with the explanation.
    const mine = (await students[0].get(`${gb(cls)}/mine`)).body.data;
    expect(mine).toMatchObject({ finalized: true, overall: { percent: 90, label: '1.75' } });
    expect(mine.explanation.length).toBeGreaterThan(0);
    const all = (await students[0].get('/api/grades/mine')).body.data;
    expect(all.find((c) => c.classId === cls.id)).toMatchObject({ finalized: true, overall: { label: '1.75' } });

    // The record survives a later change of the institution's scale.
    await prisma.gradingScaleEntry.updateMany({ where: { label: '1.75' }, data: { label: 'B+' } });
    try {
      expect((await teacher.get(gb(cls))).body.data.students.find((s) => s.id === students[0].user.id).overall.label).toBe('1.75');
      expect((await students[0].get(`${gb(cls)}/mine`)).body.data.overall.label).toBe('1.75');
    } finally {
      await prisma.gradingScaleEntry.updateMany({ where: { label: 'B+' }, data: { label: '1.75' } });
    }

    expect((await teacher.post(`${gb(cls)}/reopen`, {})).status).toBe(422);
    expect((await students[0].post(`${gb(cls)}/reopen`, { reason: 'I want a better grade' })).status).toBe(403);
    const reopened = await teacher.post(`${gb(cls)}/reopen`, { reason: 'Exam score encoded for the wrong student' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.class.finalizedAt).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { classId: cls.id, action: { in: ['grades.finalize', 'grades.reopen'] } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['grades.finalize', 'grades.reopen']);
    expect(audit[1].summary).toContain('wrong student');
  });

  it('exports the gradebook when the role is allowed to', async () => {
    const { teacher, cls, quiz, exam, grade } = await simpleBook(1);
    await grade(0, quiz.id, 45);
    await grade(0, exam.id, 90);
    const csv = await teacher.get(`${gb(cls)}/export?format=csv`);
    expect(csv.status).toBe(200);
    const [header, row] = csv.text.replace(/^\uFEFF/, '').split('\r\n'); // the BOM makes Excel read UTF-8
    expect(header).toBe('Student No.,Name,Quiz 1 (50),Final exam (100),Final %,Grade,Remark');
    expect(row).toMatch(/,45,90,90,1\.75,Good$/);
    const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
    expect((await teacher.get(`${gb(cls)}/export?format=xlsx`).buffer(true).parse(binary)).body.subarray(0, 2).toString()).toBe('PK');
    expect((await teacher.get(`${gb(cls)}/export?format=pdf`).buffer(true).parse(binary)).body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'grades.export' } })).toBe(3);

    const admin = await actor('ADMIN');
    await admin.put('/api/admin/permissions', { role: 'TEACHER', key: 'grades.export', granted: false });
    try {
      const denied = await teacher.get(`${gb(cls)}/export?format=csv`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await admin.put('/api/admin/permissions', { role: 'TEACHER', key: 'grades.export', granted: true });
    }
  });
});

describe('grade review requests', () => {
  it('go from the student to the class teacher and back', async () => {
    const { teacher, cls, students, quiz } = await simpleBook(2);
    const made = await students[0].post(`${gb(cls)}/appeals`, { gradeItemId: quiz.id, reason: 'Item 7 was marked wrong but matches the key.' });
    expect(made.status).toBe(201);
    expect((await students[0].post(`${gb(cls)}/appeals`, { gradeItemId: quiz.id, reason: 'Asking again about the same item.' })).status).toBe(409);
    expect((await teacher.post(`${gb(cls)}/appeals`, { reason: 'Teachers do not appeal grades.' })).status).toBe(403);

    expect((await students[1].get(`${gb(cls)}/appeals`)).body.data).toHaveLength(0);
    expect((await teacher.get(`${gb(cls)}/appeals`)).body.data[0]).toMatchObject({ status: 'PENDING', item: { title: 'Quiz 1' }, student: { id: students[0].user.id } });
    expect((await students[1].post(`${gb(cls)}/appeals/${made.body.data.id}/resolve`, { status: 'APPROVED', response: 'Sure' })).status).toBe(403);
    expect((await teacher.post(`${gb(cls)}/appeals/${made.body.data.id}/resolve`, { status: 'APPROVED' })).status).toBe(422);
    const resolved = await teacher.post(`${gb(cls)}/appeals/${made.body.data.id}/resolve`, { status: 'APPROVED', response: 'You are right — score corrected.' });
    expect(resolved.body.data).toMatchObject({ status: 'APPROVED', response: 'You are right — score corrected.' });
    expect((await teacher.post(`${gb(cls)}/appeals/${made.body.data.id}/resolve`, { status: 'REJECTED', response: 'Changed my mind' })).status).toBe(409);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'grade.appeal.resolved' } })).toBe(1);
  });
});

describe('academic records', () => {
  it('are visible to administrators only, and the access is audited', async () => {
    const { students, teacher } = await simpleBook(1);
    const admin = await actor('ADMIN');
    const res = await admin.get(`/api/grades/students/${students[0].user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.classes).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'records.view', entityId: students[0].user.id } })).toBe(1);
    expect((await teacher.get(`/api/grades/students/${students[0].user.id}`)).status).toBe(403);
    expect((await students[0].get(`/api/grades/students/${students[0].user.id}`)).status).toBe(403);
    expect((await teacher.get('/api/grades/mine')).status).toBe(403);
  });
});
