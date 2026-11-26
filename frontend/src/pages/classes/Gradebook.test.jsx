import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import Gradebook from './Gradebook.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const { mockData, mockPatch, mockDelete, mockDownload, mockDownloadForm } = vi.hoisted(() => ({
  mockPatch: vi.fn().mockResolvedValue({}),
  mockDelete: vi.fn().mockResolvedValue({}),
  mockDownload: vi.fn().mockResolvedValue(undefined),
  mockDownloadForm: vi.fn().mockResolvedValue('template-filled-grades.xlsx'),
  mockData: {
    class: {
      id: 'cls-1',
      label: 'IT 101 · BSIT 1A',
      title: 'Intro to Computing',
      status: 'ACTIVE',
      treatMissingAsZero: true,
      transmutationBase: 0,
      gradeRounding: 2,
      attendanceLateCredit: 0.5,
      gradeRankingEnabled: false,
      gradeRankingShowScores: true,
      gradingScale: { id: 'scale-1', name: '1.00–5.00', entries: [{ label: '1.00', minPercent: 97 }, { label: '5.00', minPercent: 0 }] },
      usesDefaultScale: true,
      attendanceAllowed: false,
      finalizedAt: null,
    },
    structure: {
      valid: true,
      errors: [],
      periods: [
        {
          id: 'p1',
          name: 'Midterm',
          weight: 50,
          position: 0,
          publishedAt: null,
          lockedAt: null,
          categories: [
            {
              id: 'c1',
              name: 'Quizzes',
              kind: 'QUIZ',
              weight: 40,
              items: [
                { id: 'item-manual', title: 'Oral Recitation', maxPoints: 50, source: 'MANUAL', assignmentId: null, quizId: null, dueAt: null, hasRubric: false },
                { id: 'item-quiz', title: 'Quiz 1', maxPoints: 20, source: 'QUIZ', assignmentId: null, quizId: 'q1', dueAt: null, hasRubric: false },
              ],
            },
            {
              id: 'c2',
              name: 'Assignments',
              kind: 'ASSIGNMENT',
              weight: 60,
              items: [
                { id: 'item-assign', title: 'Homework 1', maxPoints: 100, source: 'ASSIGNMENT', assignmentId: 'a1', quizId: null, dueAt: null, hasRubric: false },
              ],
            },
          ],
        },
        {
          id: 'p2',
          name: 'Final',
          weight: 50,
          position: 1,
          publishedAt: null,
          lockedAt: null,
          categories: [
            { id: 'c3', name: 'Final Exam', kind: 'EXAM', weight: 100, items: [] },
          ],
        },
      ],
    },
    students: [
      {
        id: 's1',
        name: 'Juan Dela Cruz',
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        studentNumber: '2026-0001',
        enrollmentStatus: 'ENROLLED',
        entries: {
          'item-manual': { score: 45, status: 'GRADED', isLate: false },
          'item-quiz': { score: 18, status: 'GRADED', isLate: false },
          'item-assign': { score: 90, status: 'GRADED', isLate: false },
        },
        periods: {
          p1: { percent: 90, computedPercent: 90, label: '1.75', remark: 'Good', isPassing: true, isOverridden: false, isComplete: true },
          p2: { percent: null, computedPercent: null, label: null, remark: null, isPassing: null, isOverridden: false, isComplete: false },
        },
        overall: { percent: 90, computedPercent: 90, label: '1.75', remark: 'Good', isPassing: true, isOverridden: false, isComplete: false },
        missingCount: 0,
      },
    ],
    stats: { students: 1, dropped: 0, graded: 1, average: 90, highest: 90, lowest: 90, passing: 1, failing: 0 },
  },
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 't1', role: 'TEACHER' }, can: () => true }),
}));

vi.mock('./useClass.js', () => ({
  useClass: () => ({ cls: { id: 'cls-1', status: 'ACTIVE' }, canManage: true, base: '/classes/cls-1' }),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn((path) => (path.includes('/appeals') ? Promise.resolve([]) : Promise.resolve(mockData))),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: mockPatch,
    delete: mockDelete,
    download: mockDownload,
    downloadForm: mockDownloadForm,
  },
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

function renderGradebook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Gradebook />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('Gradebook weighted export and column edit/delete', () => {
  it('offers column edit & delete menus on manual, assignment, and quiz columns', async () => {
    const { container, cleanup } = renderGradebook();
    await flush();

    expect(container.querySelector('button[aria-label="Column options for Oral Recitation"]')).toBeTruthy();
    const quizMenu = container.querySelector('button[aria-label="Column options for Quiz 1"]');
    const assignMenu = container.querySelector('button[aria-label="Column options for Homework 1"]');
    expect(quizMenu).toBeTruthy();
    expect(assignMenu).toBeTruthy();

    // Open Edit column on linked Assignment column -> saves PATCH cleanly.
    act(() => assignMenu.click());
    await flush();
    const editBtn = [...document.body.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Edit column'));
    act(() => editBtn.click());
    await flush();
    expect(document.body.textContent).toContain('Changes to title, points, or due date also update the linked assignment.');
    const saveBtn = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Save');
    await act(async () => {
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockPatch).toHaveBeenCalledWith('/classes/cls-1/gradebook/items/item-assign', expect.objectContaining({ title: 'Homework 1', maxPoints: 100 }));

    // Open Delete column on linked Quiz column -> confirms non-destructive detachment & calls DELETE.
    act(() => quizMenu.click());
    await flush();
    const deleteBtn = [...document.body.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Delete column'));
    act(() => deleteBtn.click());
    await flush();
    expect(document.body.textContent).toContain('The quiz itself and student attempts are kept as ungraded.');
    const confirmDel = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Delete column');
    await act(async () => {
      confirmDel.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockDelete).toHaveBeenCalledWith('/classes/cls-1/gradebook/items/item-quiz');

    cleanup();
  });

  it('lets the teacher export student grades by weights from the Export dialog', async () => {
    const { container, cleanup } = renderGradebook();
    await flush();

    const exportBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Export'));
    expect(exportBtn).toBeTruthy();
    act(() => exportBtn.click());
    await flush();

    expect(document.body.textContent).toContain('Export student grades');
    expect(document.body.textContent).toContain('By weights');
    expect(document.body.textContent).toContain('Midterm (50%)');
    expect(document.body.textContent).toContain('Quizzes 40%, Assignments 60%');

    const downloadBtn = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Download'));
    await act(async () => {
      downloadBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockDownload).toHaveBeenCalledWith(
      '/classes/cls-1/gradebook/export',
      expect.objectContaining({ format: 'xlsx', by: 'weights' }),
      'gradebook-by-weights.xlsx',
    );

    cleanup();
  });

  it('lets the teacher upload and download a populated Word or Excel grade template', async () => {
    mockDownloadForm.mockClear();
    const { container, cleanup } = renderGradebook();
    await flush();

    const exportBtn = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Export'));
    act(() => exportBtn.click());
    await flush();

    expect(document.body.textContent).toContain('Fill your own template');
    expect(document.body.textContent).toContain('Word templates need a table with a header row.');
    const input = document.body.querySelector('input[type="file"]');
    const file = new File(['template bytes'], 'registrar.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const fillButton = [...document.body.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes('Fill template'));
    expect(fillButton.disabled).toBe(false);
    await act(async () => {
      fillButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockDownloadForm).toHaveBeenCalledWith(
      '/classes/cls-1/gradebook/export-template',
      { file },
      { by: 'weights' },
      'gradebook-by-weights-filled-grades.docx',
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    cleanup();
  });
});
