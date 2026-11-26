import { describe, expect, it } from 'vitest';
import { collectTextNodes, findQuoteRange, rangesForHighlights, normaliseText } from './highlights.js';

function build(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('highlight anchoring', () => {
  it('finds a quote that spans paragraph text', () => {
    const root = build('<div class="rich"><p>Cohesion keeps related logic together.</p><p>A second line.</p></div>');
    const { text, nodes } = collectTextNodes(root);
    const range = findQuoteRange(nodes, text, { quote: 'related logic', context: '' });
    expect(range).not.toBeNull();
    expect(text.slice(range.start, range.end)).toBe('related logic');
  });

  it('places a repeated quote using the words around it', () => {
    const root = build('<div class="rich"><p>The first idea is order. Another idea is order itself.</p></div>');
    const { text, nodes } = collectTextNodes(root);
    const first = findQuoteRange(nodes, text, { quote: 'idea', context: 'The first idea is order' });
    const second = findQuoteRange(nodes, text, { quote: 'idea', context: 'Another idea is order itself' });
    expect(first.start).toBeLessThan(second.start);
  });

  it('returns null when the words are gone', () => {
    const root = build('<div class="rich"><p>Nothing here.</p></div>');
    const { text, nodes } = collectTextNodes(root);
    expect(findQuoteRange(nodes, text, { quote: 'vanished words', context: '' })).toBeNull();
  });

  it('skips controls and merges overlapping marks', () => {
    const root = build('<div class="rich"><p>Alpha beta gamma</p><button data-highlight-ignore>Save</button></div>');
    const { text, nodes } = collectTextNodes(root);
    expect(text).not.toContain('Save');
    const ranges = rangesForHighlights(nodes, text, [
      { id: '1', quote: 'Alpha beta', context: '' },
      { id: '2', quote: 'beta gamma', context: '' },
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].overlapping).toBe(true);
    // Both marks are still accounted for, so neither is reported as missing from the text.
    expect(ranges[0].ids).toEqual(['1', '2']);
  });

  it('normalises whitespace', () => {
    expect(normaliseText('  a \n b\t')).toBe('a b');
  });
});
