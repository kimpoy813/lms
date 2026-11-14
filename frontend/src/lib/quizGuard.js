// Watching over a quiz that has strict rules. Everything here runs in the student's browser.
//
// Three jobs:
//   1. notice when a rule is broken: leaving the page, copying from it, pasting into it, a
//      screenshot key, printing;
//   2. keep a slip of the hand from becoming a violation where a web page is able to: the reload
//      keys, the Back button, the menu on a right click, pulling the page down on a phone;
//   3. make sure the server hears of every violation, also when the connection is down or the
//      page is being closed: a report is written to this browser's storage first and sent until
//      the server has answered. And when the page could not say anything at all — the browser
//      was killed, the battery ran out — the server learns it from the page being opened again
//      (`openAttempt`).
//
// The server decides what a violation leads to. What a web page cannot see at all — a screenshot
// taken with a phone's buttons or a system shortcut, a second device, a person next to the
// student — is said plainly in docs/QUIZ-RULES.md and to the teacher who switches the rules on.
import { api } from './api.js';

// ── Reports that the server has not answered yet ─────────────────────────────
const STORE_KEY = 'edusphere.quiz.reports.v1';
let memory = {}; // used when the browser offers no storage (some private windows)

function readAll() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return memory;
  }
}
function writeAll(all) {
  memory = all;
  try {
    if (Object.keys(all).length === 0) window.localStorage.removeItem(STORE_KEY);
    else window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* kept in memory for as long as this page lives */
  }
}
function forget(attemptId, key) {
  const all = readAll();
  const left = (all[attemptId] ?? []).filter((r) => r.key !== key);
  if (left.length > 0) all[attemptId] = left;
  else delete all[attemptId];
  writeAll(all);
}

const newKey = () => {
  try {
    return window.crypto.randomUUID();
  } catch {
    // Not a secure page (plain http on a local network): good enough to tell two reports apart.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`;
  }
};

/** Reports of an attempt that are still waiting for the server, oldest first. */
export const pendingReports = (attemptId) => readAll()[attemptId] ?? [];
/** Attempts that have reports waiting (a page that was closed while the connection was down). */
export const attemptsWithPendingReports = () => Object.keys(readAll());
/** The attempt is over as far as the server is concerned: nothing more to tell it. */
export function forgetReports(attemptId) {
  const all = readAll();
  if (!(attemptId in all)) return;
  delete all[attemptId];
  writeAll(all);
}

/** Write a violation down, before anything else can happen to this page. */
export function recordReport(attemptId, kind, detail) {
  const report = { key: newKey(), kind, at: Date.now(), ...(detail ? { detail: String(detail).slice(0, 80) } : {}) };
  const all = readAll();
  all[attemptId] = [...(all[attemptId] ?? []), report].slice(-20);
  writeAll(all);
  return report;
}

const inFlight = new Map();
const SEND_LIMIT_MS = 20_000;

/**
 * Send one report. Resolves to the server's answer ({ outcome, kind, text, number, allowed,
 * warningsLeft }), or to null when it could not be delivered: it then stays written down and is
 * sent again later. Sending the same report twice is harmless — the server counts it once.
 */
export function sendReport(attemptId, report, { keepalive = false } = {}) {
  const running = inFlight.get(report.key);
  if (running) return running;
  const body = { kind: report.kind, key: report.key, agoMs: Math.max(0, Date.now() - report.at), ...(report.detail ? { detail: report.detail } : {}) };
  const request = api.post(`/attempts/${attemptId}/violations`, body, { keepalive })
    .then((answer) => {
      forget(attemptId, report.key);
      return answer;
    })
    .catch((err) => {
      // No connection, or the server is having a bad moment: keep it and try again. Any other
      // answer is final — not signed in any more, not this student's attempt, a report the
      // server will not take.
      const later = err?.status === 0 || err?.status === 429 || err?.status >= 500;
      if (!later) forget(attemptId, report.key);
      return null;
    });
  // A request that never comes back (the page was frozen while it was on its way) must not
  // keep the report from being sent again.
  let limit;
  const promise = Promise.race([request, new Promise((resolve) => { limit = setTimeout(() => resolve(null), SEND_LIMIT_MS); })])
    .finally(() => {
      clearTimeout(limit);
      if (inFlight.get(report.key) === promise) inFlight.delete(report.key);
    });
  inFlight.set(report.key, promise);
  return promise;
}

/** Send everything still written down for an attempt. Resolves to the last answer, or null. */
export async function sendPendingReports(attemptId) {
  let last = null;
  for (const report of pendingReports(attemptId)) {
    const answer = await sendReport(attemptId, report);
    if (answer) last = answer;
    else if (pendingReports(attemptId).some((r) => r.key === report.key)) break; // still no connection
  }
  return last;
}

// ── The page says that it has opened the attempt ─────────────────────────────
const opened = new Map();
const openedDone = new Set();
/**
 * Tell the server that this page shows the attempt: once for each time the page is loaded,
 * however often the screen is drawn. Reports that an earlier page left behind go first, so that
 * leaving and coming back are counted as one thing — and for that reason nothing is said about
 * opening while one of them could not be delivered. Resolves to the server's answer
 * ({ outcome: OPENED | IGNORED | CLOSED } or the answer to a violation); rejects when the
 * server could not be reached, and may then be called again.
 */
export function openAttempt(attemptId) {
  let promise = opened.get(attemptId);
  if (!promise) {
    promise = sendPendingReports(attemptId)
      .then(() => {
        if (pendingReports(attemptId).length > 0) throw Object.assign(new Error('The server could not be reached.'), { status: 0 });
        return api.post(`/attempts/${attemptId}/open`, {});
      })
      .then((answer) => {
        if (opened.get(attemptId) === promise) openedDone.add(attemptId);
        return answer;
      }, (err) => {
        if (opened.get(attemptId) === promise) opened.delete(attemptId);
        throw err;
      });
    opened.set(attemptId, promise);
  }
  return promise;
}
/** Has this page already told the server (and been answered)? */
export const hasOpened = (attemptId) => openedDone.has(attemptId);
/** The attempt is closed, or waits to be continued: the next time it is answered is a new opening. */
export const forgetOpening = (attemptId) => {
  opened.delete(attemptId);
  openedDone.delete(attemptId);
};

// ── Which attempt is being watched ───────────────────────────────────────────
// Kept outside the screen that shows the attempt: the app itself may move on to another page
// (App.jsx reports that), and the screen is drawn anew whenever the server's answer replaces it.
let armed = null;
/** The attempt being watched ({ attemptId, path }), or null. Set by `watchQuiz`. */
export const armedGuard = () => armed;
/** The attempt is over, or its leaving has been reported: nothing more is held against the student. */
export const disarmGuard = (attemptId) => {
  if (!attemptId || armed?.attemptId === attemptId) armed = null;
};

// ── Noticing ─────────────────────────────────────────────────────────────────
/** A window that lost the focus for less than this is not reported (a pop-up that closes by itself). */
export const BLUR_GRACE_MS = 1000;
/** How long the file chooser of a "file upload" question may stay open. */
export const FILE_DIALOG_MAX_MS = 180_000;
/** A screenshot key or the print dialog takes the focus by itself: that is not counted a second time unless it lasts. */
export const SIDE_EFFECT_MS = 10_000;
/** The page stood still for at least this long: the device slept, or the browser was frozen. */
export const SUSPENDED_MS = 30_000;
/**
 * On a touch screen the list of a drop-down (a matching question) is drawn by the system, over
 * the page. Where that takes the focus from the page, it is not counted for this long.
 */
export const PICKER_MAX_MS = 30_000;
/** The list opens with the tap: a focus lost later than this after it has another cause. */
const PICKER_OPENS_MS = 2000;

const TEXT_FIELD = 'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="image"]), [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .cm-editor';

/** The answer field a node belongs to, where the student's own writing lives. */
export function ownField(node) {
  const el = node && node.nodeType === 1 ? node : node?.parentElement;
  return el?.closest?.(TEXT_FIELD) ?? null;
}

const sameText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/**
 * Start watching the page of an attempt.
 *
 * @param {object} options
 * @param {string} options.attemptId
 * @param {(kind: string, detail?: string) => void} options.onViolation  a rule was broken
 * @param {(what: 'back'|'reload'|'shortcut'|'menu'|'link'|'drag') => void} [options.onBlocked]  something was stopped; nothing is held against the student
 * @param {(type: string, extra?: { awayMs?: number }) => void} [options.onSignal]  for the teacher's timeline: came back, used the file chooser or a drop-down that took the focus, the device slept, the focus cannot be told
 * @param {() => void} [options.onRestored]  the browser brought this page back from its memory (Back after leaving)
 * @param {(kept: boolean) => void} [options.onAwake]  whether the screen is being kept on; false where the browser cannot or will not (a phone saving its battery)
 * @param {Window} [options.win]
 * @param {(event: Event) => boolean} [options.trusted]  did the person at the device cause this event? (replaced in tests)
 * @returns {{ stop(options?: { untilBack?: boolean }): void, expectFileDialog(): void }}
 */
export function watchQuiz({ attemptId, onViolation, onBlocked = () => {}, onSignal = () => {}, onRestored = () => {}, onAwake = () => {}, win = window, trusted = (event) => event.isTrusted }) {
  const doc = win.document;
  const path = win.location.pathname;
  armed = { attemptId, path };
  const now = () => win.performance.now();
  let stopped = false;
  let away = null; // { since, kind } from a reported leave until the student is back
  let unfocusedSince = null;
  let unloadAsked = false; // the browser may be showing its own "Leave site?" question
  let fileDialog = null; // { since, timer } while the file chooser is expected to be open
  let pickerAt = null; // when a drop-down of the page was last touched
  let picker = null; // { since, timer } while its list has the focus
  let sideEffectUntil = 0; // losing the focus until then comes from the key that was just reported
  let held = null; // { since, kind }: a leave that is not reported unless it lasts
  let lastPulse = Date.now();
  // A window can only lose a focus that it had: a page opened in a window in the background, or
  // in a browser that reports no focus until the page is touched, is not held to have lost it.
  let everFocused = doc.hasFocus();
  // False once the browser has shown that it does not know where the focus is (below).
  let focusKnown = true;
  let sawHidden = false; // the page was out of sight since the last pulse: its timers were slowed down
  let lock = null;
  // On a Mac the Command key drives the browser, and Control and Option belong to typing
  // (Control+K deletes to the end of the line, Option+E starts an accent).
  const mac = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform ?? '');
  let pointer = 'mouse'; // what the page was last touched with
  const lastAt = {};
  const ownClips = [];
  const timers = new Set();
  const later = (fn, ms) => {
    const id = win.setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };

  /** One key press can arrive as two events (down and up, the key and the print dialog). */
  const violation = (kind, detail) => {
    if (stopped) return;
    const t = now();
    if (lastAt[kind] !== undefined && t - lastAt[kind] < 1500) return;
    lastAt[kind] = t;
    if (kind === 'SCREENSHOT' || kind === 'PRINT') sideEffectUntil = t + 5000;
    onViolation(kind, detail);
  };

  // ── Leaving the page ──
  /** Is the window without the focus, as far as this browser can be believed? */
  const unfocused = () => {
    if (doc.hasFocus()) {
      everFocused = true;
      return false;
    }
    return focusKnown && everFocused;
  };
  const present = () => doc.visibilityState === 'visible' && !unfocused();
  const dropPicker = () => {
    if (!picker) return null;
    const { since, timer } = picker;
    win.clearTimeout(timer);
    timers.delete(timer);
    picker = null;
    return since;
  };
  const leave = (kind, since = now()) => {
    if (stopped || away) return; // one violation per absence, however many events it causes
    dropPicker();
    if (kind !== 'CLOSED_PAGE' && since < sideEffectUntil) {
      // The screenshot tool or the print dialog took the focus. Reported after all if the
      // student does not come straight back.
      if (held) return;
      held = { since, kind };
      later(() => {
        if (stopped || !held || present()) return;
        away = held;
        held = null;
        onViolation(away.kind);
      }, SIDE_EFFECT_MS);
      return;
    }
    held = null;
    away = { since, kind };
    onViolation(kind);
  };
  const fileDialogDone = () => {
    if (!fileDialog) return;
    win.clearTimeout(fileDialog.timer);
    timers.delete(fileDialog.timer);
    const awayMs = Math.round(now() - fileDialog.since);
    fileDialog = null;
    onSignal('FILE_DIALOG', { awayMs });
  };
  const pickerOpened = (since) => {
    pickerAt = null;
    const timer = later(() => {
      picker = null;
      if (!present()) leave('LOST_FOCUS', since);
    }, Math.max(0, PICKER_MAX_MS - (now() - since)));
    picker = { since, timer };
  };
  const settle = () => {
    if (!present()) return;
    unfocusedSince = null;
    held = null;
    fileDialogDone();
    const listSince = dropPicker();
    if (listSince !== null) onSignal('PICKER', { awayMs: Math.round(now() - listSince) });
    if (!away) return;
    const { since, kind } = away;
    away = null;
    onSignal(kind === 'LOST_FOCUS' ? 'WINDOW_FOCUS' : 'TAB_VISIBLE', { awayMs: Math.round(now() - since) });
  };
  /**
   * Is the window still without the focus? Asked a moment after it lost it, and once a second:
   * the browser sends no event when the focus leaves from inside a frame of the page.
   */
  const checkFocus = () => {
    if (stopped) return undefined;
    if (doc.visibilityState !== 'visible') return undefined; // hidden: reported as leaving the page
    if (!unfocused()) return settle(); // the focus may also be in a frame of this page
    if (away || held || fileDialog || picker) return undefined;
    if (unloadAsked) {
      // The browser's own question was on screen; give the focus a moment to come back.
      unloadAsked = false;
      unfocusedSince = now();
      return undefined;
    }
    if (unfocusedSince === null) unfocusedSince = now();
    else if (now() - unfocusedSince >= BLUR_GRACE_MS) {
      if (pickerAt !== null && Math.abs(unfocusedSince - pickerAt) <= PICKER_OPENS_MS) pickerOpened(unfocusedSince);
      else leave('LOST_FOCUS', unfocusedSince);
    }
    return undefined;
  };
  const onBlur = () => {
    if (unfocusedSince === null) unfocusedSince = now();
    later(checkFocus, BLUR_GRACE_MS + 30);
  };
  const onFocus = () => {
    unloadAsked = false;
    settle();
  };
  /**
   * Keys reach a page only while it has the focus. A browser that delivers them and says in the
   * same breath that the page has none does not know where the focus is: from then on a missing
   * focus is not counted, and the teacher is told that this could not be watched.
   */
  const distrustFocus = () => {
    focusKnown = false;
    unfocusedSince = null;
    onSignal('FOCUS_UNKNOWN');
  };
  const onVisibility = () => {
    sawHidden = true;
    if (doc.visibilityState === 'hidden') {
      // A phone shows its file chooser or camera over the browser.
      if (!fileDialog) leave('LEFT_PAGE');
    } else {
      keepAwake();
      settle();
    }
  };
  const onBeforeUnload = (e) => {
    // Closing or reloading would end the attempt: let the browser ask first, so that a slip of
    // the hand can be taken back.
    unloadAsked = true;
    e.preventDefault();
    e.returnValue = '';
  };
  const onPageHide = () => leave('CLOSED_PAGE');
  const onPageShow = (e) => {
    if (e.persisted) onRestored();
  };
  const expectFileDialog = () => {
    if (stopped) return;
    const since = fileDialog?.since ?? now();
    if (fileDialog) {
      win.clearTimeout(fileDialog.timer);
      timers.delete(fileDialog.timer);
    }
    const timer = later(() => {
      fileDialog = null;
      if (!present()) leave(doc.visibilityState === 'visible' ? 'LOST_FOCUS' : 'LEFT_PAGE');
    }, FILE_DIALOG_MAX_MS);
    fileDialog = { since, timer };
  };
  // The page can only be clicked or typed in once the file chooser is gone.
  const onInput = (e) => {
    if (e.type === 'touchstart') pointer = 'touch';
    else if (e.pointerType) pointer = e.pointerType;
    // Only keys are proof: some browsers deliver a click first and move the focus afterwards.
    if (e.type === 'keydown' && focusKnown && !away && doc.visibilityState === 'visible' && !doc.hasFocus() && trusted(e)) distrustFocus();
    // With a mouse the list of a drop-down is part of the browser window and takes no focus.
    if (e.type !== 'keydown' && pointer !== 'mouse' && e.target?.closest?.('select')) pickerAt = now();
    if (fileDialog && now() - fileDialog.since > 300) fileDialogDone();
  };

  // ── Copying, pasting, dragging ──
  const remember = (text) => {
    const t = sameText(text);
    if (!t.trim() || ownClips.includes(t)) return;
    ownClips.push(t);
    if (ownClips.length > 40) ownClips.shift();
  };
  const isOwn = (text) => ownClips.includes(sameText(text));
  const selectedIn = (field) => {
    if (typeof field.value === 'string') {
      // A number field does not say what is selected: its whole value is the student's own.
      let from = null;
      let to = null;
      try {
        from = field.selectionStart;
        to = field.selectionEnd;
      } catch {
        /* this kind of field has no selection */
      }
      return typeof from === 'number' && typeof to === 'number' ? field.value.slice(from, to) : field.value;
    }
    return String(win.getSelection?.() ?? '');
  };
  const onCopyFirst = (e) => {
    if (ownField(e.target)) return; // their own writing: see onCopyLast
    // Nothing of the quiz reaches the clipboard.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (String(win.getSelection?.() ?? '').trim()) violation('COPY');
  };
  // After the editor has had its say (the code editor fills the clipboard itself).
  const onCopyLast = (e) => {
    const field = ownField(e.target);
    if (!field) return;
    let text = '';
    try {
      text = e.clipboardData?.getData('text/plain') ?? '';
    } catch {
      /* not readable during this event */
    }
    remember(text || selectedIn(field));
  };
  const onPaste = (e) => {
    const field = ownField(e.target);
    let text = '';
    try {
      text = e.clipboardData?.getData('text/plain') ?? '';
    } catch {
      /* treated as empty */
    }
    const hasFiles = (e.clipboardData?.files?.length ?? 0) > 0;
    // Text the student copied or cut from an answer of their own may come back.
    if (field && !hasFiles && (text === '' || isOwn(text))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (field && text.trim()) violation('PASTE');
  };
  const onDragStart = (e) => {
    const field = ownField(e.target);
    if (field) remember(selectedIn(field));
    else {
      e.preventDefault(); // the text and pictures of the quiz cannot be dragged out
      onBlocked('drag');
    }
  };
  const onDrop = (e) => {
    const field = ownField(e.target);
    if (!field) return; // the area for uploading a file looks after itself
    const text = e.dataTransfer?.getData('text/plain') ?? '';
    if (!text.trim() || isOwn(text)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    violation('PASTE', 'dropped');
  };
  const onContextMenu = (e) => {
    // A long press in an answer field on a touch screen is how its text is selected. (Not every
    // browser says on the event itself what it was done with.)
    const by = e.pointerType || (e.mozInputSource === 5 ? 'touch' : pointer);
    if (ownField(e.target) && by !== 'mouse') return;
    // Everywhere else the menu stays shut: it leads to printing, searching and translating —
    // and, in some browsers, it takes the focus from the page.
    e.preventDefault();
    onBlocked('menu');
  };
  const onLink = (e) => {
    const link = e.target?.closest?.('a[href]');
    if (!link) return;
    // Opening it would take the student off the page.
    e.preventDefault();
    e.stopPropagation();
    onBlocked('link');
  };

  // ── Keys ──
  const screenshot = (detail) => {
    violation('SCREENSHOT', detail);
    // The picture a screenshot key leaves on the clipboard is replaced, where the browser allows it.
    try {
      win.navigator.clipboard?.writeText?.('')?.catch?.(() => {});
    } catch {
      /* not allowed here */
    }
  };
  const onKeyFirst = (e) => {
    const key = e.key ?? '';
    const k = key.toLowerCase();
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (key === 'PrintScreen' || key === 'Snapshot') return screenshot('PrintScreen');
    // macOS (⌘⇧3 / 4 / 5 / 6) and the Windows snipping tool (Win+Shift+S) — in the rare case
    // that the system lets the page see the keys at all. By position: with Shift held, the key
    // that carries a 4 types a "$".
    const at = (e.code ?? '').replace(/^(Digit|Key)/, '');
    if (e.metaKey && e.shiftKey && ['3', '4', '5', '6', 'S'].includes(at || key.toUpperCase())) return screenshot(`Meta+Shift+${at || key.toUpperCase()}`);
    if (mod && !e.altKey && k === 'p') {
      e.preventDefault();
      return violation('PRINT', 'keyboard');
    }
    if (key === 'F5' || (mod && !e.altKey && k === 'r')) {
      e.preventDefault();
      return onBlocked('reload');
    }
    return undefined;
  };
  const onKeyUp = (e) => {
    // Windows tells the page about PrintScreen only when the key is let go.
    if (e.key === 'PrintScreen' || e.key === 'Snapshot') screenshot('PrintScreen');
  };
  // Shortcuts of the browser that open something over or instead of the page (find, save,
  // history, the address bar, the developer tools). After the page's own editors: the code
  // editor uses some of these keys itself and has already claimed them by then.
  const onKeyLast = (e) => {
    if (e.defaultPrevented) return;
    const key = e.key ?? '';
    const k = key.toLowerCase();
    const mod = mac ? e.metaKey : e.ctrlKey;
    const opens = (mod && !e.altKey && !e.shiftKey && ['s', 'u', 'f', 'g', 'o', 'h', 'j', 'd', 'l', 'k', 'e'].includes(k))
      || (mod && e.shiftKey && ['i', 'j', 'c', 'o', 'b', 'h', 'delete'].includes(k))
      // On a Mac: the history, back and forward, and the developer tools.
      || (mac && e.metaKey && !e.altKey && !e.shiftKey && ['y', '[', ']'].includes(k))
      || (mac && e.metaKey && e.altKey && ['i', 'j', 'c', 'u'].includes(e.code?.replace(/^Key/, '').toLowerCase() ?? k))
      || ['F1', 'F3', 'F6', 'F7', 'F12'].includes(key)
      || (!mac && e.altKey && !e.ctrlKey && !e.metaKey && ['d', 'e', 'f', 'home', 'arrowleft', 'arrowright'].includes(k));
    if (!opens) return;
    e.preventDefault();
    onBlocked('shortcut');
  };
  const onBeforePrint = () => violation('PRINT');

  // ── The Back button ──
  // One extra entry in the history: Back lands on the same page, and the entry is put there again.
  const pushTrap = () => {
    try {
      win.history.pushState({ ...(win.history.state ?? {}), quizGuard: attemptId }, '', win.location.href);
    } catch {
      /* the browser refused (too many entries in a short time) */
    }
  };
  if (win.history.state?.quizGuard !== attemptId) pushTrap();
  const onPopState = () => {
    if (stopped || win.history.state?.quizGuard === attemptId) return;
    if (armed?.attemptId !== attemptId) return; // the attempt is over: Back is the student's again
    if (win.location.pathname !== path) return; // the app went somewhere else: App.jsx sees to that
    pushTrap();
    onBlocked('back');
  };

  // ── Keeping the screen on ──
  // A phone that locks itself while a long question is being read would count as leaving.
  async function keepAwake() {
    if (stopped || lock || doc.visibilityState !== 'visible') return;
    try {
      if (!win.navigator.wakeLock) throw new Error('This browser cannot keep the screen on.');
      const held = await win.navigator.wakeLock.request('screen');
      if (stopped) {
        held.release?.().catch?.(() => {});
        return;
      }
      lock = held;
      held.addEventListener?.('release', () => { if (lock === held) lock = null; });
      onAwake(true);
    } catch {
      // Not supported, or not allowed (a phone that is saving its battery): the student is told
      // that the screen may switch itself off.
      if (!stopped) onAwake(false);
    }
  }

  const listeners = [
    [doc, 'visibilitychange', onVisibility],
    [win, 'blur', onBlur],
    [win, 'focus', onFocus],
    [win, 'beforeunload', onBeforeUnload],
    [win, 'pagehide', onPageHide],
    [win, 'pageshow', onPageShow],
    [win, 'popstate', onPopState],
    [win, 'beforeprint', onBeforePrint],
    [win, 'copy', onCopyFirst, true],
    [win, 'cut', onCopyFirst, true],
    [doc, 'copy', onCopyLast],
    [doc, 'cut', onCopyLast],
    [win, 'paste', onPaste, true],
    [win, 'dragstart', onDragStart, true],
    [win, 'drop', onDrop, true],
    [win, 'contextmenu', onContextMenu, true],
    [win, 'click', onLink, true],
    [win, 'auxclick', onLink, true],
    [win, 'keydown', onKeyFirst, true],
    [win, 'keyup', onKeyUp, true],
    [win, 'keydown', onKeyLast],
    [win, 'pointerdown', onInput, true],
    [win, 'touchstart', onInput, true],
    [win, 'click', onInput, true],
    [win, 'keydown', onInput, true],
  ];
  for (const [target, type, fn, capture] of listeners) target.addEventListener(type, fn, capture ?? false);
  const pulse = win.setInterval(() => {
    // A clock that jumped while the page was on screen: the device slept with the quiz open.
    // The page cannot tell that from a browser that hung, so it is a note for the teacher.
    const gap = Date.now() - lastPulse;
    lastPulse = Date.now();
    if (gap >= SUSPENDED_MS && !away && !sawHidden && doc.visibilityState === 'visible') onSignal('SUSPENDED', { awayMs: gap });
    sawHidden = doc.visibilityState !== 'visible';
    checkFocus();
  }, 1000);
  doc.documentElement.classList.add('quiz-guard');
  keepAwake();

  return {
    /**
     * Stop watching. With `untilBack`, a student who is away at this moment (the attempt was just
     * ended for leaving) is still waited for, so that the teacher can see how long they were gone.
     */
    stop({ untilBack = false } = {}) {
      if (stopped) return;
      stopped = true;
      for (const [target, type, fn, capture] of listeners) target.removeEventListener(type, fn, capture ?? false);
      win.clearInterval(pulse);
      for (const id of timers) win.clearTimeout(id);
      timers.clear();
      doc.documentElement.classList.remove('quiz-guard');
      lock?.release?.().catch?.(() => {});
      lock = null;
      if (untilBack && away) {
        const { since, kind } = away;
        const back = () => {
          if (!present()) return;
          win.removeEventListener('focus', back);
          doc.removeEventListener('visibilitychange', back);
          onSignal(kind === 'LOST_FOCUS' ? 'WINDOW_FOCUS' : 'TAB_VISIBLE', { awayMs: Math.round(now() - since) });
        };
        win.addEventListener('focus', back);
        doc.addEventListener('visibilitychange', back);
      }
    },
    /** The student pressed "Add files": the file chooser may now take the focus, or cover the page on a phone. */
    expectFileDialog,
  };
}
