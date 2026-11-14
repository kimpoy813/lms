// Strict rules in quizzes and examinations: a violation ends the attempt as failed, and only the
// teacher can reopen it, count its answers or remove it.
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, defaultScale, enroll, minutesFromNow, prepare, prisma } from '../helpers/index.js';
import { autoSubmitOverdue } from '../../src/modules/quizzes/routes.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const iso = (m) => minutesFromNow(m).toISOString();
const MC = { type: 'MULTIPLE_CHOICE', text: '<p>2 + 2 = ?</p>', points: 2, choices: [{ text: 'three' }, { text: 'four', isCorrect: true }, { text: 'five' }] };
const TF = { type: 'TRUE_FALSE', text: '<p>The sun is a star.</p>', points: 1, answer: true };
const ESSAY = { type: 'ESSAY', text: '<p>Explain recursion.</p>', points: 5 };

async function quizWith(room, questions, settings = {}) {
  const { teacher, cls } = room;
  const created = await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Quiz 1', resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', ...settings });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  for (const question of questions) expect((await teacher.post(`/api/quizzes/${id}/questions`, { question })).status).toBe(201);
  const published = await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' });
  expect(published.status).toBe(200);
  return published.body.data;
}

async function start(student, quizId) {
  const res = await student.post(`/api/quizzes/${quizId}/attempts`, { acceptRules: true });
  expect([200, 201]).toContain(res.status);
  return (await student.get(`/api/attempts/${res.body.data.attemptId}`)).body.data;
}
const answer = (student, attempt, position, response) => student.put(`/api/attempts/${attempt.id}/answers/${position}`, { response });
const choiceId = (attempt, position, text) => attempt.questions[position].question.choices.find((c) => c.text === text).id;
const violate = (student, attempt, kind = 'LEFT_PAGE', extra = {}) => student.post(`/api/attempts/${attempt.id}/violations`, { kind, ...extra });
const row = async (teacher, quizId, student) => (await teacher.get(`/api/quizzes/${quizId}/results`)).body.data.students.find((r) => r.student.id === student.user.id);
const notifications = (userId, type) => prisma.notification.findMany({ where: { userId, type }, orderBy: { createdAt: 'asc' } });

describe('the rules of a quiz', () => {
  it('are on for quizzes and examinations, off for practice, and can be changed', async () => {
    const room = await classroom(1);
    const { teacher, cls, students } = room;
    const quiz = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Q' })).body.data;
    expect(quiz).toMatchObject({ strictMode: true, violationWarnings: 0 });
    const exam = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'E', kind: 'EXAM' })).body.data;
    expect(exam.strictMode).toBe(true);
    const practice = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'P', kind: 'PRACTICE' })).body.data;
    expect(practice.strictMode).toBe(false);
    const strictPractice = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'P2', kind: 'PRACTICE', strictMode: true, violationWarnings: 2 })).body.data;
    expect(strictPractice).toMatchObject({ strictMode: true, violationWarnings: 2 });

    const relaxed = await teacher.patch(`/api/quizzes/${quiz.id}`, { strictMode: false });
    expect(relaxed.body.data.strictMode).toBe(false);
    // Changing something else leaves the rules as they are.
    expect((await teacher.patch(`/api/quizzes/${quiz.id}`, { title: 'Q renamed' })).body.data).toMatchObject({ strictMode: false, violationWarnings: 0 });
    expect((await teacher.patch(`/api/quizzes/${quiz.id}`, { violationWarnings: 9 })).status).toBe(422);
    expect((await teacher.patch(`/api/quizzes/${quiz.id}`, { violationWarnings: -1 })).status).toBe(422);
    expect((await students[0].patch(`/api/quizzes/${quiz.id}`, { strictMode: false })).status).toBe(403);

    // A copy keeps the rules of the original.
    const copy = await teacher.post(`/api/quizzes/${strictPractice.id}/copy`, {});
    expect(copy.body.data).toMatchObject({ strictMode: true, violationWarnings: 2 });
  });

  it('must be accepted before a strict quiz starts', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC]);
    // A copy of the web app from before the rules existed sends nothing: it is told to reload.
    const old = await student.post(`/api/quizzes/${quiz.id}/attempts`);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('RULES_NOT_ACCEPTED');
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: false })).body.error.code).toBe('RULES_NOT_ACCEPTED');
    expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id } })).toBe(0);

    const attempt = await start(student, quiz.id);
    expect(attempt).toMatchObject({ status: 'IN_PROGRESS', rules: { warnings: 0, used: 0 } });
    const stored = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    expect(stored.rulesAcceptedAt).toBeInstanceOf(Date);
    // Coming back to the attempt in progress needs no second acceptance.
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`)).body.data).toMatchObject({ attemptId: attempt.id, resumed: true });

    // A quiz without strict rules starts as before and tells the page so.
    const relaxed = await quizWith(room, [MC], { strictMode: false });
    const free = await student.post(`/api/quizzes/${relaxed.id}/attempts`);
    expect(free.status).toBe(201);
    expect((await student.get(`/api/attempts/${free.body.data.attemptId}`)).body.data.rules).toBeNull();
  });
});

describe('a violation', () => {
  it('ends the attempt as failed, keeps the answers and tells both sides', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const [student, other] = students;
    const quiz = await quizWith(room, [MC, TF], { categoryId: await categoryId(cls.id, 'QUIZ') });
    const attempt = await start(student, quiz.id);
    expect((await answer(student, attempt, 0, { choiceId: choiceId(attempt, 0, 'four') })).status).toBe(200);

    // Only the student of the attempt can report on it.
    expect((await violate(other, attempt)).status).toBe(404);
    expect((await violate(teacher, attempt)).status).toBe(403);
    expect((await violate(student, attempt, 'SNEEZED')).status).toBe(422);

    const ended = await violate(student, attempt, 'LEFT_PAGE');
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({ outcome: 'TERMINATED', kind: 'LEFT_PAGE', number: 1, allowed: 0, warningsLeft: 0, text: 'switched to another tab or app' });

    const stored = await prisma.quizAttempt.findUnique({ where: { id: attempt.id }, include: { answers: { orderBy: { position: 'asc' } } } });
    expect(stored).toMatchObject({ status: 'AUTO_SUBMITTED', terminationKind: 'LEFT_PAGE', totalScore: 0, autoScore: 0, needsManualGrading: false, violationCount: 1 });
    expect(stored.terminatedAt).toBeInstanceOf(Date);
    // The answers stay as they were, unmarked.
    expect(stored.answers[0].response).toEqual({ choiceId: choiceId(attempt, 0, 'four') });
    expect(stored.answers[0].score).toBeNull();

    // Nothing more can be saved or handed in, and no other attempt can be started.
    expect((await answer(student, attempt, 1, { choiceId: choiceId(attempt, 1, 'True') })).body.error.code).toBe('ATTEMPT_CLOSED');
    expect((await student.post(`/api/attempts/${attempt.id}/submit`)).body.data.status).toBe('TERMINATED');
    const again = await student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TERMINATED');
    // A second report changes nothing.
    expect((await violate(student, attempt, 'COPY')).body.data.outcome).toBe('CLOSED');
    expect((await prisma.quizAttempt.findUnique({ where: { id: attempt.id } })).terminationKind).toBe('LEFT_PAGE');

    // The student is told at once, whatever the rule for showing scores, and sees no questions.
    const mine = (await student.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(mine).toMatchObject({ status: 'TERMINATED', terminated: { kind: 'LEFT_PAGE', text: 'switched to another tab or app' }, questions: null, totalScore: null });
    const summary = (await student.get(`/api/quizzes/${quiz.id}`)).body.data;
    expect(summary).toMatchObject({ myStatus: 'TERMINATED', terminated: { attemptId: attempt.id, kind: 'LEFT_PAGE' }, start: { ok: false, code: 'TERMINATED' } });
    expect(summary.attempts[0]).toMatchObject({ status: 'TERMINATED', terminated: { kind: 'LEFT_PAGE' }, score: null });
    const listed = (await student.get(`/api/classes/${cls.id}/quizzes`)).body.data.find((q) => q.id === quiz.id);
    expect(listed).toMatchObject({ myStatus: 'TERMINATED', terminated: { kind: 'LEFT_PAGE' } });

    // The teacher sees it in the results, the list, the gradebook and a notification.
    const mineRow = await row(teacher, quiz.id, student);
    expect(mineRow).toMatchObject({ status: 'TERMINATED', score: 0, percent: 0 });
    expect(mineRow.attempts[0]).toMatchObject({ terminated: { kind: 'LEFT_PAGE' }, totalScore: 0 });
    const results = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    expect(results.stats).toMatchObject({ violations: 1, submitted: 1 });
    expect((await teacher.get(`/api/classes/${cls.id}/quizzes`)).body.data.find((q) => q.id === quiz.id).stats.violations).toBe(1);
    const view = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view).toMatchObject({ underRules: true, violationCount: 1, terminated: { kind: 'LEFT_PAGE', secondsLeft: null } });
    expect(view.questions).toHaveLength(2);
    expect(view.events.map((e) => e.type)).toEqual(['STARTED', 'VIOLATION']);
    expect(view.events[1].meta).toMatchObject({ kind: 'LEFT_PAGE', number: 1, allowed: 0, outcome: 'TERMINATED' });
    const entry = await prisma.gradeEntry.findFirst({ where: { studentId: student.user.id, gradeItem: { quizId: quiz.id } } });
    expect(entry).toMatchObject({ score: 0, status: 'GRADED' });

    const toTeacher = await notifications(teacher.user.id, 'quiz.attempt.terminated');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0].link).toBe(`/classes/${cls.id}/quizzes/${quiz.id}/results?attempt=${attempt.id}`);
    expect(toTeacher[0].body).toContain('switched to another tab or app');
    expect(await notifications(student.user.id, 'quiz.attempt.terminated')).toHaveLength(1);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'quiz.attempt.terminate', entityId: attempt.id } });
    expect(audit).toMatchObject({ actorId: student.user.id, classId: cls.id });

    // Its unmarked answers are not graded one by one, and stay out of the question analysis.
    expect((await teacher.put(`/api/attempts/${attempt.id}/answers/0/grade`, { score: 2 })).body.error.code).toBe('ATTEMPT_TERMINATED');
    expect((await teacher.get(`/api/quizzes/${quiz.id}/analysis`)).body.data).toEqual([]);
    const csv = await teacher.get(`/api/quizzes/${quiz.id}/export?format=csv`);
    expect(csv.text).toContain('Ended: rule violation');
  });

  it('is answered with a warning while the quiz allows one', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { violationWarnings: 2 });
    const attempt = await start(student, quiz.id);
    expect(attempt.rules).toEqual({ warnings: 2, used: 0 });

    expect((await violate(student, attempt, 'LOST_FOCUS')).body.data).toMatchObject({ outcome: 'WARNING', number: 1, allowed: 2, warningsLeft: 1 });
    expect((await violate(student, attempt, 'PASTE')).body.data).toMatchObject({ outcome: 'WARNING', number: 2, allowed: 2, warningsLeft: 0 });
    // Still open: answers are saved, and the page is told how many warnings were used.
    expect((await answer(student, attempt, 0, { choiceId: choiceId(attempt, 0, 'four') })).status).toBe(200);
    expect((await student.get(`/api/attempts/${attempt.id}`)).body.data.rules).toEqual({ warnings: 2, used: 2 });
    expect(await notifications(room.teacher.user.id, 'quiz.attempt.terminated')).toHaveLength(0);

    expect((await violate(student, attempt, 'SCREENSHOT', { detail: 'PrintScreen' })).body.data).toMatchObject({ outcome: 'TERMINATED', kind: 'SCREENSHOT', number: 3, allowed: 2 });
    const view = (await room.teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view.events.filter((e) => e.type === 'VIOLATION').map((e) => [e.meta.kind, e.meta.outcome])).toEqual([['LOST_FOCUS', 'WARNING'], ['PASTE', 'WARNING'], ['SCREENSHOT', 'TERMINATED']]);
    expect(view.events.at(-1).meta.detail).toBe('PrintScreen');
    expect(view.terminated.kind).toBe('SCREENSHOT');
  });

  it('is counted once when the browser sends the same report again', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { violationWarnings: 1 });
    const attempt = await start(student, quiz.id);
    const first = await violate(student, attempt, 'LEFT_PAGE', { key: 'abcdefgh12345678' });
    expect(first.body.data).toMatchObject({ outcome: 'WARNING', number: 1, warningsLeft: 0 });
    // Sent again (the first answer was lost on the way): the same answer, not a second violation.
    const repeat = await violate(student, attempt, 'LEFT_PAGE', { key: 'abcdefgh12345678' });
    expect(repeat.body.data).toMatchObject({ outcome: 'WARNING', number: 1, warningsLeft: 0 });
    // Five at once with one key: still one.
    const burst = await Promise.all(Array.from({ length: 5 }, () => violate(student, attempt, 'COPY', { key: 'burst-key-000001' })));
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(burst.every((r) => r.body.data.outcome === 'TERMINATED')).toBe(true);
    expect(await prisma.quizAttemptEvent.count({ where: { attemptId: attempt.id, type: 'VIOLATION' } })).toBe(2);
    expect((await prisma.quizAttempt.findUnique({ where: { id: attempt.id } })).violationCount).toBe(2);
    expect(await notifications(room.teacher.user.id, 'quiz.attempt.terminated')).toHaveLength(1);
    expect((await violate(student, attempt, 'COPY', { key: 'short' })).status).toBe(422);
  });

  it('is not held against an attempt that the rules do not bind', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    // No strict rules: the report is ignored (leaving the tab is only a signal there).
    const relaxed = await quizWith(room, [MC], { strictMode: false });
    const free = await start(student, relaxed.id);
    expect((await violate(student, free)).body.data.outcome).toBe('IGNORED');
    expect((await student.post(`/api/attempts/${free.id}/events`, { type: 'TAB_HIDDEN' })).status).toBe(204);
    expect((await prisma.quizAttempt.findUnique({ where: { id: free.id } })).status).toBe('IN_PROGRESS');

    // Started before the teacher switched the rules on: the student was never shown them.
    const late = await quizWith(room, [MC], { strictMode: false });
    const before = await start(student, late.id);
    expect((await room.teacher.patch(`/api/quizzes/${late.id}`, { strictMode: true })).status).toBe(200);
    expect((await student.get(`/api/attempts/${before.id}`)).body.data.rules).toBeNull();
    expect((await violate(student, before)).body.data.outcome).toBe('IGNORED');
    expect((await prisma.quizAttempt.findUnique({ where: { id: before.id } })).status).toBe('IN_PROGRESS');
    expect(await prisma.auditLog.count({ where: { action: 'quiz.rules.change', entityId: late.id } })).toBe(1);

    // Switched off while an attempt is open: from then on nothing is counted.
    const strict = await quizWith(room, [MC]);
    const bound = await start(student, strict.id);
    expect((await room.teacher.patch(`/api/quizzes/${strict.id}`, { strictMode: false })).status).toBe(200);
    expect((await violate(student, bound)).body.data.outcome).toBe('IGNORED');
  });

  it('that is reported late counts from when it happened', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { timeLimitMinutes: 30 });
    const attempt = await start(student, quiz.id);
    // The connection was down: the report arrives four minutes after the student left.
    const reported = await violate(student, attempt, 'LEFT_PAGE', { agoMs: 4 * 60_000, key: 'late-report-0001' });
    expect(reported.body.data.outcome).toBe('TERMINATED');
    const stored = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    // Never before the attempt began.
    expect(stored.terminatedAt.getTime()).toBe(stored.startedAt.getTime());
    const view = (await room.teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view.terminated.secondsLeft).toBe(30 * 60);
    expect(view.events.find((e) => e.type === 'VIOLATION').meta.reportedAt).toBeTruthy();

    // Time ran out while the report could not be sent: the attempt was handed in as usual,
    // and the late report is kept for the teacher without changing the result.
    const timed = await quizWith(room, [MC], { timeLimitMinutes: 10 });
    const second = await start(student, timed.id);
    await answer(student, second, 0, { choiceId: choiceId(second, 0, 'four') });
    await prisma.quizAttempt.update({ where: { id: second.id }, data: { startedAt: minutesFromNow(-20), deadlineAt: minutesFromNow(-10) } });
    expect(await autoSubmitOverdue()).toBeGreaterThanOrEqual(1);
    const afterwards = await violate(student, second, 'LEFT_PAGE', { agoMs: 15 * 60_000 });
    expect(afterwards.body.data.outcome).toBe('CLOSED');
    const closed = await prisma.quizAttempt.findUnique({ where: { id: second.id } });
    expect(closed).toMatchObject({ status: 'AUTO_SUBMITTED', terminatedAt: null, totalScore: 2 });
    const events = await prisma.quizAttemptEvent.findMany({ where: { attemptId: second.id, type: 'VIOLATION' } });
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ kind: 'LEFT_PAGE', outcome: 'LATE' });

    // It happened after time was up: nothing but the ordinary hand-in.
    const third = await quizWith(room, [MC], { timeLimitMinutes: 10 });
    const overdue = await start(student, third.id);
    await prisma.quizAttempt.update({ where: { id: overdue.id }, data: { startedAt: minutesFromNow(-20), deadlineAt: minutesFromNow(-10) } });
    expect((await violate(student, overdue, 'LEFT_PAGE')).body.data.outcome).toBe('CLOSED');
    expect(await prisma.quizAttempt.findUnique({ where: { id: overdue.id } })).toMatchObject({ status: 'AUTO_SUBMITTED', terminatedAt: null });
    expect(await prisma.quizAttemptEvent.count({ where: { attemptId: overdue.id, type: 'VIOLATION' } })).toBe(0);
  });

  it('keeps when the student came back, for the teacher', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);
    await violate(student, attempt, 'LEFT_PAGE');
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'TAB_VISIBLE', awayMs: 42_000 })).status).toBe(204);
    // Other signals are not taken for a closed attempt.
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'OFFLINE' })).status).toBe(204);
    const view = (await room.teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view.events.map((e) => e.type)).toEqual(['STARTED', 'VIOLATION', 'TAB_VISIBLE']);
    expect(view.events[2].meta).toEqual({ awayMs: 42_000 });
  });
});

describe('the quiz page being opened', () => {
  const open = (student, attempt) => student.post(`/api/attempts/${attempt.id}/open`, {});
  const events = async (attempt, type) => prisma.quizAttemptEvent.findMany({ where: { attemptId: attempt.id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });

  it('a second time, with nothing reported in between, is a violation: the page was closed or reloaded', async () => {
    const room = await classroom(1);
    const { teacher, students: [student] } = room;
    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);

    // The page that the start leads to.
    expect((await open(student, attempt)).body.data).toEqual({ outcome: 'OPENED' });
    expect((await prisma.quizAttempt.findUnique({ where: { id: attempt.id } })).status).toBe('IN_PROGRESS');

    // The browser was killed, the battery ran out, a private window was closed while offline:
    // nothing was reported, and now the page is back.
    const again = await open(student, attempt);
    expect(again.body.data).toMatchObject({ outcome: 'TERMINATED', kind: 'CLOSED_PAGE', number: 1, allowed: 0 });
    const stored = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    expect(stored).toMatchObject({ status: 'AUTO_SUBMITTED', terminationKind: 'CLOSED_PAGE' });
    const [event] = await events(attempt, 'VIOLATION');
    expect(event.meta).toMatchObject({ kind: 'CLOSED_PAGE', outcome: 'TERMINATED', detail: expect.stringContaining('opened again') });
    expect((await notifications(room.teacher.user.id, 'quiz.attempt.terminated')).length).toBe(1);
    expect((await row(teacher, quiz.id, student)).status).toBe('TERMINATED');

    // Nothing more to open.
    expect((await open(student, attempt)).body.data).toEqual({ outcome: 'CLOSED' });
    expect((await open(room.teacher, attempt)).status).toBe(403);
  });

  it('again after leaving was already counted is not counted twice', async () => {
    const room = await classroom(1);
    const { students: [student] } = room;
    const quiz = await quizWith(room, [MC], { violationWarnings: 2 });
    const attempt = await start(student, quiz.id);
    expect((await open(student, attempt)).body.data.outcome).toBe('OPENED');

    // A phone: the student switches apps (counted), and the system throws the page away.
    expect((await violate(student, attempt, 'LEFT_PAGE')).body.data).toMatchObject({ outcome: 'WARNING', number: 1 });
    // The new page is given the warning to show: the old one was gone before it could.
    expect((await open(student, attempt)).body.data).toEqual({ outcome: 'OPENED', warned: { kind: 'LEFT_PAGE', text: 'switched to another tab or app', number: 1, allowed: 2, at: expect.any(String) } });
    expect((await events(attempt, 'PAGE_REOPENED')).length).toBe(1);

    // Back on the page and working. If the page now comes back anew, that is a second story.
    expect((await open(student, attempt)).body.data).toMatchObject({ outcome: 'WARNING', kind: 'CLOSED_PAGE', number: 2, warningsLeft: 0 });

    // Leaving, coming back to the page as it was (a sign of life), then losing the page.
    const room2 = await classroom(1);
    const quiz2 = await quizWith(room2, [MC], { violationWarnings: 2 });
    const second = await start(room2.students[0], quiz2.id);
    await open(room2.students[0], second);
    await violate(room2.students[0], second, 'LOST_FOCUS');
    expect((await room2.students[0].post(`/api/attempts/${second.id}/events`, { type: 'WINDOW_FOCUS', awayMs: 4000 })).status).toBe(204);
    expect((await open(room2.students[0], second)).body.data).toMatchObject({ outcome: 'WARNING', number: 2 });

    // Copying is not leaving: it explains nothing about a page that comes back.
    const room3 = await classroom(1);
    const quiz3 = await quizWith(room3, [MC], { violationWarnings: 2 });
    const third = await start(room3.students[0], quiz3.id);
    await open(room3.students[0], third);
    await violate(room3.students[0], third, 'COPY');
    expect((await open(room3.students[0], third)).body.data).toMatchObject({ outcome: 'WARNING', number: 2 });
  });

  it('settles what became of the page before it: a report of leaving that arrives afterwards is not counted again', async () => {
    const room = await classroom(1);
    const { teacher, students: [student] } = room;
    const quiz = await quizWith(room, [MC], { violationWarnings: 2 });
    const attempt = await start(student, quiz.id);
    expect((await open(student, attempt)).body.data.outcome).toBe('OPENED');

    // The laptop lost its connection and was closed. The student carries on in another browser:
    // nothing was reported, so the opening itself is counted.
    expect((await open(student, attempt)).body.data).toMatchObject({ outcome: 'WARNING', kind: 'CLOSED_PAGE', number: 1 });

    // Later the laptop is back and sends what it had written down, from before that opening.
    const late = await violate(student, attempt, 'CLOSED_PAGE', { key: 'laptop-report-01', agoMs: 2000 });
    expect(late.body.data).toMatchObject({ outcome: 'IGNORED', kind: 'CLOSED_PAGE' });
    expect((await violate(student, attempt, 'LEFT_PAGE', { key: 'laptop-report-02', agoMs: 3000 })).body.data.outcome).toBe('IGNORED');
    // Sent again: the same answer.
    expect((await violate(student, attempt, 'CLOSED_PAGE', { key: 'laptop-report-01', agoMs: 9000 })).body.data.outcome).toBe('IGNORED');
    expect((await prisma.quizAttempt.findUnique({ where: { id: attempt.id } })).violationCount).toBe(1);

    // The teacher still sees it.
    const view = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    const noted = view.events.filter((e) => e.type === 'VIOLATION' && e.meta.outcome === 'SUPERSEDED');
    expect(noted.map((e) => e.meta.kind).sort()).toEqual(['CLOSED_PAGE', 'LEFT_PAGE']);
    expect(noted[0].meta.reportedAt).toBeTruthy();

    // Copying on the old page is another act than leaving it, and what happens on the new page counts as ever.
    expect((await violate(student, attempt, 'COPY', { key: 'laptop-report-03', agoMs: 4000 })).body.data).toMatchObject({ outcome: 'WARNING', number: 2 });
    expect((await violate(student, attempt, 'LEFT_PAGE', { key: 'second-browser-1' })).body.data).toMatchObject({ outcome: 'TERMINATED', number: 3 });
  });

  it('counts for nothing without strict rules, and starts afresh after a reopening', async () => {
    const room = await classroom(1);
    const { teacher, students: [student] } = room;
    const relaxed = await quizWith(room, [MC], { strictMode: false });
    const free = await start(student, relaxed.id);
    expect((await open(student, free)).body.data).toEqual({ outcome: 'IGNORED' });
    expect((await open(student, free)).body.data).toEqual({ outcome: 'IGNORED' });

    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);
    await open(student, attempt);
    expect((await open(student, attempt)).body.data.outcome).toBe('TERMINATED');
    expect((await teacher.post(`/api/attempts/${attempt.id}/reopen`, {})).status).toBe(200);
    // The first page after the reopening is expected; the one after it is not.
    expect((await open(student, attempt)).body.data).toEqual({ outcome: 'OPENED' });
    expect((await open(student, attempt)).body.data.outcome).toBe('TERMINATED');
  });

  it('keeps for the teacher that the device slept with the page open', async () => {
    const room = await classroom(1);
    const { teacher, students: [student] } = room;
    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'SUSPENDED', awayMs: 600_000 })).status).toBe(204);
    const view = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view.events.find((e) => e.type === 'SUSPENDED').meta).toEqual({ awayMs: 600_000 });
    expect(view.status).toBe('IN_PROGRESS');
    // …and that the browser could not say whether the quiz window was the active one.
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'FOCUS_UNKNOWN' })).status).toBe(204);
    // …or that the list of a drop-down had the focus for a while on a touch screen.
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'PICKER', awayMs: 4000 })).status).toBe(204);
    expect((await student.post(`/api/attempts/${attempt.id}/events`, { type: 'SOMETHING_ELSE' })).status).toBe(422);
    expect((await teacher.get(`/api/attempts/${attempt.id}`)).body.data.events.map((e) => e.type)).toEqual(['STARTED', 'SUSPENDED', 'FOCUS_UNKNOWN', 'PICKER']);
    expect((await teacher.get(`/api/attempts/${attempt.id}`)).body.data).toMatchObject({ status: 'IN_PROGRESS', violationCount: 0 });
  });
});

describe('the teacher decides', () => {
  it('reopens a timed attempt: the time that was left starts when the student continues', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const [student, other] = students;
    const quiz = await quizWith(room, [MC, TF], { timeLimitMinutes: 30, categoryId: await categoryId(cls.id, 'QUIZ') });
    const attempt = await start(student, quiz.id);
    await answer(student, attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });
    // Ten minutes in, the student leaves.
    await prisma.quizAttempt.update({ where: { id: attempt.id }, data: { startedAt: minutesFromNow(-10), deadlineAt: minutesFromNow(20) } });
    expect((await violate(student, attempt)).body.data.outcome).toBe('TERMINATED');
    const view = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(view.terminated.secondsLeft).toBeGreaterThan(20 * 60 - 5);
    expect(view.terminated.secondsLeft).toBeLessThanOrEqual(20 * 60);

    // Only the class teacher, and only an attempt that was ended.
    expect((await student.post(`/api/attempts/${attempt.id}/reopen`, {})).status).toBe(403);
    expect((await other.post(`/api/attempts/${attempt.id}/reopen`, {})).status).toBe(404);
    const outsider = await actor('TEACHER');
    expect((await outsider.post(`/api/attempts/${attempt.id}/reopen`, {})).status).toBe(404);
    expect((await teacher.post(`/api/attempts/${attempt.id}/reopen`, { minutes: 0 })).status).toBe(422);
    expect((await teacher.post(`/api/attempts/${attempt.id}/reopen`, { continueBy: iso(-5) })).body.error.details.fields.continueBy).toMatch(/not passed/);

    const reopened = await teacher.post(`/api/attempts/${attempt.id}/reopen`, { note: 'Brownout in the laboratory' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: 'IN_PROGRESS', terminated: null, violationCount: 0 });
    expect(reopened.body.data.reopened.resumeSeconds).toBeGreaterThan(20 * 60 - 5);
    expect((await teacher.post(`/api/attempts/${attempt.id}/reopen`, {})).body.error.code).toBe('ATTEMPT_NOT_TERMINATED');

    // The grade is no longer a zero while the attempt is open again.
    const entry = await prisma.gradeEntry.findFirst({ where: { studentId: student.user.id, gradeItem: { quizId: quiz.id } } });
    expect(entry).toMatchObject({ score: null, status: 'UNGRADED' });
    const told = await notifications(student.user.id, 'quiz.attempt.reopened');
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/You have 20 minutes from the moment you continue/);
    expect(told[0].body).toContain('Brownout in the laboratory');
    expect(await prisma.auditLog.count({ where: { action: 'quiz.attempt.reopen', entityId: attempt.id, actorId: teacher.user.id } })).toBe(1);

    // Until the student continues, the clock does not run and nothing can be answered.
    const waiting = (await student.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(waiting).toMatchObject({ status: 'REOPENED', questions: null, strictRules: { warnings: 0 } });
    expect(waiting.reopened.seconds).toBe(reopened.body.data.reopened.resumeSeconds);
    expect((await answer(student, attempt, 1, { choiceId: choiceId(attempt, 1, 'True') })).body.error.code).toBe('ATTEMPT_NOT_CONTINUED');
    const summary = (await student.get(`/api/quizzes/${quiz.id}`)).body.data;
    expect(summary).toMatchObject({ myStatus: 'IN_PROGRESS', terminated: null, start: { ok: true, resume: true } });
    expect(summary.reopened.seconds).toBe(waiting.reopened.seconds);
    expect((await row(teacher, quiz.id, student)).attempts[0].reopened).toMatchObject({ waiting: true });
    // A report from before the reopening is not held against the new start.
    expect((await violate(student, attempt, 'LEFT_PAGE', { agoMs: 60_000 })).body.data.outcome).toBe('IGNORED');

    const before = Date.now();
    const cont = await student.post(`/api/quizzes/${quiz.id}/attempts`);
    expect(cont.body.data).toMatchObject({ attemptId: attempt.id, resumed: true });
    const running = (await student.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(running).toMatchObject({ status: 'IN_PROGRESS', reopened: true, rules: { warnings: 0, used: 0 } });
    const left = (new Date(running.deadlineAt).getTime() - before) / 1000;
    expect(left).toBeGreaterThan(20 * 60 - 10);
    expect(left).toBeLessThan(20 * 60 + 10);
    // The earlier answer is still there, and the student can go on.
    expect(running.questions[0].response).toEqual({ choiceId: choiceId(attempt, 0, 'four') });
    expect((await answer(student, attempt, 1, { choiceId: choiceId(attempt, 1, 'True') })).status).toBe(200);
    const done = await student.post(`/api/attempts/${attempt.id}/submit`);
    expect(done.body.data).toMatchObject({ status: 'SUBMITTED', totalScore: 3 });
    const events = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data.events.map((e) => e.type);
    expect(events).toEqual(['STARTED', 'VIOLATION', 'REOPENED', 'CONTINUED', 'SUBMITTED']);
    expect((await row(teacher, quiz.id, student))).toMatchObject({ status: 'GRADED', score: 3 });
  });

  it('reopens with a time of its own, and the rules count again from the start', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { timeLimitMinutes: 30, violationWarnings: 1 });
    const attempt = await start(student, quiz.id);
    await violate(student, attempt, 'COPY');
    expect((await violate(student, attempt, 'COPY')).body.data.outcome).toBe('TERMINATED');
    const reopened = await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, { minutes: 5, continueBy: iso(60) });
    expect(reopened.body.data.reopened.resumeSeconds).toBe(300);
    expect(Math.abs(new Date(reopened.body.data.deadlineAt).getTime() - minutesFromNow(60).getTime())).toBeLessThan(5000);
    await student.post(`/api/quizzes/${quiz.id}/attempts`);
    const running = (await student.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(running.rules).toEqual({ warnings: 1, used: 0 });
    expect((new Date(running.deadlineAt).getTime() - Date.now()) / 1000).toBeLessThan(301);
    // One warning again, then the end — and it can be reopened once more.
    expect((await violate(student, attempt, 'PRINT')).body.data).toMatchObject({ outcome: 'WARNING', number: 1 });
    expect((await violate(student, attempt, 'PRINT')).body.data).toMatchObject({ outcome: 'TERMINATED', number: 2 });
    expect((await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, {})).status).toBe(200);
  });

  it('hands a reopened attempt in when the student does not continue in time', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC, TF], { timeLimitMinutes: 30 });
    const attempt = await start(student, quiz.id);
    await answer(student, attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });
    await violate(student, attempt);
    expect((await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, { continueBy: iso(30) })).status).toBe(200);
    await prisma.quizAttempt.update({ where: { id: attempt.id }, data: { deadlineAt: minutesFromNow(-1) } });
    expect(await autoSubmitOverdue()).toBeGreaterThanOrEqual(1);
    const closed = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    // An ordinary hand-in with the answers it had: the violation was forgiven by reopening.
    expect(closed).toMatchObject({ status: 'AUTO_SUBMITTED', terminatedAt: null, totalScore: 2 });
    expect((await student.get(`/api/attempts/${attempt.id}`)).body.data).toMatchObject({ status: 'SUBMITTED', autoSubmitted: true, totalScore: 2 });
  });

  it('needs a time to continue by once the quiz has closed, and no timer for an untimed quiz', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { availableUntil: iso(60) });
    const attempt = await start(student, quiz.id);
    await violate(student, attempt, 'CLOSED_PAGE');
    // While the quiz is open: no timer, and the attempt runs until the quiz closes.
    const open = await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, {});
    expect(open.body.data.reopened.resumeSeconds).toBeNull();
    expect(new Date(open.body.data.deadlineAt).getTime()).toBe(new Date(quiz.availableUntil).getTime());
    // No clock is waiting, so the questions are there at once.
    const running = (await student.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(running).toMatchObject({ status: 'IN_PROGRESS', reopened: true });
    expect(running.questions).toHaveLength(1);

    await violate(student, attempt, 'CLOSED_PAGE');
    await prisma.quiz.update({ where: { id: quiz.id }, data: { availableUntil: minutesFromNow(-5) } });
    const closed = await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, {});
    expect(closed.status).toBe(422);
    expect(closed.body.error.details.fields.continueBy).toMatch(/has closed/);
    const given = await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, { continueBy: iso(120), minutes: 15 });
    expect(given.status).toBe(200);
    expect(given.body.data.reopened.resumeSeconds).toBe(900);
    // The student can continue although the quiz itself has closed.
    expect((await student.get(`/api/quizzes/${quiz.id}`)).body.data.start).toMatchObject({ ok: true, resume: true });
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`)).body.data.resumed).toBe(true);
  });

  it('counts the answers of an ended attempt, which then waits for the essay like any other', async () => {
    const room = await classroom(1);
    const { teacher, cls } = room;
    const student = room.students[0];
    const quiz = await quizWith(room, [MC, ESSAY], { categoryId: await categoryId(cls.id, 'QUIZ') });
    const attempt = await start(student, quiz.id);
    await answer(student, attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });
    await answer(student, attempt, 1, { text: 'A function that calls itself.' });
    await violate(student, attempt, 'PASTE');
    expect((await row(teacher, quiz.id, student))).toMatchObject({ status: 'TERMINATED', score: 0 });

    expect((await student.post(`/api/attempts/${attempt.id}/count-answers`, {})).status).toBe(403);
    const counted = await teacher.post(`/api/attempts/${attempt.id}/count-answers`, { note: 'She pasted her own draft' });
    expect(counted.status).toBe(200);
    expect(counted.body.data).toMatchObject({ status: 'SUBMITTED', terminated: null, autoScore: 2, needsManualGrading: true });
    expect((await teacher.post(`/api/attempts/${attempt.id}/count-answers`, {})).body.error.code).toBe('ATTEMPT_NOT_TERMINATED');
    expect((await teacher.post(`/api/attempts/${attempt.id}/reopen`, {})).body.error.code).toBe('ATTEMPT_NOT_TERMINATED');
    expect((await row(teacher, quiz.id, student)).status).toBe('NEEDS_GRADING');

    const graded = await teacher.put(`/api/attempts/${attempt.id}/answers/1/grade`, { score: 4 });
    expect(graded.body.data).toMatchObject({ status: 'GRADED', totalScore: 6 });
    const entry = await prisma.gradeEntry.findFirst({ where: { studentId: student.user.id, gradeItem: { quizId: quiz.id } } });
    expect(entry.status).toBe('GRADED');
    expect((await student.get(`/api/attempts/${attempt.id}`)).body.data).toMatchObject({ status: 'SUBMITTED', autoSubmitted: false, totalScore: 6 });
    expect((await teacher.get(`/api/attempts/${attempt.id}`)).body.data.events.map((e) => e.type)).toEqual(['STARTED', 'VIOLATION', 'COUNTED']);
    const told = await notifications(student.user.id, 'quiz.attempt.counted');
    expect(told[0].body).toContain('She pasted her own draft');
    expect(await prisma.auditLog.count({ where: { action: 'quiz.attempt.count', entityId: attempt.id } })).toBe(1);
    // The student is no longer held back: with attempts left, another can be started.
    expect((await student.get(`/api/quizzes/${quiz.id}`)).body.data.start.code).toBe('NO_ATTEMPTS_LEFT');
  });

  it('removes an ended attempt so that the student can start afresh', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);
    await violate(student, attempt);
    expect((await student.get(`/api/quizzes/${quiz.id}`)).body.data.start.ok).toBe(false);
    expect((await room.teacher.delete(`/api/attempts/${attempt.id}`, { reason: 'Phone call from a parent' })).status).toBe(204);
    const summary = (await student.get(`/api/quizzes/${quiz.id}`)).body.data;
    expect(summary).toMatchObject({ myStatus: 'NOT_STARTED', terminated: null, start: { ok: true } });
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true })).status).toBe(201);
  });

  it('keeps an ended attempt in the way of the next one, whichever attempt counts', async () => {
    const room = await classroom(1);
    const { teacher, cls } = room;
    const student = room.students[0];
    const quiz = await quizWith(room, [MC], { maxAttempts: 3, attemptScoring: 'HIGHEST', categoryId: await categoryId(cls.id, 'QUIZ') });
    const first = await start(student, quiz.id);
    await answer(student, first, 0, { choiceId: choiceId(first, 0, 'four') });
    await student.post(`/api/attempts/${first.id}/submit`);
    const second = await start(student, quiz.id);
    await violate(student, second);
    // The first attempt still counts (highest), but the student cannot walk on to a third.
    expect((await row(teacher, quiz.id, student))).toMatchObject({ status: 'TERMINATED', score: 2, percent: 100 });
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true })).body.error.code).toBe('TERMINATED');
    // Another student is not affected.
    const other = await actor('STUDENT');
    await enroll(cls, other.user);
    expect((await other.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true })).status).toBe(201);

    expect((await teacher.post(`/api/attempts/${second.id}/count-answers`, {})).status).toBe(200);
    expect((await student.post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true })).status).toBe(201);
  });

  it('cannot decide in an archived class', async () => {
    const room = await classroom(1);
    const student = room.students[0];
    const quiz = await quizWith(room, [MC]);
    const attempt = await start(student, quiz.id);
    await violate(student, attempt);
    await prisma.class.update({ where: { id: room.cls.id }, data: { status: 'ARCHIVED' } });
    expect((await room.teacher.post(`/api/attempts/${attempt.id}/reopen`, {})).body.error.code).toBe('CLASS_ARCHIVED');
    expect((await room.teacher.post(`/api/attempts/${attempt.id}/count-answers`, {})).body.error.code).toBe('CLASS_ARCHIVED');
  });
});
