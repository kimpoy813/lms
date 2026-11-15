import { describe, expect, it } from 'vitest';
import { doubtText, isSentence, markedBy } from './quizMarking.js';

describe('a sentence, or the name of a thing', () => {
  it('takes four words and more that state something for a sentence', () => {
    for (const sentence of ['A step-by-step procedure for solving a problem', 'It stores data permanently', 'RAM is volatile memory']) expect(isSentence(sentence), sentence).toBe(true);
    for (const name of ['It stores data', 'Basic Input Output System', 'IT support staff members', 'AND gate and OR gate', '']) expect(isSentence(name), name).toBe(false);
  });
});

describe('who marks a question', () => {
  // backend/tests/unit/quiz.test.js holds this copy and the server's rule together.
  it('says a sentence is checked by its key words', () => {
    const sentence = 'An algorithm is a step-by-step procedure for solving a problem';
    expect(markedBy({ type: 'SHORT_ANSWER', accepted: [sentence] })).toEqual({ by: 'SYSTEM', why: 'KEY_WORDS' });
    expect(markedBy({ type: 'SHORT_ANSWER', accepted: ['a recipe'] })).toEqual({ by: 'SYSTEM', why: null });
    expect(markedBy({ type: 'SHORT_ANSWER', accepted: [sentence], settings: { reviewMismatch: true } })).toEqual({ by: 'BOTH', why: 'CHOSEN' });
    expect(markedBy({ type: 'SHORT_ANSWER', accepted: [] })).toEqual({ by: 'TEACHER', why: 'NO_KEY' });
    expect(markedBy({ type: 'ESSAY' })).toEqual({ by: 'TEACHER', why: 'ESSAY' });
  });
});

describe('why an answer was left to the teacher', () => {
  it('names the word that turned it round', () => {
    expect(doubtText({ why: 'NOT', words: ['lost'], side: 'ANSWER' })).toBe('It says “not” about “lost”, and the accepted answer does not.');
    expect(doubtText({ why: 'NOT', words: ['lost'], side: 'ACCEPTED' })).toBe('The accepted answer says “not” about “lost”, and this answer does not.');
    expect(doubtText({ why: 'REPLY', words: ['yes', 'no'] })).toBe('It begins with “yes” where the accepted answer begins with “no”.');
    expect(doubtText({ why: 'OPPOSITE', words: ['more', 'less'] })).toBe('It says “more” where the accepted answer says “less”.');
    expect(doubtText({ why: 'COMPARISON', words: [] })).toBe('It compares with “than”, but not with what the accepted answer compares with.');
    expect(doubtText({ why: 'PAIRING', words: ['ROM', 'volatile', 'non-volatile'] })).toBe('It puts “ROM” with “volatile”, and the accepted answer puts it with “non-volatile”.');
  });

  it('says nothing where there is no doubt, and something for a reason it does not know', () => {
    expect(doubtText(null)).toBeNull();
    expect(doubtText(undefined)).toBeNull();
    expect(doubtText({ why: 'LATER' })).toBe('It may say the opposite of the accepted answer.');
  });
});
