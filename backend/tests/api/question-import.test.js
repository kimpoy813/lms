// Importing questions into a quiz from JSON (or a test paper), and downloading them again.
// See docs/QUESTION-IMPORT.md; what is read from the JSON itself is in tests/unit/question-json.test.js.
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, createClass, defaultScale, prepare, prisma } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

// One question of each kind a computer can mark, the way the format is documented.
const FILE = {
  questions: [
    { type: 'multiple_choice', question: 'Which part carries out the instructions?', choices: ['RAM', 'CPU', 'Hard disk', 'Monitor'], answer: 'CPU', points: 2, difficulty: 'easy', explanation: 'IMPORTED-EXPLANATION' },
    { type: 'multiple_response', question: 'Which of these are input devices?', choices: ['Keyboard', 'Monitor', 'Mouse', 'Printer'], answer: ['Keyboard', 'Mouse'], points: 2 },
    { type: 'true_false', question: 'One byte is made of 8 bits.', answer: true },
    { type: 'identification', question: 'What do the letters CPU stand for?', answer: ['Central Processing Unit', 'central processor'], points: 2 },
    { type: 'fill_blanks', question: 'A byte has ___ bits, and half a byte is called a ___.', answer: [['8', 'eight'], ['nibble']], points: 2 },
    { type: 'matching', question: 'Match each device with its use.', pairs: [{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }, { left: 'Hard disk', right: 'Storage' }], points: 3 },
    { type: 'ordering', question: 'Arrange from the smallest to the largest.', items: ['bit', 'byte', 'kilobyte', 'megabyte'], points: 2 },
  ],
};
const TOTAL = 14;
const paste = (value) => ({ text: typeof value === 'string' ? value : JSON.stringify(value) });
const strip = ({ number, warnings, errors, duplicate, ...question }) => question;

async function emptyQuiz(room, settings = {}) {
  const made = await room.teacher.post(`/api/classes/${room.cls.id}/quizzes`, { title: 'Imported quiz', resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', strictMode: false, ...settings });
  expect(made.status).toBe(201);
  return made.body.data;
}
const preview = async (teacher, quizId, value) => (await teacher.post(`/api/quizzes/${quizId}/import/preview`, paste(value))).body.data;
/** Paste, review nothing, add everything that was read. */
async function importInto(teacher, quizId, value = FILE) {
  const read = await preview(teacher, quizId, value);
  return teacher.post(`/api/quizzes/${quizId}/questions/bulk`, { questions: read.questions.map(strip) });
}

describe('previewing an import', () => {
  it('reads pasted JSON into questions with their answers, and saves nothing', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const res = await room.teacher.post(`/api/quizzes/${quiz.id}/import/preview`, paste(FILE));
    expect(res.status).toBe(200);
    const { source, format, questions, summary, notes } = res.body.data;
    expect({ source, format, notes }).toEqual({ source: 'Pasted text', format: 'json', notes: [] });
    expect(summary).toMatchObject({ found: 7, ready: 7, needsReview: 0, duplicates: 0 });
    expect(questions.map((q) => q.type)).toEqual(['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'IDENTIFICATION', 'FILL_BLANKS', 'MATCHING', 'ORDERING']);
    expect(questions[0]).toMatchObject({ number: 1, text: '<p>Which part carries out the instructions?</p>', points: 2, difficulty: 'EASY', warnings: [], errors: [] });
    expect(questions[0].choices).toEqual([{ text: 'RAM', isCorrect: false }, { text: 'CPU', isCorrect: true }, { text: 'Hard disk', isCorrect: false }, { text: 'Monitor', isCorrect: false }]);
    expect(questions[0]).not.toHaveProperty('duplicate');

    expect((await room.teacher.get(`/api/quizzes/${quiz.id}`)).body.data.questionCount).toBe(0);
    expect(await prisma.question.count({ where: { bank: { ownerId: room.teacher.user.id } } })).toBe(0);
  });

  it('reads a file: JSON, or a test paper as text', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const send = (content, name) => room.teacher.agent.post(`/api/quizzes/${quiz.id}/import/preview`).set('X-CSRF-Token', room.teacher.csrf).attach('file', Buffer.from(content), name);
    const json = await send(JSON.stringify(FILE), 'Chapter 2.json');
    expect(json.status).toBe(200);
    expect(json.body.data).toMatchObject({ source: 'Chapter 2.json', format: 'json', summary: { found: 7 } });
    const paper = await send('1. 2 + 2 = ?\nA. 3\nB. 4\nAnswer: B\n\n2. The earth is flat.\nAnswer: False\n', 'midterm.txt');
    expect(paper.body.data).toMatchObject({ source: 'midterm.txt', format: 'text', summary: { found: 2, ready: 2 } });
    // A file that calls itself JSON is read as JSON, and told so when it is not.
    const notJson = await send('1. 2 + 2 = ?\nAnswer: 4', 'quiz.json');
    expect(notJson.status).toBe(422);
    expect(notJson.body.error).toMatchObject({ code: 'IMPORT_UNREADABLE', message: expect.stringMatching(/^No JSON was found/) });
    const exe = await send('MZ', 'quiz.exe');
    expect(exe.body.error).toMatchObject({ code: 'IMPORT_UNREADABLE', message: 'Import a JSON, TXT, DOCX or PDF file.' });
  });

  it('says so when there is more than one import reads', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    // Two short questions, then one that runs past 400,000 characters.
    const long = `[{"question": "One?", "answer": "1"},\n{"question": "Two?", "answer": "2"},\n{"question": "${'x'.repeat(400_000)}", "answer": "3"}]`;
    const tooLong = 'This is longer than 400,000 characters, the most that one import reads. Only the beginning was read: split it into parts and import each part.';
    const pasted = await preview(room.teacher, quiz.id, long);
    expect(pasted.summary.found).toBe(2);
    expect(pasted.notes).toEqual([tooLong]);
    const file = await room.teacher.agent.post(`/api/quizzes/${quiz.id}/import/preview`).set('X-CSRF-Token', room.teacher.csrf).attach('file', Buffer.from(long), 'long.json');
    expect(file.body.data.summary.found).toBe(2);
    expect(file.body.data.notes).toEqual([tooLong]);
    // Exactly as much as is read: nothing to say.
    const fits = `[{"question": "One?", "answer": "1"}]`.padEnd(400_000, ' ');
    expect((await preview(room.teacher, quiz.id, fits)).notes).toEqual([]);
  });

  it('says what is wrong with JSON it cannot read, and with questions it can', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const broken = await room.teacher.post(`/api/quizzes/${quiz.id}/import/preview`, paste('[\n  {"question": "One?" "answer": "1"}\n]'));
    expect(broken.status).toBe(422);
    expect(broken.body.error).toMatchObject({ code: 'IMPORT_UNREADABLE', message: 'This JSON cannot be read. Line 2: a comma is missing before this, or the text before it is not closed with a double quote ("). It is at: "answer": "1"}' });
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/import/preview`, { text: '   ' })).status).toBe(422);
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/import/preview`, {})).status).toBe(422);

    const read = await preview(room.teacher, quiz.id, [
      { question: 'Brain?', options: ['RAM', 'CPU'], answer: 'the processor' },
      { question: 'Loop?', options: ['if', 'for', 'def'], answer: 1 },
      { question: 'Fine?', options: ['yes', 'no'], answer: 'yes' },
    ]);
    expect(read.summary).toMatchObject({ found: 3, ready: 1, needsReview: 2 });
    expect(read.questions[0]).toMatchObject({ errors: ['Mark the correct choice.'], warnings: ['The answer “the processor” does not match any choice. Mark the correct choice.'] });
    expect(read.questions[1]).toMatchObject({ errors: [], warnings: [expect.stringMatching(/^The answer was given as the number 1\. It was read as the second choice, “for”, counting from 0\./)] });
  });

  it('is for the teacher of the class, while nobody has started the quiz', async () => {
    const room = await classroom(1);
    const quiz = await emptyQuiz(room);
    const other = await actor('TEACHER');
    for (const [who, code] of [[room.students[0], 403], [other, 404]]) {
      expect((await who.post(`/api/quizzes/${quiz.id}/import/preview`, paste(FILE))).status).toBe(code);
      expect((await who.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: [{ type: 'TRUE_FALSE', text: '<p>S.</p>', answer: true }] })).status).toBe(code);
      expect((await who.get(`/api/quizzes/${quiz.id}/questions/export`)).status).toBe(code);
    }
    expect((await importInto(room.teacher, quiz.id)).status).toBe(201);
    await room.teacher.patch(`/api/quizzes/${quiz.id}`, { status: 'PUBLISHED' });
    expect((await room.students[0].post(`/api/quizzes/${quiz.id}/attempts`, {})).status).toBe(201);
    const late = await room.teacher.post(`/api/quizzes/${quiz.id}/import/preview`, paste(FILE));
    expect([late.status, late.body.error.code]).toEqual([409, 'QUIZ_HAS_ATTEMPTS']);
    const later = await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: [{ type: 'TRUE_FALSE', text: '<p>Another.</p>', answer: true }] });
    expect([later.status, later.body.error.code]).toEqual([409, 'QUIZ_HAS_ATTEMPTS']);
    // The questions can still be downloaded, also once the class is archived.
    await prisma.class.update({ where: { id: room.cls.id }, data: { status: 'ARCHIVED' } });
    expect((await room.teacher.get(`/api/quizzes/${quiz.id}/questions/export`)).status).toBe(200);
  });
});

describe('adding the questions of an import', () => {
  it('puts them into the quiz in their order, after the ones it has, with their points', async () => {
    const room = await classroom(0);
    const category = await categoryId(room.cls.id, 'QUIZ');
    const quiz = await emptyQuiz(room, { categoryId: category });
    await room.teacher.post(`/api/quizzes/${quiz.id}/questions`, { question: { type: 'ESSAY', text: '<p>Written first.</p>', points: 5 } });

    const added = await importInto(room.teacher, quiz.id);
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ added: 7, reused: 0, skipped: 0 });
    const view = added.body.data.quiz;
    expect(view).toMatchObject({ id: quiz.id, questionCount: 8, totalPoints: 5 + TOTAL, status: 'DRAFT' });
    expect(view.questions.map((q) => [q.type, q.points])).toEqual([['ESSAY', 5], ['MULTIPLE_CHOICE', 2], ['MULTIPLE_RESPONSE', 2], ['TRUE_FALSE', 1], ['IDENTIFICATION', 2], ['FILL_BLANKS', 2], ['MATCHING', 3], ['ORDERING', 2]]);
    expect(view.questions[1]).toMatchObject({ explanation: 'IMPORTED-EXPLANATION', difficulty: 'EASY', choices: [{ text: 'RAM', isCorrect: false }, { text: 'CPU', isCorrect: true }, { text: 'Hard disk', isCorrect: false }, { text: 'Monitor', isCorrect: false }] });
    expect(view.questions[4].accepted).toEqual(['Central Processing Unit', 'central processor']);
    expect(view.questions[5].blanks).toEqual([['8', 'eight'], ['nibble']]);
    expect(view.questions[6].pairs).toHaveLength(3);
    expect(view.questions[7].items).toEqual(['bit', 'byte', 'kilobyte', 'megabyte']);

    // The gradebook column follows, and the questions are in the teacher's bank for this course.
    const book = (await room.teacher.get(`/api/classes/${room.cls.id}/gradebook`)).body.data;
    expect(book.structure.periods[0].categories.find((c) => c.id === category).items[0]).toMatchObject({ maxPoints: 5 + TOTAL, source: 'QUIZ' });
    const banks = (await room.teacher.get('/api/question-banks')).body.data;
    expect(banks).toHaveLength(1);
    expect(banks[0].questionCount).toBe(8);
    expect((await room.teacher.patch(`/api/quizzes/${quiz.id}`, { status: 'PUBLISHED' })).status).toBe(200);
  });

  it('adds none when one of them cannot be saved, and names it', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const read = await preview(room.teacher, quiz.id, [{ question: 'Fine?', answer: 'yes' }, { question: 'Brain?', options: ['RAM', 'CPU'], answer: 'the processor' }, { type: 'programming', question: 'Not mine.', programmingProblemId: 'someone-elses' }]);
    expect(read.questions.map((q) => q.errors.length)).toEqual([0, 1, 1]);
    expect(read.questions[2].errors[0]).toMatch(/^A programming question belongs to a problem in your own account/);
    const refused = await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: read.questions.map(strip) });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'INVALID_QUESTIONS', message: '2 question(s) still need to be fixed before they can be added.' });
    expect(refused.body.error.details.questions).toEqual([{ index: 1, errors: ['Mark the correct choice.'] }, { index: 2, errors: [expect.stringMatching(/^A programming question belongs/)] }]);
    expect((await room.teacher.get(`/api/quizzes/${quiz.id}`)).body.data.questionCount).toBe(0);
    expect(await prisma.question.count({ where: { bank: { ownerId: room.teacher.user.id } } })).toBe(0);
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: [] })).status).toBe(422);
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: [{ type: 'TRUE_FALSE', text: '<p>S.</p>', answer: true }], bankId: 'not-a-bank' })).status).toBe(422);
  });

  it('uses a question the bank already holds instead of storing it twice', async () => {
    const room = await classroom(0);
    const first = await emptyQuiz(room);
    await importInto(room.teacher, first.id);
    const inBank = () => prisma.question.count({ where: { bank: { ownerId: room.teacher.user.id } } });
    expect(await inBank()).toBe(7);

    // The same file into a second quiz, with other points and one question that is new.
    const second = await emptyQuiz(room);
    const more = { questions: [...FILE.questions.map((q) => ({ ...q, points: 5 })), { type: 'true_false', question: 'A new one.', answer: false }] };
    const again = await importInto(room.teacher, second.id, more);
    expect(again.body.data).toMatchObject({ added: 8, reused: 7, skipped: 0 });
    expect(await inBank()).toBe(8);
    expect(again.body.data.quiz.questions.map((q) => q.points)).toEqual([5, 5, 5, 5, 5, 5, 5, 1]);
    const ids = (quiz) => quiz.questions.map((q) => q.id);
    expect(ids(again.body.data.quiz).slice(0, 7)).toEqual(ids((await room.teacher.get(`/api/quizzes/${first.id}`)).body.data));

    // Pasted into the same quiz once more: the preview says so, and nothing is added twice.
    const read = await preview(room.teacher, second.id, more);
    expect(read.questions.map((q) => [q.duplicate, q.warnings, q.errors])).toEqual(Array.from({ length: 8 }, () => [true, [], []]));
    expect(read.summary).toMatchObject({ found: 8, ready: 0, needsReview: 0, duplicates: 8 });
    const third = await room.teacher.post(`/api/quizzes/${second.id}/questions/bulk`, { questions: read.questions.map(strip) });
    expect(third.body.data).toMatchObject({ added: 0, reused: 0, skipped: 8 });
    expect(third.body.data.quiz.questionCount).toBe(8);
    // Nor when the import is told to keep its questions in another bank: the quiz is what counts.
    const other = (await room.teacher.post('/api/question-banks', { title: 'Another bank' })).body.data;
    const fourth = await room.teacher.post(`/api/quizzes/${second.id}/questions/bulk`, { questions: read.questions.map(strip), bankId: other.id });
    expect(fourth.body.data).toMatchObject({ added: 0, reused: 0, skipped: 8 });
    expect(await prisma.question.count({ where: { bankId: other.id } })).toBe(0);

    // The same question with another answer is another question.
    const changed = await importInto(room.teacher, second.id, [{ ...FILE.questions[0], answer: 'RAM' }, FILE.questions[2], FILE.questions[2]]);
    expect(changed.body.data).toMatchObject({ added: 1, reused: 0, skipped: 2 });
    expect(await inBank()).toBe(9);
    // On a question of the bank, "in 2 quizzes" counts the quizzes that exist.
    const { bankId } = await prisma.question.findFirstOrThrow({ where: { bank: { ownerId: room.teacher.user.id } } });
    const used = async () => (await room.teacher.get(`/api/question-banks/${bankId}/questions`)).body.data.map((q) => q.usedInQuizzes);
    expect(await used()).toEqual([2, 2, 2, 2, 2, 2, 2, 1, 1]);
    expect((await room.teacher.delete(`/api/quizzes/${first.id}`)).status).toBe(204);
    expect(await used()).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // Another class of another course has a bank of its own.
    const elsewhere = await createClass(room.teacher.user);
    const there = await emptyQuiz({ teacher: room.teacher, cls: elsewhere });
    expect((await importInto(room.teacher, there.id)).body.data).toMatchObject({ added: 7, reused: 0 });
  });

  it('holds at most 300 questions in one quiz', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const many = (from, count) => Array.from({ length: count }, (_, i) => ({ type: 'TRUE_FALSE', text: `<p>Statement ${from + i}.</p>`, answer: true }));
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: many(0, 301) })).status).toBe(422);
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: many(0, 298) })).body.data.added).toBe(298);
    const over = await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: many(298, 3) });
    expect([over.status, over.body.error.code, over.body.error.message]).toEqual([422, 'TOO_MANY_QUESTIONS', 'A quiz holds at most 300 questions. This one has 298, so 3 more do not fit.']);
    expect((await room.teacher.post(`/api/quizzes/${quiz.id}/questions/bulk`, { questions: many(298, 2) })).body.data.quiz.questionCount).toBe(300);
  }, 60_000);
});

describe('a quiz made from an import', () => {
  it('marks a student by the answers that were in the file', async () => {
    const room = await classroom(2);
    const quiz = await emptyQuiz(room);
    expect((await importInto(room.teacher, quiz.id)).status).toBe(201);
    expect((await room.teacher.patch(`/api/quizzes/${quiz.id}`, { status: 'PUBLISHED' })).status).toBe(200);

    const take = async (student, answers) => {
      const started = await student.post(`/api/quizzes/${quiz.id}/attempts`, {});
      expect(started.status).toBe(201);
      const attempt = (await student.get(`/api/attempts/${started.body.data.attemptId}`)).body.data;
      expect(attempt.maxScore).toBe(TOTAL);
      for (const [position, entry] of attempt.questions.entries()) {
        const q = entry.question;
        const id = (text) => q.choices.find((c) => c.text === text).id;
        const response = answers[q.type](q, id);
        expect((await student.put(`/api/attempts/${attempt.id}/answers/${position}`, { response })).status).toBe(200);
      }
      return (await student.post(`/api/attempts/${attempt.id}/submit`)).body.data;
    };

    // Everything as the file has it — in other words than the file's where it allows several.
    const right = await take(room.students[0], {
      MULTIPLE_CHOICE: (q, id) => ({ choiceId: id('CPU') }),
      MULTIPLE_RESPONSE: (q, id) => ({ choiceIds: [id('Mouse'), id('Keyboard')] }),
      TRUE_FALSE: (q, id) => ({ choiceId: id('True') }),
      IDENTIFICATION: () => ({ text: '  central PROCESSOR ' }),
      FILL_BLANKS: () => ({ blanks: ['eight', 'Nibble'] }),
      MATCHING: (q) => ({ pairs: Object.fromEntries(q.left.map((l) => [l.id, l.id])) }),
      ORDERING: (q) => ({ order: ['bit', 'byte', 'kilobyte', 'megabyte'].map((text) => q.items.find((i) => i.text === text).id) }),
    });
    expect(right).toMatchObject({ status: 'SUBMITTED', awaitingGrading: false, totalScore: TOTAL, percent: 100 });

    // And everything wrong.
    const wrong = await take(room.students[1], {
      MULTIPLE_CHOICE: (q, id) => ({ choiceId: id('RAM') }),
      MULTIPLE_RESPONSE: (q, id) => ({ choiceIds: [id('Monitor'), id('Printer')] }),
      TRUE_FALSE: (q, id) => ({ choiceId: id('False') }),
      IDENTIFICATION: () => ({ text: 'computer' }),
      FILL_BLANKS: () => ({ blanks: ['4', 'bit'] }),
      MATCHING: (q) => ({ pairs: Object.fromEntries(q.left.map((l, i) => [l.id, q.left[(i + 1) % q.left.length].id])) }),
      ORDERING: (q) => ({ order: ['megabyte', 'kilobyte', 'byte', 'bit'].map((text) => q.items.find((i) => i.text === text).id) }),
    });
    expect(wrong).toMatchObject({ status: 'SUBMITTED', totalScore: 0, percent: 0 });
  });
});

describe('downloading the questions', () => {
  it('writes a file that reads back as the same quiz', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room, { title: 'Quiz 3: Number systems / Bits' });
    await importInto(room.teacher, quiz.id);
    await room.teacher.post(`/api/quizzes/${quiz.id}/questions`, { question: { type: 'ESSAY', text: '<p>Explain <strong>RAM</strong>.</p>', points: 10, explanation: 'Temporary and fast.' } });
    const original = (await room.teacher.get(`/api/quizzes/${quiz.id}`)).body.data;

    const file = await room.teacher.get(`/api/quizzes/${quiz.id}/questions/export`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(file.headers['content-disposition']).toBe('attachment; filename="Quiz-3-Number-systems-Bits-questions.json"');
    expect(file.headers['cache-control']).toBe('no-store');
    const written = JSON.parse(file.text);
    expect(written).toMatchObject({ format: 'discenda.questions', version: 1, title: 'Quiz 3: Number systems / Bits' });
    expect(written.questions[0]).toEqual({ type: 'multiple_choice', question: 'Which part carries out the instructions?', choices: ['RAM', 'CPU', 'Hard disk', 'Monitor'], answer: 'CPU', points: 2, difficulty: 'easy', explanation: 'IMPORTED-EXPLANATION' });
    expect(written.questions[7]).toMatchObject({ type: 'essay', questionHtml: '<p>Explain <strong>RAM</strong>.</p>', points: 10 });
    // The answers left the system: the audit log has who took them.
    const logged = await prisma.auditLog.findMany({ where: { action: 'quiz.questions.export', entityId: quiz.id } });
    expect(logged.map((entry) => [entry.actorId, entry.classId, entry.summary])).toEqual([[room.teacher.user.id, room.cls.id, 'Downloaded the 8 question(s) of "Quiz 3: Number systems / Bits" with their answers']]);

    // Into the quiz of a colleague: the same questions, answers and points, as questions of their own.
    const colleague = await classroom(0);
    const theirs = await emptyQuiz(colleague);
    const read = await colleague.teacher.agent.post(`/api/quizzes/${theirs.id}/import/preview`).set('X-CSRF-Token', colleague.teacher.csrf).attach('file', Buffer.from(file.text), 'questions.json');
    expect(read.body.data).toMatchObject({ format: 'json', notes: [], summary: { found: 8, ready: 8 } });
    const copy = (await colleague.teacher.post(`/api/quizzes/${theirs.id}/questions/bulk`, { questions: read.body.data.questions.map(strip) })).body.data.quiz;
    const content = ({ id, bankId, createdAt, updatedAt, bankPoints, ...question }) => question;
    expect(copy.questions.map(content)).toEqual(original.questions.map(content));
    expect(copy.totalPoints).toBe(original.totalPoints);
    expect(copy.questions.map((q) => q.id)).not.toEqual(original.questions.map((q) => q.id));
  });

  it('leaves out what was deleted from the bank, and has nothing for random questions', async () => {
    const room = await classroom(0);
    const quiz = await emptyQuiz(room);
    const view = (await importInto(room.teacher, quiz.id, FILE.questions.slice(0, 3))).body.data.quiz;
    await prisma.question.update({ where: { id: view.questions[0].id }, data: { deletedAt: new Date() } });
    const written = JSON.parse((await room.teacher.get(`/api/quizzes/${quiz.id}/questions/export`)).text);
    expect(written.questions.map((q) => q.type)).toEqual(['multiple_response', 'true_false']);
    const empty = await emptyQuiz(room);
    expect(JSON.parse((await room.teacher.get(`/api/quizzes/${empty.id}/questions/export`)).text).questions).toEqual([]);
  });
});

describe('question banks', () => {
  it('import JSON as well, and download their questions', async () => {
    const teacher = await actor('TEACHER');
    const other = await actor('TEACHER');
    const bank = (await teacher.post('/api/question-banks', { title: 'Computing: chapter 2' })).body.data.id;
    const read = await teacher.post(`/api/question-banks/${bank}/import/preview`, paste(FILE));
    expect(read.body.data).toMatchObject({ format: 'json', summary: { found: 7, ready: 7 } });
    expect((await teacher.post(`/api/question-banks/${bank}/questions/bulk`, { questions: read.body.data.questions.map(strip) })).body.data.saved).toBe(7);
    const again = await teacher.post(`/api/question-banks/${bank}/import/preview`, paste(FILE));
    expect(again.body.data.questions.map((q) => q.duplicate)).toEqual([true, true, true, true, true, true, true]);
    expect(read.body.data.questions[0]).not.toHaveProperty('duplicate');
    const foreign = await teacher.post(`/api/question-banks/${bank}/questions/bulk`, { questions: [{ type: 'TRUE_FALSE', text: '<p>S.</p>', answer: true }, { type: 'PROGRAMMING', text: '<p>P.</p>', programmingProblemId: 'someone-elses' }] });
    expect([foreign.status, foreign.body.error.code]).toEqual([422, 'INVALID_QUESTIONS']);
    expect(foreign.body.error.details.questions).toEqual([{ index: 1, errors: [expect.stringMatching(/^A programming question belongs/)] }]);

    const file = await teacher.get(`/api/question-banks/${bank}/export`);
    expect(file.headers['content-disposition']).toBe('attachment; filename="Computing-chapter-2-questions.json"');
    const written = JSON.parse(file.text);
    expect(written).toMatchObject({ format: 'discenda.questions', title: 'Computing: chapter 2' });
    expect(written.questions).toHaveLength(7);
    expect(written.questions[2]).toEqual({ type: 'true_false', question: 'One byte is made of 8 bits.', answer: true, points: 1, difficulty: 'medium' });
    expect((await other.get(`/api/question-banks/${bank}/export`)).status).toBe(404);
    expect((await (await actor('STUDENT')).get(`/api/question-banks/${bank}/export`)).status).toBe(403);
    // One download, by the owner; the two that were refused left nothing behind.
    const logged = await prisma.auditLog.findMany({ where: { action: 'question_bank.export', entityId: bank } });
    expect(logged.map((entry) => [entry.actorId, entry.summary])).toEqual([[teacher.user.id, 'Downloaded the 7 question(s) of the bank "Computing: chapter 2" with their answers']]);
  });

  it('keep a programming question with the teacher whose problem it names', async () => {
    const room = await classroom(0);
    const problem = (await room.teacher.post('/api/programming/problems', { title: 'Double it', statementHtml: '<p>Print twice the number.</p>', allowedLanguages: ['PYTHON'], testCases: [{ input: '2', expectedOutput: '4' }] })).body.data;
    const quiz = await emptyQuiz(room);
    await room.teacher.post(`/api/quizzes/${quiz.id}/questions`, { question: { type: 'PROGRAMMING', text: '<p>Double the number.</p>', points: 10, programmingProblemId: problem.id } });
    const file = (await room.teacher.get(`/api/quizzes/${quiz.id}/questions/export`)).text;
    expect(JSON.parse(file).questions[0]).toMatchObject({ type: 'programming', programmingProblemId: problem.id });

    // The same teacher imports it into another quiz: it is their problem.
    const second = await emptyQuiz(room);
    expect((await importInto(room.teacher, second.id, file)).body.data).toMatchObject({ added: 1, reused: 1 });
    // A colleague cannot: the problem is not in their account.
    const colleague = await classroom(0);
    const theirs = await emptyQuiz(colleague);
    const read = await preview(colleague.teacher, theirs.id, file);
    expect(read.questions[0].errors).toEqual([expect.stringMatching(/^A programming question belongs to a problem in your own account/)]);
    expect((await colleague.teacher.post(`/api/quizzes/${theirs.id}/questions/bulk`, { questions: read.questions.map(strip) })).status).toBe(422);
  });
});
