// One quiz. Teachers build it here (questions, points, random pools); students start or resume it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarClock, CheckCircle2, ChevronLeft, Clock, Dices, Download, FileQuestion, FileUp, Library, Lock, Pencil, PlayCircle, Plus, RefreshCw, Repeat, Settings2, Share2, ShieldAlert, Timer, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PostToClassesModal } from '../../components/ClassTargets.jsx';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, CardHeader, cn, ConfirmDialog, DescriptionList, EmptyState, Field, IconButton, Input, Modal, QueryState, Select, Spinner } from '../../components/ui.jsx';
import { api, errorMessage } from '../../lib/api.js';
import { formatDateTime, formatPercent, formatScore, formatSpan, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import ImportQuestions from './quiz/ImportQuestions.jsx';
import QuestionEditor from './quiz/QuestionEditor.jsx';
import { AnswerKey, DIFFICULTY, MarkedByBadge, PartHeading, QUESTION_TYPES, QuestionText, markedBy, typeLabel } from './quiz/QuestionParts.jsx';
import QuizDialog, { ANSWER_VISIBILITY, QUIZ_KINDS, RESULT_VISIBILITY } from './QuizDialog.jsx';
import { windowText } from './Quizzes.jsx';
import { RulesForStudents, rulesSummary } from './quiz/Rules.jsx';
import { useClass } from './useClass.js';

export default function QuizDetail() {
  const { cls, canManage, base } = useClass();
  const { quizId } = useParams();
  const query = useQuery({ queryKey: ['class', cls.id, 'quiz', quizId], queryFn: () => api.get(`/quizzes/${quizId}`) });
  return (
    <QueryState query={query}>
      {(quiz) => (
        <>
          <Link to={`${base}/quizzes`} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />All quizzes</Link>
          {canManage ? <Builder quiz={quiz} /> : <StudentView quiz={quiz} />}
        </>
      )}
    </QueryState>
  );
}

// ── Student ──────────────────────────────────────────────────────────────────
function StudentView({ quiz }) {
  const { cls, base } = useClass();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  // Starting says that the rules were read; the server refuses a strict quiz without it.
  const start = useAction(() => api.post(`/quizzes/${quiz.id}/attempts`, { acceptRules: true }), {
    invalidate: [['class', cls.id, 'quizzes'], ['class', cls.id, 'quiz', quiz.id], ['dashboard']],
    onSuccess: (r) => navigate(`${base}/quizzes/${quiz.id}/attempt/${r.attemptId}`),
    onError: () => setConfirm(false),
  });
  const attemptsLeft = quiz.maxAttempts - quiz.attemptsUsed;
  const resume = quiz.start.ok && quiz.start.resume;
  const strict = quiz.strictMode;
  const noun = quiz.kind === 'EXAM' ? 'examination' : 'quiz';
  // Reopened by the teacher, and the student has not continued yet: the clock starts when they do.
  const waiting = resume && quiz.reopened && quiz.reopened.seconds != null ? quiz.reopened : null;
  // Reopened and already open again (or reopened without a timer).
  const reopened = resume && quiz.reopened && !waiting ? quiz.reopened : null;
  const ended = quiz.myStatus === 'TERMINATED' ? quiz.terminated : null;
  // Resuming costs time, so it is not held up by a question. Everything else is asked first.
  const ask = waiting || (!resume && (strict || quiz.timeLimitMinutes));
  const label = waiting ? 'Continue' : resume ? 'Resume' : quiz.attemptsUsed > 0 ? 'Try again' : 'Start';

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="min-w-0 space-y-5 lg:col-span-2">
        {ended && (
          <Alert tone="bad" title="Your attempt was ended">
            On {formatDateTime(ended.at)} it was recorded that you <strong className="font-semibold">{ended.text}</strong>. Under the rules of this {noun} the attempt is marked as failed, with 0 points. Only your teacher can reopen it: if something outside your control caused this, tell them what happened. The answers you had given are kept.
          </Alert>
        )}
        {waiting && (
          <Alert tone="info" title="Your teacher reopened your attempt">
            You continue with the answers you had already given. You have <strong className="font-semibold">{formatSpan(waiting.seconds)}</strong> from the moment you continue.{waiting.deadlineAt ? <> Continue before <strong className="font-semibold">{formatDateTime(waiting.deadlineAt)}</strong>: after that the attempt is handed in with the answers it has.</> : null}
          </Alert>
        )}
        {reopened && (
          <Alert tone="info" title="Your teacher reopened your attempt">
            You continue with the answers you had already given.{reopened.deadlineAt ? <> Finish before <strong className="font-semibold">{formatDateTime(reopened.deadlineAt)}</strong>.</> : null}
          </Alert>
        )}
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">{QUIZ_KINDS[quiz.kind]}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink text-balance">{quiz.title}</h1>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-soft">
            <li className="flex items-center gap-1.5"><FileQuestion className="size-4 text-faint" aria-hidden="true" />{plural(quiz.questionCount, 'question')} · {formatScore(quiz.totalPoints)} points</li>
            <li className="flex items-center gap-1.5"><Timer className="size-4 text-faint" aria-hidden="true" />{quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} minutes` : 'No time limit'}</li>
            <li className="flex items-center gap-1.5"><Repeat className="size-4 text-faint" aria-hidden="true" />{quiz.maxAttempts === 1 ? 'One attempt' : `${quiz.maxAttempts} attempts`}</li>
            <li className="flex items-center gap-1.5"><CalendarClock className="size-4 text-faint" aria-hidden="true" />{windowText(quiz)}</li>
            {strict && <li className="flex items-center gap-1.5 font-medium text-ink"><ShieldAlert className="size-4 text-warn" aria-hidden="true" />Strict rules</li>}
          </ul>
          {quiz.instructionsHtml && <div className="mt-5 border-t border-line pt-5"><RichText html={quiz.instructionsHtml} /></div>}

          {/* An ended attempt is explained above, in full: not said a second time here. */}
          {!ended && <div className="mt-6 rounded-xl bg-raised p-4">
            {quiz.start.ok ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-sm text-soft">
                  {waiting ? <p className="font-semibold text-ink">Your attempt is waiting for you. The timer starts when you continue.</p>
                    : resume ? <p className="font-semibold text-warn">You have an attempt in progress.{quiz.timeLimitMinutes || quiz.reopened?.deadlineAt ? ' The timer is still running.' : ' Your answers so far are saved.'}</p>
                      : <p><span className="font-semibold text-ink">{attemptsLeft === 1 ? 'You have one attempt.' : `You have ${attemptsLeft} attempts left.`}</span>{quiz.timeLimitMinutes ? ` Once you start, you have ${quiz.timeLimitMinutes} minutes and the timer cannot be paused.` : ''}</p>}
                  <p className="mt-0.5 text-[13px] text-faint">{strict
                    ? waiting ? 'The same rules apply as before: stay on the quiz page until you submit.'
                      : reopened ? 'The same rules apply as before: stay on the quiz page until you submit.'
                        : resume ? 'Closing or leaving the quiz page counts as a violation. Stay on it from here until you submit.'
                          : 'Your answers are saved as you go. If your connection drops, stay on the quiz page: they are sent when it returns.'
                    : 'Your answers are saved as you go. If your connection drops, reopen this page to continue.'}</p>
                </div>
                <Button size="lg" icon={PlayCircle} loading={start.isPending} onClick={() => (ask ? setConfirm(true) : start.mutate())}>{label}</Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm font-medium text-soft"><Lock className="size-4 shrink-0 text-faint" aria-hidden="true" />{quiz.start.reason}</p>
            )}
          </div>}
        </Card>

        {strict && !quiz.submitted && !ended && (
          <Card>
            <CardHeader title={`Rules of this ${noun}`} icon={ShieldAlert} />
            <RulesForStudents warnings={quiz.violationWarnings} noun={noun} />
          </Card>
        )}

        {quiz.attempts.length > 0 && (
          <Card>
            <CardHeader title="Your attempts" />
            <ul className="divide-y divide-line">
              {quiz.attempts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-sm font-bold text-soft">{a.attemptNumber}</span>
                  <span className="min-w-0 flex-1 basis-40 text-sm">
                    <span className="block font-medium text-ink">{a.status === 'IN_PROGRESS' ? (a.reopened ? 'Reopened by your teacher' : 'In progress') : a.status === 'TERMINATED' ? `Ended ${formatDateTime(a.terminated.at)}: you ${a.terminated.text}` : `Submitted ${formatDateTime(a.submittedAt)}`}</span>
                    <span className="block text-xs text-faint">Started {formatDateTime(a.startedAt)}</span>
                  </span>
                  {a.status === 'IN_PROGRESS' ? <Badge tone={a.reopened ? 'info' : 'warn'}>{a.reopened ? 'Reopened' : 'In progress'}</Badge>
                    : a.status === 'TERMINATED' ? <Badge tone="bad" icon={ShieldAlert}>Failed · 0 points</Badge>
                      : a.awaitingGrading ? <Badge tone="info" icon={Clock}>Waiting for grading</Badge>
                        : a.score != null ? <span className="text-base font-bold tabular-nums text-ink">{formatScore(a.score)}<span className="text-sm font-medium text-faint"> / {formatScore(a.maxScore)}</span></span>
                          : <Badge>Score not released</Badge>}
                  {a.status === 'SUBMITTED' && <Button size="sm" variant="secondary" to={`${base}/quizzes/${quiz.id}/attempt/${a.id}`}>Review</Button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="min-w-0 space-y-5">
        <Card className={cn(ended ? 'border-bad/40' : quiz.submitted && quiz.resultsVisible && quiz.score != null && 'border-ok/40')}>
          <CardHeader title="Your result" />
          {ended ? (
            <>
              <p className="text-4xl font-bold tabular-nums text-ink">0<span className="text-xl font-semibold text-faint"> / {formatScore(quiz.totalPoints)}</span></p>
              <p className="mt-1 text-sm font-semibold text-bad">Failed: the attempt was ended for a rule violation</p>
              <p className="mt-2 text-xs text-faint">This stands until your teacher reopens the attempt or decides to count your answers.</p>
            </>
          ) : !quiz.submitted ? <p className="text-sm text-soft">{quiz.myStatus === 'MISSING' ? 'You did not take this quiz before it closed.' : quiz.myStatus === 'IN_PROGRESS' ? 'In progress.' : 'Not taken yet.'}</p>
            : quiz.awaitingGrading ? <p className="text-sm text-soft">Submitted. Some answers are being graded by your teacher.</p>
              : quiz.resultsVisible && quiz.score != null ? (
                <>
                  <p className="text-4xl font-bold tabular-nums text-ink">{formatScore(quiz.score)}<span className="text-xl font-semibold text-faint"> / {formatScore(quiz.totalPoints)}</span></p>
                  <p className={cn('mt-1 text-sm font-semibold', quiz.passed === false ? 'text-bad' : 'text-ok')}>{formatPercent(quiz.percent)}{quiz.passed === true ? ' · Passed' : quiz.passed === false ? ` · Below the passing score of ${quiz.passingPercent}%` : ''}</p>
                  {quiz.maxAttempts > 1 && <p className="mt-2 text-xs text-faint">{{ HIGHEST: 'Your highest attempt counts.', LATEST: 'Your latest attempt counts.', AVERAGE: 'The average of your attempts counts.' }[quiz.attemptScoring]}</p>}
                </>
              ) : <p className="text-sm text-soft">Submitted. {{ AFTER_CLOSE: 'Scores are shown after the quiz closes.', MANUAL: 'Your teacher will release the scores.', NEVER: 'Your score will appear in your grades.' }[quiz.resultVisibility] ?? ''}</p>}
        </Card>
        <Card>
          <CardHeader title="Details" />
          <DescriptionList items={[
            quiz.availableFrom && ['Opens', formatDateTime(quiz.availableFrom)],
            ['Closes', quiz.availableUntil ? formatDateTime(quiz.availableUntil) : 'No closing date'],
            ['Attempts', `${quiz.attemptsUsed} of ${quiz.maxAttempts} used`],
            quiz.passingPercent != null && ['Passing score', `${quiz.passingPercent}%`],
            quiz.gradeCategory && ['Counts toward', `${quiz.gradeCategory.period} › ${quiz.gradeCategory.name}`],
          ]} />
        </Card>
      </div>

      {strict ? (
        <Modal open={confirm} onClose={start.isPending ? undefined : () => setConfirm(false)} size="lg" title={waiting ? `Continue the ${noun}` : `Before you start the ${noun}`}
          footer={<><Button variant="secondary" onClick={() => setConfirm(false)} disabled={start.isPending}>Not now</Button><Button icon={PlayCircle} loading={start.isPending} onClick={() => start.mutate()}>{waiting ? 'I understand, continue' : 'I understand, start'}</Button></>}>
          {waiting
            ? <p className="mb-4 text-sm text-soft">You will have <strong className="text-ink">{formatSpan(waiting.seconds)}</strong> from the moment you continue. The timer cannot be paused, and the same rules apply as before.</p>
            : quiz.timeLimitMinutes ? <p className="mb-4 text-sm text-soft">You will have <strong className="text-ink">{quiz.timeLimitMinutes} minutes</strong>. The timer cannot be paused, and the {noun} is submitted automatically when time is up.</p> : null}
          <RulesForStudents warnings={quiz.violationWarnings} noun={noun} />
        </Modal>
      ) : (
        <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => start.mutate()} loading={start.isPending} tone="primary" title="Start the quiz now?" confirmLabel="Start">
          You will have <strong className="text-ink">{quiz.timeLimitMinutes} minutes</strong>. The timer keeps running even if you close the page, and the quiz is submitted automatically when time is up.
        </ConfirmDialog>
      )}
    </div>
  );
}

function readQuizSyncTargets(quizId) {
  if (typeof window === 'undefined' || !window.sessionStorage) return [];
  try {
    const raw = window.sessionStorage.getItem(`edusphere.quizSync.${quizId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearQuizSyncTargets(quizId) {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.removeItem(`edusphere.quizSync.${quizId}`);
  } catch {
    /* ignore */
  }
}

// ── Teacher ──────────────────────────────────────────────────────────────────
function Builder({ quiz }) {
  const { cls, base } = useClass();
  const client = useQueryClient();
  const [dialog, setDialog] = useState(null); // 'settings' | 'post' | 'new' | 'bank' | 'pools' | 'import' | { edit: question }
  const [linkedCopies, setLinkedCopies] = useState(() => readQuizSyncTargets(quiz.id));
  const [selectedSyncIds, setSelectedSyncIds] = useState(() => readQuizSyncTargets(quiz.id).map((c) => c.id));
  const key = ['class', cls.id, 'quiz', quiz.id];
  const invalidate = [['class', cls.id, 'quizzes'], key, ['class', cls.id, 'gradebook'], ['dashboard']];
  const readOnly = cls.status === 'ARCHIVED';
  const noun = quiz.kind === 'EXAM' ? 'examination' : 'quiz';
  const frozen = quiz.locked || readOnly;

  const saveItems = useAction((items) => api.put(`/quizzes/${quiz.id}/questions`, { items }), { invalidate, onSuccess: (data) => client.setQueryData(key, data) });
  const syncLinked = useAction(({ publishAfter = false } = {}) => api.post(`/quizzes/${quiz.id}/sync`, { targetQuizIds: selectedSyncIds, publish: publishAfter }), {
    invalidate,
    success: (r, { publishAfter }) => {
      for (const item of r.synced ?? []) client.invalidateQueries({ queryKey: ['class', item.classId] });
      if (publishAfter) return `Synced and published to ${plural((r.synced ?? []).length, 'other class', 'other classes')}.`;
      return `Questions and settings synced to ${plural((r.synced ?? []).length, 'other class', 'other classes')}.`;
    },
    onSuccess: (_, { publishAfter }) => {
      if (publishAfter) {
        clearQuizSyncTargets(quiz.id);
        setLinkedCopies([]);
        setSelectedSyncIds([]);
      }
    },
  });
  const publish = useAction(
    async (status) => {
      const updated = await api.patch(`/quizzes/${quiz.id}`, { status });
      if (status === 'PUBLISHED' && selectedSyncIds.length > 0) {
        const synced = await api.post(`/quizzes/${quiz.id}/sync`, { targetQuizIds: selectedSyncIds, publish: true });
        for (const item of synced.synced ?? []) client.invalidateQueries({ queryKey: ['class', item.classId] });
        return { updated, syncedCount: (synced.synced ?? []).length };
      }
      return { updated, syncedCount: 0 };
    },
    {
      invalidate,
      success: (res, status) => {
        if (status !== 'PUBLISHED') return 'Quiz moved back to draft.';
        return res.syncedCount > 0
          ? `Quiz published to ${res.syncedCount + 1} classes. Students have been notified.`
          : 'Quiz published. Students have been notified.';
      },
      onSuccess: (res, status) => {
        if (status === 'PUBLISHED' && res.syncedCount > 0) {
          clearQuizSyncTargets(quiz.id);
          setLinkedCopies([]);
          setSelectedSyncIds([]);
        }
      },
    },
  );
  // The questions come in the order in which students get them, and are saved in that order.
  const items = quiz.questions.map((q) => ({ questionId: q.id, points: q.points }));
  const change = (fn) => saveItems.mutate(fn(items));
  const move = (i, delta) => change((list) => { const next = [...list]; const [x] = next.splice(i, 1); next.splice(i + delta, 0, x); return next; });
  // The parts of the quiz, each with its questions. Without parts: one group that is the whole list.
  const parts = quiz.parts ?? [];
  const groups = parts.length > 0 ? parts.map((part, index) => ({ part, index, first: part.first, count: part.count })) : [{ part: null, index: 0, first: 0, count: quiz.questions.length }];
  // Where the questions of a part are kept together, a question moves inside its part and a part moves as a whole.
  const kept = Boolean(quiz.keptInParts) && parts.length > 0;
  const movePart = (index, delta) => change((list) => {
    const order = parts.map((_, n) => n);
    order.splice(index + delta, 0, ...order.splice(index, 1));
    return order.flatMap((n) => list.slice(parts[n].first, parts[n].first + parts[n].count));
  });
  // Who marks what: the questions that can wait for the teacher.
  const waits = quiz.questions.filter((q) => markedBy(q).by !== 'SYSTEM').length;
  // Short answers that are checked by their key words: a sentence, or where the teacher asked for it.
  const keyed = quiz.questions.filter((q) => markedBy(q).why === 'KEY_WORDS').length;
  const keyedNote = keyed > 0 ? ` ${plural(keyed, 'short answer')} ${keyed === 1 ? 'is' : 'are'} checked by key words: there, an answer that has your words but may say the opposite is left to you.` : '';
  const partNames = [...new Set(quiz.questions.map((q) => q.section).filter(Boolean))];

  const poolPoints = quiz.pools.reduce((s, p) => s + p.count * p.pointsEach, 0);
  const empty = quiz.questions.length === 0 && quiz.pools.length === 0;

  /** Add the questions of an import. The server answers with the quiz as it is afterwards. */
  const addImported = async (questions) => {
    const result = await api.post(`/quizzes/${quiz.id}/questions/bulk`, { questions });
    client.setQueryData(key, result.quiz);
    for (const queryKey of invalidate) client.invalidateQueries({ queryKey });
    client.invalidateQueries({ queryKey: ['question-banks'] });
    const already = result.skipped > 0 ? ` ${plural(result.skipped, 'question')} ${result.skipped === 1 ? 'was' : 'were'} in it already.` : '';
    if (result.added > 0) toast.success(`${plural(result.added, 'question')} added to the ${noun}.${already}`);
    else toast.info(`Nothing was added.${already}`);
  };
  // The questions with their answers, in the format the import reads.
  const download = () => api.download(`/quizzes/${quiz.id}/questions/export`, undefined, 'questions.json').catch((err) => toast.error(errorMessage(err)));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2"><StatusBadge status={quiz.status} publishAt={quiz.publishAt} /><Badge tone="brand">{QUIZ_KINDS[quiz.kind]}</Badge></p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink text-balance">{quiz.title}</h1>
              <p className="mt-1 text-sm text-soft">{plural(quiz.questionCount, 'question')} · {formatScore(quiz.totalPoints)} points · {quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} min` : 'no time limit'} · {windowText(quiz)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={Share2} onClick={() => setDialog('post')}>Post to classes</Button>
              {!readOnly && <Button variant="secondary" icon={Settings2} onClick={() => setDialog('settings')}>Settings</Button>}
              {quiz.status === 'DRAFT' && !readOnly && <Button icon={CheckCircle2} loading={publish.isPending} disabled={empty} title={empty ? 'Add at least one question first' : undefined} onClick={() => publish.mutate('PUBLISHED')}>Publish</Button>}
              {quiz.status !== 'DRAFT' && <Button icon={BarChart3} to={`${base}/quizzes/${quiz.id}/results`}>Results{quiz.attemptCount > 0 ? ` (${quiz.attemptCount})` : ''}</Button>}
            </div>
          </div>
          {quiz.instructionsHtml && <div className="mt-4 border-t border-line pt-4"><RichText html={quiz.instructionsHtml} className="text-sm" /></div>}
        </Card>

        {linkedCopies.length > 0 && (
          <Alert
            tone="info"
            title={`Drafts also created in ${plural(linkedCopies.length, 'other class', 'other classes')}`}
          >
            <p className="text-sm">When you finish adding or importing questions here, choose which classes to update{quiz.status === 'DRAFT' ? ' (clicking Publish above also syncs and publishes the checked classes)' : ''}:</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {linkedCopies.map((copy) => {
                const checked = selectedSyncIds.includes(copy.id);
                return (
                  <label key={copy.id} className={cn('inline-flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium', checked ? 'border-brand bg-surface text-ink' : 'border-line bg-surface/60 text-soft')}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setSelectedSyncIds((prev) => (e.target.checked ? [...prev, copy.id] : prev.filter((x) => x !== copy.id)))}
                      className="size-3.5 rounded accent-[var(--brand-fill)]"
                    />
                    {copy.classLabel}
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={syncLinked.isPending} disabled={selectedSyncIds.length === 0 || empty} onClick={() => syncLinked.mutate({ publishAfter: false })}>
                Sync questions now
              </Button>
              <button
                type="button"
                onClick={() => {
                  clearQuizSyncTargets(quiz.id);
                  setLinkedCopies([]);
                  setSelectedSyncIds([]);
                }}
                className="text-xs font-medium text-soft hover:text-ink hover:underline"
              >
                Dismiss
              </button>
            </div>
          </Alert>
        )}

        {quiz.locked && <Alert tone="info" title="Students have started this quiz">The questions can no longer change, so that everyone is graded on the same test. To make a new version, duplicate the quiz from the quiz list.</Alert>}
        {quiz.status === 'DRAFT' && empty && <Alert tone="warn" title="This quiz has no questions yet">Add questions below. A quiz can be published once it has at least one.</Alert>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1 text-[15px] font-semibold text-ink">
            Questions {saveItems.isPending && <Spinner className="ml-1 inline size-4" label="Saving" />}
            {quiz.questions.length > 0 && <IconButton icon={Download} size="sm" label="Download the questions as a JSON file" onClick={download} />}
          </h2>
          {!frozen && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={Dices} onClick={() => setDialog('pools')}>Random from bank</Button>
              <Button size="sm" variant="secondary" icon={Library} onClick={() => setDialog('bank')}>Add from bank</Button>
              <Button size="sm" variant="secondary" icon={FileUp} onClick={() => setDialog('import')}>Import</Button>
              <Button size="sm" icon={Plus} onClick={() => setDialog('new')}>New question</Button>
            </div>
          )}
        </div>

        {quiz.questions.length === 0 && quiz.pools.length === 0 ? (
          <Card>
            <EmptyState icon={FileQuestion} title="Start with the first question" description="Write the questions here, or import the ones you already have: paste them as JSON, or choose a Word, PDF or text file."
              action={frozen ? null : <div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" icon={FileUp} onClick={() => setDialog('import')}>Import questions</Button><Button icon={Plus} onClick={() => setDialog('new')}>New question</Button></div>} />
          </Card>
        ) : (
          <div className="space-y-5">
            {(parts.length > 0 || quiz.shuffleQuestions) && (quiz.questions.length > 0 || quiz.pools.length > 0) && (
              <p className="text-[13px] text-soft" data-testid="order-note">
                {!quiz.shuffleQuestions ? 'Students get the questions in this order, part by part.'
                  : parts.length > 0 ? 'Students take the parts in this order. Inside each part, every student gets the questions in a different order.'
                    // Random questions make parts of their own: the questions of one type are given together.
                    : quiz.pools.length > 0 ? 'Every student gets the questions in a different order. Questions of the same type are kept together.'
                      : 'Every student gets these questions in a different order.'}
              </p>
            )}
            {groups.map((group) => (
              <section key={group.part ? `part-${group.index}` : 'all'} aria-label={group.part ? `Part ${group.index + 1}` : 'Questions'}>
                {group.part && (
                  <PartHeading part={group.part} index={group.index} className="mb-3">
                    {kept && !frozen && (
                      <>
                        <IconButton icon={ArrowUp} size="sm" label={`Move part ${group.index + 1} up`} disabled={group.index === 0} onClick={() => movePart(group.index, -1)} />
                        <IconButton icon={ArrowDown} size="sm" label={`Move part ${group.index + 1} down`} disabled={group.index === parts.length - 1} onClick={() => movePart(group.index, 1)} />
                      </>
                    )}
                  </PartHeading>
                )}
                <ol className="space-y-3" start={group.first + 1}>
                  {quiz.questions.slice(group.first, group.first + group.count).map((q, n) => {
                    const i = group.first + n;
                    // Inside its part where parts are kept together; otherwise anywhere in the list.
                    const [low, high] = kept ? [group.first, group.first + group.count - 1] : [0, quiz.questions.length - 1];
                    return (
                      <li key={q.id}>
                        <Card className="p-4">
                          <div className="flex items-start gap-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-bold text-brand">{i + 1}</span>
                            <div className="min-w-0 flex-1">
                              <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                                <Badge>{typeLabel(q.type)}</Badge>
                                <span>{DIFFICULTY[q.difficulty]}</span>
                                {q.topic && <span>· {q.topic}</span>}
                                <MarkedByBadge q={q} />
                                {q.removed && <Badge tone="bad">Deleted from the bank</Badge>}
                              </p>
                              <QuestionText question={q} className="text-[15px]" />
                              <AnswerKey q={q} />
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              <label className="flex items-center gap-1.5 text-xs text-faint">
                                <span className="sr-only">Points for question {i + 1}</span>
                                <PointsInput value={q.points} disabled={frozen} onCommit={(points) => change((list) => list.map((x, k) => (k === i ? { ...x, points } : x)))} /> pts
                              </label>
                              {!frozen && (
                                <div className="flex">
                                  <IconButton icon={ArrowUp} size="sm" label="Move up" disabled={i === low} onClick={() => move(i, -1)} />
                                  <IconButton icon={ArrowDown} size="sm" label="Move down" disabled={i === high} onClick={() => move(i, 1)} />
                                  <IconButton icon={Pencil} size="sm" label="Edit question" onClick={() => setDialog({ edit: q })} />
                                  <IconButton icon={Trash2} size="sm" variant="dangerGhost" label="Remove from this quiz" onClick={() => change((list) => list.filter((_, k) => k !== i))} />
                                </div>
                              )}
                            </div>
                          </div>
                        </Card>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
            {quiz.pools.length > 0 && (
              <ul className="space-y-3">
                {quiz.pools.map((p) => (
                  <li key={p.id}>
                    <Card className="flex flex-wrap items-center gap-3 border-dashed p-4">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-info-soft text-info"><Dices className="size-4" aria-hidden="true" /></span>
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-semibold text-ink">{plural(p.count, 'random question')} from “{p.bankTitle}”</p>
                        <p className="text-[13px] text-faint">{[p.topic && `topic: ${p.topic}`, p.difficulty && DIFFICULTY[p.difficulty], p.type && typeLabel(p.type)].filter(Boolean).join(' · ') || 'any question in the bank'} · {formatScore(p.pointsEach)} pt each · each student gets a different draw{parts.length > 0 || quiz.shuffleQuestions ? ', placed with the questions of its type' : ''}</p>
                      </div>
                      {!frozen && <Button size="sm" variant="ghost" onClick={() => setDialog('pools')}>Change</Button>}
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader title="Summary" />
          <dl className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl bg-raised py-3"><dd className="text-2xl font-bold tabular-nums text-ink">{quiz.questionCount}</dd><dt className="text-xs font-medium text-faint">Questions</dt></div>
            <div className="rounded-xl bg-raised py-3"><dd className="text-2xl font-bold tabular-nums text-ink">{formatScore(quiz.totalPoints)}</dd><dt className="text-xs font-medium text-faint">Points</dt></div>
          </dl>
          {poolPoints > 0 && <p className="mt-2 text-center text-xs text-faint">includes {formatScore(poolPoints)} points from random questions</p>}
          {quiz.questions.length > 0 && (waits > 0
            ? <p className="mt-3 flex gap-2 text-[13px] text-soft" data-testid="marking-note"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" /><span>{plural(waits, 'question')} can wait for your grade. The system checks all the others the moment a student hands in. A student’s score shows once nothing waits.{keyedNote}</span></p>
            : <p className="mt-3 flex gap-2 text-[13px] text-soft" data-testid="marking-note"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" /><span>The system checks every question the moment a student hands in.{quiz.pools.length > 0 ? ' Random questions are checked the same way, except essays and file uploads.' : ''}{keyedNote}</span></p>)}
          {quiz.status !== 'DRAFT' && !readOnly && quiz.attemptCount === 0 && <Button variant="ghost" size="sm" className="mt-3 w-full" loading={publish.isPending} onClick={() => publish.mutate('DRAFT')}>Move back to draft</Button>}
        </Card>
        <Card>
          <CardHeader title="Settings" action={!readOnly && <button type="button" onClick={() => setDialog('settings')} className="text-[13px] font-medium text-brand hover:underline">Change</button>} />
          <DescriptionList items={[
            ['Opens', quiz.availableFrom ? formatDateTime(quiz.availableFrom) : 'When published'],
            ['Closes', quiz.availableUntil ? formatDateTime(quiz.availableUntil) : 'No closing date'],
            ['Time limit', quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} minutes` : 'None'],
            ['Attempts', quiz.maxAttempts === 1 ? 'One' : `${quiz.maxAttempts} (${quiz.attemptScoring.toLowerCase()} counts)`],
            quiz.passingPercent != null && ['Passing score', `${quiz.passingPercent}%`],
            ['Shuffle', [quiz.shuffleQuestions && 'questions', quiz.shuffleChoices && 'choices'].filter(Boolean).join(' and ') || 'Off'],
            ['Strict rules', rulesSummary(quiz)],
            ['Scores shown', RESULT_VISIBILITY[quiz.resultVisibility]],
            ['Review shows', ANSWER_VISIBILITY[quiz.answerVisibility]],
            ['Gradebook', quiz.gradeCategory ? `${quiz.gradeCategory.period} › ${quiz.gradeCategory.name}` : 'Not graded'],
          ]} />
        </Card>
      </div>

      {dialog === 'settings' && <QuizDialog quiz={quiz} onClose={() => setDialog(null)} />}
      <PostToClassesModal
        open={dialog === 'post'}
        onClose={() => setDialog(null)}
        title={`Post “${quiz.title}” to other classes`}
        excludeClassId={cls.id}
        teacherId={cls.teacher?.id}
        canPublish={!empty}
        publishDisabledReason="Add at least one question before publishing immediately."
        defaultStatus={quiz.status === 'PUBLISHED' && !empty ? 'PUBLISHED' : 'DRAFT'}
        hint="Copies all questions, random pools, settings, dates, and matching modules or gradebook categories to each selected class."
        onSubmit={({ targetClassIds, status }) => api.post(`/quizzes/${quiz.id}/copy`, { targetClassIds, status })}
      />
      {dialog === 'new' && <QuestionEditor parts={partNames} onClose={() => setDialog(null)} onSave={async (question) => { client.setQueryData(key, await api.post(`/quizzes/${quiz.id}/questions`, { question })); client.invalidateQueries({ queryKey: ['class', cls.id, 'quizzes'] }); toast.success('Question added.'); }} />}
      {dialog?.edit && <QuestionEditor question={dialog.edit} parts={partNames} onClose={() => setDialog(null)} onSave={async (question) => { await api.put(`/question-banks/questions/${dialog.edit.id}`, question); await client.invalidateQueries({ queryKey: key }); toast.success('Question saved.'); }} />}
      {dialog === 'bank' && <BankPicker quiz={quiz} onClose={() => setDialog(null)} onAdd={(picked) => { change((list) => [...list, ...picked.map((q) => ({ questionId: q.id, points: q.points }))]); setDialog(null); }} />}
      {dialog === 'pools' && <PoolsDialog quiz={quiz} invalidate={invalidate} onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportQuestions target="quiz" noun={noun} previewUrl={`/quizzes/${quiz.id}/import/preview`} onSave={addImported} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PointsInput({ value, onCommit, disabled }) {
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (value !== last) { setLast(value); setText(String(value)); }
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n > 0 && n <= 1000 && n !== value) onCommit(n);
    else setText(String(value));
  };
  return <Input type="number" min="0.25" max="1000" step="any" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} className="h-8 w-16 px-2 text-right tabular-nums" />;
}

function BankPicker({ quiz, onClose, onAdd }) {
  const banks = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const [bankId, setBankId] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(new Map());
  const active = bankId || banks.data?.[0]?.id || '';
  const questions = useQuery({ queryKey: ['question-banks', active, 'questions', { search, pick: true }], queryFn: () => api.get(`/question-banks/${active}/questions`, { search: search.trim() || undefined, pageSize: 100 }), enabled: Boolean(active) });
  const used = useMemo(() => new Set(quiz.questions.map((q) => q.id)), [quiz.questions]);
  const toggle = (q) => setPicked((m) => { const next = new Map(m); if (next.has(q.id)) next.delete(q.id); else next.set(q.id, q); return next; });

  return (
    <Modal open onClose={onClose} title="Add questions from a bank" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={picked.size === 0} onClick={() => onAdd([...picked.values()])}>Add {picked.size > 0 ? plural(picked.size, 'question') : ''}</Button></>}>
      {banks.isSuccess && banks.data.length === 0 ? <EmptyState compact icon={Library} title="You have no question banks yet" description="Questions you write for a quiz are saved to a bank automatically, or create one under Question banks." /> : (
        <>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <Select value={active} onChange={(e) => setBankId(e.target.value)} aria-label="Question bank">{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title} ({b.questionCount})</option>)}</Select>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search questions…" aria-label="Search questions" />
          </div>
          <QueryState query={questions} loader={<div className="grid place-items-center py-10"><Spinner /></div>}>
            {(list) => list.length === 0 ? <p className="py-8 text-center text-sm text-faint">No questions found.</p> : (
              <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
                {list.map((q) => {
                  const inQuiz = used.has(q.id);
                  return (
                    <li key={q.id}>
                      <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3', inQuiz ? 'cursor-default border-line opacity-60' : picked.has(q.id) ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong')}>
                        <input type="checkbox" className="mt-1 size-[18px] shrink-0 accent-[var(--brand-fill)]" checked={inQuiz || picked.has(q.id)} disabled={inQuiz} onChange={() => toggle(q)} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink">{q.excerpt}</span>
                          <span className="mt-0.5 block text-xs text-faint">{typeLabel(q.type)} · {DIFFICULTY[q.difficulty]}{q.topic ? ` · ${q.topic}` : ''} · {formatScore(q.points)} pt{inQuiz ? ' · already in this quiz' : ''}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryState>
        </>
      )}
    </Modal>
  );
}

function PoolsDialog({ quiz, invalidate, onClose }) {
  const banks = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const [pools, setPools] = useState(() => quiz.pools.map((p) => ({ bankId: p.bankId, topic: p.topic ?? '', difficulty: p.difficulty ?? '', type: p.type ?? '', count: p.count, pointsEach: p.pointsEach })));
  const [error, setError] = useState(null);
  const update = (i, patch) => setPools((list) => list.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  const save = useAction(() => api.put(`/quizzes/${quiz.id}/pools`, { pools: pools.map((p) => ({ bankId: p.bankId, topic: p.topic.trim() || null, difficulty: p.difficulty || null, type: p.type || null, count: Number(p.count), pointsEach: Number(p.pointsEach) })) }), {
    invalidate, success: 'Random questions saved.', onSuccess: onClose,
    onError: (err) => { setError(err.fields?.pools ?? err.message); return true; },
  });
  return (
    <Modal open onClose={onClose} title="Random questions" size="xl" description="Each student receives a different random draw from your question bank. Useful for large classes and retakes."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={pools.some((p) => !p.bankId)} onClick={() => save.mutate()}>Save</Button></>}>
      {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
      {banks.isSuccess && banks.data.length === 0 ? <EmptyState compact icon={Library} title="You have no question banks yet" /> : (
        <>
          <ul className="space-y-3">
            {pools.map((p, i) => (
              <li key={i} className="grid grid-cols-2 items-end gap-3 rounded-xl border border-line p-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr_5rem_5rem_auto]">
                <Field label="Bank" className="col-span-2 lg:col-span-1"><Select value={p.bankId} onChange={(e) => update(i, { bankId: e.target.value })}><option value="">Choose…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title} ({b.questionCount})</option>)}</Select></Field>
                <Field label="Topic"><Input value={p.topic} onChange={(e) => update(i, { topic: e.target.value })} placeholder="Any" /></Field>
                <Field label="Difficulty"><Select value={p.difficulty} onChange={(e) => update(i, { difficulty: e.target.value })}><option value="">Any</option>{Object.entries(DIFFICULTY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                <Field label="Type"><Select value={p.type} onChange={(e) => update(i, { type: e.target.value })}><option value="">Any</option>{Object.entries(QUESTION_TYPES).map(([v, t]) => <option key={v} value={v}>{t.label}</option>)}</Select></Field>
                <Field label="How many"><Input type="number" min="1" max="200" value={p.count} onChange={(e) => update(i, { count: e.target.value })} /></Field>
                <Field label="Pts each"><Input type="number" min="0.25" max="1000" step="any" value={p.pointsEach} onChange={(e) => update(i, { pointsEach: e.target.value })} /></Field>
                <Button variant="ghost" size="sm" icon={X} aria-label="Remove this rule" onClick={() => setPools((list) => list.filter((_, n) => n !== i))} className="mb-1" />
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" icon={Plus} className="mt-3" onClick={() => setPools((list) => [...list, { bankId: banks.data?.[0]?.id ?? '', topic: '', difficulty: '', type: '', count: 5, pointsEach: 1 }])}>Add a rule</Button>
          {pools.length === 0 && <p className="mt-3 text-sm text-faint">No random questions. Add a rule such as “5 easy questions about Number systems”.</p>}
        </>
      )}
    </Modal>
  );
}
