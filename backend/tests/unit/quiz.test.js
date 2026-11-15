import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { isSentence as shownAsSentence, markedBy as shownAsMarkedBy, usesKeyWords as shownAsUsingKeyWords } from '../../../frontend/src/lib/quizMarking.js';
import { isSentence } from '../../src/lib/answerMatch.js';
import { docxToText, extractImportText, parseQuestions } from '../../src/lib/questionImport.js';
import {
  attemptTotals, buildSnapshot, correctAnswer, keyWordsOf, markedBy, normalizeAnswer, normalizeQuestion, pieceResults, publicQuestion, sanitizeResponse, scoreAnswer, shortAnswerCheck, toEditorShape, usesKeyWords,
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

  it('identification matches any accepted answer, however it is typed', () => {
    const id = snap({ type: 'IDENTIFICATION', text: 'Capital?', accepted: ['Manila', 'City of Manila'] });
    expect(score(id, { text: 'manila' }).autoScore).toBe(10);
    expect(score(id, { text: ' CITY OF  MANILA ' }).autoScore).toBe(10);
    expect(score(id, { text: 'the City of Manila.' }).autoScore).toBe(10);
    expect(score(id, { text: 'Cebu' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    // Asked to be exact: as written, letter for letter.
    const cs = snap({ type: 'IDENTIFICATION', text: 'Symbol?', accepted: ['Na'], settings: { caseSensitive: true } });
    expect(score(cs, { text: 'NA' }).autoScore).toBe(0);
    expect(score(cs, { text: 'Na' }).autoScore).toBe(10);
    expect(score(cs, { text: ' Na. ' }).autoScore).toBe(10);
    expect(score(cs, { text: 'the Na' }).autoScore).toBe(0);
    // Several of the accepted answers at once are right, as long as every one of them is accepted.
    const list = snap({ type: 'IDENTIFICATION', text: 'Name an input device.', accepted: ['keyboard', 'mouse', 'scanner'] });
    expect(score(list, { text: 'Keyboard, mouse and scanner' }).autoScore).toBe(10);
    expect(score(list, { text: 'keyboard, monitor' }).autoScore).toBe(0);
  });

  it('a short answer is marked by its answer key: right when it matches, wrong when it does not', () => {
    const short = snap({ type: 'SHORT_ANSWER', text: 'Why does an apple fall?', accepted: ['because of gravity', 'gravity'] });
    expect(score(short, { text: 'Because of gravity' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(short, { text: 'The gravity.' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    // Not in the key: wrong at once, and nothing waits for the teacher.
    expect(score(short, { text: 'the wind pushes it' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(score(short, null)).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
  });

  it('a short answer waits for the teacher only where the system cannot decide', () => {
    // No answer was given for it: nothing to check against.
    expect(score(snap({ type: 'SHORT_ANSWER', text: 'Why?' }), { text: 'anything' })).toEqual({ autoScore: null, isCorrect: null, needsManual: true });
    // The teacher asked to see the answers that do not match.
    const asked = snap({ type: 'SHORT_ANSWER', text: 'Why?', accepted: ['gravity'], settings: { reviewMismatch: true } });
    expect(score(asked, { text: 'Gravity' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(asked, { text: 'the wind' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: true });
    // A sentence is checked by its key words, and nothing waits.
    const sentence = snap({ type: 'SHORT_ANSWER', text: 'Why does ice float?', accepted: ['Because ice is less dense than liquid water'] });
    expect(score(sentence, { text: 'because ice is less dense than liquid water.' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(sentence, { text: 'Liquid water is denser, so the ice stays on top' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(sentence, { text: 'it is not as heavy' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    // …except an answer that has the key words and a "not" that the accepted answer does not have.
    expect(score(sentence, { text: 'ice is not dense, liquid water is' })).toEqual({ autoScore: 0, isCorrect: null, needsManual: true });
    // An answer that was left empty never waits.
    expect(score(sentence, { text: '   ' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
  });

  it('a short answer that is a sentence is checked by its key words', () => {
    const question = { type: 'SHORT_ANSWER', text: '<p>What is an algorithm?</p>', accepted: ['An algorithm is a step-by-step procedure for solving a problem'] };
    const sentence = snap(question);
    // What the system looks for: the words that carry meaning, without the one the question gives.
    expect(keyWordsOf(sentence)).toEqual([{ accepted: question.accepted[0], keyWords: ['step', 'procedure', 'solving', 'problem'], right: 3, half: 2 }]);
    // Nothing is half right where the question gives no part of the points.
    expect(keyWordsOf(snap({ ...question, settings: { partialCredit: false } }))[0]).toMatchObject({ right: 3, half: null });
    expect(keyWordsOf(question)).toEqual(keyWordsOf(sentence));
    // In the student's own words, in any order: right.
    expect(score(sentence, { text: 'It is a procedure that solves problems step by step.' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    // About half of the key words: half of the points…
    expect(score(sentence, { text: 'a procedure for a problem' })).toEqual({ autoScore: 5, isCorrect: false, needsManual: false });
    // …or none, where the question gives no part of the points.
    expect(score(snap({ ...question, settings: { partialCredit: false } }), { text: 'a procedure for a problem' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    // Repeating the question earns nothing.
    expect(score(sentence, { text: 'An algorithm is an algorithm' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    // A teacher who looks at the other answers gets every answer that is not right.
    const asked = snap({ ...question, settings: { reviewMismatch: true } });
    expect(score(asked, { text: 'a procedure that solves problems step by step' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(asked, { text: 'a procedure for a problem' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: true });
    // Exactly as written: no key words.
    const exact = snap({ ...question, settings: { caseSensitive: true } });
    expect(score(exact, { text: 'a procedure that solves problems step by step' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(keyWordsOf(exact)).toEqual([]);
    // Only a short answer: an identification is a term.
    expect(score(snap({ ...question, type: 'IDENTIFICATION' }), { text: 'a procedure that solves problems step by step' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(keyWordsOf({ ...question, type: 'IDENTIFICATION' })).toEqual([]);
    expect(keyWordsOf({ type: 'SHORT_ANSWER', text: 'Why?', accepted: ['gravity'] })).toEqual([]);
  });

  it('the teacher says whether a short answer is checked by key words', () => {
    // A phrase, with key words asked for: the words are looked for in what the student wrote.
    const phrase = { type: 'SHORT_ANSWER', text: 'Name the two parts of the CPU.', accepted: ['control unit, arithmetic logic unit'], settings: { keyWords: true } };
    expect(keyWordsOf(snap(phrase))).toEqual([{ accepted: phrase.accepted[0], keyWords: ['control', 'unit', 'arithmetic', 'logic'], right: 3, half: 2 }]);
    expect(score(snap(phrase), { text: 'It has an arithmetic and logic unit, and a unit for control' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    expect(score(snap(phrase), { text: 'the control unit and the memory' })).toEqual({ autoScore: 5, isCorrect: false, needsManual: false });
    expect(score(snap({ ...phrase, settings: {} }), { text: 'It has an arithmetic and logic unit, and a unit for control' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(shortAnswerCheck(snap(phrase), { text: 'the control unit and the memory' })).toMatchObject({ how: 'KEY_WORDS', share: 0.5, found: ['control', 'unit'], missing: ['arithmetic', 'logic'] });
    // A sentence, with key words switched off: an answer has to be the accepted answer.
    const sentence = { type: 'SHORT_ANSWER', text: 'What is an algorithm?', accepted: ['An algorithm is a step-by-step procedure for solving a problem'], settings: { keyWords: false } };
    expect(keyWordsOf(snap(sentence))).toEqual([]);
    expect(score(snap(sentence), { text: 'a procedure that solves problems step by step' })).toEqual({ autoScore: 0, isCorrect: false, needsManual: false });
    expect(score(snap(sentence), { text: 'an algorithm is a step-by-step procedure for solving a problem.' })).toEqual({ autoScore: 10, isCorrect: true, needsManual: false });
    // The choice travels with the question: stored, shown to the editor, and copied into an attempt.
    expect(toEditorShape({ ...stored(phrase), choices: [] }).settings).toEqual({ keyWords: true });
    expect(snap(phrase).settings).toEqual({ keyWords: true });
  });

  it('says how a short answer was held against its key, for the review', () => {
    const sentence = snap({ type: 'SHORT_ANSWER', text: 'What is an algorithm?', accepted: ['A step-by-step procedure for solving a problem', 'recipe'] });
    const first = 'A step-by-step procedure for solving a problem';
    expect(shortAnswerCheck(sentence, { text: 'Recipe.' })).toEqual({ how: 'SAME', share: 1, doubt: null, accepted: null, found: [], missing: [] });
    expect(shortAnswerCheck(sentence, { text: 'the step-by-step procedures for solving a problem' })).toEqual({ how: 'WORDS', share: 1, doubt: null, accepted: first, found: [], missing: [] });
    expect(shortAnswerCheck(sentence, { text: 'a procedure to solve problems' })).toEqual({ how: 'KEY_WORDS', share: 1, doubt: null, accepted: first, found: ['procedure', 'solving', 'problem'], missing: ['step'] });
    expect(shortAnswerCheck(sentence, { text: 'a procedure' })).toEqual({ how: 'KEY_WORDS', share: 0, doubt: null, accepted: first, found: ['procedure'], missing: ['step', 'solving', 'problem'] });
    expect(shortAnswerCheck(sentence, { text: 'it is not a procedure for solving problems' })).toMatchObject({ how: 'KEY_WORDS', share: 1, doubt: { why: 'NOT', words: ['procedure'], side: 'ANSWER' } });
    // What is shown is what was counted.
    const strict = snap({ type: 'SHORT_ANSWER', text: 'What is an algorithm?', accepted: [first], settings: { partialCredit: false } });
    expect(shortAnswerCheck(strict, { text: 'a procedure for a problem' })).toMatchObject({ how: 'KEY_WORDS', share: 0, found: ['procedure', 'problem'] });
    expect(shortAnswerCheck(sentence, { text: 'a procedure for a problem' })).toMatchObject({ how: 'KEY_WORDS', share: 0.5 });
    // Nothing to say about an answer that was not given, a question without a key, or another type.
    expect(shortAnswerCheck(sentence, null)).toBeNull();
    expect(shortAnswerCheck(snap({ type: 'SHORT_ANSWER', text: 'Why?' }), { text: 'x' })).toBeNull();
    expect(shortAnswerCheck(snap({ type: 'IDENTIFICATION', text: 'x', accepted: ['a'] }), { text: 'a' })).toBeNull();
  });

  it('says who marks the answers to a question', () => {
    const by = (input) => markedBy(input);
    expect(by({ type: 'MULTIPLE_CHOICE' })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'IDENTIFICATION', accepted: ['A whole sentence of more than six words here'] })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'PROGRAMMING' })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'ESSAY' })).toEqual({ by: 'TEACHER', why: 'ESSAY' });
    expect(by({ type: 'FILE_UPLOAD' })).toEqual({ by: 'TEACHER', why: 'FILE' });
    expect(by({ type: 'SHORT_ANSWER', accepted: [] })).toEqual({ by: 'TEACHER', why: 'NO_KEY' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['gravity'] })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['gravity'], settings: { reviewMismatch: true } })).toEqual({ by: 'BOTH', why: 'CHOSEN' });
    // A sentence among the accepted answers is checked by its key words.
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water'] })).toEqual({ by: 'SYSTEM', why: 'KEY_WORDS' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water', 'less dense'] })).toEqual({ by: 'SYSTEM', why: 'KEY_WORDS' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water'], settings: { reviewMismatch: false } })).toEqual({ by: 'SYSTEM', why: 'KEY_WORDS' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water'], settings: { reviewMismatch: true } })).toEqual({ by: 'BOTH', why: 'CHOSEN' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water'], settings: { caseSensitive: true } })).toEqual({ by: 'SYSTEM', why: null });
    // The teacher says: key words for a phrase, or none for a sentence.
    expect(by({ type: 'SHORT_ANSWER', accepted: ['gravity'], settings: { keyWords: true } })).toEqual({ by: 'SYSTEM', why: 'KEY_WORDS' });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['Because ice is less dense than liquid water'], settings: { keyWords: false } })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'SHORT_ANSWER', accepted: ['gravity'], settings: { keyWords: true, caseSensitive: true } })).toEqual({ by: 'SYSTEM', why: null });
    expect(by({ type: 'SHORT_ANSWER', accepted: [], settings: { keyWords: true } })).toEqual({ by: 'TEACHER', why: 'NO_KEY' });
    expect(usesKeyWords({ type: 'SHORT_ANSWER', accepted: ['gravity'], settings: { keyWords: true, reviewMismatch: true } })).toBe(true);
    expect(usesKeyWords({ type: 'IDENTIFICATION', accepted: ['A whole sentence of more than six words here'], settings: { keyWords: true } })).toBe(false);
    // The same answer for a stored question and for the copy an attempt holds.
    const question = stored({ type: 'SHORT_ANSWER', text: 'Why?', accepted: ['gravity'], settings: { reviewMismatch: true } });
    expect(markedBy(question)).toEqual({ by: 'BOTH', why: 'CHOSEN' });
    expect(markedBy(buildSnapshot(question))).toEqual({ by: 'BOTH', why: 'CHOSEN' });
    // The choice is kept only where it means something.
    expect(stored({ type: 'IDENTIFICATION', text: 'x', accepted: ['a'], settings: { reviewMismatch: true } }).settings).toEqual({});
    expect(stored({ type: 'SHORT_ANSWER', text: 'x', accepted: ['a'], settings: { reviewMismatch: false } }).settings).toEqual({ reviewMismatch: false });
    expect(stored({ type: 'SHORT_ANSWER', text: 'x', accepted: ['a'], settings: { keyWords: true } }).settings).toEqual({ keyWords: true });
    expect(stored({ type: 'SHORT_ANSWER', text: 'x', accepted: ['a'], settings: { keyWords: 'yes' } }).settings).toEqual({});
    expect(stored({ type: 'IDENTIFICATION', text: 'x', accepted: ['a'], settings: { keyWords: true } }).settings).toEqual({});
  });

  it('is said the same way by the web app, before a question is saved', () => {
    // The builder and the import show who marks a question from their own copy of the rule.
    const sentence = 'Because ice is less dense than liquid water';
    const types = ['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'MODIFIED_TRUE_FALSE', 'IDENTIFICATION', 'SHORT_ANSWER', 'ESSAY', 'MATCHING', 'FILL_BLANKS', 'ORDERING', 'PROGRAMMING', 'FILE_UPLOAD'];
    const keys = [undefined, [], ['gravity'], [sentence], [sentence, 'less dense'], [sentence, `${sentence} and so it floats`], ['one two three four five six'], ['one two three four five six seven'],
      // Four words and more that state something are a sentence; the name of a thing is not.
      ['It stores data permanently'], ['It stores data'], ['RAM is volatile memory'], ['IT support staff members'], ['Basic Input Output System'], ['do while loop statement'], ['AND gate and OR gate'], ['Ito ay bahagi ng computer'], ["They can't be changed"], ['IT IS A PROCEDURE']];
    const choices = [undefined, {}, { reviewMismatch: true }, { reviewMismatch: false }, { caseSensitive: true }, { keyWords: true }, { keyWords: false }, { keyWords: true, caseSensitive: true }, { keyWords: true, reviewMismatch: true }];
    for (const type of types) for (const accepted of keys) for (const settings of choices) {
      const question = { type, ...(accepted ? { accepted } : {}), ...(settings ? { settings } : {}) };
      expect(shownAsMarkedBy(question), JSON.stringify(question)).toEqual(markedBy(question));
      expect(shownAsUsingKeyWords(question), JSON.stringify(question)).toBe(usesKeyWords(question));
    }
    for (const accepted of keys.flat().filter(Boolean)) expect(shownAsSentence(accepted), accepted).toBe(isSentence(accepted));
    // A list that is still being typed: empty lines are not answers.
    expect(shownAsMarkedBy({ type: 'SHORT_ANSWER', accepted: ['', '  '] })).toEqual({ by: 'TEACHER', why: 'NO_KEY' });
    expect(shownAsMarkedBy({ type: 'SHORT_ANSWER', accepted: ['gravity', ''] })).toEqual({ by: 'SYSTEM', why: null });
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

  it('tells which blanks and which pairs were counted as right', () => {
    // A review shows this, so it never disagrees with the score.
    const fill = snap({ type: 'FILL_BLANKS', text: 'The ___ runs programs kept on the ___ ; a byte has ___ bits.', blanks: [['CPU'], ['hard disk'], ['8']] });
    const given = { blanks: ['the cpu', 'harddisk', 'seven'] };
    expect(pieceResults(fill, given)).toEqual([true, true, false]);
    expect(score(fill, given, 9).autoScore).toBe(6);
    expect(pieceResults(fill, null)).toEqual([false, false, false]);
    const exact = snap({ type: 'FILL_BLANKS', text: 'The symbol of sodium is ___.', blanks: [['Na']], settings: { caseSensitive: true } });
    expect(pieceResults(exact, { blanks: ['NA'] })).toEqual([false]);
    expect(pieceResults(exact, { blanks: ['Na'] })).toEqual([true]);

    const match = snap({ type: 'MATCHING', text: 'Match', pairs: [{ left: 'a', right: '1' }, { left: 'b', right: '2' }, { left: 'c', right: '1' }] });
    const [a, b, c] = match.choices.map((x) => x.id);
    expect(pieceResults(match, { pairs: { [a]: c, [b]: a } })).toEqual([true, false, false]);
    expect(pieceResults(match, null)).toEqual([false, false, false]);
    // The other types are right or wrong as a whole.
    expect(pieceResults(snap({ type: 'IDENTIFICATION', text: 'x', accepted: ['a'] }), { text: 'a' })).toBeNull();
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
