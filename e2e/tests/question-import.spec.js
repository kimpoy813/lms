// A teacher pastes questions as JSON while building a quiz, checks what was read, and adds them
// with their answer keys. See docs/QUESTION-IMPORT.md.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique, watchForProblems } from '../helpers.js';

// What a chat assistant answers: a sentence, the JSON in a block, a sentence. Question 4 gives
// its answer as a number, and the answer of question 5 fits none of its choices.
const REPLY = `Sure! Here are your questions:

\`\`\`json
{
  "questions": [
    { "type": "multiple_choice", "question": "Which part of a computer carries out the instructions of a program?", "choices": ["RAM", "CPU", "Hard disk", "Monitor"], "answer": "CPU", "points": 2, "explanation": "The CPU executes instructions." },
    { "type": "true_false", "question": "One byte is made of 8 bits.", "answer": true },
    { "type": "identification", "question": "What do the letters CPU stand for?", "answer": ["Central Processing Unit", "central processor"] },
    { "question": "Which keyword starts a loop in Python?", "options": ["if", "for", "def"], "answer": 1 },
    { "question": "Which device is used for output?", "options": ["Keyboard", "Monitor", "Mouse"], "correctAnswer": "The monitor" },
    { "type": "fill_blanks", "question": "A byte has ___ bits, and half a byte is called a ___.", "answer": [["8", "eight"], ["nibble"]], "points": 2 },
    { "type": "matching", "question": "Match each device with what it is used for.", "pairs": [{ "left": "Keyboard", "right": "Input" }, { "left": "Monitor", "right": "Output" }], "points": 2 },
    { "type": "essay", "question": "Explain the difference between memory (RAM) and storage.", "points": 10 }
  ]
}
\`\`\`

Let me know if you would like more!`;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

let teacher;
let cls;
let quiz;
let bank;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
  quiz = await teacher.post(`/classes/${cls.id}/quizzes`, { title: unique('Imported quiz'), kind: 'QUIZ' });
  bank = await teacher.post('/question-banks', { title: unique('Imported bank') });
});
test.afterAll(async () => {
  if (quiz) await teacher.delete(`/quizzes/${quiz.id}`).catch(() => {});
  if (bank) await teacher.delete(`/question-banks/${bank.id}`).catch(() => {});
  await teacher?.dispose();
});

/** The file a download button saves, as text. */
async function saved(page, button) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') };
}

test('pasted JSON becomes the questions of a quiz, with their answers', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await page.getByRole('button', { name: 'Import questions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import questions' });
  const box = dialog.getByLabel('…or paste the questions');
  await expect(box).toBeFocused();

  // A mistake in the JSON is named, with its line.
  await box.fill('[\n  {"question": "What is RAM?" "answer": "memory"}\n]');
  await dialog.getByRole('button', { name: 'Read the questions' }).click();
  await expect(dialog.getByRole('alert')).toContainText('These could not be read');
  await expect(dialog.getByRole('alert')).toContainText('Line 2: a comma is missing before this');

  // The whole reply of a chat assistant.
  await box.fill(REPLY);
  await dialog.getByRole('button', { name: 'Read the questions' }).click();
  await expect(dialog.getByText('8 questions found')).toBeVisible();
  await expect(dialog.getByText('6 ready')).toBeVisible();
  await expect(dialog.getByText('1 to double-check')).toBeVisible();
  await expect(dialog.getByText('1 needs fixing')).toBeVisible();
  const rows = dialog.getByRole('list', { name: 'Questions that were read' }).locator(':scope > li');
  await expect(rows).toHaveCount(8);

  // Each question shows the answer that was read.
  await expect(rows.nth(0).locator('li', { has: page.getByLabel('Correct') })).toHaveText('CPU');
  await expect(rows.nth(1)).toContainText('Answer: True');
  await expect(rows.nth(2)).toContainText('Accepted: Central Processing Unit, central processor');
  // An answer given as a number: read, and marked to be checked.
  await expect(rows.nth(3).locator('li', { has: page.getByLabel('Correct') })).toHaveText('for');
  await expect(rows.nth(3)).toContainText('The answer was given as the number 1. It was read as the second choice, “for”, counting from 0.');
  // An answer that fits no choice is not guessed: the question waits, unticked.
  await expect(rows.nth(4).getByLabel('Correct')).toHaveCount(0);
  await expect(rows.nth(4)).toContainText('Mark the correct choice.');
  await expect(rows.nth(4).getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Add 7 questions to the quiz' })).toBeEnabled();

  // Fix it in the editor: it joins the others.
  await rows.nth(4).getByRole('button', { name: 'Fix' }).click();
  const editor = page.getByRole('dialog', { name: 'Question 5' });
  await editor.getByLabel('Choice 2 is correct').check();
  await editor.getByRole('button', { name: 'Save question' }).click();
  await expect(editor).toBeHidden();
  await expect(rows.nth(4).locator('li', { has: page.getByLabel('Correct') })).toHaveText('Monitor');
  await expect(rows.nth(4).getByRole('checkbox')).toBeChecked();
  await expect(dialog.getByText('7 ready')).toBeVisible();
  // Leave the essay out.
  await rows.nth(7).getByRole('checkbox').uncheck();

  await dialog.getByRole('button', { name: 'Add 7 questions to the quiz' }).click();
  await expect(page.getByText('7 questions added to the quiz.')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('7 questions · 10 points')).toBeVisible();
  await expect(page.getByText('Which device is used for output?')).toBeVisible();

  // Pasted once more: what the quiz has is recognised, and only the essay is offered.
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await box.fill(REPLY);
  await dialog.getByRole('button', { name: 'Read the questions' }).click();
  await expect(dialog.getByText('7 already in the quiz')).toBeVisible();
  await expect(dialog.getByText('1 ready')).toBeVisible();
  await expect(rows.nth(0)).toContainText('The quiz already has a question with this text.');
  await expect(rows.nth(0).getByRole('checkbox')).not.toBeChecked();
  await expect(rows.nth(7).getByRole('checkbox')).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Add 1 question to the quiz' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The download is the same questions, in the format that is imported.
  const file = await saved(page, page.getByRole('button', { name: 'Download the questions as a JSON file' }));
  expect(file.name).toMatch(/^Imported-quiz-.*-questions\.json$/);
  const written = JSON.parse(file.text);
  expect(written).toMatchObject({ format: 'edusphere.questions', version: 1, title: quiz.title });
  expect(written.questions.map((q) => [q.type, q.answer ?? null])).toEqual([
    ['multiple_choice', 'CPU'], ['true_false', true], ['identification', ['Central Processing Unit', 'central processor']],
    ['multiple_choice', 'for'], ['multiple_choice', 'Monitor'], ['fill_blanks', [['8', 'eight'], ['nibble']]], ['matching', null],
  ]);
  expect(written.questions[6].pairs).toEqual([{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }]);
  expect(written.questions[0]).toMatchObject({ points: 2, explanation: 'The CPU executes instructions.' });

  // The one request that was refused is the JSON with the mistake.
  expect(problems.filter((p) => !/status of 422/.test(p))).toEqual([]);
  expect(problems.length).toBe(1);
});

test('an examination takes its questions the same way', async ({ page }) => {
  const exam = await teacher.post(`/classes/${cls.id}/quizzes`, { title: unique('Imported examination'), kind: 'EXAM' });
  try {
    await signIn(page, 'teacher');
    await page.goto(`/classes/${cls.id}/quizzes/${exam.id}`);
    await page.getByRole('button', { name: 'Import questions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import questions' });
    await expect(dialog).toContainText('Nothing is added to the examination until you have looked at them.');
    // The form of many question sets found online: the wrong answers apart from the correct one.
    await dialog.getByLabel('…or paste the questions').fill(JSON.stringify({ results: [
      { type: 'multiple', question: 'Which planet is the largest?', correct_answer: 'Jupiter', incorrect_answers: ['Mars', 'Earth', 'Venus'] },
      { type: 'boolean', question: 'The sun is a star.', correct_answer: 'True', incorrect_answers: ['False'], points: 2 },
    ] }));
    await dialog.getByRole('button', { name: 'Read the questions' }).click();
    const rows = dialog.getByRole('list', { name: 'Questions that were read' }).locator(':scope > li');
    // The choices are put in an order that does not give the answer away, and the dialog says so.
    await expect(rows.nth(0).locator('ul > li')).toHaveText(['Earth', 'Jupiter', 'Mars', 'Venus']);
    await expect(rows.nth(0).locator('li', { has: page.getByLabel('Correct') })).toHaveText('Jupiter');
    await expect(dialog.getByText('Its choices were put in alphabetical order')).toBeVisible();
    await expect(rows.nth(1)).toContainText('Answer: True');
    await dialog.getByRole('button', { name: 'Add 2 questions to the examination' }).click();
    await expect(page.getByText('2 questions added to the examination.')).toBeVisible();
    await expect(page.getByText('2 questions · 3 points')).toBeVisible();
  } finally {
    await teacher.delete(`/quizzes/${exam.id}`).catch(() => {});
  }
});

test('the request for a chat assistant is copied, and is not taken for its answer', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import questions' });
  await dialog.getByText('Let an AI chat write the questions').click();
  await dialog.getByLabel('How many').fill('5');
  await dialog.getByLabel('Topic, and anything else to tell it').fill('Number systems, for first-year students');
  await dialog.getByLabel('Matching type').check();
  await dialog.getByRole('button', { name: 'Copy the request' }).click();
  await expect(page.getByText('Request copied. Paste it into your chat assistant.')).toBeVisible();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  expect(request).toMatch(/^Write 5 quiz questions for my students\.\nTopic and instructions: Number systems, for first-year students\n/);
  expect(request).toContain('multiple_choice, true_false, identification, matching');
  expect(request).toMatch(/Material:\n\[paste your lesson, notes or reading here\]$/);

  // Pasted back in place of the answer, the request is not read as the example questions in it.
  const box = dialog.getByLabel('…or paste the questions');
  await box.fill(request);
  await dialog.getByRole('button', { name: 'Read the questions' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This is the request for the chat assistant, not its answer.');

  // The answer is. "Start over" comes back to it.
  await box.fill('Here you go:\n[{"question": "Which number system has only the digits 0 and 1?", "answer": "binary"}]');
  await dialog.getByRole('button', { name: 'Read the questions' }).click();
  await expect(dialog.getByText('1 question found')).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Questions that were read' })).toContainText('Accepted: binary');
  await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(box).toHaveValue(/^Here you go:/);
});

test('a question bank takes a JSON file', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/question-banks/${bank.id}`);
  await page.getByRole('button', { name: 'Import questions' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import questions' });
  const chapter = { questions: [
    { type: 'true_false', question: 'A bit is either 0 or 1.', answer: true },
    { type: 'ordering', question: 'Arrange from the smallest to the largest.', items: ['bit', 'byte', 'kilobyte'] },
    { type: 'multiple_response', question: 'Which of these are input devices?', choices: ['Keyboard', 'Monitor', 'Mouse'], answer: ['Keyboard', 'Mouse'] },
  ] };
  await dialog.locator('input[type=file]').setInputFiles({ name: 'chapter-2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(chapter)) });
  await expect(dialog.getByText('chapter-2.json — look at what was read before anything is added.')).toBeVisible();
  await expect(dialog.getByText('3 questions found')).toBeVisible();
  await expect(dialog.getByText('3 ready')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add 3 questions to the bank' }).click();
  await expect(page.getByText('3 questions added to the bank.')).toBeVisible();
  await expect(page.getByText('A bit is either 0 or 1.')).toBeVisible();

  const file = await saved(page, page.getByRole('button', { name: 'Download the questions as a JSON file' }));
  expect(file.name).toMatch(/^Imported-bank-.*-questions\.json$/);
  expect(JSON.parse(file.text).questions.map((q) => q.answer ?? q.items)).toEqual([true, ['bit', 'byte', 'kilobyte'], ['Keyboard', 'Mouse']]);
  expect(problems).toEqual([]);
});
