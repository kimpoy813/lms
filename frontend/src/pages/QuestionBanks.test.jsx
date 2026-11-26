import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionBanks from './QuestionBanks.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), download: vi.fn() },
}));

let root;
let container;

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter><QuestionBanks /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  container = null;
});

describe('Question bank discovery', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue([
      { id: 'bank-math', title: 'Algebra review', subject: 'Mathematics', description: 'Linear equations', updatedAt: '2026-11-20T00:00:00.000Z', questionCount: 12, byType: { MULTIPLE_CHOICE: 8, TRUE_FALSE: 4 } },
      { id: 'bank-bio', title: 'Cell biology', subject: 'Science', description: 'Cells and organelles', updatedAt: '2026-11-21T00:00:00.000Z', questionCount: 8, byType: { IDENTIFICATION: 8 } },
    ]);
  });

  it('searches the collection and offers a clear path back to every bank', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('Algebra review');
    expect(document.body.textContent).toContain('Cell biology');

    const search = document.querySelector('input[placeholder="Search banks, subjects, descriptions…"]');
    await act(async () => { setInputValue(search, 'organelles'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });

    expect(document.body.textContent).toContain('Cell biology');
    expect(document.body.textContent).not.toContain('Algebra review');
    expect(document.body.textContent).toContain('Showing 1 of 2 banks');

    const clear = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Clear search and filters'));
    expect(clear).toBeTruthy();
    await act(async () => { clear.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });

    expect(document.body.textContent).toContain('Algebra review');
    expect(document.body.textContent).toContain('Cell biology');
  });
});
