import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Modules from './Modules.jsx';
import ModuleView from './ModuleView.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

vi.mock('../../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const { mockGet, mockPost, mockDelete, mockModuleSummary, mockModuleBook, mockLesson1, mockClassContext } = vi.hoisted(() => {
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
        contentHtml: '<h3>1. Introduction</h3><p>Modularity breaks a system into understandable parts.</p><blockquote><p><strong>Key Concept:</strong> High cohesion keeps related logic together.</p></blockquote>',
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
    resources: [],
    previous: null,
    next: { id: 'les-2', title: 'Dependency Rules & Pitfalls', locked: true },
    completed: false,
    bookmarked: false,
    aiStudyCoachEnabled: false,
  };
  return {
    mockGet: vi.fn(),
    mockPost: vi.fn().mockResolvedValue({}),
    mockDelete: vi.fn().mockResolvedValue({}),
    mockModuleSummary: summary,
    mockModuleBook: book,
    mockLesson1: lesson1,
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

function renderAt(path) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/classes/:classId/modules" element={<Modules />} />
            <Route path="/classes/:classId/modules/:moduleId" element={<ModuleView />} />
          </Routes>
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

describe('Module book-like reader & outline CTA', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockClassContext.canManage = false;
    mockClassContext.user = { id: 'stu-1', role: 'STUDENT' };
    mockGet.mockImplementation(async (url) => {
      if (url === '/classes/cls-1/modules') return [mockModuleSummary];
      if (url === '/classes/cls-1/gradebook/categories' || url === '/rubrics') return [];
      if (url === '/modules/mod-1') return mockModuleSummary;
      if (url === '/modules/mod-1/book') return mockModuleBook;
      if (url === '/lessons/les-1') return mockLesson1;
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

  it('offers teachers a draft assignment action from an unpublished lesson', async () => {
    mockClassContext.canManage = true;
    mockClassContext.user = { id: 'teacher-1', role: 'TEACHER' };
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?lesson=les-1');
    await flush();

    expect(container.textContent).toContain('Draft — hidden from students');
    const createButton = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment draft'));
    expect(createButton).toBeTruthy();
    act(() => createButton.click());
    await flush();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Create an assignment from this lesson');
    expect(dialog.querySelector('input').value).toBe('Foundations of Modularity');
    expect(dialog.querySelector('[aria-label="Assignment instructions"]').value).toBe(mockLesson1.contentHtml);

    unmount();
  });

  it('renders a cohesive book view with cover, table of contents, sequential chapters, typography controls, and completion trigger', async () => {
    const { container, unmount } = renderAt('/classes/cls-1/modules/mod-1?view=book');
    await flush();

    // Front matter & cover
    expect(container.textContent).toContain('Learning Module');
    expect(container.textContent).toContain('Learning Objectives');
    expect(container.textContent).toContain('Explain high cohesion and low coupling');
    expect(container.textContent).toContain('Table of contents');

    // Chapter 1 content uses textbook .rich-book styling (default serif)
    expect(container.textContent).toContain('Chapter 1 of 2');
    expect(container.textContent).toContain('Foundations of Modularity');
    expect(container.textContent).toContain('Modularity breaks a system into understandable parts.');
    const rich = container.querySelector('.rich-book');
    expect(rich).not.toBeNull();
    expect(rich.className).toContain('rich-book-serif');

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
