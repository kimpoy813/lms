import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuizResults from './QuizResults.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const { mockResults } = vi.hoisted(() => ({
  mockResults: {
    quiz: {
      id: 'quiz-1',
      title: 'Midterm exam',
      kind: 'EXAM',
      resultVisibility: 'IMMEDIATE',
      resultsPublishedAt: null,
      strictMode: true,
      violationWarnings: 0,
      passingPercent: null,
      totalPoints: 3,
    },
    stats: { submitted: 0, inProgress: 1, needsGrading: 0, canBeMarked: 0, violations: 0, average: null, highest: null, lowest: null, passed: 0 },
    students: [{
      student: { id: 'student-1', name: 'Ana Santos', firstName: 'Ana', lastName: 'Santos', studentNumber: 'S-1', enrollmentStatus: 'ENROLLED' },
      status: 'IN_PROGRESS',
      attempts: [{
        id: 'attempt-1',
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        startedAt: '2026-11-24T08:00:00.000Z',
        submittedAt: null,
        needsManualGrading: false,
        totalScore: null,
        maxScore: 3,
        terminated: null,
        reopened: null,
        violationCount: 0,
        progress: { answered: 1, total: 3 },
        lastSavedAt: '2026-11-24T08:05:00.000Z',
        deadlineAt: '2026-11-24T08:30:00.000Z',
      }],
      countedAttemptId: null,
      score: null,
      percent: null,
      passed: null,
      lastSubmittedAt: null,
    }],
  },
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ can: () => true }),
}));

vi.mock('./useClass.js', () => ({
  useClass: () => ({ cls: { id: 'class-1', status: 'ACTIVE' }, canManage: true, base: '/classes/class-1' }),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn((path) => (path === '/quizzes/quiz-1/results' ? Promise.resolve(mockResults) : Promise.resolve({}))),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    download: vi.fn().mockResolvedValue(undefined),
  },
}));

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderResults() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/classes/class-1/quizzes/quiz-1/results']}>
          <Routes>
            <Route path="/classes/:classId/quizzes/:quizId/results" element={<QuizResults />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('quiz live monitoring', () => {
  it('shows current question progress and lets the teacher follow an active attempt', async () => {
    const { container, cleanup } = renderResults();
    await flush();

    expect(container.textContent).toContain('Live monitoring');
    expect(container.textContent).toContain('1 student taking it now');
    expect(container.textContent).toContain('1 of 3 questions answered');
    expect(container.textContent).toContain('Last saved');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('33');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent.includes('Follow'))).toBe(true);

    cleanup();
  });
});
