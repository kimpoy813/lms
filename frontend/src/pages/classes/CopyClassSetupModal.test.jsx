import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClassSettings from './ClassSettings.jsx';
import Setup from './gradebook/Setup.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  imported: false,
  postCalls: [],
}));

const classA = {
  id: 'cls-a',
  course: { id: 'course-1', code: 'CS 101', title: 'Intro to CS', units: 3 },
  section: { id: 'sec-a', name: 'Section A' },
  semester: { id: 'sem-1', name: 'First Semester', isCurrent: true },
  teacher: { id: 'teacher-1', name: 'Prof. Reyes' },
  title: 'CS 101 — Intro to CS',
  description: '',
  room: 'Lab 1',
  color: 'indigo',
  status: 'ACTIVE',
  schedules: [],
  enrollmentCode: 'CS101A',
  enrollmentCodeEnabled: true,
  enrollmentRequiresApproval: false,
  classmatesVisible: true,
  aiStudyCoachEnabled: false,
  gradeRankingEnabled: false,
  gradeRankingShowScores: true,
  gradesFinalizedAt: null,
  syllabusHtml: '<p>Original Syllabus</p>',
  learningOutcomes: ['Original outcome'],
};

const classB = {
  id: 'cls-b',
  course: { id: 'course-1', code: 'CS 101', title: 'Intro to CS', units: 3 },
  section: { id: 'sec-b', name: 'Section B' },
  semester: { id: 'sem-1', name: 'First Semester', isCurrent: true },
  teacher: { id: 'teacher-1', name: 'Prof. Reyes' },
  title: 'CS 101 — Intro to CS',
  color: 'teal',
  status: 'ACTIVE',
  syllabusHtml: '<p>Imported CS101 B Syllabus</p>',
  learningOutcomes: ['Build algorithms', 'Analyze complexity'],
};

const classArchived = {
  id: 'cls-arch',
  course: { id: 'course-1', code: 'CS 101', title: 'Intro to CS', units: 3 },
  section: { id: 'sec-old', name: 'Old Term' },
  semester: { id: 'sem-0', name: 'Prior Semester', isCurrent: false },
  teacher: { id: 'teacher-1', name: 'Prof. Reyes' },
  title: 'CS 101 — Intro to CS',
  color: 'slate',
  status: 'ARCHIVED',
  syllabusHtml: '<p>Old Term Syllabus</p>',
  learningOutcomes: ['Old outcome'],
};

const initialGradebook = {
  class: {
    usesDefaultScale: true,
    gradingScale: null,
    transmutationBase: 0,
    gradeRounding: 0,
    treatMissingAsZero: false,
    attendanceLateCredit: 0.5,
    attendanceAllowed: false,
    finalizedAt: null,
  },
  structure: {
    periods: [
      {
        id: 'p1',
        name: 'Midterm',
        weight: 100,
        lockedAt: null,
        categories: [{ id: 'c1', name: 'Quizzes', kind: 'QUIZ', weight: 100, items: [] }],
      },
    ],
  },
};

const importedGradebook = {
  ...initialGradebook,
  structure: {
    periods: [
      {
        id: 'p-new-1',
        name: 'Midterm',
        weight: 40,
        lockedAt: null,
        categories: [
          { id: 'c-new-1', name: 'Quizzes', kind: 'QUIZ', weight: 30, items: [] },
          { id: 'c-new-2', name: 'Projects', kind: 'PROJECT', weight: 70, items: [] },
        ],
      },
      {
        id: 'p-new-2',
        name: 'Finals',
        weight: 60,
        lockedAt: null,
        categories: [{ id: 'c-new-3', name: 'Final Exam', kind: 'EXAM', weight: 100, items: [] }],
      },
    ],
  },
};

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'teacher-1', role: 'TEACHER' },
    isAdmin: false,
    isStudent: false,
    can: () => false,
  }),
}));

vi.mock('../../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel ?? 'Syllabus'} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('./useClass.js', () => ({
  classLabel: (c) => (c?.section?.name ? `${c.course.code} · ${c.section.name}` : c?.course?.code ?? ''),
  useClass: () => ({
    cls: mockState.imported ? { ...classA, syllabusHtml: classB.syllabusHtml, learningOutcomes: classB.learningOutcomes } : classA,
    base: '/classes/cls-a',
    canManage: true,
  }),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn((path) => {
      if (path === '/classes') return Promise.resolve([classA, classB, classArchived]);
      if (path === '/classes/cls-a') {
        return Promise.resolve(
          mockState.imported
            ? { ...classA, syllabusHtml: classB.syllabusHtml, learningOutcomes: classB.learningOutcomes }
            : classA,
        );
      }
      if (path === '/classes/cls-b') return Promise.resolve(classB);
      if (path === '/classes/cls-a/gradebook') {
        return Promise.resolve(mockState.imported ? importedGradebook : initialGradebook);
      }
      if (path === '/classes/cls-b/gradebook') return Promise.resolve(importedGradebook);
      if (path === '/classes/cls-a/gradebook/templates') return Promise.resolve([]);
      if (path === '/catalog/grading-scales') return Promise.resolve([]);
      return Promise.resolve([]);
    }),
    post: vi.fn((path, body) => {
      mockState.postCalls.push({ path, body });
      if (path.endsWith('/copy-setup')) {
        if (body?.targetClassIds?.includes('cls-a')) {
          mockState.imported = true;
        }
        return Promise.resolve({
          sourceClassId: path.split('/')[2],
          targets: (body?.targetClassIds ?? []).map((id) => ({ id, label: id, remappedItems: 0 })),
          copied: body,
        });
      }
      return Promise.resolve({});
    }),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

async function waitFor(getter, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let val;
    await act(async () => {
      await flush();
      val = getter();
    });
    if (val) return val;
  }
  return getter();
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()();
  }
});

function renderWithProviders(element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(cleanup);
  return { container, cleanup };
}

describe('CopyClassSetupModal in ClassSettings and Gradebook Setup', () => {
  it('pushes syllabus & learning outcomes to other classes and imports from another class with immediate UI sync', async () => {
    mockState.imported = false;
    mockState.postCalls.length = 0;

    const { container } = renderWithProviders(<ClassSettings />);
    await act(flush);

    // Click "Copy / Import…" in the Syllabus and learning outcomes card
    const copyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Copy / Import'));
    expect(copyBtn).toBeTruthy();
    await act(async () => {
      copyBtn.click();
    });

    // Wait for classes query to render target checkboxes in push mode, excluding archived Old Term
    const targetBox = await waitFor(() => (
      Array.from(document.querySelectorAll('input[type="checkbox"]')).find((cb) => cb.closest('label')?.textContent.includes('CS 101 · Section B'))
    ));
    expect(targetBox).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('input[type="checkbox"]')).find((cb) => cb.closest('label')?.textContent.includes('CS 101 · Old Term')),
    ).toBeUndefined();

    await act(async () => {
      targetBox.click();
    });

    const submitPushBtn = await waitFor(() => (
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Copy to 1 class'))
    ));
    expect(submitPushBtn).toBeTruthy();
    await act(async () => {
      submitPushBtn.click();
    });

    await waitFor(() => mockState.postCalls.length >= 1);
    expect(mockState.postCalls).toContainEqual({
      path: '/classes/cls-a/copy-setup',
      body: {
        targetClassIds: ['cls-b'],
        gradeWeights: false,
        gradePolicy: false,
        syllabus: true,
        learningOutcomes: true,
      },
    });

    // Re-open modal and import from CS 101 · Section B into CS 101 · Section A
    const reopenBtn = await waitFor(() => (
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Copy / Import'))
    ));
    await act(async () => {
      reopenBtn.click();
    });

    const importTab = await waitFor(() => (
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Import from another class'))
    ));
    await act(async () => {
      importTab.click();
    });

    const sourceRadio = await waitFor(() => (
      Array.from(document.querySelectorAll('input[type="radio"]')).find((r) => r.closest('label')?.textContent.includes('CS 101 · Section B'))
    ));
    expect(
      Array.from(document.querySelectorAll('input[type="radio"]')).find((r) => r.closest('label')?.textContent.includes('CS 101 · Old Term')),
    ).toBeTruthy();
    expect(sourceRadio).toBeTruthy();
    await act(async () => {
      sourceRadio.click();
    });

    // Wait for source preview
    const previewReady = await waitFor(() => document.body.textContent.includes('2 learning outcomes'));
    expect(previewReady).toBe(true);

    const submitPullBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Import into CS 101 · Section A'));
    await act(async () => {
      submitPullBtn.click();
    });

    // Wait for immediate UI sync on ClassSettings
    const synced = await waitFor(() => container.querySelector('textarea[aria-label="Syllabus"]')?.value === '<p>Imported CS101 B Syllabus</p>');
    expect(synced).toBe(true);
    const outcomeInputs = Array.from(container.querySelectorAll('input[aria-label^="Learning outcome"]')).map((i) => i.value);
    expect(outcomeInputs).toEqual(['Build algorithms', 'Analyze complexity']);
  });

  it('imports category weights inside Gradebook Setup and immediately updates periods on screen', async () => {
    mockState.imported = false;
    mockState.postCalls.length = 0;

    const { container } = renderWithProviders(<Setup data={initialGradebook} />);
    await act(flush);

    const copyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Copy / Import'));
    expect(copyBtn).toBeTruthy();
    await act(async () => {
      copyBtn.click();
    });

    const importTab = await waitFor(() => (
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Import from another class'))
    ));
    await act(async () => {
      importTab.click();
    });

    const sourceRadio = await waitFor(() => (
      Array.from(document.querySelectorAll('input[type="radio"]')).find((r) => r.closest('label')?.textContent.includes('CS 101 · Section B'))
    ));
    await act(async () => {
      sourceRadio.click();
    });

    // Source weights preview visible
    const previewReady = await waitFor(() => document.body.textContent.includes('Finals (60%)'));
    expect(previewReady).toBe(true);

    const submitPullBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Import into CS 101 · Section A'));
    await act(async () => {
      submitPullBtn.click();
    });

    // Period inputs immediately show Midterm + Finals from cls-b
    const synced = await waitFor(() => (
      Array.from(container.querySelectorAll('input[placeholder="e.g. Midterm"]')).map((i) => i.value).length === 2
    ));
    expect(synced).toBe(true);
    expect(mockState.postCalls).toContainEqual({
      path: '/classes/cls-b/copy-setup',
      body: {
        targetClassIds: ['cls-a'],
        gradeWeights: true,
        gradePolicy: false,
        syllabus: false,
        learningOutcomes: false,
      },
    });
    const periodInputs = Array.from(container.querySelectorAll('input[placeholder="e.g. Midterm"]')).map((i) => i.value);
    expect(periodInputs).toEqual(['Midterm', 'Finals']);
  });
});
