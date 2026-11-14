// Strict rules in quizzes and examinations: a violation ends the attempt as failed, and the
// teacher can reopen it. See docs/QUIZ-RULES.md.
//
// A test browser cannot really be switched to another tab or lose its window, so those two are
// brought about the way the page sees them: the document reports itself hidden (or without the
// focus) and the browser's own event is sent. Everything else is done for real: keys, the
// clipboard, reloading, the Back button, a second browser, the file chooser, Python in the page.
import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, unique, watchForProblems } from '../helpers.js';

const MC = { type: 'MULTIPLE_CHOICE', points: 2, text: '<p>How many bits are in one byte?</p>', choices: [{ text: 'Four' }, { text: 'Eight', isCorrect: true }, { text: 'Sixteen' }] };
const ESSAY = { type: 'ESSAY', points: 5, text: '<p>Explain what an algorithm is.</p>' };

let teacher;
let cls;
const made = [];

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
});
test.afterAll(async () => {
  for (const id of made) await teacher.delete(`/quizzes/${id}`).catch(() => {});
  await teacher?.dispose();
});

async function makeQuiz(label, questions, settings = {}) {
  const quiz = await teacher.post(`/classes/${cls.id}/quizzes`, { title: unique(label), resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', ...settings });
  made.push(quiz.id);
  for (const question of questions) await teacher.post(`/quizzes/${quiz.id}/questions`, { question });
  return teacher.patch(`/quizzes/${quiz.id}`, { status: 'PUBLISHED' });
}

/** Read the rules, agree, and land on the first question. */
async function startStrict(page, quiz) {
  await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
  await page.getByRole('button', { name: /^(Start|Try again)$/ }).click();
  const rules = page.getByRole('dialog');
  await expect(rules.getByRole('heading', { name: /^Before you start the/ })).toBeVisible();
  await rules.getByRole('button', { name: 'I understand, start' }).click();
  await expect(page).toHaveURL(/\/attempt\//);
  await expect(page.getByTestId('strict-rules')).toBeVisible();
  return page.url().split('/attempt/')[1].split(/[?#]/)[0];
}

/** What the page sees when the student switches to another tab or app. */
const leaveTab = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const comeBack = (page) => page.evaluate(() => {
  delete document.visibilityState;
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
});
/** The row of the one student who took this quiz, as the teacher's results list it. */
const attemptOf = async (quiz) => (await teacher.get(`/quizzes/${quiz.id}/results`)).students.find((row) => row.attempts.length > 0);
/** Questions may be shuffled, and a continued attempt opens on the first question without an answer. */
async function showChoices(page) {
  await expect(page.getByText(/^Question \d/).first()).toBeVisible();
  if (await page.getByLabel('Eight').isVisible().catch(() => false)) return;
  const next = page.getByRole('button', { name: /^Next/ }).first();
  await ((await next.isVisible().catch(() => false)) ? next : page.getByRole('button', { name: /^Previous/ }).first()).click();
  await expect(page.getByLabel('Eight')).toBeVisible();
}

test.describe('an attempt under strict rules', () => {
  test.describe.configure({ mode: 'serial' });
  let quiz;
  let attemptId;

  test('the student reads the rules before starting, and leaving the page ends the attempt', async ({ page }) => {
    quiz = await makeQuiz('Strict quiz', [MC, ESSAY], { timeLimitMinutes: 30 });
    expect(quiz).toMatchObject({ strictMode: true, violationWarnings: 0 });
    const problems = watchForProblems(page);
    await signIn(page, 'student');
    await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
    await expect(page.getByRole('heading', { name: 'Rules of this quiz' })).toBeVisible();
    await expect(page.getByText('The first violation ends your attempt at once.').first()).toBeVisible();

    attemptId = await startStrict(page, quiz);
    await showChoices(page);
    await page.getByLabel('Eight').check();
    await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();

    // The text of the quiz cannot be selected, and the right-click menu is off.
    expect(await page.getByText('How many bits are in one byte?').evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');

    await leaveTab(page);
    await comeBack(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Your attempt was ended' })).toBeVisible();
    await expect(page.getByText('switched to another tab or app')).toBeVisible();
    await expect(page.getByText(/failed, with 0 points/)).toBeVisible();
    await expect(page.getByLabel('Eight')).toHaveCount(0);

    // The quiz page says the same, and there is no way into another attempt.
    await page.getByRole('link', { name: 'Back to the quiz' }).first().click();
    await expect(page.getByText('Your attempt was ended').first()).toBeVisible();
    await expect(page.getByText(/Only your teacher can reopen it\./).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Start|Resume|Try again|Continue)$/ })).toHaveCount(0);
    await expect(page.getByText('Failed: the attempt was ended for a rule violation')).toBeVisible();

    const row = await attemptOf(quiz);
    expect(row).toMatchObject({ status: 'TERMINATED', score: 0 });
    expect(row.attempts[0].terminated.kind).toBe('LEFT_PAGE');
    expect(problems).toEqual([]);
  });

  test('the teacher sees what happened and reopens the attempt', async ({ page }) => {
    await signIn(page, 'teacher');
    await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}/results`);
    await expect(page.getByText('1 attempt ended for a rule violation')).toBeVisible();
    await page.getByRole('button', { name: 'Juan Dela Cruz' }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'attempt 1' });
    await expect(dialog.getByText('Ended for a rule violation: Juan Dela Cruz switched to another tab or app.')).toBeVisible();
    await expect(dialog.getByText(/Violation 1: switched to another tab or app\. The attempt was ended\./)).toBeVisible();
    await expect(dialog.getByText(/Came back to the quiz after/)).toBeVisible();
    // The answer given before the violation is kept, without a mark.
    await expect(dialog.getByText('Not marked').first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Reopen the attempt' }).click();
    const reopen = page.getByRole('dialog').filter({ hasText: 'Reopen this attempt' });
    await expect(reopen.getByText(/Empty = the time that was left: (29|30) minutes/)).toBeVisible();
    await reopen.getByLabel(/^Note/).fill('The projector software took the focus.');
    await reopen.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(page.getByText(/Attempt reopened\. Juan Dela Cruz has been notified\./)).toBeVisible();
    await expect(dialog.getByText(/Reopened, not continued yet/)).toBeVisible();

    const row = await attemptOf(quiz);
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.attempts[0].reopened.waiting).toBe(true);
  });

  test('the student continues with the answers already given, and submits', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
    await expect(page.getByText('Your teacher reopened your attempt')).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const rules = page.getByRole('dialog');
    await expect(rules.getByRole('heading', { name: 'Continue the quiz' })).toBeVisible();
    await rules.getByRole('button', { name: 'I understand, continue' }).click();
    await expect(page).toHaveURL(new RegExp(`/attempt/${attemptId}`));
    await expect(page.getByTestId('strict-rules')).toBeVisible();

    // It opens on the question that has no answer yet; the earlier answer is still there.
    await expect(page.getByText('Explain what an algorithm is.')).toBeVisible();
    await page.getByRole('textbox').first().fill('A finite list of steps that solves a problem.');
    await showChoices(page);
    await expect(page.getByLabel('Eight')).toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();

    await page.getByRole('button', { name: /Finish and submit|^Submit$/ }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your answers were submitted' })).toBeVisible();

    // Handed in like any other attempt: the essay waits for the teacher, nothing stands as failed.
    const row = await attemptOf(quiz);
    expect(row.status).toBe('NEEDS_GRADING');
    expect(row.attempts[0].terminated).toBeNull();
    // After submitting, the Back button is the student's again.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/attempt\//);
  });
});

test.describe('what counts and what does not', () => {
  test('pasting from outside draws the warning the quiz allows, a screenshot key then ends the attempt', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const quiz = await makeQuiz('Strict essay', [ESSAY], { violationWarnings: 1 });
    await signIn(page, 'student2');
    await startStrict(page, quiz);
    await expect(page.getByText('You get 1 warning. The violation after it ends your attempt.')).toBeVisible();

    // Their own words may be cut, copied and pasted.
    const answer = page.getByRole('textbox').first();
    await answer.click();
    await answer.pressSequentially('An algorithm is a finite list of steps.');
    await answer.press('ControlOrMeta+a');
    await answer.press('ControlOrMeta+x');
    await expect(answer).toHaveValue('');
    await answer.press('ControlOrMeta+v');
    await expect(answer).toHaveValue('An algorithm is a finite list of steps.');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Text from somewhere else is refused, and counted.
    await page.evaluate(() => navigator.clipboard.writeText('An algorithm, according to an encyclopedia, is …'));
    await answer.press('ControlOrMeta+v');
    const warning = page.getByRole('dialog');
    await expect(warning.getByRole('heading', { name: 'Warning 1 of 1' })).toBeVisible();
    await expect(warning.getByText('pasted text that was not written in the quiz')).toBeVisible();
    await expect(warning.getByText('You have no warnings left: the next violation ends your attempt at once.')).toBeVisible();
    await warning.getByRole('button', { name: 'I understand' }).click();
    await expect(answer).toHaveValue('An algorithm is a finite list of steps.');

    // Things the page stops without holding them against the student.
    await page.keyboard.press('F5');
    await expect(page.getByText('Reloading is switched off during this quiz: it would end your attempt.')).toBeVisible();
    await expect(page).toHaveURL(/\/attempt\//);
    await page.goBack();
    await expect(page.getByText(/The Back button is switched off during this quiz/)).toBeVisible();
    await expect(page).toHaveURL(/\/attempt\//);
    await expect(answer).toHaveValue('An algorithm is a finite list of steps.');

    await page.keyboard.press('PrintScreen');
    await expect(page.getByRole('heading', { level: 1, name: 'Your attempt was ended' })).toBeVisible();
    await expect(page.getByText('pressed a screenshot key')).toBeVisible();

    const row = await attemptOf(quiz);
    expect(row.status).toBe('TERMINATED');
    // What had been typed was saved before the attempt was closed.
    const view = await teacher.get(`/attempts/${row.attempts[0].id}`);
    expect(view.questions[0].response).toMatchObject({ text: 'An algorithm is a finite list of steps.' });
    expect(view.events.filter((e) => e.type === 'VIOLATION').map((e) => [e.meta.kind, e.meta.outcome])).toEqual([['PASTE', 'WARNING'], ['SCREENSHOT', 'TERMINATED']]);
  });

  test('reloading the page ends the attempt, and so does opening it in a second browser', async ({ page, browser }) => {
    const quiz = await makeQuiz('Strict reload', [MC]);
    await signIn(page, 'student');
    await startStrict(page, quiz);
    await page.getByLabel('Eight').check();
    // The browser asks before it lets the page go; the student insists.
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Your attempt was ended' })).toBeVisible();
    await expect(page.getByText('closed, reloaded or left the quiz page')).toBeVisible();

    // A page that vanished without a word (a browser that was killed, a dead battery) is
    // recognised when the attempt is opened anew — here from a second browser.
    const second = await makeQuiz('Strict second browser', [MC], { violationWarnings: 1 });
    const attemptId = await startStrict(page, second);
    const other = await browser.newContext();
    const elsewhere = await other.newPage();
    await signIn(elsewhere, 'student');
    await elsewhere.goto(`/classes/${cls.id}/quizzes/${second.id}/attempt/${attemptId}`);
    const warning = elsewhere.getByRole('dialog');
    await expect(warning.getByRole('heading', { name: 'Warning 1 of 1' })).toBeVisible();
    await expect(warning.getByText('closed, reloaded or left the quiz page')).toBeVisible();
    await other.close();
    const view = await teacher.get(`/attempts/${attemptId}`);
    expect(view.events.find((e) => e.type === 'VIOLATION').meta).toMatchObject({ kind: 'CLOSED_PAGE', outcome: 'WARNING', detail: expect.stringContaining('opened again') });
  });

  test('going to another page of the site is leaving, and coming back shows what was counted', async ({ page }) => {
    const quiz = await makeQuiz('Strict wander', [MC], { violationWarnings: 1 });
    await signIn(page, 'student');
    const attemptId = await startStrict(page, quiz);
    await page.getByLabel('Eight').check();
    await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();

    // The Back button is held, but the browser's history list still leads out: two steps back
    // is the page of the quiz, inside the site.
    await page.evaluate(() => window.history.go(-2));
    await expect(page).toHaveURL(new RegExp(`/quizzes/${quiz.id}$`));
    await expect(page.getByText('You have an attempt in progress.')).toBeVisible();
    await expect.poll(async () => (await teacher.get(`/attempts/${attemptId}`)).violationCount).toBe(1);

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page).toHaveURL(/\/attempt\//);
    const warning = page.getByRole('dialog');
    await expect(warning.getByRole('heading', { name: 'Warning 1 of 1' })).toBeVisible();
    await expect(warning.getByText('closed, reloaded or left the quiz page')).toBeVisible();
    await warning.getByRole('button', { name: 'I understand' }).click();
    await expect(page.getByLabel('Eight')).toBeChecked();
    await expect(page.getByTestId('strict-rules')).toContainText('You have no warnings left');

    const view = await teacher.get(`/attempts/${attemptId}`);
    expect(view.status).toBe('IN_PROGRESS');
    expect(view.events.filter((e) => e.type === 'VIOLATION').map((e) => e.meta)).toEqual([expect.objectContaining({ kind: 'CLOSED_PAGE', outcome: 'WARNING', detail: 'went to another page of the app' })]);
    // The server saw the student come back: a page lost from here on is a new story.
    expect(view.events.map((e) => e.type)).toContain('PAGE_REOPENED');
  });

  test('choosing a file for a file-upload question is not leaving', async ({ page }) => {
    const quiz = await makeQuiz('Strict upload', [{ type: 'FILE_UPLOAD', points: 5, text: '<p>Upload your flowchart.</p>' }]);
    await signIn(page, 'student');
    const attemptId = await startStrict(page, quiz);

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload your answer' }).click();
    const files = await chooser;
    // The system's file chooser has the focus for as long as it is open.
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(2500);
    await files.setFiles({ name: 'flowchart.txt', mimeType: 'text/plain', buffer: Buffer.from('start -> read n -> end\n') });
    await page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByText('flowchart.txt')).toBeVisible();
    await expect(page.getByTestId('strict-rules')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Noted for the teacher, with how long it was open; nothing is counted.
    await expect.poll(async () => (await teacher.get(`/attempts/${attemptId}`)).events.map((e) => e.type)).toContain('FILE_DIALOG');
    const view = await teacher.get(`/attempts/${attemptId}`);
    expect(view).toMatchObject({ status: 'IN_PROGRESS', violationCount: 0 });
    expect(view.events.find((e) => e.type === 'FILE_DIALOG').meta.awayMs).toBeGreaterThan(2000);

    // Without the file chooser, the same loss of focus is a violation.
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Your attempt was ended' })).toBeVisible();
  });

  test('a programming question: the student’s own code is copied, pasted and run; code from elsewhere is counted', async ({ page, context }) => {
    test.setTimeout(150_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const problem = (await teacher.get('/programming/problems')).find((p) => p.title === 'Even or odd');
    const quiz = await makeQuiz('Strict program', [{ type: 'PROGRAMMING', points: 10, text: '<p>Say whether the number is even or odd.</p>', programmingProblemId: problem.id }], { violationWarnings: 1 });
    await signIn(page, 'student2');
    const attemptId = await startStrict(page, quiz);

    const editor = page.getByRole('textbox', { name: 'Your code' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText('n = int(input())\nprint("EVEN" if n % 2 == 0 else "ODD")\n');
    // Cut everything and put it back: the editor fills the clipboard itself, and it is still the student's own.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+X');
    await expect(editor).not.toContainText('input');
    await page.keyboard.press('ControlOrMeta+V');
    await expect(editor).toContainText('n = int(input())');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Python runs in a hidden frame of the page. That is not leaving it.
    const run = page.getByRole('button', { name: 'Run sample tests' });
    await run.click();
    await expect(run).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
    await page.waitForTimeout(2500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await teacher.get(`/attempts/${attemptId}`)).violationCount).toBe(0);

    // A program from somewhere else is kept out, and counted.
    await page.evaluate(() => navigator.clipboard.writeText('print("copied from a website")'));
    await editor.click();
    await page.keyboard.press('ControlOrMeta+V');
    const warning = page.getByRole('dialog');
    await expect(warning.getByRole('heading', { name: 'Warning 1 of 1' })).toBeVisible();
    await expect(warning.getByText('pasted text that was not written in the quiz')).toBeVisible();
    await warning.getByRole('button', { name: 'I understand' }).click();
    await expect(editor).not.toContainText('copied from a website');
    await expect(editor).toContainText('n = int(input())');
  });

  test.describe('when the code editor cannot be downloaded', () => {
    // The built site has a service worker that would fetch the editor behind the test's back.
    test.use({ serviceWorkers: 'block' });

    test('a programming question is answered in a plain text box, without a reload', async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      // The connection drops at the wrong moment, or a new version of the app was installed
      // meanwhile. The cure used to be "reload the page", which under these rules ends the attempt.
      await page.route(/\/CodeEditor[^/]*\.jsx?(\?.*)?$/, (route) => route.abort());
      const problem = (await teacher.get('/programming/problems')).find((p) => p.title === 'Even or odd');
      const quiz = await makeQuiz('Strict program plain', [{ type: 'PROGRAMMING', points: 10, text: '<p>Say whether the number is even or odd.</p>', programmingProblemId: problem.id }]);
      await signIn(page, 'student');
      const attemptId = await startStrict(page, quiz);

      await expect(page.getByText('The code editor could not be downloaded, so this is a plain text box.')).toBeVisible();
      const editor = page.getByRole('textbox', { name: 'Your code' });
      await editor.fill('n = int(input())\nprint("EVEN" if n % 2 == 0 else "ODD")\n');
      const run = page.getByRole('button', { name: 'Run sample tests' });
      await run.click();
      await expect(run).toBeEnabled({ timeout: 60_000 });
      await expect(page.getByText('2 of 2 tests passed')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /saved/i }).first()).toBeVisible();

      // Nothing was counted, the page was never reloaded, and the program is with the server.
      await expect(page.getByTestId('strict-rules')).toBeVisible();
      expect(await teacher.get(`/attempts/${attemptId}`)).toMatchObject({ status: 'IN_PROGRESS', violationCount: 0 });
      const student = await apiAs('student', baseURL);
      try {
        const saved = (await student.get(`/attempts/${attemptId}`)).questions[0].response;
        expect(saved).toMatchObject({ language: 'PYTHON', code: expect.stringContaining('n = int(input())') });
      } finally {
        await student.dispose();
      }
    });
  });

  test('a quiz without strict rules is taken as before', async ({ page }) => {
    const quiz = await makeQuiz('Relaxed quiz', [MC], { strictMode: false });
    await signIn(page, 'student');
    await page.goto(`/classes/${cls.id}/quizzes/${quiz.id}`);
    await expect(page.getByRole('heading', { name: /^Rules of this/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(/\/attempt\//);
    await expect(page.getByTestId('strict-rules')).toHaveCount(0);
    await leaveTab(page);
    await comeBack(page);
    await page.getByLabel('Eight').check();
    await page.getByRole('button', { name: /Finish and submit|^Submit$/ }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your answers were submitted' })).toBeVisible();
    expect((await attemptOf(quiz)).status).toBe('GRADED');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the rules are on the screen while answering, and clicking outside the window ends the attempt', async ({ page }) => {
    const quiz = await makeQuiz('Strict phone', [MC]);
    await signIn(page, 'student');
    await startStrict(page, quiz);
    const banner = page.getByTestId('strict-rules');
    await expect(banner).toBeInViewport();
    await expect(banner).toContainText('The first violation ends your attempt at once.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The window loses the focus while the page stays on screen (a pop-up, a second window).
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await expect(page.getByRole('heading', { level: 1, name: /Your attempt (was|has been) ended/ })).toBeVisible();
    await expect(page.getByText('clicked outside the quiz window')).toBeVisible();
    await expect.poll(async () => (await attemptOf(quiz)).status).toBe('TERMINATED');
  });
});

test('the teacher chooses the rules when setting up a quiz', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto(`/classes/${cls.id}/quizzes`);
  await page.getByRole('button', { name: /New quiz/ }).first().click();
  const dialog = page.getByRole('dialog');
  const rules = dialog.getByRole('switch', { name: 'Strict rules while answering' });
  await expect(rules).toBeChecked();
  await expect(dialog.getByLabel('Warnings before an attempt is ended')).toHaveValue('0');
  // Practice quizzes start without them; the teacher can still switch them on.
  await dialog.getByLabel('Kind').selectOption('PRACTICE');
  await expect(rules).not.toBeChecked();
  await rules.click();
  await expect(rules).toBeChecked();
  await dialog.getByLabel('Warnings before an attempt is ended').selectOption('2');

  const title = unique('Practice with rules');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create and add questions' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('On · 2 warnings, then the attempt ends')).toBeVisible();
  const created = (await teacher.get(`/classes/${cls.id}/quizzes`)).find((q) => q.title === title);
  made.push(created.id);
  expect(created).toMatchObject({ kind: 'PRACTICE', strictMode: true, violationWarnings: 2 });
});
