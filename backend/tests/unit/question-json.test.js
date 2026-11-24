// Questions as JSON: what is read from what a teacher pastes, and what is written when the
// questions of a quiz are downloaded. See docs/QUESTION-IMPORT.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_TYPES, FORMAT_TYPES, buildPrompt, exampleJson } from '../../../frontend/src/lib/questionFormat.js';
import { parseImport } from '../../src/lib/questionImport.js';
import { MAX_IMPORT_QUESTIONS, QuestionImportError, findJsonError, htmlToText, looksLikeJson, parseQuestionJson, questionsToJson, textToHtml, typeFromName } from '../../src/lib/questionJson.js';
import { normalizeQuestion } from '../../src/lib/quizScoring.js';
import { sanitizeRichText } from '../../src/lib/sanitize.js';

const read = (value) => parseQuestionJson(typeof value === 'string' ? value : JSON.stringify(value));
/** The one question in this JSON. */
const one = (question) => read([question]).questions[0];
/** The choices with the correct ones in [brackets]: "RAM [CPU] Disk". */
const key = (q) => q.choices.map((c) => (c.isCorrect ? `[${c.text}]` : c.text)).join(' ');
const MC = { question: 'Brain of the computer?', choices: ['RAM', 'CPU', 'Disk', 'Monitor'] };
const clean = (q) => { expect(q.warnings).toEqual([]); expect(q.errors).toEqual([]); return q; };

describe('the documented format', () => {
  it('reads every kind of question with its answer', () => {
    const { questions, summary, notes } = read({
      questions: [
        { type: 'multiple_choice', question: 'Brain of the computer?', choices: ['RAM', 'CPU', 'Disk'], answer: 'CPU', points: 2, difficulty: 'easy', topic: 'Hardware', explanation: 'It carries out instructions.' },
        { type: 'multiple_response', question: 'Input devices?', choices: ['Keyboard', 'Monitor', 'Mouse'], answer: ['Keyboard', 'Mouse'] },
        { type: 'true_false', question: 'A byte has 8 bits.', answer: true },
        { type: 'modified_true_false', question: 'A byte has 4 bits.', answer: false, correction: ['8', 'eight'] },
        { type: 'identification', question: 'CPU stands for?', answer: ['Central Processing Unit', 'central processor'] },
        { type: 'short_answer', question: 'What does RAM do?', answer: 'It holds what the computer is working on' },
        { type: 'fill_blanks', question: 'A byte has ___ bits and a nibble has ___.', answer: [['8', 'eight'], ['4']] },
        { type: 'matching', question: 'Match.', pairs: [{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }] },
        { type: 'ordering', question: 'Smallest first.', items: ['bit', 'byte', 'kilobyte'] },
        { type: 'essay', question: 'Explain RAM.', points: 10, wordLimit: 200 },
        { type: 'file_upload', question: 'Upload your diagram.', points: 5 },
      ],
    });
    expect(notes).toEqual([]);
    expect(summary).toMatchObject({ found: 11, ready: 11, needsReview: 0 });
    questions.forEach(clean);
    expect(questions.map((q) => q.type)).toEqual(['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'MODIFIED_TRUE_FALSE', 'IDENTIFICATION', 'SHORT_ANSWER', 'FILL_BLANKS', 'MATCHING', 'ORDERING', 'ESSAY', 'FILE_UPLOAD']);
    expect(questions.map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(questions[0]).toMatchObject({ text: '<p>Brain of the computer?</p>', points: 2, difficulty: 'EASY', topic: 'Hardware', explanation: 'It carries out instructions.' });
    expect(key(questions[0])).toBe('RAM [CPU] Disk');
    expect(key(questions[1])).toBe('[Keyboard] Monitor [Mouse]');
    expect(questions[2].answer).toBe(true);
    expect(questions[3]).toMatchObject({ answer: false, correction: ['8', 'eight'] });
    expect(questions[4].accepted).toEqual(['Central Processing Unit', 'central processor']);
    expect(questions[5].accepted).toEqual(['It holds what the computer is working on']);
    expect(questions[6].blanks).toEqual([['8', 'eight'], ['4']]);
    expect(questions[7].pairs).toEqual([{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }]);
    expect(questions[8].items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(questions[9]).toMatchObject({ points: 10, settings: { wordLimit: 200 } });
    // What comes out can be saved as it is.
    for (const q of questions) expect(normalizeQuestion(q).errors).toEqual([]);
  });

  it('is what the app shows as its example, and what it asks a chat assistant for', () => {
    const all = read(exampleJson());
    expect(all.summary).toMatchObject({ found: FORMAT_TYPES.length, ready: FORMAT_TYPES.length });
    expect(all.questions.map((q) => q.type.toLowerCase())).toEqual(ALL_TYPES);
    // The request ends with the teacher's material; the example inside it is still found.
    const request = buildPrompt({ types: ALL_TYPES, topic: 'Computer basics [chapter 2]' });
    expect(looksLikeJson(request)).toBe(true);
    expect(read(request).questions.map((q) => q.type.toLowerCase())).toEqual(ALL_TYPES);
    for (const type of FORMAT_TYPES) clean(one(type.example));
  });

  it('reads every example of the documentation as it is written there', () => {
    const doc = readFileSync(new URL('../../../docs/QUESTION-IMPORT.md', import.meta.url), 'utf8');
    // A block ends at a line that holds only the three backticks: the ones inside a question are not at the start of a line.
    const examples = [...doc.matchAll(/^( *)```json\n([\s\S]*?)\n\1```$/gm)].map((m) => m[2]);
    expect(examples.length).toBe(6);
    const types = new Set();
    for (const example of examples) {
      expect(() => JSON.parse(example), example.slice(0, 60)).not.toThrow();
      const { questions, notes } = read(example);
      // The one note is on the example that keeps its answers apart.
      expect(notes.filter((note) => !note.startsWith('The file keeps its answers apart from the questions. 3 answers were taken from there'))).toEqual([]);
      expect(questions.length).toBeGreaterThan(0);
      for (const q of questions) types.add(clean(q).type);
    }
    // Every type a file can bring with it, apart from the one that names a problem of the teacher's own.
    expect([...types].sort()).toEqual(['ESSAY', 'FILE_UPLOAD', 'FILL_BLANKS', 'IDENTIFICATION', 'MATCHING', 'MODIFIED_TRUE_FALSE', 'MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'ORDERING', 'SHORT_ANSWER', 'TRUE_FALSE']);
    // The messages it quotes are the ones the reader gives.
    const quoted = (text) => doc.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ').includes(text);
    expect(() => read('[\n  {"question": "What is RAM?" "answer": "memory"}\n]')).toThrow(QuestionImportError);
    let message = '';
    try { read('[\n  {"question": "What is RAM?" "answer": "memory"}\n]'); } catch (err) { message = err.message; }
    expect(quoted(message), message).toBe(true);
  });

  it('gives a question one point and medium difficulty unless it says otherwise', () => {
    expect(clean(one({ question: 'A byte has 8 bits.', answer: true }))).toMatchObject({ points: 1, difficulty: 'MEDIUM', explanation: '' });
    expect(one({ ...MC, answer: 'CPU', points: '2 pts', difficulty: 'Difficult' })).toMatchObject({ points: 2, difficulty: 'HARD' });
    expect(one({ ...MC, answer: 'CPU', marks: 3, level: 'beginner' })).toMatchObject({ points: 3, difficulty: 'EASY' });
    expect(one({ ...MC, answer: 'CPU', points: 0 }).errors).toEqual(['Points must be more than zero.']);
  });
});

describe('other names for the same things', () => {
  it('knows the type by the names people give it', () => {
    const names = {
      MULTIPLE_CHOICE: ['multiple_choice', 'Multiple Choice', 'MCQ', 'multiple-choice question', 'single_choice', 'MULTIPLE_CHOICE'],
      MULTIPLE_RESPONSE: ['multiple_response', 'Multiple Answer', 'multi-select', 'checkbox', 'Select all that apply', 'Multiple Choice (Multiple Answers)'],
      TRUE_FALSE: ['true_false', 'True/False', 'True or False', 'TF', 'boolean', 'truefalse questions'],
      MODIFIED_TRUE_FALSE: ['modified_true_false', 'Modified True or False'],
      IDENTIFICATION: ['identification', 'Identify'],
      SHORT_ANSWER: ['short_answer', 'Short Answer', 'enumeration'],
      FILL_BLANKS: ['fill_blanks', 'Fill in the blank', 'fill-in-the-blanks', 'cloze', 'FITB'],
      MATCHING: ['matching', 'Matching Type', 'match'],
      ORDERING: ['ordering', 'Sequence', 'arrange', 'ranking'],
      ESSAY: ['essay', 'Long answer', 'open-ended'],
      FILE_UPLOAD: ['file_upload', 'File upload'],
      PROGRAMMING: ['programming', 'coding'],
    };
    for (const [type, list] of Object.entries(names)) for (const name of list) expect([name, typeFromName(name)]).toEqual([name, type]);
    for (const name of ['', 'questions', 'type', 'items', 'quiz', 'data', 'sections', 'xyz', 42, null]) expect([name, typeFromName(name)]).toEqual([name, null]);
  });

  it('finds the text, the choices and the answer under other names', () => {
    expect(key(clean(one({ prompt: 'Brain?', options: ['RAM', 'CPU'], correctAnswer: 'CPU' })))).toBe('RAM [CPU]');
    expect(key(clean(one({ questionText: 'Brain?', options: ['RAM', 'CPU'], correct_answer: 'cpu.' })))).toBe('RAM [CPU]');
    expect(key(clean(one({ stem: 'Brain?', Choices: ['RAM', 'CPU'], 'Correct Answer': 'CPU' })))).toBe('RAM [CPU]');
    expect(key(clean(one({ q: 'Brain?', options: ['RAM', 'CPU'], key: 'CPU' })))).toBe('RAM [CPU]');
    // A name such as "title" is the question only next to choices or an answer.
    expect(clean(one({ title: 'Brain?', options: ['RAM', 'CPU'], answer: 'CPU' })).text).toBe('<p>Brain?</p>');
    expect(() => read({ title: 'Midterm', author: 'Me' })).toThrow(/No questions were found/);
  });

  it('reads choices that are objects, with the correct one marked on them', () => {
    const marked = one({ question: 'Brain?', choices: [{ text: 'RAM', isCorrect: false }, { text: 'CPU', isCorrect: true }] });
    expect(key(clean(marked))).toBe('RAM [CPU]');
    expect(marked.type).toBe('MULTIPLE_CHOICE');
    expect(key(clean(one({ question: 'Brain?', options: [{ option: 'RAM', correct: false }, { option: 'CPU', correct: true }] })))).toBe('RAM [CPU]');
    expect(key(clean(one({ question: 'Brain?', answers: [{ answer: 'RAM', correct: false }, { answer: 'CPU', correct: true }] })))).toBe('RAM [CPU]');
    expect(key(clean(one({ question: 'Brain?', options: [{ id: 'a', text: 'RAM' }, { id: 'b', text: 'CPU' }], answer: 'b' })))).toBe('RAM [CPU]');
    // Two marked: several answers are right.
    const two = clean(one({ question: 'Input?', choices: [{ text: 'Keyboard', isCorrect: true }, { text: 'Monitor' }, { text: 'Mouse', isCorrect: true }] }));
    expect([two.type, key(two)]).toEqual(['MULTIPLE_RESPONSE', '[Keyboard] Monitor [Mouse]']);
  });

  it('reads choices that each stand under a name of their own', () => {
    // The columns of a spreadsheet.
    expect(key(clean(one({ question: 'Brain?', option_a: 'RAM', option_b: 'CPU', option_c: 'Disk', answer: 'B' })))).toBe('RAM [CPU] Disk');
    expect(key(clean(one({ Question: 'Brain?', 'Option A': 'RAM', 'Option B': 'CPU', 'Correct Answer': 'option_b' })))).toBe('RAM [CPU]');
    expect(key(clean(one({ question: 'Brain?', A: 'RAM', B: 'CPU', C: 'Disk', correct: 'C' })))).toBe('RAM CPU [Disk]');
    expect(key(clean(one({ question: 'Brain?', option1: 'RAM', option2: 'CPU', option3: 'Disk', answer: 2 })))).toBe('RAM [CPU] Disk');
    expect(key(clean(one({ question: 'Brain?', choice1: 'RAM', choice2: 'CPU', answer: 'CPU' })))).toBe('RAM [CPU]');
    expect(key(clean(one({ questionText: 'Brain?', answerOptions: [{ answerText: 'RAM', isCorrect: false }, { answerText: 'CPU', isCorrect: true }] })))).toBe('RAM [CPU]');
    // "a" is the answer of a question that has no "b".
    expect(clean(one({ q: 'What do the letters CPU stand for?', a: 'Central Processing Unit' }))).toMatchObject({ type: 'IDENTIFICATION', accepted: ['Central Processing Unit'] });
    expect(one({ q: 'Brain?', a: 'RAM', b: 'CPU' })).toMatchObject({ type: 'MULTIPLE_CHOICE', errors: ['Mark the correct choice.'] });
    // The file that was downloaded is read by its own names only.
    const own = read({ format: 'discenda.questions', version: 1, questions: [{ type: 'essay', question: 'Compare.', a: 'RAM', b: 'CPU' }] }).questions[0];
    expect([own.type, own.choices]).toEqual(['ESSAY', undefined]);
  });

  it('puts the choices together when the wrong ones are listed apart from the correct one', () => {
    const { questions, notes } = read({ results: [
      { type: 'multiple', difficulty: 'easy', category: 'Computers', question: 'What does CPU stand for?', correct_answer: 'Central Processing Unit', incorrect_answers: ['Central Process Unit', 'Computer Personal Unit', 'Central Processor Unit'] },
      { type: 'boolean', question: 'Linux is open source.', correct_answer: 'True', incorrect_answers: ['False'] },
      { question: 'Which is a fruit?', correct: 'None of the above', distractors: ['Rock', 'Chair', 'Zebra'] },
      { question: '2 + 2', answer: 4, wrong_answers: [3, 22, 10] },
      { question: 'Which are even?', correct_answers: ['4', '2'], incorrect_answers: ['1', '3'] },
    ] });
    // In alphabetical order: with the correct one always first, its place would give it away.
    expect(questions.map((q) => (q.choices ? key(clean(q)) : clean(q).answer))).toEqual([
      'Central Process Unit [Central Processing Unit] Central Processor Unit Computer Personal Unit',
      true,
      'Chair Rock Zebra [None of the above]',
      '3 [4] 10 22',
      '1 [2] 3 [4]',
    ]);
    expect(questions.map((q) => q.type)).toEqual(['MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE']);
    expect(questions[0]).toMatchObject({ difficulty: 'EASY', topic: 'Computers' });
    expect(notes).toEqual(['4 questions list the wrong answers apart from the correct one. Their choices were put in alphabetical order, so that the correct one is not always the first.']);
    // A sentence for the student who answers wrongly is not a list of wrong answers.
    expect(clean(one({ question: 'Capital?', answer: 'Manila', incorrect: 'Try again!' })).type).toBe('IDENTIFICATION');
    // Choices that are given are used as they are.
    const given = read([{ question: 'Capital?', options: ['Manila', 'Cebu'], correct_answer: 'Manila', incorrect_answers: ['Cebu'] }]);
    expect([key(clean(given.questions[0])), given.notes]).toEqual(['[Manila] Cebu', []]);
  });

  it('takes an answer given as a letter, and takes lettering off the choices', () => {
    for (const answer of ['B', 'b', 'B.', '(b)', 'b)', 'Option B', 'option_b', 'Choice: B', 'B. CPU', 'B) CPU']) expect([answer, key(clean(one({ ...MC, answer })))]).toEqual([answer, 'RAM [CPU] Disk Monitor']);
    expect(key(clean(one({ question: 'Brain?', options: ['A. RAM', 'B. CPU', 'C. Disk'], answer: 'B' })))).toBe('RAM [CPU] Disk');
    expect(key(clean(one({ question: 'Brain?', options: ['a) RAM', 'b) CPU', 'c) Disk'], answer: 'b) CPU' })))).toBe('RAM [CPU] Disk');
    expect(key(clean(one({ question: 'Brain?', options: ['(1) RAM', '(2) CPU', '(3) Disk'], answer: '2' })))).toBe('RAM [CPU] Disk');
    expect(key(clean(one({ question: 'Brain?', options: { A: 'RAM', B: 'CPU', C: 'Disk' }, answer: 'B' })))).toBe('RAM [CPU] Disk');
    // Lettering that does not run A, B, C is part of the choice.
    expect(key(clean(one({ question: 'Who?', options: ['J. Rizal', 'A. Bonifacio'], answer: 'J. Rizal' })))).toBe('[J. Rizal] A. Bonifacio');
    // The text of a choice comes before its letter: here "B" is the first choice.
    expect(key(clean(one({ question: 'Which vitamin?', options: ['B', 'A', 'C'], answer: 'B' })))).toBe('[B] A C');
  });

  it('reads several answers as "multiple response"', () => {
    for (const answer of [['A', 'C'], 'A, C', 'A and C', 'a;c', ['RAM', 'Disk']]) {
      const q = clean(one({ ...MC, answer }));
      expect([answer, q.type, key(q)]).toEqual([answer, 'MULTIPLE_RESPONSE', '[RAM] CPU [Disk] Monitor']);
    }
    // A choice whose text is "A and C" is that choice.
    expect(key(clean(one({ question: 'Which?', options: ['A', 'C', 'A and C'], answer: 'A and C' })))).toBe('A C [A and C]');
    const said = one({ ...MC, type: 'multiple_choice', answer: ['A', 'C'] });
    expect([said.type, said.errors]).toEqual(['MULTIPLE_RESPONSE', []]);
    expect(said.warnings).toEqual(['2 choices are correct, so this was read as “multiple response”.']);
    expect(clean(one({ ...MC, type: 'multiple_response', answer: 'B' })).type).toBe('MULTIPLE_RESPONSE');
  });

  it('leaves the answer open when it fits no choice, rather than guess', () => {
    const q = one({ ...MC, answer: 'The CPU' });
    expect(key(q)).toBe('RAM CPU Disk Monitor');
    expect(q.warnings).toEqual(['The answer “The CPU” does not match any choice. Mark the correct choice.']);
    expect(q.errors).toEqual(['Mark the correct choice.']);
    expect(one({ ...MC, answer: 'E' }).errors).toEqual(['Mark the correct choice.']);
    expect(one(MC)).toMatchObject({ warnings: ['No answer was found. Mark the correct choice.'], errors: ['Mark the correct choice.'] });
    expect(one({ ...MC, corect: 'B' }).errors).toEqual(['Mark the correct choice.']);
    const both = one({ question: 'Brain?', choices: [{ text: 'RAM', isCorrect: true }, { text: 'CPU' }], answer: 'CPU' });
    expect(key(both)).toBe('[RAM] CPU');
    expect(both.warnings.join(' ')).toMatch(/do not agree/);
  });
});

describe('an answer key that stands apart from the questions', () => {
  const QUESTIONS = [
    { id: 1, question: 'Brain of the computer?', options: ['RAM', 'CPU', 'Disk'] },
    { id: 2, question: 'One byte is 8 bits.' },
    { id: 3, question: 'What does RAM stand for?' },
  ];
  const BARE = QUESTIONS.map(({ id, ...question }) => question);
  const answersOf = (result) => result.questions.map((q) => (q.choices ? key(q) : q.accepted ?? q.answer));
  const READ = ['RAM [CPU] Disk', true, ['Random Access Memory']];
  const APART = 'The file keeps its answers apart from the questions';
  const UNCLEAR = 'They were not used: it is not clear which answer belongs to which question.';
  const note = (how, count = '3 answers were') => `${APART}. ${count} taken from there, ${how}. Check that each answer is with the right question.`;

  it('gives each question the answer that has its number', () => {
    for (const answerKey of [
      { 1: 'B', 2: 'True', 3: 'Random Access Memory' },
      { Q3: 'Random Access Memory', Q1: 'B', Q2: 'True' },
      [{ id: 3, answer: 'Random Access Memory' }, { id: 1, answer: 'B' }, { id: 2, answer: 'True' }],
      [{ question_number: 1, correct_answer: 'CPU' }, { question_number: 2, correct_answer: true }, { question_number: 3, correct_answer: 'Random Access Memory' }],
    ]) {
      const result = read({ questions: QUESTIONS, answer_key: answerKey });
      expect(answersOf(result)).toEqual(READ);
      result.questions.forEach(clean);
      expect(result.notes).toEqual([note('each for the question with its number or its text')]);
    }
    // Beside the quiz that holds the questions, and under another name.
    expect(answersOf(read({ quiz: { title: 'Quiz 1', questions: QUESTIONS }, answers: { 1: 'B', 2: 'True', 3: 'Random Access Memory' } }))).toEqual(READ);
    // By the text of the question. The lines of the key are not questions themselves.
    const byText = read({ questions: BARE, answerKey: [{ question: 'What does RAM stand for?', answer: 'Random Access Memory' }, { question: 'Brain of the computer?', answer: 'CPU' }, { question: 'One byte is 8 bits.', answer: 'True' }] });
    expect(answersOf(byText)).toEqual(READ);
  });

  it('goes by the order of the questions where they have no numbers', () => {
    for (const answerKey of [['B', true, 'Random Access Memory'], { 1: 'B', 2: 'True', 3: 'Random Access Memory' }, { 0: 'B', 1: 'True', 2: 'Random Access Memory' }, [{ answer: 'B' }, { answer: 'True' }, { answer: 'Random Access Memory' }]]) {
      const result = read({ questions: BARE, answerKey });
      expect(answersOf(result)).toEqual(READ);
      expect(result.notes).toEqual([note('in the order of the questions: the first answer for the first question')]);
    }
    // Numbers that start again in every part tell nothing: the key counts through. The "3" of
    // the second part occurs once, and is the fifth question, not the third.
    const parts = read({ sections: [{ title: 'A', questions: [{ number: 1, question: 'A1?' }, { number: 2, question: 'A2?' }] }, { title: 'B', questions: [{ number: 1, question: 'B1?' }, { number: 2, question: 'B2?' }, { number: 3, question: 'B3?' }] }], answer_key: { 1: 'a1', 2: 'a2', 3: 'b1', 4: 'b2', 5: 'b3' } });
    expect(parts.questions.map((q) => q.accepted[0])).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
    expect(parts.notes).toEqual([note('in the order of the questions: the first answer for the first question', '5 answers were')]);
    // The text of the question still tells, where the numbers of the key do not.
    const byText = read({ questions: BARE, answer_key: [{ number: 1, question: 'What does RAM stand for?', answer: 'Random Access Memory' }, { number: 1, question: 'Brain of the computer?', answer: 'B' }, { number: 2, question: 'One byte is 8 bits.', answer: 'True' }] });
    expect(answersOf(byText)).toEqual(READ);
    // A key for each part.
    const each = read({ sections: [{ title: 'A', questions: [{ question: 'A1?' }, { question: 'A2?' }], answers: ['a1', 'a2'] }, { title: 'B', type: 'true_false', questions: [{ question: 'B1.' }, { question: 'B2.' }], answers: ['T', 'F'] }] });
    expect(each.questions.map((q) => clean(q).accepted?.[0] ?? q.answer)).toEqual(['a1', 'a2', true, false]);
    // Several answers for one question; and "answers" on a question are then its choices.
    const several = read({ questions: [{ question: 'Even?', options: ['1', '2', '3', '4'] }, { question: 'Odd?', answers: ['1', '2', '4'] }], answer_key: [['B', 'D'], 'A'] });
    expect(several.questions.map((q) => [q.type, key(q)])).toEqual([['MULTIPLE_RESPONSE', '1 [2] 3 [4]'], ['MULTIPLE_CHOICE', '[1] 2 4']]);
  });

  it('leaves a question the answer it has itself', () => {
    const result = read({ questions: [{ id: 1, question: 'One?', answer: 'its own' }, { id: 2, question: 'Two?' }], answer_key: { 1: 'from the key', 2: 'two' } });
    expect(result.questions.map((q) => q.accepted)).toEqual([['its own'], ['two']]);
    expect(result.notes).toEqual([note('for the question with its number or its text', 'One answer was')]);
    expect(read({ questions: [{ id: 1, question: 'One?', answer: 'its own' }], answer_key: { 1: 'from the key' } }).notes).toEqual([]);
  });

  it('keeps the place of an answer that is left empty', () => {
    // The second question has no answer here. The third must not get the answer of a fourth.
    const result = read({ questions: BARE, answers: ['B', null, 'Random Access Memory'] });
    expect(answersOf(result)).toEqual(['RAM [CPU] Disk', undefined, ['Random Access Memory']]);
    expect(result.questions[1].type).toBe('ESSAY');
    expect(result.notes).toEqual([note('in the order of the questions: the first answer for the first question', '2 answers were')]);
    const shifted = read({ questions: BARE, answers: ['B', '', 'True', 'Random Access Memory'] });
    expect(shifted.notes).toEqual([`${APART}, and has 4 of them for 3 questions. ${UNCLEAR}`]);
    expect(shifted.summary.ready).toBe(0);
  });

  it('is not used when it does not show whose the answers are', () => {
    const unused = (file, why) => {
      const result = read(file);
      expect(result.notes).toEqual([`${APART}${why}`]);
      // Not one answer was taken: the choices are unmarked, the others are read as essays.
      expect([result.summary.ready, result.questions.map((q) => (q.choices ? key(q) : q.type))]).toEqual([0, ['RAM CPU Disk', 'ESSAY', 'ESSAY']]);
      return result;
    };
    const short = unused({ questions: QUESTIONS, answer_key: ['B', 'True'] }, `, and has 2 of them for 3 questions. ${UNCLEAR}`);
    expect(short.questions[0].errors).toEqual(['Mark the correct choice.']);
    unused({ questions: QUESTIONS, answer_key: { alpha: 'B', beta: 'True' } }, ', under names that none of the questions has. They were not used.');
    // More numbers than questions: one question is missing, and it is not known which.
    unused({ questions: BARE, answer_key: { 1: 'B', 2: 'True', 3: 'Random Access Memory', 4: 'Bit' } }, `, numbered up to 4, and there are 3 questions. ${UNCLEAR}`);
    // The key counts from 0, the questions from 1: "1" is then not the same question in both.
    unused({ questions: QUESTIONS, answer_key: { 0: 'B', 1: 'True', 2: 'Random Access Memory' } }, `, under numbers that only partly agree with the numbers of the questions. ${UNCLEAR}`);
    // The questions carry numbers of another kind; one of them is a number of the key by chance.
    const other = QUESTIONS.map((question, i) => ({ ...question, id: [3, 107, 109][i] }));
    unused({ questions: other, answer_key: { 1: 'B', 2: 'True', 3: 'Random Access Memory' } }, `, under numbers that only partly agree with the numbers of the questions. ${UNCLEAR}`);
    // A key that starts again at 1 in every part of the test. Its "2" occurs once, and is the
    // third question all the same: no number of such a key says which question it is for.
    const restarting = [{ number: 1, answer: 'B' }, { number: 1, answer: 'True' }, { number: 2, answer: 'Random Access Memory' }];
    unused({ questions: BARE, answer_key: restarting }, `, and gives the same number to several of them. ${UNCLEAR}`);
    unused({ questions: QUESTIONS, answer_key: restarting }, `, and gives the same number to several of them. ${UNCLEAR}`);
    // A key for the first questions only is clear: the last one stays open.
    const first = read({ questions: QUESTIONS, answer_key: { 1: 'B', 2: 'True' } });
    expect(answersOf(first)).toEqual(['RAM [CPU] Disk', true, undefined]);
    // So is a key that still has the answer of a question that was taken out.
    const removed = read({ questions: [QUESTIONS[0], QUESTIONS[2]], answer_key: { 1: 'B', 2: 'True', 3: 'Random Access Memory' } });
    expect(answersOf(removed)).toEqual(['RAM [CPU] Disk', ['Random Access Memory']]);
    // A question the key has nothing for stays open.
    const gap = read({ questions: QUESTIONS, answer_key: { 1: 'B', 3: 'Random Access Memory' } });
    expect(answersOf(gap)).toEqual(['RAM [CPU] Disk', undefined, ['Random Access Memory']]);
    expect(gap.questions[1]).toMatchObject({ type: 'ESSAY', warnings: ['No choices and no answer were found, so this was read as an essay question.'] });
    // Answers and nothing else beside them: these are the questions.
    expect(read({ solutions: [{ question: 'One?', answer: '1' }, { question: 'Two?', answer: '2' }] }).questions.map((q) => q.accepted[0])).toEqual(['1', '2']);
    // A file that was downloaded is read by its own names only.
    const own = read({ format: 'discenda.questions', version: 1, questions: [{ type: 'essay', question: 'Compare.' }], answers: ['Model answer.'] });
    expect([own.questions[0].explanation, own.notes]).toEqual(['', []]);
  });
});

describe('an answer given as a number', () => {
  const four = ['a', 'b', 'c', 'd'];
  const file = (...answers) => read(answers.map((answer, i) => ({ question: `Q${i}?`, options: four, ...(typeof answer === 'object' ? answer : { answer }) })));

  it('counts from 0 when a 0 appears anywhere in the file', () => {
    const { questions } = file(0, 2, 3, '1');
    expect(questions.map(key)).toEqual(['[a] b c d', 'a b [c] d', 'a b c [d]', 'a [b] c d']);
    questions.forEach(clean);
  });

  it('counts from 1 when a number is as large as its list', () => {
    const { questions } = file(4, 2, 1);
    expect(questions.map(key)).toEqual(['a b c [d]', 'a [b] c d', '[a] b c d']);
    questions.forEach(clean);
  });

  it('says so when the file does not show which, and counts from 0', () => {
    const { questions, summary } = file(2, 1);
    expect(questions.map(key)).toEqual(['a b [c] d', 'a [b] c d']);
    expect(questions[0].warnings).toEqual(['The answer was given as the number 2. It was read as the third choice, “c”, counting from 0. Check that this is the one.']);
    expect(questions[0].errors).toEqual([]);
    expect(summary).toMatchObject({ ready: 0, needsReview: 2 });
  });

  it('takes a name that says "index" at its word', () => {
    const { questions } = file({ correctIndex: 1 }, { answerIndex: 2 }, { correct_option_index: 3 });
    expect(questions.map(key)).toEqual(['a [b] c d', 'a b [c] d', 'a b c [d]']);
    questions.forEach(clean);
    expect(key(clean(one({ question: 'Several?', options: four, correctIndices: [0, 2] })))).toBe('[a] b [c] d');
  });

  it('is the value of a choice when one says that number', () => {
    expect(key(clean(one({ question: '2 + 2 = ?', options: ['3', '4', '5'], answer: 4 })))).toBe('3 [4] 5');
    expect(key(clean(one({ question: '2 + 2 = ?', options: [1, 2, 3, 4], answer: 4 })))).toBe('1 2 3 [4]');
    // The file numbered its choices itself: that numbering is meant.
    expect(key(clean(one({ question: 'Brain?', options: [{ id: 1, text: 'RAM' }, { id: 2, text: 'CPU' }], answer: 2 })))).toBe('RAM [CPU]');
    expect(key(clean(one({ question: 'Brain?', options: ['1. RAM', '2. CPU'], answer: 1 })))).toBe('[RAM] CPU');
  });

  it('is no answer when it points outside the list', () => {
    expect(file(0, 7).questions[1]).toMatchObject({ errors: ['Mark the correct choice.'], warnings: ['The answer “7” does not match any choice. Mark the correct choice.'] });
    expect(one({ question: 'Q?', options: four, answer: 1.5 }).errors).toEqual(['Mark the correct choice.']);
    expect(one({ question: 'Q?', options: four, answer: -1 }).errors).toEqual(['Mark the correct choice.']);
  });
});

describe('true or false', () => {
  it('reads the answer in the words people use', () => {
    for (const [answer, value] of [[true, true], [false, false], ['True', true], ['FALSE', false], ['true.', true]]) expect([answer, clean(one({ question: 'S.', answer })).answer]).toEqual([answer, value]);
    for (const [answer, value] of [['T', true], ['f', false], ['Yes', true], ['no', false], ['Tama', true], ['MALI', false], [1, true], [0, false], ['False. A byte has 8 bits.', false]]) {
      expect([answer, clean(one({ type: 'true_false', question: 'S.', answer })).answer]).toEqual([answer, value]);
    }
    expect(clean(one({ question: 'S.', correct: false })).answer).toBe(false);
  });

  it('reads a lone T or F as true or false, and says so', () => {
    const t = one({ question: 'One byte is 8 bits.', answer: 'T' });
    expect([t.type, t.answer, t.errors]).toEqual(['TRUE_FALSE', true, []]);
    expect(t.warnings).toEqual(['The answer “T” was read as “true”, which makes this a true-or-false question. Check that it is one.']);
    expect(one({ question: 'RAM keeps its contents without power.', answer: 'f' })).toMatchObject({ type: 'TRUE_FALSE', answer: false });
    // Not where the letter is plainly an answer of another kind.
    expect(clean(one({ question: 'The letter after S is ___.', answer: 'T' }))).toMatchObject({ type: 'FILL_BLANKS', blanks: [['T']] });
    expect(key(clean(one({ question: 'Which vitamin?', options: ['T', 'F'], answer: 'T' })))).toBe('[T] F');
    expect(clean(one({ type: 'identification', question: 'The letter after S?', answer: 'T' }))).toMatchObject({ type: 'IDENTIFICATION', accepted: ['T'] });
  });

  it('does not take "1" or "yes" for true unless the question says it is true-or-false', () => {
    expect(clean(one({ question: 'How many bits is a binary digit?', answer: '1' }))).toMatchObject({ type: 'IDENTIFICATION', accepted: ['1'] });
    expect(clean(one({ question: 'Is it?', answer: 'Yes' }))).toMatchObject({ type: 'IDENTIFICATION', accepted: ['Yes'] });
  });

  it('reads True and False given as the choices', () => {
    expect(clean(one({ question: 'S.', options: ['True', 'False'], answer: 'False' }))).toMatchObject({ type: 'TRUE_FALSE', answer: false });
    expect(clean(one({ question: 'S.', options: ['True', 'False'], answer: 'A' }))).toMatchObject({ type: 'TRUE_FALSE', answer: true });
    expect(clean(one({ question: 'S.', options: [{ text: 'True', isCorrect: false }, { text: 'False', isCorrect: true }] }))).toMatchObject({ type: 'TRUE_FALSE', answer: false });
  });

  it('asks for the answer when there is none', () => {
    expect(one({ type: 'true_false', question: 'S.' })).toMatchObject({ warnings: ['No answer was found. Choose true or false.'], errors: ['Choose whether the statement is true or false.'] });
    expect(one({ type: 'true_false', question: 'S.', answer: 'maybe' }).warnings).toEqual(['The answer “maybe” is neither true nor false. Choose true or false.']);
  });

  it('reads a modified true-or-false with its correction', () => {
    expect(clean(one({ type: 'modified true or false', question: 'The powerhouse is the nucleus.', answer: 'False - mitochondria' }))).toMatchObject({ type: 'MODIFIED_TRUE_FALSE', answer: false, correction: ['mitochondria'] });
    expect(clean(one({ type: 'modified_true_false', question: 'S.', answer: true }))).toMatchObject({ answer: true, correction: [] });
    expect(one({ type: 'modified_true_false', question: 'S.', answer: false }).errors).toEqual(['Give the word or phrase that makes the statement true.']);
  });
});

describe('answers that are typed', () => {
  it('reads one answer or several accepted ones', () => {
    expect(clean(one({ question: 'Capital?', answer: 'Manila' }))).toMatchObject({ type: 'IDENTIFICATION', accepted: ['Manila'] });
    expect(clean(one({ question: 'Capital?', answers: ['Manila', 'City of Manila'] })).accepted).toEqual(['Manila', 'City of Manila']);
    expect(clean(one({ question: 'Capital?', answer: 'Manila', alternatives: ['City of Manila', 'manila'] })).accepted).toEqual(['Manila', 'City of Manila']);
    expect(clean(one({ question: 'Year?', answer: 1898 })).accepted).toEqual(['1898']);
    // "TCP/IP" is one answer: a slash is not a list.
    expect(clean(one({ question: 'Protocol?', answer: 'TCP/IP' })).accepted).toEqual(['TCP/IP']);
    expect(clean(one({ type: 'identification', question: 'Capital?', answer: 'Manila', caseSensitive: true })).settings).toEqual({ caseSensitive: true });
    expect(one({ type: 'identification', question: 'Capital?' })).toMatchObject({ warnings: ['No answer was found. Add the accepted answer.'], errors: ['Give at least one accepted answer.'] });
  });

  it('reads a long answer as "short answer", which the teacher looks at when it differs', () => {
    expect(clean(one({ question: 'Why?', answer: 'Because the processor needs somewhere to keep its work' })).type).toBe('SHORT_ANSWER');
    expect(clean(one({ type: 'short_answer', question: 'Why?' })).accepted).toEqual([]);
  });

  it('reads blanks however they are written, and one answer for each', () => {
    expect(clean(one({ type: 'fill_blanks', question: 'A byte has ___ bits.', answer: '8' })).blanks).toEqual([['8']]);
    expect(clean(one({ type: 'fill_blanks', question: 'A byte has ___ bits.', answer: ['8', 'eight'] })).blanks).toEqual([['8', 'eight']]);
    expect(clean(one({ type: 'fill_blanks', question: '___ and ___.', answer: ['a', 'b'] })).blanks).toEqual([['a'], ['b']]);
    expect(clean(one({ type: 'fill_blanks', question: '___ and ___.', blanks: [['a', 'alpha', 'A'], 'b'] })).blanks).toEqual([['a', 'alpha'], ['b']]);
    expect(clean(one({ type: 'fill_blanks', question: '___ and ___.', answer: { 1: 'a', 2: ['b', 'bee'] } })).blanks).toEqual([['a'], ['b', 'bee']]);
    for (const text of ['A byte has [blank] bits.', 'A byte has {{blank}} bits.', 'A byte has (blank) bits.', 'A byte has [__] bits.', 'A byte has __ bits.']) {
      expect([text, clean(one({ type: 'Fill in the blank', question: text, answer: '8' })).text]).toEqual([text, '<p>A byte has ___ bits.</p>']);
    }
    // A blank that is written with underscores stays as it is, brackets and all: print(____)
    expect(clean(one({ type: 'fill_blanks', question: 'Complete it: print(____)', answer: '"hi"' })).text).toBe('<p>Complete it: print(____)</p>');
    expect(clean(one({ type: 'fill_blanks', question: 'A byte has __________ bits.', answer: '8' })).text).toBe('<p>A byte has __________ bits.</p>');
    // Without its type, the blank and the answer say what it is.
    expect(clean(one({ question: 'A byte has ____ bits.', answer: '8' }))).toMatchObject({ type: 'FILL_BLANKS', blanks: [['8']] });
    expect(clean(one({ question: 'A byte has [blank] bits.', answer: '8' }))).toMatchObject({ type: 'FILL_BLANKS', text: '<p>A byte has ___ bits.</p>' });
    // "[]" and "__init__" in a question about code are not blanks.
    expect(one({ question: 'What does [] make in Python, and what is __init__?', answer: 'a list' })).toMatchObject({ type: 'IDENTIFICATION', text: '<p>What does [] make in Python, and what is __init__?</p>' });
  });

  it('says when the blanks and the answers do not add up', () => {
    const split = one({ type: 'fill_blanks', question: '___ and ___.', answer: 'a, b' });
    expect(split).toMatchObject({ blanks: [['a'], ['b']], errors: [] });
    expect(split.warnings.join(' ')).toMatch(/split at the commas/);
    expect(one({ type: 'fill_blanks', question: '___ and ___ and ___.', answer: ['a', 'b'] }).errors).toEqual(['The question has 3 blank(s) but 2 answer(s) were given.']);
    expect(one({ type: 'fill_blanks', question: 'No blank here.', answer: 'a' }).errors[0]).toMatch(/three or more underscores/);
    expect(one({ type: 'fill_blanks', question: 'A ___.' })).toMatchObject({ warnings: ['No answer was found for the blanks.'] });
  });
});

describe('matching and ordering', () => {
  const pairs = [{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }];

  it('reads pairs in the shapes they come in', () => {
    expect(clean(one({ type: 'matching', question: 'Match.', pairs })).pairs).toEqual(pairs);
    expect(clean(one({ question: 'Match.', pairs: [['Keyboard', 'Input'], ['Monitor', 'Output']] }))).toMatchObject({ type: 'MATCHING', pairs });
    expect(clean(one({ question: 'Match.', pairs: { Keyboard: 'Input', Monitor: 'Output' } })).pairs).toEqual(pairs);
    expect(clean(one({ question: 'Match.', matches: [{ term: 'Keyboard', definition: 'Input' }, { term: 'Monitor', definition: 'Output' }] })).pairs).toEqual(pairs);
    expect(clean(one({ type: 'matching', question: 'Match.', answer: { Keyboard: 'Input', Monitor: 'Output' } })).pairs).toEqual(pairs);
    expect(clean(one({ type: 'matching', question: 'Match.', items: [{ item: 'Keyboard', match: 'Input' }, { item: 'Monitor', match: 'Output' }] })).pairs).toEqual(pairs);
  });

  it('pairs two columns by the answer that joins them', () => {
    const columns = { type: 'matching', question: 'Match.', columnA: ['Keyboard', 'Monitor'], columnB: ['Output', 'Input'] };
    expect(clean(one({ ...columns, answer: { Keyboard: 'Input', Monitor: 'Output' } })).pairs).toEqual(pairs);
    expect(clean(one({ ...columns, answer: { 1: 'B', 2: 'A' } })).pairs).toEqual(pairs);
    expect(clean(one({ ...columns, answer: ['B', 'A'] })).pairs).toEqual(pairs);
    expect(clean(one({ ...columns, answer: [1, 0] })).pairs).toEqual(pairs);
    // No answer at all: the columns as they stand, and a warning.
    const guessed = one({ type: 'matching', question: 'Match.', left: ['Keyboard', 'Monitor'], right: ['Input', 'Output'] });
    expect(guessed).toMatchObject({ pairs, errors: [], warnings: ['The two columns were paired in the order they were given. Check each pair.'] });
    expect(one({ type: 'matching', question: 'Match.' }).errors).toEqual(['Add at least two pairs.']);
  });

  it('reads the items of an ordering question in their correct order', () => {
    expect(clean(one({ type: 'ordering', question: 'Order.', items: ['bit', 'byte', 'kilobyte'] })).items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(clean(one({ question: 'Order.', items: ['bit', 'byte', 'kilobyte'] })).type).toBe('ORDERING');
    expect(clean(one({ type: 'sequence', question: 'Order.', steps: ['boot', 'log in'] })).items).toEqual(['boot', 'log in']);
    const shuffled = { question: 'Order.', options: ['byte', 'kilobyte', 'bit'] };
    expect(clean(one({ ...shuffled, correctOrder: ['bit', 'byte', 'kilobyte'] }))).toMatchObject({ type: 'ORDERING', items: ['bit', 'byte', 'kilobyte'] });
    expect(clean(one({ ...shuffled, type: 'ordering', answer: [2, 0, 1] })).items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(clean(one({ ...shuffled, type: 'ordering', answer: [3, 1, 2] })).items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(clean(one({ ...shuffled, type: 'ordering', answer: ['C', 'A', 'B'] })).items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(clean(one({ ...shuffled, type: 'ordering', answer: 'C, A, B' })).items).toEqual(['bit', 'byte', 'kilobyte']);
    expect(one({ ...shuffled, type: 'ordering', answer: ['x', 'y', 'z'] })).toMatchObject({ items: ['byte', 'kilobyte', 'bit'], warnings: [expect.stringMatching(/does not fit the items/)] });
    expect(one({ type: 'ordering', question: 'Order.' }).errors).toEqual(['Add at least two items to put in order.']);
  });
});

describe('questions the teacher marks, and what cannot be told', () => {
  it('keeps a model answer for an essay with the explanation', () => {
    expect(clean(one({ type: 'essay', question: 'Explain RAM.', answer: 'It is temporary.', rubric: ['Says temporary', 'Says fast'], maxWords: 150 }))).toMatchObject({
      type: 'ESSAY', explanation: 'Model answer: It is temporary.\nMarking guide: Says temporary\nSays fast', settings: { wordLimit: 150 },
    });
  });

  it('reads a question with nothing but its text as an essay, and says so', () => {
    expect(one({ question: 'Explain RAM.' })).toMatchObject({ type: 'ESSAY', errors: [], warnings: ['No choices and no answer were found, so this was read as an essay question.'] });
  });

  it('works the type out when the file names one it does not know', () => {
    const q = one({ type: 'riddle', ...MC, answer: 'B' });
    expect([q.type, key(q), q.errors]).toEqual(['MULTIPLE_CHOICE', 'RAM [CPU] Disk Monitor', []]);
    expect(q.warnings).toEqual(['“riddle” is not a type of question Discenda has. The type was worked out from the rest of the question.']);
  });

  it('says that a picture was left behind', () => {
    expect(one({ ...MC, answer: 'B', image: 'https://example.com/cpu.png' }).warnings).toEqual(['The picture of this question was not imported. Add it in the editor.']);
  });

  it('flags a question that is in the file twice', () => {
    const { questions } = read([{ ...MC, answer: 'B' }, { question: 'Other?', answer: 'x' }, { ...MC, question: ' brain of the COMPUTER? ', answer: 'B' }]);
    expect(questions.map((q) => q.warnings)).toEqual([[], [], ['This looks like a duplicate of question 1.']]);
  });

  it('keeps a programming question pointing at its problem', () => {
    expect(clean(one({ type: 'programming', question: 'Even or odd.', programmingProblemId: 'abc123' }))).toMatchObject({ type: 'PROGRAMMING', programmingProblemId: 'abc123' });
    expect(one({ type: 'programming', question: 'Even or odd.' }).errors).toEqual(['Choose a programming problem.']);
  });
});

describe('the text of a question', () => {
  it('is taken literally: nothing in it is HTML', () => {
    expect(one({ question: 'What does the <br> tag do in <b>HTML</b>?', answer: 'breaks the line' }).text).toBe('<p>What does the &lt;br&gt; tag do in &lt;b&gt;HTML&lt;/b&gt;?</p>');
    expect(one({ question: 'What does <script>alert(1)</script> do?', answer: 'nothing' }).text).not.toMatch(/<script/);
    expect(one({ question: 'Is 3 < 5 && 5 > 3?', answer: true }).text).toBe('<p>Is 3 &lt; 5 &amp;&amp; 5 &gt; 3?</p>');
    expect(one({ question: 'First line.\n\nSecond line.', answer: 'x' }).text).toBe('<p>First line.</p><p>Second line.</p>');
    // Stars and underscores stay what they are: "x**2 + y**2" is not bold.
    expect(one({ question: 'What is x**2 + y**2 when my_var = 1?', answer: '2' }).text).toBe('<p>What is x**2 + y**2 when my_var = 1?</p>');
  });

  it('keeps code as code', () => {
    const block = one({ question: 'What does this print?\n```python\nfor i in range(2):\n    print(i < 1)\n```\nChoose one.', options: ['a', 'b'], answer: 'a' });
    expect(block.text).toBe('<p>What does this print?</p><pre><code class="language-python">for i in range(2):\n    print(i &lt; 1)</code></pre><p>Choose one.</p>');
    expect(one({ question: 'What does `len([1, 2])` return?', answer: '2' }).text).toBe('<p>What does <code>len([1, 2])</code> return?</p>');
    expect(one({ question: 'Output?\n```\nprint(1)', answer: '1' }).text).toBe('<p>Output?</p><pre><code>print(1)</code></pre>');
    expect(one({ question: 'Output of ```print(1)```?', answer: '1' }).text).toBe('<p>Output of <code>print(1)</code>?</p>');
    // Code given next to the question, the way some assistants write it.
    expect(one({ question: 'What does this print?', code: 'x = 1\nprint(x)', language: 'python', answer: '1' }).text).toBe('<p>What does this print?</p><pre><code class="language-python">x = 1\nprint(x)</code></pre>');
    // Indentation outside a block is kept too.
    expect(textToHtml('if x:\n    print(x)')).toBe('<p>if x:</p><p>\u00A0\u00A0\u00A0\u00A0print(x)</p>');
    expect(textToHtml('```\n```')).toBe('');
  });

  it('takes HTML where the file says it is HTML', () => {
    expect(one({ questionHtml: '<p>Which is <strong>not</strong> an input device?</p><script>x()</script>', options: ['Mouse', 'Monitor'], answer: 'Monitor' }).text).toBe('<p>Which is <strong>not</strong> an input device?</p>');
    expect(one({ text: '<p>2 + 2 = ?</p>', type: 'TRUE_FALSE', answer: true }).text).toBe('<p>2 + 2 = ?</p>');
    expect(one({ question: 'A passage question?', passage: 'Read this first.', answer: 'x' }).text).toBe('<p>Read this first.</p><p>A passage question?</p>');
  });

  it('goes back to plain text only when nothing is lost', () => {
    for (const text of ['Brain of the computer?', 'Two\nlines', 'Is 3 < 5 & "x" > \'y\'?', 'What does `len(x)` return?', 'Output?\n```python\nfor i in range(2):\n    print(i)\n```', 'if x:\n    print(x)']) {
      const html = sanitizeRichText(textToHtml(text));
      expect([text, htmlToText(html)]).toEqual([text, text]);
    }
    for (const html of ['<p>Which is <strong>not</strong> one?</p>', '<p>One<br>two</p>', '<ul><li>a</li></ul>', '<p>See <img src="https://example.com/a.png"></p>', '<p>A backtick ` alone</p>', '<p>&lt;p&gt;markup as text&lt;/p&gt;</p>', '<p>a</p><p></p><p>b</p>', '']) {
      expect([html, htmlToText(html)]).toEqual([html, null]);
    }
  });
});

describe('what the questions are wrapped in', () => {
  const q = (n, extra = {}) => ({ question: `Question ${n}?`, answer: `answer ${n}`, ...extra });
  const texts = (value) => read(value).questions.map((x) => x.text.replace(/<[^>]+>/g, ''));

  it('finds them in a list, under "questions", deeper, or numbered', () => {
    const expected = ['Question 1?', 'Question 2?'];
    expect(texts([q(1), q(2)])).toEqual(expected);
    expect(texts({ questions: [q(1), q(2)] })).toEqual(expected);
    expect(texts({ quiz: { title: 'Midterm', questions: [q(1), q(2)] } })).toEqual(expected);
    expect(texts({ title: 'Midterm', data: [q(1), q(2)] })).toEqual(expected);
    expect(texts({ 1: q(1), 2: q(2) })).toEqual(expected);
    expect(texts(q(1))).toEqual(['Question 1?']);
    // The title of the quiz is not a part of it.
    expect(read({ title: 'Midterm', questions: [q(1)] }).questions[0].section).toBeUndefined();
  });

  it('gives the questions of a part its type, its points and its heading', () => {
    const { questions, summary } = read({
      sections: [
        { title: 'Part I. True or False', type: 'true_false', pointsEach: 2, questions: [{ question: 'S1.', answer: 'T' }, { question: 'S2.', answer: 'F', points: 5 }] },
        { name: 'Part II', type: 'Identification', items: [q(3)] },
      ],
    });
    expect(questions.map((x) => [x.type, x.points, x.section])).toEqual([['TRUE_FALSE', 2, 'Part I. True or False'], ['TRUE_FALSE', 5, 'Part I. True or False'], ['IDENTIFICATION', 1, 'Part II']]);
    expect(questions[0].answer).toBe(true);
    expect(summary.sections).toEqual(['Part I. True or False', 'Part II']);
  });

  it('takes the type from the name of the list', () => {
    const { questions } = read({ true_false: [{ question: 'S1.', answer: 'T' }], 'Essay Questions': [{ question: 'Explain.' }], multipleChoice: [{ ...MC, answer: 'B' }] });
    expect(questions.map((x) => x.type)).toEqual(['TRUE_FALSE', 'ESSAY', 'MULTIPLE_CHOICE']);
    questions.forEach(clean);
  });

  it('does not take the total of the quiz for the points of each question', () => {
    expect(read({ title: 'Midterm', points: 50, questions: [q(1)] }).questions[0].points).toBe(1);
  });

  it('never takes the choices of a question for questions', () => {
    // A question whose text is under a name nobody uses: its choices have a "text" each.
    const lost = { vraag: 'Brain?', choices: [{ text: 'RAM', isCorrect: false }, { text: 'CPU', isCorrect: true }] };
    expect(() => read([lost])).toThrow(QuestionImportError);
    expect(texts([lost, q(2)])).toEqual(['Question 2?']);
    // Pairs written as question and answer belong to their matching question.
    const matching = read([{ type: 'matching', question: 'Match.', items: [{ question: 'Keyboard', answer: 'Input' }, { question: 'Monitor', answer: 'Output' }] }]).questions;
    expect(matching).toHaveLength(1);
    expect(matching[0].pairs).toEqual([{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }]);
  });

  it(`reads the first ${MAX_IMPORT_QUESTIONS} questions of a longer file`, () => {
    const { questions, notes } = read(Array.from({ length: MAX_IMPORT_QUESTIONS + 5 }, (_, i) => q(i)));
    expect(questions).toHaveLength(MAX_IMPORT_QUESTIONS);
    expect(notes.join(' ')).toMatch(/The file has 305 questions. The first 300 were read/);
  });
});

describe('what was pasted around the JSON', () => {
  const two = '[{"question": "One?", "answer": "1"}, {"question": "Two?", "answer": "2"}]';
  const count = (text) => { const r = read(text); expect(r.notes).toEqual([]); return r.questions.length; };

  it('reads the reply of a chat assistant: sentences, a ``` block, sentences', () => {
    expect(count(`Sure! Here are your questions [as requested]:\n\n\`\`\`json\n${two}\n\`\`\`\n\nLet me know if you want {more}!`)).toBe(2);
    expect(count(`Here you go: ${two} Enjoy.`)).toBe(2);
    expect(count(`\`\`\`json\n${two}`)).toBe(2);
    expect(count(`\uFEFF${two}\r\n`)).toBe(2);
    // Split over two blocks, or one question on each line.
    expect(count('```json\n[{"question": "One?", "answer": "1"}]\n```\nand\n```json\n[{"question": "Two?", "answer": "2"}]\n```')).toBe(2);
    expect(count('{"question": "One?", "answer": "1"}\n{"question": "Two?", "answer": "2"}')).toBe(2);
  });

  it('passes over what JSON does not allow but people write', () => {
    expect(count('[{"question": "One?", "answer": "1",}, {"question": "Two?", "answer": "2"},]')).toBe(2);
    expect(count('[\n  // the first\n  {"question": "One?", "answer": "1"}, /* the\n second */ {"question": "Two?", "answer": "2"}\n]')).toBe(2);
    expect(count('[{\u201Cquestion\u201D: \u201COne?\u201D, \u201Canswer\u201D: \u201C1\u201D}, {\u201Cquestion\u201D: \u201CTwo?\u201D, \u201Canswer\u201D: \u201C2\u201D}]')).toBe(2);
    // Curly quotes inside a text are part of the text.
    expect(one({ question: 'What does \u201Cbit\u201D mean?', answer: 'binary digit' }).text).toBe('<p>What does \u201Cbit\u201D mean?</p>');
    expect(read('[{"question": "A // B, or /* C */?", "answer": "x,}"}]').questions[0]).toMatchObject({ text: '<p>A // B, or /* C */?</p>', accepted: ['x,}'] });
  });

  it('keeps a line break or a tab typed inside a text', () => {
    const { questions, notes } = read('[{"question": "What does this print?\n```\nif x:\n\tprint(1)\n```", "answer": "1"}]');
    expect(notes).toEqual([]);
    expect(questions[0].text).toBe('<p>What does this print?</p><pre><code>if x:\n\tprint(1)</code></pre>');
  });
});

describe('JSON that cannot be read', () => {
  const failure = (text) => { try { read(text); } catch (err) { expect(err).toBeInstanceOf(QuestionImportError); return err.message; } throw new Error('It was read.'); };

  it('says on which line, and what is wrong there', () => {
    expect(failure('[\n  {"question": "What is RAM?,\n   "answer": "memory" },\n  {"question": "ok?", "answer": "yes"}\n]'))
      .toBe('This JSON cannot be read. Line 3: a comma is missing before this, or the text before it is not closed with a double quote ("). It is at: answer": "memory" },');
    expect(failure("[{question: 'x', answer: 'y'}]")).toBe('This JSON cannot be read. Line 1: a name in double quotes is expected here, such as "question". It is at: question: \'x\', answer: \'y\'}]');
    expect(failure('{"question": \'x\'}')).toMatch(/Line 1: texts and names go in double quotes \("\), not single quotes\./);
    expect(failure('{"question" "x"}')).toMatch(/a colon \(:\) is missing after the name/);
    expect(failure('{\n"question": "C:\\Users"\n}')).toMatch(/Line 2: a backslash \(\\\) inside a text has to be written twice/);
    expect(failure('{"question": x}')).toMatch(/a text has to be inside double quotes/);
    expect(failure('{"question": "x", "points": 01}')).toMatch(/something|comma|number/);
  });

  it('says so when there is no JSON, or no question in it', () => {
    expect(failure('hello there')).toMatch(/^No JSON was found/);
    expect(failure('')).toMatch(/^No JSON was found/);
    expect(failure('[]')).toMatch(/^No questions were found in this JSON/);
    expect(failure('{"title": "Midterm", "items": [1, 2, 3]}')).toMatch(/^No questions were found in this JSON. Every question needs its text under the name "question"/);
    expect(failure('{"questions": [{"question": "Thr')).toMatch(/stops before its end/);
  });

  it('is not brought down by brackets nested thousands deep', () => {
    expect(failure('['.repeat(20_000))).toMatch(/^No JSON was found/);
    expect(failure('{"a":'.repeat(20_000))).toMatch(/stops before its end/);
    expect(failure(`${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`)).toMatch(/No questions were found|nested too deeply/);
    expect(failure(`${'['.repeat(20_000)}{"question": "x"}${']'.repeat(20_000)}`)).toMatch(/No questions were found|nested too deeply/);
  });

  it('reads the questions that are whole when the end is missing', () => {
    const { questions, notes } = read('{"questions": [ {"question": "One?", "answer": "1"}, {"question": "Two?", "answer": "2"}, {"question": "Thr');
    expect(questions.map((q) => q.accepted[0])).toEqual(['1', '2']);
    expect(notes).toEqual(['The JSON stops before its end, as if it was cut off when it was copied. The questions that are complete were read: check that none is missing at the end.']);
  });

  it('reads around a mistake, and says where it is', () => {
    const missingComma = read('[\n  {"question": "One?", "answer": "1"}\n  {"question": "Two?", "answer": "2"}\n]');
    expect(missingComma.questions).toHaveLength(2);
    expect(missingComma.notes).toEqual(['The JSON has a mistake. Line 3: a comma is missing before this, or the text before it is not closed with a double quote ("). It is at: {"question": "Two?", "answer": "2"} — What could be read around it was read piece by piece: check that no question is missing.']);
    // A question that is broken is left out — and its choices are not taken for questions.
    const broken = read('{"questions": [\n {"question": "One?", "answer": "1"},\n {"question": "Brain?", "choices": [{"text": "RAM"}, {"text": "CPU", "isCorrect": true}], "points": },\n {"question": "Three?", "answer": "3"}\n]}');
    expect(broken.questions.map((q) => q.text)).toEqual(['<p>One?</p>', '<p>Three?</p>']);
    expect(broken.notes[0]).toMatch(/^The JSON has a mistake\. Line 3: a value is missing just before this\./);
  });

  it('finds the first thing that is wrong', () => {
    expect(findJsonError('{"a": 1}')).toBeNull();
    expect(findJsonError('[1, 2,]')).toMatchObject({ at: 6, reason: 'there is one comma too many before this bracket' });
    expect(findJsonError('{"a": 1,}')).toMatchObject({ at: 8, reason: 'there is one comma too many before this brace' });
    expect(findJsonError('{"a": 1} x')).toMatchObject({ at: 9, reason: 'something follows the end of the JSON' });
    expect(findJsonError('{"a": "x')).toMatchObject({ at: 6, ended: true });
    expect(findJsonError('[1, 2')).toMatchObject({ ended: true });
    expect(findJsonError('{"a": \u201Cx\u201D}')).toMatchObject({ at: 6, reason: 'this is a curly quote (“ ”). JSON needs the straight one (")' });
    expect(findJsonError('{"a": tru}')).toMatchObject({ at: 6 });
  });
});

describe('telling JSON from a test paper', () => {
  const paper = '1. 2 + 2 = ?\nA. 3\nB. 4\nAnswer: B\n\n2. The earth is flat.\nAnswer: False';

  it('reads each in its own way', () => {
    expect(looksLikeJson(paper)).toBe(false);
    expect(parseImport(paper)).toMatchObject({ format: 'text', summary: { found: 2 } });
    expect(parseImport('[{"question": "One?", "answer": "1"}]')).toMatchObject({ format: 'json', summary: { found: 1 } });
    expect(looksLikeJson('Here: [{"question": "x"}]')).toBe(true);
    expect(looksLikeJson('  {"questions": []}')).toBe(true);
    expect(looksLikeJson('anything', 'quiz.JSON')).toBe(true);
    expect(looksLikeJson('[Midterm examination]\n1. What?')).toBe(false);
  });

  it('reads a paper that only looks like JSON as a paper', () => {
    const withCode = `${paper}\n\n3. What does this make?\n{"a": 1}\nAnswer: a dictionary`;
    expect(parseImport(withCode)).toMatchObject({ format: 'text', summary: { found: 3 } });
    const bracketed = `{Midterm}\n${paper}`;
    expect(parseImport(bracketed)).toMatchObject({ format: 'text', summary: { found: 2 } });
    // A file that says it is JSON is held to it.
    expect(() => parseImport(paper, { filename: 'quiz.json' })).toThrow(/No JSON was found/);
    expect(() => parseImport('{"question": "x" "answer": 1}')).toThrow(/This JSON cannot be read/);
  });
});

describe('questions written as JSON', () => {
  const stored = [
    { type: 'MULTIPLE_CHOICE', text: '<p>Brain of the computer?</p>', points: 2, difficulty: 'EASY', topic: 'Hardware', section: 'Part I', explanation: 'It executes.', settings: {}, choices: [{ text: 'RAM', isCorrect: false }, { text: 'CPU', isCorrect: true }] },
    { type: 'MULTIPLE_CHOICE', text: '<p>Which letter?</p>', points: 1, difficulty: 'MEDIUM', settings: {}, choices: [{ text: 'B', isCorrect: false }, { text: 'A', isCorrect: true }, { text: 'A and B', isCorrect: false }] },
    { type: 'MULTIPLE_CHOICE', text: '<p>Lettered by hand</p>', points: 1, difficulty: 'MEDIUM', settings: {}, choices: [{ text: 'A. one', isCorrect: false }, { text: 'B. two', isCorrect: true }] },
    { type: 'MULTIPLE_CHOICE', text: '<p>2 + 2 = ?</p>', points: 1, difficulty: 'MEDIUM', settings: {}, choices: [{ text: '1', isCorrect: false }, { text: '2', isCorrect: false }, { text: '4', isCorrect: true }, { text: 'True', isCorrect: false }] },
    { type: 'MULTIPLE_RESPONSE', text: '<p>Input devices?</p>', points: 2, difficulty: 'MEDIUM', settings: { partialCredit: false }, choices: [{ text: 'Keyboard', isCorrect: true }, { text: 'Monitor', isCorrect: false }, { text: 'Mouse', isCorrect: true }] },
    { type: 'TRUE_FALSE', text: '<p>A byte has 8 bits.</p>', points: 1, difficulty: 'MEDIUM', settings: {}, answer: true },
    { type: 'TRUE_FALSE', text: '<p>A byte has 4 bits.</p>', points: 1, difficulty: 'MEDIUM', settings: {}, answer: false },
    { type: 'MODIFIED_TRUE_FALSE', text: '<p>The powerhouse is the nucleus.</p>', points: 2, difficulty: 'HARD', settings: {}, answer: false, correction: ['mitochondria', 'the mitochondria'] },
    { type: 'MODIFIED_TRUE_FALSE', text: '<p>The sun is a star.</p>', points: 2, difficulty: 'MEDIUM', settings: {}, answer: true, correction: [] },
    { type: 'IDENTIFICATION', text: '<p>Capital?</p>', points: 1, difficulty: 'MEDIUM', settings: { caseSensitive: true }, accepted: ['Manila', 'City of Manila', '1'] },
    { type: 'SHORT_ANSWER', text: '<p>Why?</p>', points: 3, difficulty: 'MEDIUM', settings: {}, accepted: [] },
    { type: 'FILL_BLANKS', text: '<p>A byte has ___ bits and a nibble has ___.</p>', points: 2, difficulty: 'MEDIUM', settings: {}, blanks: [['8', 'eight'], ['4']] },
    { type: 'FILL_BLANKS', text: '<p>One ___ only.</p>', points: 1, difficulty: 'MEDIUM', settings: {}, blanks: [['a', 'b']] },
    { type: 'MATCHING', text: '<p>Match.</p>', points: 2, difficulty: 'MEDIUM', settings: {}, pairs: [{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }] },
    { type: 'ORDERING', text: '<p>Smallest first.</p>', points: 2, difficulty: 'MEDIUM', settings: { partialCredit: true }, items: ['bit', 'byte', 'kilobyte'] },
    { type: 'ESSAY', text: '<p>Explain <strong>RAM</strong>.</p><ul><li>briefly</li></ul>', points: 10, difficulty: 'HARD', explanation: 'Temporary and fast.', settings: { wordLimit: 200 } },
    { type: 'FILE_UPLOAD', text: '<p>Upload your diagram.</p>', points: 5, difficulty: 'MEDIUM', settings: {} },
    { type: 'PROGRAMMING', text: '<p>Even or odd.</p>', points: 10, difficulty: 'MEDIUM', settings: {}, programmingProblemId: 'problem-1' },
    { type: 'IDENTIFICATION', text: '<p>What does this print?</p><pre><code class="language-python">for i in range(2):\n    print(i)</code></pre>', points: 1, difficulty: 'MEDIUM', settings: {}, accepted: ['0 1'] },
    { type: 'IDENTIFICATION', text: '<p>What does <code>len(x)</code> return, and the &lt;br&gt; tag?</p>', points: 1, difficulty: 'MEDIUM', settings: {}, accepted: ['a number'] },
  ];
  const fields = ['type', 'text', 'points', 'difficulty', 'topic', 'section', 'explanation', 'choices', 'answer', 'correction', 'accepted', 'blanks', 'pairs', 'items', 'programmingProblemId'];
  const shape = (q) => ({ ...Object.fromEntries(fields.filter((f) => q[f] !== undefined && q[f] !== '').map((f) => [f, q[f]])), settings: q.settings ?? {} });

  it('reads back as the questions that were written', () => {
    const file = questionsToJson(stored, { title: 'Quiz 1' });
    expect(file).toMatchObject({ format: 'discenda.questions', version: 1, title: 'Quiz 1' });
    const { questions, notes } = read(JSON.stringify(file, null, 2));
    expect(notes).toEqual([]);
    questions.forEach(clean);
    expect(questions.map(shape)).toEqual(stored.map(shape));
    // …and what is stored of them is the same, down to the answer key.
    expect(questions.map((q) => normalizeQuestion(q))).toEqual(stored.map((q) => normalizeQuestion(q)));
  });

  it('is written the way the format is documented', () => {
    const { questions } = questionsToJson(stored);
    expect(questions[0]).toEqual({ type: 'multiple_choice', question: 'Brain of the computer?', choices: ['RAM', 'CPU'], answer: 'CPU', points: 2, difficulty: 'easy', topic: 'Hardware', section: 'Part I', explanation: 'It executes.' });
    expect(questions[4]).toMatchObject({ type: 'multiple_response', answer: ['Keyboard', 'Mouse'], partialCredit: false });
    expect(questions[5]).toEqual({ type: 'true_false', question: 'A byte has 8 bits.', answer: true, points: 1, difficulty: 'medium' });
    expect(questions[7]).toMatchObject({ answer: false, correction: ['mitochondria', 'the mitochondria'] });
    expect(questions[8]).not.toHaveProperty('correction');
    expect(questions[11]).toMatchObject({ type: 'fill_blanks', answer: [['8', 'eight'], ['4']] });
    // Formatting that plain text cannot carry travels as HTML.
    expect(questions[15]).toMatchObject({ type: 'essay', questionHtml: '<p>Explain <strong>RAM</strong>.</p><ul><li>briefly</li></ul>', wordLimit: 200 });
    expect(questions[15]).not.toHaveProperty('question');
    expect(questions[18].question).toBe('What does this print?\n```python\nfor i in range(2):\n    print(i)\n```');
    expect(questions[19].question).toBe('What does `len(x)` return, and the <br> tag?');
  });
});
