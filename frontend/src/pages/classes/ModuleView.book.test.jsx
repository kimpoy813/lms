import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Modules from './Modules.jsx';
import ModuleView, { bookPageIndexForLocation, initialBookLocation, makeBookPageMap } from './ModuleView.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

vi.mock('../../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const { mockGet, mockPost, mockDelete, mockModuleSummary, mockModuleBook, mockLesson1, mockLesson2, mockClassContext } = vi.hoisted(() => {
  const summary = {
    id: 'mod-1',
    classId: 'cls-1',
    status: 'DRAFT',
    title: 'Module 1: Software Design & Architecture',
    description: 'A cohesive textbook module covering modularity, cohesion, and layering.',
    objectives: ['Explain high cohesion and low coupling', 'Design clean module boundaries'],
    lessonCount: 2,
    totalEstimatedMinutes: 65,
    completedLessons: 0,
    progressPercent: 0,
    locked: false,
    resources: [],
    lessons: [
      { id: 'les-1', moduleId: 'mod-1', title: 'Foundations of Modularity', kind: 'LESSON', status: 'DRAFT', position: 0, estimatedMinutes: 30, completed: false, locked: false },
      { id: 'les-2', moduleId: 'mod-1', title: 'Dependency Rules & Pitfalls', kind: 'SUMMARY', position: 1, estimatedMinutes: 35, completed: false, locked: true, prerequisiteLessonId: 'les-1' },
    ],
  };
  const book = {
    ...summary,
    aiStudyCoachEnabled: false,
    chapters: [
      {
        ...summary.lessons[0],
        chapterNumber: 1,
        objectives: ['Distinguish cohesion from coupling'],
        contentHtml: '<h3>1. Introduction</h3><p>Modularity breaks a system into understandable parts.</p><blockquote><p><strong>Key Concept:</strong> High cohesion keeps related logic together.</p></blockquote><table><caption>Key terms</caption><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody><tr><td>Cohesion</td><td>How closely related the responsibilities of a module are.</td></tr></tbody></table>',
        visual: { title: 'From components to systems', description: 'Build the design in three steps.', steps: ['Group related responsibilities', 'Connect modules with clear interfaces', 'Verify the full system'] },
        selfCheck: { prompt: 'What supports high cohesion?', options: ['Related responsibilities in one module', 'Unrelated code in one module', 'Hidden dependencies'], correctIndex: 0, explanation: 'A module should keep closely related work together.' },
        resources: [],
        bookmarked: false,
        locked: false,
        lockedReason: null,
      },
      {
        ...summary.lessons[1],
        chapterNumber: 2,
        objectives: [],
        contentHtml: null,
        resources: [],
        bookmarked: false,
        locked: true,
        lockedReason: 'Complete Chapter 1 (“Foundations of Modularity”) to unlock this chapter.',
      },
    ],
  };
  const lesson1 = {
    id: 'les-1',
    classId: 'cls-1',
    moduleId: 'mod-1',
    moduleTitle: summary.title,
    title: 'Foundations of Modularity',
    kind: 'LESSON',
    status: 'DRAFT',
    estimatedMinutes: 30,
    objectives: ['Distinguish cohesion from coupling'],
    contentHtml: '<h3>1. Introduction</h3><p>Modularity breaks a system into understandable parts.</p>',
    visual: { title: 'From components to systems', description: 'Build the design in three steps.', steps: ['Group related responsibilities', 'Connect modules with clear interfaces', 'Verify the full system'] },
    selfCheck: { prompt: 'What supports high cohesion?', options: ['Related responsibilities in one module', 'Unrelated code in one module', 'Hidden dependencies'], correctIndex: 0, explanation: 'A module should keep closely related work together.' },
    resources: [],
    previous: null,
    next: { id: 'les-2', title: 'Dependency Rules & Pitfalls', locked: true },
    completed: false,
    bookmarked: false,
    aiStudyCoachEnabled: false,
  };
  const lesson2 = {
    ...lesson1,
    id: 'les-2',
    title: 'Dependency Rules & Pitfalls',
    contentHtml: '<p>Dependencies should point toward stable abstractions.</p>',
    previous: { id: 'les-1', title: 'Foundations of Modularity' },
    next: null,
  };
  return {
    mockGet: vi.fn(),
    mockPost: vi.fn().mockResolvedValue({}),
    mockDelete: vi.fn().mockResolvedValue({}),
    mockModuleSummary: summary,
    mockModuleBook: book,
    mockLesson1: lesson1,
    mockLesson2: lesson2,
    mockClassContext: { canManage: false, user: { id: 'stu-1', role: 'STUDENT' } },
  };
});

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: mockClassContext.user,
    isStudent: mockClassContext.user.role === 'STUDENT',
    isAdmin: mockClassContext.user.role === 'ADMIN',
    isTeacher: mockClassContext.user.role === 'TEACHER',
    can: () => false,
  }),
}));

vi.mock('./useClass.js', () => ({
  useClass: () => ({
    cls: { id: 'cls-1', status: 'ACTIVE', teacher: { id: 't-1' }, course: { code: 'CS101' }, section: { name: 'A' } },
    canManage: mockClassContext.canManage,
    isStudent: !mockClassContext.canManage,
    base: '/classes/cls-1',
  }),
  classLabel: (cls) => `${cls.course.code}${cls.section ? ` · ${cls.section.name}` : ''}`,
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: mockGet,
    post: mockPost,
    delete: mockDelete,
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  },
  fileUrl: (id) => `/api/files/${id}`,
}));

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 20));
});

function CurrentSearch() {
  return <output data-current-search>{useLocation().search}</output>;
}

function setViewportWidth(width) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

function mockBookFlowLayout({ chapterStarts, endStart, width = 800, height = 500, layout = 'single' }) {
  const originalWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  const originalBounds = Element.prototype.getBoundingClientRect;
  const originalRects = Element.prototype.getClientRects;
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.matches?.('[data-testid="book-page-flow"]') ? width : originalWidth?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.matches?.('[data-testid="book-page-flow"]') ? height : originalHeight?.get?.call(this) ?? 0;
    },
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.matches?.('[data-testid="book-page-flow"]')) return { left: 0, top: 0, width, height, right: width, bottom: height };
    return originalBounds.call(this);
  };
  Element.prototype.getClientRects = function getClientRects() {
    const chapterId = this.getAttribute?.('data-book-chapter-start');
    const column = chapterId ? chapterStarts[chapterId] : this.hasAttribute?.('data-book-end-start') ? endStart : null;
    if (column !== null && column !== undefined) {
      const activeLayout = this.closest?.('[data-reader-layout]')?.dataset.readerLayout ?? layout;
      const columnGap = activeLayout === 'two' ? 0 : 24;
      const columnWidth = activeLayout === 'two' ? (width - columnGap) / 2 : width;
      const flow = this.closest?.('.book-page-flow');
      const left = column * (columnWidth + columnGap) - (flow?.scrollLeft ?? 0);
      return [{ left, top: 0, width: columnWidth, height }];
    }
    return originalRects.call(this);
  };

  return () => {
    if (originalWidth) Object.defineProperty(Element.prototype, 'clientWidth', originalWidth);
    else delete Element.prototype.clientWidth;
    if (originalHeight) Object.defineProperty(Element.prototype, 'clientHeight', originalHeight);
    else delete Element.prototype.clientHeight;
    Element.prototype.getBoundingClientRect = originalBounds;
    Element.prototype.getClientRects = originalRects;
  };
}

function renderAt(path) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <>
            <CurrentSearch />
            <Routes>
              <Route path="/classes/:classId/modules" element={<Modules />} />
              <Route path="/classes/:classId/modules/:moduleId" element={<ModuleView />} />
            </Routes>
          </>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function dispatchTouch(target, type, { x, y }) {
  const touch = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === 'touchend' ? [] : [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
}

describe('Module book-like reader & outline CTA', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportWidth(1024);
    mockClassContext.canManage = false;
    mockClassContext.user = { id: 'stu-1', role: 'STUDENT' };
    mockGet.mockImplementation(async (url) => {
      if (url === '/classes/cls-1/modules') return [mockModuleSummary];
      if (url === '/classes/cls-1/gradebook/categories' || url === '/rubrics') return [];
      if (url === '/modules/mod-1') return mockModuleSummary;
      if (url === '/modules/mod-1/book') return mockModuleBook;
      if (url === '/lessons/les-1') return mockLesson1;
      if (url === '/lessons/les-2') return mockLesson2;
      throw new Error(`Unexpected GET ${url}`);
    });
    mockPost.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('offers a direct "Read as book" action on the modules list with chapter duration', async () => {
    const { container, unmount } = renderAt('/classes/cls-1/modules');
    await flush();

    expect(container.textContent).toContain('Module 1: Software Design & Architecture');
    expect(container.textContent).toContain('2 chapters');
    expect(container.textContent).toContain('1h 5m');
    const bookLinks = [...container.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.includes('view=book'));
    expect(bookLinks.length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain('Read as book');

    unmount();
  });

  it('keeps the teacher progress matrix scrollable with student names pinned on small screens', async () => {
    mockClassContext.canManage = true;
    mockClassContext.user = { id: 'teacher-1', role: 'TEACHER' };
    mockGet.mockImplementation(async (url) => {
      if (url === '/classes/cls-1/modules') return [mockModuleSummary];
      if (url === '/classes/cls-1/modules-progress') return {
        modules: [
          { id: 'mod-1', title: 'Module 1: Software Design & Architecture', lessonCount: 2 },
          { id: 'mod-2', title: 'Module 2: Data Structures', lessonCount: 3 },
        ],
        totalLessons: 5,
        students: [{ id: 'stu-1', name: 'Avery Student', percent: 40, modules: { 'mod-1': 2, 'mod-2': 0 } }],
      };
      throw new Error(`Unexpected GET ${url}`);
    });

    const { container, unmount } = renderAt('/classes/cls-1/modules');
    await flush();
    const openProgress = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Student progress'));
    expect(openProgress).toBeTruthy();
    act(() => openProgress.click());
    await flush();

    const tableScroller = document.body.querySelector('[role="region"][aria-label^="Student progress by module"]');
    expect(tableScroller).not.toBeNull();
    expect(tableScroller.tabIndex).toBe(0);
    expect(tableScroller.className).toContain('overflow-x-auto');
    expect(tableScroller.className).toContain('max-h-[65dvh]');
    expect(tableScroller.querySelector('thead th').className).toContain('sticky');
    expect(tableScroller.querySelector('tbody td').className).toContain('sticky');
    expect(tableScroller.textContent).toContain('Module 1: Software Design & Architecture');
    expect(tableScroller.textContent).toContain('Avery Student');

    unmount();
  });

  it('enters and exits browser fullscreen for the lesson reader', async () => {
    const originalRequest = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');
    const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
    const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const requestFullscreen = vi.fn(function request() {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: this });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    const exitFullscreen = vi.fn(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });

    let view;
    try {
      view = renderAt('/classes/cls-1/modules/mod-1?lesson=les-1');
      await flush();

      let toggle = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Full screen'));
      expect(toggle).toBeTruthy();
      act(() => toggle.click());
      await flush();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(document.fullscreenElement).toBe(view.container.querySelector('[data-module-reader]'));
      expect(view.container.querySelector('[data-module-reader]').className).toContain('bg-canvas');
      expect([...view.container.querySelectorAll('button')].some((button) => button.textContent.includes('Exit full screen'))).toBe(true);

      toggle = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Exit full screen'));
      act(() => toggle.click());
      await flush();
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect([...view.container.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Full screen')).toBe(true);
    } finally {
      view?.unmount();
      if (originalRequest) Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', originalRequest);
      else delete HTMLElement.prototype.requestFullscreen;
      if (originalExit) Object.defineProperty(document, 'exitFullscreen', originalExit);
      else delete document.exitFullscreen;
      if (originalFullscreenElement) Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
      else delete document.fullscreenElement;
    }
  });

  it('offers lesson-linked assignment and quiz composers plus a content-based assignment draft', async () => {
    mockClassContext.canManage = true;
    mockClassContext.user = { id: 'teacher-1', role: 'TEACHER' };
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?lesson=les-1');
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('Draft — hidden from students'));
    });
    expect(container.querySelector('select[aria-label="Choose a chapter"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Reading display options"]').className).toContain('grid-cols-2');
    expect(container.querySelector('button[aria-label="More lesson actions"]')).not.toBeNull();

    const openAssignment = [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'New assignment');
    expect(openAssignment).toBeTruthy();
    act(() => openAssignment.click());
    await flush();

    let dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const moduleLabel = [...dialog.querySelectorAll('label')].find((label) => label.textContent.includes('Module'));
    const lessonLabel = [...dialog.querySelectorAll('label')].find((label) => label.textContent.includes('Lesson'));
    expect(document.getElementById(moduleLabel.htmlFor).value).toBe('mod-1');
    expect(document.getElementById(lessonLabel.htmlFor).value).toBe('les-1');
    act(() => [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Cancel').click());
    await flush();

    const openQuiz = [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create quiz');
    expect(openQuiz).toBeTruthy();
    act(() => openQuiz.click());
    await flush();

    dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('New quiz');
    const quizModuleLabel = [...dialog.querySelectorAll('label')].find((label) => label.textContent.includes('Module'));
    const quizLessonLabel = [...dialog.querySelectorAll('label')].find((label) => label.textContent.includes('Lesson'));
    expect(document.getElementById(quizModuleLabel.htmlFor).value).toBe('mod-1');
    expect(document.getElementById(quizLessonLabel.htmlFor).value).toBe('les-1');
    act(() => [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Cancel').click());
    await flush();

    const createDraft = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment draft'));
    expect(createDraft).toBeTruthy();
    act(() => createDraft.click());
    await flush();
    dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Create an assignment from this lesson');
    const titleLabel = [...dialog.querySelectorAll('label')].find((label) => label.textContent.includes('Assignment title'));
    expect(document.getElementById(titleLabel.htmlFor).value).toBe('Foundations of Modularity');
    expect(dialog.querySelector('[aria-label="Assignment instructions"]').value).toBe(mockLesson1.contentHtml);

    unmount();
  });

  it('keeps the active book chapter in the URL and offers a saved resume point from the cover', async () => {
    const start = renderAt('/classes/cls-1/modules/mod-1?lesson=les-1');
    await flush();

    const bookMode = [...start.container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Read as book');
    expect(bookMode).toBeTruthy();
    act(() => bookMode.click());
    await flush();

    let pageNavigation = start.container.querySelector('nav[aria-label="Book page navigation"]');
    expect(pageNavigation.textContent).toContain('Page 2 of 4');
    expect(start.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1');
    const reader = start.container.querySelector('[data-book-reader]');
    act(() => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    pageNavigation = start.container.querySelector('nav[aria-label="Book page navigation"]');
    expect(pageNavigation.textContent).toContain('Page 3 of 4');
    expect(start.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-2');
    start.unmount();

    const resumed = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await flush();
    expect(resumed.container.textContent).toContain('Continue where you left off');
    const continueButton = [...resumed.container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Continue reading');
    expect(continueButton).toBeTruthy();
    act(() => continueButton.click());
    await flush();
    expect(resumed.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Page 3 of 4');
    expect(resumed.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-2');
    resumed.unmount();
  });

  it('maps measured page columns to chapter ranges and reads intra-chapter deep links', () => {
    const chapters = [{ id: 'long-chapter' }, { id: 'next-chapter' }];
    const pages = makeBookPageMap(chapters, [1, 4], 5);

    expect(pages).toEqual([
      { type: 'cover', page: 0 },
      { type: 'chapter', chapterId: 'long-chapter', page: 0 },
      { type: 'chapter', chapterId: 'long-chapter', page: 1 },
      { type: 'chapter', chapterId: 'long-chapter', page: 2 },
      { type: 'chapter', chapterId: 'next-chapter', page: 0 },
      { type: 'end' },
    ]);

    const deepLink = initialBookLocation(new URLSearchParams('view=book&chapter=long-chapter&page=3'), chapters);
    expect(deepLink).toEqual({ type: 'chapter', chapterId: 'long-chapter', page: 2 });
    expect(bookPageIndexForLocation(pages, deepLink)).toBe(3);
    expect(bookPageIndexForLocation(pages, { type: 'chapter', chapterId: 'next-chapter', page: 0 })).toBe(4);
  });

  it('resumes within a long chapter and starts the next chapter only after its final page', async () => {
    window.localStorage.setItem('discenda.readerPrefs', JSON.stringify({ font: 'serif', size: 'md', focus: false, layout: 'two' }));
    window.localStorage.setItem('discenda.bookPosition.v1.stu-1.mod-1', 'les-1');
    window.localStorage.setItem('discenda.bookPosition.v1.stu-1.mod-1.page', '3');
    setViewportWidth(820);
    const restoreLayout = mockBookFlowLayout({ chapterStarts: { 'les-1': 1, 'les-2': 4 }, endStart: 5, layout: 'two' });
    let view;
    try {
      view = renderAt('/classes/cls-1/modules/mod-1?view=book');
      await flush();
      expect(view.container.querySelector('[data-testid="book-page-flow"]').style.columnWidth).toBe('400px');
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Pages 1–2 of 6');

      const continueButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Continue reading');
      expect(continueButton).toBeTruthy();
      act(() => continueButton.click());
      await flush();
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Pages 3–4 of 6');
      expect(view.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1&page=3');
      const flow = view.container.querySelector('[data-testid="book-page-flow"]');
      const currentScrollLeft = flow.scrollLeft;
      expect(currentScrollLeft).toBe(800);
      act(() => window.dispatchEvent(new Event('beforeprint')));
      expect(flow.scrollLeft).toBe(0);
      act(() => window.dispatchEvent(new Event('afterprint')));
      expect(flow.scrollLeft).toBe(currentScrollLeft);

      const singlePage = [...view.container.querySelectorAll('[role="radiogroup"][aria-label="Book page layout"] [role="radio"]')]
        .find((button) => button.textContent.trim() === 'Single page');
      act(() => singlePage.click());
      await flush();
      expect(view.container.querySelector('[data-book-reader]').dataset.readerLayout).toBe('single');
      expect(flow.style.columnWidth).toBe('800px');
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Page 4 of 6');
      expect(view.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1&page=3');

      act(() => view.container.querySelector('[aria-label="Next page"]').click());
      await flush();
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Page 5 of 6');
      expect(view.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-2');
      expect(view.container.querySelector('#chapter-les-2').getAttribute('aria-hidden')).toBe('false');

      act(() => view.container.querySelector('[aria-label="Previous page"]').click());
      await flush();
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Page 4 of 6');
      expect(view.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1&page=3');
      expect(window.localStorage.getItem('discenda.bookPosition.v1.stu-1.mod-1.page')).toBe('3');

      view.unmount();
      view = renderAt('/classes/cls-1/modules/mod-1?view=book');
      await flush();
      const resumeAgain = [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Continue reading');
      act(() => resumeAgain.click());
      await flush();
      expect(view.container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Page 4 of 6');
      expect(view.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1&page=3');
    } finally {
      view?.unmount();
      restoreLayout();
    }
  });

  it.each([
    ['tablet', 820],
    ['laptop', 1366],
  ])('supports single pages and working two-page spreads on a %s viewport', async (_device, width) => {
    setViewportWidth(width);
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[data-book-reader]')).not.toBeNull());
    });

    const reader = container.querySelector('[data-book-reader]');
    const spread = container.querySelector('[data-testid="book-page-spread"]');
    const pageLayout = container.querySelector('[role="radiogroup"][aria-label="Book page layout"]');
    const pageNavigation = container.querySelector('nav[aria-label="Book page navigation"]');
    expect(reader.dataset.readerLayout).toBe('single');
    expect(pageLayout.className).toContain('md:inline-flex');
    expect(pageNavigation.textContent).toContain('Page 1 of 4');
    expect([...spread.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['0']);

    const twoPages = [...pageLayout.querySelectorAll('[role="radio"]')].find((button) => button.textContent.trim() === 'Two pages');
    act(() => twoPages.click());
    await flush();

    expect(reader.dataset.readerLayout).toBe('two');
    expect(spread.dataset.pageCount).toBe('2');
    let visiblePages = [...spread.querySelectorAll('.book-page[aria-hidden="false"]')];
    expect(visiblePages.map((page) => page.dataset.bookPage)).toEqual(['0', '1']);
    expect(visiblePages.map((page) => page.dataset.spreadSide)).toEqual(['left', 'right']);
    expect(pageNavigation.textContent).toContain('Pages 1–2 of 4');

    act(() => pageNavigation.querySelector('[aria-label="Next page"]').click());
    await flush();
    expect(pageNavigation.textContent).toContain('Pages 3–4 of 4');
    expect(pageNavigation.querySelector('[aria-label="Next page"]').disabled).toBe(true);
    expect(pageNavigation.querySelector('[aria-label="Previous page"]').disabled).toBe(false);
    expect(container.querySelector('[data-current-search]').textContent).toContain('chapter=les-2');
    expect(container.querySelector('[data-testid="book-turn-sheet"]').className).toContain('book-turn-sheet-next');
    visiblePages = [...spread.querySelectorAll('.book-page[aria-hidden="false"]')];
    expect(visiblePages.map((page) => page.dataset.bookPage)).toEqual(['2', '3']);

    act(() => pageNavigation.querySelector('[aria-label="Previous page"]').click());
    await flush();
    expect(pageNavigation.textContent).toContain('Pages 1–2 of 4');
    expect(container.querySelector('[data-testid="book-turn-sheet"]').className).toContain('book-turn-sheet-previous');

    const singlePage = [...pageLayout.querySelectorAll('[role="radio"]')].find((button) => button.textContent.trim() === 'Single page');
    act(() => singlePage.click());
    await flush();
    expect(reader.dataset.readerLayout).toBe('single');
    expect(pageNavigation.textContent).toContain('Page 1 of 4');
    expect([...spread.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['0']);

    act(() => pageNavigation.querySelector('[aria-label="Next page"]').click());
    await flush();
    expect(pageNavigation.textContent).toContain('Page 2 of 4');
    expect(container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1');
    unmount();
  });

  it('aligns deep links and the end-of-book URL with the correct saved spread', async () => {
    window.localStorage.setItem('discenda.readerPrefs', JSON.stringify({ font: 'serif', size: 'md', focus: false, layout: 'two' }));
    const chapter = renderAt('/classes/cls-1/modules/mod-1?view=book&chapter=les-1');
    await act(async () => {
      await vi.waitFor(() => expect(chapter.container.querySelector('[data-book-reader]')).not.toBeNull());
    });

    let pageNavigation = chapter.container.querySelector('nav[aria-label="Book page navigation"]');
    expect(pageNavigation.textContent).toContain('Pages 1–2 of 4');
    expect(chapter.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-1');
    expect([...chapter.container.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['0', '1']);
    expect(pageNavigation.querySelector('[aria-label="Previous page"]').disabled).toBe(true);
    act(() => pageNavigation.querySelector('[aria-label="Next page"]').click());
    await flush();
    pageNavigation = chapter.container.querySelector('nav[aria-label="Book page navigation"]');
    expect(pageNavigation.textContent).toContain('Pages 3–4 of 4');
    expect(chapter.container.querySelector('[data-current-search]').textContent).toContain('chapter=les-2');
    expect(pageNavigation.querySelector('[aria-label="Next page"]').disabled).toBe(true);
    chapter.unmount();

    const end = renderAt('/classes/cls-1/modules/mod-1?view=book&end=1');
    await act(async () => {
      await vi.waitFor(() => expect(end.container.querySelector('[data-book-reader]')).not.toBeNull());
    });
    pageNavigation = end.container.querySelector('nav[aria-label="Book page navigation"]');
    expect(pageNavigation.textContent).toContain('Pages 3–4 of 4');
    expect([...end.container.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['2', '3']);
    expect(end.container.querySelector('[data-current-search]').textContent).toContain('end=1');
    expect(pageNavigation.querySelector('[aria-label="Next page"]').disabled).toBe(true);
    end.unmount();
  });

  it('uses a single page below tablet width and restores a saved spread when widened', async () => {
    window.localStorage.setItem('discenda.readerPrefs', JSON.stringify({ font: 'serif', size: 'lg', focus: false, layout: 'two' }));
    setViewportWidth(390);
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[data-book-reader]')).not.toBeNull());
    });

    const reader = container.querySelector('[data-book-reader]');
    const spread = container.querySelector('[data-testid="book-page-spread"]');
    const pageLayout = container.querySelector('[role="radiogroup"][aria-label="Book page layout"]');
    expect(reader.dataset.readerLayout).toBe('single');
    expect(pageLayout.className).toContain('hidden');
    expect([...spread.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['0']);
    expect(window.localStorage.getItem('discenda.readerPrefs')).toContain('"layout":"two"');

    act(() => setViewportWidth(820));
    await flush();
    expect(reader.dataset.readerLayout).toBe('two');
    expect(spread.dataset.pageCount).toBe('2');
    expect([...spread.querySelectorAll('.book-page[aria-hidden="false"]')].map((page) => page.dataset.bookPage)).toEqual(['0', '1']);
    expect(container.querySelector('nav[aria-label="Book page navigation"]').textContent).toContain('Pages 1–2 of 4');
    unmount();
  });

  it('turns module book pages in both directions with touch swipes and laptop arrow keys', async () => {
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[data-book-reader]')).not.toBeNull());
    });

    const reader = container.querySelector('[data-book-reader]');
    const chapterOne = container.querySelector('#chapter-les-1');
    const chapterTwo = container.querySelector('#chapter-les-2');
    const pageNavigation = container.querySelector('nav[aria-label="Book page navigation"]');
    expect(reader.getAttribute('tabindex')).toBe('0');
    expect(pageNavigation.textContent).toContain('Page 1 of 4');
    expect(pageNavigation.querySelector('[aria-label="Previous page"]').disabled).toBe(true);
    expect(chapterOne.getAttribute('aria-hidden')).toBe('true');

    // Vertical reading movement does not accidentally turn a page.
    act(() => {
      dispatchTouch(reader, 'touchstart', { x: 100, y: 100 });
      dispatchTouch(reader, 'touchend', { x: 104, y: 180 });
    });
    expect(pageNavigation.textContent).toContain('Page 1 of 4');

    // Laptop keyboard navigation moves forward; a left swipe moves forward too.
    act(() => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(chapterOne.getAttribute('aria-hidden')).toBe('false');
    expect(pageNavigation.textContent).toContain('Page 2 of 4');
    const tableScroller = container.querySelector('.rich-table-scroll');
    act(() => {
      dispatchTouch(tableScroller, 'touchstart', { x: 180, y: 120 });
      dispatchTouch(tableScroller, 'touchend', { x: 90, y: 118 });
    });
    expect(pageNavigation.textContent).toContain('Page 2 of 4');

    act(() => {
      dispatchTouch(reader, 'touchstart', { x: 180, y: 120 });
      dispatchTouch(reader, 'touchend', { x: 90, y: 118 });
    });
    expect(chapterOne.getAttribute('aria-hidden')).toBe('true');
    expect(chapterTwo.getAttribute('aria-hidden')).toBe('false');
    expect(pageNavigation.textContent).toContain('Page 3 of 4');

    // A right swipe and the opposite arrow key both turn back toward the cover.
    act(() => {
      dispatchTouch(reader, 'touchstart', { x: 90, y: 118 });
      dispatchTouch(reader, 'touchend', { x: 180, y: 120 });
    });
    expect(chapterOne.getAttribute('aria-hidden')).toBe('false');
    expect(chapterTwo.getAttribute('aria-hidden')).toBe('true');
    act(() => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(pageNavigation.textContent).toContain('Page 1 of 4');
    expect(chapterOne.getAttribute('aria-hidden')).toBe('true');

    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(10_000);
      act(() => reader.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true })));
      expect(pageNavigation.textContent).toContain('Page 2 of 4');
      now.mockReturnValue(10_500);
      act(() => reader.dispatchEvent(new WheelEvent('wheel', { deltaX: -100, bubbles: true, cancelable: true })));
      expect(pageNavigation.textContent).toContain('Page 1 of 4');
    } finally {
      now.mockRestore();
    }

    unmount();
  });

  it('lets a teacher turn between individual lessons in both directions with laptop arrow keys', async () => {
    mockClassContext.canManage = true;
    mockClassContext.user = { id: 'teacher-1', role: 'TEACHER' };
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?lesson=les-1');
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[data-lesson-reader]')).not.toBeNull());
    });

    let reader = container.querySelector('[data-lesson-reader]');
    expect(reader.getAttribute('tabindex')).toBe('0');
    expect(container.textContent).toContain('Foundations of Modularity');
    const largerText = container.querySelector('button[aria-label="Larger text"]');
    act(() => largerText.click());
    await flush();
    expect(container.querySelector('.rich-book').className).toContain('rich-book-lg');
    expect(container.querySelector('.reader-scaled-content').getAttribute('data-reader-size')).toBe('lg');

    act(() => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    await flush();
    expect(container.textContent).toContain('Dependency Rules & Pitfalls');
    expect(container.querySelector('.rich-book').className).toContain('rich-book-lg');
    expect(container.querySelector('.reader-scaled-content').getAttribute('data-reader-size')).toBe('lg');

    reader = container.querySelector('[data-lesson-reader]');
    act(() => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    await flush();
    expect(container.textContent).toContain('Foundations of Modularity');

    unmount();
  });

  it('renders a cohesive book view with cover, table of contents, sequential chapters, typography controls, and completion trigger', async () => {
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('Learning Module'));
    });

    // Front matter & cover
    expect(container.textContent).toContain('Learning Module');
    expect(container.textContent).toContain('Learning Objectives');
    expect(container.textContent).toContain('Explain high cohesion and low coupling');
    expect(container.textContent).toContain('Table of contents');
    const mobileContents = container.querySelector('select[aria-label="Jump to chapter"]');
    expect(mobileContents).not.toBeNull();
    expect(mobileContents.parentElement.parentElement.parentElement.className).toContain('lg:hidden');
    expect(container.textContent).toContain('0/2 complete');

    // Chapter 1 content uses textbook .rich-book styling (default serif)
    expect(container.textContent).toContain('Chapter 1 of 2');
    expect(container.textContent).toContain('Foundations of Modularity');
    expect(container.textContent).toContain('Modularity breaks a system into understandable parts.');
    expect(container.textContent).toContain('From components to systems');
    expect(container.textContent).toContain('Quick check');
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(1);
    expect(container.textContent).toContain('What supports high cohesion?');
    const rich = container.querySelector('.rich-book');
    const scaledReaderContent = container.querySelector('#chapter-les-1 .reader-scaled-content');
    expect(rich).not.toBeNull();
    expect(scaledReaderContent).not.toBeNull();
    expect(scaledReaderContent.getAttribute('data-reader-size')).toBe('md');
    expect(rich.className).toContain('rich-book-serif');
    const scrollableTable = rich.querySelector('.rich-table-scroll[role="region"]');
    expect(scrollableTable).not.toBeNull();
    expect(scrollableTable.getAttribute('tabindex')).toBe('0');
    expect(scrollableTable.getAttribute('aria-label')).toBe('Scrollable table: Key terms');
    expect(scrollableTable.querySelector('table').textContent).toContain('Cohesion');

    // Chapter 2 is locked behind Chapter 1
    expect(container.textContent).toContain('Chapter 2 of 2 · Locked');
    expect(container.textContent).toContain('Complete Chapter 1 (“Foundations of Modularity”) to unlock this chapter.');

    // Toggle typography to Sans
    const sansBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sans');
    expect(sansBtn).toBeTruthy();
    await act(async () => {
      sansBtn.click();
    });
    expect(container.querySelector('.rich-book').className).not.toContain('rich-book-serif');

    // Text-size controls should visibly select distinct reader classes and persist the choice.
    const smallerText = container.querySelector('button[aria-label="Smaller text"]');
    const defaultText = container.querySelector('button[aria-label="Default text size"]');
    const largerText = container.querySelector('button[aria-label="Larger text"]');
    expect(smallerText).toBeTruthy();
    expect(defaultText.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { largerText.click(); });
    expect(rich.className).toContain('rich-book-lg');
    expect(scaledReaderContent.getAttribute('data-reader-size')).toBe('lg');
    expect([...container.querySelectorAll('.reader-scaled-content')].every((content) => content.getAttribute('data-reader-size') === 'lg')).toBe(true);
    expect(largerText.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem('discenda.readerPrefs')).size).toBe('lg');
    await act(async () => { smallerText.click(); });
    expect(rich.className).toContain('rich-book-sm');
    expect(scaledReaderContent.getAttribute('data-reader-size')).toBe('sm');
    expect([...container.querySelectorAll('.reader-scaled-content')].every((content) => content.getAttribute('data-reader-size') === 'sm')).toBe(true);
    await act(async () => { defaultText.click(); });
    expect(rich.className).not.toContain('rich-book-sm');
    expect(rich.className).not.toContain('rich-book-lg');
    expect(scaledReaderContent.getAttribute('data-reader-size')).toBe('md');
    expect([...container.querySelectorAll('.reader-scaled-content')].every((content) => content.getAttribute('data-reader-size') === 'md')).toBe(true);

    // Mark Chapter 1 completed directly inside book view
    const completeBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Mark Chapter 1 as completed'));
    expect(completeBtn).toBeTruthy();
    await act(async () => {
      completeBtn.click();
    });
    expect(mockPost).toHaveBeenCalledWith('/lessons/les-1/complete');

    unmount();
  });
});
