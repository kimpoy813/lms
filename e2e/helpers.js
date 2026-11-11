// Shared helpers for the end-to-end tests.
import { expect, request } from '@playwright/test';

export const PASSWORD = process.env.E2E_PASSWORD ?? 'Demo-Pass-2026';
export const ACCOUNTS = {
  admin: 'admin@edusphere.demo',
  teacher: 'teacher@edusphere.demo',
  student: 'student@edusphere.demo',
  student2: 'student2@edusphere.demo',
};
/** The classroom used by the attendance tests (Angeles City). */
export const CLASSROOM = { latitude: 15.145, longitude: 120.5887 };

/** Sign in through the sign-in form, as a person would. */
export async function signIn(page, who) {
  await page.goto('/login');
  await page.getByLabel('E-mail address').fill(ACCOUNTS[who] ?? who);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * A signed-in API client, for preparing and cleaning up test data.
 * The API uses a session cookie plus a CSRF token, exactly like the web app.
 */
export async function apiAs(who, baseURL) {
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  const login = await context.post('/api/auth/login', { data: { email: ACCOUNTS[who] ?? who, password: PASSWORD } });
  if (!login.ok()) {
    throw new Error(`Could not sign in as ${who} (HTTP ${login.status()}). The tests need the demo data: run "npm run db:seed" first.`);
  }
  const csrfToken = (await login.json()).data.csrfToken;
  const call = async (method, path, data) => {
    const response = await context.fetch(`/api${path}`, { method, data, headers: { 'X-CSRF-Token': csrfToken } });
    const body = response.status() === 204 ? null : await response.json().catch(() => null);
    if (!response.ok()) throw new Error(`${method} ${path} → HTTP ${response.status()} ${JSON.stringify(body?.error ?? body)}`);
    return body?.data ?? null;
  };
  return {
    get: (path) => call('GET', path),
    post: (path, data = {}) => call('POST', path, data),
    put: (path, data) => call('PUT', path, data),
    patch: (path, data) => call('PATCH', path, data),
    delete: (path) => call('DELETE', path),
    dispose: () => context.dispose(),
  };
}

/** One of the demo classes, by course code. */
export async function demoClass(api, courseCode = 'IT 101') {
  const classes = await api.get('/classes?status=ACTIVE');
  const found = classes.find((c) => c.course?.code === courseCode);
  if (!found) throw new Error(`The demo class ${courseCode} was not found. Run "npm run db:seed".`);
  return found;
}

/** Collects browser errors and failed API calls so that a test can assert there were none. */
export function watchForProblems(page) {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    // Map tiles come from a third-party server and may be unreachable where the tests run.
    if (message.type() === 'error' && !/tile|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) problems.push(`HTTP ${response.status()} ${response.url()}`);
  });
  return problems;
}

export const unique = (label) => `${label} ${Date.now().toString(36)}`;
