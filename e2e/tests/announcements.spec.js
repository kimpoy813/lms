// A teacher posts to a class; its students see it.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique } from '../helpers.js';

const title = unique('Room change for Friday');
let teacher;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
});
test.afterAll(async () => {
  const cls = await demoClass(teacher, 'IT 101');
  const posts = await teacher.get(`/announcements?classId=${cls.id}`).catch(() => []);
  for (const post of (posts ?? []).filter((p) => p.title === title)) await teacher.delete(`/announcements/${post.id}`).catch(() => {});
  await teacher.dispose();
});

test('a teacher posts an announcement and a student of the class reads it', async ({ page, browser }) => {
  const cls = await demoClass(teacher, 'IT 101');
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/announcements`);
  await page.getByRole('button', { name: 'New announcement' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.locator('.ProseMirror').click();
  await page.keyboard.type('We meet in Computer Lab 2 this Friday. Bring your activity sheets.');
  await dialog.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(title)).toBeVisible();

  const context = await browser.newContext();
  const studentPage = await context.newPage();
  await signIn(studentPage, 'student');
  await studentPage.goto('/announcements');
  await expect(studentPage.getByText(title)).toBeVisible();
  await expect(studentPage.getByText('We meet in Computer Lab 2 this Friday.')).toBeVisible();
  await context.close();
});

test('a student who is not in the class does not get it', async ({ browser, baseURL }) => {
  // student9 is enrolled in CS 201 only.
  const outsider = await apiAs('student9@edusphere.demo', baseURL);
  const feed = await outsider.get('/announcements');
  expect((feed ?? []).some((p) => p.title === title)).toBe(false);
  await outsider.dispose();
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, 'student9@edusphere.demo');
  await page.goto('/announcements');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(title)).toHaveCount(0);
  await context.close();
});
