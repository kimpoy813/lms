import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockPut, mockPatch } = vi.hoisted(() => ({
  mockPut: vi.fn().mockResolvedValue({
    structure: {
      periods: [
        {
          id: 'p1',
          name: 'Midterm',
          weight: 50,
          lockedAt: null,
          categories: [{ id: 'c1', name: 'Quizzes', kind: 'QUIZ', weight: 100, items: [] }],
        },
        {
          id: 'p2',
          name: 'Finals',
          weight: 50,
          lockedAt: null,
          categories: [{ id: 'c2', name: 'Exam', kind: 'EXAM', weight: 100, items: [] }],
        },
      ],
    },
  }),
  mockPatch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 't1', role: 'TEACHER' }, can: () => true }),
}));

vi.mock('../useClass.js', () => ({
  classLabel: (c) => c?.label ?? 'CS 101 · Section A',
  useClass: () => ({
    cls: {
      id: 'cls-1',
      label: 'CS 101 · Section A',
      status: 'ACTIVE',
      course: { code: 'CS 101', title: 'Intro to CS' },
      section: { name: 'Section A' },
    },
    base: '/classes/cls-1',
    canManage: true,
  }),
}));

vi.mock('../../../lib/api.js', () => ({
  api: {
    get: vi.fn((path) => {
      if (path.endsWith('/templates')) return Promise.resolve([{ key: 'standard', label: 'Midterm 50% / Finals 50%' }]);
      if (path === '/catalog/grading-scales') {
        return Promise.resolve([
          { id: 's1', name: '1.00–5.00', isDefault: true, entries: [{ label: '1.00', minPercent: 97, isPassing: true }, { label: '5.00', minPercent: 0, isPassing: false }] },
        ]);
      }
      return Promise.resolve([]);
    }),
    put: mockPut,
    patch: mockPatch,
    post: vi.fn().mockResolvedValue({}),
  },
}));

const sampleData = {
  class: {
    usesDefaultScale: true,
    gradingScale: { id: 's1', name: '1.00–5.00', entries: [{ label: '1.00', minPercent: 97, isPassing: true }, { label: '5.00', minPercent: 0, isPassing: false }] },
    transmutationBase: 50,
    gradeRounding: 2,
    treatMissingAsZero: true,
    attendanceLateCredit: 0.5,
    attendanceAllowed: false,
    gradeRankingEnabled: true,
    gradeRankingShowScores: true,
    finalizedAt: null,
  },
  structure: {
    periods: [
      {
        id: 'p1',
        name: 'Midterm',
        weight: 50,
        lockedAt: null,
        categories: [
          { id: 'c1', name: 'Quizzes', kind: 'QUIZ', weight: 40, items: [] },
          { id: 'c2', name: 'Performance Tasks', kind: 'PROJECT', weight: 60, items: [] },
        ],
      },
      {
        id: 'p2',
        name: 'Finals',
        weight: 50,
        lockedAt: null,
        categories: [],
      },
    ],
  },
};

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
  mockPut.mockClear();
  mockPatch.mockClear();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Gradebook Setup (Weights and settings)', () => {
  it('renders spacious period, category, grading policy, and ranking cards with accessible controls', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Setup data={sampleData} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });

    await act(flush);

    expect(container.textContent).toContain('Grading periods and categories');
    expect(container.textContent).toContain('Grading policy');
    expect(container.textContent).toContain('Grade release ranking');
    expect(container.textContent).toContain('No categories yet. Add at least one category totaling 100%.');
    expect(container.querySelector('select[aria-label="Start from a template"]')).toBeTruthy();

    // Category rows expose explicit accessible weight labels without colliding with Field labels
    const quizWeight = container.querySelector('input[aria-label="Weight of Quizzes"]');
    expect(quizWeight?.value).toBe('40');

    // Empty period accepts adding a new category whose default weight fills to 100%
    const addCategoryButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent.includes('Add a category'));
    expect(addCategoryButtons).toHaveLength(2);
    await act(async () => {
      addCategoryButtons[1].click();
    });
    const newWeight = container.querySelector('input[aria-label="Weight of category"]');
    expect(newWeight?.value).toBe('100');

    // Policy & ranking actions still submit properly
    const savePolicyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Save policy'));
    await act(async () => {
      savePolicyBtn.click();
    });
    expect(mockPatch).toHaveBeenCalledWith(
      '/classes/cls-1/gradebook/settings',
      expect.objectContaining({ transmutationBase: 50, gradeRounding: 2, treatMissingAsZero: true }),
    );
  });
});
