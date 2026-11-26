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

    const now = Date.now();
    if (now - state.lastTurnAt < WHEEL_TURN_COOLDOWN_MS) return;
    if (turn(direction)) state.lastTurnAt = now;
  }, [turn]);

  const onKeyDown = useCallback((event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isPageTurnControl(event.target)) return;
    if (event.key === 'ArrowLeft' && canPrevious) {
      event.preventDefault();
      turn('previous');
    } else if (event.key === 'ArrowRight' && canNext) {
      event.preventDefault();
      turn('next');
    }
  }, [canNext, canPrevious, turn]);

  return {
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
