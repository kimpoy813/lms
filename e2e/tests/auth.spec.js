import { expect, test } from '@playwright/test';
import { ACCOUNTS, signIn } from '../helpers.js';

test.describe('signing in', () => {
  test('refuses a wrong password without saying which part was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail address').fill(ACCOUNTS.student);
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Incorrect e-mail address or password.' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a student signs in, sees their dashboard and signs out', async ({ page }) => {
    await signIn(page, 'student');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Juan');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My classes' })).toBeVisible();
    // Students have no administration or teaching menus.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    // The session is really gone: a protected page sends the visitor back to sign in.
    await page.goto('/classes');
    await expect(page).toHaveURL(/\/login/);
  });

  test('returns to the page that was asked for after signing in', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('E-mail address').fill(ACCOUNTS.student);
    await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_PASSWORD ?? 'Demo-Pass-2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/calendar/);
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  });
});

test.describe('roles', () => {
  test('a student cannot open administrator pages or call administrator APIs', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto('/admin/users');
    await expect(page.getByText('This page is not available for your account')).toBeVisible();
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
    expect((await page.request.get('/api/admin/audit-logs')).status()).toBe(403);
  });

  test('a teacher cannot see a class that belongs to another teacher', async ({ page }) => {
    await signIn(page, 'teacher');
    const mine = (await (await page.request.get('/api/classes?status=ACTIVE')).json()).data.map((c) => c.id);
    expect(mine.length).toBeGreaterThan(0);
    // GE 105 is taught by the second demo teacher.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await signIn(page, 'teacher2@edusphere.demo');
    const theirs = (await (await page.request.get('/api/classes?status=ACTIVE')).json()).data.map((c) => c.id);
    expect(theirs.some((id) => mine.includes(id))).toBe(false);
    // Asking for someone else's class by id answers "not found", not "forbidden".
    expect((await page.request.get(`/api/classes/${mine[0]}`)).status()).toBe(404);
    expect((await page.request.get(`/api/classes/${mine[0]}/gradebook`)).status()).toBe(404);
  });

  test('an administrator reaches the user list and the audit log', async ({ page }) => {
    await signIn(page, 'admin');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Juan Dela Cruz' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    await expect(page.getByText('Signed in').first()).toBeVisible();
  });
});
