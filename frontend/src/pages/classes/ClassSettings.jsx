// Class settings (teacher and administrator): details, schedule, joining, privacy, syllabus, archive.
import { Archive, ArchiveRestore, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { Alert, Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Input, Switch, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useAction } from '../../lib/query.js';
import { ColorPicker, ScheduleEditor } from './Classes.jsx';
import { useClass } from './useClass.js';

export default function ClassSettings() {
  const { cls, canManage } = useClass();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const archived = cls.status === 'ARCHIVED';
  const [values, setValues] = useState(() => ({
    description: cls.description ?? '', room: cls.room ?? '', color: cls.color,
    schedules: cls.schedules.map(({ dayOfWeek, startTime, endTime, room }) => ({ dayOfWeek, startTime, endTime, room })),
    enrollmentCodeEnabled: cls.enrollmentCodeEnabled, enrollmentRequiresApproval: cls.enrollmentRequiresApproval, classmatesVisible: cls.classmatesVisible,
    syllabusHtml: cls.syllabusHtml ?? '', learningOutcomes: cls.learningOutcomes ?? [],
  }));
  const [errors, setErrors] = useState({});
  const [confirm, setConfirm] = useState(null);
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  const invalidate = [['class', cls.id], ['classes'], ['dashboard']];

  const save = useAction(() => api.patch(`/classes/${cls.id}`, {
    ...values,
    description: values.description.trim() || null,
    room: values.room.trim() || null,
    learningOutcomes: values.learningOutcomes.map((o) => o.trim()).filter(Boolean),
    schedules: values.schedules.map((s) => ({ ...s, room: s.room ?? null })),
  }), {
    invalidate, success: 'Class settings saved.',
    onSuccess: () => setErrors({}),
    onError: (err) => { if (err.fields) { setErrors(err.fields); } return false; },
  });
  const regenerate = useAction(() => api.post(`/classes/${cls.id}/enrollment-code/regenerate`), { invalidate, success: 'A new class code was created. The old code no longer works.', onSuccess: () => setConfirm(null) });
  const archive = useAction(() => api.post(`/classes/${cls.id}/${archived ? 'restore' : 'archive'}`), { invalidate, success: archived ? 'Class restored.' : 'Class archived.', onSuccess: () => setConfirm(null) });
  const remove = useAction(() => api.delete(`/classes/${cls.id}`), { invalidate: [['classes'], ['dashboard']], success: 'Class deleted.', onSuccess: () => navigate('/classes', { replace: true }) });

  if (!canManage) return <EmptyState title="Only the teacher can change class settings" />;
  const scheduleError = Object.entries(errors).find(([k]) => k.startsWith('schedules'))?.[1];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {archived && <Alert tone="warn" title="This class is archived">Restore it below before changing its settings.</Alert>}
      <fieldset disabled={archived} className="space-y-5">
        <Card>
          <CardHeader title="Details" />
          <div className="space-y-4">
            <Field label="Description" optional error={errors.description}><Textarea rows={3} value={values.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Room" optional error={errors.room}><Input value={values.room} onChange={(e) => set('room', e.target.value)} placeholder="Room 204" /></Field>
              <Field label="Colour"><ColorPicker value={values.color} onChange={(c) => set('color', c)} /></Field>
            </div>
            <ScheduleEditor value={values.schedules} onChange={(s) => set('schedules', s)} />
            {scheduleError && <p className="text-[13px] text-bad" role="alert">{scheduleError}</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Joining and privacy" />
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-raised p-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-faint">Class code</p>
                <code className="font-mono text-xl font-bold tracking-[0.2em] text-ink">{cls.enrollmentCode}</code>
              </div>
              <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => setConfirm('code')}>New code</Button>
            </div>
            <Switch checked={values.enrollmentCodeEnabled} onChange={(on) => set('enrollmentCodeEnabled', on)} label="Students can join with the class code" description="Switch this off once everyone has joined." />
            <Switch checked={values.enrollmentRequiresApproval} onChange={(on) => set('enrollmentRequiresApproval', on)} label="Approve students before they join" description="Students who enter the code wait in People until you approve them." />
            <Switch checked={values.classmatesVisible} onChange={(on) => set('classmatesVisible', on)} label="Students can see who their classmates are" description="Only names are shown. Grades, attendance and contact details are never shared between students." />
          </div>
        </Card>

        <Card>
          <CardHeader title="Syllabus and learning outcomes" description="Shown on the class overview." />
          <div className="space-y-4">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink">Learning outcomes</legend>
              <ul className="space-y-2">
                {values.learningOutcomes.map((o, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Input value={o} onChange={(e) => set('learningOutcomes', values.learningOutcomes.map((x, n) => (n === i ? e.target.value : x)))} aria-label={`Learning outcome ${i + 1}`} maxLength={300} />
                    <Button variant="ghost" size="sm" icon={X} aria-label="Remove this outcome" onClick={() => set('learningOutcomes', values.learningOutcomes.filter((_, n) => n !== i))} />
                  </li>
                ))}
              </ul>
              <Button variant="secondary" size="sm" icon={Plus} className="mt-2" onClick={() => set('learningOutcomes', [...values.learningOutcomes, ''])} disabled={values.learningOutcomes.length >= 20}>Add an outcome</Button>
              {errors.learningOutcomes && <p className="mt-1.5 text-[13px] text-bad">{errors.learningOutcomes}</p>}
            </fieldset>
            <Field label="Syllabus" error={errors.syllabusHtml}>
              <LazyEditor value={values.syllabusHtml} onChange={(html) => set('syllabusHtml', html)} placeholder="Course description, topics per week, grading system, class policies…" minHeight={220} ariaLabel="Syllabus" />
            </Field>
          </div>
        </Card>

        <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-canvas from-70% px-1 pb-2 pt-6">
          <Button icon={Save} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </div>
      </fieldset>

      <Card className="border-bad/25">
        <CardHeader title={archived ? 'Restore or delete' : 'Archive this class'} description={archived ? 'Restoring makes the class active again.' : 'At the end of the semester, archive the class. Its records stay available but nothing can be changed.'} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={archived ? ArchiveRestore : Archive} onClick={() => setConfirm('archive')}>{archived ? 'Restore class' : 'Archive class'}</Button>
          {isAdmin && <Button variant="dangerGhost" icon={Trash2} onClick={() => setConfirm('delete')}>Delete class</Button>}
        </div>
      </Card>

      <ConfirmDialog open={confirm === 'code'} onClose={() => setConfirm(null)} onConfirm={() => regenerate.mutate()} loading={regenerate.isPending} title="Create a new class code?" confirmLabel="Create new code" tone="primary">
        The current code stops working immediately. Students who already joined are not affected.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'archive'} onClose={() => setConfirm(null)} onConfirm={() => archive.mutate()} loading={archive.isPending} title={archived ? 'Restore this class?' : 'Archive this class?'} confirmLabel={archived ? 'Restore' : 'Archive'} tone={archived ? 'primary' : 'danger'}>
        {archived ? 'The class becomes active again and can be edited.' : 'Students and teachers can still open the class and its records, but nothing can be added or changed until it is restored.'}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete this class?" confirmLabel="Delete class">
        A class can only be deleted while it has no students, submissions, attendance or grades. Otherwise archive it instead — academic records must be kept.
      </ConfirmDialog>
    </div>
  );
}
