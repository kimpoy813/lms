import { describe, expect, it } from 'vitest';
import { createIdleTracker } from './idle.js';

function setup() {
  let time = 0;
  const tracker = createIdleTracker({ idleAfterMs: 600, now: () => time });
  const seen = [];
  const unsubscribe = tracker.subscribe((idle) => seen.push(idle));
  return { tracker, seen, unsubscribe, advance: (ms) => { time += ms; tracker.check(); } };
}

describe('idle tracker', () => {
  it('turns idle only after nothing happened for long enough', () => {
    const { tracker, seen, advance } = setup();
    advance(599);
    expect(tracker.isIdle()).toBe(false);
    advance(1);
    expect(tracker.isIdle()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('any input restarts the wait', () => {
    const { tracker, seen, advance } = setup();
    advance(500);
    tracker.input();
    advance(500);
    expect(tracker.isIdle()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('wakes up on input and tells its listeners once per change', () => {
    const { tracker, seen, advance, unsubscribe } = setup();
    advance(700);
    advance(700);
    tracker.input();
    tracker.input();
    expect(tracker.isIdle()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe();
    advance(700);
    expect(tracker.isIdle()).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});
