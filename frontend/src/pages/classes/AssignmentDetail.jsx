// One assignment. Students read the instructions and hand in their work here;
// teachers see a summary and go on to grade.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronLeft, Clock, FileCheck2, Lock, Pencil, Save, Send, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { FileList, FileUpload } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText, { isEmptyHtml } from '../../components/RichText.jsx';
import { Alert, Badge, Button, Card, CardHeader, cn, ConfirmDialog, DescriptionList, QueryState } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatScore, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import AssignmentDialog from './AssignmentDialog.jsx';
import { STUDENT_STATUS } from './Assignments.jsx';
import { useClass } from './useClass.js';

export const penaltyText = (a) =>
  a.latePenaltyType === 'PERCENT_PER_DAY' ? `${formatScore(a.latePenaltyValue)}% is deducted for each day late (up to ${formatScore(a.latePenaltyMax)}%).`
    : a.latePenaltyType === 'PERCENT_FLAT' ? `${formatScore(a.latePenaltyValue)}% is deducted from late work.` : 'There is no penalty for late work.';

export default function AssignmentDetail() {
  const { cls, canManage, base } = useClass();
  const { assignmentId } = useParams();
  const [editing, setEditing] = useState(false);
  const query = useQuery({ queryKey: ['class', cls.id, 'assignment', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}`) });

  return (
    <QueryState query={query}>
      {(a) => (
        <>
          <Link to={`${base}/assignments`} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />All assignments</Link>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="min-w-0 space-y-5 lg:col-span-2">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight text-ink text-balance">{a.title}</h1>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-soft">
                      <span className="flex items-center gap-1.5"><CalendarClock className="size-4 text-faint" aria-hidden="true" />{a.dueAt ? `Due ${formatDateTime(a.dueAt)}` : 'No due date'}</span>
                      <span className="font-medium text-ink">{formatScore(a.points)} points</span>
                      {canManage && <StatusBadge status={a.status} publishAt={a.publishAt} />}
                    </p>
                  </div>
                  {canManage && cls.status !== 'ARCHIVED' && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
                </div>
                <div className="mt-5 border-t border-line pt-5">
                  <RichText html={a.instructionsHtml} empty={<p className="text-sm text-faint">No written instructions.</p>} />
                  {a.attachments.length > 0 && (
                    <div className="mt-5">
                      <h2 className="mb-2 text-sm font-semibold text-ink">Files from your teacher</h2>
                      <FileList files={a.attachments} />
                    </div>
                  )}
                </div>
              </Card>
              {a.rubric && <RubricCard rubric={a.rubric} scores={a.submission?.status === 'RETURNED' ? a.submission.rubricScores : null} />}
              {!canManage && <SubmissionPanel key={a.submission?.updatedAt ?? 'none'} a={a} />}
            </div>

            <div className="min-w-0 space-y-5">
              {canManage ? <TeacherSummary a={a} /> : <StudentStatus a={a} />}
              <Card>
                <CardHeader title="Details" />
                <DescriptionList items={[
                  a.availableFrom && ['Opens', formatDateTime(a.availableFrom)],
                  ['Due', a.dueAt ? formatDateTime(a.dueAt) : 'No due date'],
                  ['Late work', a.allowLate ? (a.closeAt ? `Accepted until ${formatDateTime(a.closeAt)}` : 'Accepted') : 'Not accepted'],
                  a.allowLate && a.dueAt && ['Penalty', penaltyText(a)],
                  ['Hand in', [a.allowText && 'typed answer', a.allowFiles && `up to ${a.maxFiles} file${a.maxFiles === 1 ? '' : 's'}`].filter(Boolean).join(' or ') || 'in class'],
                  ['Resubmission', a.allowResubmission ? 'Allowed until graded' : 'Not allowed'],
                  a.gradeCategory && ['Counts toward', `${a.gradeCategory.period} › ${a.gradeCategory.name}`],
                  a.module && ['Module', <Link key="m" to={`${base}/modules/${a.module.id}`} className="text-brand hover:underline">{a.module.title}</Link>],
                ]} />
              </Card>
            </div>
          </div>
          {editing && <AssignmentDialog assignmentId={a.id} onClose={() => setEditing(false)} />}
        </>
      )}
    </QueryState>
  );
}

export function RubricCard({ rubric, scores }) {
  return (
    <Card>
      <CardHeader title="Rubric" description={`${rubric.title} · ${formatScore(rubric.totalPoints)} points`} />
      <div className="space-y-4">
        {rubric.criteria.map((c) => {
          const given = scores?.[c.id];
          return (
            <div key={c.id}>
              <p className="flex items-baseline justify-between gap-3 text-sm font-semibold text-ink"><span>{c.title}</span><span className="shrink-0 tabular-nums text-soft">{given != null ? `${formatScore(given.points ?? given)} / ` : ''}{formatScore(c.maxPoints)} pts</span></p>
              {c.description && <p className="mt-0.5 text-[13px] text-faint">{c.description}</p>}
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {c.levels.map((l) => {
                  const picked = given != null && Number(given.points ?? given) === Number(l.points);
                  return (
                    <li key={l.title} className={cn('rounded-lg border p-2.5 text-[13px]', picked ? 'border-brand bg-brand-soft' : 'border-line')}>
                      <p className="flex justify-between gap-2 font-semibold text-ink"><span>{l.title}</span><span className="tabular-nums">{formatScore(l.points)}</span></p>
                      {l.description && <p className="mt-1 text-soft">{l.description}</p>}
                    </li>
                  );
                })}
              </ul>
              {given?.comment && <p className="mt-2 text-[13px] text-soft"><span className="font-medium text-ink">Comment:</span> {given.comment}</p>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StudentStatus({ a }) {
  const s = a.submission;
  const status = STUDENT_STATUS[a.myStatus] ?? STUDENT_STATUS.NOT_SUBMITTED;
  const returned = s?.status === 'RETURNED';
  return (
    <Card className={cn(returned && 'border-ok/40')}>
      <CardHeader title="Your work" action={<Badge tone={status.tone} icon={status.icon}>{status.label}</Badge>} />
      {returned ? (
        <>
          <p className="text-4xl font-bold tabular-nums text-ink">{formatScore(s.finalScore)}<span className="text-xl font-semibold text-faint"> / {formatScore(a.points)}</span></p>
          {s.penaltyPercent > 0 && <p className="mt-1 text-[13px] text-warn">Late penalty of {formatScore(s.penaltyPercent)}% applied (score before penalty: {formatScore(s.rawScore)}).</p>}
          {s.feedback && (
            <div className="mt-4 rounded-xl bg-raised p-3.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-faint">Feedback from your teacher</p>
              <RichText html={s.feedback} className="mt-1 text-sm" />
            </div>
          )}
          <p className="mt-3 text-xs text-faint">Returned {relativeTime(s.returnedAt)}</p>
        </>
      ) : s?.submittedAt ? (
        <p className="text-sm text-soft">Submitted {formatDateTime(s.submittedAt)}{s.isLate ? ' (late)' : ''}. Your score appears here when your teacher returns it.</p>
      ) : (
        <p className="text-sm text-soft">{a.window.open ? (a.window.late ? 'The due date has passed. You can still submit, but it will be marked late.' : 'Not submitted yet.') : a.window.reason}</p>
      )}
      {s?.reopenedUntil && new Date(s.reopenedUntil) > new Date() && <Alert tone="info" className="mt-3">Your teacher reopened this for you until {formatDateTime(s.reopenedUntil)}.</Alert>}
    </Card>
  );
}

function SubmissionPanel({ a }) {
  const { cls } = useClass();
  const s = a.submission;
  const submitted = Boolean(s) && s.status !== 'DRAFT';
  const reviewed = ['GRADED', 'RETURNED'].includes(s?.status);
  const [text, setText] = useState(s?.textContent ?? '');
  const [files, setFiles] = useState(s?.files ?? []);
  const [revising, setRevising] = useState(false);
  const [errors, setErrors] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const dirty = useRef(false);
  const invalidate = [['class', cls.id], ['dashboard']];

  const body = (submit) => ({ textContent: a.allowText ? text : null, fileIds: files.map((f) => f.id), submit });
  const saveDraft = useAction(() => api.put(`/assignments/${a.id}/submission`, body(false)), {
    silent: true,
    onSuccess: () => { dirty.current = false; setSavedAt(new Date()); },
  });
  const submit = useAction(() => api.put(`/assignments/${a.id}/submission`, body(true)), {
    invalidate, success: 'Your work was submitted.',
    onSuccess: () => { dirty.current = false; setConfirm(false); setRevising(false); },
    onError: (err) => { setConfirm(false); if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  // Drafts are saved quietly a few seconds after the student stops typing.
  const editable = a.window.open && !reviewed && (!submitted || revising);
  const isDraftStage = editable && !submitted;
  useEffect(() => {
    if (!isDraftStage || !dirty.current) return undefined;
    const t = setTimeout(() => saveDraft.mutate(), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, files, isDraftStage]);

  if (!a.allowText && !a.allowFiles) {
    return <Card><CardHeader title="Your submission" /><p className="text-sm text-soft">This work is collected in class. There is nothing to hand in online.</p></Card>;
  }

  const canRevise = submitted && !reviewed && a.allowResubmission && a.window.open;
  const reopened = a.window.extended;
  const hasWork = !isEmptyHtml(text) || files.length > 0;

  return (
    <Card>
      <CardHeader title="Your submission" description={submitted && !revising ? `Attempt ${s.attemptNumber} · submitted ${formatDateTime(s.submittedAt)}${s.isLate ? ' · late' : ''}` : null}
        action={isDraftStage && savedAt ? <span className="flex items-center gap-1.5 text-xs text-faint"><CheckCircle2 className="size-3.5 text-ok" aria-hidden="true" />Draft saved {relativeTime(savedAt)}</span> : null} />

      {!a.window.open && !submitted && <Alert tone="warn" title={a.window.reason} className="mb-4"><Lock className="mr-1 inline size-3.5" aria-hidden="true" />Ask your teacher if you need this reopened.</Alert>}
      {a.window.open && a.window.late && !submitted && <Alert tone="warn" className="mb-4" title="The due date has passed">{penaltyText(a)}</Alert>}

      {editable || (reopened && reviewed) ? (
        <div className="space-y-4">
          {(reopened && reviewed) && <Alert tone="info">Your teacher reopened this assignment. Submitting again replaces your earlier work.</Alert>}
          {a.allowText && (
            <div>
              <LazyEditor value={text} onChange={(html) => { setText(html); dirty.current = true; setErrors({}); }} placeholder="Write your answer here…" minHeight={200} allowMedia={false} ariaLabel="Your answer" />
              {errors.textContent && <p className="mt-1.5 text-[13px] text-bad" role="alert">{errors.textContent}</p>}
            </div>
          )}
          {a.allowFiles && (
            <div>
              <FileUpload value={files} onChange={(list) => { setFiles(list); dirty.current = true; setErrors({}); }} max={a.maxFiles} compact={files.length > 0} label={files.length > 0 ? 'Add another file' : 'Attach your files'} hint={`Up to ${a.maxFiles} file${a.maxFiles === 1 ? '' : 's'} · PDF, Word, PowerPoint, Excel, pictures or ZIP`} />
              {errors.fileIds && <p className="mt-1.5 text-[13px] text-bad" role="alert">{errors.fileIds}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {revising && <Button variant="secondary" onClick={() => { setRevising(false); setText(s?.textContent ?? ''); setFiles(s?.files ?? []); }}>Cancel</Button>}
            {isDraftStage && <Button variant="secondary" icon={Save} loading={saveDraft.isPending} onClick={() => saveDraft.mutate(undefined, { onError: (err) => setErrors(err.fields ?? { textContent: err.message }) })}>Save draft</Button>}
            <Button icon={Send} disabled={!hasWork} onClick={() => setConfirm(true)}>{submitted ? 'Submit again' : 'Submit'}</Button>
          </div>
        </div>
      ) : submitted ? (
        <div className="space-y-4">
          {s.textContent && <div className="rounded-xl border border-line p-4"><RichText html={s.textContent} /></div>}
          <FileList files={s.files} />
          {!s.textContent && s.files.length === 0 && <p className="text-sm text-faint">Nothing was attached.</p>}
          {canRevise && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-[13px] text-faint">You can replace your work until your teacher grades it.</p>
              <Button variant="secondary" icon={Pencil} onClick={() => setRevising(true)}>Edit and resubmit</Button>
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => submit.mutate()} loading={submit.isPending} tone="primary" title={submitted ? 'Replace your submission?' : 'Submit your work?'} confirmLabel={submitted ? 'Submit again' : 'Submit'}>
        {a.window.late && !reopened ? <><strong className="text-warn">This will be marked late.</strong> {penaltyText(a)} </> : null}
        {a.allowResubmission ? 'You can replace it until your teacher starts grading.' : 'You cannot change it after submitting.'}
      </ConfirmDialog>
    </Card>
  );
}

function TeacherSummary({ a }) {
  const { cls, base } = useClass();
  const list = useQuery({ queryKey: ['class', cls.id, 'assignment', a.id, 'submissions'], queryFn: () => api.get(`/assignments/${a.id}/submissions`), enabled: a.status === 'PUBLISHED' });
  const students = list.data?.students ?? [];
  const count = (fn) => students.filter(fn).length;
  const toGrade = count((s) => ['SUBMITTED', 'UNDER_REVIEW'].includes(s.status));
  return (
    <Card>
      <CardHeader title="Submissions" icon={Users} />
      {a.status !== 'PUBLISHED' ? <p className="text-sm text-soft">Students cannot see this assignment until it is published.</p> : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-center">
            {[
              ['Submitted', count((s) => !['MISSING', 'NOT_SUBMITTED', 'DRAFT'].includes(s.status)), FileCheck2, 'text-ink'],
              ['To grade', toGrade, Clock, toGrade > 0 ? 'text-info' : 'text-ink'],
              ['Returned', count((s) => s.status === 'RETURNED'), CheckCircle2, 'text-ok'],
              ['Missing', count((s) => s.status === 'MISSING'), AlertTriangle, count((s) => s.status === 'MISSING') > 0 ? 'text-bad' : 'text-ink'],
            ].map(([label, n, , tone]) => (
              <div key={label} className="rounded-xl bg-raised py-3">
                <dd className={cn('text-2xl font-bold tabular-nums', tone)}>{list.isPending ? '–' : n}</dd>
                <dt className="text-xs font-medium text-faint">{label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-center text-xs text-faint">of {students.length} enrolled</p>
          <Button to={`${base}/assignments/${a.id}/submissions`} className="mt-4 w-full">{toGrade > 0 ? `Grade ${toGrade} submission${toGrade === 1 ? '' : 's'}` : 'View submissions'}</Button>
        </>
      )}
    </Card>
  );
}
