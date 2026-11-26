import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Rubrics, { RubricDialog } from './Rubrics.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let root;
let container;

async function renderPage(ui) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const listRubric = {
  id: 'rubric-1', title: 'Essay rubric', description: 'A short writing guide', totalPoints: 10,
  criteria: [{ id: 'criterion-1', title: 'Evidence and clarity', description: 'Claims use clear evidence.', maxPoints: 10, levels: [{ title: 'Strong', points: 10, description: 'Clear and supported.' }] }],
  assignmentCount: 1, updatedAt: '2026-11-20T00:00:00.000Z',
};

const lockedRubric = {
  ...listRubric, locked: true,
  criteria: [{ ...listRubric.criteria[0], title: 'Reasoning', description: 'Use evidence carefully.' }],
};

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  container = null;
});

describe('Rubric management', () => {
  beforeEach(() => {
    apiGet.mockReset().mockImplementation(async (path) => {
      if (path === '/rubrics') return [listRubric];
      if (path === '/rubrics/rubric-1') return lockedRubric;
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('finds a rubric by one of its criteria', async () => {
    await renderPage(<Rubrics />);
    expect(document.body.textContent).toContain('Essay rubric');

    const search = document.querySelector('input[placeholder="Search rubrics and criteria…"]');
    await act(async () => { setInputValue(search, 'evidence'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });

    expect(document.body.textContent).toContain('Essay rubric');
    expect(document.body.textContent).toContain('Showing 1 of 1 rubric');
  });

  it('keeps graded criteria fixed while allowing the rubric name to change', async () => {
    await renderPage(<RubricDialog rubric={listRubric} onClose={() => {}} />);

    expect(document.body.textContent).toContain('Criteria are locked');
    const title = [...document.body.querySelectorAll('input')].find((input) => input.value === 'Essay rubric');
    const criterion = [...document.body.querySelectorAll('input')].find((input) => input.value === 'Reasoning');
    const points = [...document.body.querySelectorAll('input[type="number"]')].find((input) => input.value === '10');

    expect(title.disabled).toBe(false);
    expect(criterion.disabled).toBe(true);
    expect(points.disabled).toBe(true);
  });
});
