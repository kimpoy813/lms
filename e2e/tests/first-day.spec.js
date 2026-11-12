// The first days of a school on EduSphere: what an administrator, a teacher and a student meet
// before any routine exists. Every test here stands for something that went wrong, or was
// missing, when a new installation was walked through by hand.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique } from '../helpers.js';

const MB = 1024 * 1024;

/** Changes one answer of the server on its way to the page (a setting, never behaviour). */
async function adjust(page, urlPattern, change) {
  await page.route(urlPattern, async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!response.ok() || !body?.data) return route.fulfill({ response });
    change(body.data);
    return route.fulfill({ response, json: body });
  });
}

test('the administrator is guided through the set-up, and a step ticks itself when it is done', async ({ page, baseURL }) => {
  const admin = await apiAs('admin', baseURL);
  const before = (await admin.get('/admin/settings')).values['institution.name'];
  try {
    // The demo school has teachers, classes and students. What it lacks is a name of its own.
    await admin.patch('/admin/settings', { values: { 'institution.name': 'EduSphere University' } });
    await signIn(page, 'admin');
    const guide = page.getByRole('region', { name: 'Getting your school started' });
    await expect(guide).toContainText('6 of 7 steps done');
    await expect(guide.getByRole('listitem').filter({ hasText: 'Name your school' })).toHaveAttribute('aria-current', 'step');

    // It can be put away, and brought back.
    await guide.getByRole('button', { name: 'Hide' }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByText('Setting up: 6 of 7 steps done.')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Show the guide' }).click();

    // Doing the step is what ticks it: nobody marks anything as done.
    await guide.getByRole('link', { name: 'Open settings' }).click();
    await page.getByLabel('Institution name').fill('Pampanga State University');
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await expect(guide).toHaveCount(0);
    await expect(page.getByText('Setting up:')).toHaveCount(0);
  } finally {
    await admin.patch('/admin/settings', { values: { 'institution.name': before } });
    await admin.dispose();
  }
});

test('someone who replaces a temporary password starts on the dashboard', async ({ page, baseURL }) => {
  const admin = await apiAs('admin', baseURL);
  const email = `first.day.${Date.now().toString(36)}@example.test`;
  const created = await admin.post('/admin/users', { role: 'TEACHER', firstName: 'Nueva', lastName: 'Maestra', email });
  try {
    await page.goto('/login');
    await page.getByLabel('E-mail address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(created.temporaryPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/change-password/);

    // A password with the person's own name in it is refused, and the message says which word.
    await page.getByLabel('Temporary password').fill(created.temporaryPassword);
    await page.getByLabel('New password', { exact: true }).fill('Maestra of the school 2026');
    await page.getByLabel('Repeat the new password').fill('Maestra of the school 2026');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'leave out “maestra”' })).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill('Chalk dust and coffee 2026');
    await page.getByLabel('Repeat the new password').fill('Chalk dust and coffee 2026');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Nueva');
    expect(new URL(page.url()).pathname).toBe('/');
  } finally {
    await admin.post(`/admin/users/${created.user.id}/anonymize`, { confirm: 'ANONYMIZE', reason: 'End-to-end test run' }).catch(() => {});
    await admin.dispose();
  }
});

test('a module and an assignment are created with every date left empty', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  const cls = await demoClass(teacher, 'IT 101');
  const moduleTitle = unique('Module without dates');
  let moduleId;
  let assignmentId;
  try {
    await signIn(page, 'teacher');
    const dialog = page.getByRole('dialog');

    // Left as a draft, so that the students of the demo class are not notified by a test.
    await page.goto(`/classes/${cls.id}/modules`);
    await page.getByRole('button', { name: 'New module' }).click();
    await dialog.getByLabel('Title').fill(moduleTitle);
    await dialog.getByRole('button', { name: 'Create and add a lesson' }).click();
    await expect(page).toHaveURL(/\/modules\/[a-z0-9]+\?new=1/);
    moduleId = new URL(page.url()).pathname.split('/').pop();
    // "Available until" was empty. That is no closing date — it used to be stored as 1 January 1970.
    const stored = (await teacher.get(`/classes/${cls.id}/modules`)).find((m) => m.id === moduleId);
    expect(stored.availableUntil).toBeNull();
    await page.goto(`/classes/${cls.id}/modules`);
    const row = page.getByRole('listitem').filter({ hasText: moduleTitle });
    await expect(row).toContainText('0 lessons');
    await expect(row).not.toContainText('available until');

    // An assignment with no opening, due or closing date could not be created at all.
    await page.goto(`/classes/${cls.id}/assignments`);
    await page.getByRole('button', { name: 'New assignment' }).first().click();
    await dialog.getByLabel('Title').fill(unique('Assignment without dates'));
    await dialog.getByRole('button', { name: 'Create assignment' }).click();
    await expect(page).toHaveURL(/\/assignments\/[a-z0-9]+$/);
    assignmentId = new URL(page.url()).pathname.split('/').pop();
    await expect(page.getByText('No due date').first()).toBeVisible();
    expect(await teacher.get(`/assignments/${assignmentId}`)).toMatchObject({ availableFrom: null, dueAt: null, closeAt: null });
  } finally {
    if (assignmentId) await teacher.delete(`/assignments/${assignmentId}`).catch(() => {});
    if (moduleId) await teacher.delete(`/modules/${moduleId}`).catch(() => {});
    await teacher.dispose();
  }
});

test('a meeting that takes only a code opens check-in on the code, and says when it closes', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  const cls = await demoClass(teacher, 'IT 101');
  const session = await teacher.post(`/classes/${cls.id}/attendance/sessions`, { title: 'Code-only meeting', allowCode: true, allowQr: false, requireLocation: false, durationMinutes: 20 });
  try {
    await signIn(page, 'student');
    // The closing time is an instant; it was once shown as "NaN:43 PM".
    await expect(page.getByText(/Code-only meeting · closes \d{1,2}:\d{2}\s?(AM|PM)/)).toBeVisible();
    await page.getByRole('link', { name: 'Check in now' }).first().click();
    // No camera is needed for this meeting, so the page does not open on the camera.
    await expect(page.getByRole('tab', { name: 'Type the code' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Attendance code from your teacher')).toBeVisible();
  } finally {
    // Cancelled meetings are left out of every attendance figure, so the demo data stays as it was.
    await teacher.post(`/attendance/sessions/${session.id}/cancel`, { reason: 'End-to-end test run' }).catch(() => {});
    await teacher.dispose();
  }
});

test('where the site cannot send e-mail, “forgot password” says whom to ask', async ({ page }) => {
  // A server without SMTP settings says so itself; here the answer is set, so that the test
  // also runs against a development server, which keeps messages in its mailbox.
  await adjust(page, '**/api/auth/config', (config) => { config.emailEnabled = false; });
  await page.goto('/forgot-password');
  await expect(page.getByText('Ask your school for a temporary password')).toBeVisible();
  await expect(page.getByText('This site does not send e-mail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send reset link' })).toHaveCount(0);
});

/**
 * A photo as a phone stores it: 3200 × 2400 pixels lying on its side, with a note in the file
 * (EXIF orientation 6) that it is to be shown upright. The left edge of the stored picture —
 * the top, once shown upright — is red.
 */
async function phonePhoto(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3200;
    canvas.height = 2400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f4f1e8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#d00000';
    context.fillRect(0, 0, 200, canvas.height);
    // Grain, as a camera sensor produces it: it is what makes a real photo several megabytes.
    const image = context.getImageData(200, 0, canvas.width - 200, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 60;
      image.data[i] += noise;
      image.data[i + 1] += noise;
      image.data[i + 2] += noise;
    }
    context.putImageData(image, 200, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  const jpeg = Buffer.from(base64, 'base64');
  // APP1 "Exif" segment holding a single tag: Orientation (0x0112) = 6, "turn a quarter clockwise".
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

test('a photo from a phone is made smaller before it is sent, and stays upright', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  const cls = await demoClass(teacher, 'IT 101');
  // The server names the size above which photos are reduced: one megabyte where space is short,
  // the upload limit elsewhere. It is set to one megabyte here so that the test needs no 25 MB photo.
  await adjust(page, /\/api\/auth\/(login|session)/, (session) => { if (session.runtime) session.runtime.reducePhotosOverBytes = MB; });
  let fileId;
  try {
    await signIn(page, 'teacher');
    await page.goto(`/classes/${cls.id}/assignments`);
    const photo = await phonePhoto(page);
    expect(photo.length).toBeGreaterThan(1.5 * MB);

    await page.getByRole('button', { name: 'New assignment' }).first().click();
    const dialog = page.getByRole('dialog');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Attach files' }).click();
    await (await chooser).setFiles({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: photo });

    // The person is told what happened to their file.
    await expect(page.getByRole('status').filter({ hasText: /“IMG_2041\.jpg” was made smaller before sending: [\d.]+ MB → [\d.]+ (KB|MB)\./ })).toBeVisible({ timeout: 30_000 });
    const link = dialog.getByRole('link', { name: 'IMG_2041.jpg', exact: true });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    fileId = href.split('/')[3];

    // What the server keeps is a JPEG well under the original size…
    const stored = await page.request.get(href);
    expect(stored.headers()['content-type']).toBe('image/jpeg');
    const bytes = await stored.body();
    expect(bytes.length).toBeLessThan(photo.length / 2);
    expect(bytes.length).toBeLessThan(1.2 * MB);
    // …2048 pixels on the long side, and upright: the red edge is at the top.
    const seen = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
      return { width: image.naturalWidth, height: image.naturalHeight, top: pixel(canvas.width / 2, 20), bottom: pixel(canvas.width / 2, canvas.height - 20) };
    }, href);
    expect([seen.width, seen.height]).toEqual([1536, 2048]);
    const isRed = ([r, g, b]) => r > 150 && g < 80 && b < 80;
    expect(isRed(seen.top), `top pixel ${seen.top}`).toBe(true);
    expect(isRed(seen.bottom), `bottom pixel ${seen.bottom}`).toBe(false);
  } finally {
    if (fileId) await teacher.raw('DELETE', `/files/${fileId}`).catch(() => {});
    await teacher.dispose();
  }
});
