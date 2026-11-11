// A student takes a quiz; objective questions are scored by the server.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique } from '../helpers.js';

const title = unique('Practice check');
let teacher;
let cls;
let quiz;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
  quiz = await teacher.post(`/classes/${cls.id}/quizzes`, { title, kind: 'PRACTICE', resultVisibility: 'IMMEDIATE', answerVisibility: 'CORRECT_ANSWERS', maxAttempts: 1 });
  await teacher.post(`/quizzes/${quiz.id}/questions`, { question: { type: 'MULTIPLE_CHOICE', points: 2, text: '<p>How many bits are in one byte?</p>', choices: [{ text: 'Four' }, { text: 'Eight', isCorrect: true }, { text: 'Sixteen' }, { text: 'Two' }] } });
  await teacher.post(`/quizzes/${quiz.id}/questions`, { question: { type: 'TRUE_FALSE', points: 1, text: '<p>RAM keeps its contents when the computer is switched off.</p>', answer: false } });
  await teacher.patch(`/quizzes/${quiz.id}`, { status: 'PUBLISHED' });
});
test.afterAll(async () => {
  if (quiz) await teacher.delete(`/quizzes/${quiz.id}`).catch(() => {});
  await teacher?.dispose();
});

test('a student answers, submits and sees the score', async ({ page }) => {
  await signIn(page, 'student');
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /^Start/ }).click();
  await expect(page).toHaveURL(/\/attempt\//);

  // The answer key is never sent to the browser while the attempt is open.
  const attemptId = page.url().split('/attempt/')[1].split(/[?#]/)[0];
  const open = await (await page.request.get(`/api/attempts/${attemptId}`)).text();
  expect(open).not.toContain('isCorrect');

  // Questions may be shuffled, so answer by what is on the screen.
  for (let i = 0; i < 2; i += 1) {
    await expect(page.getByText(`Question ${i + 1}`)).toBeVisible();
    if (await page.getByText('How many bits are in one byte?').isVisible()) await page.getByLabel('Eight').check();
    else await page.getByLabel('False', { exact: true }).check();
    if (i === 0) await page.getByRole('button', { name: /^Next/ }).first().click();
  }
  await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /Finish and submit|^Submit$/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Your answers were submitted' })).toBeVisible();
  await expect(page.getByText(/^3\s*\/\s*3$/).first()).toBeVisible();
});

test('the teacher sees the result', async () => {
  const results = await teacher.get(`/quizzes/${quiz.id}/results`);
  const juan = results.students.find((row) => row.student.name === 'Juan Dela Cruz');
  expect(juan).toMatchObject({ score: 3, percent: 100 });
  expect(results.stats.submitted).toBe(1);
});
