// Create or edit an assignment.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FileUpload } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { PublishFields } from '../../components/Publish.jsx';
import { Alert, Button, Field, Input, Modal, ModalActions, PageLoader, Select, Switch } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fromLocalInput, toLocalInput } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { useClass } from './useClass.js';

const blank = {
  title: '', instructionsHtml: '', points: 100, status: 'DRAFT', publishAt: null, availableFrom: null, dueAt: null, closeAt: null,
  allowLate: true, latePenaltyType: 'NONE', latePenaltyValue: 0, latePenaltyMax: 100, allowText: true, allowFiles: true, maxFiles: 5, allowResubmission: true,
  rubricId: '', moduleId: '', categoryId: '', files: [],
};

export default function AssignmentDialog({ assignmentId, onClose }) {
  const { cls, base } = useClass();
  const navigate = useNavigate();
  const existing = useQuery({ queryKey: ['class', cls.id, 'assignment', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}`), enabled: Boolean(assignmentId) });
  const loading = Boolean(assignmentId) && existing.isPending;
  return (
    <Modal open onClose={onClose} title={assignmentId ? 'Edit assignment' : 'New assignment'} size="xl">
      {loading ? <PageLoader /> : (
        <Form key={assignmentId ?? 'new'} existing={existing.data} onCancel={onClose} onSaved={(saved) => { onClose(); if (!assignmentId) navigate(`${base}/assignments/${saved.id}`); }} />
      )}
    </Modal>
  );
}

function Form({ existing, onSaved, onCancel }) {
  const { cls, base } = useClass();
  const modules = useQuery({ queryKey: ['class', cls.id, 'modules'], queryFn: () => api.get(`${base}/modules`) });
  const categories = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'categories'], queryFn: () => api.get(`${base}/gradebook/categories`) });
  const rubrics = useQuery({ queryKey: ['rubrics'], queryFn: () => api.get('/rubrics') });
  const [v, setV] = useState(() => existing ? {
    ...blank, ...existing, rubricId: existing.rubric?.id ?? '', moduleId: existing.module?.id ?? '', categoryId: existing.gradeCategory?.id ?? '', files: existing.attachments ?? [],
  } : blank);
  const [errors, setErrors] = useState({});
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));

  const save = useAction(() => {
    const body = {
      title: v.title.trim(), instructionsHtml: v.instructionsHtml, points: Number(v.points), status: v.status, publishAt: v.publishAt,
      availableFrom: v.availableFrom, dueAt: v.dueAt, closeAt: v.closeAt, allowLate: v.allowLate,
      latePenaltyType: v.allowLate ? v.latePenaltyType : 'NONE', latePenaltyValue: Number(v.latePenaltyValue) || 0, latePenaltyMax: Number(v.latePenaltyMax) || 100,
      allowText: v.allowText, allowFiles: v.allowFiles, maxFiles: Number(v.maxFiles) || 1, allowResubmission: v.allowResubmission,
      rubricId: v.rubricId || null, moduleId: v.moduleId || null, categoryId: v.categoryId || null, fileIds: v.files.map((f) => f.id),
    };
    return existing ? api.patch(`/assignments/${existing.id}`, body) : api.post(`${base}/assignments`, body);
  }, {
    invalidate: [['class', cls.id], ['dashboard'], ['calendar']],
    success: existing ? 'Assignment saved.' : 'Assignment created.',
    onSuccess: onSaved,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  const rubric = (rubrics.data ?? []).find((r) => r.id === v.rubricId);
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form id="assignment-form" onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-5">
      {hasErrors && <Alert tone="bad">Please check the highlighted fields.</Alert>}
      {existing?.programmingProblemId && <Alert tone="info">This assignment is linked to a coding problem. Students submit code, which is checked by the code runner.</Alert>}
      <Field label="Title" required error={errors.title}><Input value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required placeholder="e.g. Activity 3: Flowchart of a Daily Routine" /></Field>
      <Field label="Instructions" error={errors.instructionsHtml}>
        <LazyEditor value={v.instructionsHtml} onChange={(html) => set('instructionsHtml', html)} placeholder="What should students do, and how will it be graded?" minHeight={170} ariaLabel="Instructions" />
      </Field>
      <Field label="Files for students" optional hint="Worksheets, templates or reading materials.">
        <FileUpload value={v.files} onChange={(files) => set('files', files)} max={10} compact label="Attach files" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Points" required error={errors.points}><Input type="number" min="0" max="10000" step="any" value={v.points} onChange={(e) => set('points', e.target.value)} disabled={Boolean(rubric)} /></Field>
        <Field label="Due" optional error={errors.dueAt}><Input type="datetime-local" value={toLocalInput(v.dueAt)} onChange={(e) => set('dueAt', fromLocalInput(e.target.value))} /></Field>
        <Field label="Opens" optional error={errors.availableFrom} hint="Empty = as soon as it is published."><Input type="datetime-local" value={toLocalInput(v.availableFrom)} onChange={(e) => set('availableFrom', fromLocalInput(e.target.value))} /></Field>
      </div>
      {rubric && <p className="-mt-3 text-[13px] text-faint">Points follow the rubric: {rubric.totalPoints}.</p>}

      <fieldset className="space-y-4 rounded-xl border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">Late work</legend>
        <Switch checked={v.allowLate} onChange={(on) => set('allowLate', on)} label="Accept submissions after the due date" />
        {v.allowLate && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Penalty" error={errors.latePenaltyType}>
              <Select value={v.latePenaltyType} onChange={(e) => set('latePenaltyType', e.target.value)}>
                <option value="NONE">No penalty</option>
                <option value="PERCENT_PER_DAY">Percent per day late</option>
                <option value="PERCENT_FLAT">One-time percent</option>
              </Select>
            </Field>
            {v.latePenaltyType !== 'NONE' && <Field label={v.latePenaltyType === 'PERCENT_PER_DAY' ? 'Percent per day' : 'Percent deducted'} error={errors.latePenaltyValue}><Input type="number" min="0" max="100" step="any" value={v.latePenaltyValue} onChange={(e) => set('latePenaltyValue', e.target.value)} /></Field>}
            {v.latePenaltyType === 'PERCENT_PER_DAY' && <Field label="Maximum deduction (%)" error={errors.latePenaltyMax}><Input type="number" min="0" max="100" step="any" value={v.latePenaltyMax} onChange={(e) => set('latePenaltyMax', e.target.value)} /></Field>}
            <Field label="Stop accepting work on" optional error={errors.closeAt} className={v.latePenaltyType === 'NONE' ? 'sm:col-span-2' : ''}><Input type="datetime-local" value={toLocalInput(v.closeAt)} onChange={(e) => set('closeAt', fromLocalInput(e.target.value))} /></Field>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-4 rounded-xl border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">What students hand in</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Switch checked={v.allowText} onChange={(on) => set('allowText', on)} label="Typed answer" description="Students write directly in EduSphere." />
          <Switch checked={v.allowFiles} onChange={(on) => set('allowFiles', on)} label="File uploads" description="Documents, pictures or a ZIP file." />
        </div>
        {!v.allowText && !v.allowFiles && <p className="text-[13px] text-warn">With both switched off, students cannot hand in anything online — use this for work collected in class.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {v.allowFiles && <Field label="Maximum number of files" error={errors.maxFiles}><Input type="number" min="1" max="10" value={v.maxFiles} onChange={(e) => set('maxFiles', e.target.value)} /></Field>}
          <Switch checked={v.allowResubmission} onChange={(on) => set('allowResubmission', on)} label="Allow resubmission" description="Students may replace their work until it is graded." className="self-center" />
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Counts toward" optional error={errors.categoryId} hint="Adds a column to the gradebook.">
          <Select value={v.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Not graded in the gradebook</option>
            {(categories.data ?? []).map((p) => (
              <optgroup key={p.id} label={`${p.name}${p.locked ? ' (locked)' : ''}`}>
                {p.categories.map((c) => <option key={c.id} value={c.id} disabled={p.locked}>{c.name} ({c.weight}%)</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Rubric" optional error={errors.rubricId}>
          <Select value={v.rubricId} onChange={(e) => set('rubricId', e.target.value)}>
            <option value="">No rubric</option>
            {(rubrics.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.title} ({r.totalPoints} pts)</option>)}
          </Select>
        </Field>
        <Field label="Module" optional error={errors.moduleId}>
          <Select value={v.moduleId} onChange={(e) => set('moduleId', e.target.value)}>
            <option value="">None</option>
            {(modules.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </Select>
        </Field>
      </div>

      <PublishFields status={v.status} publishAt={v.publishAt} onChange={(p) => setV((s) => ({ ...s, ...p }))} error={errors.publishAt} noun="assignment" />
      <ModalActions>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={save.isPending}>{existing ? 'Save changes' : 'Create assignment'}</Button>
      </ModalActions>
    </form>
  );
}
