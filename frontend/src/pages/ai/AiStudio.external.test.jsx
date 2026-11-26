import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiStudio from '../AiStudio.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { get: apiGet, post: apiPost } }));
vi.mock('../../auth/AuthContext.jsx', () => ({ useAuth: () => ({ isAdmin: false }) }));

let root;
let container;

function setValue(control, value) {
  const prototype = control instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderPage(entry) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><AiStudio /></MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

function button(name) {
  return [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  container = null;
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  apiGet.mockReset().mockImplementation(async (path) => {
    if (path === '/ai/status') return { configured: false, provider: 'none', quota: null };
    if (path === '/ai/material' || path === '/classes' || path === '/question-banks') return [];
    throw new Error(`Unexpected request: ${path}`);
  });
  apiPost.mockReset();
});

describe('AI Studio external authoring', () => {
  it('lets a teacher copy an external quiz prompt and review the pasted questions without built-in AI', async () => {
    apiPost.mockImplementation(async (path, body) => {
      if (path === '/ai/questions/prompt') return { prompt: 'Write these questions as JSON.' };
      if (path === '/ai/questions/import') return {
        questions: [{ type: 'TRUE_FALSE', text: 'A byte contains eight bits.', answer: true, points: 1, difficulty: 'EASY' }],
        rejected: 0, skipped: 0, truncated: 0, source: null, needsReview: true,
      };
      throw new Error(`Unexpected request: ${path} ${JSON.stringify(body)}`);
    });

    await renderPage('/ai?tool=questions');
    const topic = container.querySelector('input[placeholder="e.g. Parts of the CPU and the fetch–execute cycle"]');
    await act(async () => { setValue(topic, 'Computer memory'); });
    expect(button('Draft with built-in AI').disabled).toBe(true);

    await act(async () => { button('Get prompt for external AI').click(); });
    await flush();
    expect(container.textContent).toContain('Write these questions as JSON.');
    expect(apiPost).toHaveBeenCalledWith('/ai/questions/prompt', expect.objectContaining({ topic: 'Computer memory', purpose: 'QUIZ' }));

    const response = container.querySelector('textarea[placeholder="Paste the AI\'s JSON response here..."]');
    await act(async () => { setValue(response, '{"questions":[{"type":"TRUE_FALSE"}]}'); });
    await act(async () => { button('Review questions from response').click(); });
    await flush();

    expect(apiPost).toHaveBeenCalledWith('/ai/questions/import', expect.objectContaining({ topic: 'Computer memory', pastedResponse: '{"questions":[{"type":"TRUE_FALSE"}]}' }));
    expect(container.textContent).toContain('A byte contains eight bits.');
    expect(container.textContent).toContain('draft question to review');
  });

  it('lets a teacher import an external assignment draft when no built-in AI is configured', async () => {
    apiPost.mockImplementation(async (path, body) => {
      if (path === '/ai/assignment/prompt') return { prompt: 'Write an assignment as JSON.' };
      if (path === '/ai/assignment/import') return { title: 'External assignment', instructionsHtml: '<p>Compare two examples.</p>', points: 50, rubric: null, source: null, needsReview: true };
      throw new Error(`Unexpected request: ${path} ${JSON.stringify(body)}`);
    });

    await renderPage('/ai?tool=assignment');
    const topic = container.querySelector('input[placeholder="e.g. A reflection essay on technology in daily life"]');
    await act(async () => { setValue(topic, 'Compare two examples'); });
    expect(button('Draft with built-in AI').disabled).toBe(true);

    await act(async () => { button('Get prompt for external AI').click(); });
    await flush();
    expect(container.textContent).toContain('Write an assignment as JSON.');
    expect(apiPost).toHaveBeenCalledWith('/ai/assignment/prompt', expect.objectContaining({ topic: 'Compare two examples', points: 100, withRubric: true }));

    const response = container.querySelector('textarea[placeholder="Paste the AI\'s JSON response here..."]');
    await act(async () => { setValue(response, '{"title":"External assignment","instructionsHtml":"<p>Compare two examples.</p>"}'); });
    await act(async () => { button('Review assignment draft').click(); });
    await flush();

    expect(apiPost).toHaveBeenCalledWith('/ai/assignment/import', expect.objectContaining({ topic: 'Compare two examples', pastedResponse: '{"title":"External assignment","instructionsHtml":"<p>Compare two examples.</p>"}' }));
    expect(container.textContent).toContain('External assignment');
    expect(container.textContent).toContain('Compare two examples.');
  });
});
