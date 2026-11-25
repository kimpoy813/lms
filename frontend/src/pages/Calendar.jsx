// Calendar: class meetings, deadlines, consultations and events in one month view, with a
// personal to-do list beside it.
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarDays, CalendarOff, CalendarPlus, Check, ChevronLeft, ChevronRight, ClipboardList, Clock, Download, FileQuestion, MapPin, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { toast } from '../components/toast.jsx';
import { Badge, Button, Card, CardHeader, Checkbox, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dateKeyOf, formatClock, formatDateKey, formatTime, fromLocalInput, plural, relativeTime, toLocalInput } from '../lib/format.js';
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
const validDateParam = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

const KIND = {
  CLASS_MEETING: { label: 'Class', icon: Users },
  ASSIGNMENT_DUE: { label: 'Assignment due', icon: ClipboardList },
  QUIZ_CLOSES: { label: 'Quiz closes', icon: FileQuestion },
  CONSULTATION: { label: 'Consultation', icon: Users },
  EVENT: { label: 'Event', icon: CalendarDays },
};
const EVENT_TYPES = {
  TEACHER_LEAVE: 'Leave / Sick / Unavailable',
  OTHER: 'Other',
  CLASS_ACTIVITY: 'Class activity',
  EXAM: 'Examination',
  HOLIDAY: 'Holiday / no classes',
  INSTITUTIONAL: 'School event',
  CONSULTATION: 'Consultation',
};

const chipTone = (item) => {
  if (item.type === 'HOLIDAY') return 'bg-bad-soft text-bad';
  if (item.type === 'TEACHER_LEAVE') return 'bg-warn-soft text-warn';
  if (item.kind === 'ASSIGNMENT_DUE' || item.kind === 'QUIZ_CLOSES') return 'bg-warn-soft text-warn';
  if (item.kind === 'CONSULTATION') return 'bg-info-soft text-info';
  if (item.color) return classColor(item.color).soft;
  return item.scope === 'PERSONAL' ? 'bg-raised text-soft' : 'bg-brand-soft text-brand';
};

export default function Calendar() {
  const { isStudent, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = dateKeyOf(new Date());
  const dateParam = validDateParam(params.get('date'));
  const initialDay = dateParam ?? today;
  const [month, setMonth] = useState(() => initialDay.slice(0, 7));
  const [selected, setSelected] = useState(initialDay);
  const [dialog, setDialog] = useState(() => (params.get('leave') === '1' && !isStudent ? { event: null, day: initialDay, initialScope: 'CLASSES', initialType: 'TEACHER_LEAVE' } : null));
  const [showMeetings, setShowMeetings] = useState(true);

  useEffect(() => {
    if (dateParam) {
      setMonth(dateParam.slice(0, 7));
      setSelected(dateParam);
    }
  }, [dateParam]);

  useEffect(() => {
    if (params.get('leave') === '1' && !isStudent) {
      setDialog({ event: null, day: selected, initialScope: 'CLASSES', initialType: 'TEACHER_LEAVE' });
      const next = new URLSearchParams(params);
      next.delete('leave');
      setParams(next, { replace: true });
    }
  }, [params, setParams, isStudent, selected]);

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
  const [exportingIcs, setExportingIcs] = useState(false);
  const exportIcs = async () => {
    setExportingIcs(true);
    try {
      await api.download('/calendar/export.ics', { from: range.from, to: range.to, includeMeetings: showMeetings ? 'true' : 'false' }, `discenda-${month}.ics`);
      toast.success('Calendar (.ics) downloaded.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExportingIcs(false);
    }
  };

  return (
    <>
      <PageHeader title="Calendar" description="Class meetings, deadlines and events — shown in school time."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Download} loading={exportingIcs} onClick={exportIcs}>Export .ics</Button>
            {!isStudent && (
              <Button variant="secondary" icon={CalendarOff} onClick={() => setDialog({ event: null, day: selected, initialScope: 'CLASSES', initialType: 'TEACHER_LEAVE' })}>
                Leave / Notice
              </Button>
            )}
            <Button icon={CalendarPlus} onClick={() => setDialog({ event: null })}>New event</Button>
          </div>
        } />
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
                    className={cn('flex min-h-[3.75rem] flex-col gap-1 border-b border-r border-line p-1.5 text-left transition-colors sm:min-h-[6.5rem] [&:nth-child(7n)]:border-r-0', key === selected ? 'bg-brand-soft/60 ring-2 ring-inset ring-brand' : 'hover:bg-raised', !inMonth && 'bg-raised/40', holiday && inMonth && key !== selected && 'bg-bad-soft/40')}>
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
      {dialog?.event !== undefined && (
        <EventDialog
          event={dialog.event}
          day={dialog.day}
          initialScope={dialog.initialScope}
          initialType={dialog.initialType}
          canInstitution={isAdmin}
          canClass={!isStudent}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.remove && <DeleteEvent event={dialog.remove} onClose={() => setDialog(null)} />}
    </>
  );
}

function DayItem({ item, onEdit, onDelete }) {
  const meta = KIND[item.kind] ?? KIND.EVENT;
  const Icon = item.type === 'TEACHER_LEAVE' ? CalendarOff : meta.icon;
  const body = (
    <>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', chipTone(item))}><Icon className="size-[18px]" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{item.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
          <span className="flex items-center gap-1"><Clock className="size-3" aria-hidden="true" />{item.allDay ? 'All day' : item.kind === 'ASSIGNMENT_DUE' || item.kind === 'QUIZ_CLOSES' ? formatTime(item.startAt) : `${formatTime(item.startAt)} – ${formatTime(item.endAt)}`}</span>
          {item.location && <span className="flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{item.location}</span>}
          {item.classLabel && <span>{item.classLabel}</span>}
          {item.scope === 'PERSONAL' && <span>Only you</span>}
          {item.scope === 'INSTITUTION' && <span>Whole school</span>}
          {item.type === 'TEACHER_LEAVE' && <Badge tone="warn">Teacher unavailable</Badge>}
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
  const remove = useAction(() => api.delete(`/calendar/events/${event.eventId}`), { invalidate: [['calendar'], ['dashboard'], ['notifications']], success: 'Event deleted.', onSuccess: onClose });
  const notifies = (event.scope === 'CLASS' || event.scope === 'CLASSES') && new Date(event.endAt) >= new Date();
  return (
    <ConfirmDialog open onClose={onClose} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${event.title}”?`} confirmLabel="Delete event">
      {event.scope === 'PERSONAL'
        ? 'This event is only on your calendar.'
        : notifies
          ? 'It disappears from everyone’s calendar and affected students will be notified.'
          : 'It disappears from everyone’s calendar.'}
    </ConfirmDialog>
  );
}

function formatHitSummary(hits) {
  if (!hits || hits.length === 0) return 'No scheduled meeting in this time';
  if (hits.length === 1) {
    return `${formatDateKey(hits[0].date)} · ${formatClock(hits[0].startTime)}–${formatClock(hits[0].endTime)}`;
  }
  return `${hits.length} meetings (${formatDateKey(hits[0].date)} – ${formatDateKey(hits.at(-1).date)})`;
}

function EventDialog({ event, day, initialScope, initialType, canInstitution, canClass, onClose }) {
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }), enabled: canClass && !event });
  const base = day ?? dateKeyOf(new Date());
  const defaultType = event?.type ?? initialType ?? 'OTHER';
  const defaultScope = event?.scope ?? initialScope ?? (defaultType === 'TEACHER_LEAVE' && canClass ? 'CLASSES' : 'PERSONAL');
  const [v, setV] = useState(() => ({
    scope: defaultScope,
    classId: event?.classId ?? '',
    type: defaultType,
    title: event?.title ?? '',
    description: event?.description ?? '',
    location: event?.location ?? '',
    startAt: event?.startAt ?? fromLocalInput(`${base}T09:00`),
    endAt: event?.endAt ?? fromLocalInput(`${base}T10:00`),
    allDay: event?.allDay ?? (defaultType === 'TEACHER_LEAVE'),
    notifyStudents: true,
  }));
  const [manualClassIds, setManualClassIds] = useState(() => (event?.scope === 'CLASSES' ? event.affectedClassIds ?? [] : null));
  const [showOtherClasses, setShowOtherClasses] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (name, value) => {
    setV((s) => {
      const next = { ...s, [name]: value };
      // Automatically switch personal default to affected classes if teacher picks Leave / Sick / Unavailable on a new event.
      if (!event && name === 'type' && value === 'TEACHER_LEAVE' && s.scope === 'PERSONAL' && canClass) {
        next.scope = 'CLASSES';
      }
      return next;
    });
  };

  const effectiveStart = v.allDay ? fromLocalInput(`${toLocalInput(v.startAt).slice(0, 10)}T00:00`) : v.startAt;
  const effectiveEnd = v.allDay ? fromLocalInput(`${toLocalInput(v.endAt).slice(0, 10)}T23:59`) : v.endAt;
  const validRange = Boolean(effectiveStart && effectiveEnd && new Date(effectiveEnd) >= new Date(effectiveStart));

  const overlaps = useQuery({
    queryKey: ['calendar', 'overlapping-classes', effectiveStart, effectiveEnd, v.allDay],
    queryFn: () => api.get('/calendar/overlapping-classes', {
      startAt: effectiveStart,
      endAt: effectiveEnd,
      allDay: v.allDay ? 'true' : 'false',
    }),
    enabled: canClass && v.scope === 'CLASSES' && validRange,
  });

  const matchedIds = useMemo(() => (overlaps.data?.overlapping ?? []).map((c) => c.classId), [overlaps.data]);
  const activeClassIds = manualClassIds ?? matchedIds;
  const activeSet = useMemo(() => new Set(activeClassIds), [activeClassIds]);

  const toggleClass = (cid) => {
    const next = activeSet.has(cid) ? activeClassIds.filter((id) => id !== cid) : [...activeClassIds, cid];
    setManualClassIds(next);
  };

  const overlappingRows = useMemo(() => overlaps.data?.overlapping ?? [], [overlaps.data]);
  const otherRows = useMemo(() => overlaps.data?.otherClasses ?? [], [overlaps.data]);
  const estimatedStudents = useMemo(() => {
    if (manualClassIds === null && overlaps.data) return overlaps.data.totalAffectedStudents;
    return [...overlappingRows, ...otherRows].filter((c) => activeSet.has(c.classId)).reduce((sum, c) => sum + (c.studentCount ?? 0), 0);
  }, [manualClassIds, overlaps.data, overlappingRows, otherRows, activeSet]);

  const save = useAction(() => {
    const body = {
      type: v.type,
      title: v.title.trim(),
      description: v.description.trim() || null,
      location: v.location.trim() || null,
      startAt: effectiveStart,
      endAt: effectiveEnd,
      allDay: v.allDay,
      notifyStudents: v.notifyStudents,
    };
    if (event) {
      return api.patch(`/calendar/events/${event.eventId}`, {
        ...body,
        ...(event.scope === 'CLASSES' ? { classIds: activeClassIds } : {}),
      });
    }
    return api.post('/calendar/events', {
      ...body,
      scope: v.scope,
      ...(v.scope === 'CLASS' ? { classId: v.classId } : {}),
      ...(v.scope === 'CLASSES' ? { classIds: activeClassIds } : {}),
    });
  }, {
    invalidate: [['calendar'], ['dashboard'], ['notifications']],
    success: (data) => {
      const count = data?.notifiedStudents;
      if (!event && count > 0) return `Event added. ${plural(count, 'student')} notified.`;
      return event ? 'Event saved.' : 'Event added.';
    },
    onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  const scopes = [
    { value: 'PERSONAL', label: 'Only me' },
    ...(canClass ? [{ value: 'CLASSES', label: 'Affected classes (by schedule)' }, { value: 'CLASS', label: 'One class' }] : []),
    ...(canInstitution ? [{ value: 'INSTITUTION', label: 'Whole school' }] : []),
  ];
  const needsClassPick = (v.scope === 'CLASS' && !v.classId) || (v.scope === 'CLASSES' && activeClassIds.length === 0);

  return (
    <Modal open onClose={onClose} title={event ? 'Edit event' : v.type === 'TEACHER_LEAVE' ? 'Report leave / class notice' : 'New event'} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.title.trim() || needsClassPick || !validRange} onClick={() => { setErrors({}); save.mutate(); }}>{event ? 'Save' : 'Add event'}</Button></>}>
      <div className="space-y-4">
        {!event && scopes.length > 1 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Who sees it" error={errors.scope}><Select value={v.scope} onChange={(e) => { set('scope', e.target.value); setManualClassIds(null); }}>{scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
            {v.scope === 'CLASS' && <Field label="Class" error={errors.classId}><Select value={v.classId} onChange={(e) => set('classId', e.target.value)}><option value="">Choose…</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>}
          </div>
        )}
        <Field label="Title" error={errors.title}>
          <Input
            value={v.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder={v.type === 'TEACHER_LEAVE' ? 'e.g. On sick leave, Faculty seminar, Official travel…' : undefined}
            maxLength={200}
            data-autofocus
          />
        </Field>
        <Checkbox checked={v.allDay} onChange={(e) => set('allDay', e.target.checked)} label="All day" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" error={errors.startAt}>{v.allDay ? <Input type="date" value={toLocalInput(v.startAt).slice(0, 10)} onChange={(e) => set('startAt', fromLocalInput(`${e.target.value}T00:00`))} /> : <Input type="datetime-local" value={toLocalInput(v.startAt)} onChange={(e) => set('startAt', fromLocalInput(e.target.value))} />}</Field>
          <Field label="Ends" error={errors.endAt}>{v.allDay ? <Input type="date" value={toLocalInput(v.endAt).slice(0, 10)} onChange={(e) => set('endAt', fromLocalInput(`${e.target.value}T23:59`))} /> : <Input type="datetime-local" value={toLocalInput(v.endAt)} onChange={(e) => set('endAt', fromLocalInput(e.target.value))} />}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" error={errors.type}><Select value={v.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(EVENT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Place" optional error={errors.location}><Input value={v.location} onChange={(e) => set('location', e.target.value)} maxLength={200} /></Field>
        </div>
        {v.scope === 'CLASSES' && canClass && (
          <div className="rounded-xl border border-line bg-raised/60 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-soft">
                <Bell className="size-3.5 text-brand" aria-hidden="true" />
                <span>Classes hit by this schedule</span>
              </div>
              {manualClassIds !== null && (
                <button type="button" onClick={() => setManualClassIds(null)} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  <RotateCcw className="size-3" aria-hidden="true" />Match schedule
                </button>
              )}
            </div>
            {!validRange ? (
              <p className="text-xs text-bad">Choose an end time that is after the start time.</p>
            ) : overlaps.isPending ? (
              <div className="flex items-center gap-2 text-xs text-faint"><Spinner className="size-3.5" />Checking your class schedules…</div>
            ) : (
              <>
                {overlappingRows.length === 0 ? (
                  <p className="text-xs text-soft">No scheduled class meetings fall inside this time window.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {overlappingRows.map((c) => (
                      <li key={c.classId}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 hover:border-line-strong">
                          <input type="checkbox" checked={activeSet.has(c.classId)} onChange={() => toggleClass(c.classId)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand-fill)]" />
                          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-ink">{c.label}</span>
                            <span className="block text-xs text-faint">{formatHitSummary(c.hits)} · {plural(c.studentCount, 'student')}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {otherRows.length > 0 && (
                  <div>
                    <button type="button" onClick={() => setShowOtherClasses((s) => !s)} className="text-xs font-medium text-soft hover:text-ink hover:underline">
                      {showOtherClasses ? 'Hide classes with no overlap' : `Include other classes without overlap (${otherRows.length})`}
                    </button>
                    {showOtherClasses && (
                      <ul className="mt-2 space-y-1.5">
                        {otherRows.map((c) => (
                          <li key={c.classId}>
                            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 hover:border-line-strong">
                              <input type="checkbox" checked={activeSet.has(c.classId)} onChange={() => toggleClass(c.classId)} className="size-4 shrink-0 accent-[var(--brand-fill)]" />
                              <span className={cn('size-2 shrink-0 rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.label}</span>
                              <span className="text-xs text-faint">{plural(c.studentCount, 'student')}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5 text-xs">
                  <span className={activeClassIds.length > 0 ? 'font-medium text-ink' : 'text-bad'}>
                    {activeClassIds.length > 0
                      ? `${plural(activeClassIds.length, 'class', 'classes')} selected${estimatedStudents > 0 ? ` · ${plural(estimatedStudents, 'student')} will see & be notified` : ''}`
                      : 'Select at least one class to notify.'}
                  </span>
                  <label className="flex items-center gap-1.5 text-soft">
                    <input type="checkbox" checked={v.notifyStudents} onChange={(e) => set('notifyStudents', e.target.checked)} className="size-3.5 accent-[var(--brand-fill)]" />
                    Send notification
                  </label>
                </div>
                {errors.classIds && <p className="text-xs text-bad">{errors.classIds}</p>}
              </>
            )}
          </div>
        )}
        <Field label="Notes" optional error={errors.description}><Textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} placeholder={v.type === 'TEACHER_LEAVE' ? 'Optional instructions (e.g. asynchronous task, makeup schedule)…' : undefined} /></Field>
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
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }} className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a reminder…" aria-label="New reminder" maxLength={200} className="col-span-2 min-w-0 w-full" />
        <Field label="Due date" optional className="min-w-0">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="min-w-0 w-full" />
        </Field>
        <Button type="submit" icon={Plus} loading={add.isPending} disabled={!title.trim()} aria-label="Add reminder" className="self-end sm:flex-none" />
      </form>
      {query.isPending ? <Spinner /> : tasks.length === 0 ? <p className="py-3 text-center text-sm text-faint">Nothing on your list.</p> : (
        <ul className="space-y-1">
          {[...open, ...done].map((t) => {
            const overdue = !t.completedAt && t.dueAt && new Date(t.dueAt) < new Date();
            return (
              <li key={t.id} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-raised">
                <input type="checkbox" checked={Boolean(t.completedAt)} onChange={() => toggle.mutate(t)} aria-label={`Mark “${t.title}” as ${t.completedAt ? 'not done' : 'done'}`} className="size-[18px] shrink-0 rounded accent-[var(--brand-fill)]" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block break-words text-sm leading-snug', t.completedAt ? 'text-faint line-through' : 'text-ink')}>{t.title}</span>
                  {t.dueAt && !t.completedAt && <span className={cn('text-xs', overdue ? 'font-medium text-bad' : 'text-faint')}>{overdue ? 'Was due' : 'Due'} {formatDateKey(dateKeyOf(t.dueAt))}</span>}
                </span>
                <button type="button" onClick={() => remove.mutate(t.id)} className="rounded p-1 text-faint max-sm:opacity-70 sm:opacity-0 hover:text-bad focus:opacity-100 sm:group-hover:opacity-100" aria-label={`Delete “${t.title}”`}><Trash2 className="size-4" /></button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
