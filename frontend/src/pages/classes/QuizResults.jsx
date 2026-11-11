// Quiz results for the teacher: who took it, what needs grading, how each question performed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CheckCircle2, ChevronLeft, Download, Eye, EyeOff, FileQuestion, MonitorOff, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Avatar, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, Input, Menu, MenuItem, Modal, ProgressBar, QueryState, StatCard, Table, Tabs, Td, Textarea, Th, Tr } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatPercent, formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { AnswerReview, QuestionText, typeLabel } from './quiz/QuestionParts.jsx';
import { RESULT_VISIBILITY } from './QuizDialog.jsx';
import { useClass } from './useClass.js';

const STATUS = {
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  MISSING: { label: 'Missed', tone: 'bad' },
  IN_PROGRESS: { label: 'In progress', tone: 'warn' },
  NEEDS_GRADING: { label: 'Needs grading', tone: 'info' },
  GRADED: { label: 'Done', tone: 'ok' },
};

export default function QuizResults() {
  const { cls, canManage, base } = useClass();
  const { can } = useAuth();
  const { quizId } = useParams();
  const [params, setParams] = useSearchParams();
  const [confirm, setConfirm] = useState(null);
  const tab = params.get('tab') ?? 'students';
  const attemptId = params.get('attempt');
  const key = ['class', cls.id, 'quiz', quizId, 'results'];
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/quizzes/${quizId}/results`), enabled: canManage, refetchInterval: 30_000 });
  const invalidate = [key, ['class', cls.id, 'quizzes'], ['class', cls.id, 'quiz', quizId], ['class', cls.id, 'gradebook'], ['dashboard']];

  const release = useAction((confirmPending) => api.post(`/quizzes/${quizId}/results/publish`, { confirmPending }), {
    invalidate, success: 'Results released. Students can now see their scores.', onSuccess: () => setConfirm(null),
    onError: (err) => { if (err.code === 'GRADING_PENDING') { setConfirm('pending'); return true; } return false; },
  });
  const withhold = useAction(() => api.post(`/quizzes/${quizId}/results/withhold`), { invalidate, success: 'Results are hidden from students again.' });
  const exportAs = async (format) => {
    try {
      await api.download(`/quizzes/${quizId}/export`, { format }, `quiz-results.${format}`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!canManage) return <EmptyState title="Only the teacher can see quiz results" />;
  return (
    <QueryState query={query}>
      {(data) => {
        const { quiz, stats, students } = data;
        const manual = quiz.resultVisibility === 'MANUAL';
        return (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link to={`${base}/quizzes/${quiz.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />Quiz</Link>
              <h2 className="min-w-0 flex-1 basis-60 truncate text-lg font-semibold text-ink">{quiz.title} — results</h2>
              {can('grades.export') && (
                <Menu trigger={({ toggle, props }) => <Button variant="secondary" size="sm" icon={Download} onClick={toggle} {...props}>Export</Button>}>
                  <MenuItem onClick={() => exportAs('xlsx')}>Excel (.xlsx)</MenuItem>
                  <MenuItem onClick={() => exportAs('csv')}>CSV</MenuItem>
                  <MenuItem onClick={() => exportAs('pdf')}>PDF</MenuItem>
                </Menu>
              )}
              {manual && (quiz.resultsPublishedAt
                ? <Button variant="secondary" size="sm" icon={EyeOff} loading={withhold.isPending} onClick={() => withhold.mutate()}>Hide results</Button>
                : <Button size="sm" icon={Eye} loading={release.isPending} disabled={stats.submitted === 0} onClick={() => release.mutate(false)}>Release results</Button>)}
            </div>

            <p className="mb-4 text-[13px] text-soft">
              Students see their score: <strong className="font-semibold text-ink">{RESULT_VISIBILITY[quiz.resultVisibility].toLowerCase()}</strong>
              {manual ? (quiz.resultsPublishedAt ? ` — released ${formatDateTime(quiz.resultsPublishedAt)}.` : ' — not released yet.') : '.'}
            </p>

            <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Submitted" value={`${stats.submitted}/${students.length}`} icon={Users} />
              <StatCard label="Needs grading" value={stats.needsGrading} icon={FileQuestion} tone={stats.needsGrading > 0 ? 'info' : 'ok'} hint={stats.needsGrading > 0 ? 'Essay or file answers' : 'Nothing waiting'} />
              <StatCard label="Class average" value={stats.average === null ? '—' : formatPercent(stats.average)} icon={BarChart3} hint={stats.highest !== null ? `Highest ${formatPercent(stats.highest, 0)} · lowest ${formatPercent(stats.lowest, 0)}` : 'No scores yet'} />
              <StatCard label="Passed" value={quiz.passingPercent == null ? '—' : stats.passed} icon={CheckCircle2} tone="ok" hint={quiz.passingPercent == null ? 'No passing score set' : `Passing score ${quiz.passingPercent}%`} />
            </div>

            <Tabs className="mb-4" value={tab} onChange={(t) => setParams(t === 'students' ? {} : { tab: t })} tabs={[{ value: 'students', label: 'Students', icon: Users }, { value: 'analysis', label: 'Question analysis', icon: BarChart3 }]} />

            {tab === 'analysis' ? <Analysis quizId={quiz.id} /> : (
              <Table>
                <thead><tr><Th>Student</Th><Th>Status</Th><Th className="text-right">Score</Th><Th className="hidden text-right sm:table-cell">Percent</Th><Th className="hidden md:table-cell">Submitted</Th><Th><span className="sr-only">Attempts</span></Th></tr></thead>
                <tbody>
                  {students.map((s) => {
                    const st = STATUS[s.status] ?? STATUS.NOT_STARTED;
                    const last = s.attempts.at(-1);
                    return (
                      <Tr key={s.student.id}>
                        <Td>
                          <div className="flex items-center gap-3">
                            <Avatar name={s.student.name} size={32} />
                            <div className="min-w-0"><p className="truncate font-medium">{s.student.lastName}, {s.student.firstName}</p><p className="text-xs text-faint">{s.student.studentNumber ?? ''}</p></div>
                          </div>
                        </Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                        <Td className="text-right font-semibold tabular-nums">{s.score === null ? '—' : <>{formatScore(s.score)}<span className="font-normal text-faint"> / {formatScore(quiz.totalPoints)}</span></>}</Td>
                        <Td className={cn('hidden text-right tabular-nums sm:table-cell', s.passed === false ? 'text-bad' : 'text-soft')}>{s.percent === null ? '—' : formatPercent(s.percent)}</Td>
                        <Td className="hidden text-soft md:table-cell">{s.lastSubmittedAt ? formatDateTime(s.lastSubmittedAt) : '—'}</Td>
                        <Td className="text-right">
                          {s.attempts.length === 0 ? null : s.attempts.length === 1
                            ? <Button size="sm" variant={last.needsManualGrading ? 'primary' : 'secondary'} disabled={last.status === 'IN_PROGRESS'} onClick={() => setParams({ attempt: last.id })}>{last.status === 'IN_PROGRESS' ? 'Answering…' : last.needsManualGrading ? 'Grade' : 'View'}</Button>
                            : (
                              <Menu trigger={({ toggle, props }) => <Button size="sm" variant={s.attempts.some((a) => a.needsManualGrading) ? 'primary' : 'secondary'} onClick={toggle} {...props}>{plural(s.attempts.length, 'attempt')}</Button>}>
                                {s.attempts.map((a) => (
                                  <MenuItem key={a.id} disabled={a.status === 'IN_PROGRESS'} onClick={() => setParams({ attempt: a.id })}>
                                    Attempt {a.attemptNumber} · {a.status === 'IN_PROGRESS' ? 'in progress' : `${formatScore(a.totalScore)} / ${formatScore(a.maxScore)}`}{a.id === s.countedAttemptId ? ' ✓' : ''}{a.needsManualGrading ? ' · needs grading' : ''}
                                  </MenuItem>
                                ))}
                              </Menu>
                            )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}

            {attemptId && <AttemptDialog attemptId={attemptId} invalidate={invalidate} onClose={() => setParams(tab === 'students' ? {} : { tab })} />}
            <ConfirmDialog open={confirm === 'pending'} onClose={() => setConfirm(null)} onConfirm={() => release.mutate(true)} loading={release.isPending} tone="primary" title="Some answers are not graded yet" confirmLabel="Release anyway">
              {plural(stats.needsGrading, 'student')} still {stats.needsGrading === 1 ? 'has' : 'have'} answers waiting for your grade. If you release now, those students see “waiting for grading” until you finish.
            </ConfirmDialog>
          </>
        );
      }}
    </QueryState>
  );
}

function Analysis({ quizId }) {
  const { cls } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'quiz', quizId, 'analysis'], queryFn: () => api.get(`/quizzes/${quizId}/analysis`) });
  return (
    <QueryState query={query}>
      {(rows) => rows.length === 0 ? <Card><EmptyState icon={BarChart3} title="No submitted attempts yet" description="The analysis appears after students submit." /></Card> : (
        <ol className="space-y-3">
          {rows.map((r, i) => {
            const pct = r.correctPercent ?? r.averagePercent;
            return (
              <li key={r.questionId}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-sm font-bold text-soft">{i + 1}</span>
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="text-sm text-ink">{r.text}</p>
                      <p className="mt-0.5 text-xs text-faint">{typeLabel(r.type)} · {r.answered} of {plural(r.responses, 'student')} answered{r.pending > 0 ? ` · ${r.pending} not graded yet` : ''}</p>
                    </div>
                    <div className="w-40 shrink-0">
                      <p className={cn('text-right text-lg font-bold tabular-nums', pct === null ? 'text-faint' : pct < 50 ? 'text-bad' : pct < 75 ? 'text-warn' : 'text-ok')}>{pct === null ? '—' : formatPercent(pct, 0)}</p>
                      <p className="mb-1 text-right text-[11px] text-faint">{r.correctPercent !== null ? 'answered correctly' : 'average score'}</p>
                      {pct !== null && <ProgressBar value={pct} tone={pct < 50 ? 'bad' : pct < 75 ? 'warn' : 'ok'} label="Share of correct answers" className="h-1.5" />}
                    </div>
                  </div>
                  {r.choices.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                      {r.choices.map((c) => (
                        <li key={c.text} className="flex items-center gap-3 text-[13px]">
                          <span className={cn('min-w-0 flex-1 truncate', c.isCorrect ? 'font-semibold text-ok' : 'text-soft')}>{c.isCorrect && '✓ '}{c.text}</span>
                          <span className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-raised"><span className={cn('block h-full rounded-full', c.isCorrect ? 'bg-ok' : 'bg-line-strong')} style={{ width: `${r.responses ? (c.count / r.responses) * 100 : 0}%` }} /></span>
                          <span className="w-6 shrink-0 text-right tabular-nums text-faint">{c.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </QueryState>
  );
}

function AttemptDialog({ attemptId, invalidate, onClose }) {
  const client = useQueryClient();
  const { cls } = useClass();
  const key = ['attempt', attemptId, 'teacher'];
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/attempts/${attemptId}`) });
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(null);
  const remove = useAction(() => api.delete(`/attempts/${attemptId}`, { reason: reason.trim() }), {
    invalidate, success: 'Attempt removed. The student can take the quiz again.', onSuccess: onClose,
    onError: (err) => { setReasonError(err.fields?.reason ?? err.message); return true; },
  });
  const onGraded = (data) => {
    client.setQueryData(key, data);
    for (const queryKey of invalidate) client.invalidateQueries({ queryKey });
  };
  const a = query.data;
  const away = a?.events?.filter((e) => e.type === 'TAB_HIDDEN' || e.type === 'WINDOW_BLUR').length ?? 0;

  return (
    <Modal open onClose={onClose} size="xl" title={a ? `${a.student.name} — attempt ${a.attemptNumber}` : 'Attempt'} description={a ? `Submitted ${formatDateTime(a.submittedAt)} · started ${formatDateTime(a.startedAt)}` : null}
      footer={a && cls.status !== 'ARCHIVED' ? <><Button variant="dangerGhost" icon={Trash2} className="mr-auto" onClick={() => setVoiding(true)}>Remove attempt</Button><Button onClick={onClose}>Done</Button></> : <Button onClick={onClose}>Done</Button>}>
      <QueryState query={query}>
        {(attempt) => (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-raised px-4 py-3">
              <div><p className="text-xs font-medium text-faint">Score</p><p className="text-2xl font-bold tabular-nums text-ink">{formatScore(attempt.totalScore)}<span className="text-base font-semibold text-faint"> / {formatScore(attempt.maxScore)}</span></p></div>
              <div className="text-sm text-soft">Checked automatically: <strong className="text-ink">{formatScore(attempt.autoScore)}</strong> · by you: <strong className="text-ink">{formatScore(attempt.manualScore)}</strong></div>
              {attempt.needsManualGrading && <Badge tone="info" className="ml-auto">Answers waiting for your grade</Badge>}
            </div>
            {away > 0 && (
              <Alert tone="warn" title={`Left the quiz tab ${away} time${away === 1 ? '' : 's'}`}>
                <MonitorOff className="mr-1 inline size-3.5" aria-hidden="true" />This is only a signal: a notification, a phone call or a weak connection also causes it. Talk to the student before drawing conclusions.
              </Alert>
            )}
            {attempt.questions?.map((item, i) => <GradeAnswer key={item.position} attemptId={attempt.id} item={item} number={i + 1} onGraded={onGraded} readOnly={cls.status === 'ARCHIVED'} />)}
          </div>
        )}
      </QueryState>

      <ConfirmDialog open={voiding} onClose={() => setVoiding(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Remove this attempt?" confirmLabel="Remove attempt">
        <p>The attempt and its answers are deleted so the student can take the quiz again — for example after a power interruption. This is recorded in the audit log.</p>
        <Field label="Reason" className="mt-3" error={reasonError}><Textarea rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(null); }} placeholder="e.g. Brownout during the quiz" maxLength={500} /></Field>
      </ConfirmDialog>
    </Modal>
  );
}

function GradeAnswer({ attemptId, item, number, onGraded, readOnly }) {
  const [score, setScore] = useState(item.manualScore ?? item.score ?? '');
  const [feedback, setFeedback] = useState(item.feedback ?? '');
  const [open, setOpen] = useState(item.needsManual);
  const [error, setError] = useState(null);
  const grade = useAction(() => api.put(`/attempts/${attemptId}/answers/${item.position}/grade`, { score: Number(score), feedback: feedback.trim() || null }), {
    success: `Question ${number} graded.`,
    onSuccess: (data) => { setError(null); setOpen(false); onGraded(data); },
    onError: (err) => { setError(err.fields?.score ?? err.message); return true; },
  });
  const full = item.score !== null && item.score >= item.points;
  return (
    <section className={cn('rounded-xl border p-4', item.needsManual ? 'border-info/50' : 'border-line')} aria-label={`Question ${number}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-brand">Question {number}<Badge>{typeLabel(item.question.type)}</Badge></p>
        <p className="flex items-center gap-2 text-sm">
          {item.needsManual ? <Badge tone="info">Needs your grade</Badge> : <span className={cn('font-bold tabular-nums', full ? 'text-ok' : item.score > 0 ? 'text-warn' : 'text-bad')}>{formatScore(item.score)} / {formatScore(item.points)}</span>}
          {!item.needsManual && !readOnly && <button type="button" onClick={() => setOpen((v) => !v)} className="text-[13px] font-medium text-brand hover:underline">{open ? 'Cancel' : 'Change score'}</button>}
        </p>
      </div>
      <QuestionText question={item.question} className="mb-3 text-sm" />
      <AnswerReview item={item} />
      {item.explanation && <p className="mt-2 text-[13px] text-faint">Explanation: {item.explanation}</p>}
      {item.feedback && !open && <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-sm text-soft"><span className="font-medium text-ink">Your feedback:</span> {item.feedback}</p>}
      {open && !readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); grade.mutate(); }} className="mt-3 grid gap-3 rounded-xl bg-raised p-3 sm:grid-cols-[9rem_1fr_auto] sm:items-end">
          <Field label={`Score (of ${formatScore(item.points)})`} error={error}><Input type="number" min="0" max={item.points} step="any" required value={score} onChange={(e) => setScore(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Feedback" optional><Input value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={5000} placeholder="Shown to the student with the result" /></Field>
          <Button type="submit" loading={grade.isPending} disabled={score === ''}>Save</Button>
        </form>
      )}
      {!item.needsManual && item.manualScore !== null && item.autoScore !== null && item.manualScore !== item.autoScore && <p className="mt-2 flex items-center gap-1.5 text-xs text-faint"><AlertTriangle className="size-3.5 text-warn" aria-hidden="true" />You changed the automatic score ({formatScore(item.autoScore)}).</p>}
    </section>
  );
}
