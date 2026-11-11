// The teacher's gradebook: a spreadsheet of scores, the weights behind it, and the controls
// that decide when students may see a grading period.
//
// All arithmetic happens on the server (GET …/gradebook returns computed percentages and
// transmuted grades); this page only displays and edits scores.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ClipboardList, Download, Eye, EyeOff, FileQuestion, History, Inbox, Lock, LockOpen, MoreHorizontal, Pencil, Plus, Save, Settings2, Table2, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, QueryState, Select, StatCard, Tabs, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, formatPercent, formatScore, fromLocalInput, plural, relativeTime, toLocalInput } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import Appeals from './gradebook/Appeals.jsx';
import Setup from './gradebook/Setup.jsx';
import StudentGrades from './gradebook/StudentGrades.jsx';
import { useClass } from './useClass.js';

const cellKey = (studentId, itemId) => `${studentId}:${itemId}`;

export default function Gradebook() {
  const { cls, canManage, base } = useClass();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'grades';
  const query = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'grid'], queryFn: () => api.get(`${base}/gradebook`), enabled: canManage });
  const appeals = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'appeals'], queryFn: () => api.get(`${base}/gradebook/appeals`), enabled: canManage });
  if (!canManage) return <EmptyState title="The gradebook is for the teacher" description="Open Grades to see your own scores." action={<Button to={`${base}/grades`}>My grades</Button>} />;
  const pendingAppeals = (appeals.data ?? []).filter((a) => a.status === 'PENDING').length;

  return (
    <>
      <Tabs className="mb-5" value={tab} onChange={(t) => setParams(t === 'grades' ? {} : { tab: t })} tabs={[
        { value: 'grades', label: 'Grades', icon: Table2 },
        { value: 'setup', label: 'Weights and settings', icon: Settings2 },
        { value: 'appeals', label: 'Appeals', icon: Inbox, count: pendingAppeals },
        { value: 'log', label: 'Release log', icon: History },
      ]} />
      {tab === 'appeals' ? <Appeals query={appeals} />
        : tab === 'log' ? <ReleaseLog />
          : (
            <QueryState query={query}>
              {(data) => (tab === 'setup' ? <Setup data={data} /> : <Grid data={data} />)}
            </QueryState>
          )}
    </>
  );
}

function ReleaseLog() {
  const { cls, base } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'log'], queryFn: () => api.get(`${base}/gradebook/publishing-log`) });
  const LABEL = { PUBLISHED: 'Published to students', UNPUBLISHED: 'Hidden from students', LOCKED: 'Locked', UNLOCKED: 'Unlocked', FINALIZED: 'Final grades submitted', REOPENED: 'Final grades reopened' };
  return (
    <QueryState query={query}>
      {(rows) => rows.length === 0 ? <Card><EmptyState icon={History} title="Nothing has been released yet" description="Publishing, locking and finalising grades is recorded here." /></Card> : (
        <Card>
          <ol className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0 text-sm">
                <span className="font-semibold text-ink">{r.scope}</span>
                <span className="text-soft">{LABEL[r.action] ?? r.action.toLowerCase()}</span>
                {r.note && <span className="text-faint">— {r.note}</span>}
                <span className="ml-auto text-xs text-faint">{r.by} · {formatDateTime(r.at)}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </QueryState>
  );
}

// ── The grid ─────────────────────────────────────────────────────────────────
function Grid({ data }) {
  const { cls, base } = useClass();
  const { can } = useAuth();
  const { structure, students, stats } = data;
  // Start on the period that is being worked on: the first one that has columns and is not locked yet.
  const hasItems = (p) => p.categories.some((c) => c.items.length > 0);
  const [periodId, setPeriodId] = useState(() => (structure.periods.find((p) => !p.lockedAt && hasItems(p)) ?? structure.periods.find((p) => !p.lockedAt) ?? structure.periods[0])?.id ?? '');
  const [dirty, setDirty] = useState({}); // cellKey → { status, score }
  const [dialog, setDialog] = useState(null);
  const [studentId, setStudentId] = useState(null);
  const [reasonPrompt, setReasonPrompt] = useState(null);
  const [reason, setReason] = useState('');
  const invalidate = [['class', cls.id, 'gradebook'], ['dashboard'], ['grades']];
  const finalized = Boolean(data.class.finalizedAt);
  const readOnly = cls.status === 'ARCHIVED' || finalized;
  const period = structure.periods.find((p) => p.id === periodId) ?? structure.periods[0];
  const locked = Boolean(period?.lockedAt) || readOnly;

  const save = useAction((withReason) => api.put(`${base}/gradebook/entries`, {
    entries: Object.entries(dirty).map(([key, v]) => { const [sid, itemId] = key.split(':'); return { studentId: sid, itemId, status: v.status, score: v.status === 'GRADED' ? v.score : null }; }),
    ...(withReason ? { reason: reason.trim() } : {}),
  }), {
    invalidate, success: 'Grades saved.',
    onSuccess: () => { setDirty({}); setReasonPrompt(null); setReason(''); },
    onError: (err) => { if (err.fields?.reason) { setReasonPrompt(err.fields.reason); return true; } return false; },
  });
  const periodAction = useAction(({ action, note }) => api.post(`${base}/gradebook/periods/${period.id}/${action}`, note ? { note } : {}), {
    invalidate, onSuccess: () => setDialog(null),
    success: (_, { action }) => ({ publish: `${period.name} grades are now visible to students.`, unpublish: `${period.name} grades are hidden from students.`, lock: `${period.name} is locked.`, unlock: `${period.name} is unlocked.` }[action]),
  });
  const removeItem = useAction((itemId) => api.delete(`${base}/gradebook/items/${itemId}`), { invalidate, success: 'Column deleted.', onSuccess: () => setDialog(null) });
  const exportAs = async (format) => {
    try {
      await api.download(`${base}/gradebook/export`, { format }, `gradebook.${format}`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Do not lose unsaved scores to an accidental tab close.
  const dirtyCount = Object.keys(dirty).length;
  useEffect(() => {
    if (dirtyCount === 0) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);

  const items = useMemo(() => (period?.categories ?? []).flatMap((c) => c.items.map((item) => ({ ...item, category: c }))), [period]);
  const setCell = (sid, item, value) => setDirty((d) => {
    const key = cellKey(sid, item.id);
    const original = students.find((s) => s.id === sid)?.entries[item.id];
    const same = (original?.status ?? 'UNGRADED') === value.status && (value.status !== 'GRADED' || original?.score === value.score);
    const next = { ...d };
    if (same) delete next[key]; else next[key] = value;
    return next;
  });

  if (structure.periods.length === 0) {
    return <Card><EmptyState icon={Settings2} title="Set up the grading periods first" description="Choose how the final grade is computed — for example Midterm 50% and Final 50%, each with weighted categories." action={<Button to="?tab=setup">Set up weights</Button>} /></Card>;
  }

  return (
    <div className="space-y-5">
      {!structure.valid && <Alert tone="warn" title="The weights do not add up yet" action={<Button size="sm" variant="secondary" to="?tab=setup">Fix weights</Button>}>{structure.errors[0]}</Alert>}
      {finalized && <Alert tone="ok" title={`Final grades were submitted ${formatDateTime(data.class.finalizedAt)}`} action={cls.status !== 'ARCHIVED' ? <Button size="sm" variant="secondary" onClick={() => setDialog('reopen')}>Reopen</Button> : null}>Scores can no longer be changed. Reopening requires a reason and is recorded.</Alert>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Class average" value={stats.average === null ? '—' : formatPercent(stats.average)} icon={Table2} hint={stats.highest !== null ? `Highest ${formatPercent(stats.highest, 0)} · lowest ${formatPercent(stats.lowest, 0)}` : 'No grades yet'} />
        <StatCard label="Passing" value={stats.passing} icon={CheckCircle2} tone="ok" hint={`of ${plural(stats.graded, 'graded student')}`} />
        <StatCard label="Failing" value={stats.failing} icon={AlertTriangle} tone={stats.failing > 0 ? 'bad' : 'ok'} hint="Below the passing mark so far" />
        <StatCard label="Grading scale" value={data.class.gradingScale?.entries?.[0]?.label ? `${data.class.gradingScale.entries[0].label}–${data.class.gradingScale.entries.at(-1).label}` : '—'} icon={Settings2} hint={data.class.gradingScale?.name ?? 'Not chosen'} />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div role="tablist" aria-label="Grading period" className="inline-flex rounded-lg border border-line bg-raised p-0.5">
            {structure.periods.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={p.id === period.id} onClick={() => setPeriodId(p.id)} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', p.id === period.id ? 'bg-surface text-ink shadow-sm' : 'text-soft hover:text-ink')}>
                {p.name} <span className="text-xs font-normal text-faint">{p.weight}%</span>
                {p.lockedAt ? <Lock className="size-3.5 text-faint" aria-label="Locked" /> : p.publishedAt ? <Eye className="size-3.5 text-ok" aria-label="Published" /> : null}
              </button>
            ))}
          </div>
          <span className="flex flex-wrap items-center gap-1.5">
            {period.publishedAt ? <Badge tone="ok" icon={Eye}>Visible to students</Badge> : <Badge tone="warn" icon={EyeOff}>Hidden from students</Badge>}
            {period.lockedAt && <Badge icon={Lock}>Locked</Badge>}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!locked && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setDialog({ item: null })}>Add column</Button>}
            {!readOnly && (
              <Menu trigger={({ toggle, props }) => <Button size="sm" variant="secondary" onClick={toggle} {...props}>{period.name} <MoreHorizontal className="size-4" aria-hidden="true" /></Button>}>
                {period.publishedAt
                  ? <MenuItem icon={EyeOff} onClick={() => periodAction.mutate({ action: 'unpublish' })}>Hide from students</MenuItem>
                  : <MenuItem icon={Eye} onClick={() => setDialog('publish')}>Publish to students</MenuItem>}
                {period.lockedAt
                  ? <MenuItem icon={LockOpen} onClick={() => setDialog('unlock')}>Unlock for changes</MenuItem>
                  : <MenuItem icon={Lock} onClick={() => periodAction.mutate({ action: 'lock' })}>Lock scores</MenuItem>}
              </Menu>
            )}
            {can('grades.export') && (
              <Menu trigger={({ toggle, props }) => <IconButton icon={Download} variant="secondary" size="sm" label="Export the gradebook" onClick={toggle} {...props} />}>
                <MenuItem onClick={() => exportAs('xlsx')}>Excel (.xlsx)</MenuItem>
                <MenuItem onClick={() => exportAs('csv')}>CSV</MenuItem>
                <MenuItem onClick={() => exportAs('pdf')}>PDF</MenuItem>
              </Menu>
            )}
          </div>
        </div>

        {students.length === 0 ? <EmptyState icon={Table2} title="No students are enrolled yet" /> : (
          <GridTable period={period} items={items} students={students} dirty={dirty} locked={locked} structure={structure}
            onCell={setCell} onStudent={setStudentId} onEditItem={(item) => setDialog({ item })} onDeleteItem={(item) => setDialog({ remove: item })} base={base} />
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-faint">
          <span><kbd className="rounded border border-line px-1">Enter</kbd> / arrows move between cells</span>
          <span>Type <strong className="text-soft">M</strong> for missing, <strong className="text-soft">EX</strong> for exempt, empty for not graded yet</span>
          <span className="flex items-center gap-1"><ClipboardList className="size-3.5" aria-hidden="true" />/<FileQuestion className="size-3.5" aria-hidden="true" /> columns are scored in the assignment or quiz</span>
        </div>
      </Card>

      {!readOnly && structure.valid && (
        <Card className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <h3 className="text-[15px] font-semibold text-ink">End of the semester</h3>
            <p className="mt-0.5 text-sm text-soft">Submitting final grades locks every score and shows students their final grade. It can be reopened with a reason.</p>
          </div>
          <Button variant="secondary" icon={Lock} onClick={() => setDialog('finalize')}>Submit final grades</Button>
        </Card>
      )}

      {/* Unsaved changes bar */}
      {dirtyCount > 0 && (
        <div className="sticky bottom-4 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-pop" role="status">
          <p className="text-sm font-medium text-ink">{plural(dirtyCount, 'unsaved change')}</p>
          <Button variant="ghost" size="sm" icon={Undo2} onClick={() => setDirty({})}>Discard</Button>
          <Button size="sm" icon={Save} loading={save.isPending} onClick={() => save.mutate(false)}>Save grades</Button>
        </div>
      )}

      {dialog?.item !== undefined && <ItemDialog item={dialog.item} period={period} structure={structure} invalidate={invalidate} onClose={() => setDialog(null)} />}
      {studentId && <StudentDialog studentId={studentId} structure={structure} invalidate={invalidate} readOnly={readOnly} onClose={() => setStudentId(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => removeItem.mutate(dialog.remove.id)} loading={removeItem.isPending} title={`Delete the column “${dialog?.remove?.title}”?`} confirmLabel="Delete column">
        All scores in this column are deleted and grades are recomputed.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'publish'} onClose={() => setDialog(null)} onConfirm={() => periodAction.mutate({ action: 'publish' })} loading={periodAction.isPending} tone="primary" title={`Publish ${period.name} grades?`} confirmLabel="Publish">
        Students will see their {period.name} grade and the scores behind it, and are notified. You can keep editing scores until you lock the period.
      </ConfirmDialog>
      <NoteDialog open={dialog === 'unlock'} title={`Unlock ${period.name}?`} label="Reason for unlocking" confirmLabel="Unlock" loading={periodAction.isPending} onClose={() => setDialog(null)} onConfirm={(note) => periodAction.mutate({ action: 'unlock', note })}>
        Unlocking lets scores change again. The reason is kept in the release log.
      </NoteDialog>
      {dialog === 'finalize' && <FinalizeDialog invalidate={invalidate} onClose={() => setDialog(null)} />}
      {dialog === 'reopen' && <ReopenDialog invalidate={invalidate} onClose={() => setDialog(null)} />}
      <Modal open={Boolean(reasonPrompt)} onClose={() => setReasonPrompt(null)} title="A reason is needed" size="sm" footer={<><Button variant="secondary" onClick={() => setReasonPrompt(null)}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 5} onClick={() => save.mutate(true)}>Save grades</Button></>}>
        <Alert tone="info" className="mb-4">{reasonPrompt}</Alert>
        <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-autofocus /></Field>
      </Modal>
    </div>
  );
}

function GridTable({ period, items, students, dirty, locked, onCell, onStudent, onEditItem, onDeleteItem, base }) {
  const table = useRef(null);
  const focusCell = (row, col) => table.current?.querySelector(`[data-cell="${row}:${col}"]`)?.focus();
  const editable = items.map((item) => item.source === 'MANUAL');

  return (
    <div className="overflow-x-auto" ref={table}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className="sticky left-0 z-20 min-w-[11rem] border-b border-r border-line bg-raised px-4 py-2 text-left align-bottom text-xs font-semibold uppercase tracking-wide text-faint">Student</th>
            {period.categories.map((c) => c.items.length > 0 && (
              <th key={c.id} scope="colgroup" colSpan={c.items.length} className="border-b border-r border-line bg-raised px-3 py-1.5 text-center text-xs font-semibold text-soft">
                {c.name} <span className="font-normal text-faint">· {c.weight}%</span>
              </th>
            ))}
            {items.length === 0 && <th scope="col" rowSpan={2} className="border-b border-line bg-raised px-4 py-2 text-left text-xs font-normal text-faint">No columns yet. Add a column, or link an assignment or quiz to a category of this period.</th>}
            <th scope="col" rowSpan={2} className="border-b border-r border-line bg-raised px-3 py-2 text-right align-bottom text-xs font-semibold uppercase tracking-wide text-faint">{period.name}</th>
            <th scope="col" rowSpan={2} className="border-b border-line bg-raised px-3 py-2 text-right align-bottom text-xs font-semibold uppercase tracking-wide text-faint">Overall</th>
          </tr>
          <tr>
            {items.map((item) => (
              <th key={item.id} scope="col" className="group min-w-[5.5rem] max-w-[9rem] border-b border-r border-line bg-surface px-2 py-1.5 text-left align-bottom">
                <span className="flex items-start gap-1">
                  {item.source === 'ASSIGNMENT' ? <ClipboardList className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="Assignment" /> : item.source === 'QUIZ' ? <FileQuestion className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="Quiz" /> : null}
                  <span className="min-w-0 flex-1">
                    {item.source === 'MANUAL'
                      ? <span className="line-clamp-2 text-xs font-semibold leading-tight text-ink" title={item.title}>{item.title}</span>
                      : <Link to={item.source === 'QUIZ' ? `${base}/quizzes/${item.quizId}/results` : `${base}/assignments/${item.assignmentId}/submissions`} className="line-clamp-2 text-xs font-semibold leading-tight text-ink hover:text-brand hover:underline" title={`${item.title} — open to grade`}>{item.title}</Link>}
                    <span className="block text-[11px] font-normal text-faint">out of {formatScore(item.maxPoints)}</span>
                  </span>
                  {item.source === 'MANUAL' && !locked && (
                    <Menu trigger={({ toggle, props }) => <button type="button" onClick={toggle} {...props} className="rounded p-0.5 text-faint opacity-60 hover:bg-raised hover:text-ink group-hover:opacity-100" aria-label={`Column options for ${item.title}`}><MoreHorizontal className="size-3.5" /></button>}>
                      <MenuItem icon={Pencil} onClick={() => onEditItem(item)}>Edit column</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => onDeleteItem(item)}>Delete column</MenuItem>
                    </Menu>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {students.map((s, row) => {
            const p = s.periods[period.id];
            return (
              <tr key={s.id} className="group/row">
                <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface px-4 py-1.5 text-left font-medium group-hover/row:bg-raised">
                  <button type="button" onClick={() => onStudent(s.id)} className="max-w-[13rem] truncate text-left text-ink hover:text-brand hover:underline" title="Show how this grade is computed">{s.lastName}, {s.firstName}</button>
                  {s.missingCount > 0 && <span className="ml-1.5 text-[11px] font-normal text-bad">{s.missingCount} missing</span>}
                </th>
                {items.map((item, col) => (
                  <td key={item.id} className="border-b border-r border-line p-0 text-center">
                    <Cell item={item} entry={s.entries[item.id]} draft={dirty[cellKey(s.id, item.id)]} locked={locked} name={s.name}
                      dataCell={`${row}:${col}`} onChange={(v) => onCell(s.id, item, v)}
                      onMove={(dr, dc) => { let c = col + dc; while (dc !== 0 && c >= 0 && c < items.length && !editable[c]) c += dc; focusCell(row + dr, dc === 0 ? col : c); }} />
                  </td>
                ))}
                {items.length === 0 && <td className="border-b border-line" />}
                <td className="border-b border-r border-line px-3 py-1.5 text-right"><GradeValue g={p} /></td>
                <td className="border-b border-line px-3 py-1.5 text-right"><GradeValue g={s.overall} strong /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GradeValue({ g, strong }) {
  if (!g || g.percent === null) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap tabular-nums" title={g.isOverridden ? `Adjusted by the teacher (computed ${formatPercent(g.computedPercent)}): ${g.overrideReason ?? ''}` : g.isComplete ? undefined : 'Some work is not graded yet'}>
      <span className={cn(strong ? 'font-bold' : 'font-semibold', g.isPassing === false ? 'text-bad' : 'text-ink')}>{formatPercent(g.percent, 2)}</span>
      {g.label && <span className="text-xs text-faint">{g.label}</span>}
      {g.isOverridden && <span className="text-[10px] font-bold text-warn" aria-label="Adjusted">ADJ</span>}
    </span>
  );
}

/** One score cell. Manual columns are typed into; linked columns show the score from the assignment or quiz. */
function Cell({ item, entry, draft, locked, name, dataCell, onChange, onMove }) {
  const current = draft ?? { status: entry?.status ?? 'UNGRADED', score: entry?.score ?? null };
  const display = current.status === 'GRADED' ? formatScore(current.score) : current.status === 'MISSING' ? 'M' : current.status === 'EXEMPT' ? 'EX' : '';
  const [text, setText] = useState(display);
  const [shown, setShown] = useState(display);
  if (shown !== display) { setShown(display); setText(display); }
  const [invalid, setInvalid] = useState(false);
  const manual = item.source === 'MANUAL';

  const commit = () => {
    const value = text.trim().toUpperCase();
    setInvalid(false);
    if (value === '') return onChange({ status: 'UNGRADED', score: null });
    if (value === 'M' || value === 'MISSING') return onChange({ status: 'MISSING', score: null });
    if (value === 'EX' || value === 'E' || value === 'EXEMPT') return onChange({ status: 'EXEMPT', score: null });
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > item.maxPoints) { setInvalid(true); return undefined; }
    return onChange({ status: 'GRADED', score: Math.round(n * 100) / 100 });
  };

  if (!manual || locked) {
    const tone = current.status === 'MISSING' ? 'text-bad font-semibold' : current.status === 'EXEMPT' ? 'text-info font-semibold' : current.status === 'GRADED' ? 'text-ink' : 'text-faint';
    // A linked column can still be exempted for one student (for example after an excused absence).
    if (!manual && !locked) {
      return (
        <Menu align="left" trigger={({ toggle, props }) => (
          <button type="button" onClick={toggle} {...props} className={cn('h-9 w-full px-2 tabular-nums hover:bg-raised', tone, draft && 'bg-brand-soft')} aria-label={`${name}, ${item.title}: ${display || 'not graded'}`}>
            {display || '—'}{entry?.isLate && current.status === 'GRADED' ? <span className="ml-0.5 text-[10px] font-bold text-warn" title="Submitted late">L</span> : null}
          </button>
        )}>
          {current.status === 'EXEMPT'
            ? <MenuItem onClick={() => onChange({ status: 'UNGRADED', score: null })}>Remove the exemption</MenuItem>
            : <MenuItem onClick={() => onChange({ status: 'EXEMPT', score: null })}>Exempt this student</MenuItem>}
        </Menu>
      );
    }
    return <span className={cn('block px-2 py-2 tabular-nums', tone)}>{display || '—'}</span>;
  }
  return (
    <input
      data-cell={dataCell}
      value={text}
      onChange={(e) => { setText(e.target.value); setInvalid(false); }}
      onBlur={commit}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); commit(); onMove(1, 0); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); commit(); onMove(-1, 0); }
        else if (e.key === 'ArrowRight' && e.target.selectionStart === text.length) { commit(); onMove(0, 1); }
        else if (e.key === 'ArrowLeft' && e.target.selectionEnd === 0) { commit(); onMove(0, -1); }
        else if (e.key === 'Escape') { setText(display); setInvalid(false); }
      }}
      inputMode="decimal"
      autoComplete="off"
      aria-label={`${name}, ${item.title}, out of ${item.maxPoints}`}
      aria-invalid={invalid || undefined}
      title={invalid ? `Enter a number from 0 to ${item.maxPoints}, M, or EX` : undefined}
      className={cn('h-9 w-full min-w-[4.5rem] bg-transparent px-2 text-center tabular-nums outline-none focus:bg-surface focus:ring-2 focus:ring-inset focus:ring-brand',
        invalid ? 'bg-bad-soft text-bad ring-2 ring-inset ring-bad' : draft ? 'bg-brand-soft font-semibold text-brand' : current.status === 'MISSING' ? 'font-semibold text-bad' : current.status === 'EXEMPT' ? 'font-semibold text-info' : 'text-ink hover:bg-raised')}
    />
  );
}

function ItemDialog({ item, period, structure, invalidate, onClose }) {
  const { base } = useClass();
  const [v, setV] = useState({ categoryId: item?.category?.id ?? period.categories[0]?.id ?? '', title: item?.title ?? '', maxPoints: item?.maxPoints ?? 100, dueAt: item?.dueAt ?? null });
  const [errors, setErrors] = useState({});
  const save = useAction(() => {
    const body = { categoryId: v.categoryId, title: v.title.trim(), maxPoints: Number(v.maxPoints), dueAt: v.dueAt };
    return item ? api.patch(`${base}/gradebook/items/${item.id}`, body) : api.post(`${base}/gradebook/items`, body);
  }, { invalidate, success: item ? 'Column saved.' : 'Column added.', onSuccess: onClose, onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; } });
  return (
    <Modal open onClose={onClose} title={item ? 'Edit column' : 'Add a column'} size="sm" description="For work scored outside EduSphere — recitation, a paper quiz, a project defence."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.title.trim() || !v.categoryId} onClick={() => save.mutate()}>{item ? 'Save' : 'Add column'}</Button></>}>
      <div className="space-y-4">
        <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. Recitation 2" maxLength={200} /></Field>
        <Field label="Category" error={errors.categoryId}>
          <Select value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })}>
            {structure.periods.map((p) => <optgroup key={p.id} label={`${p.name}${p.lockedAt ? ' (locked)' : ''}`}>{p.categories.filter((c) => c.kind !== 'ATTENDANCE').map((c) => <option key={c.id} value={c.id} disabled={Boolean(p.lockedAt)}>{c.name} ({c.weight}%)</option>)}</optgroup>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Points" error={errors.maxPoints}><Input type="number" min="1" max="10000" step="any" value={v.maxPoints} onChange={(e) => setV({ ...v, maxPoints: e.target.value })} /></Field>
          <Field label="Date" optional error={errors.dueAt}><Input type="datetime-local" value={toLocalInput(v.dueAt)} onChange={(e) => setV({ ...v, dueAt: fromLocalInput(e.target.value) })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function NoteDialog({ open, title, label, confirmLabel, loading, onClose, onConfirm, children }) {
  const [note, setNote] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={note.trim().length < 5} onClick={() => onConfirm(note.trim())}>{confirmLabel}</Button></>}>
      <p className="mb-4 text-sm text-soft">{children}</p>
      <Field label={label}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-autofocus /></Field>
    </Modal>
  );
}

function FinalizeDialog({ invalidate, onClose }) {
  const { base } = useClass();
  const [incomplete, setIncomplete] = useState(null);
  const [error, setError] = useState(null);
  const finalize = useAction((confirmIncomplete) => api.post(`${base}/gradebook/finalize`, { confirmIncomplete }), {
    invalidate: [...invalidate, ['class']], success: 'Final grades submitted. Students can now see their final grade.', onSuccess: onClose,
    onError: (err) => { if (err.code === 'INCOMPLETE_GRADES') { setIncomplete(err.details); return true; } setError(err.message); return true; },
  });
  return (
    <Modal open onClose={onClose} title="Submit final grades?" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Lock} loading={finalize.isPending} onClick={() => finalize.mutate(Boolean(incomplete))}>{incomplete ? 'Submit anyway' : 'Submit final grades'}</Button></>}>
      {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
      {incomplete ? (
        <Alert tone="warn" title={`${plural(incomplete.count, 'student')} still ${incomplete.count === 1 ? 'has' : 'have'} work that is not graded`}>
          <p>{incomplete.students.join(', ')}{incomplete.count > incomplete.students.length ? '…' : ''}</p>
          <p className="mt-1">Ungraded work is left out of their grade. Grade it first, or submit anyway.</p>
        </Alert>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-soft">
          <li>Every score in this class is locked.</li>
          <li>Students see their final grade for the course.</li>
          <li>Changing a grade afterwards means reopening the class with a written reason, which is recorded in the audit log.</li>
        </ul>
      )}
    </Modal>
  );
}

function ReopenDialog({ invalidate, onClose }) {
  const { base } = useClass();
  const [reason, setReason] = useState('');
  const reopen = useAction(() => api.post(`${base}/gradebook/reopen`, { reason: reason.trim() }), { invalidate: [...invalidate, ['class']], success: 'Final grades reopened.', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Reopen final grades?" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={reopen.isPending} disabled={reason.trim().length < 5} onClick={() => reopen.mutate()}>Reopen</Button></>}>
      <p className="mb-4 text-sm text-soft">Students stop seeing a final grade until you submit again. The reason is recorded.</p>
      <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Correcting an encoding error in the final exam" data-autofocus /></Field>
    </Modal>
  );
}

/** How one student's grade is computed, with the history of changes and a way to adjust the result. */
function StudentDialog({ studentId, structure, invalidate, readOnly, onClose }) {
  const { cls, base } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'student', studentId], queryFn: () => api.get(`${base}/gradebook/students/${studentId}`) });
  const [adjust, setAdjust] = useState(null);
  const removeOverride = useAction((id) => api.delete(`${base}/gradebook/overrides/${id}`), { invalidate, success: 'Adjustment removed. The computed grade applies again.' });
  return (
    <Modal open onClose={onClose} size="xl" title={query.data ? query.data.student.name : 'Student grades'} description={query.data ? [query.data.student.studentNumber, query.data.student.email].filter(Boolean).join(' · ') : null} footer={<Button onClick={onClose}>Close</Button>}>
      <QueryState query={query}>
        {(d) => (
          <div className="space-y-5">
            <StudentGrades data={d} teacher />
            {d.overrides.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-ink">Adjustments</h3>
                <ul className="space-y-2">
                  {d.overrides.map((o) => (
                    <li key={o.id} className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm', o.revokedAt ? 'border-line opacity-70' : 'border-warn/40 bg-warn-soft')}>
                      <span className="min-w-0 flex-1">
                        <strong className={cn('text-ink', o.revokedAt && 'line-through')}>{o.scopeName} set to {formatPercent(o.overridePercent, 2)}</strong> <span className="text-soft">(computed {formatPercent(o.computedPercent, 2)}) — {o.reason}</span>
                        <span className="block text-xs text-faint">{o.by} · {formatDateTime(o.createdAt)}{o.revokedAt ? ` · removed ${formatDateTime(o.revokedAt)}` : ''}</span>
                      </span>
                      {!readOnly && !o.revokedAt && <Button size="sm" variant="ghost" onClick={() => removeOverride.mutate(o.id)}>Remove</Button>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!readOnly && <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setAdjust({ scope: 'OVERALL', percent: '', reason: '' })}>Adjust a computed grade…</Button>}
            {d.history.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-ink">History of changes</h3>
                <ul className="divide-y divide-line text-[13px]">
                  {d.history.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                      <span className="font-medium text-ink">{h.item}</span>
                      <span className="text-soft tabular-nums">{h.oldScore ?? (h.oldStatus ? h.oldStatus.toLowerCase() : '—')} → {h.newScore ?? h.newStatus?.toLowerCase()}</span>
                      {h.reason && <span className="text-faint">“{h.reason}”</span>}
                      <span className="ml-auto text-xs text-faint">{h.by} · {relativeTime(h.at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </QueryState>
      {adjust && <AdjustDialog studentId={studentId} structure={structure} invalidate={invalidate} onClose={() => setAdjust(null)} />}
    </Modal>
  );
}

function AdjustDialog({ studentId, structure, invalidate, onClose }) {
  const { base } = useClass();
  const [v, setV] = useState({ scope: 'OVERALL', percent: '', reason: '' });
  const [errors, setErrors] = useState({});
  const save = useAction(() => api.post(`${base}/gradebook/overrides`, { studentId, scope: v.scope, percent: Number(v.percent), reason: v.reason.trim() }), {
    invalidate, success: 'Grade adjusted.', onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  return (
    <Modal open onClose={onClose} title="Adjust a computed grade" size="sm" description="Use this only for decisions outside the formula. The computed grade stays on record next to your adjustment."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={v.percent === '' || v.reason.trim().length < 5} onClick={() => save.mutate()}>Save adjustment</Button></>}>
      <div className="space-y-4">
        <Field label="Which grade" error={errors.scope}>
          <Select value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value })}>
            <option value="OVERALL">Overall grade</option>
            {structure.periods.map((p) => <option key={p.id} value={p.id} disabled={Boolean(p.lockedAt)}>{p.name}{p.lockedAt ? ' (locked)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Set to (percent)" error={errors.percent}><Input type="number" min="0" max="100" step="0.01" value={v.percent} onChange={(e) => setV({ ...v, percent: e.target.value })} /></Field>
        <Field label="Reason" error={errors.reason} hint="Required. Shown in the audit log."><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
