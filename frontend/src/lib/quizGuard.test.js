import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({ api: { post: vi.fn() } }));

import { api } from './api.js';
import {
  BLUR_GRACE_MS, FILE_DIALOG_MAX_MS, PICKER_MAX_MS, SIDE_EFFECT_MS, SUSPENDED_MS,
  armedGuard, attemptsWithPendingReports, disarmGuard, forgetOpening, forgetReports, hasOpened, openAttempt, ownField,
  pendingReports, recordReport, sendPendingReports, sendReport, watchQuiz,
} from './quizGuard.js';

const failure = (status) => Object.assign(new Error(`status ${status}`), { status });
const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: FAKED });
  api.post.mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  for (const id of attemptsWithPendingReports()) forgetReports(id);
  vi.useRealTimers();
});

// ── Reports ──────────────────────────────────────────────────────────────────
describe('reports of violations', () => {
  it('are written down first, and removed once the server has answered', async () => {
    const report = recordReport('a1', 'LEFT_PAGE');
    expect(report).toMatchObject({ kind: 'LEFT_PAGE', at: Date.now() });
    expect(report.key).toMatch(/^[A-Za-z0-9_-]{8,40}$/);
    expect(pendingReports('a1')).toEqual([report]);
    expect(JSON.parse(window.localStorage.getItem('edusphere.quiz.reports.v1'))).toEqual({ a1: [report] });

    vi.advanceTimersByTime(2500);
    api.post.mockResolvedValueOnce({ outcome: 'TERMINATED', kind: 'LEFT_PAGE' });
    await expect(sendReport('a1', report)).resolves.toEqual({ outcome: 'TERMINATED', kind: 'LEFT_PAGE' });
    // The server is told how long ago it happened, not what this device's clock says.
    expect(api.post).toHaveBeenCalledWith('/attempts/a1/violations', { kind: 'LEFT_PAGE', key: report.key, agoMs: 2500 }, { keepalive: false });
    expect(pendingReports('a1')).toEqual([]);
    expect(window.localStorage.getItem('edusphere.quiz.reports.v1')).toBeNull();
  });

  it('carry a short detail, and can be sent while the page is closing', async () => {
    const report = recordReport('a1', 'SCREENSHOT', 'x'.repeat(200));
    expect(report.detail).toHaveLength(80);
    api.post.mockResolvedValueOnce({ outcome: 'WARNING' });
    await sendReport('a1', report, { keepalive: true });
    expect(api.post).toHaveBeenCalledWith('/attempts/a1/violations', expect.objectContaining({ detail: report.detail }), { keepalive: true });
  });

  it.each([0, 429, 500, 503])('stay written down when the server could not be reached (status %i)', async (status) => {
    const report = recordReport('a1', 'LOST_FOCUS');
    api.post.mockRejectedValueOnce(failure(status));
    await expect(sendReport('a1', report)).resolves.toBeNull();
    expect(pendingReports('a1')).toEqual([report]);

    // …and are sent again, as the same report.
    api.post.mockResolvedValueOnce({ outcome: 'WARNING' });
    await expect(sendPendingReports('a1')).resolves.toEqual({ outcome: 'WARNING' });
    expect(api.post.mock.calls[1][1].key).toBe(report.key);
    expect(pendingReports('a1')).toEqual([]);
  });

  it.each([401, 403, 404, 409, 422])('are dropped when the server will not take them (status %i)', async (status) => {
    const report = recordReport('a1', 'COPY');
    api.post.mockRejectedValueOnce(failure(status));
    await expect(sendReport('a1', report)).resolves.toBeNull();
    expect(pendingReports('a1')).toEqual([]);
  });

  it('are sent one request at a time: asking twice does not send twice', async () => {
    const report = recordReport('a1', 'PASTE');
    let answer;
    api.post.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const first = sendReport('a1', report);
    const second = sendReport('a1', report);
    expect(second).toBe(first);
    answer({ outcome: 'WARNING' });
    await expect(first).resolves.toEqual({ outcome: 'WARNING' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('are sent again when a request never comes back', async () => {
    const report = recordReport('a1', 'LEFT_PAGE');
    api.post.mockReturnValueOnce(new Promise(() => {}));
    const stuck = sendReport('a1', report);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(stuck).resolves.toBeNull();
    expect(pendingReports('a1')).toEqual([report]);

    api.post.mockResolvedValueOnce({ outcome: 'TERMINATED' });
    await expect(sendReport('a1', report)).resolves.toEqual({ outcome: 'TERMINATED' });
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('go out oldest first, and stop at the first one that cannot be delivered', async () => {
    const first = recordReport('a1', 'LEFT_PAGE');
    vi.advanceTimersByTime(10);
    const second = recordReport('a1', 'PASTE');
    recordReport('other', 'COPY');
    expect(attemptsWithPendingReports().sort()).toEqual(['a1', 'other']);

    api.post.mockResolvedValueOnce({ outcome: 'WARNING', number: 1 }).mockRejectedValueOnce(failure(0));
    await expect(sendPendingReports('a1')).resolves.toEqual({ outcome: 'WARNING', number: 1 });
    expect(api.post.mock.calls.map((call) => call[1].key)).toEqual([first.key, second.key]);
    expect(pendingReports('a1')).toEqual([second]);
    expect(pendingReports('other')).toHaveLength(1);

    forgetReports('a1');
    expect(attemptsWithPendingReports()).toEqual(['other']);
  });

  it('keep at most twenty for one attempt', () => {
    for (let i = 0; i < 25; i += 1) recordReport('a1', 'COPY', String(i));
    expect(pendingReports('a1').map((r) => r.detail)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 5)));
  });

  it('survive a browser that offers no storage', async () => {
    const broken = () => { throw new Error('storage is not available'); };
    const spies = ['getItem', 'setItem', 'removeItem'].map((name) => vi.spyOn(Storage.prototype, name).mockImplementation(broken));
    try {
      forgetReports('a1'); // whatever an earlier test left in memory
      const report = recordReport('a1', 'LEFT_PAGE');
      expect(pendingReports('a1')).toEqual([report]);
      api.post.mockResolvedValueOnce({ outcome: 'TERMINATED' });
      await expect(sendPendingReports('a1')).resolves.toEqual({ outcome: 'TERMINATED' });
      expect(pendingReports('a1')).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('ignore what somebody else wrote into the storage', () => {
    window.localStorage.setItem('edusphere.quiz.reports.v1', '["not", "ours"]');
    expect(pendingReports('a1')).toEqual([]);
    window.localStorage.setItem('edusphere.quiz.reports.v1', '{broken');
    expect(pendingReports('a1')).toEqual([]);
    expect(recordReport('a1', 'COPY')).toMatchObject({ kind: 'COPY' });
  });
});

// ── Opening ──────────────────────────────────────────────────────────────────
describe('telling the server that the page shows the attempt', () => {
  afterEach(() => {
    forgetOpening('a1');
  });

  it('happens once for a page, however often it is asked for', async () => {
    api.post.mockResolvedValue({ outcome: 'OPENED' });
    expect(hasOpened('a1')).toBe(false);
    const first = openAttempt('a1');
    expect(openAttempt('a1')).toBe(first);
    await expect(first).resolves.toEqual({ outcome: 'OPENED' });
    expect(hasOpened('a1')).toBe(true);
    await openAttempt('a1');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/attempts/a1/open', {});

    // The attempt was closed, or waits to be continued: the next answering is a new opening.
    forgetOpening('a1');
    expect(hasOpened('a1')).toBe(false);
    await openAttempt('a1');
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('sends what an earlier page left behind first, so that leaving is counted once', async () => {
    const report = recordReport('a1', 'CLOSED_PAGE');
    api.post.mockResolvedValueOnce({ outcome: 'WARNING', number: 1 }).mockResolvedValueOnce({ outcome: 'OPENED', warned: { kind: 'CLOSED_PAGE', number: 1 } });
    await expect(openAttempt('a1')).resolves.toMatchObject({ outcome: 'OPENED', warned: { number: 1 } });
    expect(api.post.mock.calls.map((call) => call[0])).toEqual(['/attempts/a1/violations', '/attempts/a1/open']);
    expect(api.post.mock.calls[0][1].key).toBe(report.key);
  });

  it('says nothing about opening while a report of leaving could not be delivered', async () => {
    // Otherwise the server would count the opening as a page closed without a word, and the
    // report on top of it once it arrives: one act counted twice.
    const report = recordReport('a1', 'CLOSED_PAGE');
    api.post.mockRejectedValueOnce(failure(0));
    await expect(openAttempt('a1')).rejects.toMatchObject({ status: 0 });
    expect(api.post.mock.calls.map((call) => call[0])).toEqual(['/attempts/a1/violations']);
    expect(pendingReports('a1')).toEqual([report]);
    expect(hasOpened('a1')).toBe(false);

    // The connection is back.
    api.post.mockResolvedValueOnce({ outcome: 'WARNING', number: 1 }).mockResolvedValueOnce({ outcome: 'OPENED' });
    await expect(openAttempt('a1')).resolves.toEqual({ outcome: 'OPENED' });
    expect(api.post.mock.calls.map((call) => call[0])).toEqual(['/attempts/a1/violations', '/attempts/a1/violations', '/attempts/a1/open']);
  });

  it('can be tried again when the server could not be reached', async () => {
    api.post.mockRejectedValueOnce(failure(0));
    await expect(openAttempt('a1')).rejects.toMatchObject({ status: 0 });
    expect(hasOpened('a1')).toBe(false);
    api.post.mockResolvedValueOnce({ outcome: 'OPENED' });
    await expect(openAttempt('a1')).resolves.toEqual({ outcome: 'OPENED' });
    expect(hasOpened('a1')).toBe(true);
  });
});

// ── Watching the page ────────────────────────────────────────────────────────
describe('watching the page of an attempt', () => {
  let page;
  let guard;
  let seen;

  /** The browser as the guard sees it: is the page on screen, does its window have the focus. */
  function browser({ platform = 'Win32', focused = true } = {}) {
    const state = { visible: true, focused };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (state.visible ? 'visible' : 'hidden') });
    document.hasFocus = () => state.focused;
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => platform });
    document.body.innerHTML = `
      <main>
        <p id="question">How many bits are in one byte?</p>
        <a id="link" href="https://example.com/answers">A link in the question</a>
        <label><input id="choice" type="radio" name="q1"> Eight</label>
        <textarea id="essay"></textarea>
        <textarea id="second"></textarea>
        <input id="number" type="number">
        <select id="match"><option value="">Choose…</option><option value="a">A byte</option></select>
        <div id="code" contenteditable="true">print(1)</div>
      </main>`;
    const $ = (id) => document.getElementById(id);
    const fire = (target, event, extra) => {
      if (extra) for (const [name, value] of Object.entries(extra)) Object.defineProperty(event, name, { configurable: true, value });
      target.dispatchEvent(event);
      return event;
    };
    const plain = (type) => new Event(type, { bubbles: true, cancelable: true });
    return {
      $,
      hide() { state.visible = false; document.dispatchEvent(new Event('visibilitychange')); },
      show() { state.visible = true; document.dispatchEvent(new Event('visibilitychange')); },
      blur() { state.focused = false; window.dispatchEvent(new Event('blur')); },
      focus() { state.focused = true; window.dispatchEvent(new Event('focus')); },
      /** The focus is gone and no event says so (it left from inside a frame of the page). */
      loseFocusSilently() { state.focused = false; },
      event: (type, target = window) => fire(target, plain(type)),
      key: (key, mods = {}, target = document.body, type = 'keydown') => fire(target, new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...mods })),
      clipboard: (type, target, text = '', files = []) => fire(target, plain(type), { clipboardData: { getData: () => text, files } }),
      drop: (target, text) => fire(target, plain('drop'), { dataTransfer: { getData: () => text } }),
      menu: (target, pointerType) => fire(target, pointerType ? new window.PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType }) : new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      touch: (target, pointerType = 'touch') => fire(target, new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType })),
      select(id) {
        const range = document.createRange();
        range.selectNodeContents($(id));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
      /** Type into an answer field and select all of it, as before a copy. */
      write(id, text) {
        const field = $(id);
        field.value = text;
        if (field.type !== 'number') field.setSelectionRange(0, text.length);
        return field;
      },
      restore() {
        delete document.visibilityState;
        delete document.hasFocus;
        delete window.navigator.platform;
        window.getSelection().removeAllRanges();
        document.body.innerHTML = '';
      },
    };
  }

  function start(options = {}) {
    page = browser(options);
    seen = { violations: [], blocked: [], signals: [], restored: 0, awake: [] };
    guard = watchQuiz({
      attemptId: 'a1',
      trusted: () => true, // an event made by a test counts as one made by a person
      onViolation: (kind, detail) => seen.violations.push(detail === undefined ? kind : `${kind}:${detail}`),
      onBlocked: (what) => seen.blocked.push(what),
      onSignal: (type, extra) => seen.signals.push([type, extra]),
      onRestored: () => { seen.restored += 1; },
      onAwake: (kept) => seen.awake.push(kept),
    });
    return page;
  }

  afterEach(() => {
    guard?.stop();
    guard = null;
    disarmGuard();
    page?.restore();
    page = null;
  });

  describe('leaving', () => {
    it('counts a page that went out of sight, once, and notes when the student is back', () => {
      start();
      page.hide();
      expect(seen.violations).toEqual(['LEFT_PAGE']);
      // Switching tabs also takes the focus, and may be followed by the page being put away.
      page.blur();
      vi.advanceTimersByTime(4000);
      page.event('pagehide');
      expect(seen.violations).toEqual(['LEFT_PAGE']);

      page.show(); // on screen again, but another window still has the focus
      expect(seen.signals).toEqual([]);
      page.focus();
      expect(seen.signals).toEqual([['TAB_VISIBLE', { awayMs: 4000 }]]);

      // A second absence is a second violation.
      page.hide();
      expect(seen.violations).toEqual(['LEFT_PAGE', 'LEFT_PAGE']);
    });

    it('lets a window lose the focus for a moment', () => {
      start();
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS - 400);
      page.focus();
      vi.advanceTimersByTime(10_000);
      expect(seen.violations).toEqual([]);
      expect(seen.signals).toEqual([]);
    });

    it('counts a window that stays without the focus', () => {
      start();
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS - 100);
      expect(seen.violations).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
      vi.advanceTimersByTime(30_000);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
      page.focus();
      // Away from the moment the focus was lost, not from the moment it was counted.
      expect(seen.signals).toEqual([['WINDOW_FOCUS', { awayMs: BLUR_GRACE_MS + 100 + 30_000 }]]);
    });

    it('notices a focus that left without an event', () => {
      start();
      page.loseFocusSilently();
      vi.advanceTimersByTime(900);
      expect(seen.violations).toEqual([]);
      vi.advanceTimersByTime(1200);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
    });

    it('does not hold a window to have lost a focus that it never had', () => {
      // Opened in a window in the background, or in a browser that reports no focus until the page is touched.
      start({ focused: false });
      vi.advanceTimersByTime(20_000);
      page.event('blur');
      vi.advanceTimersByTime(20_000);
      expect(seen.violations).toEqual([]);
      // Once it has had the focus, losing it counts.
      page.focus();
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
    });

    it('stops going by the focus in a browser that does not know where it is, and says so', () => {
      start();
      // Keys only reach a page that has the focus. This browser delivers them and reports none.
      page.loseFocusSilently();
      page.key('a', {}, page.$('essay'));
      page.key('b', {}, page.$('essay'));
      expect(seen.signals).toEqual([['FOCUS_UNKNOWN', undefined]]);
      vi.advanceTimersByTime(60_000);
      expect(seen.violations).toEqual([]);
      // A page that goes out of sight is still seen.
      page.hide();
      expect(seen.violations).toEqual(['LEFT_PAGE']);
      vi.advanceTimersByTime(5000);
      page.show();
      expect(seen.signals.at(-1)).toEqual(['TAB_VISIBLE', { awayMs: 5000 }]);
    });

    it('takes no key for proof once the missing focus has been counted', () => {
      start();
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
      page.key('a', {}, page.$('essay'));
      expect(seen.signals).toEqual([]);
    });

    describe('the list of a drop-down on a touch screen', () => {
      // A phone draws the list of a <select> itself, over the page. Where that takes the focus…
      const tap = (id = 'match') => {
        page.touch(page.$(id));
        page.event('click', page.$(id));
      };

      it('is not counted as clicking outside, and is noted with how long it was open', () => {
        start();
        tap();
        vi.advanceTimersByTime(300);
        page.blur();
        vi.advanceTimersByTime(12_000);
        expect(seen.violations).toEqual([]);
        page.focus();
        expect(seen.signals).toEqual([['PICKER', { awayMs: 12_000 }]]);
        // The next loss of focus has nothing to do with the list.
        vi.advanceTimersByTime(5000);
        page.blur();
        vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
        expect(seen.violations).toEqual(['LOST_FOCUS']);
      });

      it('is counted when the focus stays away for longer than a list takes', () => {
        start();
        tap();
        page.blur();
        vi.advanceTimersByTime(PICKER_MAX_MS - 1000);
        expect(seen.violations).toEqual([]);
        vi.advanceTimersByTime(1100);
        expect(seen.violations).toEqual(['LOST_FOCUS']);
        vi.advanceTimersByTime(8900);
        page.focus();
        // Away since the focus was lost, not since it was counted.
        expect(seen.signals).toEqual([['WINDOW_FOCUS', { awayMs: PICKER_MAX_MS + 9000 }]]);
      });

      it('does not excuse a page that goes out of sight', () => {
        start();
        tap();
        page.blur();
        vi.advanceTimersByTime(3000);
        page.hide();
        expect(seen.violations).toEqual(['LEFT_PAGE']);
        vi.advanceTimersByTime(7000);
        page.show();
        page.focus();
        // One absence, told as one: nothing is said about a list.
        expect(seen.signals).toEqual([['TAB_VISIBLE', { awayMs: 7000 }]]);
        vi.advanceTimersByTime(PICKER_MAX_MS);
        expect(seen.violations).toEqual(['LEFT_PAGE']);
      });

      it('is no excuse with a mouse, where the list is part of the browser window', () => {
        start();
        page.touch(page.$('match'), 'mouse');
        page.event('click', page.$('match'));
        page.blur();
        vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
        expect(seen.violations).toEqual(['LOST_FOCUS']);
      });

      it('is no excuse for a focus lost long after the tap, or after a tap elsewhere', () => {
        start();
        tap();
        vi.advanceTimersByTime(5000);
        page.blur();
        vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
        expect(seen.violations).toEqual(['LOST_FOCUS']);
        page.focus();

        vi.advanceTimersByTime(5000);
        tap('choice');
        page.blur();
        vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
        expect(seen.violations).toEqual(['LOST_FOCUS', 'LOST_FOCUS']);
      });

      it('goes by a touch on a browser that sends no pointer events', () => {
        start();
        page.event('touchstart', page.$('match'));
        page.event('click', page.$('match'));
        page.blur();
        vi.advanceTimersByTime(10_000);
        expect(seen.violations).toEqual([]);
      });
    });

    it('counts a page that is closed, reloaded or left for another address', () => {
      start();
      page.event('pagehide');
      expect(seen.violations).toEqual(['CLOSED_PAGE']);
    });

    it('lets the browser ask before the page is closed, and waits for the focus after its question', () => {
      start();
      const asked = page.event('beforeunload');
      expect(asked.defaultPrevented).toBe(true);
      // The browser's question had the focus. "Stay" gives it back a moment later.
      page.loseFocusSilently();
      vi.advanceTimersByTime(1000);
      page.focus();
      vi.advanceTimersByTime(5000);
      expect(seen.violations).toEqual([]);
    });

    it('tells the screen when the browser brought the page back from its memory', () => {
      start();
      page.event('pageshow');
      expect(seen.restored).toBe(0);
      const back = new Event('pageshow');
      Object.defineProperty(back, 'persisted', { value: true });
      window.dispatchEvent(back);
      expect(seen.restored).toBe(1);
    });

    it('notes a device that slept with the quiz on screen, without counting it', () => {
      start();
      vi.advanceTimersByTime(5000);
      vi.setSystemTime(Date.now() + SUSPENDED_MS + 60_000);
      vi.advanceTimersByTime(1000);
      expect(seen.signals).toEqual([['SUSPENDED', { awayMs: SUSPENDED_MS + 61_000 }]]);
      expect(seen.violations).toEqual([]);
    });

    it('does not call it sleep when the page was out of sight: that was leaving', () => {
      start();
      page.hide();
      vi.setSystemTime(Date.now() + SUSPENDED_MS + 60_000);
      page.show();
      vi.advanceTimersByTime(3000);
      expect(seen.violations).toEqual(['LEFT_PAGE']);
      expect(seen.signals.map(([type]) => type)).toEqual(['TAB_VISIBLE']);
    });
  });

  describe('the file chooser of a question that asks for a file', () => {
    it('may take the focus, and is noted for the teacher', () => {
      start();
      guard.expectFileDialog();
      page.blur();
      vi.advanceTimersByTime(60_000);
      expect(seen.violations).toEqual([]);
      page.focus();
      expect(seen.signals).toEqual([['FILE_DIALOG', { awayMs: 60_000 }]]);
      // Only that once: the next loss of focus is counted.
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
    });

    it('may cover the page on a phone', () => {
      start();
      guard.expectFileDialog();
      page.hide();
      vi.advanceTimersByTime(20_000);
      page.show();
      expect(seen.violations).toEqual([]);
      expect(seen.signals).toEqual([['FILE_DIALOG', { awayMs: 20_000 }]]);
    });

    it('is not an open door: after three minutes the absence counts', () => {
      start();
      guard.expectFileDialog();
      page.blur();
      vi.advanceTimersByTime(FILE_DIALOG_MAX_MS - 1000);
      expect(seen.violations).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
    });

    it('is over as soon as the page is touched again', () => {
      start();
      guard.expectFileDialog();
      vi.advanceTimersByTime(800);
      page.touch(page.$('essay'), 'mouse');
      expect(seen.signals).toEqual([['FILE_DIALOG', { awayMs: 800 }]]);
      page.blur();
      vi.advanceTimersByTime(BLUR_GRACE_MS + 100);
      expect(seen.violations).toEqual(['LOST_FOCUS']);
    });
  });

  describe('copying and pasting', () => {
    it('counts copying the text of the quiz, and puts nothing on the clipboard', () => {
      start();
      page.select('question');
      const copy = page.clipboard('copy', page.$('question'));
      expect(copy.defaultPrevented).toBe(true);
      expect(seen.violations).toEqual(['COPY']);
      // One press of the keys is one violation, however many events it causes.
      page.clipboard('copy', page.$('question'));
      expect(seen.violations).toEqual(['COPY']);
      vi.advanceTimersByTime(2000);
      page.clipboard('cut', page.$('question'));
      expect(seen.violations).toEqual(['COPY', 'COPY']);
    });

    it('does not count the copy keys pressed with nothing selected', () => {
      start();
      const copy = page.clipboard('copy', page.$('question'));
      expect(copy.defaultPrevented).toBe(true);
      expect(seen.violations).toEqual([]);
    });

    it('lets the student copy, cut and paste their own writing', () => {
      start();
      const essay = page.write('essay', 'An algorithm is a finite list of steps.');
      const copy = page.clipboard('copy', essay);
      expect(copy.defaultPrevented).toBe(false);
      const paste = page.clipboard('paste', page.$('second'), 'An algorithm is a finite list of steps.');
      expect(paste.defaultPrevented).toBe(false);

      // Cut from one answer, pasted into the code editor: the clipboard may end a line differently.
      page.write('second', 'first line\nsecond line');
      expect(page.clipboard('cut', page.$('second'), 'first line\nsecond line').defaultPrevented).toBe(false);
      expect(page.clipboard('paste', page.$('code'), 'first line\r\nsecond line\r\n').defaultPrevented).toBe(false);

      // A number field does not say what is selected: its whole value is the student's.
      page.write('number', '42');
      page.clipboard('copy', page.$('number'));
      expect(page.clipboard('paste', essay, '42').defaultPrevented).toBe(false);
      expect(seen.violations).toEqual([]);
    });

    it('counts pasting text that was not written in the quiz, and keeps it out', () => {
      start();
      const paste = page.clipboard('paste', page.$('essay'), 'An answer copied from a website.');
      expect(paste.defaultPrevented).toBe(true);
      expect(seen.violations).toEqual(['PASTE']);
    });

    it('keeps a pasted picture out without counting it, and ignores pasting outside the answers', () => {
      start();
      expect(page.clipboard('paste', page.$('essay'), '', [{ name: 'photo.png' }]).defaultPrevented).toBe(true);
      expect(page.clipboard('paste', page.$('question'), 'anything').defaultPrevented).toBe(true);
      // An empty clipboard is left to the browser.
      expect(page.clipboard('paste', page.$('essay'), '').defaultPrevented).toBe(false);
      expect(seen.violations).toEqual([]);
    });

    it('treats text that is dragged like text that is pasted', () => {
      start();
      const out = page.event('dragstart', page.$('question'));
      expect(out.defaultPrevented).toBe(true);
      expect(seen.blocked).toEqual(['drag']);

      const essay = page.write('essay', 'my own words');
      expect(page.event('dragstart', essay).defaultPrevented).toBe(false);
      expect(page.drop(page.$('second'), 'my own words').defaultPrevented).toBe(false);
      expect(seen.violations).toEqual([]);

      expect(page.drop(page.$('second'), 'words from elsewhere').defaultPrevented).toBe(true);
      expect(seen.violations).toEqual(['PASTE:dropped']);
    });

    it('knows which fields hold the student’s own writing', () => {
      start();
      expect(ownField(page.$('essay'))).toBe(page.$('essay'));
      expect(ownField(page.$('number'))).toBe(page.$('number'));
      expect(ownField(page.$('code').firstChild)).toBe(page.$('code'));
      expect(ownField(page.$('choice'))).toBeNull();
      expect(ownField(page.$('question'))).toBeNull();
      expect(ownField(null)).toBeNull();
    });
  });

  describe('keys', () => {
    it('counts the screenshot key once, whether the page hears it going down, coming up, or both', () => {
      start();
      page.key('PrintScreen');
      page.key('PrintScreen', {}, document.body, 'keyup');
      expect(seen.violations).toEqual(['SCREENSHOT:PrintScreen']);
      vi.advanceTimersByTime(3000);
      page.key('PrintScreen', {}, document.body, 'keyup'); // Windows tells the page only this
      expect(seen.violations).toEqual(['SCREENSHOT:PrintScreen', 'SCREENSHOT:PrintScreen']);
    });

    it('does not count the focus that the screenshot tool takes, unless the student stays away', () => {
      start();
      page.key('PrintScreen');
      page.blur();
      vi.advanceTimersByTime(4000);
      page.focus();
      vi.advanceTimersByTime(SIDE_EFFECT_MS * 2);
      expect(seen.violations).toEqual(['SCREENSHOT:PrintScreen']);

      vi.advanceTimersByTime(60_000);
      page.key('PrintScreen');
      page.blur();
      vi.advanceTimersByTime(SIDE_EFFECT_MS + BLUR_GRACE_MS + 100);
      expect(seen.violations).toEqual(['SCREENSHOT:PrintScreen', 'SCREENSHOT:PrintScreen', 'LOST_FOCUS']);
    });

    it('counts printing, from the keyboard or from the browser’s menu, and stops the keyboard one', () => {
      start();
      const print = page.key('p', { ctrlKey: true });
      expect(print.defaultPrevented).toBe(true);
      page.event('beforeprint');
      expect(seen.violations).toEqual(['PRINT:keyboard']);
      vi.advanceTimersByTime(2000);
      page.event('beforeprint');
      expect(seen.violations).toEqual(['PRINT:keyboard', 'PRINT']);
    });

    it('stops the reload keys without counting anything', () => {
      start();
      expect(page.key('F5').defaultPrevented).toBe(true);
      expect(page.key('r', { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(page.key('R', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
      expect(seen.blocked).toEqual(['reload', 'reload', 'reload']);
      expect(seen.violations).toEqual([]);
    });

    it('stops the browser’s shortcuts that open something over the page', () => {
      start();
      for (const [key, mods] of [['f', { ctrlKey: true }], ['s', { ctrlKey: true }], ['u', { ctrlKey: true }], ['l', { ctrlKey: true }], ['I', { ctrlKey: true, shiftKey: true }], ['F12', {}], ['ArrowLeft', { altKey: true }]]) {
        expect(page.key(key, mods).defaultPrevented, key).toBe(true);
      }
      expect(seen.blocked).toEqual(Array(7).fill('shortcut'));
      expect(seen.violations).toEqual([]);
    });

    it('leaves the keys of writing alone', () => {
      start();
      const essay = page.$('essay');
      for (const [key, mods] of [['a', { ctrlKey: true }], ['c', { ctrlKey: true }], ['v', { ctrlKey: true }], ['x', { ctrlKey: true }], ['z', { ctrlKey: true }], ['y', { ctrlKey: true }], ['Z', { ctrlKey: true, shiftKey: true }], ['Backspace', { ctrlKey: true }], ['ArrowLeft', { ctrlKey: true }], ['Home', { ctrlKey: true }], ['e', {}], ['F2', {}], ['Tab', {}],
        // AltGr on a Windows keyboard arrives as Control and Alt together: AltGr+E types "€".
        ['€', { ctrlKey: true, altKey: true }]]) {
        expect(page.key(key, mods, essay).defaultPrevented, key).toBe(false);
      }
      expect(seen.blocked).toEqual([]);
    });

    it('leaves a shortcut to the editor that has already used it', () => {
      start();
      // The code editor has its own search on Ctrl+F.
      page.$('code').addEventListener('keydown', (e) => e.preventDefault());
      page.key('f', { ctrlKey: true }, page.$('code'));
      expect(seen.blocked).toEqual([]);
    });

    it('goes by the Command key on a Mac, where Control belongs to writing', () => {
      start({ platform: 'MacIntel' });
      const essay = page.$('essay');
      expect(page.key('r', { metaKey: true }).defaultPrevented).toBe(true);
      expect(page.key('f', { metaKey: true }).defaultPrevented).toBe(true);
      expect(page.key('y', { metaKey: true }).defaultPrevented).toBe(true);
      expect(page.key('[', { metaKey: true }).defaultPrevented).toBe(true);
      expect(page.key('ˆ', { metaKey: true, altKey: true, code: 'KeyI' }).defaultPrevented).toBe(true);
      expect(seen.blocked).toEqual(['reload', 'shortcut', 'shortcut', 'shortcut', 'shortcut']);
      // Control+K deletes to the end of the line, Control+E goes there, Option+E starts an accent.
      for (const [key, mods] of [['k', { ctrlKey: true }], ['e', { ctrlKey: true }], ['f', { ctrlKey: true }], ['p', { ctrlKey: true }], ['Dead', { altKey: true, code: 'KeyE' }], ['z', { metaKey: true }], ['Z', { metaKey: true, shiftKey: true }], ['ArrowLeft', { metaKey: true }]]) {
        expect(page.key(key, mods, essay).defaultPrevented, key).toBe(false);
      }
      expect(seen.violations).toEqual([]);

      expect(page.key('p', { metaKey: true }).defaultPrevented).toBe(true);
      // With Shift held, the key that carries a 4 types "$".
      page.key('$', { metaKey: true, shiftKey: true, code: 'Digit4' });
      expect(seen.violations).toEqual(['PRINT:keyboard', 'SCREENSHOT:Meta+Shift+4']);
    });
  });

  describe('what is stopped without being counted', () => {
    it('keeps the menu of a right click shut', () => {
      start();
      expect(page.menu(page.$('question')).defaultPrevented).toBe(true);
      expect(page.menu(page.$('essay')).defaultPrevented).toBe(true);
      expect(page.menu(page.$('essay'), 'mouse').defaultPrevented).toBe(true);
      expect(seen.blocked).toEqual(['menu', 'menu', 'menu']);
      expect(seen.violations).toEqual([]);
    });

    it('leaves the long press in an answer on a touch screen, which is how text is selected there', () => {
      start();
      expect(page.menu(page.$('essay'), 'touch').defaultPrevented).toBe(false);
      expect(page.menu(page.$('question'), 'touch').defaultPrevented).toBe(true);
      // A browser that does not say what the menu was opened with: go by the last touch.
      page.touch(page.$('essay'));
      expect(page.menu(page.$('essay')).defaultPrevented).toBe(false);
      page.touch(page.$('essay'), 'mouse');
      expect(page.menu(page.$('essay')).defaultPrevented).toBe(true);
    });

    it('does not follow links', () => {
      start();
      const click = page.event('click', page.$('link'));
      expect(click.defaultPrevented).toBe(true);
      expect(page.event('auxclick', page.$('link')).defaultPrevented).toBe(true);
      expect(page.event('click', page.$('choice')).defaultPrevented).toBe(false);
      expect(seen.blocked).toEqual(['link', 'link']);
    });

    it('holds the Back button for as long as the attempt is watched', () => {
      start();
      expect(armedGuard()).toEqual({ attemptId: 'a1', path: window.location.pathname });
      expect(window.history.state).toMatchObject({ quizGuard: 'a1' });

      // Back: the browser shows the entry underneath, which is the same page.
      window.history.replaceState({ idx: 3 }, '', window.location.href);
      page.event('popstate');
      expect(window.history.state).toMatchObject({ idx: 3, quizGuard: 'a1' });
      expect(seen.blocked).toEqual(['back']);

      // Submitted, or ended: Back is the student's again.
      disarmGuard('a1');
      expect(armedGuard()).toBeNull();
      window.history.replaceState({ idx: 3 }, '', window.location.href);
      page.event('popstate');
      expect(window.history.state).toEqual({ idx: 3 });
      expect(seen.blocked).toEqual(['back']);
    });

    it('is disarmed only by the attempt that armed it', () => {
      start();
      disarmGuard('another');
      expect(armedGuard()).toMatchObject({ attemptId: 'a1' });
      disarmGuard();
      expect(armedGuard()).toBeNull();
    });
  });

  describe('keeping the screen on', () => {
    // A phone that locks itself while a long question is read would count as leaving.
    const screens = () => {
      const locks = [];
      const wakeLock = {
        refuse: false,
        request: vi.fn(async (what) => {
          if (wakeLock.refuse) throw new DOMException('Battery saver is on', 'NotAllowedError');
          const lock = new EventTarget();
          lock.type = what;
          lock.released = false;
          lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
          locks.push(lock);
          return lock;
        }),
      };
      Object.defineProperty(window.navigator, 'wakeLock', { configurable: true, value: wakeLock });
      return { wakeLock, locks };
    };
    const settled = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
    afterEach(() => { delete window.navigator.wakeLock; });

    it('asks the browser to, takes it up again when the page is back, and lets go at the end', async () => {
      const { wakeLock, locks } = screens();
      start();
      await settled();
      expect(wakeLock.request).toHaveBeenCalledWith('screen');
      expect(locks).toHaveLength(1);
      expect(seen.awake).toEqual([true]);

      // The browser lets go by itself when the page goes out of sight.
      page.hide();
      await locks[0].release();
      page.show();
      await settled();
      expect(locks).toHaveLength(2);
      expect(locks[1].released).toBe(false);

      guard.stop();
      await settled();
      expect(locks[1].released).toBe(true);
    });

    it('says so where the browser will not, so that the student can be told', async () => {
      const { wakeLock } = screens();
      wakeLock.refuse = true;
      start();
      await settled();
      expect(seen.awake).toEqual([false]);
      expect(seen.violations).toEqual([]);
    });

    it('says so where the browser cannot', async () => {
      start();
      await settled();
      expect(seen.awake).toEqual([false]);
    });
  });

  describe('stopping', () => {
    it('marks the page while it watches, and hears nothing afterwards', async () => {
      start();
      expect(document.documentElement.classList.contains('quiz-guard')).toBe(true);
      guard.stop();
      guard.stop();
      expect(document.documentElement.classList.contains('quiz-guard')).toBe(false);

      page.hide();
      page.show();
      page.blur();
      vi.advanceTimersByTime(60_000);
      page.select('question');
      expect(page.clipboard('copy', page.$('question')).defaultPrevented).toBe(false);
      expect(page.clipboard('paste', page.$('essay'), 'anything').defaultPrevented).toBe(false);
      expect(page.key('PrintScreen').defaultPrevented).toBe(false);
      expect(page.key('F5').defaultPrevented).toBe(false);
      expect(page.menu(page.$('question')).defaultPrevented).toBe(false);
      expect(page.event('beforeunload').defaultPrevented).toBe(false);
      guard.expectFileDialog();
      await Promise.resolve();
      // jsdom cannot keep a screen on, which was said once, before the watching stopped.
      expect(seen).toEqual({ violations: [], blocked: [], signals: [], restored: 0, awake: [false] });
    });

    it('can still wait for the student whose leaving ended the attempt', () => {
      start();
      page.hide();
      page.blur();
      guard.stop({ untilBack: true });
      vi.advanceTimersByTime(45_000);
      page.show();
      page.focus();
      page.blur();
      page.focus();
      expect(seen.violations).toEqual(['LEFT_PAGE']);
      expect(seen.signals).toEqual([['TAB_VISIBLE', { awayMs: 45_000 }]]);
    });

    it('waits for nobody who was there when the attempt ended', () => {
      start();
      page.select('question');
      page.clipboard('copy', page.$('question'));
      guard.stop({ untilBack: true });
      page.blur();
      page.focus();
      expect(seen.signals).toEqual([]);
    });
  });
});
