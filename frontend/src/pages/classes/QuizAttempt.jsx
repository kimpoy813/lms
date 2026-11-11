// Taking a quiz (full screen, no app navigation) and reviewing a finished attempt.
//
// What keeps an attempt safe:
//  • every answer is saved to the server a moment after it changes, and retried if the network fails;
//  • the deadline is the server's — the countdown here is only a display, corrected for clock difference;
//  • when time runs out the server submits the attempt even if this page is closed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CircleDashed, Clock, CloudOff, Flag, Grid3x3, Send, Timer, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ProgrammingAnswer } from '../../components/CodeWorkbench.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, PageLoader, Spinner } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatDuration, formatPercent, formatScore, plural } from '../../lib/format.js';
import { AnswerInput, AnswerReview, QuestionText, ScoreChip, typeLabel } from './quiz/QuestionParts.jsx';

export default function QuizAttempt() {
  const { classId, quizId, attemptId } = useParams();
  const client = useQueryClient();
  const key = ['attempt', attemptId];
  // While an attempt is in progress the page owns the answers: never refetch over them.
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/attempts/${attemptId}`), staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 });
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
  const finish = (data) => {
    client.setQueryData(key, data);
    client.invalidateQueries({ queryKey: ['class', classId] });
    client.invalidateQueries({ queryKey: ['dashboard'] });
  };
  return attempt.status === 'IN_PROGRESS'
    ? <Taking key={attempt.id} attempt={attempt} back={back} onFinished={finish} onClosedElsewhere={() => query.refetch()} />
    : <Review attempt={attempt} back={back} />;
}

// ── Answering ────────────────────────────────────────────────────────────────
function Taking({ attempt, back, onFinished, onClosedElsewhere }) {
  const navigate = useNavigate();
  const questions = attempt.questions;
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

  // ── Clock ──
  const offset = useMemo(() => new Date(attempt.serverTime).getTime() - Date.now(), [attempt.serverTime]);
  const deadline = attempt.deadlineAt ? new Date(attempt.deadlineAt).getTime() : null;
  const [remaining, setRemaining] = useState(() => (deadline ? Math.max(0, (deadline - (Date.now() + offset)) / 1000) : null));
  const timedOut = useRef(false);

  const submit = useCallback(async (auto = false) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await flush();
      const data = await api.post(`/attempts/${attempt.id}/submit`);
      closed.current = true;
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
  }, [attempt.id, flush, onFinished, onClosedElsewhere]);

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
    const report = (type) => api.post(`/attempts/${attempt.id}/events`, { type }).catch(() => {});
    const onVisibility = () => report(document.hidden ? 'TAB_HIDDEN' : 'TAB_VISIBLE');
    const onBlur = () => report('WINDOW_BLUR');
    const onOffline = () => setOnline(false);
    const onOnline = () => { setOnline(true); report('ONLINE'); flush(); };
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
  }, [attempt.id, flush]);

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

  return (
    <div className="min-h-dvh bg-canvas pb-24 lg:pb-8">
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
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-faint">Leaving this tab is recorded for your teacher. You can move between questions freely before submitting.</p>
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
      <button type="button" className="sr-only" onClick={() => navigate(back)}>Leave the quiz (your answers stay saved and the timer keeps running)</button>
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
          <Link to={back} className="inline-flex items-center gap-1.5 text-sm font-medium text-soft hover:text-brand"><ArrowLeft className="size-4" aria-hidden="true" />Back to the quiz</Link>
          <p className="ml-auto truncate text-sm font-semibold text-ink">{attempt.quiz.title}</p>
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
