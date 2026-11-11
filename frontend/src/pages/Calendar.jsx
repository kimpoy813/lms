// Calendar: class meetings, deadlines, consultations and events in one month view, with a
// personal to-do list beside it.
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, ClipboardList, Clock, FileQuestion, MapPin, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Badge, Button, Card, CardHeader, Checkbox, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dateKeyOf, formatDateKey, formatTime, fromLocalInput, relativeTime, toLocalInput } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { classColor } from './classes/classColors.js';
import { classLabel } from './classes/useClass.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** Add days to a YYYY-MM-DD key (pure calendar arithmetic, no time zones involved). */
const addDays = (key, days) => {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};
const weekdayOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

const KIND = {
  CLASS_MEETING: { label: 'Class', icon: Users },
  ASSIGNMENT_DUE: { label: 'Assignment due', icon: ClipboardList },
  QUIZ_CLOSES: { label: 'Quiz closes', icon: FileQuestion },
  CONSULTATION: { label: 'Consultation', icon: Users },
  EVENT: { label: 'Event', icon: CalendarDays },
};
const EVENT_TYPES = { OTHER: 'Other', CLASS_ACTIVITY: 'Class activity', EXAM: 'Examination', HOLIDAY: 'Holiday / no classes', INSTITUTIONAL: 'School event', CONSULTATION: 'Consultation' };

const chipTone = (item) => {
  if (item.type === 'HOLIDAY') return 'bg-bad-soft text-bad';
  if (item.kind === 'ASSIGNMENT_DUE' || item.kind === 'QUIZ_CLOSES') return 'bg-warn-soft text-warn';
  if (item.kind === 'CONSULTATION') return 'bg-info-soft text-info';
  if (item.color) return classColor(item.color).soft;
  return item.scope === 'PERSONAL' ? 'bg-raised text-soft' : 'bg-brand-soft text-brand';
};

export default function Calendar() {
  const { isStudent, isAdmin } = useAuth();
  const today = dateKeyOf(new Date());
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [dialog, setDialog] = useState(null);
  const [showMeetings, setShowMeetings] = useState(true);

  // The grid always starts on a Sunday and covers whole weeks.
  const grid = useMemo(() => {
    const first = `${month}-01`;
    const start = addDays(first, -weekdayOf(first));
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const weeks = Math.ceil((weekdayOf(first) + daysInMonth) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [month]);

  const range = { from: fromLocalInput(`${grid[0]}T00:00`), to: fromLocalInput(`${grid.at(-1)}T23:59`) };
  const query = useQuery({ queryKey: ['calendar', range.from, range.to], queryFn: () => api.get('/calendar', range), placeholderData: (prev) => prev });

  // Put every item on each day it covers.
  const byDay = useMemo(() => {
    const map = new Map();
    for (const item of query.data ?? []) {
      if (!showMeetings && item.kind === 'CLASS_MEETING') continue;
      const first = dateKeyOf(item.startAt);
      // An all-day event ending at midnight belongs to the previous day.
      const last = dateKeyOf(new Date(Math.max(new Date(item.startAt).getTime(), new Date(item.endAt).getTime() - (item.allDay ? 1 : 0))));
      for (let key = first, n = 0; key <= last && n < 62; key = addDays(key, 1), n += 1) map.set(key, [...(map.get(key) ?? []), item]);
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || new Date(a.startAt) - new Date(b.startAt));
    return map;
  }, [query.data, showMeetings]);

  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    const next = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    setMonth(next);
    setSelected(next === today.slice(0, 7) ? today : `${next}-01`);
  };
  const monthLabel = new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  const dayItems = byDay.get(selected) ?? [];

  return (
    <>
      <PageHeader title="Calendar" description="Class meetings, deadlines and events — shown in school time."
        actions={<Button icon={CalendarPlus} onClick={() => setDialog({ event: null })}>New event</Button>} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card padded={false} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="mr-auto text-lg font-semibold text-ink" aria-live="polite">{monthLabel}</h2>
            {query.isFetching && <Spinner className="size-4" />}
            <label className="mr-2 flex items-center gap-2 text-[13px] text-soft"><input type="checkbox" checked={showMeetings} onChange={(e) => setShowMeetings(e.target.checked)} className="size-4 accent-[var(--brand-fill)]" />Class meetings</label>
            <Button variant="secondary" size="sm" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>Today</Button>
            <IconButton icon={ChevronLeft} size="sm" variant="secondary" label="Previous month" onClick={() => shift(-1)} />
            <IconButton icon={ChevronRight} size="sm" variant="secondary" label="Next month" onClick={() => shift(1)} />
          </div>
          <div role="grid" aria-label={monthLabel}>
            <div role="row" className="grid grid-cols-7 border-b border-line bg-raised/60 text-center text-[11px] font-semibold uppercase tracking-wide text-faint">
              {WEEKDAYS.map((d) => <div key={d} role="columnheader" className="py-2">{d}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {grid.map((key) => {
                const items = byDay.get(key) ?? [];
                const inMonth = key.startsWith(month);
                const isToday = key === today;
                const holiday = items.some((i) => i.type === 'HOLIDAY');
                return (
                  <button key={key} type="button" role="gridcell" aria-selected={key === selected} aria-label={`${formatDateKey(key)}, ${items.length} item${items.length === 1 ? '' : 's'}`} onClick={() => setSelected(key)}
                    className={cn('flex min-h-[4.5rem] flex-col gap-1 border-b border-r border-line p-1.5 text-left transition-colors sm:min-h-[6.5rem] [&:nth-child(7n)]:border-r-0', key === selected ? 'bg-brand-soft/60 ring-2 ring-inset ring-brand' : 'hover:bg-raised', !inMonth && 'bg-raised/40', holiday && inMonth && key !== selected && 'bg-bad-soft/40')}>
                    <span className={cn('grid size-6 place-items-center rounded-full text-xs font-semibold tabular-nums', isToday ? 'bg-brand-fill text-white' : inMonth ? 'text-ink' : 'text-faint')}>{Number(key.slice(8))}</span>
                    {/* Chips on larger screens, dots on phones. */}
                    <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                      {items.slice(0, 3).map((item) => <span key={item.id} className={cn('truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-tight', chipTone(item))}>{!item.allDay && item.kind !== 'ASSIGNMENT_DUE' && item.kind !== 'QUIZ_CLOSES' ? `${formatTime(item.startAt).replace(':00', '').replace(' ', '').toLowerCase()} ` : ''}{item.kind === 'CLASS_MEETING' ? item.classLabel : item.title}</span>)}
                      {items.length > 3 && <span className="px-1.5 text-[11px] font-medium text-faint">+{items.length - 3} more</span>}
                    </span>
                    <span className="flex flex-wrap gap-0.5 sm:hidden">{items.slice(0, 4).map((item) => <span key={item.id} className={cn('size-1.5 rounded-full bg-current', chipTone(item).split(' ').find((c) => c.startsWith('text-')))} />)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title={formatDateKey(selected)} description={selected === today ? 'Today' : relativeTime(fromLocalInput(`${selected}T12:00`)).replace(/^in /, 'In ')} action={<IconButton icon={Plus} size="sm" variant="soft" label="Add an event on this day" onClick={() => setDialog({ event: null, day: selected })} />} />
            {dayItems.length === 0 ? <EmptyState compact icon={CalendarDays} title="Nothing scheduled" /> : (
              <ul className="space-y-2">
                {dayItems.map((item) => <li key={item.id}><DayItem item={item} onEdit={() => setDialog({ event: item })} onDelete={() => setDialog({ remove: item })} /></li>)}
              </ul>
            )}
          </Card>
          <Tasks />
        </div>
      </div>
      {dialog?.event !== undefined && <EventDialog event={dialog.event} day={dialog.day} canInstitution={isAdmin} canClass={!isStudent} onClose={() => setDialog(null)} />}
      {dialog?.remove && <DeleteEvent event={dialog.remove} onClose={() => setDialog(null)} />}
    </>
  );
}

function DayItem({ item, onEdit, onDelete }) {
  const meta = KIND[item.kind] ?? KIND.EVENT;
  const body = (
    <>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', chipTone(item))}><meta.icon className="size-[18px]" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{item.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-faint">
          <span className="flex items-center gap-1"><Clock className="size-3" aria-hidden="true" />{item.allDay ? 'All day' : item.kind === 'ASSIGNMENT_DUE' || item.kind === 'QUIZ_CLOSES' ? formatTime(item.startAt) : `${formatTime(item.startAt)} – ${formatTime(item.endAt)}`}</span>
          {item.location && <span className="flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{item.location}</span>}
          {item.classLabel && item.kind !== 'CLASS_MEETING' && <span>{item.classLabel}</span>}
          {item.kind === 'CLASS_MEETING' && <span>{item.classLabel}</span>}
          {item.scope === 'PERSONAL' && <span>Only you</span>}
          {item.scope === 'INSTITUTION' && <span>Whole school</span>}
          {item.draft && <Badge tone="warn">Draft</Badge>}
        </span>
        {item.description && <span className="mt-1 block text-[13px] text-soft">{item.description}</span>}
      </span>
    </>
  );
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line p-2.5">
      {item.link ? <Link to={item.link} className="flex min-w-0 flex-1 items-start gap-3 hover:opacity-80">{body}</Link> : <div className="flex min-w-0 flex-1 items-start gap-3">{body}</div>}
      {item.canEdit && (
        <span className="flex shrink-0">
          <IconButton icon={Pencil} size="sm" label={`Edit ${item.title}`} onClick={onEdit} />
          <IconButton icon={Trash2} size="sm" variant="dangerGhost" label={`Delete ${item.title}`} onClick={onDelete} />
        </span>
      )}
    </div>
  );
}

function DeleteEvent({ event, onClose }) {
  const remove = useAction(() => api.delete(`/calendar/events/${event.eventId}`), { invalidate: [['calendar']], success: 'Event deleted.', onSuccess: onClose });
  return <ConfirmDialog open onClose={onClose} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${event.title}”?`} confirmLabel="Delete event">{event.scope === 'PERSONAL' ? 'This event is only on your calendar.' : 'It disappears from everyone’s calendar.'}</ConfirmDialog>;
}

function EventDialog({ event, day, canInstitution, canClass, onClose }) {
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }), enabled: canClass && !event });
  const base = day ?? dateKeyOf(new Date());
  const [v, setV] = useState(() => ({
    scope: event?.scope ?? 'PERSONAL', classId: event?.classId ?? '', type: event?.type ?? 'OTHER', title: event?.title ?? '', description: event?.description ?? '', location: event?.location ?? '',
    startAt: event?.startAt ?? fromLocalInput(`${base}T09:00`), endAt: event?.endAt ?? fromLocalInput(`${base}T10:00`), allDay: event?.allDay ?? false,
  }));
  const [errors, setErrors] = useState({});
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));
  const save = useAction(() => {
    // All-day events run from midnight to midnight of the following day, in school time.
    const startAt = v.allDay ? fromLocalInput(`${toLocalInput(v.startAt).slice(0, 10)}T00:00`) : v.startAt;
    const endAt = v.allDay ? fromLocalInput(`${toLocalInput(v.endAt).slice(0, 10)}T23:59`) : v.endAt;
    const body = { type: v.type, title: v.title.trim(), description: v.description.trim() || null, location: v.location.trim() || null, startAt, endAt, allDay: v.allDay };
    return event ? api.patch(`/calendar/events/${event.eventId}`, body) : api.post('/calendar/events', { ...body, scope: v.scope, classId: v.scope === 'CLASS' ? v.classId : null });
  }, {
    invalidate: [['calendar'], ['dashboard']], success: event ? 'Event saved.' : 'Event added.', onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  const scopes = [{ value: 'PERSONAL', label: 'Only me' }, ...(canClass ? [{ value: 'CLASS', label: 'A class' }] : []), ...(canInstitution ? [{ value: 'INSTITUTION', label: 'Whole school' }] : [])];
  return (
    <Modal open onClose={onClose} title={event ? 'Edit event' : 'New event'} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.title.trim() || (v.scope === 'CLASS' && !v.classId)} onClick={() => { setErrors({}); save.mutate(); }}>{event ? 'Save' : 'Add event'}</Button></>}>
      <div className="space-y-4">
        {!event && scopes.length > 1 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Who sees it" error={errors.scope}><Select value={v.scope} onChange={(e) => set('scope', e.target.value)}>{scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
            {v.scope === 'CLASS' && <Field label="Class" error={errors.classId}><Select value={v.classId} onChange={(e) => set('classId', e.target.value)}><option value="">Choose…</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>}
          </div>
        )}
        <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={200} data-autofocus /></Field>
        <Checkbox checked={v.allDay} onChange={(e) => set('allDay', e.target.checked)} label="All day" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" error={errors.startAt}>{v.allDay ? <Input type="date" value={toLocalInput(v.startAt).slice(0, 10)} onChange={(e) => set('startAt', fromLocalInput(`${e.target.value}T00:00`))} /> : <Input type="datetime-local" value={toLocalInput(v.startAt)} onChange={(e) => set('startAt', fromLocalInput(e.target.value))} />}</Field>
          <Field label="Ends" error={errors.endAt}>{v.allDay ? <Input type="date" value={toLocalInput(v.endAt).slice(0, 10)} onChange={(e) => set('endAt', fromLocalInput(`${e.target.value}T23:59`))} /> : <Input type="datetime-local" value={toLocalInput(v.endAt)} onChange={(e) => set('endAt', fromLocalInput(e.target.value))} />}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" error={errors.type}><Select value={v.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(EVENT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Place" optional error={errors.location}><Input value={v.location} onChange={(e) => set('location', e.target.value)} maxLength={200} /></Field>
        </div>
        <Field label="Notes" optional error={errors.description}><Textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}

function Tasks() {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const query = useQuery({ queryKey: ['tasks'], queryFn: () => api.get('/tasks') });
  const invalidate = [['tasks']];
  const add = useAction(() => api.post('/tasks', { title: title.trim(), dueAt: due ? fromLocalInput(`${due}T23:59`) : null }), { invalidate, onSuccess: () => { setTitle(''); setDue(''); } });
  const toggle = useAction((t) => api.patch(`/tasks/${t.id}`, { completed: !t.completedAt }), { invalidate });
  const remove = useAction((id) => api.delete(`/tasks/${id}`), { invalidate });
  const tasks = query.data ?? [];
  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);
  return (
    <Card>
      <CardHeader icon={Check} title="My to-do list" description="Private reminders. Only you can see them." />
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }} className="mb-3 flex flex-wrap gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a reminder…" aria-label="New reminder" maxLength={200} className="min-w-0 flex-1 basis-40" />
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date (optional)" className="w-36" />
        <Button type="submit" icon={Plus} loading={add.isPending} disabled={!title.trim()} aria-label="Add reminder" />
      </form>
      {query.isPending ? <Spinner /> : tasks.length === 0 ? <p className="py-3 text-center text-sm text-faint">Nothing on your list.</p> : (
        <ul className="space-y-1">
          {[...open, ...done].map((t) => {
            const overdue = !t.completedAt && t.dueAt && new Date(t.dueAt) < new Date();
            return (
              <li key={t.id} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-raised">
                <input type="checkbox" checked={Boolean(t.completedAt)} onChange={() => toggle.mutate(t)} aria-label={`Mark “${t.title}” as ${t.completedAt ? 'not done' : 'done'}`} className="size-[18px] shrink-0 rounded accent-[var(--brand-fill)]" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', t.completedAt ? 'text-faint line-through' : 'text-ink')}>{t.title}</span>
                  {t.dueAt && !t.completedAt && <span className={cn('text-xs', overdue ? 'font-medium text-bad' : 'text-faint')}>{overdue ? 'Was due' : 'Due'} {formatDateKey(dateKeyOf(t.dueAt))}</span>}
                </span>
                <button type="button" onClick={() => remove.mutate(t.id)} className="rounded p-1 text-faint opacity-0 hover:text-bad focus:opacity-100 group-hover:opacity-100" aria-label={`Delete “${t.title}”`}><Trash2 className="size-4" /></button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
