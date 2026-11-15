// Two promises of a quiz:
//   • the system marks every answer that has an answer key, at once — the teacher is left with
//     essays, files, and the few short answers that the system cannot decide;
//   • a quiz is taken part by part, and shuffling changes the order inside each part only.
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, defaultScale, prepare, prisma } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const mc = (n, extra = {}) => ({ type: 'MULTIPLE_CHOICE', text: `<p>MC ${n}</p>`, points: 1, choices: [{ text: 'right', isCorrect: true }, { text: 'wrong' }, { text: 'also wrong' }], ...extra });
const tf = (n, extra = {}) => ({ type: 'TRUE_FALSE', text: `<p>TF ${n}</p>`, points: 1, answer: true, ...extra });
const ident = (n, extra = {}) => ({ type: 'IDENTIFICATION', text: `<p>ID ${n}</p>`, points: 2, accepted: ['Manila'], ...extra });
const essay = (n, extra = {}) => ({ type: 'ESSAY', text: `<p>ESSAY ${n}</p>`, points: 5, ...extra });
const short = (n, extra = {}) => ({ type: 'SHORT_ANSWER', text: `<p>SHORT ${n}</p>`, points: 2, accepted: ['gravity'], ...extra });

/** A published quiz with the given questions, added in this order. */
async function quizWith(room, questions, settings = {}) {
  const { teacher, cls } = room;
  const created = await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Quiz', resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', strictMode: false, ...settings });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  for (const question of questions) expect((await teacher.post(`/api/quizzes/${id}/questions`, { question })).status).toBe(201);
  const published = await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' });
  expect(published.status).toBe(200);
  return published.body.data;
}

async function start(student, quizId) {
  const res = await student.post(`/api/quizzes/${quizId}/attempts`, {});
  expect([200, 201]).toContain(res.status);
  return (await student.get(`/api/attempts/${res.body.data.attemptId}`)).body.data;
}
const label = (q) => q.question.text.replace(/<[^>]*>/g, '');
/** Answer the question with this text, wherever it stands in the attempt. */
async function answer(student, attempt, text, response) {
  const position = attempt.questions.find((q) => label(q) === text).position;
  expect((await student.put(`/api/attempts/${attempt.id}/answers/${position}`, { response })).status).toBe(200);
}
const submit = async (student, attempt) => (await student.post(`/api/attempts/${attempt.id}/submit`)).body.data;
const byText = (view, text) => view.questions.find((q) => label(q) === text);

describe('a quiz is taken part by part', () => {
  it('shuffles inside each part and keeps the parts in the teacher’s order', async () => {
    const room = await classroom(8);
    const { teacher, students } = room;
    const one = 'Part I. Multiple Choice';
    const two = 'Part II. True or False';
    const quiz = await quizWith(room, [
      mc(1, { section: one }), mc(2, { section: one }), mc(3, { section: one }), mc(4, { section: one }), mc(5, { section: one }),
      tf(1, { section: two }), tf(2, { section: two }), tf(3, { section: two }), tf(4, { section: two }),
      ident(1), ident(2), ident(3), ident(4),
      essay(1, { section: 'Part IV. Essay' }), essay(2, { section: 'Part IV. Essay' }),
      // Written last and without a part name: it still belongs with the other multiple-choice questions.
      mc(6),
    ], { shuffleQuestions: true, shuffleChoices: true });

    // The teacher sees the quiz as students get it.
    const expected = [{ title: 'Multiple Choice', first: 0, count: 6, points: 6 }, { title: 'True or False', first: 6, count: 4, points: 4 }, { title: 'Identification', first: 10, count: 4, points: 8 }, { title: 'Essay', first: 14, count: 2, points: 10 }];
    expect(quiz.parts).toEqual(expected);
    expect(quiz.keptInParts).toBe(true);
    expect(quiz.questions.map((q) => q.part)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    expect(quiz.questions.map((q) => q.text.replace(/<[^>]*>/g, '')).slice(0, 6)).toEqual(['MC 1', 'MC 2', 'MC 3', 'MC 4', 'MC 5', 'MC 6']);

    const orders = [];
    let last;
    for (const student of students) {
      const attempt = await start(student, quiz.id);
      last = attempt;
      expect(attempt.parts).toEqual(expected);
      expect(attempt.questions.map((q) => q.part)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
      const texts = attempt.questions.map(label);
      // Every part holds its own questions and nothing else…
      expect(texts.slice(0, 6).sort()).toEqual(['MC 1', 'MC 2', 'MC 3', 'MC 4', 'MC 5', 'MC 6']);
      expect(texts.slice(6, 10).sort()).toEqual(['TF 1', 'TF 2', 'TF 3', 'TF 4']);
      expect(texts.slice(10, 14).sort()).toEqual(['ID 1', 'ID 2', 'ID 3', 'ID 4']);
      expect(texts.slice(14).sort()).toEqual(['ESSAY 1', 'ESSAY 2']);
      orders.push(texts.join('|'));
      // …and the student is not told the teacher's part names or anything of the key.
      expect(JSON.stringify(attempt)).not.toMatch(/Part I\.|"section"|isCorrect|answerKey/);
    }
    // …in an order of their own.
    expect(new Set(orders).size).toBeGreaterThan(3);

    // The parts stay with the attempt: in the student's review and in the teacher's view.
    const student = students.at(-1);
    await answer(student, last, 'MC 1', { choiceId: byText(last, 'MC 1').question.choices.find((c) => c.text === 'right').id });
    const done = await submit(student, last);
    expect(done.parts).toEqual(expected);
    expect(done.questions.map((q) => q.part)).toEqual(last.questions.map((q) => q.part));
    expect(done.questions.map(label)).toEqual(last.questions.map(label));
    const seen = (await teacher.get(`/api/attempts/${last.id}`)).body.data;
    expect(seen.parts).toEqual(expected);
    expect(seen.questions.map(label)).toEqual(last.questions.map(label));
  });

  it('groups a shuffled quiz without part names by the kind of question', async () => {
    const room = await classroom(4);
    const quiz = await quizWith(room, [mc(1), tf(1), mc(2), essay(1), tf(2), mc(3)], { shuffleQuestions: true });
    expect(quiz.parts.map((p) => [p.title, p.count])).toEqual([['Multiple choice', 3], ['True or false', 2], ['Essay', 1]]);
    for (const student of room.students) {
      const attempt = await start(student, quiz.id);
      expect(attempt.questions.map((q) => q.question.type)).toEqual(['MULTIPLE_CHOICE', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'TRUE_FALSE', 'ESSAY']);
      expect(attempt.parts.map((p) => p.title)).toEqual(['Multiple choice', 'True or false', 'Essay']);
    }
  });

  it('shuffles a quiz as a whole when it has no parts to keep', async () => {
    const room = await classroom(8);
    // Four questions of four kinds: nothing to group. And one kind only: one group.
    const kinds = await quizWith(room, [mc(1), tf(1), ident(1), essay(1)], { shuffleQuestions: true });
    const same = await quizWith(room, [mc(1), mc(2), mc(3), mc(4)], { shuffleQuestions: true });
    for (const quiz of [kinds, same]) {
      expect(quiz).toMatchObject({ parts: [], keptInParts: false });
      const orders = new Set();
      for (const student of room.students) {
        const attempt = await start(student, quiz.id);
        expect(attempt.parts).toEqual([]);
        expect(attempt.questions.map((q) => q.part)).toEqual([null, null, null, null]);
        orders.add(attempt.questions.map(label).join('|'));
      }
      expect(orders.size).toBeGreaterThan(1);
    }
  });

  it('gives a quiz without parts that is not shuffled exactly as it was written', async () => {
    const room = await classroom(2);
    // The kinds are mixed on purpose: this quiz has no parts.
    const mixed = await quizWith(room, [mc(1), tf(1), mc(2), ident(1)]);
    expect(mixed).toMatchObject({ parts: [], keptInParts: false });
    const attempt = await start(room.students[0], mixed.id);
    expect(attempt.questions.map(label)).toEqual(['MC 1', 'TF 1', 'MC 2', 'ID 1']);
    expect(attempt.parts).toEqual([]);
    expect(attempt.questions.map((q) => q.part)).toEqual([null, null, null, null]);

    // Written kind after kind, the same quiz shows its parts — in the same order as written.
    const sorted = await quizWith(room, [mc(1), mc(2), tf(1), ident(1)]);
    expect(sorted.keptInParts).toBe(false);
    const second = await start(room.students[0], sorted.id);
    expect(second.questions.map(label)).toEqual(['MC 1', 'MC 2', 'TF 1', 'ID 1']);
    expect(second.parts.map((p) => [p.title, p.first, p.count])).toEqual([['Multiple choice', 0, 2], ['True or false', 2, 1], ['Identification', 3, 1]]);
  });

  it('keeps named parts together without shuffling, and lets the teacher move a whole part', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const created = await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Parts', resultVisibility: 'IMMEDIATE', strictMode: false });
    const id = created.body.data.id;
    for (const question of [mc(1, { section: 'Test I' }), tf(1, { section: 'Test II' }), mc(2, { section: 'Test I' }), tf(2, { section: 'TEST  II.' })]) await teacher.post(`/api/quizzes/${id}/questions`, { question });
    let quiz = (await teacher.get(`/api/quizzes/${id}`)).body.data;
    // Shown as it is given: part by part, each part in the order its questions were written.
    expect(quiz.questions.map((q) => q.text.replace(/<[^>]*>/g, ''))).toEqual(['MC 1', 'MC 2', 'TF 1', 'TF 2']);
    // A part named by its number only is called after the kind of its questions.
    expect(quiz.parts.map((p) => [p.title, p.first, p.count])).toEqual([['Multiple choice', 0, 2], ['True or false', 2, 2]]);
    expect(quiz.keptInParts).toBe(true);

    // The second part first, and its questions the other way round.
    const [a, b, c, d] = quiz.questions.map((q) => ({ questionId: q.id, points: q.points }));
    quiz = (await teacher.put(`/api/quizzes/${id}/questions`, { items: [d, c, a, b] })).body.data;
    expect(quiz.questions.map((q) => q.text.replace(/<[^>]*>/g, ''))).toEqual(['TF 2', 'TF 1', 'MC 1', 'MC 2']);
    expect(quiz.parts.map((p) => p.title)).toEqual(['True or false', 'Multiple choice']);

    await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' });
    const attempt = await start(students[0], id);
    expect(attempt.questions.map(label)).toEqual(['TF 2', 'TF 1', 'MC 1', 'MC 2']);
    expect(attempt.parts.map((p) => p.title)).toEqual(['True or false', 'Multiple choice']);

    // The downloaded questions come part by part too, with their part names.
    const file = JSON.parse((await teacher.get(`/api/quizzes/${id}/questions/export`)).text);
    expect(file.questions.map((q) => [q.question.replace(/<[^>]*>/g, ''), q.section])).toEqual([['TF 2', 'TEST II.'], ['TF 1', 'Test II'], ['MC 1', 'Test I'], ['MC 2', 'Test I']]);
  });

  it('places questions drawn at random in the part of their kind, the parts in one order for everyone', async () => {
    const room = await classroom(6);
    const { teacher, cls, students } = room;
    const bank = (await teacher.post('/api/question-banks', { title: 'Pool' })).body.data.id;
    // The bank starts with true-or-false questions: what is drawn first must not decide the order of the parts.
    await teacher.post(`/api/question-banks/${bank}/questions/bulk`, { questions: [...[11, 12, 13, 14, 15].map((n) => tf(n)), ...[11, 12, 13, 14, 15].map((n) => mc(n))] });
    const id = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Drawn', resultVisibility: 'IMMEDIATE', strictMode: false, shuffleQuestions: true })).body.data.id;
    for (const question of [mc(1), tf(1), essay(1)]) await teacher.post(`/api/quizzes/${id}/questions`, { question });
    expect((await teacher.put(`/api/quizzes/${id}/pools`, { pools: [{ bankId: bank, count: 5, pointsEach: 1 }] })).status).toBe(200);
    await teacher.patch(`/api/quizzes/${id}`, { status: 'PUBLISHED' });

    const draws = new Set();
    for (const student of students) {
      const attempt = await start(student, id);
      expect(attempt.questions).toHaveLength(8);
      const kinds = attempt.questions.map((q) => q.question.type);
      // Multiple choice, then true or false, then the essay: the order of the quiz's own questions.
      expect(kinds).toEqual([...kinds].sort((x, y) => ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'ESSAY'].indexOf(x) - ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'ESSAY'].indexOf(y)));
      expect(kinds.at(-1)).toBe('ESSAY');
      expect(attempt.parts.map((p) => p.title)).toEqual(['Multiple choice', 'True or false', 'Essay']);
      expect(attempt.parts.reduce((sum, p) => sum + p.count, 0)).toBe(8);
      draws.add(attempt.questions.map(label).sort().join('|'));
    }
    expect(draws.size).toBeGreaterThan(1);
  });

  it('keeps the part of a question when the question is edited', async () => {
    const teacher = await actor('TEACHER');
    const bank = (await teacher.post('/api/question-banks', { title: 'Bank' })).body.data.id;
    const made = (await teacher.post(`/api/question-banks/${bank}/questions`, mc(1, { section: 'Part I. Multiple Choice' }))).body.data;
    expect(made.section).toBe('Part I. Multiple Choice');
    const edited = (await teacher.put(`/api/question-banks/questions/${made.id}`, { ...mc(1), text: '<p>MC 1, reworded</p>', section: 'Part I. Multiple Choice' })).body.data;
    expect(edited).toMatchObject({ text: '<p>MC 1, reworded</p>', section: 'Part I. Multiple Choice' });
    // Emptied on purpose, it goes.
    expect((await teacher.put(`/api/question-banks/questions/${made.id}`, { ...mc(1), section: '  ' })).body.data.section).toBeNull();
  });
});

describe('the system marks the answers', () => {
  it('marks a short answer at once: right when it matches the key, wrong when it does not', async () => {
    const room = await classroom(2);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    const quiz = await quizWith(room, [mc(1), short(1, { accepted: ['gravity', 'because of gravity'] }), ident(1, { accepted: ['Central Processing Unit (CPU)'] })], { categoryId: category });

    // Right, though not typed like the key.
    const first = await start(students[0], quiz.id);
    await answer(students[0], first, 'MC 1', { choiceId: byText(first, 'MC 1').question.choices.find((c) => c.text === 'right').id });
    await answer(students[0], first, 'SHORT 1', { text: 'The gravity.' });
    await answer(students[0], first, 'ID 1', { text: 'cpu' });
    expect(await submit(students[0], first)).toMatchObject({ awaitingGrading: false, totalScore: 5, percent: 100 });

    // Wrong: marked wrong at once, and the score is there without the teacher.
    const second = await start(students[1], quiz.id);
    await answer(students[1], second, 'SHORT 1', { text: 'the wind pushes it down' });
    await answer(students[1], second, 'ID 1', { text: 'the monitor' });
    const done = await submit(students[1], second);
    expect(done).toMatchObject({ awaitingGrading: false, totalScore: 0, percent: 0 });
    expect(byText(done, 'SHORT 1')).toMatchObject({ score: 0, isCorrect: false, needsManual: false });

    const results = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    expect(results.stats).toMatchObject({ submitted: 2, needsGrading: 0, canBeMarked: 0 });
    expect(results.students.map((s) => s.status)).toEqual(['GRADED', 'GRADED']);
    expect((await teacher.get(`/api/classes/${cls.id}/quizzes`)).body.data[0].stats.toGrade).toBe(0);
    const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    const item = book.structure.periods[0].categories.find((c) => c.id === category).items[0];
    expect(book.students.map((s) => s.entries[item.id]?.score).sort()).toEqual([0, 5]);

    // The teacher can still overrule the system where a student was right in other words.
    const overruled = (await teacher.put(`/api/attempts/${second.id}/answers/${byText(second, 'SHORT 1').position}/grade`, { score: 2 })).body.data;
    expect(overruled).toMatchObject({ totalScore: 2, needsManualGrading: false });
  });

  it('leaves to the teacher only what it cannot decide', async () => {
    const room = await classroom(4);
    const { teacher, students } = room;
    const sentence = 'Because ice is less dense than liquid water';
    const quiz = await quizWith(room, [
      mc(1),
      short('no key', { accepted: [] }),
      short('asked', { settings: { reviewMismatch: true } }),
      short('sentence', { accepted: [sentence] }),
      short('sentence, asked', { accepted: [sentence], settings: { reviewMismatch: true } }),
      essay(1),
    ]);
    // The teacher is told so while building the quiz: what the system looks for in a sentence.
    expect(quiz.questions.map((q) => q.settings)).toEqual([{}, {}, { reviewMismatch: true }, {}, { reviewMismatch: true }, {}]);
    const lookedFor = [{ accepted: sentence, keyWords: ['ice', 'dense', 'liquid', 'water'], right: 3, half: 2 }];
    expect(quiz.questions.map((q) => q.keyWords)).toEqual([[], [], [], lookedFor, lookedFor, []]);

    // Answers that match nothing. The sentence is wrong at once; the others wait, each for its own reason.
    const attempt = await start(students[0], quiz.id);
    for (const text of ['SHORT no key', 'SHORT asked', 'SHORT sentence', 'SHORT sentence, asked', 'ESSAY 1']) await answer(students[0], attempt, text, { text: 'something else entirely' });
    expect(await submit(students[0], attempt)).toMatchObject({ awaitingGrading: true, totalScore: null });
    const seen = (await teacher.get(`/api/attempts/${attempt.id}`)).body.data;
    expect(seen.questions.map((q) => [label(q), q.needsManual])).toEqual([['MC 1', false], ['SHORT no key', true], ['SHORT asked', true], ['SHORT sentence', false], ['SHORT sentence, asked', true], ['ESSAY 1', true]]);
    expect(byText(seen, 'SHORT sentence')).toMatchObject({ score: 0, check: { how: 'KEY_WORDS', share: 0, found: [], missing: ['ice', 'dense', 'liquid', 'water'] } });

    // In the student's own words: marked at once, also where the teacher looks at the other answers.
    const own = await start(students[1], quiz.id);
    await answer(students[1], own, 'SHORT asked', { text: 'Gravity' });
    await answer(students[1], own, 'SHORT sentence', { text: 'the ice floats since water in its liquid form is denser' });
    await answer(students[1], own, 'SHORT sentence, asked', { text: 'Liquid water is more dense than ice' });
    expect(await submit(students[1], own)).toMatchObject({ awaitingGrading: false, totalScore: 6 });

    // About half of the key words: half of the points, and the review says which were found.
    const half = await start(students[2], quiz.id);
    await answer(students[2], half, 'SHORT sentence', { text: 'because of the dense water' });
    expect(await submit(students[2], half)).toMatchObject({ awaitingGrading: false, totalScore: 1 });
    const halfSeen = byText((await teacher.get(`/api/attempts/${half.id}`)).body.data, 'SHORT sentence');
    expect(halfSeen).toMatchObject({ score: 1, isCorrect: false, needsManual: false, check: { how: 'KEY_WORDS', share: 0.5, doubt: null, accepted: sentence, found: ['dense', 'water'], missing: ['ice', 'liquid'] } });
    // The student is told as much as the quiz shows of its answers: here, not the key.
    expect(byText((await students[2].get(`/api/attempts/${half.id}`)).body.data, 'SHORT sentence').check).toBeUndefined();

    // The key words with a "not" that the accepted answer does not have: the system cannot tell, and says so.
    const denied = await start(students[3], quiz.id);
    await answer(students[3], denied, 'SHORT sentence', { text: 'ice is not dense like liquid water' });
    expect(await submit(students[3], denied)).toMatchObject({ awaitingGrading: true, totalScore: null });
    const deniedSeen = byText((await teacher.get(`/api/attempts/${denied.id}`)).body.data, 'SHORT sentence');
    expect(deniedSeen).toMatchObject({ needsManual: true, check: { how: 'KEY_WORDS', doubt: { why: 'NOT' }, found: ['ice', 'dense', 'liquid', 'water'] } });
    expect((await teacher.put(`/api/attempts/${denied.id}/answers/${deniedSeen.position}/grade`, { score: 0 })).body.data).toMatchObject({ totalScore: 0, needsManualGrading: false });

    // Nothing here is for the system to mark again.
    expect((await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data.stats).toMatchObject({ submitted: 4, needsGrading: 1, canBeMarked: 0 });
  });

  it('marks again the sentences that waited for the teacher', async () => {
    const room = await classroom(3);
    const { teacher, students } = room;
    const quiz = await quizWith(room, [short('sentence', { accepted: ['Because ice is less dense than liquid water'] })]);
    const answers = ['liquid water is denser than the ice', 'because of the dense water', 'no idea'];
    const attempts = [];
    for (const [i, text] of answers.entries()) {
      const attempt = await start(students[i], quiz.id);
      await answer(students[i], attempt, 'SHORT sentence', { text });
      await submit(students[i], attempt);
      attempts.push(attempt);
    }
    // As they were kept when an answer to a sentence that was not typed word for word was left to the teacher.
    await prisma.studentAnswer.updateMany({ where: { attemptId: { in: attempts.map((a) => a.id) } }, data: { autoScore: 0, score: 0, isCorrect: false, needsManual: true } });
    await prisma.quizAttempt.updateMany({ where: { id: { in: attempts.map((a) => a.id) } }, data: { autoScore: 0, totalScore: 0, needsManualGrading: true } });
    expect((await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data.stats).toMatchObject({ needsGrading: 3, canBeMarked: 3 });

    expect((await teacher.post(`/api/quizzes/${quiz.id}/results/recheck`, {})).body.data).toEqual({ attempts: 3, answers: 3, settled: 3, raised: 2, complete: 3 });
    const after = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    expect(after.stats).toMatchObject({ needsGrading: 0, canBeMarked: 0 });
    expect(after.students.map((s) => [s.status, s.score])).toEqual([['GRADED', 2], ['GRADED', 1], ['GRADED', 0]]);
  });

  it('marks again the answers that were handed in before it could mark them', async () => {
    const room = await classroom(4);
    const { teacher, cls, students } = room;
    const category = await categoryId(cls.id, 'QUIZ');
    const quiz = await quizWith(room, [mc(1), short(1), ident(1, { accepted: ['hard disk'] }), essay(1)], { categoryId: category });
    const position = (attempt, text) => byText(attempt, text).position;
    const row = (attempt, text) => prisma.studentAnswer.findFirst({ where: { attemptId: attempt.id, position: position(attempt, text) } });
    /** Put an answer back to how it was stored when a short answer that missed the key was left to the teacher. */
    const asBefore = async (attempt, text, data) => {
      await prisma.studentAnswer.updateMany({ where: { attemptId: attempt.id, position: position(attempt, text) }, data });
      const answers = await prisma.studentAnswer.findMany({ where: { attemptId: attempt.id } });
      const total = answers.reduce((sum, a) => sum + (a.manualScore ?? a.autoScore ?? 0), 0);
      await prisma.quizAttempt.update({ where: { id: attempt.id }, data: { totalScore: total, autoScore: total, needsManualGrading: answers.some((a) => a.needsManual && a.manualScore === null) } });
    };

    // Student 1: a short answer that missed the key, and waited.
    const one = await start(students[0], quiz.id);
    await answer(students[0], one, 'SHORT 1', { text: 'the wind' });
    await submit(students[0], one);
    await asBefore(one, 'SHORT 1', { needsManual: true });
    // Student 2: a short answer that waited, and an answer that was marked wrong for how it was typed.
    const two = await start(students[1], quiz.id);
    await answer(students[1], two, 'SHORT 1', { text: 'It is the gravity.' });
    await answer(students[1], two, 'ID 1', { text: 'harddisk' });
    await submit(students[1], two);
    await asBefore(two, 'SHORT 1', { needsManual: true, autoScore: 0, score: 0, isCorrect: false });
    await asBefore(two, 'ID 1', { autoScore: 0, score: 0, isCorrect: false });
    // Student 3: a short answer that waited and that the teacher has marked; and an essay, which waits for good reason.
    const three = await start(students[2], quiz.id);
    await answer(students[2], three, 'SHORT 1', { text: 'things fall' });
    await answer(students[2], three, 'ESSAY 1', { text: 'An essay.' });
    await submit(students[2], three);
    await asBefore(three, 'SHORT 1', { needsManual: true });
    expect((await teacher.put(`/api/attempts/${three.id}/answers/${position(three, 'SHORT 1')}/grade`, { score: 1 })).status).toBe(200);

    const before = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    // Two answers wait that the system can mark, and one that it marked wrong would now be right.
    expect(before.stats).toMatchObject({ needsGrading: 3, canBeMarked: 3 });

    // Only the teacher of the class.
    expect((await students[0].post(`/api/quizzes/${quiz.id}/results/recheck`, {})).status).toBe(403);
    expect((await (await actor('TEACHER')).post(`/api/quizzes/${quiz.id}/results/recheck`, {})).status).toBe(404);

    const marked = await teacher.post(`/api/quizzes/${quiz.id}/results/recheck`, {});
    expect(marked.status).toBe(200);
    // Three answers changed in two attempts; two of them turned out right; two students have a complete score.
    expect(marked.body.data).toEqual({ attempts: 2, answers: 3, settled: 2, raised: 2, complete: 2 });

    expect(await row(one, 'SHORT 1')).toMatchObject({ autoScore: 0, score: 0, isCorrect: false, needsManual: false });
    expect(await row(two, 'SHORT 1')).toMatchObject({ autoScore: 2, score: 2, isCorrect: true, needsManual: false });
    expect(await row(two, 'ID 1')).toMatchObject({ autoScore: 2, score: 2, isCorrect: true });
    // The teacher's own score stands, and the essay still waits.
    expect(await row(three, 'SHORT 1')).toMatchObject({ manualScore: 1, score: 1 });
    expect(await row(three, 'ESSAY 1')).toMatchObject({ needsManual: true, autoScore: null });

    const after = (await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data;
    expect(after.stats).toMatchObject({ needsGrading: 1, canBeMarked: 0 });
    expect(after.students.map((s) => [s.status, s.score])).toEqual([['GRADED', 0], ['GRADED', 4], ['NEEDS_GRADING', null], ['NOT_STARTED', null]]);
    const book = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data;
    const item = book.structure.periods[0].categories.find((c) => c.id === category).items[0];
    expect(book.students.find((s) => s.id === students[1].user.id).entries[item.id]).toMatchObject({ score: 4, status: 'GRADED' });

    // Kept with the attempt and in the audit log; a second time changes nothing and leaves no trace.
    const seen = (await teacher.get(`/api/attempts/${two.id}`)).body.data;
    expect(seen.events.map((e) => e.type)).toEqual(['STARTED', 'SUBMITTED', 'MARKED_AGAIN']);
    expect(seen.events.at(-1).meta).toMatchObject({ totalFrom: 0, totalTo: 4 });
    expect((await teacher.post(`/api/quizzes/${quiz.id}/results/recheck`, {})).body.data).toEqual({ attempts: 0, answers: 0, settled: 0, raised: 0, complete: 0 });
    expect(await prisma.auditLog.count({ where: { classId: cls.id, action: 'quiz.results.recheck' } })).toBe(1);
  });

  it('never takes points away when it marks again', async () => {
    const room = await classroom(1);
    const { teacher, students } = room;
    const quiz = await quizWith(room, [ident(1), short(1)]);
    const attempt = await start(students[0], quiz.id);
    await answer(students[0], attempt, 'ID 1', { text: 'Cebu' });
    await answer(students[0], attempt, 'SHORT 1', { text: 'the wind' });
    expect(await submit(students[0], attempt)).toMatchObject({ awaitingGrading: false, totalScore: 0 });
    // As if an answer had been given its points under a rule that no longer holds.
    const position = byText(attempt, 'ID 1').position;
    await prisma.studentAnswer.updateMany({ where: { attemptId: attempt.id, position }, data: { autoScore: 2, score: 2, isCorrect: true } });
    await prisma.quizAttempt.update({ where: { id: attempt.id }, data: { totalScore: 2, autoScore: 2 } });

    expect((await teacher.get(`/api/quizzes/${quiz.id}/results`)).body.data.stats).toMatchObject({ needsGrading: 0, canBeMarked: 0 });
    expect((await teacher.post(`/api/quizzes/${quiz.id}/results/recheck`, {})).body.data).toEqual({ attempts: 0, answers: 0, settled: 0, raised: 0, complete: 0 });
    expect(await prisma.studentAnswer.findFirst({ where: { attemptId: attempt.id, position } })).toMatchObject({ autoScore: 2, score: 2, isCorrect: true });
    expect((await teacher.get(`/api/attempts/${attempt.id}`)).body.data).toMatchObject({ totalScore: 2 });
  });

  it('shows the teacher how an answer would be marked, before any student gives it', async () => {
    const { teacher, students } = await classroom(1);
    const question = { type: 'SHORT_ANSWER', text: '<p>What is an algorithm?</p>', accepted: ['A step-by-step procedure for solving a problem', 'recipe'], settings: {} };
    const tryIt = async (answer, extra = {}) => (await teacher.post('/api/question-banks/try-answer', { question: { ...question, ...extra }, answer })).body.data;
    const keyWords = [{ accepted: question.accepted[0], keyWords: ['step', 'procedure', 'solving', 'problem'], right: 3, half: 2 }];

    // What the system will look for, before any answer is tried.
    expect(await tryIt('')).toEqual({ keyWords, result: null });
    expect(await tryIt('a procedure to solve problems step by step')).toEqual({ keyWords, result: { outcome: 'RIGHT', how: 'KEY_WORDS', doubt: null, accepted: question.accepted[0], found: ['step', 'procedure', 'solving', 'problem'], missing: [] } });
    expect((await tryIt('a procedure for a problem')).result).toMatchObject({ outcome: 'HALF', found: ['procedure', 'problem'], missing: ['step', 'solving'] });
    expect((await tryIt('a procedure for a problem', { settings: { partialCredit: false } })).result).toMatchObject({ outcome: 'WRONG', found: ['procedure', 'problem'] });
    expect((await tryIt('Recipe.')).result).toMatchObject({ outcome: 'RIGHT', how: 'SAME' });
    expect((await tryIt('it is not a procedure for solving problems step by step')).result).toMatchObject({ outcome: 'WAITS', doubt: { why: 'NOT', words: ['procedure'], side: 'ANSWER' } });
    expect((await tryIt('a procedure', { settings: { reviewMismatch: true } })).result).toMatchObject({ outcome: 'WAITS', doubt: null });
    expect((await tryIt('a procedure to solve problems step by step', { settings: { caseSensitive: true } }))).toMatchObject({ keyWords: [], result: { outcome: 'WRONG' } });
    // The teacher's choice: no key words for the sentence, or key words for the word as well.
    expect(await tryIt('a procedure to solve problems step by step', { settings: { keyWords: false } })).toMatchObject({ keyWords: [], result: { outcome: 'WRONG', how: 'NONE' } });
    expect(await tryIt('it is like a recipe to follow', { settings: { keyWords: true } })).toMatchObject({ keyWords: [keyWords[0], { accepted: 'recipe', keyWords: ['recipe'], right: 1, half: null }], result: { outcome: 'RIGHT', how: 'KEY_WORDS', accepted: 'recipe', found: ['recipe'] } });
    expect((await tryIt('it is like a recipe to follow')).result).toMatchObject({ outcome: 'WRONG' });
    // An identification is a term: right or wrong.
    expect(await tryIt('the cpu', { type: 'IDENTIFICATION', accepted: ['CPU'] })).toEqual({ keyWords: [], result: { outcome: 'RIGHT', how: null, accepted: null, found: [], missing: [], doubt: null } });
    expect((await tryIt('the gpu', { type: 'IDENTIFICATION', accepted: ['CPU'] })).result).toMatchObject({ outcome: 'WRONG' });
    // A question that is still being written.
    expect(await tryIt('anything', { accepted: ['', '  '] })).toEqual({ keyWords: [], result: null });

    // For teachers, and for typed questions.
    expect((await students[0].post('/api/question-banks/try-answer', { question, answer: 'x' })).status).toBe(403);
    expect((await teacher.post('/api/question-banks/try-answer', { question: { ...question, type: 'ESSAY' }, answer: 'x' })).status).toBe(422);
  });

  it('keeps the teacher’s choice about a short answer through a download and an import', async () => {
    const room = await classroom(1);
    const { teacher, cls } = room;
    const quiz = await quizWith(room, [short('asked', { settings: { reviewMismatch: true } }), short('decided', { accepted: ['Because ice is less dense than liquid water'], settings: { reviewMismatch: false, keyWords: false } }), short('plain'), short('by key words', { settings: { keyWords: true, partialCredit: false } })]);
    // Saved with the question, and with it what the system then looks for.
    expect(quiz.questions.map((q) => q.keyWords.length)).toEqual([0, 0, 0, 1]);
    const file = JSON.parse((await teacher.get(`/api/quizzes/${quiz.id}/questions/export`)).text);
    expect(file.questions.map((q) => q.reviewOtherAnswers)).toEqual([true, false, undefined, undefined]);
    expect(file.questions.map((q) => q.keyWords)).toEqual([undefined, false, undefined, true]);
    expect(file.questions.map((q) => q.partialCredit)).toEqual([undefined, undefined, undefined, false]);

    const other = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Copy' })).body.data.id;
    const preview = await teacher.post(`/api/quizzes/${other}/import/preview`, { text: JSON.stringify(file) });
    expect(preview.status).toBe(200);
    expect(preview.body.data.questions.map((q) => q.settings ?? {})).toEqual([{ reviewMismatch: true }, { reviewMismatch: false, keyWords: false }, {}, { keyWords: true, partialCredit: false }]);
  });
});
