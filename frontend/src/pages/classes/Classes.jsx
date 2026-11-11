// "My classes": what a student is enrolled in, what a teacher teaches, or everything (admin).
import { useQuery } from '@tanstack/react-query';
import { Archive, BookOpen, CalendarDays, Check, Clock, KeyRound, MapPin, Plus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Avatar, Badge, Button, Card, cn, EmptyState, Field, Input, Modal, PageHeader, QueryState, SearchInput, Segmented, Select, Skeleton, Switch, Textarea, useDebounced, useForm } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatClock, plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { CLASS_COLORS, classColor } from './classColors.js';
import { classLabel, DAYS, DAYS_SHORT } from './useClass.js';

export const scheduleSummary = (schedules = []) => {
  if (schedules.length === 0) return 'No fixed schedule';
  const groups = new Map();
  for (const s of schedules) {
    const key = `${s.startTime}-${s.endTime}`;
    groups.set(key, [...(groups.get(key) ?? []), s.dayOfWeek]);
  }
  return [...groups].map(([key, days]) => `${days.sort((a, b) => a - b).map((d) => DAYS_SHORT[d]).join(', ')} ${formatClock(key.split('-')[0])}–${formatClock(key.split('-')[1])}`).join(' · ');
};

export default function Classes() {
  const { user, isStudent, isAdmin, can } = useAuth();
  const [status, setStatus] = useState('ACTIVE');
  const [search, setSearch] = useState('');
  const [joining, setJoining] = useState(false);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim());
  const classes = useQuery({ queryKey: ['classes', { status, term }], queryFn: () => api.get('/classes', { status, search: term || undefined }) });
  const mine = useQuery({ queryKey: ['enrollments', 'mine'], queryFn: () => api.get('/enrollments/mine'), enabled: isStudent });

  const pending = (mine.data?.enrollments ?? []).filter((e) => e.status === 'PENDING' || e.status === 'REJECTED');
  const invitations = mine.data?.invitations ?? [];
  const canCreate = !isStudent && can('class.create');

  return (
    <>
      <PageHeader
        title={isStudent ? 'My classes' : isAdmin ? 'Classes' : 'My classes'}
        description={isStudent ? 'Open a class to see its lessons, assignments and grades.' : isAdmin ? 'Every class in the institution.' : 'Classes you teach.'}
        actions={<>
          {isStudent && <Button icon={KeyRound} onClick={() => setJoining(true)}>Join with a class code</Button>}
          {canCreate && <Button icon={Plus} onClick={() => setCreating(true)}>New class</Button>}
        </>}
      />

      {isStudent && invitations.length > 0 && <Invitations items={invitations} />}
      {isStudent && pending.length > 0 && (
        <Card className="mb-5">
          <h2 className="mb-3 text-sm font-semibold">Join requests</h2>
          <ul className="divide-y divide-line">
            {pending.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{e.class.title}</span>
                  <span className="block text-xs text-faint">{e.class.teacherName} · requested {relativeTime(e.requestedAt)}{e.note ? ` · “${e.note}”` : ''}</span>
                </span>
                {e.status === 'PENDING' ? <Badge tone="warn" icon={Clock}>Waiting for approval</Badge> : <Badge tone="bad" icon={X}>Not approved</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search classes…" className="w-full sm:w-72" />
        <Segmented label="Show" value={status} onChange={setStatus} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'ARCHIVED', label: 'Archived' }]} />
      </div>

      <QueryState query={classes} loader={<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-52 rounded-2xl" />)}</div>}>
        {(list) => list.length === 0 ? (
          <Card>
            <EmptyState
              icon={status === 'ARCHIVED' ? Archive : BookOpen}
              title={term ? `No classes match “${term}”` : status === 'ARCHIVED' ? 'No archived classes' : isStudent ? 'You are not in a class yet' : 'No classes yet'}
              description={term || status === 'ARCHIVED' ? null : isStudent ? 'Ask your teacher for the class code, then join.' : canCreate ? 'Create your first class to add lessons, take attendance and record grades.' : 'Classes are created by the administrator.'}
              action={term || status === 'ARCHIVED' ? null : isStudent ? <Button icon={KeyRound} onClick={() => setJoining(true)}>Join with a class code</Button> : canCreate ? <Button icon={Plus} onClick={() => setCreating(true)}>New class</Button> : null}
            />
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => <li key={c.id}><ClassCard cls={c} showTeacher={c.teacher.id !== user.id} /></li>)}
          </ul>
        )}
      </QueryState>

      {joining && <JoinDialog onClose={() => setJoining(false)} />}
      {creating && <CreateClassDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function ClassCard({ cls, showTeacher }) {
  const color = classColor(cls.color);
  return (
    <Link to={`/classes/${cls.id}`} className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card transition-shadow hover:shadow-pop">
      <div className={cn('relative h-24 bg-gradient-to-br p-4 text-white', color.banner)}>
        <p className="text-lg font-bold leading-tight tracking-tight">{classLabel(cls)}</p>
        <p className="mt-0.5 line-clamp-2 text-[13px] text-white/85">{cls.course.title}</p>
        {cls.status === 'ARCHIVED' && <span className="absolute right-3 top-3 rounded-full bg-black/30 px-2 py-0.5 text-[11px] font-semibold">Archived</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-4 text-[13px] text-soft">
        {showTeacher && (
          <p className="flex items-center gap-2"><Avatar name={cls.teacher.name} fileId={cls.teacher.avatarFileId} size={22} /><span className="truncate font-medium text-ink">{cls.teacher.name}</span></p>
        )}
        <p className="flex items-start gap-2"><CalendarDays className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" /><span>{scheduleSummary(cls.schedules)}</span></p>
        {cls.room && <p className="flex items-center gap-2"><MapPin className="size-4 shrink-0 text-faint" aria-hidden="true" />{cls.room}</p>}
        <p className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-faint">
          <span className="flex items-center gap-1.5"><Users className="size-3.5" aria-hidden="true" />{plural(cls.studentCount, 'student')}</span>
          <span>{cls.semester.name} · {cls.semester.academicYear.name}</span>
        </p>
      </div>
    </Link>
  );
}

function Invitations({ items }) {
  const answer = useAction(({ id, accept }) => api.post(`/enrollments/invitations/${id}/${accept ? 'accept' : 'decline'}`), {
    invalidate: [['enrollments'], ['classes'], ['dashboard']],
    success: (_, { accept }) => (accept ? 'You joined the class.' : 'Invitation declined.'),
  });
  return (
    <Card className="mb-5 border-brand/30">
      <h2 className="mb-3 text-sm font-semibold">Class invitations</h2>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-brand-soft p-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{i.class.title}</span>
              <span className="block text-xs text-soft">{i.class.teacherName} invited you · {i.class.semester.name}</span>
            </span>
            <Button size="sm" icon={Check} loading={answer.isPending && answer.variables?.id === i.id && answer.variables.accept} onClick={() => answer.mutate({ id: i.id, accept: true })}>Accept</Button>
            <Button size="sm" variant="secondary" onClick={() => answer.mutate({ id: i.id, accept: false })}>Decline</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function JoinDialog({ onClose }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const join = useAction((value) => api.post('/enrollments/join', { code: value }), {
    invalidate: [['classes'], ['enrollments'], ['dashboard']],
    success: (r) => r.message,
    onSuccess: (r) => {
      onClose();
      if (r.status === 'ENROLLED') navigate(`/classes/${r.class.id}`);
    },
    onError: (err) => {
      setError(err.fields?.code ?? err.message);
      return true;
    },
  });
  return (
    <Modal open onClose={onClose} title="Join a class" description="Enter the code your teacher shared with the class." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="join-form" type="submit" loading={join.isPending} disabled={code.trim().length < 4}>Join</Button></>}>
      <form id="join-form" onSubmit={(e) => { e.preventDefault(); setError(null); join.mutate(code.trim()); }}>
        <Field label="Class code" error={error}>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. GB6CCZ7" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12} className="h-12 text-center font-mono text-lg tracking-[0.3em]" />
        </Field>
      </form>
    </Modal>
  );
}

function CreateClassDialog({ onClose }) {
  const navigate = useNavigate();
  const { isAdmin, can } = useAuth();
  const semesters = useQuery({ queryKey: ['catalog', 'semesters'], queryFn: () => api.get('/catalog/semesters') });
  const courses = useQuery({ queryKey: ['catalog', 'courses'], queryFn: () => api.get('/catalog/courses') });
  const sections = useQuery({ queryKey: ['catalog', 'sections'], queryFn: () => api.get('/catalog/sections') });
  const teachers = useQuery({ queryKey: ['admin', 'users', 'teachers'], queryFn: () => api.get('/admin/users', { role: 'TEACHER', status: 'ACTIVE', pageSize: 100 }), enabled: isAdmin });
  const mayAddCatalog = can('catalog.create');
  const form = useForm({ courseId: '', newCode: '', newTitle: '', newUnits: '3', sectionId: '', newSectionName: '', semesterId: '', teacherId: '', room: '', color: 'indigo', description: '', enrollmentRequiresApproval: false });
  const [schedules, setSchedules] = useState([]);
  const [error, setError] = useState(null);

  const create = useAction((body) => api.post('/classes', body), {
    invalidate: [['classes'], ['dashboard'], ['catalog']],
    success: 'Class created.',
    onSuccess: (cls) => {
      onClose();
      navigate(`/classes/${cls.id}`);
    },
    onError: (err) => {
      if (!form.fail(err)) setError(err.message);
      else setError('Please check the highlighted fields.');
      return true;
    },
  });

  const v = form.values;
  const semesterId = v.semesterId || semesters.data?.find((s) => s.isCurrent)?.id || semesters.data?.[0]?.id || '';
  const submit = (e) => {
    e.preventDefault();
    setError(null);
    create.mutate({
      semesterId,
      ...(v.courseId === 'new' ? { newCourse: { code: v.newCode.trim(), title: v.newTitle.trim(), units: Number(v.newUnits) || 3 } } : { courseId: v.courseId }),
      ...(v.sectionId === 'new' ? { newSectionName: v.newSectionName.trim() } : v.sectionId ? { sectionId: v.sectionId } : {}),
      ...(isAdmin && v.teacherId ? { teacherId: v.teacherId } : {}),
      room: v.room.trim() || null,
      description: v.description.trim() || null,
      color: v.color,
      enrollmentRequiresApproval: v.enrollmentRequiresApproval,
      schedules: schedules.map((s) => ({ ...s, room: v.room.trim() || null })),
    });
  };
  const ready = semesterId && (v.courseId === 'new' ? v.newCode.trim() && v.newTitle.trim() : v.courseId) && (!isAdmin || v.teacherId);

  return (
    <Modal open onClose={onClose} title="New class" description="A class is one course taught to one section in one semester." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="class-form" type="submit" loading={create.isPending} disabled={!ready}>Create class</Button></>}>
      {semesters.isSuccess && semesters.data.length === 0 ? (
        <Alert tone="warn" title="No semester has been set up yet">{isAdmin ? <>Add an academic year and semester in the <Link to="/admin/catalog" className="font-semibold text-brand underline">academic catalogue</Link> first.</> : 'Ask the administrator to add the current semester first.'}</Alert>
      ) : (
        <form id="class-form" onSubmit={submit} className="space-y-4">
          {error && <Alert tone="bad">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Course" required error={form.errors.courseId}>
              <Select {...form.bind('courseId')} required>
                <option value="">Choose a course…</option>
                {(courses.data ?? []).filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.title}</option>)}
                {mayAddCatalog && <option value="new">＋ Add a new course…</option>}
              </Select>
            </Field>
            <Field label="Semester" required error={form.errors.semesterId}>
              <Select value={semesterId} onChange={(e) => form.set('semesterId', e.target.value)}>
                {(semesters.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}{s.isCurrent ? ' (current)' : ''}</option>)}
              </Select>
            </Field>
          </div>
          {v.courseId === 'new' && (
            <div className="grid gap-4 rounded-xl bg-raised p-4 sm:grid-cols-[8rem_1fr_5rem]">
              <Field label="Code" required error={form.errors['newCourse.code']}><Input {...form.bind('newCode')} placeholder="IT 102" /></Field>
              <Field label="Course title" required error={form.errors['newCourse.title']}><Input {...form.bind('newTitle')} placeholder="Computer Programming 1" /></Field>
              <Field label="Units"><Input type="number" min="0" max="12" step="0.5" {...form.bind('newUnits')} /></Field>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Section" optional error={form.errors.sectionId}>
              <Select {...form.bind('sectionId')}>
                <option value="">No section</option>
                {(sections.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                {mayAddCatalog && <option value="new">＋ Add a new section…</option>}
              </Select>
            </Field>
            {v.sectionId === 'new'
              ? <Field label="New section name" required error={form.errors.newSectionName}><Input {...form.bind('newSectionName')} placeholder="BSIT 1B" /></Field>
              : <Field label="Room" optional><Input {...form.bind('room')} placeholder="Room 204" /></Field>}
          </div>
          {v.sectionId === 'new' && <Field label="Room" optional><Input {...form.bind('room')} placeholder="Room 204" /></Field>}
          {isAdmin && (
            <Field label="Teacher" required error={form.errors.teacherId}>
              <Select {...form.bind('teacherId')} required>
                <option value="">Choose a teacher…</option>
                {(teachers.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          )}
          <ScheduleEditor value={schedules} onChange={setSchedules} />
          <Field label="Description" optional><Textarea rows={2} {...form.bind('description')} maxLength={2000} /></Field>
          <Field label="Colour">
            <ColorPicker value={v.color} onChange={(c) => form.set('color', c)} />
          </Field>
          <Switch checked={v.enrollmentRequiresApproval} onChange={(on) => form.set('enrollmentRequiresApproval', on)} label="Approve students before they join" description="Students who enter the class code wait for your approval." />
        </form>
      )}
    </Modal>
  );
}

export function ColorPicker({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Class colour" className="flex flex-wrap gap-2">
      {CLASS_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} title={c} onClick={() => onChange(c)} className={cn('grid size-8 place-items-center rounded-full text-white', classColor(c).bar, value === c && 'ring-2 ring-brand ring-offset-2 ring-offset-surface')}>
          {value === c && <Check className="size-4" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** Weekly meeting times. */
export function ScheduleEditor({ value, onChange }) {
  const update = (i, patch) => onChange(value.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-ink">Weekly schedule <span className="text-xs font-normal text-faint">optional</span></legend>
      {value.length > 0 && (
        <ul className="mb-2 space-y-2">
          {value.map((s, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Select value={s.dayOfWeek} onChange={(e) => update(i, { dayOfWeek: Number(e.target.value) })} aria-label="Day" className="w-36">
                {DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
              </Select>
              <Input type="time" value={s.startTime} onChange={(e) => update(i, { startTime: e.target.value })} aria-label="Starts" className="w-32" />
              <span className="text-faint">to</span>
              <Input type="time" value={s.endTime} onChange={(e) => update(i, { endTime: e.target.value })} aria-label="Ends" className="w-32" />
              <Button variant="ghost" size="sm" icon={X} onClick={() => onChange(value.filter((_, n) => n !== i))} aria-label="Remove this meeting" />
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" size="sm" icon={Plus} onClick={() => onChange([...value, { dayOfWeek: value.at(-1) ? Math.min(6, value.at(-1).dayOfWeek + 2) : 1, startTime: value.at(-1)?.startTime ?? '09:00', endTime: value.at(-1)?.endTime ?? '10:00' }])}>Add a meeting</Button>
    </fieldset>
  );
}
