// An examination in parts: the teacher sees the parts while building it, a student takes the
// shuffled paper part by part, and the score is there on handing in — the system marks typed
// answers by itself. See docs/QUIZZES.md.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique, watchForProblems } from '../helpers.js';

const title = unique('Midterm in parts');
const ONE = 'Part I. Multiple Choice';
const TWO = 'Part II. True or False';
const mc = (n) => ({ type: 'MULTIPLE_CHOICE', points: 1, section: ONE, text: `<p>Which of these is an output device? (${n})</p>`, choices: [{ text: 'Monitor', isCorrect: true }, { text: 'Keyboard' }, { text: 'Mouse' }, { text: 'Scanner' }] });
const tf = (n) => ({ type: 'TRUE_FALSE', points: 1, section: TWO, text: `<p>RAM keeps its contents when the power is off. (${n})</p>`, answer: false });

let teacher;
let cls;
let quiz;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
  quiz = await teacher.post(`/classes/${cls.id}/quizzes`, { title, kind: 'EXAM', resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', strictMode: false, shuffleQuestions: true, shuffleChoices: true });
  const questions = [
    mc(1), tf(1),
    // Written without a part name: they go with the questions of their kind.
    { type: 'IDENTIFICATION', points: 2, text: '<p>What is called the brain of the computer?</p>', accepted: ['Central Processing Unit (CPU)'] },
    mc(2), tf(2), mc(3),
    { type: 'IDENTIFICATION', points: 2, text: '<p>How many bits make one byte?</p>', accepted: ['8'] },
    { type: 'SHORT_ANSWER', points: 2, text: '<p>What kind of memory loses its contents without power?</p>', accepted: ['volatile memory', 'volatile'] },
    { type: 'SHORT_ANSWER', points: 2, text: '<p>What do we call the programs of a computer, as opposed to its machinery?</p>', accepted: ['software'] },
  ];
  for (const question of questions) await teacher.post(`/quizzes/${quiz.id}/questions`, { question });
});
test.afterAll(async () => {
  if (quiz) await teacher.delete(`/quizzes/${quiz.id}`).catch(() => {});
  await teacher?.dispose();
});

const headings = (scope) => scope.getByTestId('part-heading');

test('the teacher sees the examination in its parts, and builds on them', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);

  // The questions were written in a mixed order; they are shown as they are given: part by part.
  await expect(headings(page)).toHaveText([/^Part 1 · Multiple Choice\s*Questions 1–3 · 3 points$/, /^Part 2 · True or False\s*Questions 4–5 · 2 points$/, /^Part 3 · Identification\s*Questions 6–7 · 4 points$/, /^Part 4 · Short answer\s*Questions 8–9 · 4 points$/]);
  await expect(page.getByTestId('order-note')).toHaveText('Students take the parts in this order. Inside each part, every student gets the questions in a different order.');
  // Nothing in this examination waits for the teacher.
  await expect(page.getByTestId('marking-note')).toHaveText('The system checks every question the moment a student hands in.');
  await expect(page.getByText('Graded by you')).toHaveCount(0);

  // A new question names its part and joins it.
  await page.getByRole('button', { name: 'New question' }).click();
  const editor = page.getByRole('dialog', { name: 'New question' });
  await editor.getByLabel('Question type').selectOption('TRUE_FALSE');
  await editor.locator('.ProseMirror').click();
  await page.keyboard.type('RAM keeps its contents when the power is off. (3)');
  await editor.getByRole('radio', { name: 'False' }).click();
  await editor.getByLabel(/^Part/).fill(TWO);
  await editor.getByRole('button', { name: 'Save question' }).click();
  await expect(editor).toBeHidden();
  await expect(headings(page).nth(1)).toHaveText(/Part 2 · True or False\s*Questions 4–6 · 3 points/);
  const second = page.getByRole('region', { name: 'Part 2' });
  await expect(second.getByRole('listitem')).toHaveCount(3);
  await expect(second.getByRole('listitem').last()).toContainText('RAM keeps its contents when the power is off. (3)');

  // Editing a question keeps it in its part.
  const first = page.getByRole('region', { name: 'Part 1' });
  await first.getByRole('button', { name: 'Edit question' }).first().click();
  const edit = page.getByRole('dialog', { name: 'Edit question' });
  await expect(edit.getByLabel(/^Part/)).toHaveValue(ONE);
  await edit.getByLabel('Points').fill('1');
  await edit.getByRole('button', { name: 'Save question' }).click();
  await expect(edit).toBeHidden();
  await expect(headings(page).first()).toHaveText(/Part 1 · Multiple Choice\s*Questions 1–3 · 3 points/);

  // A question moves inside its part, never out of it; a part moves as a whole.
  await expect(first.getByRole('button', { name: 'Move up', exact: true }).first()).toBeDisabled();
  await expect(first.getByRole('button', { name: 'Move down', exact: true }).last()).toBeDisabled();
  await page.getByRole('button', { name: 'Move part 2 up' }).click();
  await expect(headings(page).first()).toHaveText(/Part 1 · True or False\s*Questions 1–3/);
  await expect(headings(page).nth(1)).toHaveText(/Part 2 · Multiple Choice\s*Questions 4–6/);
  await page.getByRole('button', { name: 'Move part 1 down' }).click();
  await expect(headings(page).first()).toHaveText(/Part 1 · Multiple Choice\s*Questions 1–3/);

  // A short answer whose key is a whole sentence is the one case that can wait: said on the question.
  await page.getByRole('button', { name: 'New question' }).click();
  await editor.getByLabel('Question type').selectOption('SHORT_ANSWER');
  const review = editor.getByLabel('I look at the answers that match none of these');
  await editor.getByLabel('Accepted answers').fill('volatile');
  await expect(review).not.toBeChecked();
  await editor.getByLabel('Accepted answers').fill('Because it holds the programs that are running right now');
  await expect(review).toBeChecked();
  await expect(editor.getByText('This is on because the answer is a whole sentence')).toBeVisible();
  // The teacher decides otherwise, and the system marks every answer.
  await review.uncheck();
  await expect(editor.getByText('Off: the system checks every answer at once')).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('link', { name: /^Results/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a student takes the shuffled examination part by part, and has the score on handing in', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, 'student');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await page.getByRole('button', { name: /^Start/ }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /^Start/ }).click();
  await expect(page).toHaveURL(/\/attempt\//);

  // The list of questions is grouped by part.
  const list = page.getByRole('complementary').getByRole('navigation', { name: 'Questions' });
  await expect(list.getByRole('group')).toHaveCount(4);
  await expect(list.getByRole('group', { name: 'Part 1 · Multiple Choice' }).getByRole('button')).toHaveCount(3);
  await expect(list.getByRole('group', { name: 'Part 2 · True or False' }).getByRole('button')).toHaveCount(3);
  await expect(list.getByRole('group', { name: 'Part 3 · Identification' }).getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('group', { name: 'Part 4 · Short answer' }).getByRole('button')).toHaveCount(2);

  // Through the paper, answering by what is on the screen: the order inside a part differs per student.
  const question = page.getByRole('main');
  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    await expect(question.getByText(`Question ${i + 1} of 10`)).toBeVisible();
    const part = (await page.getByTestId('part').innerText()).replace(/\s+/g, ' ');
    const text = await question.innerText();
    seen.push(part.replace(/ Questions? .*$/, ''));
    if (text.includes('output device')) await page.getByLabel('Monitor').check();
    else if (text.includes('RAM keeps')) await page.getByLabel('False', { exact: true }).check();
    // Typed in the student's own way: the system still knows the answer.
    else if (text.includes('brain of the computer')) await question.getByRole('textbox').fill('the cpu');
    else if (text.includes('How many bits')) await question.getByRole('textbox').fill('Eight.');
    else if (text.includes('loses its contents')) await question.getByRole('textbox').fill('It is volatile memory');
    // …and a wrong answer is wrong.
    else await question.getByRole('textbox').fill('hardware');
    if (i < 9) await page.getByRole('button', { name: /^Next/ }).first().click();
  }
  // Multiple choice first, then true or false, then identification, then the short answers: never mixed.
  expect(seen).toEqual([
    'Part 1 of 4 · Multiple Choice', 'Part 1 of 4 · Multiple Choice', 'Part 1 of 4 · Multiple Choice',
    'Part 2 of 4 · True or False', 'Part 2 of 4 · True or False', 'Part 2 of 4 · True or False',
    'Part 3 of 4 · Identification', 'Part 3 of 4 · Identification',
    'Part 4 of 4 · Short answer', 'Part 4 of 4 · Short answer',
  ]);

  await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /Finish and submit|^Submit$/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();

  // Marked at once, short answers included: nothing waits for the teacher.
  await expect(page.getByRole('heading', { level: 1, name: 'Your answers were submitted' })).toBeVisible();
  await expect(page.getByText(/^12\s*\/\s*14$/).first()).toBeVisible();
  await expect(page.getByText(/graded by your teacher|Waiting for your teacher/)).toHaveCount(0);
  // The answers are shown part by part as well.
  await expect(headings(page)).toHaveText([/^Part 1 of 4 · Multiple Choice/, /^Part 2 of 4 · True or False/, /^Part 3 of 4 · Identification/, /^Part 4 of 4 · Short answer/]);
  expect(problems).toEqual([]);
});

test('the teacher finds the attempt marked, with nothing left to grade', async ({ page }) => {
  const results = await teacher.get(`/quizzes/${quiz.id}/results`);
  const juan = results.students.find((row) => row.student.name === 'Juan Dela Cruz');
  expect(juan).toMatchObject({ status: 'GRADED', score: 12, percent: 85.7 });
  expect(results.stats).toMatchObject({ submitted: 1, needsGrading: 0, canBeMarked: 0 });

  const problems = watchForProblems(page);
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}/results`);
  const row = page.getByRole('row').filter({ hasText: 'Dela Cruz, Juan' });
  await expect(row).toContainText('Done');
  await expect(row).toContainText('12 / 14');
  await row.getByRole('button', { name: 'View' }).click();
  const attempt = page.getByRole('dialog', { name: /Juan Dela Cruz/ });
  await expect(headings(attempt)).toHaveText([/^Part 1 of 4 · Multiple Choice/, /^Part 2 of 4 · True or False/, /^Part 3 of 4 · Identification/, /^Part 4 of 4 · Short answer/]);
  await expect(attempt.getByText('Checked by the system: 12')).toBeVisible();
  await expect(attempt.getByText('Needs your grade')).toHaveCount(0);
  // The wrong short answer was marked wrong; the teacher can still overrule it.
  const wrong = attempt.getByRole('region', { name: 'Question 9' }).or(attempt.getByRole('region', { name: 'Question 10' })).filter({ hasText: 'hardware' });
  await expect(wrong).toContainText('0 / 2');
  await expect(wrong.getByRole('button', { name: 'Change score' })).toBeVisible();
  expect(problems).toEqual([]);
});
