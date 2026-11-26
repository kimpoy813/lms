// Highlights inside lesson text.
//
// A highlight is stored as the words the reader marked (the quote) plus a little of the text around
// them, and is found again by searching the lesson's text for those words. Nothing is stored about
// where on the page the words were: that changes with the width of the window, the font and the
// page layout. This keeps a highlight in place after a small edit and makes it disappear quietly
// when the words themselves are gone.

export const HIGHLIGHT_COLORS = [
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'pink', label: 'Pink' },
];

export const DEFAULT_HIGHLIGHT_COLOR = 'yellow';

export const isHighlightColor = (value) => HIGHLIGHT_COLORS.some((colour) => colour.value === value);

/** One line, single spaces, as the server stores it. */
export function normaliseText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Every text node under `root`, in reading order, with its offset in the joined text of the page.
 * An element marked `data-highlight-ignore` (a control, a panel) and everything inside it is skipped.
 */
export function collectTextNodes(root) {
  if (!root || typeof document === 'undefined') return { text: '', nodes: [] };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      // The root itself may be the element that was marked, so it is not consulted — only its
      // descendants are, and they belong to the page when it does.
      if (node.parentElement?.closest?.('[data-highlight-ignore]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    // The end of a block reads as a space, so a quote never runs two paragraphs together and every
    // offset in `text` maps to one place in the page.
    if (nodes.length) text += ' ';
    nodes.push({ node, start: text.length, end: text.length + node.textContent.length });
    text += node.textContent;
  }
  return { text, nodes };
}

/**
 * Where each character of the whitespace-collapsed text sits in the page text. A run of spaces,
 * tabs or line breaks counts once, so the two strings have the same length and every position in
 * one names a position in the other.
 */
function collapsedPositions(text) {
  const positions = [];
  let afterSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const isSpace = /\s/.test(text[index]);
    if (isSpace && afterSpace) continue;
    positions.push(index);
    afterSpace = isSpace;
  }
  return positions;
}

const CONTEXT_LENGTH = 40;

/** How many trailing characters of `a` are the trailing characters of `b`. */
function commonSuffix(a, b) {
  const max = Math.min(a.length, b.length);
  let count = 0;
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

/** How many leading characters of `a` are the leading characters of `b`. */
function commonPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let count = 0;
  while (count < max && a[count] === b[count]) count += 1;
  return count;
}

/**
 * Where a highlight belongs in this page text, or null when its words are not there. A quote that
 * appears more than once is placed by the words that surrounded it when it was made.
 */
export function findQuoteRange(nodes, text, { quote, context }) {
  const needle = normaliseText(quote);
  if (!needle || !text) return null;
  const haystack = text.replace(/\s+/g, ' ');
  if (!haystack.includes(needle)) return null;

  const matches = [];
  let from = 0;
  while (matches.length < 50) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    matches.push(at);
    from = at + 1;
  }
  if (!matches.length) return null;
  let compactStart = matches[0];

  if (matches.length > 1) {
    // The stored context is `some words before` + quote + `some words after`.
    const hint = normaliseText(context);
    const hintAt = hint.indexOf(needle);
    const before = hintAt > 0 ? hint.slice(0, hintAt) : '';
    const after = hintAt >= 0 ? hint.slice(hintAt + needle.length) : '';
    if (before || after) {
      let best = { at: matches[0], score: 0 };
      for (const at of matches) {
        const beforeWindow = haystack.slice(Math.max(0, at - before.length), at);
        const afterWindow = haystack.slice(at + needle.length, at + needle.length + after.length);
        const score = commonSuffix(before, beforeWindow) + commonPrefix(after, afterWindow);
        if (score > best.score) best = { at, score };
      }
      compactStart = best.at;
    }
  }

  const positions = collapsedPositions(text);
  const start = positions[compactStart];
  const lastIndex = positions[Math.min(compactStart + needle.length - 1, positions.length - 1)];
  const end = lastIndex + 1;
  if (!Number.isFinite(start) || !(end > start)) return null;
  return { start, end };
}

/**
 * Split a page's text into ranges for each highlight, so the DOM can be marked up in one pass.
 * Overlapping highlights are merged into one mark (the browser cannot nest them cleanly).
 */
export function rangesForHighlights(nodes, text, highlights) {
  const ranges = [];
  for (const highlight of highlights ?? []) {
    const range = findQuoteRange(nodes, text, highlight);
    if (!range) continue;
    ranges.push({ ...range, highlight, ids: [highlight.id] });
  }
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start < last.end) {
      // Two marks that touch become one painted mark; both still belong to the list.
      last.end = Math.max(last.end, range.end);
      last.ids = [...last.ids, ...range.ids];
      last.overlapping = true;
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** The words around a selection, used to place a quote that appears more than once. */
export function selectionContext(container, range) {
  const { text } = collectTextNodes(container);
  const full = range.toString().replace(/\s+/g, ' ');
  const flat = text.replace(/\s+/g, ' ');
  const quote = normaliseText(range.toString());
  const at = flat.indexOf(quote);
  if (at < 0) return '';
  const before = flat.slice(Math.max(0, at - CONTEXT_LENGTH), at);
  const after = flat.slice(at + quote.length, at + quote.length + CONTEXT_LENGTH);
  return normaliseText(`${before}${full}${after}`).slice(0, 500);
}
