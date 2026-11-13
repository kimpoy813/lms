// Running programs, seen from the web app: what a student is shown while the code checker is busy
// or being prepared, what the administrator's "Check now" shows, and the note for a teacher whose
// tests cannot all fit into the time the checker has.
//
// The demo site has no code runner (it would need a Vercel account), so the server's part is
// played here: its answers to "run this program" and "check the code runner" are written by the
// test, in the shapes the API uses (backend/tests/api/code-runner.test.js checks those).
import { expect, test } from '@playwright/test';
import { signIn } from '../helpers.js';

/** Changes one answer of the server on its way to the page. */
async function adjust(page, urlPattern, change) {
  await page.route(urlPattern, async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!response.ok() || !body?.data) return route.fulfill({ response });
    change(body.data);
    return route.fulfill({ response, json: body });
  });
}

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const refusal = (code, message, details) => json(503, { error: { code, message, details } });

/**
 * A site whose programs are checked in Vercel Sandbox machines. These tests are about the server's
 * part, so every program goes there: trying Python in the browser is switched off, as an
 * administrator can do (python-in-browser.spec.js is about the other case).
 */
async function withCodeRunner(page) {
  await adjust(page, '**/api/programming/status', (status) => Object.assign(status, { configured: true, provider: 'vercel-sandbox', message: null, totalTimeLimitMs: 50_000, inBrowser: [] }));
  await adjust(page, /\/api\/programming\/problems\/[^/?]+(\?.*)?$/, (problem) => Object.assign(problem.runner, { configured: true, provider: 'vercel-sandbox', message: null, inBrowser: [] }));
}

async function openPracticeProblem(page) {
  await signIn(page, 'student');
  await page.goto('/programming');
  await page.getByRole('link', { name: 'Even or odd' }).click();
  await expect(page.getByRole('textbox', { name: 'Your code' })).toBeVisible();
}

const RUN = /\/api\/programming\/problems\/[^/]+\/run$/;
const samples = {
  data: { mode: 'SAMPLES', status: 'COMPLETED', errorMessage: null, passedCount: 1, totalCount: 2, results: [
    { position: 0, isHidden: false, passed: true, outcome: 'PASSED', input: '7', expectedOutput: 'ODD', stdout: 'ODD\n', stderr: '' },
    { position: 1, isHidden: false, passed: false, outcome: 'RUNTIME_ERROR', input: '10', expectedOutput: 'EVEN', stdout: '', stderr: 'Memory limit exceeded (128 MB).' },
  ] },
};

test('a busy code checker is asked again by the page, and the student sees why it takes longer', async ({ page }) => {
  await withCodeRunner(page);
  let asked = 0;
  await page.route(RUN, (route) => {
    asked += 1;
    return route.fulfill(asked <= 2 ? refusal('CODE_RUNNER_BUSY', 'The code checker is busy right now. Please try again in a few seconds.', { retryAfterSeconds: 1 }) : json(200, samples));
  });
  await openPracticeProblem(page);

  await page.getByRole('button', { name: 'Run sample tests' }).click();
  const waiting = page.getByRole('status').filter({ hasText: 'The code checker is busy' });
  await expect(waiting).toContainText('The code checker is busy. Trying again in a second…');
  // Nothing else can be started while it waits.
  await expect(page.getByRole('button', { name: 'Submit for checking' })).toBeDisabled();

  await expect(page.getByText('1 of 2 tests passed')).toBeVisible({ timeout: 15_000 });
  expect(asked).toBe(3);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByText('Could not run')).toHaveCount(0);
  // A limit that was hit is told in words, next to the test it happened in.
  await expect(page.getByText('Test 2: Runtime error')).toBeVisible();
  await expect(page.getByText('Memory limit exceeded (128 MB).')).toBeVisible();
});

test('a checker that stays busy, or is being prepared, is explained instead of looking broken', async ({ page }) => {
  await withCodeRunner(page);
  let asked = 0;
  let answer = refusal('CODE_RUNNER_BUSY', 'The code checker is busy right now. Please try again in a few seconds.', { retryAfterSeconds: 1 });
  await page.route(RUN, (route) => {
    asked += 1;
    return route.fulfill(answer);
  });
  await openPracticeProblem(page);

  await page.getByRole('button', { name: 'Run sample tests' }).click();
  await expect(page.getByText('The code checker is busy right now. Please try again in a minute.')).toBeVisible({ timeout: 30_000 });
  // The first try and three more, then the page stops asking.
  expect(asked).toBe(4);
  await expect(page.getByRole('button', { name: 'Run sample tests' })).toBeEnabled();

  // Being prepared takes minutes: the page says so at once and does not keep asking.
  asked = 0;
  answer = refusal('CODE_RUNNER_PREPARING', 'The machine that runs programs is being prepared. This takes a few minutes; please try again shortly.', { retryAfterSeconds: 60 });
  await page.getByRole('button', { name: 'Run sample tests' }).click();
  await expect(page.getByText('The machine that runs programs is being prepared, which takes a few minutes. Please try again shortly.')).toBeVisible();
  expect(asked).toBe(1);
});

test('the administrator can check the code runner and sees every language, or the reason', async ({ page }) => {
  await adjust(page, '**/api/admin/status', (status) => {
    status.codeRunner = { configured: true, provider: 'vercel-sandbox', region: 'sin1', lastSuccessAt: null, lastFailureAt: null, lastFailure: null };
  });
  const languages = (broken) => Object.fromEntries(['PYTHON', 'JAVASCRIPT', 'C', 'CPP', 'JAVA'].map((id) => [id, { ok: id !== broken, compileMs: 90, runMs: 20, peakKb: 3000, detail: id === broken ? 'not installed: javac, java' : null }]));
  const about = { provider: 'vercel-sandbox', region: 'sin1', identity: 'the project’s identity, handed to this request by Vercel' };
  const answers = [
    json(200, { data: { ok: true, ...about, languages: languages(null), versions: { PYTHON: 'Python 3.14.4', JAVA: 'javac 25.0.5.0.3' }, limits: 'cgroup', timings: { totalMs: 5100 } } }),
    json(200, { data: { ok: false, ...about, languages: languages('JAVA'), versions: { PYTHON: 'Python 3.14.4' }, limits: 'cgroup', timings: { totalMs: 4800 } } }),
    json(200, { data: { ok: false, ...about, code: 'CODE_RUNNER_UNAVAILABLE', detail: 'The allowance for running programs is used up for now. — HTTP 402 payment_required: Sandbox creation is paused' } }),
  ];
  await page.route('**/api/admin/code-runner/check', (route) => route.fulfill(answers.shift()));

  await signIn(page, 'admin');
  await page.goto('/admin/settings');
  const runner = page.getByRole('listitem').filter({ hasText: 'Code runner' });
  await expect(runner).toContainText('Every program runs in a machine of its own on this site’s Vercel account (region sin1), without network access');

  await runner.getByRole('button', { name: 'Check now' }).click();
  await expect(runner.getByText('Programs are being checked.')).toBeVisible();
  await expect(runner.getByText('5.1 s')).toBeVisible();
  await expect(runner.getByRole('listitem').filter({ hasText: 'Python' })).toContainText('Python 3.14.4');
  await expect(runner.getByRole('listitem').filter({ hasText: 'Java' }).last()).toContainText('javac 25.0.5.0.3');
  await expect(runner).toContainText('Machines are started with: the project’s identity, handed to this request by Vercel.');

  await runner.getByRole('button', { name: 'Check now' }).click();
  await expect(runner.getByText('Programs cannot be checked right now.')).toBeVisible();
  await expect(runner.getByText('not installed: javac, java')).toBeVisible();

  await runner.getByRole('button', { name: 'Check now' }).click();
  await expect(runner.getByText('HTTP 402 payment_required: Sandbox creation is paused')).toBeVisible();
  await expect(runner.getByText('Python 3.14.4')).toHaveCount(0);
});

test('a teacher is told when a slow program cannot get through all tests', async ({ page }) => {
  await withCodeRunner(page);
  await signIn(page, 'teacher');
  await page.goto('/programming');
  await page.getByRole('button', { name: 'New problem' }).click();
  const dialog = page.getByRole('dialog');
  const hint = dialog.getByText('The checker gives one program 50 seconds');

  // Two tests of three seconds each fit easily: nothing to say.
  await expect(dialog.getByLabel('Time limit per test (seconds)')).toHaveValue('3');
  await expect(hint).toHaveCount(0);

  await dialog.getByLabel('Time limit per test (seconds)').fill('15');
  await expect(hint).toHaveCount(0); // 2 × 15 s
  await dialog.getByRole('button', { name: 'Add a test case' }).click();
  await dialog.getByRole('button', { name: 'Add a test case' }).click();
  await expect(hint).toHaveText('The checker gives one program 50 seconds for all its tests together. A program that needs the full 15 s every time gets through about 3 of these 4 tests; the rest then count as too slow.');

  await dialog.getByLabel('Time limit per test (seconds)').fill('5');
  await expect(hint).toHaveCount(0);
});
