import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import Calendar from './Calendar.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn().mockResolvedValue({ id: 'ev-new', notifiedStudents: 30 }),
  mockGet: vi.fn((path) => {
    if (path === '/calendar/overlapping-classes') {
      return Promise.resolve({
        timeZone: 'Asia/Manila',
        totalOverlappingClasses: 2,
        totalAffectedStudents: 30,
        overlapping: [
          {
            classId: 'c1',
            label: 'CS 101 · A',
            title: 'Intro to CS',
            color: 'blue',
            studentCount: 20,
            hits: [{ date: '2026-12-15', startTime: '09:00', endTime: '10:30' }],
          },
          {
            classId: 'c2',
            label: 'IT 201 · B',
            title: 'Systems',
            color: 'emerald',
            studentCount: 15,
            hits: [{ date: '2026-12-15', startTime: '13:00', endTime: '14:30' }],
          },
        ],
        otherClasses: [
          {
            classId: 'c3',
            label: 'CS 103 · C',
            title: 'Algorithms',
            color: 'amber',
            studentCount: 12,
            hits: [],
          },
        ],
      });
    }
    if (path === '/calendar') {
      return Promise.resolve([
        {
          id: 'event:ev-future',
          eventId: 'ev-future',
          kind: 'EVENT',
          type: 'TEACHER_LEAVE',
          scope: 'CLASSES',
          title: 'Regional faculty conference',
          description: 'Async reading posted',
          startAt: '2026-12-15T00:00:00.000Z',
          endAt: '2026-12-15T15:59:00.000Z',
          allDay: true,
          classLabel: 'CS 101 · A, IT 201 · B',
          affectedClasses: [
            { id: 'c1', label: 'CS 101 · A', color: 'blue' },
            { id: 'c2', label: 'IT 201 · B', color: 'emerald' },
          ],
          affectedClassIds: ['c1', 'c2'],
          canEdit: true,
        },
      ]);
    }
    if (path === '/tasks') return Promise.resolve([]);
    if (path === '/classes') return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

vi.mock('../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'teacher-1', role: 'TEACHER' },
    isStudent: false,
    isAdmin: false,
  }),
}));

vi.mock('../lib/api.js', () => ({
  api: {
    get: mockGet,
    post: mockPost,
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    download: vi.fn().mockResolvedValue(undefined),
  },
}));

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

async function renderCalendar(initialEntry = '/calendar') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Calendar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Calendar teacher leave and overlapping classes', () => {
  it('shows Leave / Notice modal, previews overlapping classes & students, and posts scope CLASSES', async () => {
    mockPost.mockClear();
    const { container, cleanup } = await renderCalendar('/calendar?date=2026-12-15');
    try {
      // Deep link jumps straight to December 2026 and shows the future event.
      expect(container.textContent).toContain('December 2026');
      expect(container.textContent).toContain('Regional faculty conference');
      expect(container.textContent).toContain('Teacher unavailable');

      const leaveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Leave / Notice'));
      expect(leaveBtn).toBeTruthy();
      await act(async () => { leaveBtn.click(); });
      await flush();

      expect(document.body.textContent).toContain('Report leave / class notice');
      expect(document.body.textContent).toContain('Classes hit by this schedule');
      expect(document.body.textContent).toContain('CS 101 · A');
      expect(document.body.textContent).toContain('IT 201 · B');
      expect(document.body.textContent).toContain('2 classes selected · 30 students will see & be notified');
      expect(document.body.textContent).toContain('Include other classes without overlap (1)');

      const titleInput = document.body.querySelector('input[placeholder*="sick leave"]');
      expect(titleInput).toBeTruthy();
      await act(async () => { setInputValue(titleInput, 'Attending conference'); });

      const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add event');
      expect(submitBtn.disabled).toBe(false);
      await act(async () => { submitBtn.click(); });
      await flush();

      expect(mockPost).toHaveBeenCalledWith('/calendar/events', expect.objectContaining({
        scope: 'CLASSES',
        type: 'TEACHER_LEAVE',
        title: 'Attending conference',
        classIds: ['c1', 'c2'],
        notifyStudents: true,
      }));
    } finally {
      cleanup();
    }
  });
});
