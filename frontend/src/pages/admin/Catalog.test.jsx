import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminCatalog from './Catalog.jsx';
import Classes from '../classes/Classes.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'a1', role: 'ADMIN' },
    isStudent: false,
    isAdmin: true,
    isTeacher: false,
    can: () => true,
  }),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: mockGet,
    post: mockPost,
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

function setNativeValue(el, value) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

function render(ui, initialEntry = '/') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          {ui}
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

describe('course units decimal precision', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPost.mockResolvedValue({ id: 'created-1' });
    mockGet.mockImplementation((path) => {
      if (path === '/catalog/courses') return Promise.resolve([]);
      if (path === '/catalog/departments') return Promise.resolve([]);
      if (path === '/catalog/programs') return Promise.resolve([]);
      if (path === '/catalog/sections') return Promise.resolve([]);
      if (path === '/catalog/semesters') return Promise.resolve([{ id: 'sem-1', label: '1st Semester 2026-2027', isCurrent: true }]);
      if (path === '/admin/users') return Promise.resolve([{ id: 't1', name: 'Tess Teacher' }]);
      if (path === '/classes') return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it('allows creating a catalog course with 4.25 (and finer) decimal units', async () => {
    const { container, unmount } = render(<AdminCatalog />, '/admin/catalog?tab=courses');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    const newCourseBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('New course'));
    expect(newCourseBtn).toBeTruthy();
    act(() => newCourseBtn.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const codeInput = dialog.querySelector('input[placeholder="e.g. IT 101"]');
    const titleInput = dialog.querySelector('input[placeholder="e.g. Introduction to Computing"]');
    const unitsInput = dialog.querySelector('input[type="number"]');
    expect(unitsInput.getAttribute('step')).toBe('any');

    act(() => {
      setNativeValue(codeInput, 'PHYS 101L');
      setNativeValue(titleInput, 'Physics with Lab');
      setNativeValue(unitsInput, '4.25');
    });
    expect(unitsInput.checkValidity()).toBe(true);

    act(() => {
      setNativeValue(unitsInput, '4.125');
    });
    expect(unitsInput.checkValidity()).toBe(true);

    act(() => {
      setNativeValue(unitsInput, '4.25');
    });
    const form = dialog.querySelector('form');
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockPost).toHaveBeenCalledWith('/catalog/courses', expect.objectContaining({
      code: 'PHYS 101L',
      title: 'Physics with Lab',
      units: 4.25,
    }));
    unmount();
  });

  it('allows creating an inline new course with 4.25 units from New class dialog', async () => {
    const { container, unmount } = render(<Classes />, '/classes');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    const newClassBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('New class'));
    expect(newClassBtn).toBeTruthy();
    act(() => newClassBtn.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    const selects = [...dialog.querySelectorAll('select')];
    const courseSelect = selects[0];
    act(() => {
      setNativeValue(courseSelect, 'new');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const codeInput = dialog.querySelector('input[placeholder="IT 102"]');
    const titleInput = dialog.querySelector('input[placeholder="Computer Programming 1"]');
    const unitsInput = dialog.querySelector('input[type="number"]');
    expect(unitsInput.getAttribute('step')).toBe('any');

    const teacherSelect = [...dialog.querySelectorAll('select')][3];
    act(() => {
      setNativeValue(codeInput, 'CHEM 101');
      setNativeValue(titleInput, 'General Chemistry');
      setNativeValue(unitsInput, '4.25');
      setNativeValue(teacherSelect, 't1');
    });
    expect(unitsInput.checkValidity()).toBe(true);

    const form = dialog.querySelector('form#class-form');
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockPost).toHaveBeenCalledWith('/classes', expect.objectContaining({
      newCourse: { code: 'CHEM 101', title: 'General Chemistry', units: 4.25 },
    }));
    unmount();
  });
});
