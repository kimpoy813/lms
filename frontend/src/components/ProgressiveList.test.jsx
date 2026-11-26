import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressiveList } from './ui.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

function render(node) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ProgressiveList', () => {
  it('shows a compact first set, exposes the rest accessibly, and can collapse again', () => {
    const view = render(
      <ProgressiveList items={['Ana', 'Ben', 'Chen', 'Dina']} initialCount={2} moreLabel="student">
        {(name) => <li key={name}>{name}</li>}
      </ProgressiveList>,
    );

    const list = view.querySelector('ul');
    const button = view.querySelector('button');
    expect([...list.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['Ana', 'Ben']);
    expect(button.textContent).toBe('Show 2 more students');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(list.id);

    act(() => button.click());
    expect([...list.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['Ana', 'Ben', 'Chen', 'Dina']);
    expect(button.textContent).toBe('Show fewer');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    act(() => button.click());
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses singular wording when exactly one item is hidden', () => {
    const view = render(
      <ProgressiveList items={['Ana', 'Ben', 'Chen']} initialCount={2} moreLabel="item">
        {(item) => <li key={item}>{item}</li>}
      </ProgressiveList>,
    );

    expect(view.querySelector('button').textContent).toBe('Show 1 more item');
    act(() => view.querySelector('button').click());
    expect(view.querySelectorAll('li')).toHaveLength(3);
  });

  it('omits the expand control when all items are already visible', () => {
    const view = render(
      <ProgressiveList items={['Ana', 'Ben']} initialCount={2}>
        {(item) => <li key={item}>{item}</li>}
      </ProgressiveList>,
    );

    expect(view.querySelectorAll('li')).toHaveLength(2);
    expect(view.querySelector('button')).toBeNull();
  });
});
