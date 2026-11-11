// How often a "live" screen asks the server for news.
//
// With real-time push a socket event triggers the refresh, and a timer is only a safety net (or
// off). A server that runs as short-lived function invocations cannot push, so there the timer is
// what keeps the screen current — and every round is a request the host counts. So without push
// the timers stop while nobody is at the keyboard (React Query already stops them while the tab is
// hidden), and what they kept current is fetched again as soon as the reader is back.
import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { createIdleTracker } from './idle.js';

const IDLE_AFTER_MS = 10 * 60_000;
const tracker = createIdleTracker({ idleAfterMs: IDLE_AFTER_MS });

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, tracker.input, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tracker.input();
  });
  setInterval(tracker.check, 30_000);
}

/** True when the reader has not touched the page for ten minutes. */
export const isReaderIdle = tracker.isIdle;

function useReaderIdle() {
  return useSyncExternalStore(tracker.subscribe, tracker.isIdle, () => false);
}

/**
 * The value for React Query's `refetchInterval`.
 * @param {number} withoutPush interval in ms when the server cannot push
 * @param {number | false} [withPush] interval in ms when it can (false = no timer)
 * @param {{ evenWhenIdle?: boolean }} [options] keep going while nobody touches the page — for a
 *        screen that is watched rather than used, such as the attendance monitor on a projector
 */
export function useLiveInterval(withoutPush, withPush = false, { evenWhenIdle = false } = {}) {
  const { runtime } = useAuth();
  const idle = useReaderIdle();
  if (runtime.realtime) return withPush;
  return idle && !evenWhenIdle ? false : withoutPush;
}

/**
 * Run `callback` when the reader is back after an idle spell, to refresh what was paused.
 * Does nothing when the server pushes: nothing was paused then.
 */
export function useOnReturn(callback) {
  const { runtime } = useAuth();
  useEffect(() => {
    if (runtime.realtime) return undefined;
    return tracker.subscribe((idle) => { if (!idle) callback(); });
  }, [runtime.realtime, callback]);
}
