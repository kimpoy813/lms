import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { docxToText, extractImportText, parseQuestions } from '../../src/lib/questionImport.js';
import {
  attemptTotals, buildSnapshot, correctAnswer, normalizeAnswer, normalizeQuestion, publicQuestion, sanitizeResponse, scoreAnswer, toEditorShape,
} from '../../src/lib/quizScoring.js';
import { quizOutcome } from '../../src/modules/quizzes/attemptScore.js';

/** Build a stored question (as Prisma would return it) from editor shape. */
let nextId = 0;
function stored(input) {
  const { errors, data, choices } = normalizeQuestion(input);
  expect(errors, JSON.stringify(input)).toEqual([]);
  return { id: `q${(nextId += 1)}`, ...data, choices: choices.map((c) => ({ ...c, id: `c${(nextId += 1)}` })) };
}
const snap = (input, options) => buildSnapshot(stored(input), options);
const score = (snapshot, raw, points = 10) => scoreAnswer(snapshot, sanitizeResponse(snapshot, raw), points);
const idOf = (snapshot, text) => snapshot.choices.find((c) => c.text === text).id;

describe('question validation', () => {
  it('accepts well-formed questions of every type', () => {
    const ok = [
      { type: 'MULTIPLE_CHOICE', text: 'Pick', choices: [{ text: 'a', isCorrect: true }, { text: 'b' }] },
      { type: 'MULTIPLE_RESPONSE', text: 'Pick', choices: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: true }, { text: 'c' }] },
      { type: 'TRUE_FALSE', text: 'Sky is blue', answer: true },
      { type: 'MODIFIED_TRUE_FALSE', text: 'The CPU stores data permanently', answer: false, correction: ['hard disk'] },
      { type: 'IDENTIFICATION', text: 'Capital?', accepted: ['Manila'] },
      { type: 'SHORT_ANSWER', text: 'Why?' },
      { type: 'ESSAY', text: 'Discuss', settings: { wordLimit: 300 } },
      { type: 'FILL_BLANKS', text: '___ and ____', blanks: [['a'], ['b', 'B2']] },
      { type: 'MATCHING', text: 'Match', pairs: [{ left: 'a', right: '1' }, { left: 'b', right: '2' }] },
      { type: 'ORDERING', text: 'Order', items: ['one', 'two', 'three'] },
      { type: 'FILE_UPLOAD', text: 'Upload your diagram' },
    ];
    for (const q of ok) expect(normalizeQuestion(q).errors, q.type).toEqual([]);
  });

  it('explains what is wrong', () => {
    const errors = (q) => normalizeQuestion(q).errors.join(' ');
    expect(errors({ type: 'NOPE', text: 'x' })).toMatch(/question type/);
    expect(errors({ type: 'MULTIPLE_CHOICE', text: '', choices: [] })).toMatch(/Write the question.*at least two choices/);
    expect(errors({ type: 'MULTIPLE_CHOICE', text: 'x', choices: [{ text: 'a' }, { text: 'b' }] })).toMatch(/Mark the correct choice/);
    expect(errors({ type: 'MULTIPLE_CHOICE', text: 'x', choices: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: true }] })).toMatch(/exactly one/);
    expect(errors({ type: 'MULTIPLE_CHOICE', text: 'x', choices: [{ text: 'Same', isCorrect: true }, { text: ' same ' }] })).toMatch(/the same/);
    expect(errors({ type: 'TRUE_FALSE', text: 'x' })).toMatch(/true or false/);
    expect(errors({ type: 'MODIFIED_TRUE_FALSE', text: 'x', answer: false })).toMatch(/makes the statement true/);
    expect(errors({ type: 'IDENTIFICATION', text: 'x', accepted: ['  '] })).toMatch(/accepted answer/);
    expect(errors({ type: 'FILL_BLANKS', text: 'no blanks here', blanks: [['a']] })).toMatch(/underscores/);
    expect(errors({ type: 'FILL_BLANKS', text: '___ and ___', blanks: [['a']] })).toMatch(/2 blank\(s\) but 1/);
    expect(errors({ type: 'MATCHING', text: 'x', pairs: [{ left: 'a', right: '1' }] })).toMatch(/two pairs/);
    expect(errors({ type: 'ORDERING', text: 'x', items: ['a', 'a'] })).toMatch(/the same/);
    expect(errors({ type: 'ESSAY', text: 'x', points: 0 })).toMatch(/Points/);
    expect(errors({ type: 'PROGRAMMING', text: 'x' })).toMatch(/programming problem/);
  });

  it('round-trips through storage', () => {
    const input = { type: 'MATCHING', text: 'Match', points: 4, pairs: [{ left: 'CPU', right: 'Processor' }, { left: 'RAM', right: 'Memory' }], topic: 'Hardware', difficulty: 'HARD' };
    expect(toEditorShape(stored(input))).toMatchObject({ type: 'MATCHING', points: 4, pairs: input.pairs, topic: 'Hardware', difficulty: 'HARD' });
    expect(toEditorShape(stored({ type: 'TRUE_FALSE', text: 'x', answer: false })).answer).toBe(false);
    expect(toEditorShape(stored({ type: 'ORDERING', text: 'x', items: ['b', 'a', 'c'] })).items).toEqual(['b', 'a', 'c']);
  });
});

describe('what students receive', () => {
  it('never contains the answer key', () => {
    const questions = [
      { type: 'MULTIPLE_CHOICE', text: 'Pick', explanation: 'SECRET-EXPLANATION', choices: [{ text: 'right-one', isCorrect: true }, { text: 'wrong-one' }] },
      { type: 'MODIFIED_TRUE_FALSE', text: 'Statement', answer: false, correction: ['SECRET-CORRECTION'] },
      { type: 'IDENTIFICATION', text: 'Capital?', accepted: ['SECRET-ANSWER'] },
      { type: 'FILL_BLANKS', text: 'The ___ is', blanks: [['SECRET-BLANK']] },
      { type: 'MATCHING', text: 'Match', pairs: [{ left: 'a', right: '1' }, { left: 'b', right: '2' }, { left: 'c', right: '3' }] },
      { type: 'ORDERING', text: 'Order', items: ['one', 'two', 'three', 'four'] },
    ];
    for (const q of questions) {
      const snapshot = snap(q, { shuffleChoices: true });
      const json = JSON.stringify(publicQuestion(snapshot));
      expect(json, q.type).not.toMatch(/SECRET|isCorrect|answerKey|explanation|matchText/);
    }
    const ordering = snap(questions[5]);
    expect(publicQuestion(ordering).items.map((i) => i.id)).not.toEqual(ordering.choices.map((c) => c.id)); // never presented already solved
    const matching = snap(questions[4]);
    expect(publicQuestion(matching).right.map((r) => r.id)).not.toEqual(matching.choices.map((c) => c.id));
    expect(publicQuestion(matching).left.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('shuffles choices per attempt when asked, keeping the same set', () => {
    const q = stored({ type: 'MULTIPLE_CHOICE', text: 'Pick', choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((text, i) => ({ text, isCorrect: i === 0 })) });
    const orders = new Set(Array.from({ length: 12 }, () => buildSnapshot(q, { shuffleChoices: true }).choices.map((c) => c.text).join('')));
    expect(orders.size).toBeGreaterThan(1);
    expect([...orders].every((o) => [...o].sort().join('') === 'abcdefgh')).toBe(true);
    expect(buildSnapshot(q).choices.map((c) => c.text).join('')).toBe('abcdefgh');
  });
});

describe('answer normalisation', () => {
  it('ignores case, spacing, trailing punctuation and typographic quotes', () => {
    expect(normalizeAnswer('  Central   Processing Unit. ')).toBe('central processing unit');
    expect(normalizeAnswer('It’s')).toBe("it's");
    expect(normalizeAnswer('ＣＰＵ')).toBe('cpu');
    expect(normalizeAnswer('CPU', { caseSensitive: true })).toBe('CPU');
  });
});

describe('automatic scoring', () => {
  it('multiple choice and true/false are all or nothing', () => {
    const mc = snap({ type: 'MULTIPLE_CHOICE', text: 'Pick', choices: [{ text: 'a', isCorrect: true }, { text: 'b' }] });
    expect(score(mc, { choiceId: idOf(mc, 'a') })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(mc, { choiceId: idOf(mc, 'b') })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(score(mc, { choiceId: 'forged-id' }).autoScore).toBe(0);
    expect(score(mc, null).autoScore).toBe(0);
    const tf = snap({ type: 'TRUE_FALSE', text: 'x', answer: false });
    expect(score(tf, { choiceId: idOf(tf, 'False') }).autoScore).toBe(10);
    expect(score(tf, { choiceId: idOf(tf, 'True') }).autoScore).toBe(0);
  });

  it('multiple response gives partial credit and penalises wrong picks', () => {
    const q = { type: 'MULTIPLE_RESPONSE', text: 'Pick', choices: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: true }, { text: 'c' }, { text: 'd' }] };
    const s = snap(q);
    const pick = (...texts) => score(s, { choiceIds: texts.map((t) => idOf(s, t)) });
    expect(pick('a', 'b')).toMatchObject({ autoScore: 10, isCorrect: true });
    expect(pick('a')).toMatchObject({ autoScore: 5, isCorrect: false });
    expect(pick('a', 'c').autoScore).toBe(0);
    expect(pick('a', 'b', 'c').autoScore).toBe(5);
    expect(pick('a', 'b', 'c', 'd').autoScore).toBe(0); // ticking everything earns nothing
    expect(pick('c', 'd').autoScore).toBe(0); // never negative
    const strict = snap({ ...q, settings: { partialCredit: false } });
    expect(score(strict, { choiceIds: [idOf(strict, 'a')] }).autoScore).toBe(0);
  });

  it('modified true/false needs the correction when the statement is false', () => {
    const s = snap({ type: 'MODIFIED_TRUE_FALSE', text: 'RAM is permanent storage', answer: false, correction: ['temporary', 'volatile'] });
    const F = idOf(s, 'False');
    expect(score(s, { choiceId: F, correction: ' Volatile. ' }).autoScore).toBe(10);
    expect(score(s, { choiceId: F, correction: 'fast' }).autoScore).toBe(5);
    expect(score(s, { choiceId: F }).autoScore).toBe(5);
    expect(score(s, { choiceId: idOf(s, 'True'), correction: 'volatile' }).autoScore).toBe(0);
    const t = snap({ type: 'MODIFIED_TRUE_FALSE', text: 'RAM is volatile', answer: true });
    expect(score(t, { choiceId: idOf(t, 'True') }).autoScore).toBe(10);
    expect(score(t, { choiceId: idOf(t, 'False'), correction: 'x' }).autoScore).toBe(0);
  });

  it('identification matches any accepted answer; short answers that miss go to the teacher', () => {
    const id = snap({ type: 'IDENTIFICATION', text: 'Capital?', accepted: ['Manila', 'City of Manila'] });
    expect(score(id, { text: 'manila' }).autoScore).toBe(10);
    expect(score(id, { text: ' CITY OF  MANILA ' }).autoScore).toBe(10);
    expect(score(id, { text: 'Cebu' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    const cs = snap({ type: 'IDENTIFICATION', text: 'Symbol?', accepted: ['Na'], settings: { caseSensitive: true } });
    expect(score(cs, { text: 'NA' }).autoScore).toBe(0);
    expect(score(cs, { text: 'Na' }).autoScore).toBe(10);

    const short = snap({ type: 'SHORT_ANSWER', text: 'Why?', accepted: ['because of gravity'] });
    expect(score(short, { text: 'Because of gravity' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(short, { text: 'gravity pulls it' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: true });
    expect(score(snap({ type: 'SHORT_ANSWER', text: 'Why?' }), { text: 'anything' })).toEqual({ autoScore: null, isCorrect: null, needsManual: true });
  });

  it('fill in the blanks, matching and ordering', () => {
    const fill = snap({ type: 'FILL_BLANKS', text: '___ is to ___ as ___', blanks: [['a'], ['b', 'bee'], ['c']] });
    expect(score(fill, { blanks: ['A', 'bee', 'c'] }, 9).autoScore).toBe(9);
    expect(score(fill, { blanks: ['a', 'x', 'c'] }, 9).autoScore).toBe(6);
    expect(score(fill, { blanks: ['c', 'b', 'a'] }, 9).autoScore).toBe(3); // position matters
    expect(score(fill, { blanks: ['', '', ''] }, 9).autoScore).toBe(0);

    const match = snap({ type: 'MATCHING', text: 'Match', pairs: [{ left: 'a', right: '1' }, { left: 'b', right: '2' }, { left: 'c', right: '1' }] });
    const [a, b, c] = match.choices.map((x) => x.id);
    expect(score(match, { pairs: { [a]: a, [b]: b, [c]: c } }, 9).autoScore).toBe(9);
    expect(score(match, { pairs: { [a]: c, [b]: b, [c]: a } }, 9).autoScore).toBe(9); // identical right-hand texts are interchangeable
    expect(score(match, { pairs: { [a]: b, [b]: a, [c]: c } }, 9).autoScore).toBe(3);
    expect(score(match, { pairs: { [a]: 'forged' } }, 9).autoScore).toBe(0);

    const order = snap({ type: 'ORDERING', text: 'Order', items: ['one', 'two', 'three', 'four'] });
    const ids = order.choices.map((x) => x.id);
    expect(score(order, { order: ids }).autoScore).toBe(10);
    expect(score(order, { order: [ids[1], ids[0], ids[2], ids[3]] }).autoScore).toBe(0);
    expect(score(order, { order: ids.slice(0, 3) }).autoScore).toBe(0); // not a full permutation
    const lenient = snap({ type: 'ORDERING', text: 'Order', items: ['one', 'two', 'three', 'four'], settings: { partialCredit: true } });
    const lids = lenient.choices.map((x) => x.id);
    expect(score(lenient, { order: [lids[1], lids[0], lids[2], lids[3]] }).autoScore).toBe(5);
  });

  it('essays and uploads wait for the teacher; blank ones score zero', () => {
    const essay = snap({ type: 'ESSAY', text: 'Discuss' });
    expect(score(essay, { text: 'My essay' })).toEqual({ autoScore: null, isCorrect: null, needsManual: true });
    expect(score(essay, { text: '   ' })).toEqual({ autoScore: 0, isCorrect: null, needsManual: false });
    const upload = snap({ type: 'FILE_UPLOAD', text: 'Upload' });
    expect(score(upload, { fileIds: ['abc123'] }).needsManual).toBe(true);
    expect(score(upload, { fileIds: ['../etc/passwd'] }).needsManual).toBe(false);
  });

  it('reveals correct answers in display form', () => {
    const mc = snap({ type: 'MULTIPLE_CHOICE', text: 'Pick', choices: [{ text: 'a' }, { text: 'b', isCorrect: true }] });
    expect(correctAnswer(mc)).toEqual({ choiceId: idOf(mc, 'b') });
    expect(correctAnswer(snap({ type: 'IDENTIFICATION', text: 'x', accepted: ['y'] }))).toEqual({ accepted: ['y'] });
    expect(correctAnswer(snap({ type: 'ESSAY', text: 'x' }))).toBeNull();
  });

  it('totals an attempt, preferring the teacher\'s score', () => {
    expect(attemptTotals([{ autoScore: 5, needsManual: false }, { autoScore: null, needsManual: true }, { autoScore: 2, manualScore: 4, needsManual: true }]))
      .toEqual({ autoScore: 5, manualScore: 4, totalScore: 9, needsManualGrading: true });
    expect(attemptTotals([{ autoScore: 5, needsManual: false }, { autoScore: 0, manualScore: 3, needsManual: true }]))
      .toEqual({ autoScore: 5, manualScore: 3, totalScore: 8, needsManualGrading: false });
  });
});

describe('which attempt counts', () => {
  const attempt = (attemptNumber, totalScore, extra = {}) => ({ id: `a${attemptNumber}`, attemptNumber, status: 'SUBMITTED', needsManualGrading: false, totalScore, maxScore: 10, ...extra });
  it('highest, latest and average', () => {
    const attempts = [attempt(1, 6), attempt(2, 9), attempt(3, 7)];
    expect(quizOutcome(attempts, 'HIGHEST')).toMatchObject({ fraction: 0.9, attemptId: 'a2', pending: false });
    expect(quizOutcome(attempts, 'LATEST')).toMatchObject({ fraction: 0.7, attemptId: 'a3' });
    expect(quizOutcome(attempts, 'AVERAGE').fraction).toBeCloseTo(0.7333, 3);
  });
  it('ignores attempts in progress and waits for manual grading where it matters', () => {
    expect(quizOutcome([], 'HIGHEST')).toBeNull();
    expect(quizOutcome([attempt(1, null, { status: 'IN_PROGRESS' })], 'HIGHEST')).toBeNull();
    const pending = [attempt(1, 6), attempt(2, 3, { needsManualGrading: true })];
    expect(quizOutcome(pending, 'HIGHEST')).toMatchObject({ fraction: 0.6, pending: true });
    expect(quizOutcome(pending, 'LATEST')).toMatchObject({ fraction: null, pending: true });
    expect(quizOutcome(pending, 'AVERAGE')).toMatchObject({ fraction: null, pending: true });
    expect(quizOutcome([attempt(1, 5, { maxScore: 0 })], 'HIGHEST').fraction).toBe(0);
  });
});

describe('importing a test paper', () => {
  const paper = `
Midterm Examination in IT 101
Name: ______________   Date: ________

Part I. Multiple Choice (2 points each)
1. Which device is the "brain" of the computer?
A. Monitor
B. CPU
C. Keyboard
D. Mouse
Answer: B

2. Which of the following are input devices?
   a) Mouse *
   b) Printer
   c) Keyboard *
   d) Speaker

Part II. True or False
3. RAM is volatile memory.
Answer: True
4. An operating system is hardware. (True/False)
Answer: F

Part III. Identification
5. The physical parts of a computer.
Answer: Hardware / computer hardware
6. ________ is the capital of the Philippines.
Answer: Manila

Part IV. Essay
7. Explain the fetch-decode-execute cycle. (10 points)

8. This one has choices but no key
A. first
B. second
`;

  it('recognises sections, types, answers and points', () => {
    const { questions, summary } = parseQuestions(paper);
    expect(questions.map((q) => [q.number, q.type])).toEqual([
      [1, 'MULTIPLE_CHOICE'], [2, 'MULTIPLE_RESPONSE'], [3, 'TRUE_FALSE'], [4, 'TRUE_FALSE'], [5, 'IDENTIFICATION'], [6, 'FILL_BLANKS'], [7, 'ESSAY'], [8, 'MULTIPLE_CHOICE'],
    ]);
    expect(questions[0]).toMatchObject({ points: 2, section: 'Part I. Multiple Choice (2 points each)', errors: [], warnings: [] });
    expect(questions[0].choices).toEqual([{ text: 'Monitor', isCorrect: false }, { text: 'CPU', isCorrect: true }, { text: 'Keyboard', isCorrect: false }, { text: 'Mouse', isCorrect: false }]);
    expect(questions[0].text).toBe('<p>Which device is the &quot;brain&quot; of the computer?</p>');
    expect(questions[1].choices.filter((c) => c.isCorrect).map((c) => c.text)).toEqual(['Mouse', 'Keyboard']);
    expect(questions[2].answer).toBe(true);
    expect(questions[3]).toMatchObject({ answer: false, text: '<p>An operating system is hardware.</p>' });
    expect(questions[4].accepted).toEqual(['Hardware', 'computer hardware']);
    expect(questions[5].blanks).toEqual([['Manila']]);
    expect(questions[6]).toMatchObject({ type: 'ESSAY', points: 10, errors: [] });
    // The header's "Name: ____" line is not a question.
    expect(questions).toHaveLength(8);
    expect(summary).toMatchObject({ found: 8, ready: 7, needsReview: 1 });
  });

  it('flags what the teacher must fix instead of guessing', () => {
    const { questions } = parseQuestions(paper);
    expect(questions[7].warnings.join(' ')).toMatch(/No answer was found/);
    expect(questions[7].errors.join(' ')).toMatch(/Mark the correct choice/);
    const odd = parseQuestions('1. Pick one\nA. x\nB. y\nAnswer: E\n\n2. Pick one\nA. x\nB. y\nAnswer: E\n\n3. Something with no answer at all');
    expect(odd.questions[0].warnings.join(' ')).toMatch(/does not match any choice/);
    expect(odd.questions[1].warnings.join(' ')).toMatch(/duplicate of question 1/);
    expect(odd.questions[2]).toMatchObject({ type: 'ESSAY' });
    expect(odd.questions[2].warnings.join(' ')).toMatch(/imported as an essay/);
    expect(parseQuestions('Just a paragraph of text with no numbering.').notes.join(' ')).toMatch(/No numbered questions/);
  });

  it('uses a trailing answer key and says so', () => {
    const { questions, notes } = parseQuestions('1) First?\nA. a\nB. b\n2) Earth is flat.\n3) Largest planet?\n\nANSWER KEY\n1. B   2. False\n3. Jupiter');
    expect(questions[0].choices.find((c) => c.isCorrect).text).toBe('b');
    expect(questions[1]).toMatchObject({ type: 'TRUE_FALSE', answer: false });
    expect(questions[2]).toMatchObject({ type: 'IDENTIFICATION', accepted: ['Jupiter'] });
    expect(questions[0].warnings.join(' ')).toMatch(/answer key at the end/);
    expect(notes.join(' ')).toMatch(/answer key with 3 answer/);
  });

  it('handles choices on one line and answers quoted by text', () => {
    const { questions } = parseQuestions('1. 2 + 2 = ?\nA. 3    B. 4    C. 5\nAnswer: 4\n2. Multi-line question\nthat continues here?\nA. yes (correct)\nB. no');
    expect(questions[0].choices).toEqual([{ text: '3', isCorrect: false }, { text: '4', isCorrect: true }, { text: '5', isCorrect: false }]);
    expect(questions[1].text).toBe('<p>Multi-line question that continues here?</p>');
    expect(questions[1].choices[0]).toEqual({ text: 'yes', isCorrect: true });
  });

  it('escapes markup found in the document', () => {
    const { questions } = parseQuestions('1. What does <script>alert(1)</script> do?\nAnswer: nothing');
    expect(questions[0].text).toBe('<p>What does &lt;script&gt;alert(1)&lt;/script&gt; do?</p>');
  });

  it('reads Word documents, including automatic numbering and bold answers', async () => {
    const p = (text, { num, bold } = {}) =>
      `<w:p>${num ? `<w:pPr><w:numPr><w:ilvl w:val="${num[1]}"/><w:numId w:val="${num[0]}"/></w:numPr></w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${[
      p('Quiz 1 &amp; Review'),
      p('What is 1 + 1?', { num: [3, 0] }),
      p('One', { num: [3, 1] }),
      p('Two', { num: [3, 1], bold: true }),
      p('The sun is a star.', { num: [3, 0] }),
      p('Answer: True'),
    ].join('')}</w:body></w:document>`;
    const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>') }));
    expect(docxToText(docx).split('\n')).toEqual(['Quiz 1 & Review', '1. What is 1 + 1?', 'A. One', '*B. Two', '2. The sun is a star.', 'Answer: True']);
    const { questions } = parseQuestions(await extractImportText(docx, 'Quiz.DOCX'));
    expect(questions[0].choices).toEqual([{ text: 'One', isCorrect: false }, { text: 'Two', isCorrect: true }]);
    expect(questions[1]).toMatchObject({ type: 'TRUE_FALSE', answer: true });
    await expect(extractImportText(Buffer.from('not a zip'), 'x.docx')).rejects.toThrow(/not a valid Word document/);
    await expect(extractImportText(Buffer.from('x'), 'old.doc')).rejects.toThrow(/save it as \.docx/);
    await expect(extractImportText(Buffer.from('x'), 'sheet.xlsx')).rejects.toThrow(/TXT, DOCX or PDF/);
  });

  it('reads text PDFs', async () => {
    const { buildDocumentPdf } = await import('../../src/lib/pdf.js');
    const pdf = await buildDocumentPdf({ title: 'Quiz', blocks: [{ type: 'paragraph', text: '1. The capital of France?' }, { type: 'paragraph', text: 'Answer: Paris' }] });
    const text = await extractImportText(pdf, 'quiz.pdf');
    const { questions } = parseQuestions(text);
    expect(questions[0]).toMatchObject({ type: 'IDENTIFICATION', accepted: ['Paris'] });
  });
});
