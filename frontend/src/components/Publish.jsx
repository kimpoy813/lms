// Draft / scheduled / published — the same rules apply to modules, assignments, quizzes and announcements.
import { CalendarClock, CheckCircle2, PencilLine } from 'lucide-react';
import { formatDateTime, fromLocalInput, toLocalInput } from '../lib/format.js';
import { Badge, Field, Input, Segmented } from './ui.jsx';

export function StatusBadge({ status, publishAt }) {
  if (status === 'PUBLISHED') return <Badge tone="ok" icon={CheckCircle2}>Published</Badge>;
  if (status === 'SCHEDULED') return <Badge tone="info" icon={CalendarClock}>Scheduled{publishAt ? ` · ${formatDateTime(publishAt)}` : ''}</Badge>;
  if (status === 'ARCHIVED') return <Badge>Archived</Badge>;
  if (status === 'CLOSED') return <Badge>Closed</Badge>;
  return <Badge tone="warn" icon={PencilLine}>Draft</Badge>;
}

/** Controls for { status, publishAt }. Students only see published items. */
export function PublishFields({ status, publishAt, onChange, error, noun = 'item' }) {
  return (
    <fieldset className="rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-medium text-ink">Visibility</legend>
      <Segmented label="Visibility" value={status} onChange={(s) => onChange({ status: s, publishAt: s === 'SCHEDULED' ? publishAt : null })}
        options={[{ value: 'DRAFT', label: 'Draft' }, { value: 'SCHEDULED', label: 'Schedule' }, { value: 'PUBLISHED', label: 'Published' }]} />
      <p className="mt-2 text-[13px] text-faint">
        {status === 'DRAFT' && `Only you can see this ${noun}. Publish it when it is ready.`}
        {status === 'SCHEDULED' && `Students will see this ${noun} from the date and time below.`}
        {status === 'PUBLISHED' && `Students can see this ${noun} as soon as you save.`}
      </p>
      {status === 'SCHEDULED' && (
        <Field label="Publish on" className="mt-3" error={error}>
          <Input type="datetime-local" value={toLocalInput(publishAt)} onChange={(e) => onChange({ status, publishAt: fromLocalInput(e.target.value) })} className="max-w-xs" />
        </Field>
      )}
    </fieldset>
  );
}
