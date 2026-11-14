import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, defaultScale, minutesFromNow, prepare, prisma } from '../helpers/index.js';
import { autoSubmitOverdue } from '../../src/modules/quizzes/routes.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const iso = (m) => minutesFromNow(m).toISOString();
const MC = { type: 'MULTIPLE_CHOICE', text: '<p>2 + 2 = ?</p>', points: 2, explanation: 'KEY-EXPLANATION', choices: [{ text: 'three' }, { text: 'four', isCorrect: true }, { text: 'five' }] };
const TF = { type: 'TRUE_FALSE', text: '<p>The sun is a star.</p>', points: 1, answer: true };
const ID = { type: 'IDENTIFICATION', text: '<p>Capital of the Philippines?</p>', points: 2, accepted: ['Manila'] };
const ESSAY = { type: 'ESSAY', text: '<p>Explain recursion.</p>', points: 5 };

/** A published quiz with the given questions. */
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
  // Quizzes have strict rules unless the teacher switches them off; starting accepts them.
  const res = await student.post(`/api/quizzes/${quizId}/attempts`, { acceptRules: true });
  expect([200, 201]).toContain(res.status);
  const attempt = (await student.get(`/api/attempts/${res.body.data.attemptId}`)).body.data;
  return attempt;
}
const answer = (student, attempt, position, response, extra = {}) => student.put(`/api/attempts/${attempt.id}/answers/${position}`, { response, ...extra });
const choiceId = (attempt, position, text) => attempt.questions[position].question.choices.find((c) => c.text === text).id;

describe('question banks', () => {
  it('store questions privately for their teacher', async () => {
    const teacher = await actor('TEACHER');
    const other = await actor('TEACHER');
    const student = await actor('STUDENT');
    const bank = await teacher.post('/api/question-banks', { title: 'IT 101', subject: 'Computing' });
    expect(bank.status).toBe(201);
    const id = bank.body.data.id;
    const q = await teacher.post(`/api/question-banks/${id}/questions`, { ...MC, topic: 'Arithmetic', text: '<p>2 + 2 = ?</p><script>x()</script>' });
    expect(q.status).toBe(201);
    expect(q.body.data.text).toBe('<p>2 + 2 = ?</p>');
    const bad = await teacher.post(`/api/question-banks/${id}/questions`, { ...MC, choices: [{ text: 'only one', isCorrect: true }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors[0]).toMatch(/at least two choices/);

    const bulk = await teacher.post(`/api/question-banks/${id}/questions/bulk`, { questions: [TF, { ...ID, accepted: [] }] });
    expect(bulk.status).toBe(422);
    expect(bulk.body.error.details.questions).toEqual([{ index: 1, errors: ['Give at least one accepted answer.'] }]);
    expect((await teacher.post(`/api/question-banks/${id}/questions/bulk`, { questions: [TF, ID] })).body.data.saved).toBe(2);

    const list = await teacher.get(`/api/question-banks/${id}/questions?type=MULTIPLE_CHOICE`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ total: 1, topics: ['Arithmetic'] });
    expect((await teacher.get('/api/question-banks')).body.data[0]).toMatchObject({ questionCount: 3, byType: { MULTIPLE_CHOICE: 1, TRUE_FALSE: 1, IDENTIFICATION: 1 } });

    const edited = await teacher.put(`/api/question-banks/questions/${q.body.data.id}`, { ...TF, answer: false });
    expect(edited.body.data).toMatchObject({ type: 'TRUE_FALSE', answer: false });

    for (const who of [other, student]) {
      const code = who === student ? 403 : 404;
      expect((await who.get(`/api/question-banks/${id}/questions`)).status).toBe(code);
      expect((await who.post(`/api/question-banks/${id}/questions`, MC)).status).toBe(code);
      expect((await who.put(`/api/question-banks/questions/${q.body.data.id}`, MC)).status).toBe(code);
      expect((await who.delete(`/api/question-banks/questions/${q.body.data.id}`)).status).toBe(code);
    }
    expect((await other.get('/api/question-banks')).body.data).toHaveLength(0);
  });

  it('previews an imported paper without saving anything', async () => {
    const teacher = await actor('TEACHER');
    const id = (await teacher.post('/api/question-banks', { title: 'Import' })).body.data.id;
    const paper = '1. 2 + 2 = ?\nA. 3\nB. 4\nAnswer: B\n\n2. The earth is flat.\nAnswer: False\n\n3. No answer here\nA. x\nB. y\n';
    const pasted = await teacher.post(`/api/question-banks/${id}/import/preview`, { text: paper });
    expect(pasted.status).toBe(200);
    expect(pasted.body.data.summary).toMatchObject({ found: 3, ready: 2, needsReview: 1 });
    expect(pasted.body.data.questions[2].errors).toEqual(['Mark the correct choice.']);
    expect(await prisma.question.count({ where: { bankId: id } })).toBe(0);

    const file = await teacher.agent.post(`/api/question-banks/${id}/import/preview`).set('X-CSRF-Token', teacher.csrf).attach('file', Buffer.from(paper), 'midterm.txt');
    expect(file.status).toBe(200);
    expect(file.body.data).toMatchObject({ source: 'midterm.txt', summary: { found: 3 } });
    const exe = await teacher.agent.post(`/api/question-banks/${id}/import/preview`).set('X-CSRF-Token', teacher.csrf).attach('file', Buffer.from('MZ'), 'paper.exe');
    expect(exe.status).toBe(422);
    expect(exe.body.error.code).toBe('IMPORT_UNREADABLE');
    expect((await teacher.post(`/api/question-banks/${id}/import/preview`, { text: '  ' })).status).toBe(422);

    // The teacher fixes the third question and saves; a second import then flags the duplicates.
    const fixed = pasted.body.data.questions.map((q, i) => (i === 2 ? { ...q, choices: [{ text: 'x', isCorrect: true }, { text: 'y' }] } : q));
    expect((await teacher.post(`/api/question-banks/${id}/questions/bulk`, { questions: fixed })).body.data.saved).toBe(3);
    const again = await teacher.post(`/api/question-banks/${id}/import/preview`, { text: paper });
    expect(again.body.data.questions[0].warnings.join(' ')).toMatch(/already in this bank/);
  });
});

describe('building a quiz', () => {
  it('cannot be published empty, and totals its points into the gradebook', async () => {
    const room = await classroom(1);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    expect((await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Empty', status: 'PUBLISHED' })).body.error.code).toBe('QUIZ_EMPTY');
    const made = await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Quiz 1', categoryId: category, timeLimitMinutes: 20 });
    const id = made.body.data.id;
    expect((await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' })).body.error.code).toBe('QUIZ_EMPTY');
    expect((await students[0].get(`/api/quizzes/${id}`)).status).toBe(404);
    expect((await students[0].post(`/api/quizzes/${id}/attempts`)).status).toBe(404);

    await teacher.post(`/api/quizzes/${id}/questions`, { question: MC });
    const two = await teacher.post(`/api/quizzes/${id}/questions`, { question: ESSAY });
    expect(two.body.data).toMatchObject({ questionCount: 2, totalPoints: 7 });
    const reordered = await teacher.put(`/api/quizzes/${id}/questions`, { items: [{ questionId: two.body.data.questions[1].id, points: 8 }, { questionId: two.body.data.questions[0].id, points: 2 }] });
    expect(reordered.body.data.questions.map((q) => [q.type, q.points])).toEqual([['ESSAY', 8], ['MULTIPLE_CHOICE', 2]]);
    const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    expect(book.structure.periods[0].categories.find((c) => c.id === category).items[0]).toMatchObject({ title: 'Quiz 1', maxPoints: 10, source: 'QUIZ' });

    expect((await teacher.patch(`/api/quizzes/${id}`, { availableFrom: iso(60), availableUntil: iso(30) })).status).toBe(422);
    expect((await teacher.patch(`/api/quizzes/${id}`, { resultVisibility: 'AFTER_CLOSE' })).status).toBe(422);
    expect((await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'quiz.published' } })).toBe(1);

    // Another teacher's questions cannot be pulled in.
    const other = await actor('TEACHER');
    const theirBank = (await other.post('/api/question-banks', { title: 'Theirs' })).body.data.id;
    const theirs = (await other.post(`/api/question-banks/${theirBank}/questions`, MC)).body.data.id;
    const copy = await teacher.post(`/api/quizzes/${id}/copy`, {});
    expect(copy.body.data).toMatchObject({ status: 'DRAFT', title: 'Quiz 1 (copy)', questionCount: 2 });
    expect((await teacher.put(`/api/quizzes/${copy.body.data.id}/questions`, { items: [{ questionId: theirs, points: 1 }] })).status).toBe(422);
    for (const [who, code] of [[students[0], 403], [other, 404]]) {
      expect((await who.patch(`/api/quizzes/${id}`, { title: 'x' })).status).toBe(code);
      expect((await who.put(`/api/quizzes/${id}/questions`, { items: [] })).status).toBe(code);
      expect((await who.get(`/api/quizzes/${id}/results`)).status).toBe(code);
      expect((await who.get(`/api/quizzes/${id}/analysis`)).status).toBe(code);
      expect((await who.delete(`/api/quizzes/${id}`)).status).toBe(code);
    }
  });

  it('draws random questions from a pool, differently per student', async () => {
    const room = await classroom(6);
    const { teacher, cls, students } = room;
    const bank = (await teacher.post('/api/question-banks', { title: 'Pool' })).body.data.id;
    const questions = Array.from({ length: 12 }, (_, i) => ({ ...ID, text: `<p>Question number ${i}</p>`, topic: i < 10 ? 'Loops' : 'Other' }));
    await teacher.post(`/api/question-banks/${bank}/questions/bulk`, { questions });
    const id = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Random', resultVisibility: 'IMMEDIATE' })).body.data.id;
    const tooMany = await teacher.put(`/api/quizzes/${id}/pools`, { pools: [{ bankId: bank, topic: 'Other', count: 3, pointsEach: 1 }] });
    expect(tooMany.status).toBe(422);
    const pooled = await teacher.put(`/api/quizzes/${id}/pools`, { pools: [{ bankId: bank, topic: 'Loops', count: 4, pointsEach: 2.5 }] });
    expect(pooled.body.data).toMatchObject({ questionCount: 4, totalPoints: 10 });
    await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' });

    const papers = [];
    for (const s of students) {
      const attempt = await start(s, id);
      expect(attempt.questions).toHaveLength(4);
      expect(attempt.maxScore).toBe(10);
      expect(new Set(attempt.questions.map((q) => q.question.text)).size).toBe(4);
      expect(attempt.questions.every((q) => !q.question.text.includes('number 10') && !q.question.text.includes('number 11'))).toBe(true);
      papers.push(attempt.questions.map((q) => q.question.text).join('|'));
    }
    expect(new Set(papers).size).toBeGreaterThan(1);
  });
});

describe('taking a quiz', () => {
  it('never sends the answer key, autosaves, scores on submit and reaches the gradebook', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    const quiz = await quizWith(room, [MC, TF, ID], { categoryId: category });

    const summary = (await students[0].get(`/api/quizzes/${quiz.id}`)).body.data;
    expect(summary).toMatchObject({ myStatus: 'NOT_STARTED', questionCount: 3, totalPoints: 5, start: { ok: true, resume: false } });
    expect(JSON.stringify(summary)).not.toMatch(/four|Manila|KEY-EXPLANATION|isCorrect/);

    const attempt = await start(students[0], quiz.id);
    expect(attempt).toMatchObject({ status: 'IN_PROGRESS', maxScore: 5, deadlineAt: null });
    const wire = JSON.stringify(attempt);
    expect(wire).not.toMatch(/isCorrect|answerKey|KEY-EXPLANATION|Manila|"accepted"|"correct"|"score"/);
    // Starting again resumes the same attempt.
    const resumed = await students[0].post(`/api/quizzes/${quiz.id}/attempts`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toEqual({ attemptId: attempt.id, resumed: true });

    expect((await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, 'four') })).status).toBe(200);
    await answer(students[0], attempt, 1, { choiceId: choiceId(attempt, 1, 'False') }, { flagged: true });
    await answer(students[0], attempt, 2, { text: ' manila ' });
    // Forged or malformed answers are dropped, not stored.
    const forged = await answer(students[0], attempt, 0, { choiceId: 'not-a-choice', isCorrect: true, score: 99 });
    expect(forged.body.data.answered).toBe(false);
    await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });
    expect((await answer(students[0], attempt, 9, { text: 'x' })).status).toBe(404);

    const reloaded = (await students[0].get(`/api/attempts/${attempt.id}`)).body.data;
    expect(reloaded.questions.map((q) => [q.answered, q.flagged])).toEqual([[true, false], [true, true], [true, false]]);
    expect(reloaded.questions[2].response).toEqual({ text: 'manila' });

    const done = await students[0].post(`/api/attempts/${attempt.id}/submit`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'SUBMITTED', autoSubmitted: false, resultsVisible: true, awaitingGrading: false, totalScore: 4, percent: 80 });
    expect(done.body.data.questions.map((q) => [q.score, q.isCorrect])).toEqual([[2, true], [0, false], [2, true]]);
    // answerVisibility = RESPONSES: correctness, but not the key.
    expect(JSON.stringify(done.body.data)).not.toMatch(/KEY-EXPLANATION|"correct":/);

    // Submitting twice changes nothing; a finished attempt accepts no more answers.
    expect((await students[0].post(`/api/attempts/${attempt.id}/submit`)).body.data.totalScore).toBe(4);
    expect((await answer(students[0], attempt, 1, { choiceId: choiceId(attempt, 1, 'True') })).body.error.code).toBe('ATTEMPT_CLOSED');
    expect((await students[0].post(`/api/quizzes/${quiz.id}/attempts`)).body.error.code).toBe('NO_ATTEMPTS_LEFT');
    expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id, studentId: students[0].user.id } })).toBe(1);

    const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    const item = book.structure.periods[0].categories.find((c) => c.id === category).items[0];
    expect(book.students.find((s) => s.id === students[0].user.id).entries[item.id]).toMatchObject({ score: 4, status: 'GRADED' });

    // Attempts are private to their student.
    expect((await students[1].get(`/api/attempts/${attempt.id}`)).status).toBe(404);
    expect((await students[1].put(`/api/attempts/${attempt.id}/answers/0`, { response: { text: 'x' } })).status).toBe(404);
    expect((await students[1].post(`/api/attempts/${attempt.id}/submit`)).status).toBe(404);
    expect((await (await actor('TEACHER')).get(`/api/attempts/${attempt.id}`)).status).toBe(404);
    expect((await teacher.post(`/api/quizzes/${quiz.id}/attempts`)).status).toBe(403);
  });

  it('starts one attempt only, even on a double click', async () => {
    const room = await classroom(1);
    const quiz = await quizWith(room, [TF]);
    const results = await Promise.all(Array.from({ length: 5 }, () => room.students[0].post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true })));
    expect(new Set(results.map((r) => r.body.data.attemptId)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id } })).toBe(1);
  });

  it('enforces the availability window', async () => {
    const room = await classroom(1);
    const { students } = room;
    const future = await quizWith(room, [TF], { availableFrom: iso(60), availableUntil: iso(120) });
    expect((await students[0].post(`/api/quizzes/${future.id}/attempts`)).body.error.code).toBe('NOT_OPEN');
    const past = await quizWith(room, [TF], { title: 'Past', availableUntil: iso(60) });
    await prisma.quiz.update({ where: { id: past.id }, data: { availableUntil: minutesFromNow(-1) } });
    expect((await students[0].post(`/api/quizzes/${past.id}/attempts`)).body.error.code).toBe('CLOSED');
    expect((await students[0].get(`/api/quizzes/${past.id}`)).body.data.myStatus).toBe('MISSING');
  });

  it('keeps time on the server and submits automatically when it runs out', async () => {
    const room = await classroom(2);
    const { students } = room;
    const quiz = await quizWith(room, [MC, TF], { timeLimitMinutes: 10, availableUntil: iso(5) });
    const attempt = await start(students[0], quiz.id);
    // The quiz closes before the time limit would end: the earlier instant is the deadline.
    const deadline = new Date(attempt.deadlineAt).getTime();
    expect(Math.abs(deadline - minutesFromNow(5).getTime())).toBeLessThan(5_000);
    expect(new Date(attempt.serverTime).getTime()).toBeLessThanOrEqual(Date.now());
    await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });

    // Time runs out (the student's device clock is irrelevant).
    await prisma.quizAttempt.update({ where: { id: attempt.id }, data: { deadlineAt: minutesFromNow(-1) } });
    const late = await answer(students[0], attempt, 1, { choiceId: choiceId(attempt, 1, 'True') });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('TIME_UP');
    const result = (await students[0].get(`/api/attempts/${attempt.id}`)).body.data;
    expect(result).toMatchObject({ status: 'SUBMITTED', autoSubmitted: true, totalScore: 2 }); // only what was saved in time counts
    const row = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    expect(row.submittedAt.getTime()).toBe(row.deadlineAt.getTime());

    // A student who walked away is submitted by the background job.
    const second = await start(students[1], quiz.id);
    await prisma.quizAttempt.update({ where: { id: second.id }, data: { deadlineAt: minutesFromNow(-1) } });
    expect(await autoSubmitOverdue()).toBeGreaterThanOrEqual(1);
    expect((await prisma.quizAttempt.findUnique({ where: { id: second.id } })).status).toBe('AUTO_SUBMITTED');
    expect(await autoSubmitOverdue()).toBe(0);
  });

  it('allows several attempts and counts them by the chosen rule', async () => {
    const room = await classroom(1);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    const quiz = await quizWith(room, [TF, ID], { maxAttempts: 2, attemptScoring: 'HIGHEST', categoryId: category });
    const take = async (right) => {
      const attempt = await start(students[0], quiz.id);
      await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, right ? 'True' : 'False') });
      await answer(students[0], attempt, 1, { text: 'Manila' });
      return (await students[0].post(`/api/attempts/${attempt.id}/submit`)).body.data;
    };
    expect((await take(true)).totalScore).toBe(3);
    expect((await take(false)).totalScore).toBe(2);
    const entry = async () => {
      const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
      const item = book.structure.periods[0].categories.find((c) => c.id === category).items[0];
      return book.students[0].entries[item.id].score;
    };
    expect(await entry()).toBe(3);
    expect((await students[0].get(`/api/quizzes/${quiz.id}`)).body.data).toMatchObject({ attemptsUsed: 2, score: 3, percent: 100, start: { ok: false, code: 'NO_ATTEMPTS_LEFT' } });
    await teacher.patch(`/api/quizzes/${quiz.id}`, { attemptScoring: 'LATEST' });
    expect(await entry()).toBe(2);
    await teacher.patch(`/api/quizzes/${quiz.id}`, { attemptScoring: 'AVERAGE' });
    expect(await entry()).toBe(2.5);
    // Once taken, the questions are frozen.
    expect((await teacher.put(`/api/quizzes/${quiz.id}/questions`, { items: [] })).body.error.code).toBe('QUIZ_HAS_ATTEMPTS');
    expect((await teacher.post(`/api/quizzes/${quiz.id}/questions`, { question: MC })).body.error.code).toBe('QUIZ_HAS_ATTEMPTS');
  });
});

describe('results and manual grading', () => {
  it('waits for the teacher on essays, then completes the score', async () => {
    const room = await classroom(1);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    const quiz = await quizWith(room, [MC, ESSAY], { categoryId: category });
    const attempt = await start(students[0], quiz.id);
    await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, 'four') });
    await answer(students[0], attempt, 1, { text: 'A function that calls itself.' });
    const submitted = (await students[0].post(`/api/attempts/${attempt.id}/submit`)).body.data;
    expect(submitted).toMatchObject({ awaitingGrading: true, totalScore: null, percent: null });

    const results = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    expect(results.students[0]).toMatchObject({ status: 'NEEDS_GRADING', score: null });
    expect(results.stats).toMatchObject({ submitted: 1, needsGrading: 1 });
    expect((await teacher.get(`/api/classes/${cls.id}/quizzes`)).body.data[0].stats.toGrade).toBe(1);

    const review = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(review.questions[0]).toMatchObject({ isCorrect: true, explanation: 'KEY-EXPLANATION' });
    expect(review.questions[1]).toMatchObject({ needsManual: true, response: { text: 'A function that calls itself.' } });
    expect(review.events.map((e) => e.type)).toEqual(['STARTED', 'SUBMITTED']);

    expect((await teacher.put(`/api/attempts/${attempt.id}/answers/1/grade`, { score: 6 })).status).toBe(422);
    expect((await students[0].put(`/api/attempts/${attempt.id}/answers/1/grade`, { score: 5 })).status).toBe(403);
    const graded = await teacher.put(`/api/attempts/${attempt.id}/answers/1/grade`, { score: 4, feedback: 'Mention the base case.' });
    expect(graded.body.data).toMatchObject({ status: 'GRADED', totalScore: 6, needsManualGrading: false });

    const mine = (await students[0].get(`/api/attempts/${attempt.id}`)).body.data;
    expect(mine).toMatchObject({ awaitingGrading: false, totalScore: 6, percent: 85.7 });
    expect(mine.questions[1]).toMatchObject({ score: 4, feedback: 'Mention the base case.' });
    const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    const item = book.structure.periods[0].categories.find((c) => c.id === category).items[0];
    expect(book.students[0].entries[item.id]).toMatchObject({ score: 6, status: 'GRADED' });

    // Overruling an automatically scored answer leaves a trace.
    await teacher.put(`/api/attempts/${attempt.id}/answers/0/grade`, { score: 1 });
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'quiz.answer.override' } })).toBe(1);
  });

  it('releases scores and answers according to the quiz settings', async () => {
    const room = await classroom(1);
    const { teacher, students } = room;
    const quiz = await quizWith(room, [MC], { resultVisibility: 'MANUAL', answerVisibility: 'CORRECT_ANSWERS', availableUntil: iso(60) });
    const attempt = await start(students[0], quiz.id);
    await answer(students[0], attempt, 0, { choiceId: choiceId(attempt, 0, 'three') });
    const hidden = (await students[0].post(`/api/attempts/${attempt.id}/submit`)).body.data;
    expect(hidden).toMatchObject({ resultsVisible: false, totalScore: null, questions: null });
    expect((await students[0].get(`/api/quizzes/${quiz.id}`)).body.data).toMatchObject({ submitted: true, score: null, percent: null });
    expect(JSON.stringify(hidden)).not.toMatch(/KEY-EXPLANATION/);

    expect((await students[0].post(`/api/quizzes/${quiz.id}/results/publish`, {})).status).toBe(403);
    expect((await teacher.post(`/api/quizzes/${quiz.id}/results/publish`, {})).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'quiz.results' } })).toBe(1);
    // Released, but the quiz is still open to others: scores and responses, not yet the key.
    let shown = (await students[0].get(`/api/attempts/${attempt.id}`)).body.data;
    expect(shown).toMatchObject({ resultsVisible: true, totalScore: 0, answersPending: true });
    expect(shown.questions[0].correct).toBeUndefined();
    await prisma.quiz.update({ where: { id: quiz.id }, data: { availableUntil: minutesFromNow(-1) } });
    shown = (await students[0].get(`/api/attempts/${attempt.id}`)).body.data;
    expect(shown.questions[0]).toMatchObject({ isCorrect: false, explanation: 'KEY-EXPLANATION' });
    expect(shown.questions[0].correct.choiceId).toBe(choiceId(attempt, 0, 'four'));

    await teacher.post(`/api/quizzes/${quiz.id}/results/withhold`, {});
    expect((await students[0].get(`/api/attempts/${attempt.id}`)).body.data.totalScore).toBeNull();
  });

  it('lets the teacher void an attempt with a reason, analyse items and export results', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const quiz = await quizWith(room, [MC, TF]);
    for (const [i, pick] of [['four', 'True'], ['three', 'True']].entries()) {
      const attempt = await start(students[i], quiz.id);
      await answer(students[i], attempt, 0, { choiceId: choiceId(attempt, 0, pick[0]) });
      await answer(students[i], attempt, 1, { choiceId: choiceId(attempt, 1, pick[1]) });
      await students[i].post(`/api/attempts/${attempt.id}/submit`);
    }
    const analysis = (await teacher.get(`/api/quizzes/${quiz.id}/analysis`)).body.data;
    expect(analysis.map((a) => [a.type, a.responses, a.correctPercent])).toEqual([['MULTIPLE_CHOICE', 2, 50], ['TRUE_FALSE', 2, 100]]);
    expect(analysis[0].choices).toEqual(expect.arrayContaining([{ text: 'four', isCorrect: true, count: 1 }, { text: 'three', isCorrect: false, count: 1 }]));

    const csv = await teacher.get(`/api/quizzes/${quiz.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Student No.,Name,Attempts,Score,%,Status,Submitted');
    expect(csv.text).toMatch(/,1,3,100,Graded,/);

    const results = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    const victim = results.students.find((s) => s.student.id === students[1].user.id).attempts[0].id;
    expect((await teacher.delete(`/api/attempts/${victim}`, {})).status).toBe(422);
    expect((await students[1].delete(`/api/attempts/${victim}`, { reason: 'Let me try again please' })).status).toBe(403);
    expect((await teacher.delete(`/api/attempts/${victim}`, { reason: 'Power interruption during the quiz' })).status).toBe(204);
    expect((await students[1].get(`/api/quizzes/${quiz.id}`)).body.data).toMatchObject({ attemptsUsed: 0, start: { ok: true } });
    const log = await prisma.auditLog.findFirst({ where: { classId: cls.id, action: 'quiz.attempt.void' } });
    expect(log.summary).toContain('Power interruption');
  });
});
