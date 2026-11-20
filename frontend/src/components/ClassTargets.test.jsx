import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AlsoPostToClasses, PostToClassesModal } from './ClassTargets.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockClasses = vi.hoisted(() => [
  { id: 'c1', status: 'ACTIVE', color: '#4f46e5', course: { code: 'IT 101', title: 'Intro to Computing' }, section: { name: 'BSIT 1A' }, semester: { name: '1st Sem' } },
  { id: 'c2', status: 'ACTIVE', color: '#059669', course: { code: 'IT 101', title: 'Intro to Computing' }, section: { name: 'BSIT 1B' }, semester: { name: '1st Sem' } },
  { id: 'c3', status: 'ACTIVE', color: '#d97706', course: { code: 'IT 101', title: 'Intro to Computing' }, section: { name: 'BSIT 1C' }, semester: { name: '1st Sem' } },
]);

vi.mock('../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 't1', role: 'TEACHER' } }),
}));

vi.mock('../lib/api.js', () => ({
  api: {
    get: vi.fn().mockResolvedValue(mockClasses),
  },
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

function renderWithQuery(node) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return {
    container,
    rerender: (nextNode) => {
      act(() => {
        root.render(<QueryClientProvider client={queryClient}>{nextNode}</QueryClientProvider>);
      });
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ClassTargets multi-class selection components', () => {
  it('lists other active classes, excludes the current class, and supports Select all / Clear all', async () => {
    let latest = [];
    const onChange = vi.fn((next) => { latest = next; });
    const view = renderWithQuery(
      <AlsoPostToClasses excludeClassId="c1" value={latest} onChange={onChange} hint="Matched automatically." />,
    );
    await flush();

    expect(view.container.textContent).toContain('Also post to other classes');
    expect(view.container.textContent).not.toContain('BSIT 1A');
    expect(view.container.textContent).toContain('BSIT 1B');
    expect(view.container.textContent).toContain('BSIT 1C');

    const selectAllBtn = [...view.container.querySelectorAll('button')].find((b) => b.textContent.includes('Select all'));
    expect(selectAllBtn).toBeTruthy();
    act(() => selectAllBtn.click());
    expect(onChange).toHaveBeenLastCalledWith(['c2', 'c3']);

    view.rerender(<AlsoPostToClasses excludeClassId="c1" value={['c2', 'c3']} onChange={onChange} />);
    await flush();
    expect(view.container.textContent).toContain('+2 classes');
    const clearBtn = [...view.container.querySelectorAll('button')].find((b) => b.textContent.includes('Clear all'));
    act(() => clearBtn.click());
    expect(onChange).toHaveBeenLastCalledWith([]);

    view.cleanup();
  });

  it('posts selected classes and status from PostToClassesModal and blocks publishing empty quizzes', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();

    // 1. Empty quiz (canPublish=false): cannot switch to PUBLISHED.
    const emptyQuizView = renderWithQuery(
      <PostToClassesModal
        open
        onClose={onClose}
        excludeClassId="c1"
        canPublish={false}
        publishDisabledReason="Add at least one question before publishing immediately."
        onSubmit={onSubmit}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain('Add at least one question before publishing immediately.');
    const checkboxes = [...document.body.querySelectorAll('[role="dialog"] input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    act(() => {
      checkboxes[0].click();
    });
    const publishRadio = [...document.body.querySelectorAll('[role="radio"]')].find((b) => b.textContent.includes('Publish immediately'));
    act(() => publishRadio.click());
    const postBtn = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Post to 1 class'));
    await act(async () => {
      postBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).toHaveBeenCalledWith({ targetClassIds: ['c2'], status: 'DRAFT' });
    emptyQuizView.cleanup();

    // 2. Publishable item: chooses Publish immediately and posts to both classes.
    onSubmit.mockClear();
    const readyView = renderWithQuery(
      <PostToClassesModal
        open
        onClose={onClose}
        excludeClassId="c1"
        canPublish
        defaultStatus="PUBLISHED"
        onSubmit={onSubmit}
      />,
    );
    await flush();
    const allBtn = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Select all'));
    act(() => allBtn.click());
    const submitBoth = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Post to 2 classes'));
    await act(async () => {
      submitBoth.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSubmit).toHaveBeenCalledWith({ targetClassIds: ['c2', 'c3'], status: 'PUBLISHED' });
    readyView.cleanup();
  });
});
