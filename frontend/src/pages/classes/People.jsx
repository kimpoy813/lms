// Who is in the class. Teachers manage enrolment here; students see the teacher and
// (when the teacher allows it) their classmates' names.
import { useQuery } from '@tanstack/react-query';
import { Check, Clock, EyeOff, Mail, MailPlus, MessageSquare, MoreHorizontal, RotateCcw, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Menu, MenuItem, Modal, QueryState, SearchInput, Table, Td, Textarea, Th, Tr } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDate, plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { useClass } from './useClass.js';

export default function People() {
  const { cls, canManage, base } = useClass();
  const query = useQuery({ queryKey: ['class', cls.id, 'people'], queryFn: () => api.get(`${base}/people`) });
  return <QueryState query={query}>{(data) => (canManage ? <Manage data={data} /> : <Classmates data={data} />)}</QueryState>;
}

function TeacherCard({ teacher, showMessage }) {
  return (
    <Card className="flex flex-wrap items-center gap-4">
      <Avatar name={teacher.name} fileId={teacher.avatarFileId} size={48} />
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">Teacher</p>
        <p className="truncate font-semibold text-ink">{teacher.name}</p>
        <p className="truncate text-[13px] text-faint">{[teacher.position, teacher.email].filter(Boolean).join(' · ')}</p>
        {teacher.consultationHours && <p className="mt-1 text-[13px] text-soft">Consultation: {teacher.consultationHours}</p>}
      </div>
      {showMessage && <Button to={`/messages?to=${teacher.id}`} variant="secondary" icon={MessageSquare}>Message</Button>}
    </Card>
  );
}

function Classmates({ data }) {
  const { user, can } = useAuth();
  return (
    <div className="space-y-5">
      <TeacherCard teacher={data.teacher} showMessage={can('messaging.student_to_teacher')} />
      <Card>
        <h2 className="mb-3 text-[15px] font-semibold">Classmates</h2>
        {!data.classmatesVisible ? (
          <EmptyState compact icon={EyeOff} title="The class list is private" description="Your teacher has chosen not to show the list of students in this class." />
        ) : data.students.length === 0 ? <EmptyState compact title="No one else has joined yet" /> : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.students.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <Avatar name={s.name} fileId={s.avatarFileId} size={34} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{s.name}{s.id === user.id && <span className="font-normal text-faint"> (you)</span>}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-faint">Only names are shared with classmates. Grades, attendance and contact details stay private.</p>
      </Card>
    </div>
  );
}

function Manage({ data }) {
  const { cls, base } = useClass();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind: 'drop'|'reject', student }
  const [note, setNote] = useState('');
  const invalidate = [['class', cls.id], ['dashboard'], ['classes']];

  const act = useAction(({ enrollmentId, action, body }) => api.post(`${base}/people/${enrollmentId}/${action}`, body), {
    invalidate,
    success: (_, { action }) => ({ approve: 'Student approved.', reject: 'Request declined.', drop: 'Student dropped from the class.', reinstate: 'Student reinstated.' }[action]),
    onSuccess: () => { setConfirm(null); setNote(''); },
  });
  const cancelInvite = useAction((id) => api.delete(`${base}/people/invitations/${id}`), { invalidate, success: 'Invitation cancelled.' });

  const term = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const match = (s) => !term || `${s.name} ${s.email} ${s.studentNumber ?? ''}`.toLowerCase().includes(term);
    const by = (status) => data.students.filter((s) => s.status === status && match(s));
    return { pending: by('PENDING'), enrolled: by('ENROLLED'), inactive: [...by('DROPPED'), ...by('REJECTED')] };
  }, [data.students, term]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, e-mail or student number…" className="w-full sm:w-80" />
        <span className="text-sm text-soft">{plural(groups.enrolled.length, 'student')} enrolled</span>
        <Button icon={UserPlus} className="ml-auto" onClick={() => setAdding(true)} disabled={cls.status === 'ARCHIVED'}>Add students</Button>
      </div>

      {groups.pending.length > 0 && (
        <Card className="border-warn/40">
          <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold"><Clock className="size-4 text-warn" aria-hidden="true" />Waiting for your approval <Badge tone="warn">{groups.pending.length}</Badge></h2>
          <ul className="divide-y divide-line">
            {groups.pending.map((s) => (
              <li key={s.enrollmentId} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Avatar name={s.name} fileId={s.avatarFileId} size={38} />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                  <p className="truncate text-xs text-faint">{[s.studentNumber, s.program, s.email].filter(Boolean).join(' · ')} · asked {relativeTime(s.requestedAt)}</p>
                </div>
                <Button size="sm" icon={Check} loading={act.isPending && act.variables?.enrollmentId === s.enrollmentId && act.variables.action === 'approve'} onClick={() => act.mutate({ enrollmentId: s.enrollmentId, action: 'approve' })}>Approve</Button>
                <Button size="sm" variant="secondary" icon={X} onClick={() => setConfirm({ kind: 'reject', student: s })}>Decline</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {groups.enrolled.length === 0 ? (
        <Card><EmptyState icon={UserPlus} title={term ? 'No student matches your search' : 'No students yet'} description={term ? null : `Share the class code ${cls.enrollmentCode ?? ''} or add students by e-mail.`} action={term ? null : <Button icon={UserPlus} onClick={() => setAdding(true)}>Add students</Button>} /></Card>
      ) : (
        <Table>
          <thead><tr><Th>Student</Th><Th className="hidden md:table-cell">Student no.</Th><Th className="hidden lg:table-cell">Program</Th><Th className="hidden sm:table-cell">Joined</Th><Th className="w-12"><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {groups.enrolled.map((s) => (
              <Tr key={s.enrollmentId}>
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={s.name} fileId={s.avatarFileId} size={34} />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.lastName}, {s.firstName}{s.accountStatus !== 'ACTIVE' && <Badge tone="warn" className="ml-2">Account {s.accountStatus.toLowerCase()}</Badge>}</p>
                      <p className="truncate text-xs text-faint">{s.email}</p>
                    </div>
                  </div>
                </Td>
                <Td className="hidden font-mono text-[13px] text-soft md:table-cell">{s.studentNumber ?? '—'}</Td>
                <Td className="hidden text-soft lg:table-cell">{[s.program, s.yearLevel ? `Year ${s.yearLevel}` : null].filter(Boolean).join(' · ') || '—'}</Td>
                <Td className="hidden text-soft sm:table-cell">{formatDate(s.enrolledAt)}</Td>
                <Td className="text-right">
                  <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label={`Actions for ${s.name}`} size="sm" onClick={toggle} {...props} />}>
                    <MenuItem icon={MessageSquare} to={`/messages?to=${s.id}`}>Send a message</MenuItem>
                    <MenuItem icon={UserMinus} tone="danger" onClick={() => setConfirm({ kind: 'drop', student: s })}>Drop from class</MenuItem>
                  </Menu>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {data.invitations.length > 0 && (
        <Card>
          <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold"><Mail className="size-4 text-brand" aria-hidden="true" />Invitations sent</h2>
          <p className="mb-3 text-[13px] text-faint">These addresses do not have an account yet. They join automatically when they register with the same e-mail address.</p>
          <ul className="divide-y divide-line">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.email}</span>
                {i.expired ? <Badge tone="bad">Expired</Badge> : <span className="hidden text-xs text-faint sm:block">sent {relativeTime(i.createdAt)}</span>}
                <IconButton icon={Trash2} label={`Cancel the invitation for ${i.email}`} size="sm" variant="dangerGhost" onClick={() => cancelInvite.mutate(i.id)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {groups.inactive.length > 0 && (
        <Card>
          <h2 className="mb-3 text-[15px] font-semibold">No longer in the class</h2>
          <ul className="divide-y divide-line">
            {groups.inactive.map((s) => (
              <li key={s.enrollmentId} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <Avatar name={s.name} fileId={s.avatarFileId} size={32} />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-medium text-ink">{s.name}</p>
                  <p className="truncate text-xs text-faint">{s.status === 'DROPPED' ? `Dropped ${formatDate(s.droppedAt)}` : 'Request declined'}{s.note ? ` — ${s.note}` : ''}</p>
                </div>
                <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => act.mutate({ enrollmentId: s.enrollmentId, action: 'reinstate' })}>Reinstate</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adding && <AddStudents onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => { setConfirm(null); setNote(''); }}
        title={confirm?.kind === 'drop' ? `Drop ${confirm.student.name}?` : `Decline ${confirm?.student.name}’s request?`}
        confirmLabel={confirm?.kind === 'drop' ? 'Drop student' : 'Decline request'}
        loading={act.isPending}
        onConfirm={() => act.mutate({ enrollmentId: confirm.student.enrollmentId, action: confirm.kind, body: { note: note.trim() || undefined } })}
      >
        <p>{confirm?.kind === 'drop' ? 'The student loses access to this class. Their submissions, grades and attendance are kept, and you can reinstate them later.' : 'The student is told that the request was not approved.'}</p>
        <Field label="Note" optional className="mt-3"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={confirm?.kind === 'drop' ? 'e.g. Transferred to another section' : 'Reason shown to the student'} /></Field>
      </ConfirmDialog>
    </div>
  );
}

function AddStudents({ onClose }) {
  const { cls, base } = useClass();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const emails = useMemo(() => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))], [text]);
  const add = useAction((list) => api.post(`${base}/people/bulk`, { emails: list }), {
    invalidate: [['class', cls.id], ['dashboard'], ['classes']],
    onSuccess: setResult,
  });

  return (
    <Modal open onClose={onClose} title="Add students" size="lg" description="Students with an account are enrolled right away. Other addresses receive an invitation by e-mail."
      footer={result ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={MailPlus} loading={add.isPending} disabled={emails.length === 0 || emails.length > 200} onClick={() => add.mutate(emails)}>Add {emails.length > 0 ? plural(emails.length, 'address', 'addresses') : ''}</Button></>}>
      {result ? (
        <div className="space-y-3 text-sm">
          {result.enrolled.length > 0 && <Alert tone="ok" title={`${plural(result.enrolled.length, 'student')} enrolled`}>{result.enrolled.map((e) => e.name).join(', ')}</Alert>}
          {result.invited.length > 0 && <Alert tone="info" title={`${plural(result.invited.length, 'invitation')} sent`}>{result.invited.map((e) => e.email).join(', ')}</Alert>}
          {result.alreadyEnrolled.length + result.alreadyInvited.length > 0 && <Alert tone="info" title="Already in the class or invited">{[...result.alreadyEnrolled, ...result.alreadyInvited].map((e) => e.email).join(', ')}</Alert>}
          {result.invalid.length > 0 && (
            <Alert tone="warn" title={`${plural(result.invalid.length, 'address', 'addresses')} could not be added`}>
              <ul className="mt-1 list-disc pl-5">{result.invalid.map((e) => <li key={e.email}>{e.email} — {e.reason}</li>)}</ul>
            </Alert>
          )}
        </div>
      ) : (
        <Field label="E-mail addresses" hint="One per line, or separated by commas. You can paste a column from a spreadsheet.">
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'juan.delacruz@school.edu.ph\nmaria.clara@school.edu.ph'} spellCheck={false} autoCapitalize="none" className="font-mono text-[13px]" />
        </Field>
      )}
    </Modal>
  );
}
