// Taking a quiz (full screen, no app navigation) and reviewing a finished attempt.
//
// What keeps an attempt safe:
//  • every answer is saved to the server a moment after it changes, and retried if the network fails;
//  • the deadline is the server's — the countdown here is only a display, corrected for clock difference;
//  • when time runs out the server submits the attempt even if this page is closed.
//
// A quiz with strict rules is also watched (lib/quizGuard.js): leaving the page, copying, pasting
// or a screenshot key is reported to the server, which answers with a warning or ends the attempt.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CircleDashed, Clock, CloudOff, Flag, Grid3x3, PlayCircle, Send, ShieldAlert, Timer, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ProgrammingAnswer } from '../../components/CodeWorkbench.jsx';
import { preloadCodeEditor } from '../../components/LazyCodeEditor.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Modal, PageLoader, Spinner } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatDuration, formatPercent, formatScore, formatSpan, formatTime, plural } from '../../lib/format.js';
import { disarmGuard, forgetOpening, hasOpened, openAttempt, pendingReports, recordReport, sendPendingReports, sendReport, watchQuiz } from '../../lib/quizGuard.js';
import { AnswerInput, AnswerReview, QuestionText, ScoreChip, typeLabel } from './quiz/QuestionParts.jsx';
import { consequenceText, RulesForStudents, violationText } from './quiz/Rules.jsx';

// Said when the page stops something that would otherwise have counted against the student.
const BLOCKED = {
  back: 'The Back button is switched off during this quiz. Use Submit when you have finished.',
  reload: 'Reloading is switched off during this quiz: it would end your attempt.',
  shortcut: 'That shortcut is switched off during this quiz.',
  menu: 'The right-click menu is switched off during this quiz.',
  link: 'Links are switched off during this quiz: opening one would take you off the page.',
};

export default function QuizAttempt() {
  const { classId, quizId, attemptId } = useParams();
  const client = useQueryClient();
  // Raised when the server's view of the attempt replaced this page's: the answering screen starts afresh.
  const [generation, setGeneration] = useState(0);
  const key = ['attempt', attemptId];
  // While an attempt is in progress the page owns the answers: never refetch over them. And
  // nothing is kept once the page is left (gcTime): coming back to it asks the server again,
  // instead of showing the answers — or the ended attempt — as they were when it was first opened.
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/attempts/${attemptId}`), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: 1 });
  const back = `/classes/${classId}/quizzes/${quizId}`;

  if (query.isPending) return <div className="grid min-h-dvh place-items-center"><PageLoader label="Opening the quiz…" /></div>;
  if (query.isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <EmptyState icon={AlertTriangle} title={query.error.status === 404 ? 'This attempt was not found' : 'The quiz could not be opened'} description={query.error.message} action={<div className="flex justify-center gap-2"><Button variant="secondary" onClick={() => query.refetch()}>Try again</Button><Button to={back}>Back to the quiz</Button></div>} />
      </div>
    );
  }
  const attempt = query.data;
  /** The attempt is over and this page stays: stop watching, and take the extra history entry away. */
  const release = () => {
    disarmGuard(attemptId);
    forgetOpening(attemptId);
    if (window.history.state?.quizGuard === attemptId) window.history.back();
  };
  const refreshLists = () => {
    client.invalidateQueries({ queryKey: ['class', classId] });
    client.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const finish = (data) => {
    client.setQueryData(key, data);
    if (data.status !== 'IN_PROGRESS') release();
    refreshLists();
  };
  /** The server knows more than this page (time ran out, the attempt was ended): ask it, and start the page afresh. */
  const reload = async () => {
    const result = await query.refetch();
    if (result.data && result.data.status !== 'IN_PROGRESS') release();
    setGeneration((g) => g + 1);
    refreshLists();
  };
  if (attempt.status === 'IN_PROGRESS') return <Taking key={`${attempt.id}:${generation}`} attempt={attempt} back={back} onFinished={finish} onClosedElsewhere={reload} />;
  if (attempt.status === 'REOPENED') return <ContinueGate attempt={attempt} back={back} onContinued={reload} />;
  if (attempt.status === 'TERMINATED') return <Terminated attempt={attempt} back={back} />;
  return <Review attempt={attempt} back={back} />;
}

const noun = (attempt) => (attempt.quiz.kind === 'EXAM' ? 'examination' : 'quiz');

function Frame({ attempt, back, children }) {
  return (
    <div className="min-h-dvh bg-canvas pb-12">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
          <Link to={back} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-soft hover:text-brand"><ArrowLeft className="size-4" aria-hidden="true" />Back to the quiz</Link>
          <p className="ml-auto min-w-0 truncate text-sm font-semibold text-ink">{attempt.quiz.title}</p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-6">{children}</main>
    </div>
  );
}

// ── Reopened by the teacher, not continued yet ───────────────────────────────
function ContinueGate({ attempt, back, onContinued }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { seconds, continueBy } = attempt.reopened;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/quizzes/${attempt.quizId}/attempts`, { acceptRules: true });
      await onContinued();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Frame attempt={attempt} back={back}>
      <Card className="sm:p-8">
        <span className="grid size-14 place-items-center rounded-2xl bg-brand-soft text-brand"><PlayCircle className="size-7" aria-hidden="true" /></span>
        <h1 className="mt-4 text-xl font-bold text-ink">Your teacher reopened this attempt</h1>
        <p className="mt-2 text-sm text-soft">
          You continue with the answers you had already given. <strong className="font-semibold text-ink">You have {formatSpan(seconds)}</strong>, counted from the moment you press Continue; the timer cannot be paused.
          {continueBy ? <> Continue before <strong className="font-semibold text-ink">{formatDateTime(continueBy)}</strong>: after that the attempt is handed in with the answers it has.</> : null}
        </p>
        {attempt.strictRules && <RulesForStudents warnings={attempt.strictRules.warnings} noun={noun(attempt)} className="mt-5 border-t border-line pt-5" />}
        {error && <Alert tone="bad" className="mt-4">{error}</Alert>}
        <div className="mt-6 flex flex-wrap gap-2">
          <Button size="lg" icon={PlayCircle} loading={busy} onClick={go}>Continue</Button>
          <Button size="lg" variant="secondary" to={back}>Not now</Button>
        </div>
      </Card>
    </Frame>
  );
}

// ── Ended for a rule violation ───────────────────────────────────────────────
function Terminated({ attempt, back }) {
  const { at, kind } = attempt.terminated;
  return (
    <Frame attempt={attempt} back={back}>
      <Card className="text-center sm:p-8">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-bad-soft text-bad"><ShieldAlert className="size-7" aria-hidden="true" /></span>
        <h1 className="mt-4 text-xl font-bold text-ink">Your attempt was ended</h1>
        <p className="mt-1 text-sm text-faint">Attempt {attempt.attemptNumber} · ended {formatDateTime(at)}</p>
        <p className="mx-auto mt-4 max-w-md text-sm text-soft">It was recorded that you <strong className="font-semibold text-ink">{violationText(kind)}</strong>. Under the rules of this {noun(attempt)} the attempt is marked as <strong className="font-semibold text-ink">failed, with 0 points</strong>.</p>
        <p className="mx-auto mt-3 max-w-md text-sm text-soft">Only your teacher can reopen it. If something outside your control caused this, tell your teacher what happened. The answers you had given are kept.</p>
        <Button to={back} variant="secondary" className="mt-6">Back to the quiz</Button>
      </Card>
    </Frame>
  );
}

/** The student's name across the page, faintly: a picture taken of the screen says whose screen it was. */
function Watermark() {
  const { user } = useAuth();
  const image = useMemo(() => {
    const label = [user?.name, user?.studentProfile?.studentNumber ?? user?.email].filter(Boolean).join(' · ').replace(/[<>&"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><text x="180" y="110" text-anchor="middle" transform="rotate(-24 180 110)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#808080" fill-opacity="0.13">${label}</text></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }, [user]);
  return <div className="pointer-events-none fixed inset-0 z-10" style={{ backgroundImage: image }} aria-hidden="true" data-quiz-watermark />;
}

// ── Answering ────────────────────────────────────────────────────────────────
function Taking({ attempt, back, onFinished, onClosedElsewhere }) {
  const navigate = useNavigate();
  const questions = attempt.questions;
  // The strict rules as they bind this attempt ({ warnings, used }), or null.
  const rules = attempt.rules;
  const strict = Boolean(rules);
  const [index, setIndex] = useState(() => Math.max(0, questions.findIndex((q) => !q.answered)));
  const [answers, setAnswers] = useState(() => Object.fromEntries(questions.map((q) => [q.position, { response: q.response, flagged: q.flagged, files: q.files ?? [] }])));
  const [unsaved, setUnsaved] = useState(() => new Set());
  const [saving, setSaving] = useState(0);
  const [saveError, setSaveError] = useState(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [palette, setPalette] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [lastSaved, setLastSaved] = useState(attempt.lastSavedAt);

  // The newest value of every answer, for the save timers.
  const latest = useRef(answers);
  latest.current = answers;
  const timers = useRef(new Map());
  const pending = useRef(new Set());
  const closed = useRef(false);

  // ── Strict rules ──
  // Violations this page knows of: those the server has counted, and those still on their way to
  // it (written down by this page, or by an earlier one that was closed while offline).
  const waiting = useRef(strict ? pendingReports(attempt.id) : []);
  const used = useRef((rules?.used ?? 0) + waiting.current.length);
  const [warningsUsed, setWarningsUsed] = useState(used.current);
  // The warning on screen: { kind, number, at }. A page that comes back after it was thrown away
  // while the student was gone starts with the warning that could not be shown then.
  const [warning, setWarning] = useState(() => {
    const last = waiting.current.at(-1);
    return last && used.current <= rules.warnings ? { kind: last.kind, number: used.current, at: last.at } : null;
  });
  // Set once this page knows the attempt is over, before the server has confirmed it: { kind }.
  // The answers typed until then are still saved; nothing more can be typed.
  const [ended, setEnded] = useState(() => (strict && used.current > rules.warnings ? { kind: waiting.current.at(-1)?.kind } : null));
  const over = useRef(Boolean(ended));
  // Under strict rules the page first tells the server that it has opened the attempt:
  // 'asking' → 'open', or 'failed' when the server could not be reached.
  const [opening, setOpening] = useState(strict && !ended && !hasOpened(attempt.id) ? 'asking' : 'open');
  const guard = useRef(null);
  // The latest report of a violation on its way to the server.
  const lastReport = useRef(null);
  // The browser would not keep the screen on: a phone that locks itself counts as leaving.
  const [screenMayLock, setScreenMayLock] = useState(false);

  // The code editor is a download of its own. Fetched now, it is there when the student reaches
  // the programming question, whatever the connection does in between.
  const hasProgram = questions.some((q) => q.question.type === 'PROGRAMMING');
  useEffect(() => { if (hasProgram) preloadCodeEditor(); }, [hasProgram]);

  const save = useCallback(async (position) => {
    if (closed.current) return;
    const value = latest.current[position];
    setSaving((n) => n + 1);
    try {
      const result = await api.put(`/attempts/${attempt.id}/answers/${position}`, { response: value.response ?? null, flagged: value.flagged });
      // Only clear the "unsaved" mark if nothing changed while the request was on its way.
      if (latest.current[position] === value) {
        pending.current.delete(position);
        setUnsaved((s) => { const next = new Set(s); next.delete(position); return next; });
      }
      setLastSaved(result.savedAt);
      setSaveError(null);
    } catch (err) {
      if (err.code === 'TIME_UP' || err.code === 'ATTEMPT_CLOSED') {
        closed.current = true;
        onClosedElsewhere();
        return;
      }
      setSaveError(err.status === 0 ? 'offline' : err.message);
      // Try again shortly; the answer stays marked as unsaved.
      clearTimeout(timers.current.get(position));
      timers.current.set(position, setTimeout(() => save(position), 5000));
    } finally {
      setSaving((n) => n - 1);
    }
  }, [attempt.id, onClosedElsewhere]);

  const change = (position, patch, delay = 700) => {
    setAnswers((a) => ({ ...a, [position]: { ...a[position], ...patch } }));
    pending.current.add(position);
    setUnsaved((s) => new Set(s).add(position));
    clearTimeout(timers.current.get(position));
    timers.current.set(position, setTimeout(() => save(position), delay));
  };

  /** Send every unsaved answer now. Resolves when all of them have been tried once. */
  const flush = useCallback(async () => {
    const positions = [...pending.current];
    for (const position of positions) clearTimeout(timers.current.get(position));
    await Promise.all(positions.map((position) => save(position)));
  }, [save]);

  /** What the server said about a violation (null: it has not been reached yet). */
  const heard = useCallback((answer) => {
    if (!answer || closed.current) return;
    if (answer.outcome === 'WARNING' && !over.current) {
      // The server's count stands; reports still on their way come on top of it.
      used.current = Math.max(used.current, answer.number + pendingReports(attempt.id).length);
      setWarningsUsed(used.current);
      return;
    }
    // Ended, already closed, or not as this page thought (the teacher changed the rules in the
    // meantime): in each case the server's view replaces this page's.
    closed.current = true;
    onClosedElsewhere();
  }, [attempt.id, onClosedElsewhere]);

  /** A rule was broken. Written down first, shown at once, then reported until the server answers. */
  const violate = useCallback((kind, detail) => {
    if (closed.current || over.current) return;
    const report = recordReport(attempt.id, kind, detail);
    used.current += 1;
    setWarningsUsed(used.current);
    // What was typed in the last moment is saved first: it was written before the violation.
    const saved = flush();
    const leaving = kind === 'LEFT_PAGE' || kind === 'CLOSED_PAGE';
    if (used.current > rules.warnings) {
      over.current = true;
      disarmGuard(attempt.id);
      guard.current?.stop({ untilBack: true });
      setWarning(null);
      setEnded({ kind });
    } else {
      setWarning({ kind, number: used.current, at: Date.now() });
    }
    // A page that is going out of sight may not get another chance: its report leaves at once.
    const ready = leaving || !over.current ? Promise.resolve() : Promise.race([saved, new Promise((resolve) => { setTimeout(resolve, 1500); })]);
    const sent = ready.then(() => sendReport(attempt.id, report, { keepalive: true }));
    lastReport.current = sent;
    sent.then(heard);
  }, [attempt.id, rules, flush, heard]);
  const onViolation = useRef(violate);
  onViolation.current = violate;
  const onHeard = useRef(heard);
  onHeard.current = heard;
  const onFlush = useRef(flush);
  onFlush.current = flush;

  useEffect(() => {
    if (!strict) return undefined;
    // Reports that could not be delivered are sent again every few seconds and when the
    // connection returns — after the answers that were still unsaved.
    let busy = false;
    const send = async () => {
      if (busy || pendingReports(attempt.id).length === 0) return;
      busy = true;
      try {
        if (over.current) await Promise.race([onFlush.current(), new Promise((resolve) => { setTimeout(resolve, 3000); })]);
        onHeard.current(await sendPendingReports(attempt.id));
      } finally {
        busy = false;
      }
    };
    if (over.current) send(); // a page that was loaded anew with the end of the attempt still to be reported
    const id = setInterval(send, 4000);
    window.addEventListener('online', send);
    return () => { clearInterval(id); window.removeEventListener('online', send); };
  }, [strict, attempt.id]);

  // The page tells the server that it has opened the attempt (once for each load of the page).
  // A page that was closed without a word is recognised by this second opening.
  const [openTry, setOpenTry] = useState(0);
  useEffect(() => {
    // Already told and answered, and this screen was only drawn anew: the answer is not acted on twice.
    if (!strict || over.current || hasOpened(attempt.id)) return undefined;
    let current = true;
    openAttempt(attempt.id).then((answer) => {
      if (!current) return;
      if (answer.outcome === 'WARNING') {
        used.current = Math.max(used.current, answer.number + pendingReports(attempt.id).length);
        setWarningsUsed(used.current);
        setWarning((w) => w ?? { kind: answer.kind, number: answer.number, at: Date.now() });
        setOpening('open');
      } else if (answer.outcome === 'OPENED' || answer.outcome === 'IGNORED') {
        const { warned } = answer;
        if (warned) {
          used.current = Math.max(used.current, warned.number + pendingReports(attempt.id).length);
          setWarningsUsed(used.current);
          setWarning((w) => w ?? { kind: warned.kind, number: warned.number, at: new Date(warned.at).getTime() });
        }
        setOpening('open');
      } else {
        closed.current = true;
        onClosedElsewhere();
      }
    }, () => { if (current) setOpening('failed'); });
    return () => { current = false; };
  }, [strict, attempt.id, openTry, onClosedElsewhere]);

  useEffect(() => {
    if (!strict || over.current || opening !== 'open') return undefined;
    const watch = watchQuiz({
      attemptId: attempt.id,
      onViolation: (kind, detail) => onViolation.current(kind, detail),
      onBlocked: (what) => { if (BLOCKED[what]) toast.warning(BLOCKED[what]); },
      // "Came back" is read by the server after the report of the absence that it ends.
      onSignal: (type, extra) => { Promise.resolve(lastReport.current).then(() => api.post(`/attempts/${attempt.id}/events`, { type, ...extra })).catch(() => {}); },
      // Brought back by the browser's Back button after the page had been left: that is a new
      // opening of the page. Ask the server what became of the attempt.
      onRestored: () => { forgetOpening(attempt.id); onHeard.current({ outcome: 'CLOSED' }); },
      onAwake: (kept) => setScreenMayLock(!kept),
    });
    guard.current = watch;
    return () => { watch.stop(); if (guard.current === watch) guard.current = null; };
  }, [strict, attempt.id, opening]);

  // ── Clock ──
  const offset = useMemo(() => new Date(attempt.serverTime).getTime() - Date.now(), [attempt.serverTime]);
  const deadline = attempt.deadlineAt ? new Date(attempt.deadlineAt).getTime() : null;
  const [remaining, setRemaining] = useState(() => (deadline ? Math.max(0, (deadline - (Date.now() + offset)) / 1000) : null));
  const timedOut = useRef(false);

  const submit = useCallback(async (auto = false) => {
    if (over.current) return; // ended for a violation: the report settles what becomes of it
    setSubmitting(true);
    setSubmitError(null);
    try {
      await flush();
      // A violation that is still on its way to the server is settled before the attempt is handed in.
      if (strict) await sendPendingReports(attempt.id);
      const data = await api.post(`/attempts/${attempt.id}/submit`);
      closed.current = true;
      guard.current?.stop();
      onFinished(data);
    } catch (err) {
      if (err.code === 'ATTEMPT_CLOSED' || err.code === 'TIME_UP') {
        closed.current = true;
        onClosedElsewhere();
        return;
      }
      setSubmitting(false);
      setConfirm(false);
      setSubmitError(auto ? `Time is up, but the quiz could not be submitted from this device (${err.message}). The server will submit your saved answers automatically.` : err.message);
    }
  }, [attempt.id, strict, flush, onFinished, onClosedElsewhere]);

  useEffect(() => {
    if (!deadline) return undefined;
    const tick = () => {
      const left = Math.max(0, (deadline - (Date.now() + offset)) / 1000);
      setRemaining(left);
      if (left <= 0 && !timedOut.current) {
        timedOut.current = true;
        submit(true);
      }
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, offset, submit]);

  // ── Things the teacher may want to know about, and things the student must not lose ──
  useEffect(() => {
    const report = (type, extra) => api.post(`/attempts/${attempt.id}/events`, { type, ...extra }).catch(() => {});
    // A lost connection can only be told of once it is back: with how long it was gone.
    let offlineSince = navigator.onLine === false ? Date.now() : null;
    // Without strict rules, leaving the tab is only a signal for the teacher. With them it is a
    // violation, and lib/quizGuard.js does the watching.
    const onVisibility = () => { if (!strict) report(document.hidden ? 'TAB_HIDDEN' : 'TAB_VISIBLE'); };
    const onBlur = () => { if (!strict) report('WINDOW_BLUR'); };
    const onOffline = () => { setOnline(false); offlineSince ??= Date.now(); };
    const onOnline = () => {
      setOnline(true);
      report('ONLINE', offlineSince === null ? {} : { awayMs: Math.max(0, Date.now() - offlineSince) });
      offlineSince = null;
      flush();
    };
    const onBeforeUnload = (e) => { if (pending.current.size > 0) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onBeforeUnload);
    const savers = timers.current;
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('beforeunload', onBeforeUnload);
      for (const t of savers.values()) clearTimeout(t);
    };
  }, [attempt.id, flush, strict]);

  const current = questions[index];
  const value = answers[current.position];
  const answeredCount = questions.filter((q) => answers[q.position].response != null).length;
  const flaggedCount = questions.filter((q) => answers[q.position].flagged).length;
  const unanswered = questions.length - answeredCount;
  const showTimer = remaining !== null && remaining < 24 * 3600;
  const urgent = showTimer && remaining <= 60;
  const soon = showTimer && remaining <= 300;

  const go = (i) => { setIndex(Math.max(0, Math.min(questions.length - 1, i))); setPalette(false); window.scrollTo({ top: 0 }); };

  const Palette = (
    <nav aria-label="Questions">
      <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 lg:grid-cols-5">
        {questions.map((q, i) => {
          const a = answers[q.position];
          const done = a.response != null;
          return (
            <li key={q.position}>
              <button type="button" onClick={() => go(i)} aria-current={i === index ? 'step' : undefined} aria-label={`Question ${i + 1}${done ? ', answered' : ', not answered'}${a.flagged ? ', flagged' : ''}`}
                className={cn('relative grid h-10 w-full place-items-center rounded-lg border text-sm font-semibold tabular-nums transition-colors', i === index ? 'border-brand ring-2 ring-brand/30' : 'border-line', done ? 'bg-brand-soft text-brand' : 'bg-surface text-soft hover:bg-raised')}>
                {i + 1}
                {a.flagged && <Flag className="absolute -right-1 -top-1 size-3.5 fill-warn text-warn" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
        <li className="flex items-center gap-1.5"><span className="size-3 rounded bg-brand-soft ring-1 ring-brand/30" />Answered</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded border border-line bg-surface" />Not yet</li>
        <li className="flex items-center gap-1.5"><Flag className="size-3 fill-warn text-warn" />Flagged</li>
      </ul>
    </nav>
  );

  if (opening !== 'open') {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas p-6">
        {opening === 'asking' ? <PageLoader label="Opening the quiz…" /> : (
          <EmptyState icon={WifiOff} title="The quiz could not be opened" description="The server could not be reached. Check your connection and try again. Your answers so far are saved, and the timer keeps running."
            action={<Button onClick={() => { setOpening('asking'); setOpenTry((n) => n + 1); }}>Try again</Button>} />
        )}
      </div>
    );
  }

  // This page knows that the attempt is over; the server is being told (or will be, once the connection is back).
  if (ended) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas p-6" role="alert">
        <Card className="w-full max-w-md text-center sm:p-8">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-bad-soft text-bad"><ShieldAlert className="size-7" aria-hidden="true" /></span>
          <h1 className="mt-4 text-xl font-bold text-ink">Your attempt has been ended</h1>
          <p className="mt-3 text-sm text-soft">You <strong className="font-semibold text-ink">{violationText(ended.kind)}</strong>. Under the rules of this {noun(attempt)} that ends the attempt: it is marked as failed, with 0 points. Only your teacher can reopen it.</p>
          <p className="mt-5 flex items-center justify-center gap-2 text-sm font-medium text-soft">
            {online ? <><Spinner className="size-4" label="Recording" />Recording this…</> : <><WifiOff className="size-4 text-bad" aria-hidden="true" /><span>You are offline. This is recorded as soon as your connection returns: keep this page open.</span></>}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn('min-h-dvh bg-canvas pb-24 lg:pb-8', strict && 'quiz-guarded')}>
      {strict && <Watermark />}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{attempt.quiz.title}</p>
            <p className="flex items-center gap-1.5 text-xs text-faint" role="status">
              {!online ? <><WifiOff className="size-3.5 text-bad" aria-hidden="true" /><span className="font-medium text-bad">Offline — answers will be saved when you reconnect</span></>
                : saveError ? <><CloudOff className="size-3.5 text-warn" aria-hidden="true" /><span className="font-medium text-warn">Not saved yet — retrying…</span></>
                  : saving > 0 || unsaved.size > 0 ? <><Spinner className="size-3" label="Saving" />Saving…</>
                    : <><CheckCircle2 className="size-3.5 text-ok" aria-hidden="true" />{lastSaved ? 'All answers saved' : 'Answers are saved automatically'}</>}
            </p>
          </div>
          {showTimer && (
            <div className={cn('flex items-center gap-2 rounded-xl px-3 py-1.5 font-mono text-lg font-bold tabular-nums', urgent ? 'animate-pulse bg-bad-soft text-bad' : soon ? 'bg-warn-soft text-warn' : 'bg-raised text-ink')} role="timer" aria-label={`Time left: ${formatDuration(remaining)}`}>
              <Timer className="size-[18px]" aria-hidden="true" />{formatDuration(remaining)}
            </div>
          )}
          <Button icon={Send} onClick={() => setConfirm(true)} className="max-sm:hidden">Submit</Button>
        </div>
        <div className="h-1 bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answeredCount} aria-label="Questions answered">
          <div className="h-full bg-brand-fill transition-[width] duration-300" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
        </div>
      </header>
      {/* Announced once for screen-reader users. */}
      <p className="sr-only" aria-live="assertive">{urgent ? 'One minute left.' : soon ? 'Five minutes left.' : ''}</p>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 pt-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <main className="min-w-0">
          {strict && (
            <p className="mb-4 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-[13px] leading-snug text-ink" data-testid="strict-rules">
              <ShieldAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden="true" />
              <span>
                <strong className="font-semibold">Strict rules: stay on this page until you submit.</strong> Leaving it, copying, pasting or a screenshot key is a violation. {consequenceText(rules.warnings, warningsUsed)}
                {screenMayLock && <span className="mt-1.5 block" data-testid="screen-may-lock"><strong className="font-semibold">Keep your screen on.</strong> This browser would not let the quiz do it for you, and a screen that switches off or locks by itself counts as leaving. {window.matchMedia?.('(pointer: coarse)').matches ? 'Touch the page' : 'Move the mouse'} now and then while you read.</span>}
              </span>
            </p>
          )}
          {submitError && <Alert tone="bad" className="mb-4" title="Could not submit">{submitError}</Alert>}
          <Card className="sm:p-7">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-brand">Question {index + 1} <span className="font-normal text-faint">of {questions.length}</span></p>
              <div className="flex items-center gap-2">
                <Badge>{typeLabel(current.question.type)}</Badge>
                <span className="text-sm font-medium text-soft">{formatScore(current.points)} {current.points === 1 ? 'point' : 'points'}</span>
              </div>
            </div>
            <QuestionText question={current.question} className="mb-5 text-[17px] leading-relaxed" />
            {current.question.type === 'PROGRAMMING' ? (
              <ProgrammingAnswer key={current.position} problemId={current.question.programmingProblemId} studentAnswerId={current.answerId} value={value.response} onChange={(response) => change(current.position, { response }, 900)} />
            ) : (
            <AnswerInput key={current.position} name={`q-${current.position}`} question={current.question} response={value.response} files={value.files}
              onBrowse={() => guard.current?.expectFileDialog()}
              onFiles={(files) => setAnswers((a) => ({ ...a, [current.position]: { ...a[current.position], files } }))}
              onChange={(response) => change(current.position, { response }, ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTIPLE_RESPONSE', 'MATCHING', 'ORDERING', 'FILE_UPLOAD'].includes(current.question.type) ? 150 : 900)} />
            )}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <button type="button" onClick={() => change(current.position, { flagged: !value.flagged }, 150)} aria-pressed={value.flagged} className={cn('inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium', value.flagged ? 'bg-warn-soft text-warn' : 'text-soft hover:bg-raised')}>
                <Flag className={cn('size-4', value.flagged && 'fill-current')} aria-hidden="true" />{value.flagged ? 'Flagged for review' : 'Flag for review'}
              </button>
              {value.response != null && <button type="button" onClick={() => change(current.position, { response: null, files: [] }, 150)} className="text-[13px] font-medium text-faint hover:text-ink">Clear my answer</button>}
            </div>
          </Card>
          <div className="mt-4 hidden items-center justify-between gap-3 lg:flex">
            <Button variant="secondary" icon={ArrowLeft} disabled={index === 0} onClick={() => go(index - 1)}>Previous</Button>
            {index < questions.length - 1 ? <Button onClick={() => go(index + 1)}>Next<ArrowRight className="size-4" aria-hidden="true" /></Button> : <Button icon={Send} onClick={() => setConfirm(true)}>Finish and submit</Button>}
          </div>
        </main>

        <aside className="hidden lg:block">
          <Card className="sticky top-24">
            <h2 className="mb-3 text-sm font-semibold text-ink">{answeredCount} of {questions.length} answered</h2>
            {Palette}
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-faint">{strict ? 'You can move between questions freely before submitting, and cut, copy and paste within your own answers.' : 'Leaving this tab is recorded for your teacher. You can move between questions freely before submitting.'}</p>
          </Card>
        </aside>
      </div>

      {/* Phone controls */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5 lg:hidden">
        <Button variant="secondary" icon={ArrowLeft} disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous question" />
        <Button variant="secondary" icon={Grid3x3} className="flex-1" onClick={() => setPalette(true)}>{index + 1} / {questions.length}</Button>
        {index < questions.length - 1 ? <Button onClick={() => go(index + 1)} aria-label="Next question">Next<ArrowRight className="size-4" aria-hidden="true" /></Button> : <Button icon={Send} onClick={() => setConfirm(true)}>Submit</Button>}
      </div>
      {palette && (
        <div className="fixed inset-0 z-30 flex items-end lg:hidden" role="dialog" aria-modal="true" aria-label="All questions">
          <div className="absolute inset-0 bg-[#0b0d17]/55" onClick={() => setPalette(false)} aria-hidden="true" />
          <div className="animate-pop relative max-h-[75dvh] w-full overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-4">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{answeredCount} of {questions.length} answered</h2><button type="button" onClick={() => setPalette(false)} className="rounded-md p-1.5 text-faint hover:bg-raised" aria-label="Close"><X className="size-5" /></button></div>
            {Palette}
            <Button icon={Send} className="mt-4 w-full" onClick={() => { setPalette(false); setConfirm(true); }}>Submit quiz</Button>
          </div>
        </div>
      )}

      <ConfirmDialog open={confirm} onClose={() => !submitting && setConfirm(false)} onConfirm={() => submit(false)} loading={submitting} tone="primary" title="Submit your answers?" confirmLabel="Submit">
        {unanswered > 0 ? <p className="mb-2 flex items-start gap-2 font-medium text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{plural(unanswered, 'question')} {unanswered === 1 ? 'has' : 'have'} no answer yet.</p> : <p className="mb-2 flex items-center gap-2 font-medium text-ok"><CheckCircle2 className="size-4" aria-hidden="true" />Every question is answered.</p>}
        {flaggedCount > 0 && <p className="mb-2">{plural(flaggedCount, 'question')} flagged for review.</p>}
        <p>You cannot change your answers after submitting.</p>
      </ConfirmDialog>

      {submitting && !confirm && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-canvas/90" role="alert">
          <div className="text-center"><Spinner className="mx-auto size-8" label="Submitting" /><p className="mt-3 font-semibold text-ink">Time is up — submitting your answers…</p></div>
        </div>
      )}
      {/* With strict rules there is no leaving: the way out is Submit. */}
      {!strict && <button type="button" className="sr-only" onClick={() => navigate(back)}>{deadline ? 'Leave the quiz (your answers stay saved and the timer keeps running)' : 'Leave the quiz (your answers stay saved)'}</button>}

      <Modal open={Boolean(warning)} dismissible={false} title={warning ? `Warning ${warning.number} of ${rules.warnings}` : ''} size="sm"
        footer={<Button data-autofocus onClick={() => setWarning(null)}>I understand</Button>}>
        {warning && (
          <div className="space-y-3 text-sm text-soft">
            <p className="flex gap-2.5 text-ink"><ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" /><span>It was recorded at {formatTime(warning.at)} that you <strong className="font-semibold">{violationText(warning.kind)}</strong>.</span></p>
            <p><strong className="font-semibold text-ink">{consequenceText(rules.warnings, warning.number)}</strong> An attempt that is ended is marked as failed with 0 points, and only your teacher can reopen it.</p>
            <p>Stay on this page until you submit.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Reviewing ────────────────────────────────────────────────────────────────
function Review({ attempt, back }) {
  const hasScore = attempt.resultsVisible !== false && attempt.totalScore != null && !attempt.awaitingGrading;
  const message = attempt.awaitingGrading ? 'Some answers are graded by your teacher. Your score will appear when grading is finished.'
    : attempt.resultsVisible === false ? ({ AFTER_CLOSE: 'Scores are shown after the quiz closes.', MANUAL: 'Your teacher will release the scores.', NEVER: 'Your score will appear in your grades.' }[attempt.resultVisibility] ?? 'Scores are not available yet.') : null;
  return (
    <div className="min-h-dvh bg-canvas pb-12">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
          <Link to={back} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-soft hover:text-brand"><ArrowLeft className="size-4" aria-hidden="true" />Back to the quiz</Link>
          <p className="ml-auto min-w-0 truncate text-sm font-semibold text-ink">{attempt.quiz.title}</p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-6">
        <Card className="text-center sm:p-8">
          <span className={cn('mx-auto grid size-14 place-items-center rounded-2xl', hasScore ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand')}>{hasScore ? <CheckCircle2 className="size-7" aria-hidden="true" /> : <Clock className="size-7" aria-hidden="true" />}</span>
          <h1 className="mt-4 text-xl font-bold text-ink">{attempt.student ? `${attempt.student.name} — attempt ${attempt.attemptNumber}` : attempt.autoSubmitted ? 'Time was up — your answers were submitted' : 'Your answers were submitted'}</h1>
          <p className="mt-1 text-sm text-faint">Attempt {attempt.attemptNumber} · submitted {formatDateTime(attempt.submittedAt)}</p>
          {hasScore ? (
            <>
              <p className="mt-5 text-5xl font-bold tabular-nums text-ink">{formatScore(attempt.totalScore)}<span className="text-2xl font-semibold text-faint"> / {formatScore(attempt.maxScore)}</span></p>
              {attempt.percent != null && <p className={cn('mt-1 text-base font-semibold', attempt.passed === false ? 'text-bad' : 'text-ok')}>{formatPercent(attempt.percent)}{attempt.passed === true ? ' · Passed' : attempt.passed === false ? ' · Below the passing score' : ''}</p>}
            </>
          ) : <p className="mx-auto mt-4 max-w-md text-sm text-soft">{message}</p>}
          <Button to={back} variant="secondary" className="mt-6">Back to the quiz</Button>
        </Card>

        {attempt.answersPending && <Alert tone="info">The correct answers will be shown here after the quiz closes for everyone.</Alert>}
        {attempt.questions && attempt.questions.map((item, i) => (
          <Card key={item.position}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-brand">Question {i + 1}</p>
              <div className="flex items-center gap-2"><Badge>{typeLabel(item.question.type)}</Badge><ScoreChip item={item} /></div>
            </div>
            <QuestionText question={item.question} className="mb-4" />
            <AnswerReview item={item} />
            {item.feedback && <div className="mt-3 rounded-xl bg-raised p-3 text-sm"><p className="text-xs font-semibold uppercase tracking-wide text-faint">Teacher’s feedback</p><p className="mt-1 whitespace-pre-wrap text-ink">{item.feedback}</p></div>}
            {item.explanation && <p className="mt-3 rounded-xl bg-info-soft p-3 text-sm text-ink"><span className="font-semibold">Explanation: </span>{item.explanation}</p>}
          </Card>
        ))}
        {!attempt.questions && attempt.status !== 'IN_PROGRESS' && <p className="flex items-center justify-center gap-2 py-4 text-center text-sm text-faint"><CircleDashed className="size-4" aria-hidden="true" />Your answers are not shown for this quiz.</p>}
      </main>
    </div>
  );
}
