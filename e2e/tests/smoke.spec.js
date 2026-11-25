// Main and detail screens render cleanly for every role, including narrow phone-sized viewports.
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

async function measureLayout(page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - width;
    const offenders = [...document.body.querySelectorAll('*')].filter((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || (rect.left >= -1 && rect.right <= width + 1)) return false;
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.hasAttribute('aria-hidden') || ancestor.classList.contains('pointer-events-none')) return false;
        const overflowX = getComputedStyle(ancestor).overflowX;
        if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    }).slice(0, 8).map((el) => ({
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className : '',
      left: Math.round(el.getBoundingClientRect().left),
      right: Math.round(el.getBoundingClientRect().right),
    }));
    return { width, overflow, offenders };
  });
}

async function assertMobileLayout(page, path) {
  const layout = await measureLayout(page);
  expect(layout.overflow, `${path} does not scroll sideways (${JSON.stringify(layout)})`).toBeLessThanOrEqual(0);
  expect(layout.offenders, `${path} has no content outside the mobile viewport`).toEqual([]);
}

async function visit(page, path, problems) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first(), `${path} shows a page title`).toBeVisible();
  await expect(page.getByText(/This page could not be displayed|This page needs to be reloaded/), `${path} did not crash`).toHaveCount(0);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const layout = await measureLayout(page);
  expect(layout.overflow, `${path} does not scroll sideways (${JSON.stringify(layout)})`).toBeLessThanOrEqual(0);
  if (layout.width <= 768) expect(layout.offenders, `${path} has no content outside the mobile viewport`).toEqual([]);
  expect(problems, `${path} raised no errors`).toEqual([]);
}

async function visitFirstLink(page, listPath, { startsWith, endsWith }, problems) {
  await visit(page, listPath, problems);
  const href = await page.locator('a[href]').evaluateAll((anchors, match) => anchors.map((a) => a.getAttribute('href')).find((value) =>
    value?.startsWith(match.startsWith) && (!match.endsWith || value.endsWith(match.endsWith))), { startsWith, endsWith });
  expect(href, `${listPath} has a link to ${startsWith}${endsWith ?? ''}`).toBeTruthy();
  await visit(page, href, problems);
  return href;
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

for (const role of Object.keys(PAGES)) {
  test(`${role}: every main page fits a mobile viewport`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 800 });
    const problems = watchForProblems(page);
    await signIn(page, role);
    for (const path of PAGES[role]) await visit(page, path, problems);
    if (role !== 'admin') await visitFirstLink(page, '/programming', { startsWith: '/programming/' }, problems);
    if (role === 'teacher') await visitFirstLink(page, '/question-banks', { startsWith: '/question-banks/' }, problems);
  });
}

for (const role of Object.keys(CLASS_PAGES)) {
  test(`${role}: every class tab fits a mobile viewport`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 800 });
    const problems = watchForProblems(page);
    await signIn(page, role);
    const classes = (await (await page.request.get('/api/classes?status=ACTIVE')).json()).data;
    const cls = classes.find((c) => c.course?.code === 'IT 101') ?? classes[0];
    const base = `/classes/${cls.id}`;
    for (const tab of CLASS_PAGES[role]) await visit(page, `${base}${tab}`, problems);
    await visitFirstLink(page, `${base}/modules`, { startsWith: `${base}/modules/` }, problems);
    await visitFirstLink(page, `${base}/assignments`, { startsWith: `${base}/assignments/` }, problems);
    await visitFirstLink(page, `${base}/quizzes`, { startsWith: `${base}/quizzes/` }, problems);
    await visitFirstLink(page, `${base}/discussions`, { startsWith: `${base}/discussions/` }, problems);
    if (role === 'teacher') {
      await visitFirstLink(page, `${base}/assignments`, { startsWith: `${base}/assignments/`, endsWith: '/submissions' }, problems);
      await visitFirstLink(page, `${base}/quizzes`, { startsWith: `${base}/quizzes/`, endsWith: '/results' }, problems);
    }
  });
}

test('conversation and comment composers fit a mobile viewport', async ({ page }) => {
  const width = 360;
  await page.setViewportSize({ width, height: 800 });
  const problems = watchForProblems(page);
  await signIn(page, 'student');

  await page.goto('/messages');
  const conversation = page.locator('main aside button').first();
  await expect(conversation, 'the demo student has a conversation to open').toBeVisible();
  await conversation.click();
  await expect(page.getByRole('log', { name: /Messages with/ })).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Write a message' });
  await expect(message).toBeVisible();
  await assertMobileLayout(page, 'active conversation');
  const messageBox = await message.boundingBox();
  expect(messageBox?.width).toBeGreaterThan(100);
  expect((messageBox?.x ?? 0) + (messageBox?.width ?? width)).toBeLessThanOrEqual(width);

  await page.goto('/announcements');
  const comments = page.getByRole('button', { name: /^(?:Add a comment|\d+ comments?)$/ }).first();
  await expect(comments, 'the demo announcement has comments enabled').toBeVisible();
  await comments.click();
  const comment = page.getByRole('textbox', { name: 'Write a comment' });
  await expect(comment).toBeVisible();
  await assertMobileLayout(page, 'announcement comment composer');
  const commentBox = await comment.boundingBox();
  expect(commentBox?.width).toBeGreaterThan(100);
  expect((commentBox?.x ?? 0) + (commentBox?.width ?? width)).toBeLessThanOrEqual(width);
  expect(problems).toEqual([]);
});

test('public account and privacy pages fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const problems = watchForProblems(page);
  for (const path of ['/login', '/register', '/forgot-password', '/privacy']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first(), `${path} has a page title`).toBeVisible();
    await assertMobileLayout(page, path);
  }
  expect(problems).toEqual([]);
});

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
