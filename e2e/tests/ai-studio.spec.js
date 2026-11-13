// The teacher's assistant, seen from the web app: an examination and an assignment drafted from
// a module the teacher chose, what becomes of the drafts, what a teacher is told when the AI
// service refuses, and the administrator's "Check now".
//
// The demo site has no AI service, so the AI's part is played here: the answers to "draft
// questions", "draft an assignment" and "check the AI service" are written by the test in the
// shapes the API uses (backend/tests/api/programming-ai.test.js and ai-gateway.test.js check
// those, and what the model is asked). Everything else is real: the modules to choose from, the
// question bank, the quiz and the assignment.
import { expect, test } from '@playwright/test';
import { apiAs, signIn, unique } from '../helpers.js';

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const QUESTIONS = [
  { type: 'MULTIPLE_CHOICE', text: 'Which part of a computer carries out instructions?', points: 1, difficulty: 'EASY', topic: 'Hardware', explanation: 'The processor fetches and executes instructions.', choices: [{ text: 'The processor', isCorrect: true }, { text: 'The monitor', isCorrect: false }, { text: 'The keyboard', isCorrect: false }, { text: 'The power supply', isCorrect: false }] },
  { type: 'TRUE_FALSE', text: 'What is in main memory is kept when the computer is switched off.', points: 1, difficulty: 'MEDIUM', topic: 'Memory', answer: false },
  { type: 'IDENTIFICATION', text: 'What is the program called that manages the hardware for all other programs?', points: 2, difficulty: 'MEDIUM', topic: 'Software', accepted: ['operating system', 'OS'] },
];

/** A site with an AI service: the status says so, and the test answers in the model's place. */
async function withAssistant(page, answers) {
  const asked = { questions: [], assignment: [] };
  await page.route('**/api/ai/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.data, { configured: true, model: 'test-model', message: null });
    return route.fulfill({ response, json: body });
  });
  await page.route('**/api/ai/questions', (route) => {
    asked.questions.push(route.request().postDataJSON());
    return route.fulfill(json(200, { data: answers.questions(asked.questions.length) }));
  });
  await page.route('**/api/ai/assignment', (route) => {
    asked.assignment.push(route.request().postDataJSON());
    return route.fulfill(json(200, { data: answers.assignment() }));
  });
  return asked;
}

/** A module of the demo teacher that has lessons, with its class. */
async function aModule(teacher) {
  const material = await teacher.get('/ai/material');
  const cls = material.find((c) => c.modules.some((m) => m.lessonCount > 0));
  if (!cls) throw new Error('The demo teacher has no module with lessons. Run "npm run db:seed".');
  return { cls, module: cls.modules.find((m) => m.lessonCount > 0) };
}

test('a teacher drafts an examination from a module and gets a draft quiz of the questions', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  const banksBefore = new Set((await teacher.get('/question-banks')).map((bank) => bank.id));
  let quizId = null;
  try {
    const { cls, module } = await aModule(teacher);
    const source = { moduleId: module.id, moduleTitle: module.title, classId: cls.id, lessonCount: module.lessonCount + 1, usedLessons: module.lessonCount, shortened: true };
    const asked = await withAssistant(page, {
      questions: (round) => ({ questions: round === 1 ? QUESTIONS.slice(0, 2) : QUESTIONS.slice(2), rejected: round === 1 ? 1 : 0, skipped: 0, source, needsReview: true }),
    });

    await signIn(page, 'teacher');
    await page.goto('/ai');
    await page.getByRole('tab', { name: 'Quiz or exam' }).click();
    // The teacher's own modules, class by class.
    await page.getByLabel('Based on').selectOption(module.id);
    await page.getByLabel('For').selectOption('EXAM');
    await expect(page.getByLabel('Source text')).toHaveCount(0);
    await page.getByRole('button', { name: 'Draft questions' }).click();

    await expect(page.getByText('2 draft questions to review')).toBeVisible();
    // What the draft was made from, and what was left out, is said.
    const note = page.getByText(`Drafted from “${module.title}”`);
    await expect(note).toContainText('1 lesson without text could not be used.');
    await expect(note).toContainText('its lessons were shortened to fit');
    await expect(note).toContainText('Some questions from the AI were left out: 1 incomplete.');
    expect(asked.questions[0]).toMatchObject({ moduleId: module.id, purpose: 'EXAM', avoid: [], types: ['MULTIPLE_CHOICE', 'TRUE_FALSE'] });
    expect(asked.questions[0].sourceText).toBeUndefined();

    // Another round adds to the list and tells the model what is there already.
    await page.getByRole('button', { name: 'Draft more questions' }).click();
    await expect(page.getByText('3 draft questions to review')).toBeVisible();
    expect(asked.questions[1].avoid).toEqual([QUESTIONS[0].text, QUESTIONS[1].text]);

    // The teacher decides what is kept…
    await page.getByLabel('Keep question 2').uncheck();
    const title = unique('Examination from a module');
    await page.getByLabel('Title').fill(title);
    await expect(page.getByLabel('In the class')).toHaveValue(cls.id);
    await expect(page.getByText('Make a draft examination of the 2 selected questions')).toBeVisible();
    await page.getByRole('button', { name: 'Create the examination' }).click();

    // …and lands on an ordinary quiz, still a draft, that belongs to the module.
    await expect(page).toHaveURL(/\/classes\/[^/]+\/quizzes\/[^/]+$/);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    quizId = new URL(page.url()).pathname.split('/').pop();
    const quiz = await teacher.get(`/quizzes/${quizId}`);
    expect(quiz).toMatchObject({ title, kind: 'EXAM', status: 'DRAFT', module: { id: module.id } });
    expect(quiz.questions.map((q) => [q.type, q.points])).toEqual([['MULTIPLE_CHOICE', 1], ['IDENTIFICATION', 2]]);
  } finally {
    if (quizId) await teacher.delete(`/quizzes/${quizId}`).catch(() => {});
    // The bank that was made for the questions.
    for (const bank of await teacher.get('/question-banks')) {
      if (!banksBefore.has(bank.id)) await teacher.delete(`/question-banks/${bank.id}`).catch(() => {});
    }
    await teacher.dispose();
  }
});

test('a teacher drafts an assignment from a module and saves it into that module', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  let saved = null;
  try {
    const { cls, module } = await aModule(teacher);
    const title = unique('Assignment from a module');
    const asked = await withAssistant(page, {
      assignment: () => ({ title, instructionsHtml: '<p>Describe, in your own words, what happens between pressing a key and seeing the letter.</p>', points: 40, rubric: null, source: { moduleId: module.id, moduleTitle: module.title, classId: cls.id, lessonCount: module.lessonCount, usedLessons: module.lessonCount, shortened: false }, needsReview: true }),
    });

    await signIn(page, 'teacher');
    await page.goto('/ai?tool=assignment');
    const draftButton = page.getByRole('button', { name: 'Draft assignment' });
    await expect(draftButton).toBeDisabled(); // neither a module nor a topic yet
    await page.getByLabel('Based on').selectOption(module.id);
    await page.getByLabel('Points').fill('40');
    await page.getByLabel('Also draft a rubric').uncheck();
    await draftButton.click();

    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText(`Drafted from “${module.title}” (${module.lessonCount} lesson${module.lessonCount === 1 ? '' : 's'}).`)).toBeVisible();
    expect(asked.assignment).toEqual([{ moduleId: module.id, points: 40, withRubric: false }]);
    // The module's class is suggested for saving it.
    await expect(page.getByLabel('Save as a draft assignment in')).toHaveValue(cls.id);
    await page.getByRole('button', { name: 'Save draft' }).click();

    await expect(page).toHaveURL(/\/classes\/[^/]+\/assignments\/[^/]+$/);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    saved = new URL(page.url()).pathname.split('/').pop();
    expect(await teacher.get(`/assignments/${saved}`)).toMatchObject({ title, status: 'DRAFT', points: 40, module: { id: module.id } });
  } finally {
    if (saved) await teacher.delete(`/assignments/${saved}`).catch(() => {});
    await teacher.dispose();
  }
});

test('without an AI service the page says so and drafts nothing', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto('/ai?tool=questions');
  await expect(page.getByText('AI assistance is not set up on this server')).toBeVisible();
  // The teacher's modules can be looked at all the same; the button stays off.
  await expect(page.getByLabel('Based on')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Draft questions' })).toBeDisabled();
});

test('a teacher is told what to do when the AI service refuses, and nothing is lost', async ({ page, baseURL }) => {
  const teacher = await apiAs('teacher', baseURL);
  try {
    const { cls, module } = await aModule(teacher);
    // In turn: an account that needs an administrator, a service that is busy, a module without text, and then an answer.
    const refusals = [
      json(503, { error: { code: 'AI_NEEDS_ATTENTION', message: 'The AI service did not accept the request, and trying again will not help. An administrator can see the reason under Administration → Settings.' } }),
      json(503, { error: { code: 'AI_BUSY', message: 'The AI service has too many requests right now. Wait a minute, then try again.', details: { retryAfterSeconds: 30 } } }),
      json(422, { error: { code: 'MODULE_HAS_NO_TEXT', message: 'This module has no written lessons yet, so there is nothing to draw from. Add a lesson with text, or give a topic instead.', details: { fields: { moduleId: 'This module has no written lessons yet.' } } } }),
    ];
    let asked = 0;
    await page.route('**/api/ai/status', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.data, { configured: true, model: 'test-model', message: null });
      return route.fulfill({ response, json: body });
    });
    await page.route('**/api/ai/questions', (route) => {
      asked += 1;
      return route.fulfill(refusals.shift() ?? json(200, { data: { questions: QUESTIONS.slice(0, 1), rejected: 0, skipped: 0, source: { moduleId: module.id, moduleTitle: module.title, classId: cls.id, lessonCount: module.lessonCount, usedLessons: module.lessonCount, shortened: false }, needsReview: true } }));
    });

    await signIn(page, 'teacher');
    await page.goto('/ai?tool=questions');
    await page.getByLabel('Based on').selectOption(module.id);
    const draft = page.getByRole('button', { name: 'Draft questions' });

    await draft.click();
    await expect(page.getByText('The AI service did not accept the request, and trying again will not help. An administrator can see the reason under Administration → Settings.')).toBeVisible();
    // The page does not ask again by itself, and what the teacher chose is still there.
    await expect(draft).toBeEnabled();
    await expect(page.getByLabel('Based on')).toHaveValue(module.id);
    expect(asked).toBe(1);

    await draft.click();
    await expect(page.getByText('The AI service has too many requests right now. Wait a minute, then try again.')).toBeVisible();
    await expect(page.getByText('trying again will not help')).toHaveCount(0); // the earlier message is gone
    expect(asked).toBe(2);

    await draft.click();
    await expect(page.getByText('This module has no written lessons yet, so there is nothing to draw from. Add a lesson with text, or give a topic instead.')).toBeVisible();

    await draft.click();
    await expect(page.getByText('1 draft question to review')).toBeVisible();
    await expect(page.getByText('This module has no written lessons yet')).toHaveCount(0);
    expect(asked).toBe(4);
  } finally {
    await teacher.dispose();
  }
});

test('the administrator can check the AI service and sees the answer, or the reason and where to fix it', async ({ page }) => {
  const CARD = 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card';
  const refused = { kind: 'verification', message: 'Vercel wants a payment method on the account before its free credit can be used.', detail: 'HTTP 403 customer_verification_required: AI Gateway requires a valid credit card on file to service requests.', link: CARD };
  await page.route('**/api/admin/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // A site on Vercel whose assistant asks the AI Gateway; a teacher's request failed a minute ago.
    body.data.ai = { configured: true, provider: 'vercel-ai-gateway', model: 'meta/muse-ember', askedWith: 'project identity', lastSuccessAt: null, lastFailureAt: new Date(Date.now() - 60_000).toISOString(), lastFailure: refused };
    return route.fulfill({ response, json: body });
  });
  const about = { provider: 'vercel-ai-gateway', model: 'meta/muse-ember', askedWith: 'project identity' };
  const answers = [
    json(200, { data: { ok: false, ...about, failure: refused } }),
    // A service that names a page somewhere else: its words are shown, its link is not.
    json(200, { data: { ok: false, ...about, failure: { kind: 'verification', message: 'The AI service wants the account verified.', detail: 'HTTP 403: verify at https://vercel.com.pay.example/now', link: 'https://vercel.com.pay.example/now' } } }),
    json(200, { data: { ok: false, ...about, failure: { kind: 'credit', message: 'The credit for the AI service is used up.', detail: 'HTTP 402 insufficient_funds: Insufficient funds', link: null } } }),
    json(200, { data: { ok: true, ...about, model: 'meta/muse-ember-1109', ms: 1840, answer: 'Which gas do plants take in?' } }),
    json(403, { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' } }),
  ];
  let checks = 0;
  await page.route('**/api/admin/ai/check', (route) => {
    checks += 1;
    return route.fulfill(answers.shift());
  });

  await signIn(page, 'admin');
  await page.goto('/admin/settings');
  const assistant = page.getByRole('listitem').filter({ hasText: 'AI assistant for teachers' });
  await expect(assistant).toContainText('Vercel AI Gateway, model meta/muse-ember. Asked with the identity of this site’s Vercel project; no key is stored.');

  // Before any check: what teachers ran into last.
  await expect(assistant.getByText('The last request of a teacher failed:')).toBeVisible();
  await expect(assistant.getByText(refused.message)).toBeVisible();
  const link = assistant.getByRole('link', { name: 'Open the page on vercel.com' });
  await expect(link).toHaveAttribute('href', CARD);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(checks).toBe(0); // looking at the page asks the service nothing

  const check = assistant.getByRole('button', { name: 'Check now' });
  await check.click();
  await expect(assistant.getByText(refused.detail)).toBeVisible();
  await expect(assistant.getByText('The last request of a teacher failed:')).toHaveCount(0);
  await expect(link).toHaveAttribute('href', CARD);

  await check.click();
  await expect(assistant.getByText('The AI service wants the account verified.')).toBeVisible();
  await expect(assistant.getByText('HTTP 403: verify at https://vercel.com.pay.example/now')).toBeVisible();
  await expect(assistant.getByRole('link')).toHaveCount(0);

  await check.click();
  await expect(assistant.getByText('The credit for the AI service is used up.')).toBeVisible();
  await expect(assistant.getByText('HTTP 402 insufficient_funds: Insufficient funds')).toBeVisible();
  await expect(assistant.getByRole('link')).toHaveCount(0);

  await check.click();
  await expect(assistant.getByText('The AI service answers.')).toBeVisible();
  await expect(assistant.getByText('1.8 s')).toBeVisible();
  await expect(assistant).toContainText('Model meta/muse-ember-1109. Its answer began: “Which gas do plants take in?”');
  await expect(assistant.getByText('The credit for the AI service is used up.')).toHaveCount(0);

  // The check itself cannot be made: that is said, in place of an old result.
  await check.click();
  await expect(assistant.getByText('You do not have permission to do that.')).toBeVisible();
  await expect(assistant.getByText('The AI service answers.')).toHaveCount(0);
  expect(checks).toBe(5);
});

test('an administrator whose site has no AI service is told so, and is offered no check', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/settings');
  const assistant = page.getByRole('listitem').filter({ hasText: 'AI assistant for teachers' });
  await expect(assistant).toContainText('Not set up. The AI studio shows a notice and drafts nothing.');
  await expect(assistant.getByRole('button', { name: 'Check now' })).toHaveCount(0);
});
