import { ClipboardList } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useAction } from '../../lib/query.js';
import { classLabel } from '../classes/useClass.js';
import { activityInstructionsHtml, starterActivityRubric } from './activityAssignment.js';

export default function ActivityAssignmentDialog({
  activity,
  activityNumber,
  moduleTitle,
  classes,
  defaultClassId,
  moduleId,
  moduleClassId,
  onClose,
  onCreated,
}) {
  const [classId, setClassId] = useState(defaultClassId ?? '');
  const [title, setTitle] = useState(activity.title?.trim() || `${moduleTitle || 'Module'} activity ${activityNumber}`);
  const [instructions, setInstructions] = useState(activity.instructions ?? '');
  const [points, setPoints] = useState('100');
  const [includeRubric, setIncludeRubric] = useState(true);
  const [error, setError] = useState(null);
  const numberOfPoints = Number(points);
  const minimumPoints = includeRubric ? 4 : 1;
  const validPoints = Number.isSafeInteger(numberOfPoints) && numberOfPoints >= minimumPoints && numberOfPoints <= 1000;

  const create = useAction(async () => {
    const rubricBody = includeRubric ? starterActivityRubric(title, numberOfPoints) : null;
    let rubric = null;
    if (rubricBody) rubric = await api.post('/rubrics', rubricBody);
    try {
      return await api.post(`/classes/${classId}/assignments`, {
        title: title.trim(),
        instructionsHtml: activityInstructionsHtml(instructions),
        points: rubric?.totalPoints ?? numberOfPoints,
        status: 'DRAFT',
        rubricId: rubric?.id ?? null,
        ...(moduleId && moduleClassId === classId ? { moduleId } : {}),
      });
    } catch (err) {
      // Avoid leaving an unused rubric behind if assignment creation fails.
      if (rubric?.id) await api.delete(`/rubrics/${rubric.id}`).catch(() => {});
      throw err;
    }
  }, {
    invalidate: [['rubrics'], ['class', classId], ['dashboard'], ['calendar']],
    success: includeRubric
      ? 'Draft assignment and starter rubric created. Neither is published.'
      : 'Draft assignment created. It is not published.',
    onSuccess: (assignment) => onCreated?.(assignment, classId, includeRubric),
    onError: (err) => {
      setError(err.fields ? Object.values(err.fields).filter(Boolean).join(' ') : err.message);
      return true;
    },
  });

  const disabled = !classes.length || !classId || !title.trim() || !instructions.trim() || !validPoints;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Create an assignment from this activity"
      description="The activity becomes a separate assignment. You can review and edit it before publishing."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={ClipboardList} loading={create.isPending} disabled={disabled} onClick={() => { setError(null); create.mutate(); }}>{includeRubric ? 'Create assignment and rubric' : 'Create assignment draft'}</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        <Alert tone="info" title="Saved as a draft">
          The assignment will not be shown to students until you publish it. The editable starter rubric will be attached to the assignment and added to your Rubrics list.
        </Alert>
        {classes.length === 0
          ? <Alert tone="warn">There are no active classes to add this assignment to.</Alert>
          : (
            <Field label="Add assignment to class">
              <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">Choose a class…</option>
                {classes.map((cls) => <option key={cls.id} value={cls.id}>{classLabel(cls)}</option>)}
              </Select>
            </Field>
          )}
        <Field label="Assignment title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Instructions" hint="The activity text is copied here. Edit it for the assignment if needed.">
          <Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={3000} />
        </Field>
        <Field label="Total points" hint={includeRubric ? 'At least 4 points are needed for the four-criterion rubric.' : undefined}>
          <Input type="number" min={minimumPoints} max="1000" step="1" value={points} onChange={(e) => setPoints(e.target.value)} />
        </Field>
        <Checkbox
          checked={includeRubric}
          onChange={(e) => setIncludeRubric(e.target.checked)}
          label="Attach a four-criterion starter rubric"
          description="It is editable, appears in Rubrics, and will be attached to this assignment. Review it before use."
        />
      </div>
    </Modal>
  );
}
