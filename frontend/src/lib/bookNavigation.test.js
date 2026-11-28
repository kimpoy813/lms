import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigationHandlers, useBookNavigation } from './bookNavigation.js';

// A laptop turns pages with a two-finger trackpad gesture, arrow keys, or a pen; a phone swipes.
// These tests pin the parts that only a laptop exercises.
describe('book navigation', () => {
  let container;
  let root;
  let turns;
  let frameCallbacks;

  function renderReader({ canPrevious = true, canNext = true } = {}) {
    function Reader() {
      const navigation = useBookNavigation({
        canPrevious,
        canNext,
        onPrevious: () => turns.push('previous'),
        onNext: () => turns.push('next'),
      });
      return createElement('div', {
        ref: navigation.surfaceRef,
        'data-reader': true,
        tabIndex: 0,
        ...navigationHandlers(navigation),
      });
    }
    act(() => root.render(createElement(Reader)));
    return container.querySelector('[data-reader]');
  }

  /** A wheel event that records whether it was refused. */
  function wheel(reader, { deltaX = 0, deltaY = 0 }) {
    const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
    act(() => { reader.dispatchEvent(event); });
    return event;
  }

  beforeEach(() => {
    turns = [];
    frameCallbacks = [];
    // jsdom has no real frames; the hook uses them to restore scroll after a consumed gesture.
    vi.stubGlobal('requestAnimationFrame', (callback) => { frameCallbacks.push(callback); return frameCallbacks.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a horizontal trackpad gesture at the source, because React’s own wheel listener is passive', () => {
    const reader = renderReader();
    const event = wheel(reader, { deltaX: 120 });
    // preventDefault only sticks if the listener that calls it is not passive. This is what stopped
    // the page scrolling under the flip on a laptop.
    expect(event.defaultPrevented).toBe(true);
    expect(turns).toEqual(['next']);
  });

  it('leaves vertical scrolling alone, so a long lesson can still be read', () => {
    const reader = renderReader();
    const event = wheel(reader, { deltaY: 240 });
    expect(event.defaultPrevented).toBe(false);
    expect(turns).toEqual([]);
  });

  it('does not turn twice from one continuous gesture, nor turn during the cooldown', () => {
    const reader = renderReader();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(10_000);
      wheel(reader, { deltaX: 90 });
      now.mockReturnValue(10_100);
      wheel(reader, { deltaX: 90 });
      expect(turns).toEqual(['next']);
      now.mockReturnValue(11_000);
      wheel(reader, { deltaX: 90 });
      expect(turns).toEqual(['next', 'next']);
    } finally {
      now.mockRestore();
    }
  });

  it('ignores auto-repeat, so holding an arrow key does not flick through pages', () => {
    const reader = renderReader();
    act(() => {
      reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    const held = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, repeat: true });
    act(() => { reader.dispatchEvent(held); });
    expect(turns).toEqual(['next']);
    expect(held.defaultPrevented).toBe(false);
  });

  it('puts back any page scroll a consumed gesture caused, so the flip is not yanked off-screen', () => {
    const reader = renderReader();
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true, writable: true });
    // The reader itself stays in view: this is the usual case, and the scroll should simply be undone.
    reader.getBoundingClientRect = () => ({ top: 40, bottom: 640, left: 0, right: 800, width: 800, height: 600 });

    wheel(reader, { deltaX: 120 });
    // The browser applies its own scrolling after this handler, so the restore waits a frame.
    window.scrollY = 400;
    act(() => { frameCallbacks.forEach((callback) => callback()); });

    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'instant' });
  });

  it('brings the reader back into view if the gesture scrolled it away', () => {
    const reader = renderReader();
    const scrollIntoView = vi.fn();
    reader.scrollIntoView = scrollIntoView;
    // Scrolled out of view by the gesture that just turned the page.
    reader.getBoundingClientRect = () => ({ top: -900, bottom: -300, left: 0, right: 800, width: 800, height: 600 });

    wheel(reader, { deltaX: 120 });
    act(() => { frameCallbacks.forEach((callback) => callback()); });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('leaves a gesture that starts on a control alone, so its own scrolling still works', () => {
    const reader = renderReader();
    const scroller = document.createElement('div');
    scroller.className = 'rich-table-scroll';
    reader.appendChild(scroller);
    const event = new WheelEvent('wheel', { deltaX: 120, bubbles: true, cancelable: true });
    act(() => { scroller.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(turns).toEqual([]);
  });

  it('stops turning at the first and last page', () => {
    const reader = renderReader({ canPrevious: false, canNext: false });
    const event = wheel(reader, { deltaX: 120 });
    expect(event.defaultPrevented).toBe(false);
    const back = wheel(reader, { deltaX: -120 });
    expect(back.defaultPrevented).toBe(false);
    expect(turns).toEqual([]);
  });
});
