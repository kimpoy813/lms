import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionDrafts from './QuestionDrafts.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), put: vi.fn() },
}));

let root;
let container;

const initialDrafts = () => [
  { key: 'draft-1', type: 'TRUE_FALSE', text: 'A byte contains eight bits.', answer: true, points: 1, difficulty: 'EASY', include: false },
  { key: 'draft-2', type: 'TRUE_FALSE', text: 'A kilobyte is smaller than a byte.', answer: false, points: 1, difficulty: 'EASY', include: false },
];

function Harness() {
  const [drafts, setDrafts] = useState(initialDrafts);
  return <QuestionDrafts drafts={drafts} setDrafts={setDrafts} defaultBankTitle="Digital systems" />;
}

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter><Harness /></MemoryRouter></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  container = null;
});

describe('AI question draft selection', () => {
  beforeEach(() => apiGet.mockReset().mockResolvedValue([]));

  it('selects or clears the whole draft set without losing the questions', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('0 of 2 selected');

    const selectAll = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Select all');
    await act(async () => { selectAll.click(); });
    expect(document.body.textContent).toContain('2 of 2 selected');
    expect([...document.body.querySelectorAll('input[type="checkbox"]')].every((input) => input.checked)).toBe(true);

    const clear = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Clear selection');
    await act(async () => { clear.click(); });
    expect(document.body.textContent).toContain('0 of 2 selected');
    expect(document.body.textContent).toContain('A byte contains eight bits.');
  });
});
