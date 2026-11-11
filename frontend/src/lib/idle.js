// Has the reader done anything lately? Kept free of the DOM so that it can be tested; lib/live.js
// feeds it the browser's input events.

/**
 * @param {{ idleAfterMs: number, now?: () => number }} options
 */
export function createIdleTracker({ idleAfterMs, now = Date.now }) {
  let lastInput = now();
  let idle = false;
  const listeners = new Set();
  const set = (next) => {
    if (idle === next) return;
    idle = next;
    for (const listener of [...listeners]) listener(idle);
  };
  return {
    /** The reader did something (a key, a click, a scroll, coming back to the tab). */
    input() {
      lastInput = now();
      set(false);
    },
    /** Call every so often: turns idle once nothing has happened for `idleAfterMs`. */
    check() {
      if (now() - lastInput >= idleAfterMs) set(true);
    },
    isIdle: () => idle,
    /** `listener(idle)` runs whenever the state changes. Returns a function that unsubscribes. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
