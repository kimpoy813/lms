import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDialog } from './Programming.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock('../components/LazyCodeEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

let root;
let container;

async function renderDialog(problemId = null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ProblemDialog problemId={problemId} languages={[{ id: 'PYTHON', label: 'Python 3' }]} onClose={() => {}} /></MemoryRouter>
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

describe('Coding problem editing', () => {
  beforeEach(() => apiGet.mockReset());

  it('does not replace a problem that failed to load with a blank editor', async () => {
    apiGet.mockImplementation(async (path) => {
      if (path === '/programming/problems/problem-1') throw new Error('Network unavailable');
      return [];
    });
    await renderDialog('problem-1');

    expect(document.body.textContent).toContain('Could not load this problem');
    expect(document.body.textContent).toContain('Network unavailable');
    expect(document.body.querySelector('textarea[aria-label="Problem statement"]')).toBeNull();
    expect([...document.body.querySelectorAll('button')].some((button) => button.textContent.includes('Try again'))).toBe(true);
  });

  it('requires at least one positively weighted test before saving', async () => {
    apiGet.mockImplementation(async (...args) => {
      const [path] = args;
      if (path === '/programming/status') return { configured: true, totalTimeLimitMs: 60_000, languages: [{ id: 'PYTHON', label: 'Python 3' }] };
      if (path === '/classes') return [];
      return [];
    });
    await renderDialog();

    const title = document.querySelector('input[placeholder="e.g. Sum of an array"]');
    await act(async () => { setInputValue(title, 'Sum of an array'); });
    const weights = [...document.body.querySelectorAll('input[type="number"][min="0"][max="100"]')];
    expect(weights).toHaveLength(2);
    await act(async () => {
      for (const weight of weights) setInputValue(weight, '0');
    });

    expect(document.body.textContent).toContain('Give a positive weight to at least one test');
    const save = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create problem'));
    expect(save.disabled).toBe(true);
  });
});
