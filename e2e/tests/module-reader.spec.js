import { expect, test } from '@playwright/test';
import { apiAs, demoClass, signIn } from '../helpers.js';

const PAGE_TEXT = 'A well-designed reading sequence explains each idea clearly, connects it to the next concept, and gives learners enough context to apply it. '.repeat(3);
const WIDE_CELL = 'InterdepartmentalInformationAssuranceControl '.repeat(4);
const REPORTED_SUMMARY_TEXT = 'Every learner should understand how a careful security decision works, connect it to an appropriate control, and apply the result responsibly to information systems. '.repeat(3);
const REPORTED_SUMMARY_OBJECTIVES = [
  'I can recommend appropriate administrative, technical, and physical controls.',
  'I can distinguish authentication from authorization and explain least privilege.',
  'I can explain how defense in depth supports information protection.',
  'I can identify basic secure coding and database management practices.',
  'I can explain why backup verification, monitoring, and recovery planning contribute to information assurance.',
  'I can incorporate security and privacy considerations into a computer science capstone project.',
  'I can demonstrate responsible and ethical behavior when handling information and performing security-related activities.',
];
const REPORTED_SUMMARY_END = `<ul>${REPORTED_SUMMARY_OBJECTIVES.map((objective) => `<li>${objective}</li>`).join('')}</ul><h3>Final Learning Reflection</h3><p>Reflect on a software application that you have developed or frequently use. Identify the information it processes, explain how the CIA triad applies to it, discuss its potential security risks, and recommend improvements that would make it more trustworthy. Consider how your responsibilities as a computer science professional extend beyond delivering functional software.</p>`;

// The visible objectives/reflection come from the supplied screenshot; repeated notes only place
// that excerpt at the reported 155–156 spread because the complete module export is unavailable here.
function reportedSummaryFixtureContent(chapterNumber, paragraphCount) {
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => (
    `<p><strong>Security note ${chapterNumber}-${index + 1}.</strong> ${REPORTED_SUMMARY_TEXT}</p>`
  )).join('');
  return `${paragraphs}${chapterNumber === 9 ? REPORTED_SUMMARY_END : ''}`;
}

function longChapterContent(chapterNumber) {
  const paragraphs = Array.from({ length: 22 }, (_, index) => (
    `<p><strong>Reading note ${index + 1}.</strong> Chapter ${chapterNumber} explores a practical security decision. ${PAGE_TEXT}</p>`
  )).join('');
  const table = chapterNumber === 9
    ? `<table><caption>Security control reference</caption><thead><tr><th>Control area</th><th>Example</th><th>Purpose</th><th>Review cadence</th></tr></thead><tbody><tr><td>${WIDE_CELL}</td><td>${WIDE_CELL}</td><td>${WIDE_CELL}</td><td>${WIDE_CELL}</td></tr></tbody></table>`
    : '';
  return `<h3>Chapter ${chapterNumber} overview</h3>${table}${paragraphs}`;
}

async function visibleSpreadHasTextInBothPages(page) {
  return page.locator('[data-testid="book-page-flow"]').evaluate((flow) => {
    const box = flow.getBoundingClientRect();
    const center = box.left + box.width / 2;
    let left = false;
    let right = false;
    const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);

    while (walker.nextNode() && !(left && right)) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 2 || rect.height < 2
          || rect.bottom <= box.top + 2 || rect.top >= box.bottom - 2
          || rect.right <= box.left + 4 || rect.left >= box.right - 4) continue;
        const textCenter = (rect.left + rect.right) / 2;
        if (textCenter < center - 8) left = true;
        if (textCenter > center + 8) right = true;
        if (left && right) break;
      }
      range.detach?.();
    }
    return { left, right };
  });
}

async function visibleTextOnSpreadSide(page, text, side) {
  return page.locator('[data-testid="book-page-flow"]').evaluate((flow, { needle, targetSide }) => {
    const box = flow.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.includes(needle)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const visibleOnSide = [...range.getClientRects()].some((rect) => {
        if (rect.width < 2 || rect.height < 2
          || rect.bottom <= box.top + 2 || rect.top >= box.bottom - 2
          || rect.right <= box.left + 4 || rect.left >= box.right - 4) return false;
        const center = (rect.left + rect.right) / 2;
        return targetSide === 'left' ? center < middle - 8 : center > middle + 8;
      });
      range.detach?.();
      if (visibleOnSide) return true;
    }
    return false;
  }, { needle: text, targetSide: side });
}

test('two-page book spreads fill both sides, wrap tables, and keep settings out of the text', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, 'teacher');

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('teacher', baseURL);
  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));
    expect(demoModule, 'the demo class includes its first reading module').toBeTruthy();

    const [moduleSummary, book] = await Promise.all([
      api.get(`/modules/${demoModule.id}`),
      api.get(`/modules/${demoModule.id}/book`),
    ]);
    const baseChapter = book.chapters[0];
    const chapters = Array.from({ length: 10 }, (_, index) => {
      const chapterNumber = index + 1;
      return {
        ...baseChapter,
        id: `reader-qa-chapter-${chapterNumber}`,
        moduleId: demoModule.id,
        title: `Reader QA chapter ${chapterNumber}`,
        chapterNumber,
        kind: 'LESSON',
        status: 'PUBLISHED',
        estimatedMinutes: 6,
        objectives: [],
        contentHtml: longChapterContent(chapterNumber),
        resources: [],
        visual: null,
        selfCheck: null,
        completed: false,
        bookmarked: false,
        locked: false,
        lockedReason: null,
      };
    });
    const fixtureSummary = {
      ...moduleSummary,
      title: 'Two-page pagination regression fixture',
      description: 'Long chapters used to verify book spread flow.',
      status: 'PUBLISHED',
      locked: false,
      lessonCount: chapters.length,
      lessons: chapters.map((chapter, index) => ({ ...chapter, position: index })),
      objectives: [],
      resources: [],
    };
    const fixtureBook = {
      ...book,
      ...fixtureSummary,
      chapters,
      totalEstimatedMinutes: chapters.length * 6,
    };

    await page.route(`**/api/modules/${demoModule.id}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: fixtureSummary }),
    }));
    await page.route(`**/api/modules/${demoModule.id}/book`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: fixtureBook }),
    }));

    await page.addInitScript(() => localStorage.setItem('discenda.readerPrefs', JSON.stringify({
      font: 'serif', size: 'md', focus: true, layout: 'two',
    })));
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book&chapter=${chapters[8].id}`);

    const reader = page.locator('[data-book-reader]');
    const spread = page.locator('[data-testid="book-page-spread"]');
    const toolbar = page.getByTestId('book-immersive-toolbar');
    await expect(reader).toBeVisible();
    await expect(reader).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');
    await expect(toolbar).toBeVisible();
    await expect(page.locator(`#chapter-${chapters[8].id}`)).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });

    const settings = page.getByTestId('book-reader-settings');
    await settings.locator('summary').click();
    const settingsPanel = settings.locator('.book-reader-settings-panel');
    await expect(settingsPanel).toBeVisible();
    const settingsDoNotCoverPages = await page.evaluate(() => {
      const panel = document.querySelector('.book-reader-settings-panel').getBoundingClientRect();
      const spreadRect = document.querySelector('[data-testid="book-page-spread"]').getBoundingClientRect();
      return panel.bottom <= spreadRect.top + 1;
    });
    expect(settingsDoNotCoverPages).toBe(true);

    const table = page.locator(`#chapter-${chapters[8].id} .rich-table-scroll`);
    const tableMetrics = await table.evaluate((wrapper) => {
      const element = wrapper.querySelector('table');
      const firstCell = element.querySelector('tbody td, tbody th, td, th');
      return {
        overflowX: getComputedStyle(wrapper).overflowX,
        role: wrapper.getAttribute('role'),
        tabIndex: wrapper.getAttribute('tabindex'),
        tableLayout: getComputedStyle(element).tableLayout,
        wrapperWidth: wrapper.clientWidth,
        firstCellMinWidth: getComputedStyle(firstCell).minWidth,
        firstCellOverflowWrap: getComputedStyle(firstCell).overflowWrap,
        tableFragmentWidths: [...element.getClientRects()].map((rect) => rect.width),
        tableScrollWidth: wrapper.scrollWidth,
      };
    });
    expect(tableMetrics.overflowX).toBe('visible');
    expect(tableMetrics.role).toBeNull();
    expect(tableMetrics.tabIndex).toBeNull();
    expect(tableMetrics.tableLayout).toBe('fixed');
    expect(tableMetrics.firstCellMinWidth).toBe('0px');
    expect(tableMetrics.firstCellOverflowWrap).toBe('anywhere');
    expect(tableMetrics.tableFragmentWidths.length).toBeGreaterThan(0);
    expect(Math.max(...tableMetrics.tableFragmentWidths)).toBeLessThanOrEqual(tableMetrics.wrapperWidth + 1);
    expect(tableMetrics.tableScrollWidth).toBeLessThanOrEqual(tableMetrics.wrapperWidth + 1);

    await settings.locator('select[aria-label="Jump to chapter"]').selectOption(chapters[9].id);
    await expect(page.locator(`#chapter-${chapters[9].id}`)).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });
  } finally {
    await api.dispose();
  }
});

test('keeps the screenshot-derived chapter 9 spread populated at pages 155–156 of 165', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, 'teacher');

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('teacher', baseURL);
  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));
    expect(demoModule, 'the demo class includes its first reading module').toBeTruthy();

    const [moduleSummary, book] = await Promise.all([
      api.get(`/modules/${demoModule.id}`),
      api.get(`/modules/${demoModule.id}/book`),
    ]);
    const paragraphCounts = [45, 45, 45, 45, 45, 45, 49, 49, 131, 27];
    const chapters = paragraphCounts.map((paragraphCount, index) => {
      const chapterNumber = index + 1;
      return {
        ...book.chapters[0],
        id: `reported-summary-chapter-${chapterNumber}`,
        moduleId: demoModule.id,
        title: chapterNumber === 9
          ? 'Module Summary: Building a Security-Oriented Computing Mindset'
          : `Reader QA chapter ${chapterNumber}`,
        chapterNumber,
        kind: 'LESSON',
        status: 'PUBLISHED',
        estimatedMinutes: 6,
        objectives: [],
        contentHtml: reportedSummaryFixtureContent(chapterNumber, paragraphCount),
        resources: [],
        visual: null,
        selfCheck: null,
        completed: false,
        bookmarked: false,
        locked: false,
        lockedReason: null,
      };
    });
    const fixtureSummary = {
      ...moduleSummary,
      title: 'Module 1: Introduction to Information Assurance and Security',
      description: 'Screenshot-derived content at the reported two-page boundary.',
      status: 'PUBLISHED',
      locked: false,
      lessonCount: chapters.length,
      lessons: chapters.map((chapter, index) => ({ ...chapter, position: index })),
      objectives: [],
      resources: [],
    };
    const fixtureBook = {
      ...book,
      ...fixtureSummary,
      chapters,
      totalEstimatedMinutes: chapters.length * 6,
    };

    await page.route(`**/api/modules/${demoModule.id}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: fixtureSummary }),
    }));
    await page.route(`**/api/modules/${demoModule.id}/book`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: fixtureBook }),
    }));

    await page.addInitScript(() => localStorage.setItem('discenda.readerPrefs', JSON.stringify({
      font: 'serif', size: 'md', focus: true, layout: 'two',
    })));
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book&chapter=${chapters[8].id}&page=39`);

    const reader = page.locator('[data-book-reader]');
    const spread = page.locator('[data-testid="book-page-spread"]');
    const navigation = page.getByRole('navigation', { name: 'Book page navigation' });
    await expect(reader).toBeVisible();
    await expect(reader).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');
    await expect(spread).toHaveAttribute('data-total-pages', '165');
    await expect(navigation).toContainText('Chapter 9 of 10: Module Summary: Building a Security-Oriented Computing Mindset (continued)');
    await expect(navigation).toContainText('Pages 155–156 of 165');
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });
    await expect.poll(() => visibleTextOnSpreadSide(page, 'Final Learning Reflection', 'left')).toBe(true);
    await expect.poll(() => visibleTextOnSpreadSide(page, 'Security note 10-1.', 'right')).toBe(true);
  } finally {
    await api.dispose();
  }
});
