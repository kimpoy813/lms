import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssignmentDraftDialog from './AssignmentDraftDialog.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiDelete, apiPost } = vi.hoisted(() => ({ apiDelete: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { delete: apiDelete, post: apiPost } }));
vi.mock('../../components/LazyEditor.jsx', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

let root;
let container;

function render(ui) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('AssignmentDraftDialog', () => {
  beforeEach(() => {
    apiDelete.mockReset().mockResolvedValue(null);
    apiPost.mockReset().mockImplementation(async (path, body) => {
      if (path === '/rubrics') return { id: 'rubric-1', totalPoints: body.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0) };
      if (path === '/classes/class-1/assignments') return { id: 'assignment-1', title: body.title };
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    container = null;
  });

  it('creates an unpublished assignment with a linked starter rubric from activity text', async () => {
    const onCreated = vi.fn();
    render(
      <AssignmentDraftDialog
        source={{ title: 'Threat-model exercise', instructions: 'List the assets.\n\nExplain one likely threat.' }}
        sourceNumber={1}
        moduleTitle="Information security"
        classes={[{ id: 'class-1', course: { code: 'CS101' }, section: { name: 'A' } }]}
        defaultClassId="class-1"
        moduleId="module-1"
        moduleClassId="class-1"
        onClose={() => {}}
        onCreated={onCreated}
      />,
    );

    const createButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment and rubric'));
    expect(createButton).toBeTruthy();
    expect(createButton.disabled).toBe(false);
    act(() => createButton.click());
    await flush();

    expect(apiPost).toHaveBeenNthCalledWith(1, '/rubrics', expect.objectContaining({
      title: 'Threat-model exercise — Starter rubric',
      criteria: expect.arrayContaining([expect.objectContaining({ title: 'Understanding and accuracy' })]),
    }));
    const rubricBody = apiPost.mock.calls[0][1];
    expect(rubricBody.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0)).toBe(100);
    expect(apiPost).toHaveBeenNthCalledWith(2, '/classes/class-1/assignments', expect.objectContaining({
      title: 'Threat-model exercise',
      instructionsHtml: '<p>List the assets.</p><p>Explain one likely threat.</p>',
      status: 'DRAFT',
      rubricId: 'rubric-1',
      moduleId: 'module-1',
      points: 100,
    }));
    expect(onCreated).toHaveBeenCalledWith({ id: 'assignment-1', title: 'Threat-model exercise' }, 'class-1', true);
  });

  it('creates a draft assignment from rich lesson content before the lesson is published', async () => {
    const onCreated = vi.fn();
    const contentHtml = '<h2>Draft chapter</h2><p>Explain how the system works.</p>';
    render(
      <AssignmentDraftDialog
        source={{ title: 'Draft chapter', instructionsHtml: contentHtml }}
        sourceNumber={1}
        moduleTitle="Information security"
        classes={[{ id: 'class-1', course: { code: 'CS101' }, section: null }]}
        defaultClassId="class-1"
        moduleId="module-1"
        moduleClassId="class-1"
        sourceLabel="lesson"
        onClose={() => {}}
        onCreated={onCreated}
      />,
    );

    expect(document.body.textContent).toContain('Create an assignment from this lesson');
    expect(document.body.querySelector('[aria-label="Assignment instructions"]').value).toBe(contentHtml);
    const createButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment and rubric'));
    expect(createButton.disabled).toBe(false);
    act(() => createButton.click());
    await flush();

    expect(apiPost).toHaveBeenNthCalledWith(2, '/classes/class-1/assignments', expect.objectContaining({
      title: 'Draft chapter',
      instructionsHtml: contentHtml,
      status: 'DRAFT',
      rubricId: 'rubric-1',
      moduleId: 'module-1',
    }));
    expect(onCreated).toHaveBeenCalledWith({ id: 'assignment-1', title: 'Draft chapter' }, 'class-1', true);
  });

  it('removes the newly created rubric if saving the assignment fails', async () => {
    apiPost.mockImplementation(async (path, body) => {
      if (path === '/rubrics') return { id: 'rubric-1', totalPoints: body.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0) };
      throw new Error('Assignment could not be saved.');
    });
    render(
      <AssignmentDraftDialog
        source={{ title: 'Threat-model exercise', instructions: 'List the assets.' }}
        sourceNumber={1}
        moduleTitle="Information security"
        classes={[{ id: 'class-1', course: { code: 'CS101' }, section: null }]}
        defaultClassId="class-1"
        moduleId={null}
        moduleClassId={null}
        onClose={() => {}}
      />,
    );

    const createButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment and rubric'));
    expect(createButton).toBeTruthy();
    act(() => createButton.click());
    await flush();

    expect(apiDelete).toHaveBeenCalledWith('/rubrics/rubric-1');
    expect(document.body.textContent).toContain('Assignment could not be saved.');
  });
});
