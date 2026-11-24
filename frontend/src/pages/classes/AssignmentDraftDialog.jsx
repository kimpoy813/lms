import { ClipboardList } from 'lucide-react';
import { useMemo, useState } from 'react';
import LazyEditor from '../../components/LazyEditor.jsx';
import { Alert, Button, Checkbox, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useAction } from '../../lib/query.js';
import { classLabel } from './useClass.js';
import { activityInstructionsHtml, extractRubricFromHtml, starterActivityRubric } from './assignmentDraft.js';

export default function AssignmentDraftDialog({
  source,
  sourceNumber,
  moduleTitle,
  classes,
  defaultClassId,
  moduleId,
  moduleClassId,
  sourceLabel = 'activity',
  onClose,
  onCreated,
}) {
  const [classId, setClassId] = useState(defaultClassId ?? '');
  const [title, setTitle] = useState(source.title?.trim() || `${moduleTitle || 'Module'} ${sourceLabel} ${sourceNumber}`);
  const [instructions, setInstructions] = useState(source.instructionsHtml ?? source.instructions ?? '');
  const hasRichInstructions = typeof source.instructionsHtml === 'string';
  const activityRubric = useMemo(
    () => extractRubricFromHtml(source.instructionsHtml, source.title?.trim() || title),
    [source.instructionsHtml, source.title, title],
  );
  const activityRubricPoints = activityRubric
    ? Math.round(activityRubric.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0) * 100) / 100
    : null;
  const [points, setPoints] = useState(() => String(activityRubricPoints ?? 100));
  const [includeRubric, setIncludeRubric] = useState(true);
  const [error, setError] = useState(null);
  const numberOfPoints = activityRubric && includeRubric ? activityRubricPoints : Number(points);
  const minimumPoints = includeRubric && !activityRubric ? 4 : 1;
  const maximumPoints = activityRubric ? 10_000 : 1000;
  const validPoints = activityRubric
    ? Number.isFinite(numberOfPoints) && numberOfPoints >= minimumPoints && numberOfPoints <= maximumPoints
    : Number.isSafeInteger(numberOfPoints) && numberOfPoints >= minimumPoints && numberOfPoints <= maximumPoints;

  const create = useAction(async () => {
    const rubricBody = includeRubric ? activityRubric ?? starterActivityRubric(title, numberOfPoints) : null;
    let rubric = null;
    if (rubricBody) rubric = await api.post('/rubrics', rubricBody);
    try {
      return await api.post(`/classes/${classId}/assignments`, {
        title: title.trim(),
        instructionsHtml: hasRichInstructions ? instructions : activityInstructionsHtml(instructions),
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
      ? activityRubric
        ? 'Draft assignment and activity rubric created. Neither is published.'
        : 'Draft assignment and starter rubric created. Neither is published.'
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
      title={`Create an assignment from this ${sourceLabel}`}
      description={`The ${sourceLabel} becomes a separate assignment. You can review and edit it before publishing.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={ClipboardList} loading={create.isPending} disabled={disabled} onClick={() => { setError(null); create.mutate(); }}>{includeRubric ? 'Create assignment and rubric' : 'Create assignment draft'}</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        <Alert tone="info" title="Draft assignment · not in the gradebook">
          Students will not see it until you publish it, and it will not be linked to a gradebook category by default. You can still score submissions with a rubric or manually, then add a gradebook category later if you want it counted. {includeRubric
            ? activityRubric
              ? <>The rubric found in this lesson ({activityRubric.criteria.length} {activityRubric.criteria.length === 1 ? 'criterion' : 'criteria'}, {activityRubricPoints} points) will be attached and added to your Rubrics list.</>
              : 'The editable starter rubric will be attached to the assignment and added to your Rubrics list.'
            : 'No rubric will be attached. You can add one to the draft assignment later.'}
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
        <Field label="Instructions" hint={`The ${sourceLabel} content is copied here. Edit it for the assignment if needed.`}>
          {hasRichInstructions
            ? <LazyEditor value={instructions} onChange={setInstructions} placeholder="What should students do?" minHeight={170} ariaLabel="Assignment instructions" />
            : <Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={3000} />}
        </Field>
        <Field
          label="Total points"
          hint={activityRubric && includeRubric
            ? 'The total follows the rubric found in the lesson.'
            : includeRubric
              ? 'At least 4 points are needed for the four-criterion starter rubric.'
              : undefined}
        >
          <Input
            type="number"
            min={minimumPoints}
            max={maximumPoints}
            step={activityRubric ? 'any' : '1'}
            value={activityRubric && includeRubric ? activityRubricPoints : points}
            onChange={(e) => setPoints(e.target.value)}
            disabled={Boolean(activityRubric && includeRubric)}
          />
        </Field>
        <Checkbox
          checked={includeRubric}
          onChange={(e) => setIncludeRubric(e.target.checked)}
          label={activityRubric ? 'Attach the lesson rubric' : 'Attach a four-criterion starter rubric'}
          description={!includeRubric
            ? 'No rubric will be attached to this assignment.'
            : activityRubric
              ? 'The rubric table in this lesson will be imported, added to your Rubrics list, and linked to the assignment.'
              : 'It is editable, appears in Rubrics, and will be attached to this assignment. Review it before use.'}
        />
      </div>
    </Modal>
  );
}
