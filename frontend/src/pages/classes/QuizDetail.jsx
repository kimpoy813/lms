// One quiz. Teachers build it here (questions, points, random pools); students start or resume it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarClock, Check, CheckCircle2, ChevronLeft, Clock, Dices, FileQuestion, Library, Lock, Pencil, PlayCircle, Plus, Repeat, Settings2, Timer, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, CardHeader, cn, ConfirmDialog, DescriptionList, EmptyState, Field, IconButton, Input, Modal, QueryState, Select, Spinner } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatPercent, formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import QuestionEditor from './quiz/QuestionEditor.jsx';
import { DIFFICULTY, QUESTION_TYPES, QuestionText, typeLabel } from './quiz/QuestionParts.jsx';
import QuizDialog, { ANSWER_VISIBILITY, QUIZ_KINDS, RESULT_VISIBILITY } from './QuizDialog.jsx';
import { windowText } from './Quizzes.jsx';
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
  const start = useAction(() => api.post(`/quizzes/${quiz.id}/attempts`), {
    invalidate: [['class', cls.id, 'quizzes'], ['class', cls.id, 'quiz', quiz.id], ['dashboard']],
    onSuccess: (r) => navigate(`${base}/quizzes/${quiz.id}/attempt/${r.attemptId}`),
    onError: () => setConfirm(false),
  });
  const attemptsLeft = quiz.maxAttempts - quiz.attemptsUsed;
  const resume = quiz.start.ok && quiz.start.resume;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="min-w-0 space-y-5 lg:col-span-2">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">{QUIZ_KINDS[quiz.kind]}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink text-balance">{quiz.title}</h1>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-soft">
            <li className="flex items-center gap-1.5"><FileQuestion className="size-4 text-faint" aria-hidden="true" />{plural(quiz.questionCount, 'question')} · {formatScore(quiz.totalPoints)} points</li>
            <li className="flex items-center gap-1.5"><Timer className="size-4 text-faint" aria-hidden="true" />{quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} minutes` : 'No time limit'}</li>
            <li className="flex items-center gap-1.5"><Repeat className="size-4 text-faint" aria-hidden="true" />{quiz.maxAttempts === 1 ? 'One attempt' : `${quiz.maxAttempts} attempts`}</li>
            <li className="flex items-center gap-1.5"><CalendarClock className="size-4 text-faint" aria-hidden="true" />{windowText(quiz)}</li>
          </ul>
          {quiz.instructionsHtml && <div className="mt-5 border-t border-line pt-5"><RichText html={quiz.instructionsHtml} /></div>}

          <div className="mt-6 rounded-xl bg-raised p-4">
            {quiz.start.ok ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-sm text-soft">
                  {resume ? <p className="font-semibold text-warn">You have an attempt in progress.{quiz.timeLimitMinutes ? ' The timer is still running.' : ' Your answers so far are saved.'}</p>
                    : <p><span className="font-semibold text-ink">{attemptsLeft === 1 ? 'You have one attempt.' : `You have ${attemptsLeft} attempts left.`}</span>{quiz.timeLimitMinutes ? ` Once you start, you have ${quiz.timeLimitMinutes} minutes and the timer cannot be paused.` : ''}</p>}
                  <p className="mt-0.5 text-[13px] text-faint">Your answers are saved as you go. If your connection drops, reopen this page to continue.</p>
                </div>
                <Button size="lg" icon={PlayCircle} loading={start.isPending} onClick={() => (resume || !quiz.timeLimitMinutes ? start.mutate() : setConfirm(true))}>{resume ? 'Resume' : quiz.attemptsUsed > 0 ? 'Try again' : 'Start'}</Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm font-medium text-soft"><Lock className="size-4 text-faint" aria-hidden="true" />{quiz.start.reason}</p>
            )}
          </div>
        </Card>

        {quiz.attempts.length > 0 && (
          <Card>
            <CardHeader title="Your attempts" />
            <ul className="divide-y divide-line">
              {quiz.attempts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-sm font-bold text-soft">{a.attemptNumber}</span>
                  <span className="min-w-0 flex-1 basis-40 text-sm">
                    <span className="block font-medium text-ink">{a.status === 'IN_PROGRESS' ? 'In progress' : `Submitted ${formatDateTime(a.submittedAt)}`}</span>
                    <span className="block text-xs text-faint">Started {formatDateTime(a.startedAt)}</span>
                  </span>
                  {a.status === 'IN_PROGRESS' ? <Badge tone="warn">In progress</Badge>
                    : a.awaitingGrading ? <Badge tone="info" icon={Clock}>Waiting for grading</Badge>
                      : a.score != null ? <span className="text-base font-bold tabular-nums text-ink">{formatScore(a.score)}<span className="text-sm font-medium text-faint"> / {formatScore(a.maxScore)}</span></span>
                        : <Badge>Score not released</Badge>}
                  {a.status !== 'IN_PROGRESS' && <Button size="sm" variant="secondary" to={`${base}/quizzes/${quiz.id}/attempt/${a.id}`}>Review</Button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="min-w-0 space-y-5">
        <Card className={cn(quiz.submitted && quiz.resultsVisible && quiz.score != null && 'border-ok/40')}>
          <CardHeader title="Your result" />
          {!quiz.submitted ? <p className="text-sm text-soft">{quiz.myStatus === 'MISSING' ? 'You did not take this quiz before it closed.' : 'Not taken yet.'}</p>
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

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => start.mutate()} loading={start.isPending} tone="primary" title="Start the quiz now?" confirmLabel="Start">
        You will have <strong className="text-ink">{quiz.timeLimitMinutes} minutes</strong>. The timer keeps running even if you close the page, and the quiz is submitted automatically when time is up.
      </ConfirmDialog>
    </div>
  );
}

// ── Teacher ──────────────────────────────────────────────────────────────────
function Builder({ quiz }) {
  const { cls, base } = useClass();
  const client = useQueryClient();
  const [dialog, setDialog] = useState(null); // 'settings' | 'new' | 'bank' | 'pools' | { edit: question }
  const key = ['class', cls.id, 'quiz', quiz.id];
  const invalidate = [['class', cls.id, 'quizzes'], key, ['class', cls.id, 'gradebook'], ['dashboard']];
  const readOnly = cls.status === 'ARCHIVED';
  const frozen = quiz.locked || readOnly;

  const saveItems = useAction((items) => api.put(`/quizzes/${quiz.id}/questions`, { items }), { invalidate, onSuccess: (data) => client.setQueryData(key, data) });
  const publish = useAction((status) => api.patch(`/quizzes/${quiz.id}`, { status }), { invalidate, success: (_, status) => (status === 'PUBLISHED' ? 'Quiz published. Students have been notified.' : 'Quiz moved back to draft.') });
  const items = quiz.questions.map((q) => ({ questionId: q.id, points: q.points }));
  const change = (fn) => saveItems.mutate(fn(items));
  const move = (i, delta) => change((list) => { const next = [...list]; const [x] = next.splice(i, 1); next.splice(i + delta, 0, x); return next; });

  const poolPoints = quiz.pools.reduce((s, p) => s + p.count * p.pointsEach, 0);
  const empty = quiz.questions.length === 0 && quiz.pools.length === 0;

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
              {!readOnly && <Button variant="secondary" icon={Settings2} onClick={() => setDialog('settings')}>Settings</Button>}
              {quiz.status === 'DRAFT' && !readOnly && <Button icon={CheckCircle2} loading={publish.isPending} disabled={empty} title={empty ? 'Add at least one question first' : undefined} onClick={() => publish.mutate('PUBLISHED')}>Publish</Button>}
              {quiz.status !== 'DRAFT' && <Button icon={BarChart3} to={`${base}/quizzes/${quiz.id}/results`}>Results{quiz.attemptCount > 0 ? ` (${quiz.attemptCount})` : ''}</Button>}
            </div>
          </div>
          {quiz.instructionsHtml && <div className="mt-4 border-t border-line pt-4"><RichText html={quiz.instructionsHtml} className="text-sm" /></div>}
        </Card>

        {quiz.locked && <Alert tone="info" title="Students have started this quiz">The questions can no longer change, so that everyone is graded on the same test. To make a new version, duplicate the quiz from the quiz list.</Alert>}
        {quiz.status === 'DRAFT' && empty && <Alert tone="warn" title="This quiz has no questions yet">Add questions below. A quiz can be published once it has at least one.</Alert>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">Questions {saveItems.isPending && <Spinner className="ml-1 inline size-4" label="Saving" />}</h2>
          {!frozen && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={Dices} onClick={() => setDialog('pools')}>Random from bank</Button>
              <Button size="sm" variant="secondary" icon={Library} onClick={() => setDialog('bank')}>Add from bank</Button>
              <Button size="sm" icon={Plus} onClick={() => setDialog('new')}>New question</Button>
            </div>
          )}
        </div>

        {quiz.questions.length === 0 && quiz.pools.length === 0 ? (
          <Card><EmptyState icon={FileQuestion} title="Start with the first question" description="Write a new question, or reuse questions from your question bank." action={frozen ? null : <Button icon={Plus} onClick={() => setDialog('new')}>New question</Button>} /></Card>
        ) : (
          <ol className="space-y-3">
            {quiz.questions.map((q, i) => (
              <li key={q.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-bold text-brand">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                        <Badge>{typeLabel(q.type)}</Badge>
                        <span>{DIFFICULTY[q.difficulty]}</span>
                        {q.topic && <span>· {q.topic}</span>}
                        {!QUESTION_TYPES[q.type]?.auto && <Badge tone="warn">Graded by you</Badge>}
                        {q.removed && <Badge tone="bad">Deleted from the bank</Badge>}
                      </p>
                      <QuestionText question={q} className="text-[15px]" />
                      <AnswerKey q={q} />
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-faint">
                        <span className="sr-only">Points for question {i + 1}</span>
                        <PointsInput value={q.points} disabled={frozen} onCommit={(points) => change((list) => list.map((x, n) => (n === i ? { ...x, points } : x)))} /> pts
                      </label>
                      {!frozen && (
                        <div className="flex">
                          <IconButton icon={ArrowUp} size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                          <IconButton icon={ArrowDown} size="sm" label="Move down" disabled={i === quiz.questions.length - 1} onClick={() => move(i, 1)} />
                          <IconButton icon={Pencil} size="sm" label="Edit question" onClick={() => setDialog({ edit: q })} />
                          <IconButton icon={Trash2} size="sm" variant="dangerGhost" label="Remove from this quiz" onClick={() => change((list) => list.filter((_, n) => n !== i))} />
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
            {quiz.pools.map((p) => (
              <li key={p.id}>
                <Card className="flex flex-wrap items-center gap-3 border-dashed p-4">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-info-soft text-info"><Dices className="size-4" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-semibold text-ink">{plural(p.count, 'random question')} from “{p.bankTitle}”</p>
                    <p className="text-[13px] text-faint">{[p.topic && `topic: ${p.topic}`, p.difficulty && DIFFICULTY[p.difficulty], p.type && typeLabel(p.type)].filter(Boolean).join(' · ') || 'any question in the bank'} · {formatScore(p.pointsEach)} pt each · each student gets a different draw</p>
                  </div>
                  {!frozen && <Button size="sm" variant="ghost" onClick={() => setDialog('pools')}>Change</Button>}
                </Card>
              </li>
            ))}
          </ol>
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
          {quiz.questions.some((q) => !QUESTION_TYPES[q.type]?.auto) && <p className="mt-3 flex gap-2 text-[13px] text-soft"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />Some questions are graded by you. Scores are released after you grade them.</p>}
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
            ['Scores shown', RESULT_VISIBILITY[quiz.resultVisibility]],
            ['Review shows', ANSWER_VISIBILITY[quiz.answerVisibility]],
            ['Gradebook', quiz.gradeCategory ? `${quiz.gradeCategory.period} › ${quiz.gradeCategory.name}` : 'Not graded'],
          ]} />
        </Card>
      </div>

      {dialog === 'settings' && <QuizDialog quiz={quiz} onClose={() => setDialog(null)} />}
      {dialog === 'new' && <QuestionEditor onClose={() => setDialog(null)} onSave={async (question) => { client.setQueryData(key, await api.post(`/quizzes/${quiz.id}/questions`, { question })); client.invalidateQueries({ queryKey: ['class', cls.id, 'quizzes'] }); toast.success('Question added.'); }} />}
      {dialog?.edit && <QuestionEditor question={dialog.edit} onClose={() => setDialog(null)} onSave={async (question) => { await api.put(`/question-banks/questions/${dialog.edit.id}`, question); await client.invalidateQueries({ queryKey: key }); toast.success('Question saved.'); }} />}
      {dialog === 'bank' && <BankPicker quiz={quiz} onClose={() => setDialog(null)} onAdd={(picked) => { change((list) => [...list, ...picked.map((q) => ({ questionId: q.id, points: q.points }))]); setDialog(null); }} />}
      {dialog === 'pools' && <PoolsDialog quiz={quiz} invalidate={invalidate} onClose={() => setDialog(null)} />}
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

/** The answer key as the teacher sees it in the builder. */
export function AnswerKey({ q }) {
  const item = 'flex items-center gap-2 text-sm';
  switch (q.type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE':
      return <ul className="mt-2 space-y-1">{q.choices.map((c) => <li key={c.text} className={cn(item, c.isCorrect ? 'font-medium text-ok' : 'text-soft')}>{c.isCorrect ? <Check className="size-4 shrink-0" aria-label="Correct" /> : <span className="size-4 shrink-0" />}{c.text}</li>)}</ul>;
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE':
      return <p className="mt-2 text-sm text-soft">Answer: <strong className={q.answer ? 'text-ok' : 'text-bad'}>{q.answer ? 'True' : 'False'}</strong>{q.correction?.length > 0 && <> · correction: <strong className="text-ink">{q.correction.join(', ')}</strong></>}</p>;
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      return <p className="mt-2 text-sm text-soft">{q.accepted?.length ? <>Accepted: <strong className="text-ok">{q.accepted.join(', ')}</strong></> : 'No accepted answers listed — you grade the answers.'}</p>;
    case 'FILL_BLANKS':
      return <ol className="mt-2 space-y-0.5 text-sm text-soft">{(q.blanks ?? []).map((b, i) => <li key={b.join('|')}>({i + 1}) <strong className="text-ok">{b.join(' / ')}</strong></li>)}</ol>;
    case 'MATCHING':
      return <ul className="mt-2 space-y-0.5 text-sm text-soft">{q.pairs.map((p) => <li key={p.left}>{p.left} → <strong className="text-ok">{p.right}</strong></li>)}</ul>;
    case 'ORDERING':
      return <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-soft">{q.items.map((it) => <li key={it}>{it}</li>)}</ol>;
    default:
      return null;
  }
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
