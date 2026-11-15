// What a teacher is shown about the JSON format, and the request for a chat assistant. That the
// server reads these examples as they are written is checked in backend/tests/unit/question-json.test.js.
import { describe, expect, it } from 'vitest';
import { ALL_TYPES, DEFAULT_TYPES, FORMAT_TYPES, buildPrompt, exampleJson, isOwnRequest, questionCount } from './questionFormat.js';

describe('the example of the format', () => {
  it('is JSON, with one question of each kind asked for, each on a line of its own', () => {
    const all = exampleJson();
    expect(JSON.parse(all).questions.map((q) => q.type)).toEqual(ALL_TYPES);
    expect(all.split('\n')).toHaveLength(FORMAT_TYPES.length + 4);
    const two = exampleJson(['true_false', 'multiple_choice']);
    // In the order of the list, not of the request.
    expect(JSON.parse(two).questions.map((q) => q.type)).toEqual(['multiple_choice', 'true_false']);
    expect(two).toContain('    { "type": "true_false", "question": "One byte is made of 8 bits.", "answer": true, "points": 1, "difficulty": "easy", "explanation": "A byte is a group of eight bits." }');
    expect(two).toContain('"choices": ["RAM", "CPU", "Hard disk", "Monitor"], "answer": "CPU"');
    expect(JSON.parse(exampleJson([])).questions).toEqual([]);
  });

  it('gives every kind an answer that is in its own example', () => {
    const byType = Object.fromEntries(FORMAT_TYPES.map((t) => [t.value, t.example]));
    expect(byType.multiple_choice.choices).toContain(byType.multiple_choice.answer);
    for (const answer of byType.multiple_response.answer) expect(byType.multiple_response.choices).toContain(answer);
    expect(byType.fill_blanks.question.match(/_{3,}/g)).toHaveLength(byType.fill_blanks.answer.length);
    expect(byType.essay).not.toHaveProperty('answer');
    for (const t of FORMAT_TYPES) expect([t.value, t.example.type, t.rule.startsWith(`${t.value}:`)]).toEqual([t.value, t.value, true]);
  });
});

describe('the request for a chat assistant', () => {
  it('asks for the number and the kinds chosen, and shows the form for those kinds only', () => {
    const request = buildPrompt({ count: 15, types: ['true_false', 'essay'], topic: '  Number systems,\n for first-year students ', difficulty: 'hard' });
    expect(request).toMatch(/^Write 15 quiz questions for my students\.\nTopic and instructions: Number systems, for first-year students\n/);
    expect(request).toContain('Kinds of question to use, each about equally often: true_false, essay.');
    expect(request).toContain('Make every question hard.');
    expect(request).toContain('Answer with JSON only: no sentence before it and none after it.');
    expect(request).toContain(exampleJson(['true_false', 'essay']));
    expect(request).toContain('- true_false: "question" is a statement');
    expect(request).toContain('- essay: no "answer".');
    expect(request).not.toContain('multiple_choice');
    expect(request).not.toContain('- matching:');
    expect(request).toMatch(/\nMaterial:\n\[paste your lesson, notes or reading here\]$/);
  });

  it('has sensible defaults, and leaves the material out when there is none', () => {
    const request = buildPrompt();
    expect(request).toMatch(/^Write 10 quiz questions for my students\.\nUse only the material at the end of this message\./);
    expect(request).toContain(`each about equally often: ${DEFAULT_TYPES.join(', ')}.`);
    expect(request).toContain('Mix easy, medium and hard questions.');
    expect(request).not.toContain('Topic and instructions');
    const alone = buildPrompt({ count: 1, types: ['identification'], material: false });
    expect(alone).toMatch(/^Write 1 quiz question for my students\.\nEvery question is of the kind identification\./);
    expect(alone).not.toMatch(/Material|material/);
    // Nothing chosen, or a kind that does not exist: the usual three.
    expect(buildPrompt({ types: [] })).toContain(`each about equally often: ${DEFAULT_TYPES.join(', ')}.`);
    expect(buildPrompt({ types: ['riddle'], difficulty: 'impossible' })).toContain('Mix easy, medium and hard questions.');
  });

  it('is told from the answer to it', () => {
    // As it was copied, and with the lesson pasted after it.
    expect(isOwnRequest(buildPrompt())).toBe(true);
    expect(isOwnRequest(`\n${buildPrompt({ count: 1, types: ['essay'], material: false })}`)).toBe(true);
    expect(isOwnRequest(buildPrompt({ topic: 'Number systems' }).replace('[paste your lesson, notes or reading here]', 'A bit is 0 or 1.'))).toBe(true);
    // What an assistant answers, with or without a sentence around the JSON.
    expect(isOwnRequest(exampleJson())).toBe(false);
    expect(isOwnRequest(`Sure! Here are your questions:\n${exampleJson(DEFAULT_TYPES)}\nLet me know if you want more.`)).toBe(false);
    expect(isOwnRequest('Write 10 quiz questions for my students.')).toBe(false);
    expect(isOwnRequest('1. Write 10 as a binary number.\nAnswer: 1010')).toBe(false);
    expect([undefined, null, ''].map(isOwnRequest)).toEqual([false, false, false]);
  });

  it('keeps the number of questions between 1 and 100', () => {
    expect([0, -3, '', 'abc', 2.6, '7', 100, 5000].map(questionCount)).toEqual([10, 1, 10, 10, 3, 7, 100, 100]);
    expect(buildPrompt({ count: 5000 })).toMatch(/^Write 100 quiz questions/);
  });
});
