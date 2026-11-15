// A short answer that is checked by its key words: the student answers in their own words and
// has the score on handing in, the teacher sees what the system found, and says for a word or a
// phrase whether its key words are looked for. See docs/QUIZZES.md.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique, watchForProblems } from '../helpers.js';

const title = unique('Sentences');
const ALGORITHM = 'An algorithm is a step-by-step procedure for solving a problem';
const LOST = 'The contents of RAM are lost when the computer is turned off';

let teacher;
let cls;
let quiz;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
  quiz = await teacher.post(`/classes/${cls.id}/quizzes`, { title, resultVisibility: 'IMMEDIATE', answerVisibility: 'CORRECT_ANSWERS', strictMode: false });
  const questions = [
    { type: 'SHORT_ANSWER', points: 2, text: '<p>What is an algorithm?</p>', accepted: [ALGORITHM] },
    { type: 'SHORT_ANSWER', points: 2, text: '<p>What is a byte?</p>', accepted: ['A byte is a unit of data that is made of eight bits'] },
    { type: 'SHORT_ANSWER', points: 2, text: '<p>What happens to the contents of RAM when the computer is turned off?</p>', accepted: [LOST] },
  ];
  for (const question of questions) await teacher.post(`/quizzes/${quiz.id}/questions`, { question });
  await teacher.patch(`/quizzes/${quiz.id}`, { status: 'PUBLISHED' });
});
test.afterAll(async () => {
  if (quiz) await teacher.delete(`/quizzes/${quiz.id}`).catch(() => {});
  await teacher?.dispose();
});

const answers = async (page, texts) => {
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await page.getByRole('button', { name: /^Start/ }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /^Start/ }).click();
  await expect(page).toHaveURL(/\/attempt\//);
  const question = page.getByRole('main');
  for (let i = 0; i < 3; i += 1) {
    await expect(question.getByText(`Question ${i + 1} of 3`)).toBeVisible();
    await question.getByRole('textbox').fill(texts[i]);
    if (i < 2) await page.getByRole('button', { name: /^Next/ }).first().click();
  }
  await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /Finish and submit|^Submit$/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your answers were submitted' })).toBeVisible();
};

test('the builder says which questions are checked by key words, and what it looks for', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await expect(page.getByText('Checked by key words', { exact: true })).toHaveCount(3);
  await expect(page.getByTestId('key-words')).toHaveText([/key words: step · procedure · solving · problem$/, /key words: unit · data · made · eight · bits$/, /key words: lost$/]);
  await expect(page.getByTestId('marking-note')).toHaveText('The system checks every question the moment a student hands in. 3 short answers are checked by key words: there, an answer that has your words but may say the opposite is left to you.');
  expect(problems).toEqual([]);
});

test('a student answers in their own words and has the score on handing in', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'student');
  // Right in other words; half right (the number is missing); right, with the word in another form.
  await answers(page, ['It is a procedure that solves problems.', 'a unit of data', 'RAM loses everything']);

  await expect(page.getByText(/^5\s*\/\s*6$/).first()).toBeVisible();
  await expect(page.getByText(/graded by your teacher|Waiting for your teacher/)).toHaveCount(0);
  // The quiz shows its answers, so the student reads what was found.
  const checks = page.getByTestId('answer-check');
  await expect(checks).toHaveText(['Key words found: 3 of 4 — procedure, solving, problem · missing: step', 'Key words found: 2 of 5 — unit, data · missing: made, eight, bits', 'Key words found: 1 of 1 — lost']);
  await expect(page.getByRole('img', { name: 'Partly correct' })).toHaveCount(1);
  expect(problems).toEqual([]);
});

test('an answer that may say the opposite is left to the teacher, who sees why', async ({ page, browser }) => {
  // Another student: the key words are there, with a "not".
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await signIn(theirs, 'student2');
  await answers(theirs, ['a step by step procedure for solving a problem', 'a unit of data made of 8 bits', 'They are not lost']);
  await expect(theirs.getByText('Waiting for your teacher')).toHaveCount(1);
  await expect(theirs.getByText('It says “not” about “lost”, and the accepted answer does not.')).toBeVisible();
  await other.close();

  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}/results`);
  const juan = page.getByRole('row').filter({ hasText: 'Dela Cruz, Juan' });
  await expect(juan).toContainText('5 / 6');
  const waiting = page.getByRole('row').filter({ hasText: 'Needs grading' });
  await expect(waiting).toHaveCount(1);
  await waiting.getByRole('button', { name: 'Grade' }).click();
  const attempt = page.getByRole('dialog', { name: /attempt 1/ });
  await expect(attempt.getByText('Checked by the system: 4')).toBeVisible();
  const doubted = attempt.getByRole('region', { name: 'Question 3' });
  await expect(doubted).toContainText('Needs your grade');
  await expect(doubted.getByTestId('answer-check')).toContainText('Key words found: 1 of 1 — lost');
  await expect(doubted.getByTestId('answer-check')).toContainText('It says “not” about “lost”, and the accepted answer does not. Key words cannot tell whether that is right, so it is left to the teacher.');
  // The teacher decides: wrong.
  await doubted.getByLabel(/^Score/).fill('0');
  await doubted.getByRole('button', { name: 'Save' }).click();
  await expect(attempt.getByText('Needs your grade')).toHaveCount(0);
  await attempt.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ramos, Angelica' })).toContainText('4 / 6');
  expect(problems).toEqual([]);
});

test('the teacher has the key words of a phrase looked for, and tries an answer first', async ({ page }) => {
  const problems = watchForProblems(page);
  const draft = await teacher.post(`/classes/${cls.id}/quizzes`, { title: unique('Key words of a phrase') });
  try {
    await signIn(page, 'teacher');
    await page.goto(`/classes/${cls.id}/quizzes/${draft.id}`);
    await page.getByRole('button', { name: 'New question' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New question' });
    await editor.getByLabel('Question type').selectOption('SHORT_ANSWER');
    await editor.locator('[contenteditable="true"]').first().click();
    await page.keyboard.type('Name the two parts of the CPU.');
    await editor.getByLabel('Accepted answers').fill('control unit, arithmetic logic unit');

    // A phrase is taken as it stands: the same in the student's own sentence is wrong.
    const byKeyWords = editor.getByLabel('Check by key words');
    await expect(byKeyWords).not.toBeChecked();
    await editor.getByLabel('Try an answer').fill('It has a unit for control and an arithmetic and logic unit');
    await expect(editor.getByTestId('phrase-note')).toContainText('An answer has to be one of yours, as it stands.');
    await expect(editor.getByTestId('try-result')).toContainText('Wrong: no points');

    // With its key words looked for, it is right — and the teacher sees what an answer needs.
    await byKeyWords.check();
    await expect(editor.getByTestId('key-words')).toContainText('right with 3 of 4, half right with 2');
    await expect(editor.getByTestId('try-result')).toContainText('Right: all the points');
    await expect(editor.getByTestId('try-result')).toContainText('Key words found: 4 of 4 — control, unit, arithmetic, logic');
    await editor.getByLabel('Try an answer').fill('the control unit and the memory');
    await expect(editor.getByTestId('try-result')).toContainText('Half right: half the points');

    // A sentence is checked that way without being asked.
    await byKeyWords.uncheck();
    await editor.getByLabel('Accepted answers').fill('It has a control unit and an arithmetic logic unit');
    await expect(byKeyWords).toBeChecked();
    await editor.getByLabel('Accepted answers').fill('control unit, arithmetic logic unit');
    await expect(byKeyWords).not.toBeChecked();

    // The choice is saved with the question.
    await byKeyWords.check();
    await editor.getByRole('button', { name: 'Save question' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByText('Checked by key words', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('key-words')).toHaveText(/key words: control · unit · arithmetic · logic$/);
    await page.reload();
    await expect(page.getByTestId('marking-note')).toContainText('1 short answer is checked by key words');
    expect(problems).toEqual([]);
  } finally {
    await teacher.delete(`/quizzes/${draft.id}`).catch(() => {});
  }
});
