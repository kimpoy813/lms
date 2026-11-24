import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssignmentDraftDialog from './AssignmentDraftDialog.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiDelete, apiGet, apiPost } = vi.hoisted(() => ({ apiDelete: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { delete: apiDelete, get: apiGet, post: apiPost } }));
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
    apiGet.mockReset().mockImplementation(async (path) => {
      if (path === '/classes/class-1/gradebook/categories') {
        return [{ id: 'period-1', name: 'Midterm', locked: false, categories: [{ id: 'category-1', name: 'Assignments', weight: 60 }] }];
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    apiPost.mockReset().mockImplementation(async (path, body) => {
      if (path === '/rubrics') return { id: 'rubric-1', totalPoints: body.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0) };
      if (path === '/classes/class-1/assignments') return {
        id: 'assignment-1',
        title: body.title,
        gradeCategory: body.categoryId ? { id: body.categoryId } : null,
      };
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
    expect(document.body.textContent).toContain('not counted in the gradebook');
    expect(document.body.textContent).toContain('Teachers can still score it with a rubric or manually, but the score will not count toward class grades.');
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
    expect(apiPost.mock.calls[1][1]).not.toHaveProperty('categoryId');
    expect(onCreated).toHaveBeenCalledWith({ id: 'assignment-1', title: 'Threat-model exercise', gradeCategory: null }, 'class-1', true);
  });

  it('lets a teacher include the draft in the gradebook by choosing a category', async () => {
    const onCreated = vi.fn();
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
        onCreated={onCreated}
      />,
    );
    await flush();

    const gradebookLabel = [...document.body.querySelectorAll('label')].find((label) => label.textContent.includes('Count this assignment toward the gradebook'));
    const gradebookCheckbox = document.getElementById(gradebookLabel.htmlFor);
    expect(gradebookCheckbox.checked).toBe(false);
    act(() => gradebookCheckbox.click());
    await flush();

    const categorySelect = [...document.body.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'category-1'));
    expect(categorySelect).toBeTruthy();
    act(() => {
      categorySelect.value = 'category-1';
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const createButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment and rubric'));
    expect(createButton.disabled).toBe(false);
    act(() => createButton.click());
    await flush();

    expect(apiPost).toHaveBeenNthCalledWith(2, '/classes/class-1/assignments', expect.objectContaining({
      title: 'Threat-model exercise',
      status: 'DRAFT',
      categoryId: 'category-1',
    }));
    expect(onCreated).toHaveBeenCalledWith(
      { id: 'assignment-1', title: 'Threat-model exercise', gradeCategory: { id: 'category-1' } },
      'class-1',
      true,
    );
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
    expect(onCreated).toHaveBeenCalledWith({ id: 'assignment-1', title: 'Draft chapter', gradeCategory: null }, 'class-1', true);
  });

  it('attaches the activity rubric read from the lesson HTML instead of making a starter rubric', async () => {
    const onCreated = vi.fn();
    const contentHtml = '<h2>Lesson rubric</h2><table><thead><tr><th>Criterion</th><th>Excellent (4 points)</th><th>Developing (2 points)</th></tr></thead><tbody><tr><th>Accuracy (4 points)</th><td>Correct and complete.</td><td>Some errors.</td></tr><tr><th>Evidence (6 points)</th><td>Supports claims.</td><td>Limited support.</td></tr></tbody></table>';
    render(
      <AssignmentDraftDialog
        source={{ title: 'Threat-model exercise', instructionsHtml: contentHtml }}
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

    expect(document.body.textContent).toContain('The rubric found in this lesson (2 criteria, 10 points)');
    expect(document.body.textContent).toContain('Attach the lesson rubric');
    const pointsInput = document.body.querySelector('input[type="number"]');
    expect(pointsInput.value).toBe('10');
    expect(pointsInput.disabled).toBe(true);
    const createButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent.includes('Create assignment and rubric'));
    expect(createButton.disabled).toBe(false);
    act(() => createButton.click());
    await flush();

    expect(apiPost).toHaveBeenNthCalledWith(1, '/rubrics', {
      title: 'Lesson rubric',
      description: '',
      criteria: [
        {
          title: 'Accuracy', description: '', maxPoints: 4,
          levels: [
            { title: 'Excellent', points: 4, description: 'Correct and complete.' },
            { title: 'Developing', points: 2, description: 'Some errors.' },
          ],
        },
        {
          title: 'Evidence', description: '', maxPoints: 6,
          levels: [
            { title: 'Excellent', points: 4, description: 'Supports claims.' },
            { title: 'Developing', points: 2, description: 'Limited support.' },
          ],
        },
      ],
    });
    expect(apiPost).toHaveBeenNthCalledWith(2, '/classes/class-1/assignments', expect.objectContaining({
      title: 'Threat-model exercise',
      instructionsHtml: contentHtml,
      status: 'DRAFT',
      rubricId: 'rubric-1',
      moduleId: 'module-1',
      points: 10,
    }));
    expect(onCreated).toHaveBeenCalledWith({ id: 'assignment-1', title: 'Threat-model exercise', gradeCategory: null }, 'class-1', true);
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
