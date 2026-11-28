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

test('keeps the initial two-page module-cover spread populated', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1228, height: 690 });
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
    const chapters = Array.from({ length: 10 }, (_, index) => ({
      ...book.chapters[0],
      id: `cover-spread-chapter-${index + 1}`,
      moduleId: demoModule.id,
      title: `Security chapter ${index + 1}`,
      chapterNumber: index + 1,
      kind: 'LESSON',
      status: 'DRAFT',
      estimatedMinutes: 48,
      objectives: [],
      contentHtml: `<h3>Chapter ${index + 1}</h3><p>${PAGE_TEXT.repeat(10)}</p>`,
      resources: [],
      visual: null,
      selfCheck: null,
      completed: false,
      bookmarked: false,
      locked: false,
      lockedReason: null,
    }));
    let fixtureSummary = {
      ...moduleSummary,
      title: 'Module 1: Introduction to Information Assurance and Security',
      description: 'A concise module overview for the opening spread.',
      status: 'DRAFT',
      locked: false,
      lessonCount: chapters.length,
      lessons: chapters.map((chapter, index) => ({ ...chapter, position: index })),
      objectives: [],
      resources: [],
    };
    let fixtureBook = { ...book, ...fixtureSummary, chapters, totalEstimatedMinutes: 480 };
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

    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book`);
    const spread = page.locator('[data-testid="book-page-spread"]');
    const navigation = page.getByRole('navigation', { name: 'Book page navigation' });
    await expect(page.locator('[data-book-reader]')).toHaveAttribute('data-reader-layout', 'two');
    await expect(navigation).toContainText('Module cover');
    await expect(navigation).toContainText('Pages 1–2 of');
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });
    await expect.poll(() => visibleTextOnSpreadSide(page, 'Chapters in this module', 'right')).toBe(true);

    // Match the cover copy visible in the user report as well: a long summary should continue
    // across the spread instead of leaving the facing page empty.
    fixtureSummary = {
      ...fixtureSummary,
      description: 'In an increasingly interconnected world, information has become one of the most valuable assets of individuals, organizations, and governments. However, the technologies that make information easier to collect, process, store, and exchange also expose it to numerous threats, including unauthorized access, data manipulation, system disruption, and cyberattacks. This module introduces the fundamental principles of Information Assurance and Security, emphasizing the confidentiality, integrity, and availability of information, the nature of common security threats, and the strategies used to protect computing environments. Through practical examples, realistic scenarios, and analytical activities, students will develop a security-oriented mindset that they can apply to software development, database management, networking, research, and professional computing practice. The module is designed for approximately 480 minutes or eight hours of structured learning, combining foundational concepts with applied activities and practical review.',
    };
    fixtureBook = { ...fixtureBook, ...fixtureSummary };
    await page.reload();
    await expect(spread).toHaveAttribute('data-page-count', '2');
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });
    await expect.poll(() => visibleTextOnSpreadSide(page, 'develop a security-oriented mindset', 'right')).toBe(true);
  } finally {
    await api.dispose();
  }
});

test('keeps long chapter text flowing across both pages of a two-page spread', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1228, height: 690 });
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
    const chapters = Array.from({ length: 10 }, (_, index) => {
      const chapterNumber = index + 1;
      const paragraphs = Array.from({ length: 48 }, (_, paragraphIndex) => (
        `<p><strong>Reading section ${paragraphIndex + 1}.</strong> Chapter ${chapterNumber} continuity marker. ${PAGE_TEXT}</p>`
      )).join('');
      return {
        ...book.chapters[0],
        id: `continuous-reader-chapter-${chapterNumber}`,
        moduleId: demoModule.id,
        title: `Continuous reading chapter ${chapterNumber}`,
        chapterNumber,
        kind: 'LESSON',
        status: 'PUBLISHED',
        estimatedMinutes: 48,
        objectives: [],
        contentHtml: `<h3>Chapter ${chapterNumber} overview</h3>${paragraphs}`,
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
      title: 'Two-page continuity regression fixture',
      description: 'Long chapter text should continue across physical page columns.',
      status: 'PUBLISHED',
      locked: false,
      lessonCount: chapters.length,
      lessons: chapters.map((chapter, index) => ({ ...chapter, position: index })),
      objectives: [],
      resources: [],
    };
    const fixtureBook = { ...book, ...fixtureSummary, chapters, totalEstimatedMinutes: 480 };
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

    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book&chapter=${chapters[0].id}&page=3`);
    const spread = page.locator('[data-testid="book-page-spread"]');
    const navigation = page.getByRole('navigation', { name: 'Book page navigation' });
    await expect(page.locator('[data-book-reader]')).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');
    await expect(navigation).toContainText('Continuous reading chapter 1 (continued)');
    await expect.poll(() => visibleTextOnSpreadSide(page, 'Chapter 1 continuity marker', 'left')).toBe(true);
    await expect.poll(() => visibleTextOnSpreadSide(page, 'Chapter 1 continuity marker', 'right')).toBe(true);
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

// A scaled Windows display or a page zoom lays the reader out at a fractional width (837.89px, not
// 838px). `clientWidth` rounds that up, so a column width taken from it no longer fits twice besides
// the gap: the browser then draws one column and the right page of every spread stays empty.
test('keeps both pages of a spread filled at a fractional reader width', async ({ page }) => {
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
    const book = await api.get(`/modules/${demoModule.id}/book`);

    const chapters = Array.from({ length: 4 }, (_, index) => {
      const chapterNumber = index + 1;
      const paragraphs = Array.from({ length: 14 }, (_, paragraphIndex) => (
        `<p><strong>Reading note ${paragraphIndex + 1}.</strong> Chapter ${chapterNumber} continues the spread. ${PAGE_TEXT}</p>`
      )).join('');
      return {
        ...book.chapters[0],
        id: `fractional-reader-chapter-${chapterNumber}`,
        moduleId: demoModule.id,
        title: `Fractional reader chapter ${chapterNumber}`,
        chapterNumber,
        kind: 'LESSON',
        status: 'PUBLISHED',
        estimatedMinutes: 6,
        objectives: [],
        contentHtml: `<h3>Chapter ${chapterNumber} overview</h3>${paragraphs}`,
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
      ...demoModule,
      title: 'Fractional reader fixture',
      description: 'Chapter text should fill both pages of every spread.',
      status: 'PUBLISHED',
      locked: false,
      lessonCount: chapters.length,
      lessons: chapters.map((chapter, index) => ({ ...chapter, position: index })),
      objectives: [],
      resources: [],
    };
    const fixtureBook = { ...book, ...fixtureSummary, chapters, totalEstimatedMinutes: 24 };
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
      font: 'serif', size: 'md', focus: false, layout: 'two',
    })));
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book&chapter=${chapters[0].id}`);

    const reader = page.locator('[data-book-reader]');
    const spread = page.locator('[data-testid="book-page-spread"]');
    const flow = page.locator('[data-testid="book-page-flow"]');
    await expect(reader).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');

    // Widths that leave a fraction of a pixel, as a scaled display or a page zoom does.
    for (const width of [837.9, 836.9, 823.5, 899.35]) {
      await spread.evaluate((element, nextWidth) => { element.style.width = `${nextWidth}px`; }, width);
      await expect.poll(async () => (await visibleSpreadHasTextInBothPages(page))).toEqual({ left: true, right: true });
      const columns = await flow.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const columnWidth = Number.parseFloat(element.style.columnWidth);
        const gap = Number.parseFloat(element.style.columnGap);
        const offsets = new Set();
        for (const article of element.querySelectorAll('[data-book-page]')) {
          const rect = article.getBoundingClientRect();
          if (rect.width > 0) offsets.add(Math.round((rect.left - bounds.left) / (columnWidth + gap)));
        }
        return { count: offsets.size, columnWidth, gap, width: bounds.width };
      });
      expect(columns.count, `a ${width}px reader must keep two columns (${JSON.stringify(columns)})`).toBeGreaterThanOrEqual(2);
      expect(columns.columnWidth * 2 + columns.gap).toBeLessThanOrEqual(columns.width + 0.01);
    }

    // Turning pages still moves one spread at a time at a fractional width.
    await spread.evaluate((element) => { element.style.width = '837.9px'; });
    const navigation = page.getByRole('navigation', { name: 'Book page navigation' }).first();
    const before = await navigation.textContent();
    await page.locator('[data-book-reader]').press('ArrowRight');
    await expect.poll(() => navigation.textContent()).not.toBe(before);
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });
  } finally {
    await api.dispose();
  }
});

// Two thin columns are hard to read on a tablet held upright, so the spread is offered on landscape
// screens only: a laptop, or a tablet turned sideways.
// A laptop turns pages with the keyboard or a two-finger trackpad gesture, and both used to look
// broken: the sheet was an opaque card hiding the text, and the gesture scrolled the page out from
// under the flip because the wheel listener could not refuse it.
test('turns the page with a sheet that never hides the words or scrolls the page', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'student');

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('student', baseURL);
  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));

    await page.addInitScript(() => localStorage.setItem('discenda.readerPrefs', JSON.stringify({
      font: 'serif', size: 'md', focus: true, layout: 'two',
    })));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book`);

    const reader = page.locator('[data-book-reader]');
    const spread = page.getByTestId('book-page-spread');
    await expect(reader).toBeVisible();
    await expect(spread).toHaveAttribute('data-page-count', '2');

    // Keyboard turn: a sheet appears, is translucent, and is gone when the turn is over.
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await reader.press('ArrowRight');
    const sheet = page.getByTestId('book-turn-sheet');
    const duringTurn = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        animation: style.animationName,
        blend: style.mixBlendMode,
        // Layout size, not the projected rectangle: the sheet is already turning, so its on-screen
        // box shrinks with the rotation and would make this assertion a race.
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
    });
    expect(duringTurn.animation).toContain('book-sheet-flip');
    // The sheet must not be an opaque card over the text.
    expect(duringTurn.blend).toBe('multiply');
    // It is one page of the spread, not the whole spread, and it has real size.
    const spreadBox = await spread.boundingBox();
    expect(duringTurn.width).toBeGreaterThan(spreadBox.width * 0.4);
    expect(duringTurn.width).toBeLessThan(spreadBox.width * 0.6);
    expect(duringTurn.height).toBeGreaterThan(spreadBox.height * 0.5);

    // The words the reader is on stay in the document, and visible, while the sheet passes over.
    const textUnderSheet = await page.evaluate(() => {
      const flow = document.querySelector('[data-testid="book-page-flow"]');
      const visible = [...flow.querySelectorAll('.book-page[aria-hidden="false"]')];
      return visible.map((element) => element.textContent.trim().length);
    });
    expect(textUnderSheet.every((length) => length > 40)).toBe(true);

    // When the turn ends the sheet is gone, so no invisible layer sits over the pages.
    await expect(sheet).toHaveCount(0, { timeout: 3000 });
    // The page did not scroll under the turn.
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThan(4);

    // Trackpad gesture: refused at the source, so the window cannot scroll while the page turns.
    const before = await page.getByRole('navigation', { name: 'Book page navigation' }).first().textContent();
    const refused = await reader.evaluate((element) => {
      const event = new WheelEvent('wheel', { deltaX: 140, deltaY: 0, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(refused).toBe(true);
    await expect.poll(async () => page.getByRole('navigation', { name: 'Book page navigation' }).first().textContent()).not.toBe(before);

    // A vertical gesture is still a scroll, not a page turn.
    const afterTurns = await page.getByRole('navigation', { name: 'Book page navigation' }).first().textContent();
    const verticalLeftAlone = await reader.evaluate((element) => {
      const event = new WheelEvent('wheel', { deltaX: 0, deltaY: 180, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(verticalLeftAlone).toBe(false);
    await page.waitForTimeout(700);
    expect(await page.getByRole('navigation', { name: 'Book page navigation' }).first().textContent()).toBe(afterTurns);
  } finally {
    await api.dispose();
  }
});

test('offers a two-page spread on landscape screens only', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'teacher');

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const api = await apiAs('teacher', baseURL);
  try {
    const cls = await demoClass(api);
    const modules = await api.get(`/classes/${cls.id}/modules`);
    const demoModule = modules.find((module) => module.title.includes('Introduction to Computers'));
    expect(demoModule, 'the demo class includes its first reading module').toBeTruthy();

    await page.addInitScript(() => localStorage.setItem('discenda.readerPrefs', JSON.stringify({
      font: 'serif', size: 'md', focus: false, layout: 'two',
    })));
    await page.goto(`/classes/${cls.id}/modules/${demoModule.id}?view=book`);

    const reader = page.locator('[data-book-reader]');
    const spread = page.locator('[data-testid="book-page-spread"]');
    const twoPages = page.locator('[role="radiogroup"][aria-label="Book page layout"] [role="radio"]')
      .filter({ hasText: 'Two pages' });
    await expect(reader).toBeVisible();

    // A tablet held upright: one page, and the spread choice explains why it is unavailable.
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(reader).toHaveAttribute('data-reader-layout', 'single');
    await expect(spread).toHaveAttribute('data-page-count', '1');
    await expect(twoPages).toBeDisabled();
    await expect(twoPages).toHaveAttribute('title', /landscape/);

    // Turned sideways (or on a laptop) the saved spread comes back by itself.
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(reader).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');
    await expect(twoPages).toBeEnabled();
    await expect.poll(() => visibleSpreadHasTextInBothPages(page)).toEqual({ left: true, right: true });

    // A laptop keeps its spread.
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(reader).toHaveAttribute('data-reader-layout', 'two');
    await expect(spread).toHaveAttribute('data-page-count', '2');

    // A phone-sized screen stays on one page.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reader).toHaveAttribute('data-reader-layout', 'single');
    await expect(spread).toHaveAttribute('data-page-count', '1');
  } finally {
    await api.dispose();
  }
});
