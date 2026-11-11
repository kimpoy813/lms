// Assignments tab.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ClipboardList, Clock, Copy, FileCheck2, MoreHorizontal, PenLine, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { StatusBadge } from '../../components/Publish.jsx';
import { Badge, Button, Card, cn, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, QueryState, Segmented } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { dueLabel, formatDateTime, formatScore } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import AssignmentDialog from './AssignmentDialog.jsx';
import { useClass } from './useClass.js';

/** How a student's own status is shown. */
export const STUDENT_STATUS = {
  NOT_SUBMITTED: { label: 'Not submitted', tone: 'neutral', icon: Clock },
  DRAFT: { label: 'Draft saved', tone: 'info', icon: PenLine },
  SUBMITTED: { label: 'Submitted', tone: 'brand', icon: FileCheck2 },
  MISSING: { label: 'Missing', tone: 'bad', icon: AlertTriangle },
  RETURNED: { label: 'Graded', tone: 'ok', icon: CheckCircle2 },
  UNDER_REVIEW: { label: 'Being reviewed', tone: 'brand', icon: FileCheck2 },
  GRADED: { label: 'Graded, not returned', tone: 'info', icon: CheckCircle2 },
};

export default function Assignments() {
  const { cls, canManage, base } = useClass();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const query = useQuery({ queryKey: ['class', cls.id, 'assignments'], queryFn: () => api.get(`${base}/assignments`) });
  const creating = canManage && params.get('new') === '1';
  const readOnly = cls.status === 'ARCHIVED';

  const visible = (list) => {
    if (canManage) return filter === 'ALL' ? list : list.filter((a) => (filter === 'DRAFT' ? a.status !== 'PUBLISHED' : filter === 'TO_GRADE' ? a.stats.toGrade > 0 : true));
    if (filter === 'TODO') return list.filter((a) => ['NOT_SUBMITTED', 'DRAFT', 'MISSING'].includes(a.myStatus));
    if (filter === 'DONE') return list.filter((a) => ['SUBMITTED', 'RETURNED'].includes(a.myStatus));
    return list;
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Filter" value={filter} onChange={setFilter} options={canManage
          ? [{ value: 'ALL', label: 'All' }, { value: 'TO_GRADE', label: 'To grade' }, { value: 'DRAFT', label: 'Drafts' }]
          : [{ value: 'ALL', label: 'All' }, { value: 'TODO', label: 'To do' }, { value: 'DONE', label: 'Done' }]} />
        {canManage && <Button icon={Plus} onClick={() => setParams({ new: '1' })} disabled={readOnly}>New assignment</Button>}
      </div>
      <QueryState query={query}>
        {(list) => {
          const rows = visible(list);
          if (rows.length === 0) {
            return (
              <Card>
                <EmptyState icon={ClipboardList} title={list.length === 0 ? (canManage ? 'No assignments yet' : 'No assignments have been posted') : 'Nothing here'}
                  description={list.length === 0 ? (canManage ? 'Create an assignment to collect work online and grade it with points or a rubric.' : 'When your teacher posts an assignment it appears here.') : 'Try another filter.'}
                  action={list.length === 0 && canManage && !readOnly ? <Button icon={Plus} onClick={() => setParams({ new: '1' })}>New assignment</Button> : null} />
              </Card>
            );
          }
          return <ul className="space-y-3">{rows.map((a) => <li key={a.id}>{canManage ? <TeacherRow a={a} onEdit={() => setEditing(a.id)} readOnly={readOnly} /> : <StudentRow a={a} />}</li>)}</ul>;
        }}
      </QueryState>
      {(creating || editing) && <AssignmentDialog assignmentId={editing} onClose={() => { setEditing(null); if (creating) setParams({}, { replace: true }); }} />}
    </>
  );
}

function StudentRow({ a }) {
  const { base } = useClass();
  const status = STUDENT_STATUS[a.myStatus] ?? STUDENT_STATUS.NOT_SUBMITTED;
  const closed = !a.window?.open && !['SUBMITTED', 'RETURNED'].includes(a.myStatus);
  return (
    <Link to={`${base}/assignments/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', a.myStatus === 'MISSING' ? 'bg-bad-soft text-bad' : a.myStatus === 'RETURNED' ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand')}><ClipboardList className="size-5" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 basis-56">
        <span className="block truncate font-semibold text-ink">{a.title}</span>
        <span className="block truncate text-[13px] text-faint">{dueLabel(a.dueAt)} · {formatScore(a.points)} points{a.module ? ` · ${a.module.title}` : ''}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {a.isLate && a.myStatus !== 'MISSING' && <Badge tone="warn">Late</Badge>}
        {closed && <Badge>Closed</Badge>}
        {a.myStatus === 'RETURNED' && a.score != null
          ? <span className="text-right"><span className="block text-base font-bold tabular-nums text-ink">{formatScore(a.score)}<span className="text-sm font-medium text-faint"> / {formatScore(a.points)}</span></span></span>
          : <Badge tone={status.tone} icon={status.icon}>{status.label}</Badge>}
      </span>
    </Link>
  );
}

function TeacherRow({ a, onEdit, readOnly }) {
  const { cls, base } = useClass();
  const [confirm, setConfirm] = useState(false);
  const invalidate = [['class', cls.id], ['dashboard'], ['calendar']];
  const publish = useAction(() => api.patch(`/assignments/${a.id}`, { status: 'PUBLISHED' }), { invalidate, success: 'Assignment published. Students have been notified.' });
  const copy = useAction(() => api.post(`/assignments/${a.id}/copy`, {}), { invalidate, success: 'A draft copy was created.' });
  const remove = useAction(() => api.delete(`/assignments/${a.id}`), { invalidate, success: 'Assignment deleted.', onSuccess: () => setConfirm(false) });
  const s = a.stats;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <Link to={`${base}/assignments/${a.id}`} className="group flex min-w-0 flex-1 basis-64 items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><ClipboardList className="size-5" aria-hidden="true" /></span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold text-ink group-hover:text-brand">{a.title}</span><StatusBadge status={a.status} publishAt={a.publishAt} /></span>
          <span className="block truncate text-[13px] text-faint">{a.dueAt ? `Due ${formatDateTime(a.dueAt)}` : 'No due date'} · {formatScore(a.points)} points{a.gradeCategory ? ` · ${a.gradeCategory.period} › ${a.gradeCategory.name}` : ' · not in the gradebook'}</span>
        </span>
      </Link>
      {a.status === 'PUBLISHED' && (
        <dl className="flex shrink-0 gap-5 text-center text-xs text-faint">
          <div><dd className="text-base font-bold tabular-nums text-ink">{s.submitted}<span className="text-sm font-medium text-faint">/{s.enrolled}</span></dd><dt>Submitted</dt></div>
          <div><dd className={cn('text-base font-bold tabular-nums', s.toGrade > 0 ? 'text-info' : 'text-ink')}>{s.toGrade}</dd><dt>To grade</dt></div>
          <div><dd className={cn('text-base font-bold tabular-nums', s.missing > 0 ? 'text-bad' : 'text-ink')}>{s.missing}</dd><dt>Missing</dt></div>
        </dl>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {a.status === 'PUBLISHED'
          ? <Button size="sm" variant={s.toGrade > 0 ? 'primary' : 'secondary'} to={`${base}/assignments/${a.id}/submissions`}>{s.toGrade > 0 ? 'Grade' : 'Submissions'}</Button>
          : a.status === 'DRAFT' && !readOnly ? <Button size="sm" variant="soft" loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button> : null}
        <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Actions for ${a.title}`} onClick={toggle} {...props} />}>
          <MenuItem icon={Pencil} onClick={onEdit}>Edit</MenuItem>
          <MenuItem icon={Copy} onClick={() => copy.mutate()}>Duplicate as draft</MenuItem>
          <MenuItem icon={Trash2} tone="danger" onClick={() => setConfirm(true)}>Delete</MenuItem>
        </Menu>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${a.title}”?`} confirmLabel="Delete assignment">
        {s.submitted > 0 ? `${s.submitted} submission${s.submitted === 1 ? '' : 's'} and their grades will no longer be visible to students. ` : ''}The assignment is removed from the class and from the gradebook.
      </ConfirmDialog>
    </div>
  );
}
