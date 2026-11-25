import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningVisual, QuickCheck } from './LearningFeatures.jsx';

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

beforeEach(() => {
  container = null;
  root = null;
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

describe('interactive module learning features', () => {
  it('renders a labelled, responsive SVG pathway with accessible step text', () => {
    const view = render(<LearningVisual visual={{
      title: 'From light to glucose',
      description: 'A simplified energy pathway.',
      steps: ['Capture light energy', 'Build glucose', 'Store chemical energy'],
    }} />);

    expect(view.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('From light to glucose: Capture light energy, then Build glucose, then Store chemical energy');
    expect(view.querySelectorAll('svg[role="img"] rect')).toHaveLength(3);
    expect([...view.querySelectorAll('.sr-only li')].map((item) => item.textContent)).toEqual(['Capture light energy', 'Build glucose', 'Store chemical energy']);
    expect(view.querySelector('[role="region"][tabindex="0"]')).not.toBeNull();
  });

  it('checks a learner response and reveals clear, ungraded feedback', () => {
    const view = render(<QuickCheck check={{
      prompt: 'Where does glycolysis occur?',
      options: ['In the cytoplasm', 'In the mitochondrial matrix', 'In the nucleus'],
      correctIndex: 0,
      explanation: 'Glycolysis takes place in the cytoplasm.',
    }} />);

    const radios = [...view.querySelectorAll('input[type="radio"]')];
    const checkButton = [...view.querySelectorAll('button')].find((button) => button.textContent.includes('Check answer'));
    expect(checkButton.disabled).toBe(true);
    act(() => radios[1].click());
    expect(checkButton.disabled).toBe(false);
    act(() => checkButton.click());
    expect(view.textContent).toContain('Not quite. The best answer is “In the cytoplasm”.');
    expect(view.textContent).toContain('Glycolysis takes place in the cytoplasm.');
    expect(view.querySelector('[role="status"]').getAttribute('aria-live')).toBe('polite');

    const retry = [...view.querySelectorAll('button')].find((button) => button.textContent.includes('Try again'));
    act(() => retry.click());
    expect(view.querySelector('[role="status"]')).toBeNull();
    expect(view.querySelector('input[type="radio"]:checked')).toBeNull();
  });
});
