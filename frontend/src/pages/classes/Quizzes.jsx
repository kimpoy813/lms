// Quizzes tab.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Copy, FileQuestion, Hourglass, MoreHorizontal, PlayCircle, Plus, RotateCcw, Settings2, ShieldAlert, Timer, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusBadge } from '../../components/Publish.jsx';
import { Badge, Button, Card, cn, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, QueryState } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatPercent, formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import QuizDialog, { QUIZ_KINDS } from './QuizDialog.jsx';
import { useClass } from './useClass.js';

export const windowText = (q) => {
  const now = Date.now();
  if (q.availableFrom && new Date(q.availableFrom).getTime() > now) return `Opens ${formatDateTime(q.availableFrom)}`;
  if (q.availableUntil) return `${new Date(q.availableUntil).getTime() <= now ? 'Closed' : 'Closes'} ${formatDateTime(q.availableUntil)}`;
  return 'No closing date';
};

export default function Quizzes() {
  const { cls, canManage, base } = useClass();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useQuery({ queryKey: ['class', cls.id, 'quizzes'], queryFn: () => api.get(`${base}/quizzes`) });
  const readOnly = cls.status === 'ARCHIVED';
  return (
    <>
      {canManage && (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" to="/question-banks">Question banks</Button>
          <Button icon={Plus} onClick={() => setCreating(true)} disabled={readOnly}>New quiz</Button>
        </div>
      )}
      <QueryState query={query}>
        {(list) => list.length === 0 ? (
          <Card>
            <EmptyState icon={FileQuestion} title={canManage ? 'No quizzes yet' : 'No quizzes have been posted'} description={canManage ? 'Quizzes are checked automatically for most question types, with a server-side timer.' : 'Quizzes and exams appear here when your teacher opens them.'}
              action={canManage && !readOnly ? <Button icon={Plus} onClick={() => setCreating(true)}>New quiz</Button> : null} />
          </Card>
        ) : <ul className="space-y-3">{list.map((q) => <li key={q.id}>{canManage ? <TeacherRow q={q} readOnly={readOnly} /> : <StudentRow q={q} />}</li>)}</ul>}
      </QueryState>
      {creating && <QuizDialog onClose={() => setCreating(false)} onSaved={(q) => navigate(`${base}/quizzes/${q.id}`)} />}
    </>
  );
}

const meta = (q) => [QUIZ_KINDS[q.kind]?.split(' ')[0], plural(q.questionCount, 'question'), `${formatScore(q.totalPoints)} points`, q.timeLimitMinutes ? `${q.timeLimitMinutes} min` : null, q.strictMode ? 'strict rules' : null].filter(Boolean).join(' · ');

function StudentRow({ q }) {
  const { base } = useClass();
  const inProgress = Boolean(q.inProgressAttemptId);
  // Ended for a rule violation and waiting for the teacher; or given back by the teacher.
  const ended = q.myStatus === 'TERMINATED';
  const reopened = inProgress && Boolean(q.reopened);
  return (
    <Link to={`${base}/quizzes/${q.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', q.myStatus === 'MISSING' || ended ? 'bg-bad-soft text-bad' : q.submitted ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand')}><FileQuestion className="size-5" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 basis-56">
        <span className="block truncate font-semibold text-ink">{q.title}</span>
        <span className="block truncate text-[13px] text-faint">{meta(q)} · {windowText(q)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {reopened ? <Badge tone="info" icon={RotateCcw}>Reopened — continue</Badge>
          : inProgress ? <Badge tone="warn" icon={Hourglass}>In progress — resume</Badge>
            : ended ? <Badge tone="bad" icon={ShieldAlert}>Ended: rule violation</Badge>
          : q.submitted ? (
            q.awaitingGrading ? <Badge tone="info" icon={Clock}>Waiting for grading</Badge>
              : q.resultsVisible && q.score != null ? <span className="text-right"><span className="block text-base font-bold tabular-nums text-ink">{formatScore(q.score)}<span className="text-sm font-medium text-faint"> / {formatScore(q.totalPoints)}</span></span><span className={cn('block text-xs font-semibold', q.passed === false ? 'text-bad' : 'text-ok')}>{formatPercent(q.percent, 0)}{q.passed === true ? ' · passed' : q.passed === false ? ' · below passing' : ''}</span></span>
                : <Badge tone="brand" icon={CheckCircle2}>Submitted</Badge>
          ) : q.start?.ok ? <Badge tone="info" icon={PlayCircle}>Open</Badge>
            : q.myStatus === 'MISSING' ? <Badge tone="bad" icon={AlertTriangle}>Missed</Badge> : <Badge>{q.start?.code === 'NOT_OPEN' ? 'Not open yet' : 'Closed'}</Badge>}
      </span>
    </Link>
  );
}

function TeacherRow({ q, readOnly }) {
  const { cls, base } = useClass();
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(false);
  const invalidate = [['class', cls.id], ['dashboard'], ['calendar']];
  const copy = useAction(() => api.post(`/quizzes/${q.id}/copy`, {}), { invalidate, success: 'A draft copy was created.' });
  const remove = useAction(() => api.delete(`/quizzes/${q.id}`), { invalidate, success: 'Quiz deleted.', onSuccess: () => setConfirm(false) });
  const s = q.stats;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <Link to={`${base}/quizzes/${q.id}`} className="group flex min-w-0 flex-1 basis-64 items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><FileQuestion className="size-5" aria-hidden="true" /></span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold text-ink group-hover:text-brand">{q.title}</span><StatusBadge status={q.status} publishAt={q.publishAt} />{q.kind === 'EXAM' && <Badge tone="brand">Exam</Badge>}{q.kind === 'PRACTICE' && <Badge>Practice</Badge>}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-faint">{q.timeLimitMinutes ? <Timer className="size-3.5" aria-hidden="true" /> : null}{meta(q)} · {windowText(q)}</span>
        </span>
      </Link>
      {q.status === 'PUBLISHED' && (
        <dl className="flex shrink-0 gap-5 text-center text-xs text-faint">
          <div><dd className="text-base font-bold tabular-nums text-ink">{s.submitted}<span className="text-sm font-medium text-faint">/{s.enrolled}</span></dd><dt>Submitted</dt></div>
          <div><dd className={cn('text-base font-bold tabular-nums', s.toGrade > 0 ? 'text-info' : 'text-ink')}>{s.toGrade}</dd><dt>To grade</dt></div>
          <div><dd className={cn('text-base font-bold tabular-nums', s.inProgress > 0 ? 'text-warn' : 'text-ink')}>{s.inProgress}</dd><dt>In progress</dt></div>
          {s.violations > 0 && <div><dd className="text-base font-bold tabular-nums text-bad">{s.violations}</dd><dt>Ended</dt></div>}
        </dl>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {q.status === 'PUBLISHED' ? <Button size="sm" variant={s.toGrade > 0 || s.violations > 0 ? 'primary' : 'secondary'} to={`${base}/quizzes/${q.id}/results`}>{s.violations > 0 ? 'Decide' : s.toGrade > 0 ? 'Grade' : 'Results'}</Button> : <Button size="sm" variant="soft" to={`${base}/quizzes/${q.id}`}>Edit questions</Button>}
        <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Actions for ${q.title}`} onClick={toggle} {...props} />}>
          {!readOnly && <MenuItem icon={Settings2} onClick={() => setSettings(true)}>Settings</MenuItem>}
          <MenuItem icon={Copy} onClick={() => copy.mutate()}>Duplicate as draft</MenuItem>
          <MenuItem icon={Trash2} tone="danger" onClick={() => setConfirm(true)}>Delete</MenuItem>
        </Menu>
      </div>
      {settings && <SettingsLoader quizId={q.id} onClose={() => setSettings(false)} />}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${q.title}”?`} confirmLabel="Delete quiz">
        {s?.submitted > 0 ? `${plural(s.submitted, 'student')} already took this quiz. Their attempts will no longer be visible. ` : ''}The quiz is removed from the class and from the gradebook. The questions stay in your question bank.
      </ConfirmDialog>
    </div>
  );
}

/** The list does not carry every setting, so load the full quiz before editing. */
function SettingsLoader({ quizId, onClose }) {
  const { cls } = useClass();
  const quiz = useQuery({ queryKey: ['class', cls.id, 'quiz', quizId], queryFn: () => api.get(`/quizzes/${quizId}`) });
  if (!quiz.data) return null;
  return <QuizDialog quiz={quiz.data} onClose={onClose} />;
}
