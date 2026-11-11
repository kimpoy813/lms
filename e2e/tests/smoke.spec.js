// Every main screen of every role opens without a crash, a server error or sideways scrolling.
import { expect, test } from '@playwright/test';
import { signIn, watchForProblems } from '../helpers.js';

const PAGES = {
  student: ['/', '/classes', '/attendance/scan', '/grades', '/programming', '/announcements', '/messages', '/calendar', '/consultations', '/notifications', '/profile'],
  teacher: ['/', '/classes', '/question-banks', '/rubrics', '/programming', '/ai', '/announcements', '/messages', '/calendar', '/consultations', '/profile'],
  admin: ['/', '/admin/users', '/classes', '/admin/enrollments', '/admin/catalog', '/admin/permissions', '/admin/settings', '/admin/audit', '/announcements'],
};
const CLASS_PAGES = {
  student: ['', '/modules', '/assignments', '/quizzes', '/attendance', '/grades', '/discussions', '/resources', '/announcements', '/people'],
  teacher: ['', '/modules', '/assignments', '/quizzes', '/attendance', '/gradebook', '/discussions', '/resources', '/announcements', '/people', '/analytics', '/settings'],
};

async function visit(page, path, problems) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first(), `${path} shows a page title`).toBeVisible();
  await expect(page.getByText(/This page could not be displayed|This page needs to be reloaded/), `${path} did not crash`).toHaveCount(0);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${path} does not scroll sideways`).toBeLessThanOrEqual(0);
  expect(problems, `${path} raised no errors`).toEqual([]);
}

for (const role of Object.keys(PAGES)) {
  test(`${role}: every main page opens`, async ({ page }) => {
    test.setTimeout(180_000);
    const problems = watchForProblems(page);
    await signIn(page, role);
    for (const path of PAGES[role]) await visit(page, path, problems);
  });
}

for (const role of Object.keys(CLASS_PAGES)) {
  test(`${role}: every tab of a class opens`, async ({ page }) => {
    test.setTimeout(180_000);
    const problems = watchForProblems(page);
    await signIn(page, role);
    const classes = (await (await page.request.get('/api/classes?status=ACTIVE')).json()).data;
    const cls = classes.find((c) => c.course?.code === 'IT 101') ?? classes[0];
    for (const tab of CLASS_PAGES[role]) await visit(page, `/classes/${cls.id}${tab}`, problems);
  });
}

test('the sign-in page works on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watchForProblems(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await signIn(page, 'student');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Check in' })).toBeVisible();
  expect(problems).toEqual([]);
});
