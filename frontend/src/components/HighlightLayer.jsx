// Marks the words a reader highlighted inside a piece of lesson text and offers a small action when
// they select new words.
//
// The marks are painted into the rendered text after it is drawn (the HTML itself is never changed),
// and they are painted again whenever the page re-flows: a different window width, a different page
// in a two-page spread, or another text size all move the words. The range arithmetic lives in
// lib/highlights.js.
import { Highlighter, MessageSquarePlus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  collectTextNodes,
  isHighlightColor,
  normaliseText,
  rangesForHighlights,
  selectionContext,
} from '../lib/highlights.js';

const MARK_ATTRIBUTE = 'data-reading-highlight';

/** Put the marks back the way the text was drawn. */
function clearMarks(root) {
  if (!root) return;
  for (const mark of root.querySelectorAll(`mark[${MARK_ATTRIBUTE}]`)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  root.normalize?.();
}

/**
 * Wrap the given ranges of text in <mark> elements. Ranges are absolute offsets in the joined text
 * of the page, so every text node is visited once and each piece is split at the boundaries.
 */
function paintMarks(root, nodes, ranges, colourFor) {
  if (!root || !ranges.length) return;
  // Right to left, so a mark that is added never moves the offsets of the ranges still to come.
  for (const range of ranges.slice().reverse()) {
    for (const entry of nodes) {
      const node = entry.node;
      if (!node.parentNode) continue;
      // A node that was already split keeps only its left part, so its end is read again each time.
      const length = node.textContent.length;
      const nodeStart = entry.start;
      if (nodeStart >= range.end) break;
      if (nodeStart + length <= range.start) continue;
      const localStart = Math.max(0, range.start - nodeStart);
      const localEnd = Math.min(length, range.end - nodeStart);
      if (localEnd <= localStart) continue;
      let target = node;
      if (localEnd < target.textContent.length) target.splitText(localEnd);
      if (localStart > 0) target = target.splitText(localStart);
      const mark = document.createElement('mark');
      mark.setAttribute(MARK_ATTRIBUTE, range.highlight?.id ?? '');
      mark.setAttribute('data-highlight-colour', colourFor(range.highlight));
      mark.className = 'reading-highlight';
      if (range.overlapping) mark.setAttribute('data-highlight-shared', 'true');
      target.parentNode?.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }
}

/** A selection inside `root`, as a quote ready to be stored. */
function selectionIn(root) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root?.contains(range.commonAncestorContainer)) return null;
  const quote = normaliseText(range.toString());
  if (!quote || quote.length > 500) return null;
  return { range, quote, context: selectionContext(root, range) };
}

export default function HighlightLayer({
  rootEl,
  highlights = [],
  colour = DEFAULT_HIGHLIGHT_COLOR,
  canHighlight = true,
  enabled = true,
  onHighlight,
  onNote,
  onRemove,
  onPainted,
}) {
  const layerRef = useRef(null);
  const [toolbar, setToolbar] = useState(null); // { top, left, quote, context, highlightId }
  const highlightColour = isHighlightColor(colour) ? colour : DEFAULT_HIGHLIGHT_COLOR;

  const colourOf = useCallback((highlight) => (
    isHighlightColor(highlight?.colour) ? highlight.colour : highlightColour
  ), [highlightColour]);

  // Paint the marks for the text as it is drawn now.
  const paint = useCallback(() => {
    const root = rootEl;
    if (!root) return;
    clearMarks(root);
    if (!enabled || !highlights.length) {
      onPainted?.([]);
      return;
    }
    const { text, nodes } = collectTextNodes(root);
    const ranges = text ? rangesForHighlights(nodes, text, highlights) : [];
    // Report which marks the text still holds, so the list can say when words have been edited away.
    onPainted?.(ranges.flatMap((range) => range.ids));
    if (ranges.length) paintMarks(root, nodes, ranges, colourOf);
  }, [colourOf, enabled, highlights, onPainted, rootEl]);

  useLayoutEffect(() => {
    paint();
  });

  // Re-flowing the page moves the words, so the marks are painted again after a resize or a page turn.
  useEffect(() => {
    if (!enabled || !highlights.length || !rootEl) return undefined;
    const redraw = () => paint();
    window.addEventListener('resize', redraw);
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(redraw);
      observer.observe(rootEl);
    }
    return () => {
      window.removeEventListener('resize', redraw);
      observer?.disconnect();
    };
  }, [enabled, highlights, paint, rootEl]);

  // Tapping a mark opens its note (or offers to start one); tapping elsewhere puts the layer away.
  useEffect(() => {
    const root = rootEl;
    if (!root || !enabled) return undefined;
    const onClick = (event) => {
      const mark = event.target.closest?.(`mark[${MARK_ATTRIBUTE}]`);
      if (!mark || !root.contains(mark)) return;
      const id = mark.getAttribute(MARK_ATTRIBUTE);
      const highlight = highlights.find((item) => item.id === id);
      if (!highlight) return;
      const rect = mark.getBoundingClientRect();
      setToolbar({
        id: highlight.id,
        quote: highlight.quote,
        note: highlight.note ?? '',
        colour: colourOf(highlight),
        top: rect.top + rect.height + 8,
        left: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140),
      });
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [colourOf, enabled, highlights, rootEl]);

  // A new selection in the lesson text opens the "highlight these words" action.
  useEffect(() => {
    const root = rootEl;
    if (!root || !enabled || !canHighlight) return undefined;
    const onSelection = () => {
      const found = selectionIn(root);
      if (!found) return;
      const rect = found.range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      setToolbar({
        mode: 'select',
        quote: found.quote,
        context: found.context,
        top: rect.bottom + 10,
        left: Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160),
      });
    };
    const onDown = (event) => {
      if (layerRef.current?.contains(event.target)) return;
      if (event.target.closest?.(`mark[${MARK_ATTRIBUTE}]`)) return;
      setToolbar(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setToolbar(null);
    };
    // pointerup, not mouseup: the same path serves a finger, a stylus and a mouse.
    document.addEventListener('pointerup', onSelection);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    // The action is anchored to the words, so it closes rather than drifting when the page moves.
    const onScroll = () => setToolbar(null);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('pointerup', onSelection);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll);
    };
  }, [canHighlight, enabled, rootEl]);

  if (!enabled || !toolbar) return null;
  const style = { top: toolbar.top, left: toolbar.left };

  if (toolbar.mode === 'select') {
    return (
      <div
        ref={layerRef}
        className="reading-highlight-toolbar no-print"
        style={{ ...style, position: 'fixed' }}
        data-testid="highlight-toolbar"
        role="dialog"
        aria-label="Highlight these words"
      >
        <span className="reading-highlight-toolbar-quote" title={toolbar.quote}>“{toolbar.quote.slice(0, 42)}{toolbar.quote.length > 42 ? '…' : ''}”</span>
        <button
          type="button"
          className="reading-highlight-toolbar-action"
          onClick={() => {
            onHighlight?.({ quote: toolbar.quote, context: toolbar.context, colour: highlightColour });
            window.getSelection?.()?.removeAllRanges?.();
            setToolbar(null);
          }}
        >
          <Highlighter className="size-3.5" aria-hidden="true" />
          Highlight
        </button>
        <button type="button" className="reading-highlight-toolbar-close" onClick={() => setToolbar(null)} aria-label="Cancel">
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={layerRef}
      className="reading-highlight-toolbar no-print"
      style={{ ...style, position: 'fixed' }}
      data-testid="highlight-toolbar"
      role="dialog"
      aria-label="Highlight options"
    >
      <span className="reading-highlight-toolbar-quote" title={toolbar.quote}>“{toolbar.quote.slice(0, 30)}{toolbar.quote.length > 30 ? '…' : ''}”</span>
      <div className="reading-highlight-toolbar-colours" role="group" aria-label="Highlight colour">
        {HIGHLIGHT_COLORS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="reading-highlight-colour"
            data-colour={option.value}
            aria-label={option.label}
            aria-pressed={toolbar.colour === option.value}
            onClick={() => setToolbar((current) => ({ ...current, colour: option.value }))}
          />
        ))}
      </div>
      <button
        type="button"
        className="reading-highlight-toolbar-action"
        onClick={() => {
          onNote?.({ id: toolbar.id, note: toolbar.note, colour: toolbar.colour });
          setToolbar(null);
        }}
        title="Add a note to this highlight"
      >
        <MessageSquarePlus className="size-3.5" aria-hidden="true" />
        Note
      </button>
      <button
        type="button"
        className="reading-highlight-toolbar-remove"
        onClick={() => {
          onRemove?.(toolbar.id);
          setToolbar(null);
        }}
        title="Remove this highlight"
        aria-label="Remove this highlight"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export { clearMarks, MARK_ATTRIBUTE };
