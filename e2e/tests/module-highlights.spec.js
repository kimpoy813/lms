import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn, watchForProblems } from '../helpers.js';

// Selects the first few words of a paragraph the way a reader does: press, drag, release.
async function selectWordsInFirstParagraph(page) {
  // A paragraph with real words (the first one may hold only a figure caption or a blank line).
  const paragraph = page.locator('[data-lesson-text] p').filter({ hasText: /\w{4,} \w{4,}/ }).first();
  await paragraph.waitFor();
  await paragraph.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const box = await paragraph.boundingBox();
  // Keep the drag inside the viewport on a short window.
  const y = Math.min(box.y + box.height / 2, page.viewportSize().height - 60);
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(150, box.width - 8), y, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.trim().length, 'the drag selects some words').toBeGreaterThan(2);
  return selected.trim();
}

test('a student highlights words, sees them again later, colours and removes them', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchForProblems(page);
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('student', baseURL);
  // Start from a clean page: any earlier run's marks are removed.
  for (const previous of await api.get('/highlights')) await api.delete(`/highlights/${previous.id}`);

  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));
    const book = await api.get(`/modules/${demoModule.id}/book`);
    const chapter = book.chapters.find((entry) => entry.contentHtml?.includes('<p>'));

    await signIn(page, 'student');
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?lesson=${chapter.id}`);

    const quote = await selectWordsInFirstParagraph(page);
    await page.getByTestId('highlight-toolbar').getByRole('button', { name: 'Highlight' }).click();

    // The words are marked in place, and listed under the lesson.
    const mark = page.locator(`mark[data-reading-highlight]:has-text("${quote}")`).first();
    await expect(mark).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your highlights' }).getByText(`“${quote}”`)).toBeVisible();

    // A note and another colour are kept with it.
    await mark.click();
    await page.getByTestId('highlight-toolbar').getByRole('button', { name: 'Note' }).click();
    await page.getByLabel('Your note').fill('Worth remembering for the quiz');
    await page.getByRole('button', { name: 'Blue highlighter' }).click();
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.locator('mark[data-reading-highlight]').first()).toHaveAttribute('data-highlight-colour', 'blue');

    // It survives a reload: the words are found again in the lesson text.
    await page.reload();
    await expect(page.locator('mark[data-reading-highlight]').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your highlights' })).toContainText('Worth remembering for the quiz');

    // In the book reader the same words are marked on the chapter's page.
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book&chapter=${chapter.id}`);
    await expect(page.locator('mark[data-reading-highlight]').first()).toBeVisible({ timeout: 15_000 });

    // Removing it from the list clears both the mark and the saved highlight.
    await page.getByRole('button', { name: `Remove highlight “${quote}”` }).click();
    await expect(page.locator('mark[data-reading-highlight]')).toHaveCount(0);
    expect(await api.get('/highlights')).toHaveLength(0);
    expect(problems.filter((problem) => !/401|403/.test(problem))).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('the reading settings are a labelled panel that remembers the highlighter colour', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, 'teacher');

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('teacher', baseURL);
  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));

    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book`);
    // Start at the top, so opening the panel cannot be confused with Playwright scrolling to it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.getByTestId('book-reader-settings').locator('summary').click();
    // The panel opens in the flow, above the pages: it never covers the text being read.
    const panelClearsPages = await page.evaluate(() => {
      const panel = document.querySelector('.book-reader-settings-panel').getBoundingClientRect();
      const spread = document.querySelector('[data-testid="book-page-spread"]').getBoundingClientRect();
      return panel.bottom <= spread.top + 1;
    });
    expect(panelClearsPages).toBe(true);

    const settings = page.getByRole('group', { name: 'Reading display options' });
    await expect(settings).toBeVisible();
    for (const group of ['Typeface', 'Text size', 'Pages', 'Highlighter']) {
      await expect(settings.getByText(group, { exact: true })).toBeVisible();
    }
    await settings.getByRole('button', { name: 'Green highlighter' }).click();
    await expect(settings.getByRole('button', { name: 'Green highlighter' })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('discenda.readerPrefs')).highlightColour)).toBe('green');
  } finally {
    await api.dispose();
  }
});
