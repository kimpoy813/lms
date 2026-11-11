// Lessons tab: the class's modules, each with its lessons and resources.
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BookOpen, CheckCircle2, ChevronDown, Circle, Copy, FilePlus2, FolderPlus, Lock, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PublishFields, StatusBadge } from '../../components/Publish.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ProgressBar, QueryState, Select, Table, Td, Textarea, Th, Tr } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, fromLocalInput, plural, toLocalInput } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { ResourceDialog, ResourceItem } from './ResourceParts.jsx';
import { useClass } from './useClass.js';

export const LESSON_KINDS = { LESSON: 'Lesson', ACTIVITY: 'Activity', ASSESSMENT: 'Assessment', SUMMARY: 'Summary', REFERENCE: 'Reference' };

export default function Modules() {
  const { cls, canManage, base } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'modules'], queryFn: () => api.get(`${base}/modules`) });
  const [dialog, setDialog] = useState(null); // { type: 'module'|'progress'|'resource', module? }
  const readOnly = cls.status === 'ARCHIVED';

  const reorder = useAction((ids) => api.put(`${base}/modules/order`, { ids }), { invalidate: [['class', cls.id, 'modules']] });
  const move = (list, index, delta) => {
    const ids = list.map((m) => m.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    reorder.mutate(ids);
  };

  return (
    <>
      {canManage && (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" icon={Users} onClick={() => setDialog({ type: 'progress' })}>Student progress</Button>
          <Button variant="secondary" icon={Sparkles} to="/ai">Draft with AI</Button>
          <Button icon={FolderPlus} onClick={() => setDialog({ type: 'module' })} disabled={readOnly}>New module</Button>
        </div>
      )}
      <QueryState query={query}>
        {(modules) => modules.length === 0 ? (
          <Card>
            <EmptyState icon={BookOpen} title={canManage ? 'No modules yet' : 'No lessons have been posted yet'}
              description={canManage ? 'A module groups related lessons — for example one per week or per topic.' : 'Your teacher will add lessons here.'}
              action={canManage && !readOnly ? <Button icon={FolderPlus} onClick={() => setDialog({ type: 'module' })}>Create the first module</Button> : null} />
          </Card>
        ) : (
          <ol className="space-y-4">
            {modules.map((m, i) => (
              <li key={m.id}>
                <ModuleCard module={m} modules={modules} index={i} onMove={(delta) => move(modules, i, delta)} onEdit={() => setDialog({ type: 'module', module: m })} onAddResource={() => setDialog({ type: 'resource', module: m })} readOnly={readOnly} />
              </li>
            ))}
          </ol>
        )}
      </QueryState>
      {dialog?.type === 'module' && <ModuleDialog module={dialog.module} modules={query.data ?? []} onClose={() => setDialog(null)} />}
      {dialog?.type === 'resource' && <ResourceDialog classId={cls.id} placement={{ moduleId: dialog.module.id }} modules={query.data ?? []} onClose={() => setDialog(null)} />}
      {dialog?.type === 'progress' && <ProgressDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function ModuleCard({ module: m, modules, index, onMove, onEdit, onAddResource, readOnly }) {
  const { cls, canManage, base } = useClass();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [confirm, setConfirm] = useState(null);
  const invalidate = [['class', cls.id, 'modules'], ['dashboard']];
  const remove = useAction(() => api.delete(`/modules/${m.id}`), { invalidate, success: 'Module deleted.', onSuccess: () => setConfirm(null) });
  const publish = useAction(() => api.patch(`/modules/${m.id}`, { status: 'PUBLISHED' }), { invalidate, success: 'Module published. Students have been notified.' });
  const copy = useAction(() => api.post(`/modules/${m.id}/copy`, {}), { invalidate, success: 'A draft copy was added to this class.' });
  const reorderLessons = useAction((ids) => api.put(`/modules/${m.id}/lessons/order`, { ids }), { invalidate });
  const moveLesson = (i, delta) => {
    const ids = m.lessons.map((l) => l.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + delta, 0, id);
    reorderLessons.mutate(ids);
  };
  const locked = !canManage && m.locked;

  return (
    <Card padded={false} className={cn(locked && 'opacity-80')}>
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? 'Collapse module' : 'Expand module'} className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg text-soft hover:bg-raised">
          <ChevronDown className={cn('size-5 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{m.title}</h2>
            {canManage && <StatusBadge status={m.status} publishAt={m.publishAt} />}
            {canManage && m.source === 'AI' && <Badge tone="brand" icon={Sparkles}>AI draft{m.aiReviewStatus === 'APPROVED' ? ' · reviewed' : ''}</Badge>}
            {locked && <Badge icon={Lock}>Locked</Badge>}
            {!canManage && !locked && m.lessonCount > 0 && m.progressPercent === 100 && <Badge tone="ok" icon={CheckCircle2}>Completed</Badge>}
          </div>
          {m.description && <p className="mt-1 text-sm text-soft">{m.description}</p>}
          {locked && <p className="mt-1 text-[13px] text-warn">{m.lockedReason}</p>}
          <p className="mt-1.5 text-xs text-faint">
            {plural(m.lessonCount, 'lesson')}{m.resources.length > 0 ? ` · ${plural(m.resources.length, 'resource')}` : ''}{m.availableUntil ? ` · available until ${formatDateTime(m.availableUntil)}` : ''}
          </p>
          {!canManage && !locked && m.lessonCount > 0 && (
            <div className="mt-2.5 flex max-w-sm items-center gap-3 text-xs text-faint">
              <ProgressBar value={m.progressPercent} tone={m.progressPercent === 100 ? 'ok' : 'brand'} label={`Progress in ${m.title}`} className="h-1.5" />
              <span className="shrink-0 tabular-nums">{m.completedLessons}/{m.lessonCount}</span>
            </div>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            {m.status === 'DRAFT' && !readOnly && <Button size="sm" variant="soft" loading={publish.isPending} onClick={() => publish.mutate()} className="max-sm:hidden">Publish</Button>}
            <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label={`Actions for ${m.title}`} onClick={toggle} {...props} />}>
              <MenuItem icon={Pencil} onClick={onEdit}>Edit module</MenuItem>
              <MenuItem icon={FilePlus2} onClick={() => navigate(`${base}/modules/${m.id}?new=1`)}>Add a lesson</MenuItem>
              <MenuItem icon={Plus} onClick={onAddResource}>Add a resource</MenuItem>
              {m.status === 'DRAFT' && <MenuItem icon={CheckCircle2} onClick={() => publish.mutate()}>Publish</MenuItem>}
              {index > 0 && <MenuItem icon={ArrowUp} onClick={() => onMove(-1)}>Move up</MenuItem>}
              {index < modules.length - 1 && <MenuItem icon={ArrowDown} onClick={() => onMove(1)}>Move down</MenuItem>}
              <MenuItem icon={Copy} onClick={() => copy.mutate()}>Duplicate as draft</MenuItem>
              <MenuItem icon={Trash2} tone="danger" onClick={() => setConfirm('delete')}>Delete module</MenuItem>
            </Menu>
          </div>
        )}
      </div>

      {open && !locked && (
        <div className="border-t border-line px-4 pb-4 pt-2 sm:px-5">
          {m.lessons.length === 0 ? (
            <p className="py-3 text-sm text-faint">{canManage ? 'This module has no lessons yet.' : 'No lessons yet.'}</p>
          ) : (
            <ol>
              {m.lessons.map((l, i) => {
                const lessonLocked = !canManage && l.locked;
                const row = (
                  <>
                    {canManage ? <span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised text-xs font-semibold text-soft tabular-nums">{i + 1}</span>
                      : l.completed ? <CheckCircle2 className="size-5 shrink-0 text-ok" aria-label="Completed" />
                        : lessonLocked ? <Lock className="size-5 shrink-0 text-faint" aria-label="Locked" /> : <Circle className="size-5 shrink-0 text-line-strong" aria-label="Not completed yet" />}
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm font-medium', lessonLocked ? 'text-faint' : 'text-ink')}>{l.title}</span>
                      <span className="block text-xs text-faint">{LESSON_KINDS[l.kind] ?? 'Lesson'}{l.estimatedMinutes ? ` · ${l.estimatedMinutes} min` : ''}{lessonLocked ? ' · finish the previous lesson first' : ''}</span>
                    </span>
                    {canManage && l.status === 'DRAFT' && <Badge tone="warn">Draft</Badge>}
                  </>
                );
                return (
                  <li key={l.id} className="flex items-center gap-1 border-b border-line last:border-b-0">
                    {lessonLocked
                      ? <div className="flex min-w-0 flex-1 items-center gap-3 px-1 py-2.5">{row}</div>
                      : <Link to={`${base}/modules/${m.id}?lesson=${l.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-2.5 hover:bg-raised">{row}</Link>}
                    {canManage && !readOnly && m.lessons.length > 1 && (
                      <span className="flex shrink-0">
                        <IconButton icon={ArrowUp} size="sm" label={`Move “${l.title}” up`} disabled={i === 0 || reorderLessons.isPending} onClick={() => moveLesson(i, -1)} />
                        <IconButton icon={ArrowDown} size="sm" label={`Move “${l.title}” down`} disabled={i === m.lessons.length - 1 || reorderLessons.isPending} onClick={() => moveLesson(i, 1)} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {m.resources.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-faint">Resources</h3>
              <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {m.resources.map((r) => <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} modules={modules} />)}
              </ul>
            </>
          )}
          {canManage && !readOnly && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={FilePlus2} to={`${base}/modules/${m.id}?new=1`}>Add a lesson</Button>
              <Button size="sm" variant="ghost" icon={Plus} onClick={onAddResource}>Add a resource</Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${m.title}”?`} confirmLabel="Delete module">
        The module and its {plural(m.lessonCount, 'lesson')} are removed for everyone. Assignments and quizzes linked to it are kept.
      </ConfirmDialog>
    </Card>
  );
}

function ModuleDialog({ module: m, modules, onClose }) {
  const { cls, base } = useClass();
  const navigate = useNavigate();
  const [values, setValues] = useState({
    title: m?.title ?? '', description: m?.description ?? '', objectives: m?.objectives ?? [],
    status: m?.status ?? 'DRAFT', publishAt: m?.publishAt ?? null, availableUntil: m?.availableUntil ?? null, prerequisiteModuleId: m?.prerequisiteModuleId ?? '',
  });
  const [errors, setErrors] = useState({});
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  const save = useAction(() => {
    const body = { ...values, title: values.title.trim(), description: values.description.trim() || null, objectives: values.objectives.map((o) => o.trim()).filter(Boolean), prerequisiteModuleId: values.prerequisiteModuleId || null };
    return m ? api.patch(`/modules/${m.id}`, body) : api.post(`${base}/modules`, body);
  }, {
    invalidate: [['class', cls.id, 'modules'], ['dashboard']],
    success: m ? 'Module saved.' : 'Module created.',
    onSuccess: (saved) => { onClose(); if (!m) navigate(`${base}/modules/${saved.id}?new=1`); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <Modal open onClose={onClose} title={m ? 'Edit module' : 'New module'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!values.title.trim()} onClick={() => save.mutate()}>{m ? 'Save' : 'Create and add a lesson'}</Button></>}>
      <div className="space-y-4">
        <Field label="Title" required error={errors.title}><Input value={values.title} onChange={(e) => set('title', e.target.value)} placeholder="Module 3 — Algorithms and Flowcharts" maxLength={200} /></Field>
        <Field label="Description" optional error={errors.description}><Textarea rows={2} value={values.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Learning objectives <span className="text-xs font-normal text-faint">optional</span></legend>
          <ul className="space-y-2">
            {values.objectives.map((o, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input value={o} onChange={(e) => set('objectives', values.objectives.map((x, n) => (n === i ? e.target.value : x)))} aria-label={`Objective ${i + 1}`} maxLength={300} />
                <Button variant="ghost" size="sm" icon={X} aria-label="Remove this objective" onClick={() => set('objectives', values.objectives.filter((_, n) => n !== i))} />
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" icon={Plus} className="mt-2" onClick={() => set('objectives', [...values.objectives, ''])}>Add an objective</Button>
        </fieldset>
        <PublishFields status={values.status} publishAt={values.publishAt} onChange={(p) => setValues((v) => ({ ...v, ...p }))} error={errors.publishAt} noun="module" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Unlocks after" optional error={errors.prerequisiteModuleId} hint="Students must finish that module first.">
            <Select value={values.prerequisiteModuleId} onChange={(e) => set('prerequisiteModuleId', e.target.value)}>
              <option value="">No prerequisite</option>
              {modules.filter((x) => x.id !== m?.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </Select>
          </Field>
          <Field label="Available until" optional error={errors.availableUntil} hint="Leave empty to keep it open.">
            <Input type="datetime-local" value={toLocalInput(values.availableUntil)} onChange={(e) => set('availableUntil', fromLocalInput(e.target.value))} />
          </Field>
        </div>
        {m?.source === 'AI' && <Alert tone="info">This module started as an AI draft. Check every lesson for accuracy before publishing it.</Alert>}
      </div>
    </Modal>
  );
}

function ProgressDialog({ onClose }) {
  const { cls, base } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'modules-progress'], queryFn: () => api.get(`${base}/modules-progress`) });
  return (
    <Modal open onClose={onClose} title="Student progress" description="Lessons each student has marked as completed (published modules only)." size="xl">
      <QueryState query={query}>
        {(data) => data.students.length === 0 || data.totalLessons === 0 ? <EmptyState compact icon={Users} title={data.totalLessons === 0 ? 'No published lessons yet' : 'No students yet'} /> : (
          <Table className="shadow-none">
            <thead>
              <tr>
                <Th>Student</Th>
                <Th className="w-48">Overall</Th>
                {data.modules.map((m) => <Th key={m.id} className="max-w-[10rem] truncate text-center" title={m.title}>{m.title.split(/[—:-]/)[0].trim().slice(0, 14)}</Th>)}
              </tr>
            </thead>
            <tbody>
              {data.students.map((s) => (
                <Tr key={s.id}>
                  <Td className="font-medium">{s.name}</Td>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <ProgressBar value={s.percent} tone={s.percent === 100 ? 'ok' : s.percent < 34 ? 'warn' : 'brand'} label={`${s.name} overall progress`} className="h-1.5" />
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-soft">{s.percent}%</span>
                    </div>
                  </Td>
                  {data.modules.map((m) => <Td key={m.id} className="text-center tabular-nums text-soft">{s.modules[m.id] ?? 0}/{m.lessonCount}</Td>)}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </Modal>
  );
}
