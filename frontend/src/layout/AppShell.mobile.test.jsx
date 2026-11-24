import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardHeader, Modal, Segmented, Tabs } from '../components/ui.jsx';
import AppShell from './AppShell.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const { authState, mockFetchBadges, mockApiGet } = vi.hoisted(() => ({
  authState: {
    user: { id: 'u1', role: 'STUDENT', name: 'Ana Reyes', email: 'ana@school.edu' },
    settings: { 'institution.name': 'Discenda Demo' },
    runtime: { realtime: false },
    logout: vi.fn(),
  },
  mockFetchBadges: vi.fn(),
  mockApiGet: vi.fn(),
}));

vi.mock('../auth/AuthContext.jsx', () => ({
  useAuth: () => authState,
}));

vi.mock('../lib/badges.js', () => ({
  fetchBadges: mockFetchBadges,
}));

vi.mock('../lib/api.js', () => ({
  api: {
    get: mockApiGet,
    post: vi.fn().mockResolvedValue({}),
  },
  fileUrl: (id) => `/files/${id}`,
}));

vi.mock('../lib/theme.js', () => ({
  useTheme: () => ({ preference: 'light', dark: false, setTheme: vi.fn() }),
}));

vi.mock('../lib/pwa.js', () => ({
  subscribeInstallPrompt: () => () => {},
  promptInstallPwa: vi.fn(),
}));

vi.mock('../lib/socket.js', () => ({
  useSocketEvent: () => {},
}));

const mounted = [];

function renderAt(ui, entry = '/') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          {ui}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const handle = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('Mobile navigation and responsive UI primitives', () => {
  beforeEach(() => {
    mockFetchBadges.mockResolvedValue({ messages: 4, notifications: 2 });
    mockApiGet.mockResolvedValue([]);
    authState.user = { id: 'u1', role: 'STUDENT', name: 'Ana Reyes', email: 'ana@school.edu' };
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop().unmount();
  });

  it('renders role-tailored mobile bottom navigation with unread message badge and drawer toggle', async () => {
    const { container } = renderAt(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>Dashboard page</div>} />
        </Route>
      </Routes>,
      '/',
    );
    await flush();

    const quickNav = container.querySelector('nav[aria-label="Quick navigation"]');
    expect(quickNav).toBeTruthy();
    const labels = [...quickNav.querySelectorAll('a, button')].map((el) => el.textContent);
    expect(labels.some((t) => t.includes('Home'))).toBe(true);
    expect(labels.some((t) => t.includes('Classes'))).toBe(true);
    expect(labels.some((t) => t.includes('Check in'))).toBe(true);
    expect(labels.some((t) => t.includes('Messages'))).toBe(true);
    expect(labels.some((t) => t.includes('Menu'))).toBe(true);
    expect(quickNav.querySelector('[aria-label="4 unread"]')).toBeTruthy();

    // Tapping Menu opens the mobile slide-over drawer.
    const menuBtn = [...quickNav.querySelectorAll('button')].find((b) => b.textContent.includes('Menu'));
    act(() => menuBtn.click());
    expect(container.querySelector('[role="dialog"][aria-label="Navigation"]')).toBeTruthy();
  });

  it('adapts mobile quick navigation for teachers and admins and hides it inside an open chat', async () => {
    authState.user = { id: 't1', role: 'TEACHER', name: 'Prof. Santos', email: 'santos@school.edu' };
    const teacherView = renderAt(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/messages" element={<div>Inbox</div>} />
        </Route>
      </Routes>,
      '/messages',
    );
    await flush();

    let quickNav = teacherView.container.querySelector('nav[aria-label="Quick navigation"]');
    expect(quickNav).toBeTruthy();
    expect(quickNav.textContent).toContain('Calendar');

    // Inside an active conversation (/messages?c=conv-1), hide the bottom bar so the composer has full space.
    const chatView = renderAt(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/messages" element={<div>Conversation</div>} />
        </Route>
      </Routes>,
      '/messages?c=conv-1',
    );
    await flush();
    expect(chatView.container.querySelector('nav[aria-label="Quick navigation"]')).toBeNull();
    expect(chatView.container.querySelector('main').className).toContain('max-lg:pb-3');

    authState.user = { id: 'a1', role: 'ADMIN', name: 'Admin Cruz', email: 'admin@school.edu' };
    const adminView = renderAt(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>Admin home</div>} />
        </Route>
      </Routes>,
      '/',
    );
    await flush();
    quickNav = adminView.container.querySelector('nav[aria-label="Quick navigation"]');
    expect(quickNav.textContent).toContain('Users');
    expect(quickNav.textContent).toContain('Classes');
  });

  it('adds right-edge fade mask on overflowing Tabs, safe wrapping on CardHeader/Segmented, and mobile Modal handle', () => {
    const origScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 320 });

    try {
      const { container } = renderAt(
        <>
          <Tabs
            tabs={[
              { value: 'a', label: 'Overview' },
              { value: 'b', label: 'Lessons' },
              { value: 'c', label: 'Assignments' },
            ]}
            value="a"
            onChange={() => {}}
          />
          <CardHeader title="Very long card title that wraps rather than clips" action={<button type="button">Action</button>} />
          <Segmented
            label="Filter"
            value="ALL"
            onChange={() => {}}
            options={[
              { value: 'ALL', label: 'All' },
              { value: 'ONE', label: 'Option One' },
            ]}
          />
          <Modal open onClose={() => {}} title="Mobile Sheet" footer={<button type="button">Save</button>}>
            <p>Sheet content</p>
          </Modal>
        </>,
      );

      const tablist = container.querySelector('[role="tablist"]');
      expect(tablist.style.maskImage).toContain('linear-gradient');

      const radiogroup = container.querySelector('[role="radiogroup"]');
      expect(radiogroup.className).toContain('max-w-full');
      expect(radiogroup.className).toContain('overflow-x-auto');

      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog.querySelector('.rounded-full.bg-line-strong')).toBeTruthy();
    } finally {
      if (origScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScrollWidth);
      if (origClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
    }
  });
});
