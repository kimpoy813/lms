// Screens that update by themselves: an open conversation and the teacher's attendance monitor.
//
// A server that stays up pushes these changes over a socket. A server that runs as function
// invocations (Vercel) cannot, and the web app asks again every few seconds instead. Either way
// the change has to show up without anybody reloading the page — that is what is tested here.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique } from '../helpers.js';

test.describe.configure({ mode: 'serial' });

let teacher;
let student;
let runtime;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  student = await apiAs('student', baseURL);
  runtime = (await teacher.get('/auth/session')).runtime;
});

test.afterAll(async () => {
  await teacher?.dispose();
  await student?.dispose();
});

/** Marks the page so that a later check can tell it was never reloaded. */
const stamp = (page) => page.evaluate(() => { window.__sameVisit = true; });
const stillSameVisit = (page) => page.evaluate(() => window.__sameVisit === true);

test('a new message shows up in an open conversation', async ({ page }) => {
  const studentId = (await student.get('/auth/session')).user.id;
  const conversation = await teacher.post('/messages/conversations', { userId: studentId });
  const text = unique('Reminder: bring your laptop');
  let sent;
  try {
    await signIn(page, 'student');
    await page.goto(`/messages?c=${conversation.id}`);
    await expect(page.getByRole('textbox').last()).toBeVisible();
    await stamp(page);

    sent = await teacher.post(`/messages/conversations/${conversation.id}/messages`, { body: text });
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
    expect(await stillSameVisit(page)).toBe(true);
  } finally {
    if (sent) await teacher.delete(`/messages/messages/${sent.id}`).catch(() => {});
  }
});

test('the attendance monitor picks up a check-in', async ({ page }) => {
  const cls = await demoClass(teacher, 'IT 101');
  const session = await teacher.post(`/classes/${cls.id}/attendance/sessions`, {
    title: 'Live update test meeting', allowCode: true, allowQr: false, requireLocation: false, durationMinutes: 20,
  });
  try {
    const { code } = await teacher.post(`/attendance/sessions/${session.id}/code`, {});
    await signIn(page, 'teacher');
    await page.goto(`/classes/${cls.id}/attendance?session=${session.id}`);
    // The tally at the top of the monitor: a number above each of Present, Late, Absent, Excused.
    const present = page.locator('dl > div').filter({ has: page.locator('dt', { hasText: /^Present$/ }) }).locator('dd').first();
    await expect(present).toHaveText('0');
    await stamp(page);

    const result = await student.post('/attendance/check-in', { code });
    expect(result.status).toBe('RECORDED');
    await expect(present).toHaveText('1', { timeout: 25_000 });
    expect(await stillSameVisit(page)).toBe(true);
  } finally {
    await teacher.post(`/attendance/sessions/${session.id}/cancel`, { reason: 'End-to-end test run' }).catch(() => {});
  }
});

test('the web app opens a socket only when the server can push', async ({ page }) => {
  const sockets = [];
  page.on('request', (request) => { if (request.url().includes('/socket.io')) sockets.push(request.url()); });
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await signIn(page, 'student');
  await page.goto('/messages');
  await page.waitForTimeout(3_000);
  if (runtime.realtime) expect(sockets.length).toBeGreaterThan(0);
  else expect(sockets).toEqual([]);
});
