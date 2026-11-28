import { useCallback, useRef } from 'react';

const MIN_SWIPE_DISTANCE = 48;
const WHEEL_TURN_THRESHOLD = 72;
const WHEEL_TURN_COOLDOWN_MS = 480;
const PAGE_TURN_IGNORE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="option"]',
  '[contenteditable="true"]',
  '[data-no-page-turn]',
  '.rich-table-scroll',
  '.tableWrapper',
  '.overflow-x-auto',
  '.overflow-auto',
  '.rich pre',
  'iframe',
  'video',
  'audio',
].join(',');

function isPageTurnControl(target) {
  return Boolean(target?.closest?.(PAGE_TURN_IGNORE_SELECTOR));
}

function swipeDirection(start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.abs(deltaX) < MIN_SWIPE_DISTANCE || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return null;
  return deltaX < 0 ? 'next' : 'previous';
}

const HORIZONTAL_WHEEL = 12;

/**
 * True when this wheel event is a horizontal gesture that will turn a page. A gesture that is still
 * accumulating toward the threshold is refused too, so the page cannot creep sideways while the
 * reader builds up to a turn.
 */
function shouldTurnFromWheel(event, state, canPrevious, canNext) {
  if (isPageTurnControl(event.target)) return false;
  const deltaX = Number(event.deltaX) || 0;
  const deltaY = Number(event.deltaY) || 0;
  if (Math.abs(deltaX) < HORIZONTAL_WHEEL || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return false;
  if (state.deltaX !== 0 && Math.sign(state.deltaX) !== Math.sign(deltaX)) return false;
  // At the first or last page there is nothing to turn to, so the gesture is left alone.
  return deltaX > 0 ? canNext : canPrevious;
}

/**
 * Puts back the scrolling a consumed wheel gesture caused. A handler still runs before the
 * browser applies a wheel gesture's default scroll, so the position is remembered here and
 * restored on the next frame; if the gesture had already scrolled the reader out of view, the
 * reader is brought back instead of leaving the reader looking at the wrong part of the page.
 */
function keepScrollSteady(surface) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  const before = window.scrollY;
  window.requestAnimationFrame(() => {
    const rect = surface?.getBoundingClientRect?.();
    if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
      surface.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (window.scrollY !== before) window.scrollTo({ top: before, behavior: 'instant' });
  });
}

/**
 * Adds book-style navigation to a reader region. Touch and pen swipes work on phones, tablets,
 * and touchscreen laptops; horizontal trackpad gestures and arrow keys cover laptop navigation.
 * Native touch scrolling is left intact for vertical reading and horizontally scrollable content.
 */
export function useBookNavigation({ canPrevious, canNext, onPrevious, onNext }) {
  const pointerStart = useRef(null);
  const touchStart = useRef(null);
  const wheelState = useRef({ deltaX: 0, lastTurnAt: 0 });

  const turn = useCallback((direction) => {
    if (direction === 'previous') {
      if (!canPrevious) return false;
      onPrevious?.();
      return true;
    }
    if (!canNext) return false;
    onNext?.();
    return true;
  }, [canNext, canPrevious, onNext, onPrevious]);

  const onPointerDown = useCallback((event) => {
    if (event.pointerType !== 'pen' || event.isPrimary === false || isPageTurnControl(event.target)) {
      pointerStart.current = null;
      return;
    }
    pointerStart.current = { x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; a swipe that starts and ends on the reader still works without it.
    }
  }, []);

  const onPointerUp = useCallback((event) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    const direction = swipeDirection(start, { x: event.clientX, y: event.clientY });
    if (direction) turn(direction);
  }, [turn]);

  const onPointerCancel = useCallback(() => {
    pointerStart.current = null;
  }, []);

  const onTouchStart = useCallback((event) => {
    if (event.touches.length !== 1 || isPageTurnControl(event.target)) {
      touchStart.current = null;
      return;
    }
    const touch = event.touches[0];
    touchStart.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }, []);

  const onTouchEnd = useCallback((event) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const touch = Array.from(event.changedTouches).find(({ identifier }) => identifier === start.id);
    if (!touch) return;
    const direction = swipeDirection(start, { x: touch.clientX, y: touch.clientY });
    if (direction) turn(direction);
  }, [turn]);

  const onTouchCancel = useCallback(() => {
    touchStart.current = null;
  }, []);

  const onWheel = useCallback((event) => {
    if (isPageTurnControl(event.target)) {
      wheelState.current.deltaX = 0;
      return;
    }

    const deltaX = Number(event.deltaX) || 0;
    const deltaY = Number(event.deltaY) || 0;
    if (Math.abs(deltaX) < 12 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) {
      wheelState.current.deltaX = 0;
      return;
    }

    const state = wheelState.current;
    if (state.deltaX !== 0 && Math.sign(state.deltaX) !== Math.sign(deltaX)) state.deltaX = 0;
    state.deltaX += deltaX;
    if (Math.abs(state.deltaX) < WHEEL_TURN_THRESHOLD) return;

    event.preventDefault();
    const direction = state.deltaX > 0 ? 'next' : 'previous';
    state.deltaX = 0;
    // React listens for wheel passively, so preventDefault is ignored and the gesture may have
    // scrolled the page as well. Put back any scroll it caused, or the reader drifts down the
    // page while the sheet turns and the turn looks like a jump.
    keepScrollSteady(event.currentTarget);

    const now = Date.now();
    if (now - state.lastTurnAt < WHEEL_TURN_COOLDOWN_MS) return;
    if (turn(direction)) state.lastTurnAt = now;
  }, [turn]);

  const onKeyDown = useCallback((event) => {
    // Holding an arrow key repeats keydown; turning a page per repeat is a flicker, not a turn.
    if (event.repeat) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isPageTurnControl(event.target)) return;
    if (event.key === 'ArrowLeft' && canPrevious) {
      event.preventDefault();
      turn('previous');
    } else if (event.key === 'ArrowRight' && canNext) {
      event.preventDefault();
      turn('next');
    }
  }, [canNext, canPrevious, turn]);

  // React attaches its wheel listener as passive, where preventDefault is silently ignored, so a
  // trackpad swipe both turned the page and scrolled the reader. A listener we own can refuse the
  // gesture. It is attached from a callback ref rather than an effect: the ref is called with the
  // element the moment React attaches it, whereas an effect can run while the ref is still empty.
  const config = useRef({ canPrevious, canNext });
  config.current = { canPrevious, canNext };
  const nativeListener = useRef({ node: null, handler: null });
  const surfaceRef = useCallback((node) => {
    const previous = nativeListener.current;
    if (previous.node && previous.handler) previous.node.removeEventListener('wheel', previous.handler);
    nativeListener.current = { node: null, handler: null };
    if (!node || typeof node.addEventListener !== 'function') return;
    const handler = (event) => {
      const { canPrevious: canBack, canNext: canForward } = config.current;
      if (shouldTurnFromWheel(event, wheelState.current, canBack, canForward)) event.preventDefault();
    };
    node.addEventListener('wheel', handler, { passive: false });
    nativeListener.current = { node, handler };
  }, []);

  return {
    surfaceRef,
    onPointerDown,
    onPointerUp,
    onPointerCancel,
    onTouchStart,
    onTouchEnd,
    onTouchCancel,
    onWheel,
    onKeyDown,
  };
}

/**
 * The event handlers from useBookNavigation, ready to spread onto the reader element. The surface
 * ref is used separately (on the element's ref), so it is left out of the spread.
 */
export function navigationHandlers({ surfaceRef: _surfaceRef, ...handlers }) {
  return handlers;
}
