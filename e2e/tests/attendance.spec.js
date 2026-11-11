// QR + GPS attendance: the location check is decided on the server, per check-in.
import { expect, test } from '@playwright/test';
import { apiAs, CLASSROOM, demoClass, signIn } from '../helpers.js';

test.describe.configure({ mode: 'serial' });

let teacher;
let session;
let code;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  const cls = await demoClass(teacher, 'IT 101');
  session = await teacher.post(`/classes/${cls.id}/attendance/sessions`, {
    title: 'End-to-end test meeting',
    allowCode: true,
    allowQr: true,
    requireLocation: true,
    durationMinutes: 20,
    radiusMeters: 80,
    location: { ...CLASSROOM, name: 'Room 204', save: false },
  });
  code = (await teacher.post(`/attendance/sessions/${session.id}/code`, {})).code;
});

test.afterAll(async () => {
  // Cancelled meetings are left out of every attendance figure, so the demo data stays as it was.
  if (session) await teacher.post(`/attendance/sessions/${session.id}/cancel`, { reason: 'End-to-end test run' }).catch(() => {});
  await teacher?.dispose();
});

async function checkIn(browser, who, position) {
  const context = await browser.newContext({ geolocation: position ? { ...position, accuracy: 12 } : undefined, permissions: position ? ['geolocation'] : [] });
  const page = await context.newPage();
  await signIn(page, who);
  await page.goto('/attendance/scan');
  await page.getByRole('tab', { name: /Type the code/ }).click();
  await page.locator('#attendance-code').fill(code);
  await page.getByRole('button', { name: 'Check in' }).click();
  return { page, context };
}

test('a student inside the classroom is checked in', async ({ browser }) => {
  const { page, context } = await checkIn(browser, 'student', CLASSROOM);
  await expect(page.getByText(/You are checked in|Checked in — late/)).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('a student who is far away is refused and told the distance', async ({ browser }) => {
  // About 1.1 km north of the classroom.
  const { page, context } = await checkIn(browser, 'student2', { latitude: CLASSROOM.latitude + 0.01, longitude: CLASSROOM.longitude });
  await expect(page.getByText('Not checked in yet')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/from the classroom; the limit is 80 m/)).toBeVisible();
  await context.close();
});

test('a student who does not share a location is refused', async ({ browser }) => {
  const { page, context } = await checkIn(browser, 'student3@edusphere.demo', null);
  await expect(page.getByText(/You are checked in|Checked in — late/)).toHaveCount(0);
  await expect(page.getByText(/location/i).first()).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('the teacher sees one student present and the refused attempts', async ({ page }) => {
  const detail = await teacher.get(`/attendance/sessions/${session.id}`);
  const present = detail.roster.filter((row) => ['PRESENT', 'LATE'].includes(row.record?.status));
  expect(present.map((row) => row.name)).toEqual(['Juan Dela Cruz']);
  const attempts = await teacher.get(`/attendance/sessions/${session.id}/attempts`);
  const far = attempts.find((a) => a.reason === 'OUTSIDE_RADIUS');
  expect(far).toBeTruthy();
  expect(far.distanceMeters).toBeGreaterThan(900);
  // Only the distance is kept: no coordinates of a student are stored or returned.
  expect(Object.keys(far)).not.toContain('latitude');
  expect(Object.keys(present[0].record)).not.toContain('latitude');

  await signIn(page, 'teacher');
  await page.goto(`/classes/${detail.classId}/attendance`);
  await expect(page.getByText('End-to-end test meeting').first()).toBeVisible();
});
