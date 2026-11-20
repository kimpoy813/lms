import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import People from './People.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockPeople, mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn().mockResolvedValue({}),
  mockPeople: {
    teacher: { id: 't1', name: 'Tess Teacher', email: 'tess@test.edu' },
    canManage: true,
    classmatesVisible: true,
    gradesFinalized: false,
    invitations: [],
    students: [
      {
        enrollmentId: 'e1',
        id: 's1',
        name: 'Juan Dela Cruz',
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        email: 'juan@test.edu',
        accountStatus: 'ACTIVE',
        status: 'ENROLLED',
        studentNumber: '2026-0001',
        enrolledAt: '2026-08-01T00:00:00.000Z',
      },
      {
        enrollmentId: 'e2',
        id: 's2',
        name: 'Maria Clara',
        firstName: 'Maria',
        lastName: 'Clara',
        email: 'maria@test.edu',
        accountStatus: 'ACTIVE',
        status: 'DROPPED',
        studentNumber: '2026-0002',
        enrolledAt: '2026-08-01T00:00:00.000Z',
        droppedAt: '2026-10-15T00:00:00.000Z',
        note: 'Need final grade later',
      },
    ],
  },
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 't1', role: 'TEACHER' }, isStudent: false, isAdmin: false, isTeacher: true, can: () => true }),
}));

vi.mock('./useClass.js', () => ({
  useClass: () => ({ cls: { id: 'cls-1', status: 'ACTIVE', enrollmentCode: 'ABC123' }, canManage: true, isStudent: false, base: '/classes/cls-1' }),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn().mockResolvedValue(mockPeople),
    post: mockPost,
    delete: vi.fn().mockResolvedValue({}),
  },
}));

function renderPeople() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <People />
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

describe('People roster drop vs remove', () => {
  it('keeps dropped students in the roster table with Dropped badge and offers both Drop and Remove', async () => {
    const { container, unmount } = renderPeople();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(container.textContent).toContain('Dela Cruz, Juan');
    expect(container.textContent).toContain('Clara, Maria');
    expect(container.textContent).toContain('Dropped');
    expect(container.textContent).toContain('Need final grade later');
    expect(container.textContent).toContain('1 student enrolled · 1 dropped');

    const juanMenuBtn = container.querySelector('button[aria-label="Actions for Juan Dela Cruz"]');
    expect(juanMenuBtn).toBeTruthy();
    act(() => juanMenuBtn.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.body.textContent).toContain('Drop from class');
    expect(document.body.textContent).toContain('Remove from class');
    expect(document.body.textContent).toContain('View grades');

    const dropBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Drop from class'));
    act(() => dropBtn.click());
    expect(document.body.textContent).toContain('remains on your class roster and gradebook');

    const cancelBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel');
    act(() => cancelBtn.click());

    const mariaMenuBtn = container.querySelector('button[aria-label="Actions for Maria Clara"]');
    expect(mariaMenuBtn).toBeTruthy();
    act(() => mariaMenuBtn.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.body.textContent).toContain('Reinstate to class');
    expect(document.body.textContent).toContain('Remove from class');

    const removeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Remove from class'));
    act(() => removeBtn.click());
    expect(document.body.textContent).toContain('completely removed from this class');
    expect(document.body.textContent).toContain('choose Drop instead');

    unmount();
  });
});
