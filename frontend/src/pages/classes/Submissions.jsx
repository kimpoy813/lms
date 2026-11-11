// Grading: the class list on the left, one student's work and the grading form on the right.
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarClock, CheckCircle2, ChevronLeft, Download, Inbox, RotateCcw, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { FileList } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Avatar, Badge, Button, Card, Checkbox, cn, EmptyState, Field, Input, Modal, PageLoader, QueryState, Segmented, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatScore, fromLocalInput, plural, toLocalInput } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { penaltyText } from './AssignmentDetail.jsx';
import { useClass } from './useClass.js';

const ROSTER_STATUS = {
  NOT_SUBMITTED: { label: 'Not submitted', tone: 'neutral' },
  MISSING: { label: 'Missing', tone: 'bad' },
  SUBMITTED: { label: 'To grade', tone: 'info' },
  UNDER_REVIEW: { label: 'To grade', tone: 'info' },
  GRADED: { label: 'Graded', tone: 'warn' },
  RETURNED: { label: 'Returned', tone: 'ok' },
};

export default function Submissions() {
  const { cls, canManage, base } = useClass();
  const { can } = useAuth();
  const { assignmentId } = useParams();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('ALL');
  const query = useQuery({ queryKey: ['class', cls.id, 'assignment', assignmentId, 'submissions'], queryFn: () => api.get(`/assignments/${assignmentId}/submissions`), enabled: canManage });
  const studentId = params.get('student');
  const invalidate = [['class', cls.id, 'assignment', assignmentId], ['class', cls.id, 'assignments'], ['class', cls.id, 'gradebook'], ['dashboard']];

  const returnAll = useAction(() => api.post(`/assignments/${assignmentId}/return`, {}), { invalidate, success: (r) => (r.returned > 0 ? `${plural(r.returned, 'grade')} returned to students.` : 'There were no graded submissions waiting to be returned.') });
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      await api.download(`/assignments/${assignmentId}/submissions-archive`, null, 'submissions.zip');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDownloading(false);
    }
  };

  const students = query.data?.students;
  const shown = useMemo(() => (students ?? []).filter((s) => filter === 'ALL' || (filter === 'TO_GRADE' ? ['SUBMITTED', 'UNDER_REVIEW'].includes(s.status) : filter === 'GRADED' ? ['GRADED', 'RETURNED'].includes(s.status) : ['MISSING', 'NOT_SUBMITTED'].includes(s.status))), [students, filter]);

  // Start with the first submission that still needs a grade.
  useEffect(() => {
    if (!students || studentId || students.length === 0) return;
    const first = students.find((s) => ['SUBMITTED', 'UNDER_REVIEW'].includes(s.status)) ?? students[0];
    setParams({ student: first.student.id }, { replace: true });
  }, [students, studentId, setParams]);

  if (!canManage) return <EmptyState title="Only the teacher can see submissions" />;
  return (
    <QueryState query={query}>
      {(data) => {
        const a = data.assignment;
        const gradedNotReturned = data.students.filter((s) => s.status === 'GRADED').length;
        return (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link to={`${base}/assignments/${a.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />Assignment</Link>
              <h2 className="min-w-0 flex-1 basis-60 truncate text-lg font-semibold text-ink">{a.title}</h2>
              {can('submissions.download') && <Button variant="secondary" size="sm" icon={Download} loading={downloading} onClick={download}>Download all</Button>}
              <Button size="sm" icon={Send} loading={returnAll.isPending} disabled={gradedNotReturned === 0} onClick={() => returnAll.mutate()}>Return {gradedNotReturned > 0 ? `${gradedNotReturned} graded` : 'grades'}</Button>
            </div>
            {data.students.length === 0 ? <Card><EmptyState icon={Inbox} title="No students are enrolled yet" /></Card> : (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
                <aside className="lg:sticky lg:top-32 lg:self-start">
                  <div className="lg:hidden">
                    <Select aria-label="Choose a student" value={studentId ?? ''} onChange={(e) => setParams({ student: e.target.value })}>
                      {data.students.map((s) => <option key={s.student.id} value={s.student.id}>{s.student.lastName}, {s.student.firstName} — {ROSTER_STATUS[s.status]?.label}</option>)}
                    </Select>
                  </div>
                  <Card padded={false} className="hidden lg:block">
                    <div className="border-b border-line p-3">
                      <Segmented size="sm" label="Filter students" value={filter} onChange={setFilter} className="w-full [&>button]:flex-1" options={[{ value: 'ALL', label: 'All' }, { value: 'TO_GRADE', label: 'To grade' }, { value: 'GRADED', label: 'Graded' }, { value: 'MISSING', label: 'Missing' }]} />
                    </div>
                    <ul className="max-h-[calc(100dvh-17rem)] overflow-y-auto p-2">
                      {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-faint">No students in this group.</li>}
                      {shown.map((s) => {
                        const meta = ROSTER_STATUS[s.status] ?? ROSTER_STATUS.NOT_SUBMITTED;
                        return (
                          <li key={s.student.id}>
                            <button type="button" onClick={() => setParams({ student: s.student.id })} aria-current={s.student.id === studentId ? 'true' : undefined} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left', s.student.id === studentId ? 'bg-brand-soft' : 'hover:bg-raised')}>
                              <Avatar name={s.student.name} fileId={s.student.avatarFileId} size={30} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">{s.student.lastName}, {s.student.firstName}</span>
                                <span className="flex items-center gap-1.5 text-[11px] text-faint">
                                  <span className={cn('size-1.5 rounded-full', { neutral: 'bg-line-strong', bad: 'bg-bad', info: 'bg-info', warn: 'bg-warn', ok: 'bg-ok' }[meta.tone])} aria-hidden="true" />
                                  {meta.label}{s.isLate ? ' · late' : ''}
                                </span>
                              </span>
                              {s.finalScore != null && <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{formatScore(s.finalScore)}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                </aside>
                <div className="min-w-0">
                  {studentId ? <GradePanel key={studentId} assignmentId={a.id} studentId={studentId} invalidate={invalidate} onNavigate={(id) => setParams({ student: id })} /> : <PageLoader />}
                </div>
              </div>
            )}
          </>
        );
      }}
    </QueryState>
  );
}

function GradePanel({ assignmentId, studentId, invalidate, onNavigate }) {
  const { cls } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'assignment', assignmentId, 'submission', studentId], queryFn: () => api.get(`/assignments/${assignmentId}/submissions/${studentId}`) });
  return <QueryState query={query}>{(data) => <GradeForm key={data.submission?.updatedAt ?? 'none'} data={data} invalidate={invalidate} onNavigate={onNavigate} />}</QueryState>;
}

function GradeForm({ data, invalidate, onNavigate }) {
  const { cls } = useClass();
  const { assignment: a, student, submission: s } = data;
  const meta = ROSTER_STATUS[data.status] ?? ROSTER_STATUS.NOT_SUBMITTED;
  const rubric = a.rubric;
  const [score, setScore] = useState(s?.rawScore ?? '');
  const [rubricScores, setRubricScores] = useState(() => s?.rubricScores ?? {});
  const [feedback, setFeedback] = useState(s?.feedback ?? '');
  const [waive, setWaive] = useState(false);
  const [errors, setErrors] = useState({});
  const [reopening, setReopening] = useState(false);
  const readOnly = cls.status === 'ARCHIVED';

  const rubricComplete = rubric ? rubric.criteria.every((c) => rubricScores[c.id]?.points !== undefined && rubricScores[c.id]?.points !== '') : false;
  const rubricTotal = rubric ? rubric.criteria.reduce((sum, c) => sum + (Number(rubricScores[c.id]?.points) || 0), 0) : null;
  const raw = rubric && rubricComplete ? rubricTotal : score === '' ? null : Number(score);
  const penalty = waive ? 0 : s?.penaltyPercent ?? 0;
  const final = raw === null || Number.isNaN(raw) ? null : Math.round(raw * (1 - penalty / 100) * 100) / 100;

  const grade = useAction((returnNow) => api.put(`/assignments/${a.id}/submissions/${student.id}/grade`, {
    ...(rubric && rubricComplete ? { rubricScores: Object.fromEntries(rubric.criteria.map((c) => [c.id, { points: Number(rubricScores[c.id].points), comment: rubricScores[c.id].comment ?? '' }])) } : { score: raw }),
    feedback: feedback || null,
    ...(waive ? { waivePenalty: true } : {}),
    return: returnNow,
  }), {
    invalidate,
    success: (_, returnNow) => (returnNow || s?.status === 'RETURNED' ? `Grade returned to ${student.firstName}.` : 'Grade saved. The student will see it when you return it.'),
    onSuccess: () => { setErrors({}); if (data.nextStudentId && s?.status !== 'RETURNED') onNavigate(data.nextStudentId); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={student.name} fileId={student.avatarFileId} size={44} />
          <div className="min-w-0 flex-1 basis-40">
            <p className="truncate text-lg font-semibold text-ink">{student.name}</p>
            <p className="text-[13px] text-faint">{student.studentNumber ?? 'No student number'} · {data.position} of {data.total}</p>
          </div>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <div className="flex gap-1.5">
            <Button variant="secondary" size="sm" icon={ArrowLeft} disabled={!data.previousStudentId} onClick={() => onNavigate(data.previousStudentId)} aria-label="Previous student" />
            <Button variant="secondary" size="sm" disabled={!data.nextStudentId} onClick={() => onNavigate(data.nextStudentId)} aria-label="Next student"><ArrowRight className="size-4" aria-hidden="true" /></Button>
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-5">
          {!s || s.status === 'DRAFT' || (!s.submittedAt && s.rawScore == null) ? (
            <EmptyState compact icon={Inbox} title={data.status === 'MISSING' ? 'Nothing was submitted before the due date' : 'Not submitted yet'} description={s?.reopenedUntil && new Date(s.reopenedUntil) > new Date() ? `Reopened for this student until ${formatDateTime(s.reopenedUntil)}.` : 'You can still record a score, for example for work handed in on paper.'} />
          ) : (
            <>
              <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-soft">
                <CalendarClock className="size-4 text-faint" aria-hidden="true" />
                {s.submittedAt ? <>Submitted {formatDateTime(s.submittedAt)} · attempt {s.attemptNumber}</> : 'No online submission'}
                {s.isLate && <Badge tone="warn">Late{s.penaltyPercent > 0 ? ` · −${formatScore(s.penaltyPercent)}%` : ''}</Badge>}
              </p>
              {s.textContent && <div className="rounded-xl border border-line bg-canvas p-4"><RichText html={s.textContent} /></div>}
              {s.files.length > 0 && <FileList files={s.files} className="mt-3" />}
              {!s.textContent && s.files.length === 0 && <p className="text-sm text-faint">The submission has no text or files.</p>}
            </>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 text-[15px] font-semibold">Grade</h3>
        {errors.rubricScores && <Alert tone="bad" className="mb-4">{errors.rubricScores}</Alert>}
        <fieldset disabled={readOnly} className="space-y-5">
          {rubric ? (
            <div className="space-y-4">
              {rubric.criteria.map((c) => {
                const current = rubricScores[c.id] ?? {};
                const setCriterion = (patch) => setRubricScores((r) => ({ ...r, [c.id]: { ...r[c.id], ...patch } }));
                return (
                  <div key={c.id} className="rounded-xl border border-line p-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{c.title}</p>
                      <label className="flex items-center gap-2 text-[13px] text-soft">
                        <span className="sr-only">Points for {c.title}</span>
                        <Input type="number" min="0" max={c.maxPoints} step="any" value={current.points ?? ''} onChange={(e) => setCriterion({ points: e.target.value })} className="h-8 w-20 text-right tabular-nums" />
                        / {formatScore(c.maxPoints)}
                      </label>
                    </div>
                    {c.description && <p className="mt-0.5 text-[13px] text-faint">{c.description}</p>}
                    <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Level for ${c.title}`}>
                      {c.levels.map((l) => {
                        const picked = current.points !== undefined && current.points !== '' && Number(current.points) === Number(l.points);
                        return (
                          <button key={l.title} type="button" role="radio" aria-checked={picked} title={l.description ?? ''} onClick={() => setCriterion({ points: l.points })} className={cn('rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors', picked ? 'border-brand bg-brand-soft text-brand' : 'border-line text-soft hover:border-line-strong hover:text-ink')}>
                            <span className="font-semibold">{l.title}</span> <span className="tabular-nums opacity-80">· {formatScore(l.points)}</span>
                          </button>
                        );
                      })}
                    </div>
                    <Input value={current.comment ?? ''} onChange={(e) => setCriterion({ comment: e.target.value })} placeholder="Comment on this criterion (optional)" maxLength={1000} className="mt-2.5 h-9" aria-label={`Comment for ${c.title}`} />
                  </div>
                );
              })}
            </div>
          ) : (
            <Field label={`Score (out of ${formatScore(a.points)})`} error={errors.score}>
              <Input type="number" min="0" max={a.points} step="any" value={score} onChange={(e) => setScore(e.target.value)} className="h-12 w-40 text-xl font-semibold tabular-nums" inputMode="decimal" />
            </Field>
          )}

          {(s?.penaltyPercent ?? 0) > 0 && (
            <div className="rounded-xl bg-warn-soft p-3.5">
              <p className="text-sm font-medium text-ink">Late penalty: {formatScore(s.penaltyPercent)}%</p>
              <p className="mb-2 text-[13px] text-soft">{penaltyText(a)}</p>
              <Checkbox checked={waive} onChange={(e) => setWaive(e.target.checked)} label="Waive the penalty for this student" description="The waiver is recorded in the audit log." />
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl bg-raised px-4 py-3">
            <div>
              <p className="text-xs font-medium text-faint">{penalty > 0 ? 'Final score after penalty' : 'Final score'}</p>
              <p className="text-2xl font-bold tabular-nums text-ink">{final === null ? '—' : formatScore(final)}<span className="text-base font-semibold text-faint"> / {formatScore(a.points)}</span></p>
            </div>
            {rubric && !rubricComplete && <p className="text-[13px] text-warn">Score every criterion to finish.</p>}
            {errors.score && rubric && <p className="text-[13px] text-bad">{errors.score}</p>}
          </div>

          <Field label="Feedback for the student" optional error={errors.feedback}>
            <LazyEditor value={feedback} onChange={setFeedback} placeholder="What went well, and what to improve next time…" minHeight={90} allowMedia={false} ariaLabel="Feedback" />
          </Field>
        </fieldset>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setReopening(true)} disabled={readOnly}>Reopen for this student</Button>
          <div className="flex flex-wrap gap-2">
            {s?.status !== 'RETURNED' && <Button variant="secondary" loading={grade.isPending && grade.variables === false} disabled={final === null || readOnly} onClick={() => grade.mutate(false)}>Save grade</Button>}
            <Button icon={s?.status === 'RETURNED' ? CheckCircle2 : Send} loading={grade.isPending && grade.variables === true} disabled={final === null || readOnly} onClick={() => grade.mutate(true)}>{s?.status === 'RETURNED' ? 'Update returned grade' : 'Save and return'}</Button>
          </div>
        </div>
        {s?.gradedAt && <p className="mt-3 text-right text-xs text-faint">Last graded {formatDateTime(s.gradedAt)}{s.gradedBy ? ` by ${s.gradedBy}` : ''}{s.returnedAt ? ` · returned ${formatDateTime(s.returnedAt)}` : ' · not returned yet'}</p>}
      </Card>

      {reopening && <ReopenDialog assignment={a} student={student} invalidate={invalidate} onClose={() => setReopening(false)} />}
    </div>
  );
}

function ReopenDialog({ assignment, student, invalidate, onClose }) {
  const [until, setUntil] = useState(() => new Date(Date.now() + 2 * 86_400_000).toISOString());
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const reopen = useAction(() => api.post(`/assignments/${assignment.id}/submissions/${student.id}/reopen`, { until, note: note.trim() || undefined }), {
    invalidate, success: `${student.firstName} can submit again.`, onSuccess: onClose,
    onError: (err) => { setError(err.fields?.until ?? err.message); return true; },
  });
  return (
    <Modal open onClose={onClose} title={`Reopen for ${student.name}`} size="sm" description="The student can submit (again) until the time below, without a late penalty."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={reopen.isPending} disabled={!until} onClick={() => reopen.mutate()}>Reopen</Button></>}>
      <div className="space-y-4">
        <Field label="Open until" error={error}><Input type="datetime-local" value={toLocalInput(until)} onChange={(e) => setUntil(fromLocalInput(e.target.value))} /></Field>
        <Field label="Note to the student" optional><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Please attach the missing page." /></Field>
      </div>
    </Modal>
  );
}
