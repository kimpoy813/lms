// Trying a Python program in the browser: "Run sample tests" and "Try my own input" run on the
// student's own device, in a frame that is shut off from the site, and the server's code runner
// is asked only for what the browser cannot do faithfully and for every submission that counts.
//
// This is the real thing: Python is downloaded and started in the test's browser. Only the
// server's code runner is played by the test where one is needed (the demo site has none).
import { expect, test } from '@playwright/test';
import { apiAs, signIn } from '../helpers.js';

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const RUN = /\/api\/programming\/problems\/[^/]+\/run$/;
const SUBMIT = /\/api\/programming\/problems\/[^/]+\/submit$/;
const EVEN_OR_ODD = 'n = int(input())\nprint("EVEN" if n % 2 == 0 else "ODD")\n';

/** Counts what is asked of the server's code runner; answers it when the test plays one. */
async function watchServer(page, { run, submit } = {}) {
  const asked = { run: [], submit: [] };
  await page.route(RUN, (route) => {
    asked.run.push(route.request().postDataJSON());
    return run ? route.fulfill(json(200, { data: run })) : route.continue();
  });
  await page.route(SUBMIT, (route) => {
    asked.submit.push(route.request().postDataJSON());
    return submit ? route.fulfill(json(201, { data: submit })) : route.continue();
  });
  return asked;
}

/** The demo site with a code runner on the server (played by the test). */
async function withCodeRunner(page) {
  const adjust = async (pattern, change) => page.route(pattern, async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!response.ok() || !body?.data) return route.fulfill({ response });
    change(body.data);
    return route.fulfill({ response, json: body });
  });
  await adjust('**/api/programming/status', (status) => Object.assign(status, { configured: true, provider: 'vercel-sandbox', message: null }));
  await adjust(/\/api\/programming\/problems\/[^/?]+(\?.*)?$/, (problem) => Object.assign(problem.runner, { configured: true, provider: 'vercel-sandbox', message: null }));
}

async function openPracticeProblem(page) {
  await signIn(page, 'student');
  await page.goto('/programming');
  await page.getByRole('link', { name: 'Even or odd' }).click();
  await expect(page.getByRole('textbox', { name: 'Your code' })).toBeVisible();
}

async function write(page, code) {
  await page.getByRole('textbox', { name: 'Your code' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(code);
}

/** Press "Run sample tests" and wait until the run is over. */
async function runSamples(page) {
  const button = page.getByRole('button', { name: 'Run sample tests' });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 45_000 });
}

test('a Python program is tried in the browser, without the server’s code runner', async ({ page }) => {
  test.setTimeout(120_000);
  const asked = await watchServer(page);
  await openPracticeProblem(page);
  // The demo site has no code runner, and Python can be tried all the same.
  await expect(page.getByText('Programs are not checked automatically on this server')).toBeVisible();
  const note = page.getByText('Run in your browser');

  await write(page, EVEN_OR_ODD);
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
  await expect(note).toBeVisible();

  // A wrong answer shows what was expected and what the program printed.
  await write(page, 'n = int(input())\nprint("ODD")\n');
  await runSamples(page);
  await expect(page.getByText('1 of 2 tests passed')).toBeVisible();
  await expect(page.getByText('Test 2: Wrong answer')).toBeVisible();

  // An error is reported as Python reports it on the server: the same file name, line and marks.
  await write(page, 'n = int(input())\nprint(10 // (n - 7))\n');
  await runSamples(page);
  await expect(page.getByText('Test 1: Runtime error')).toBeVisible();
  await expect(page.getByText('File "main.py", line 2, in <module>')).toBeVisible();
  await expect(page.getByText('ZeroDivisionError: division by zero')).toBeVisible();

  await write(page, 'n = int(input()\n');
  await runSamples(page);
  await expect(page.getByText('The program could not be compiled or started')).toBeVisible();
  await expect(page.getByText("SyntaxError: '(' was never closed")).toBeVisible();

  // An input of one's own.
  await write(page, 'name = input("Name? ")\nprint("Hello,", name)\n');
  await page.getByRole('button', { name: 'Try my own input' }).click();
  await page.getByLabel('Input for the program (stdin)').fill('Ana\n');
  const runOwn = page.getByRole('button', { name: 'Run', exact: true });
  await runOwn.click();
  await expect(page.getByText('Name? Hello, Ana')).toBeVisible({ timeout: 45_000 });
  await expect(note).toBeVisible();

  // A program that never ends is stopped, and the page says where and after how long.
  await write(page, 'print("started", flush=True)\nwhile True:\n    pass\n');
  await runSamples(page);
  await expect(page.getByText('Test 1: Too slow')).toBeVisible();
  await expect(page.getByText('Stopped after 9 seconds on this device. On the server a test may take 3 seconds.')).toBeVisible();
  await expect(page.getByText('Not run: an earlier test took too long.')).toBeVisible();
  // …and the next run starts from a clean Python.
  await write(page, EVEN_OR_ODD);
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();

  // What the browser's Python cannot do as the server's does is not guessed at. With no code
  // runner on the server there is nobody to hand it to, and the page says so.
  await write(page, 'import threading\nprint("EVEN")\n');
  await runSamples(page);
  await expect(page.getByText('This program cannot be run in your browser (it imports threading), and no code runner is set up on the server.')).toBeVisible();

  expect(asked.run).toEqual([]);
  expect(asked.submit).toEqual([]);
});

test('the server runs what the browser cannot, and everything that counts', async ({ page }) => {
  test.setTimeout(120_000);
  const fromServer = {
    mode: 'SAMPLES', status: 'COMPLETED', errorMessage: null, passedCount: 2, totalCount: 2,
    results: [
      { position: 0, isHidden: false, passed: true, outcome: 'PASSED', input: '7\n', expectedOutput: 'ODD', stdout: 'ODD\n', stderr: '' },
      { position: 1, isHidden: false, passed: true, outcome: 'PASSED', input: '10\n', expectedOutput: 'EVEN', stdout: 'EVEN\n', stderr: '' },
    ],
  };
  const checked = { id: 'sub-1', status: 'COMPLETED', errorMessage: null, passedCount: 4, totalCount: 4, scorePercent: 100, results: [...fromServer.results, { position: 2, isHidden: true, passed: true, outcome: 'PASSED' }, { position: 3, isHidden: true, passed: true, outcome: 'PASSED' }] };
  await withCodeRunner(page);
  const asked = await watchServer(page, { run: fromServer, submit: checked });
  await openPracticeProblem(page);
  await expect(page.getByText('Programs are not checked automatically on this server')).toHaveCount(0);
  const note = page.getByText('Run in your browser');

  // An ordinary program: in the browser.
  await write(page, EVEN_OR_ODD);
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
  await expect(note).toContainText('“Submit for checking” is what counts, and that runs on the server.');
  expect(asked.run).toHaveLength(0);

  // Whoever doubts the browser can ask the server for the same run.
  await page.getByRole('button', { name: 'Run on the server instead' }).click();
  await expect(note).toHaveCount(0);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
  expect(asked.run).toEqual([{ language: 'PYTHON', code: EVEN_OR_ODD }]);

  // A program that uses threads is handed over without a word: the answer is the server's.
  const threads = `import threading\n${EVEN_OR_ODD}`;
  await write(page, threads);
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(asked.run).toHaveLength(2);
  expect(asked.run[1]).toEqual({ language: 'PYTHON', code: threads });

  // Submitting is never done in the browser.
  await write(page, EVEN_OR_ODD);
  await page.getByRole('button', { name: 'Submit for checking' }).click();
  await expect(page.getByText('4 of 4 tests passed')).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(asked.submit).toEqual([{ language: 'PYTHON', code: EVEN_OR_ODD }]);

  // Other languages run on the server as before.
  await page.getByLabel('Language').selectOption('CPP');
  await write(page, '#include <iostream>\nint main() { int n; std::cin >> n; std::cout << (n % 2 ? "ODD" : "EVEN"); }\n');
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(asked.run).toHaveLength(3);
  expect(asked.run[2].language).toBe('CPP');
});

test('the frame the programs run in is shut off from the site', async ({ page }) => {
  await openPracticeProblem(page);
  await write(page, EVEN_OR_ODD);
  await runSamples(page);
  await expect(page.getByText('2 of 2 tests passed')).toBeVisible();

  // Opened by itself, with the session cookie of the student in the browser: the server's headers
  // alone give the document an origin of its own and no network.
  const response = await page.goto('/pyrunner/frame.html');
  const policy = response.headers()['content-security-policy'];
  expect(policy).toContain('sandbox allow-scripts');
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("default-src 'none'");
  const inside = await page.evaluate(async () => {
    const attempt = async (what) => {
      try {
        return `allowed: ${String(await what()).slice(0, 40)}`;
      } catch (error) {
        return `refused: ${error.name}`;
      }
    };
    return {
      origin: window.origin,
      cookies: await attempt(() => document.cookie),
      storage: await attempt(() => window.localStorage.length),
      api: await attempt(async () => (await fetch('/api/auth/me', { credentials: 'include' })).status),
      elsewhere: await attempt(async () => (await fetch('https://example.com/', { mode: 'no-cors' })).type),
    };
  });
  expect(inside).toEqual({ origin: 'null', cookies: 'refused: SecurityError', storage: 'refused: SecurityError', api: 'refused: TypeError', elsewhere: 'refused: TypeError' });
});

test('an administrator can keep every program on the server', async ({ page, baseURL }) => {
  const admin = await apiAs('admin', baseURL);
  try {
    await signIn(page, 'admin');
    await page.goto('/admin/settings');
    const setting = page.getByRole('switch', { name: 'Try Python programs in the student’s browser' });
    await expect(setting).toHaveAttribute('aria-checked', 'true');
    await expect(setting).toHaveAccessibleName(/use nothing of the code runner’s allowance/);
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Save 1 change' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await expect.poll(async () => (await admin.get('/programming/status')).inBrowser).toEqual([]);

    // Without a code runner on the demo site, nothing can be run then.
    await page.goto('/programming');
    await page.getByRole('link', { name: 'Even or odd' }).click();
    await expect(page.getByText('Code is not run automatically on this server')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run sample tests' })).toBeDisabled();
  } finally {
    await admin.patch('/admin/settings', { values: { 'programming.runPythonInBrowser': true } });
    await admin.dispose();
  }
});
