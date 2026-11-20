// Administration → Enrolment: find a student, then enrol, transfer, drop or remove.
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Plus, RotateCcw, Search, UserMinus, Users, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Pagination, QueryState, SearchInput, Select, Textarea, useDebounced } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { classLabel } from '../classes/useClass.js';

const STATUS_TONE = { ACTIVE: 'ok', PENDING: 'warn', SUSPENDED: 'bad', DEACTIVATED: 'neutral' };

export default function AdminEnrollments() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const term = useDebounced(search.trim());
  const students = useQuery({ queryKey: ['admin', 'students', term, page], queryFn: () => api.list('/admin/students', { search: term || undefined, page, pageSize: 20 }), placeholderData: (prev) => prev });
  const classes = useQuery({ queryKey: ['admin', 'classes', 'active'], queryFn: () => api.get('/classes', { status: 'ACTIVE', pageSize: 200 }) });
  const sections = useQuery({ queryKey: ['admin', 'sections'], queryFn: () => api.get('/catalog/sections') });

  return (
    <>
      <PageHeader
        title="Enrolment"
        description="Enrol a student in a class, move them to another section, or enrol an entire block section in one click."
        actions={
          <Button variant="secondary" icon={Users} onClick={() => setDialog({ type: 'section' })}>
            Enrol whole section
          </Button>
        }
      />
      <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search students by name, e-mail or student number…" className="mb-4 w-full sm:w-96" />
      <QueryState query={{ ...students, data: students.data?.data }}>
        {(rows) => rows.length === 0 ? (
          <Card><EmptyState icon={term ? Search : Users} title={term ? 'No student matches' : 'No students yet'} description={term ? 'Check the spelling, or search by student number.' : 'Create student accounts under Users first.'} /></Card>
        ) : (
          <ul className="space-y-3">
            {rows.map((s) => (
              <li key={s.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Avatar name={s.name} size={40} />
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink"><Link to={`/admin/users?open=${s.id}`} className="hover:text-brand">{s.name}</Link>{s.status !== 'ACTIVE' && <Badge tone={STATUS_TONE[s.status]}>{s.status.toLowerCase()}</Badge>}</p>
                      <p className="truncate text-[13px] text-faint">{[s.studentNumber, s.program, s.section, s.yearLevel ? `Year ${s.yearLevel}` : null, s.email].filter(Boolean).join(' · ')}</p>
                    </div>
                    <Button size="sm" variant="secondary" icon={Plus} disabled={s.status !== 'ACTIVE'} title={s.status !== 'ACTIVE' ? 'Only active accounts can be enrolled' : undefined} onClick={() => setDialog({ type: 'enrol', student: s })}>Enrol in a class</Button>
                  </div>
                  {s.classes.length === 0 && (s.droppedClasses?.length ?? 0) === 0 ? <p className="mt-3 text-sm text-faint">Not enrolled in any class.</p> : (
                    <div className="mt-3 space-y-2">
                      {s.classes.length > 0 && (
                        <ul className="divide-y divide-line rounded-xl border border-line">
                          {s.classes.map((c) => (
                            <li key={c.enrollmentId} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                              <Link to={`/classes/${c.classId}/people`} className="min-w-0 flex-1 basis-48 truncate"><span className="font-medium text-ink hover:text-brand">{c.label}</span> <span className="text-faint">{c.title}</span></Link>
                              <Button size="sm" variant="ghost" icon={ArrowRightLeft} onClick={() => setDialog({ type: 'transfer', student: s, from: c })}>Transfer</Button>
                              <Button size="sm" variant="ghost" icon={UserMinus} onClick={() => setDialog({ type: 'drop', student: s, from: c })}>Drop</Button>
                              <Button size="sm" variant="ghost" icon={UserX} className="text-bad hover:text-bad" onClick={() => setDialog({ type: 'remove', student: s, from: c })}>Remove</Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {(s.droppedClasses?.length ?? 0) > 0 && (
                        <ul className="divide-y divide-line rounded-xl border border-warn/30 bg-warn-soft/20">
                          {s.droppedClasses.map((c) => (
                            <li key={c.enrollmentId} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                              <div className="min-w-0 flex-1 basis-48 truncate">
                                <Link to={`/classes/${c.classId}/gradebook?student=${s.id}`} className="font-medium text-ink hover:text-brand">{c.label}</Link>
                                <span className="ml-1.5 text-faint">{c.title}</span>
                                <Badge tone="warn" className="ml-2">Dropped{c.droppedAt ? ` ${formatDate(c.droppedAt)}` : ''}</Badge>
                              </div>
                              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setDialog({ type: 'reinstate', student: s, from: c })}>Reinstate</Button>
                              <Button size="sm" variant="ghost" icon={UserX} className="text-bad hover:text-bad" onClick={() => setDialog({ type: 'remove', student: s, from: c })}>Remove</Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Pagination meta={students.data?.meta} onPage={setPage} />
      {dialog?.type === 'section'
        ? <SectionEnrolDialog classes={classes.data ?? []} sections={sections.data ?? []} onClose={() => setDialog(null)} />
        : dialog && <EnrolmentDialog {...dialog} classes={classes.data ?? []} onClose={() => setDialog(null)} />}
    </>
  );
}

function SectionEnrolDialog({ classes, sections, onClose }) {
  const [sectionId, setSectionId] = useState('');
  const [classId, setClassId] = useState('');
  const [error, setError] = useState(null);
  const selectedSection = sections.find((s) => s.id === sectionId);
  const activeSections = sections.filter((s) => s.isActive !== false);

  const action = useAction(() => api.post('/admin/enrollments/section', { sectionId, classId }), {
    invalidate: [['admin', 'students'], ['admin', 'users'], ['class'], ['dashboard']],
    success: (r) =>
      r.enrolledCount > 0
        ? `Enrolled ${r.enrolledCount} student${r.enrolledCount === 1 ? '' : 's'} from ${r.sectionName} into ${r.classLabel}.${r.alreadyEnrolledCount > 0 ? ` (${r.alreadyEnrolledCount} already enrolled)` : ''}`
        : `All ${r.totalInSection} students in ${r.sectionName} are already enrolled in ${r.classLabel}.`,
    onSuccess: onClose,
    onError: (err) => { setError(err.fields ? Object.values(err.fields)[0] : err.message); return true; },
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Enrol whole section"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={action.isPending} disabled={!sectionId || !classId} onClick={() => { setError(null); action.mutate(); }}>
            Enrol section
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        <p className="text-sm text-soft">Enrols every active student assigned to the chosen section into an active class. Students already enrolled are skipped automatically.</p>
        <Field label="Section" hint={selectedSection ? `${selectedSection.studentCount ?? 0} student${selectedSection.studentCount === 1 ? '' : 's'} assigned` : undefined}>
          <Select value={sectionId} onChange={(e) => {
            const nextId = e.target.value;
            setSectionId(nextId);
            if (!classId && nextId) {
              const match = classes.find((c) => c.section?.id === nextId);
              if (match) setClassId(match.id);
            }
          }}>
            <option value="">Choose a section…</option>
            {activeSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.program?.code ? ` (${s.program.code})` : ''} · {s.studentCount ?? 0} students
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Class">
          <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">Choose a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {classLabel(c)} — {c.teacher?.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function EnrolmentDialog({ type, student, from, classes, onClose }) {
  const [classId, setClassId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const taken = new Set(student.classes.map((c) => c.classId));
  const choices = classes.filter((c) => !taken.has(c.id));
  const needsClassChoice = type === 'enrol' || type === 'transfer';
  const action = useAction(() => {
    if (type === 'enrol') return api.post('/admin/enrollments', { classId, studentId: student.id });
    if (type === 'transfer') return api.post('/admin/enrollments/transfer', { studentId: student.id, fromClassId: from.classId, toClassId: classId, note: note.trim() || undefined });
    if (type === 'reinstate') return api.post(`/classes/${from.classId}/people/${from.enrollmentId}/reinstate`);
    if (type === 'remove') return api.post(`/classes/${from.classId}/people/${from.enrollmentId}/remove`, { note: note.trim() || undefined });
    return api.post(`/classes/${from.classId}/people/${from.enrollmentId}/drop`, { note: note.trim() || undefined });
  }, {
    invalidate: [['admin', 'students'], ['admin', 'users'], ['class'], ['dashboard']],
    success: (r) => r?.message ?? ({
      enrol: `${student.name} was enrolled.`,
      drop: `${student.name} was dropped from ${from?.label} (kept in gradebook).`,
      remove: `${student.name} was removed from ${from?.label}.`,
      reinstate: `${student.name} was reinstated in ${from?.label}.`,
    }[type] ?? 'Transferred.'),
    onSuccess: onClose,
    onError: (err) => { setError(err.fields ? Object.values(err.fields)[0] : err.message); return true; },
  });
  const title = {
    enrol: `Enrol ${student.name}`,
    transfer: `Transfer ${student.name}`,
    drop: `Drop ${student.name} from ${from?.label}?`,
    remove: `Remove ${student.name} from ${from?.label}?`,
    reinstate: `Reinstate ${student.name} in ${from?.label}?`,
  }[type];
  return (
    <Modal open onClose={onClose} size="sm" title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={type === 'remove' ? 'danger' : 'primary'} loading={action.isPending} disabled={needsClassChoice && !classId} onClick={() => { setError(null); action.mutate(); }}>{{ enrol: 'Enrol', transfer: 'Transfer', drop: 'Drop student', remove: 'Remove from class', reinstate: 'Reinstate' }[type]}</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        {type === 'transfer' && <p className="text-sm text-soft">The student leaves <strong className="text-ink">{from.label}</strong> and joins the class you choose. Scores already recorded stay with the old class; they are not copied.</p>}
        {type === 'drop' && <p className="text-sm text-soft">The student loses active access to the class, but remains on the class roster and gradebook so their grades, submissions, and attendance stay available.</p>}
        {type === 'remove' && <p className="text-sm text-soft">The student is completely removed from <strong className="text-ink">{from.label}</strong>, including their roster entry, grades, submissions, and attendance records in this class. If you need their grade later, choose Drop instead.</p>}
        {type === 'reinstate' && <p className="text-sm text-soft">Restores active access for <strong className="text-ink">{student.name}</strong> in <strong className="text-ink">{from.label}</strong> with all kept grades and records.</p>}
        {needsClassChoice && (
          <Field label={type === 'transfer' ? 'Transfer to' : 'Class'} hint={choices.length === 0 ? 'There is no other active class.' : undefined}>
            <Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choose a class…</option>{choices.map((c) => <option key={c.id} value={c.id}>{classLabel(c)} — {c.teacher?.name}</option>)}</Select>
          </Field>
        )}
        {(type === 'transfer' || type === 'drop' || type === 'remove') && (
          <Field label="Note" optional hint={type === 'remove' ? 'Recorded in the audit log.' : 'Kept with the enrolment record.'}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} /></Field>
        )}
      </div>
    </Modal>
  );
}
