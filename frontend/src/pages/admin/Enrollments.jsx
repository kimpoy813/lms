// Administration → Enrolment: find a student, then enrol, transfer or drop.
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Plus, Search, UserMinus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Pagination, QueryState, SearchInput, Select, Textarea, useDebounced } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
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

  return (
    <>
      <PageHeader title="Enrolment" description="Enrol a student in a class, move them to another section, or drop them. Teachers can also manage their own class lists." />
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
                  {s.classes.length === 0 ? <p className="mt-3 text-sm text-faint">Not enrolled in any class.</p> : (
                    <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
                      {s.classes.map((c) => (
                        <li key={c.enrollmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                          <Link to={`/classes/${c.classId}/people`} className="min-w-0 flex-1 basis-48 truncate"><span className="font-medium text-ink hover:text-brand">{c.label}</span> <span className="text-faint">{c.title}</span></Link>
                          <Button size="sm" variant="ghost" icon={ArrowRightLeft} onClick={() => setDialog({ type: 'transfer', student: s, from: c })}>Transfer</Button>
                          <Button size="sm" variant="ghost" icon={UserMinus} className="text-bad hover:text-bad" onClick={() => setDialog({ type: 'drop', student: s, from: c })}>Drop</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Pagination meta={students.data?.meta} onPage={setPage} />
      {dialog && <EnrolmentDialog {...dialog} classes={classes.data ?? []} onClose={() => setDialog(null)} />}
    </>
  );
}

function EnrolmentDialog({ type, student, from, classes, onClose }) {
  const [classId, setClassId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const taken = new Set(student.classes.map((c) => c.classId));
  const choices = classes.filter((c) => !taken.has(c.id));
  const action = useAction(() => {
    if (type === 'enrol') return api.post('/admin/enrollments', { classId, studentId: student.id });
    if (type === 'transfer') return api.post('/admin/enrollments/transfer', { studentId: student.id, fromClassId: from.classId, toClassId: classId, note: note.trim() || undefined });
    return api.post(`/classes/${from.classId}/people/${from.enrollmentId}/drop`, { note: note.trim() || undefined });
  }, {
    invalidate: [['admin', 'students'], ['admin', 'users'], ['class'], ['dashboard']],
    success: (r) => r?.message ?? (type === 'enrol' ? `${student.name} was enrolled.` : type === 'drop' ? `${student.name} was dropped from ${from.label}.` : 'Transferred.'),
    onSuccess: onClose,
    onError: (err) => { setError(err.fields ? Object.values(err.fields)[0] : err.message); return true; },
  });
  const title = { enrol: `Enrol ${student.name}`, transfer: `Transfer ${student.name}`, drop: `Drop ${student.name} from ${from?.label}?` }[type];
  return (
    <Modal open onClose={onClose} size="sm" title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={type === 'drop' ? 'danger' : 'primary'} loading={action.isPending} disabled={type !== 'drop' && !classId} onClick={() => { setError(null); action.mutate(); }}>{{ enrol: 'Enrol', transfer: 'Transfer', drop: 'Drop student' }[type]}</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        {type === 'transfer' && <p className="text-sm text-soft">The student leaves <strong className="text-ink">{from.label}</strong> and joins the class you choose. Scores already recorded stay with the old class; they are not copied.</p>}
        {type === 'drop' && <p className="text-sm text-soft">The student loses access to the class. Their submissions, scores and attendance are kept, and they can be reinstated from the class list.</p>}
        {type !== 'drop' && (
          <Field label={type === 'transfer' ? 'Transfer to' : 'Class'} hint={choices.length === 0 ? 'There is no other active class.' : undefined}>
            <Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choose a class…</option>{choices.map((c) => <option key={c.id} value={c.id}>{classLabel(c)} — {c.teacher?.name}</option>)}</Select>
          </Field>
        )}
        {type !== 'enrol' && <Field label="Note" optional hint="Kept with the enrolment record."><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} /></Field>}
      </div>
    </Modal>
  );
}
