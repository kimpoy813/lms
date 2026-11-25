import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClassLayout from './ClassLayout.jsx';
import ClassSettings from './ClassSettings.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  classData: {
    id: 'class-1',
    myRole: 'TEACHER',
    status: 'ARCHIVED',
    color: 'indigo',
    course: { id: 'course-1', code: 'CS 101', title: 'Fundamentals of Programming' },
    section: { id: 'section-1', name: 'BSCS 1A' },
    semester: { id: 'semester-1', name: 'First Semester' },
    teacher: { id: 'teacher-1', name: 'Kim Dave Rafael', avatarFileId: null },
    schedules: [],
    room: null,
    description: '',
    enrollmentCode: 'CS101A',
    enrollmentCodeEnabled: true,
    enrollmentRequiresApproval: false,
    classmatesVisible: true,
    aiStudyCoachEnabled: false,
    gradeRankingEnabled: false,
    gradeRankingShowScores: true,
    syllabusHtml: '',
    learningOutcomes: [],
  },
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ isAdmin: false, can: () => false }),
}));

vi.mock('../../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn((path) => Promise.resolve(path === '/classes' ? [] : mockState.classData)),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

let root;
let container;
let client;
let originalScrollIntoView;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) act(() => root.unmount());
  client?.clear();
  container?.remove();
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
  else delete Element.prototype.scrollIntoView;
  root = null;
  container = null;
});

describe('class-wide archived status messaging', () => {
  it('shows one contextual archive notice on the settings page', async () => {
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/classes/class-1/settings']}>
          <Routes>
            <Route path="/classes/:classId" element={<ClassLayout />}>
              <Route path="settings" element={<ClassSettings />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

    expect(container.textContent.match(/This class is archived/g)).toHaveLength(1);
    expect(container.textContent).toContain('Use “Restore class” at the bottom of this page to edit settings.');
    expect(container.textContent).not.toContain('Restore it below before changing its settings.');
  });
});
