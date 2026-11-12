// Administration → Users: every account, with approval, suspension, password reset and import.
import { useQuery } from '@tanstack/react-query';
import { Ban, Check, Copy, Download, KeyRound, Lock, Mail, MoreHorizontal, Pencil, RotateCcw, ShieldAlert, Unlock, Upload, UserPlus, UserX, Users as UsersIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, DescriptionList, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, PageHeader, PageLoader, Pagination, QueryState, SearchInput, Segmented, Select, Table, Tabs, Td, Textarea, Th, Tr, useDebounced } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { parseCsv, toCsv } from '../../lib/csv.js';
import { formatDateTime, plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';

const ROLE = { STUDENT: 'Student', TEACHER: 'Teacher', ADMIN: 'Administrator' };
const STATUS = { ACTIVE: { label: 'Active', tone: 'ok' }, PENDING: { label: 'Waiting for approval', tone: 'warn' }, SUSPENDED: { label: 'Suspended', tone: 'bad' }, DEACTIVATED: { label: 'Deactivated', tone: 'neutral' } };
const isLocked = (u) => u.lockedUntil && new Date(u.lockedUntil) > new Date();
const idNumber = (u) => u.studentProfile?.studentNumber ?? u.teacherProfile?.employeeNumber ?? null;

export function UserStatus({ user }) {
  const s = STATUS[user.status] ?? STATUS.ACTIVE;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={s.tone}>{s.label}</Badge>
      {isLocked(user) && <Badge tone="warn" icon={Lock}>Locked</Badge>}
      {user.anonymizedAt && <Badge>Anonymised</Badge>}
    </span>
  );
}

export default function AdminUsers() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const term = useDebounced(search.trim());
  const role = params.get('role') ?? '';
  const status = params.get('status') ?? '';
  const page = Number(params.get('page')) || 1;
  const openId = params.get('open');
  const patch = (changes) => setParams((prev) => { const next = new URLSearchParams(prev); for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); } return next; }, { replace: true });

  const query = useQuery({
    queryKey: ['admin', 'users', { term, role, status, page }],
    queryFn: () => api.list('/admin/users', { search: term || undefined, role: role || undefined, status: status || undefined, page, pageSize: 20 }),
    placeholderData: (prev) => prev,
  });
  const counts = query.data?.meta?.statusCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader title="Users" description="Accounts of students, teachers and administrators."
        actions={<><Button variant="secondary" icon={Upload} onClick={() => setDialog('import')}>Import</Button><Button icon={UserPlus} onClick={() => setDialog('create')}>New user</Button></>} />
      <Tabs className="mb-4" value={status} onChange={(next) => patch({ status: next, page: null })} tabs={[
        { value: '', label: 'All', count: total }, { value: 'PENDING', label: 'Waiting for approval', count: counts.PENDING }, { value: 'ACTIVE', label: 'Active', count: counts.ACTIVE },
        { value: 'SUSPENDED', label: 'Suspended', count: counts.SUSPENDED }, { value: 'DEACTIVATED', label: 'Deactivated', count: counts.DEACTIVATED },
      ]} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); if (page !== 1) patch({ page: null }); }} placeholder="Search by name, e-mail or ID number…" className="w-full sm:w-80" />
        <Segmented label="Role" value={role} onChange={(next) => patch({ role: next, page: null })} options={[{ value: '', label: 'Everyone' }, { value: 'STUDENT', label: 'Students' }, { value: 'TEACHER', label: 'Teachers' }, { value: 'ADMIN', label: 'Admins' }]} />
      </div>

      <QueryState query={{ ...query, data: query.data?.data }}>
        {(users) => users.length === 0 ? (
          <Card><EmptyState icon={UsersIcon} title="No accounts match" description={term || role || status ? 'Try another search or filter.' : 'Create the first account, or import a list.'} /></Card>
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th className="max-sm:hidden">Role</Th><Th className="max-md:hidden">ID number</Th><Th className="max-2xl:hidden">Program / department</Th><Th className="max-sm:hidden">Status</Th><Th className="max-xl:hidden">Last sign-in</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {users.map((u) => (
                <Tr key={u.id}>
                  {/* The name column takes whatever width is left and truncates instead of widening the table. */}
                  <Td className="w-full min-w-[11rem] max-w-0">
                    <button type="button" onClick={() => patch({ open: u.id })} className="flex w-full min-w-0 items-center gap-3 text-left">
                      <Avatar name={u.name} size={34} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink hover:text-brand">{u.name}</span>
                        <span className="block truncate text-xs text-faint">{u.email}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-soft sm:hidden">{ROLE[u.role]}<UserStatus user={u} /></span>
                      </span>
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap text-soft max-sm:hidden">{ROLE[u.role]}</Td>
                  <Td className="whitespace-nowrap tabular-nums text-soft max-md:hidden">{idNumber(u) ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-soft max-2xl:hidden">{u.studentProfile ? [u.studentProfile.program?.code, u.studentProfile.section?.name].filter(Boolean).join(' · ') || '—' : u.teacherProfile?.department?.code ?? '—'}</Td>
                  <Td className="whitespace-nowrap max-sm:hidden"><UserStatus user={u} /></Td>
                  <Td className="whitespace-nowrap text-soft max-xl:hidden">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</Td>
                  <Td className="w-px text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {u.status === 'PENDING' && <span className="max-xl:hidden"><ApproveButton user={u} /></span>}
                      <IconButton size="sm" icon={MoreHorizontal} label={`Open ${u.name}`} onClick={() => patch({ open: u.id })} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
      <Pagination meta={query.data?.meta} onPage={(p) => patch({ page: p > 1 ? String(p) : null })} />

      {openId && <UserDialog userId={openId} onClose={() => patch({ open: null })} />}
      {dialog === 'create' && <UserForm onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function ApproveButton({ user }) {
  const approve = useAction(() => api.post(`/admin/users/${user.id}/approve`), { invalidate: [['admin', 'users'], ['dashboard']], success: `${user.name} can now sign in.` });
  return <Button size="sm" icon={Check} loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>;
}

/** A password that is shown exactly once. */
function OneTimePassword({ password, name }) {
  return (
    <Alert tone="ok" title={`Temporary password for ${name}`}>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="rounded-lg bg-surface px-3 py-1.5 font-mono text-base font-semibold tracking-wide text-ink">{password}</code>
        <Button size="sm" variant="secondary" icon={Copy} onClick={() => navigator.clipboard?.writeText(password).then(() => toast.success('Copied.'), () => toast.error('Could not copy. Select the password and copy it manually.'))}>Copy</Button>
      </div>
      <p className="mt-2">Give it to the user privately. It is shown only now, and they must choose a new password when they sign in.</p>
    </Alert>
  );
}

function UserDialog({ userId, onClose }) {
  const { user: me, runtime } = useAuth();
  const query = useQuery({ queryKey: ['admin', 'users', userId], queryFn: () => api.get(`/admin/users/${userId}`), retry: false });
  const [step, setStep] = useState(null); // 'edit' | 'reset' | 'suspend' | 'deactivate' | 'anonymize'
  const [temp, setTemp] = useState(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const invalidate = [['admin', 'users'], ['dashboard']];
  const act = useAction(({ path, body }) => api.post(`/admin/users/${userId}/${path}`, body), {
    invalidate,
    onSuccess: (result, { path, done }) => {
      if (path === 'reset-password') setTemp(result.temporaryPassword);
      else if (path === 'send-invite') (result.delivered ? toast.success : toast.info)(result.message);
      else toast.success(done);
      setStep(null); setReason(''); setConfirm('');
    },
  });
  const u = query.data;
  const self = u?.id === me.id;
  const busy = (path) => act.isPending && act.variables?.path === path;

  return (
    <Modal open onClose={onClose} size="lg" title={u ? u.name : 'Account'} description={u ? `${ROLE[u.role]} · ${u.email}` : null}>
      {query.isPending ? <PageLoader /> : query.isError ? <Alert tone="bad">{query.error.message}</Alert> : step === 'edit' ? (
        <UserFields user={u} onCancel={() => setStep(null)} onSaved={() => setStep(null)} />
      ) : (
        <div className="space-y-5">
          {temp && <OneTimePassword password={temp} name={u.name} />}
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={u.name} size={56} />
            <div className="min-w-0 flex-1">
              <UserStatus user={u} />
              <p className="mt-1 text-[13px] text-faint">{u.lastLoginAt ? `Last sign-in ${formatDateTime(u.lastLoginAt)}` : 'Has never signed in'} · created {formatDateTime(u.createdAt)}</p>
            </div>
            {u.status === 'PENDING' && <Button icon={Check} loading={busy('approve')} onClick={() => act.mutate({ path: 'approve', done: `${u.name} can now sign in.` })}>Approve</Button>}
          </div>
          {u.status === 'SUSPENDED' && u.suspendedReason && <Alert tone="warn" title="Reason for suspension">{u.suspendedReason}</Alert>}
          {isLocked(u) && <Alert tone="warn" title="Locked after too many wrong passwords" action={<Button size="sm" variant="secondary" icon={Unlock} loading={busy('unlock')} onClick={() => act.mutate({ path: 'unlock', done: 'The account was unlocked.' })}>Unlock now</Button>}>Unlocks by itself {relativeTime(u.lockedUntil)}.</Alert>}

          <DescriptionList items={[
            ['E-mail', <span key="e">{u.email}{u.emailVerified || !runtime.email ? '' : <span className="font-normal text-faint"> · not verified</span>}</span>],
            u.phone && ['Mobile', u.phone],
            u.studentProfile && ['Student number', u.studentProfile.studentNumber],
            u.studentProfile && ['Program', u.studentProfile.program ? `${u.studentProfile.program.code} — ${u.studentProfile.program.name}` : null],
            u.studentProfile && ['Section', [u.studentProfile.section?.name, u.studentProfile.yearLevel ? `Year ${u.studentProfile.yearLevel}` : null].filter(Boolean).join(' · ') || null],
            u.teacherProfile && ['Employee number', u.teacherProfile.employeeNumber],
            u.teacherProfile && ['Department', u.teacherProfile.department ? `${u.teacherProfile.department.code} — ${u.teacherProfile.department.name}` : null],
            u.teacherProfile && ['Position', u.teacherProfile.position],
            ['Signed-in devices', u.activeSessions],
            u.mustChangePassword && ['Password', 'Temporary — must be changed at next sign-in'],
          ]} />

          {(u.classesTaught?.length > 0 || u.enrollments?.length > 0) && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{u.role === 'STUDENT' ? 'Classes' : 'Classes taught'}</p>
              <ul className="flex flex-wrap gap-1.5">
                {(u.classesTaught ?? []).map((c) => <li key={c.id}><Link to={`/classes/${c.id}`} className="inline-flex rounded-lg border border-line px-2.5 py-1 text-[13px] font-medium text-ink hover:border-brand hover:text-brand">{c.course.code} · {c.section?.name}{c.status === 'ARCHIVED' ? ' (archived)' : ''}</Link></li>)}
                {(u.enrollments ?? []).map((e) => <li key={e.id}><Link to={`/classes/${e.class.id}`} className="inline-flex rounded-lg border border-line px-2.5 py-1 text-[13px] font-medium text-ink hover:border-brand hover:text-brand">{e.class.course.code} · {e.class.section?.name}{e.status !== 'ENROLLED' ? ` (${e.status.toLowerCase()})` : ''}</Link></li>)}
              </ul>
            </div>
          )}

          {step === 'reset' && (
            <div className="rounded-xl border border-warn/40 p-4">
              <p className="text-sm font-semibold text-ink">Replace the password of {u.name}?</p>
              <p className="mt-1 text-sm text-soft">The password they use now stops working at once and they are signed out on every device. You get a temporary password to hand over, and they choose their own when they sign in with it.</p>
              <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setStep(null)}>Cancel</Button><Button icon={KeyRound} loading={busy('reset-password')} onClick={() => act.mutate({ path: 'reset-password' })}>Replace the password</Button></div>
            </div>
          )}
          {step === 'suspend' && (
            <div className="rounded-xl border border-bad/40 p-4">
              <Field label="Reason for suspending this account" hint="Recorded in the audit log. The user is signed out everywhere and cannot sign in."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-autofocus /></Field>
              <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setStep(null)}>Cancel</Button><Button variant="danger" loading={busy('suspend')} disabled={reason.trim().length < 3} onClick={() => act.mutate({ path: 'suspend', body: { reason: reason.trim() }, done: 'The account was suspended.' })}>Suspend account</Button></div>
            </div>
          )}
          {step === 'anonymize' && (
            <div className="rounded-xl border border-bad/40 p-4">
              <p className="text-sm font-semibold text-bad">Erase this person’s personal data</p>
              <p className="mt-1 text-sm text-soft">The name, e-mail, phone, picture and ID numbers are removed for good and the account can never sign in again. Grades, submissions and attendance are kept without identifying details, as school records require. This cannot be undone.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Reason (for the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Written request dated…" /></Field>
                <Field label="Type ANONYMIZE to confirm"><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></Field>
              </div>
              <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setStep(null)}>Cancel</Button><Button variant="danger" loading={busy('anonymize')} disabled={confirm !== 'ANONYMIZE' || reason.trim().length < 3} onClick={() => act.mutate({ path: 'anonymize', body: { confirm: 'ANONYMIZE', reason: reason.trim() }, done: 'Personal data was erased.' })}>Erase personal data</Button></div>
            </div>
          )}

          {!u.anonymizedAt && !step && (
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button variant="secondary" icon={Pencil} onClick={() => setStep('edit')}>Edit details</Button>
              <Button variant="secondary" icon={KeyRound} disabled={self} title={self ? 'Change your own password from your profile' : undefined} onClick={() => { setTemp(null); setStep('reset'); }}>Reset password</Button>
              {runtime.email && <Button variant="secondary" icon={Mail} loading={busy('send-invite')} onClick={() => act.mutate({ path: 'send-invite' })}>E-mail a set-password link</Button>}
              <Menu align="left" trigger={({ toggle, props }) => <Button variant="secondary" icon={MoreHorizontal} onClick={toggle} {...props}>More</Button>}>
                {(u.status === 'SUSPENDED' || u.status === 'DEACTIVATED') && <MenuItem icon={RotateCcw} onClick={() => act.mutate({ path: 'reactivate', done: 'The account is active again.' })}>Reactivate</MenuItem>}
                {u.status !== 'SUSPENDED' && u.status !== 'DEACTIVATED' && !self && <MenuItem icon={Ban} tone="danger" onClick={() => setStep('suspend')}>Suspend…</MenuItem>}
                {u.status !== 'DEACTIVATED' && !self && <MenuItem icon={UserX} tone="danger" onClick={() => setStep('deactivate')}>Deactivate…</MenuItem>}
                {u.role !== 'ADMIN' && <MenuItem icon={ShieldAlert} tone="danger" onClick={() => setStep('anonymize')}>Erase personal data…</MenuItem>}
              </Menu>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog open={step === 'deactivate'} onClose={() => setStep(null)} onConfirm={() => act.mutate({ path: 'deactivate', done: 'The account was deactivated.' })} loading={busy('deactivate')} title={`Deactivate ${u?.name ?? 'this account'}?`} confirmLabel="Deactivate">
        Use this when someone has left the school. They are signed out and can no longer sign in; their records stay intact, and the account can be reactivated later.
      </ConfirmDialog>
    </Modal>
  );
}

function useCatalog() {
  const programs = useQuery({ queryKey: ['catalog', 'programs'], queryFn: () => api.get('/catalog/programs'), staleTime: 60_000 });
  const sections = useQuery({ queryKey: ['catalog', 'sections'], queryFn: () => api.get('/catalog/sections'), staleTime: 60_000 });
  const departments = useQuery({ queryKey: ['catalog', 'departments'], queryFn: () => api.get('/catalog/departments'), staleTime: 60_000 });
  return { programs: programs.data ?? [], sections: sections.data ?? [], departments: departments.data ?? [] };
}

/** Shared fields for creating and editing an account. */
function UserFields({ user, onCancel, onSaved }) {
  const { programs, sections, departments } = useCatalog();
  const [v, setV] = useState({
    role: user?.role ?? 'STUDENT', firstName: user?.firstName ?? '', middleName: user?.middleName ?? '', lastName: user?.lastName ?? '', email: user?.email ?? '', phone: user?.phone ?? '', password: '',
    studentNumber: user?.studentProfile?.studentNumber ?? '', programId: user?.studentProfile?.programId ?? '', sectionId: user?.studentProfile?.sectionId ?? '', yearLevel: user?.studentProfile?.yearLevel ?? '',
    employeeNumber: user?.teacherProfile?.employeeNumber ?? '', departmentId: user?.teacherProfile?.departmentId ?? '', position: user?.teacherProfile?.position ?? '',
  });
  const [errors, setErrors] = useState({});
  const [created, setCreated] = useState(null);
  const set = (name) => (e) => setV((s) => ({ ...s, [name]: e.target.value }));
  const save = useAction(() => {
    const common = { firstName: v.firstName.trim(), lastName: v.lastName.trim(), middleName: v.middleName.trim() || null, email: v.email.trim() };
    const student = v.role === 'STUDENT' ? { ...(v.studentNumber.trim() ? { studentNumber: v.studentNumber.trim() } : {}), programId: v.programId || null, sectionId: v.sectionId || null, yearLevel: v.yearLevel ? Number(v.yearLevel) : null } : {};
    const teacher = v.role === 'TEACHER' ? { employeeNumber: v.employeeNumber.trim() || null, departmentId: v.departmentId || null, position: v.position.trim() || null } : {};
    if (user) return api.patch(`/admin/users/${user.id}`, { ...common, phone: v.phone.trim() || null, ...student, ...teacher });
    return api.post('/admin/users', { role: v.role, ...common, ...(v.password ? { password: v.password } : {}), ...student, ...teacher });
  }, {
    invalidate: [['admin', 'users'], ['dashboard']],
    onSuccess: (result) => { if (user) { toast.success('Account saved.'); onSaved(); } else setCreated(result); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  if (created) {
    return (
      <div className="space-y-4">
        {created.temporaryPassword ? <OneTimePassword password={created.temporaryPassword} name={created.user.name} /> : <Alert tone="ok">The account for {created.user.name} was created with the password you entered.</Alert>}
        <ModalActions><Button onClick={onSaved}>Done</Button></ModalActions>
      </div>
    );
  }
  const programSections = sections.filter((s) => !v.programId || !s.programId || s.programId === v.programId);
  return (
    <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-4">
      {!user && <Field label="Role"><Segmented label="Role" value={v.role} onChange={(role) => setV((s) => ({ ...s, role }))} options={[{ value: 'STUDENT', label: 'Student' }, { value: 'TEACHER', label: 'Teacher' }, { value: 'ADMIN', label: 'Administrator' }]} /></Field>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="First name" error={errors.firstName}><Input value={v.firstName} onChange={set('firstName')} required maxLength={80} /></Field>
        <Field label="Middle name" optional error={errors.middleName}><Input value={v.middleName} onChange={set('middleName')} maxLength={80} /></Field>
        <Field label="Last name" error={errors.lastName}><Input value={v.lastName} onChange={set('lastName')} required maxLength={80} /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="E-mail address" error={errors.email}><Input type="email" value={v.email} onChange={set('email')} required autoComplete="off" /></Field>
        {user ? <Field label="Mobile number" optional error={errors.phone}><Input value={v.phone} onChange={set('phone')} inputMode="tel" maxLength={30} /></Field>
          : <Field label="Password" optional error={errors.password} hint="Leave empty to generate a temporary password."><Input type="text" value={v.password} onChange={set('password')} autoComplete="off" /></Field>}
      </div>
      {v.role === 'STUDENT' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student number" optional={!user} error={errors.studentNumber}><Input value={v.studentNumber} onChange={set('studentNumber')} maxLength={40} placeholder="e.g. 2026-01011" /></Field>
          <Field label="Year level" optional error={errors.yearLevel}><Select value={v.yearLevel} onChange={set('yearLevel')}><option value="">—</option>{[1, 2, 3, 4, 5, 6].map((y) => <option key={y} value={y}>Year {y}</option>)}</Select></Field>
          <Field label="Program" optional error={errors.programId}><Select value={v.programId} onChange={set('programId')}><option value="">—</option>{programs.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</Select></Field>
          <Field label="Section" optional error={errors.sectionId}><Select value={v.sectionId} onChange={set('sectionId')}><option value="">—</option>{programSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        </div>
      )}
      {v.role === 'TEACHER' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Employee number" optional error={errors.employeeNumber}><Input value={v.employeeNumber} onChange={set('employeeNumber')} maxLength={40} /></Field>
          <Field label="Department" optional error={errors.departmentId}><Select value={v.departmentId} onChange={set('departmentId')}><option value="">—</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.code} — {d.name}</option>)}</Select></Field>
          <Field label="Position" optional error={errors.position}><Input value={v.position} onChange={set('position')} maxLength={120} /></Field>
        </div>
      )}
      {!user && v.role === 'ADMIN' && <Alert tone="warn">Administrators can see and change everything, including grades and other accounts. Give this role only to staff who need it.</Alert>}
      <ModalActions>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={save.isPending}>{user ? 'Save changes' : 'Create account'}</Button>
      </ModalActions>
    </form>
  );
}

function UserForm({ onClose }) {
  return <Modal open onClose={onClose} size="lg" title="New user" description="The account is active immediately."><UserFields onCancel={onClose} onSaved={onClose} /></Modal>;
}

const IMPORT_COLUMNS = ['role', 'firstName', 'lastName', 'email', 'studentNumber', 'employeeNumber', 'programCode', 'sectionName', 'departmentCode', 'yearLevel'];
const TEMPLATE = `role,firstName,lastName,email,studentNumber,employeeNumber,programCode,sectionName,departmentCode,yearLevel
STUDENT,Ana,Reyes,ana.reyes@example.edu.ph,2026-01021,,BSIT,BSIT 1A,,1
TEACHER,Ramon,Cruz,ramon.cruz@example.edu.ph,,EMP-2026-031,,,CCS,
`;
const download = (name, text) => { const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

/** Reads a CSV with a header row into import rows. Header names are matched loosely ("First Name" = firstName). */
export function readImport(text) {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length < 2) return { rows: [], problems: ['The file needs a header row and at least one account.'] };
  const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
  const aliases = { role: 'role', firstname: 'firstName', givenname: 'firstName', lastname: 'lastName', surname: 'lastName', familyname: 'lastName', email: 'email', emailaddress: 'email', studentnumber: 'studentNumber', studentno: 'studentNumber', studentid: 'studentNumber', employeenumber: 'employeeNumber', employeeno: 'employeeNumber', employeeid: 'employeeNumber', programcode: 'programCode', program: 'programCode', course: 'programCode', sectionname: 'sectionName', section: 'sectionName', departmentcode: 'departmentCode', department: 'departmentCode', yearlevel: 'yearLevel', year: 'yearLevel' };
  const header = table[0].map((h) => aliases[norm(h)] ?? null);
  const problems = [];
  for (const needed of ['role', 'firstName', 'lastName', 'email']) if (!header.includes(needed)) problems.push(`The column “${needed}” is missing.`);
  const rows = table.slice(1).map((cells) => {
    const row = {};
    header.forEach((name, i) => { const value = (cells[i] ?? '').trim(); if (name && value !== '') row[name] = value; });
    row.role = String(row.role ?? '').toUpperCase();
    return row;
  });
  rows.forEach((r, i) => { if (r.role !== 'STUDENT' && r.role !== 'TEACHER') problems.push(`Line ${i + 2}: role must be STUDENT or TEACHER.`); });
  if (rows.length > 500) problems.push('A file can contain at most 500 accounts. Split it into smaller files.');
  return { rows, problems: problems.slice(0, 8) };
}

function ImportDialog({ onClose }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const fileInput = useRef(null);
  const parsed = text.trim() ? readImport(text) : null;
  const run = useAction(() => api.post('/admin/users/import', { rows: parsed.rows }), { invalidate: [['admin', 'users'], ['dashboard']], onSuccess: setResult });
  const exportResult = () => download('imported-accounts.csv', toCsv([['line', 'email', 'name', 'role', 'result', 'temporaryPassword'], ...result.results.map((r) => [r.line, r.email, r.name ?? '', r.role ?? '', r.ok ? 'created' : r.error, r.temporaryPassword ?? ''])]));

  return (
    <Modal open onClose={onClose} size="xl" title="Import accounts" description="Create many student and teacher accounts from a spreadsheet saved as CSV."
      footer={result ? <><Button variant="secondary" icon={Download} onClick={exportResult}>Download the results</Button><Button onClick={onClose}>Done</Button></> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Upload} loading={run.isPending} disabled={!parsed || parsed.problems.length > 0 || parsed.rows.length === 0} onClick={() => run.mutate()}>Create {parsed?.rows.length ? plural(parsed.rows.length, 'account') : 'accounts'}</Button></>}>
      {result ? (
        <div className="space-y-4">
          <Alert tone={result.failed > 0 ? 'warn' : 'ok'} title={`${plural(result.created, 'account')} created${result.failed > 0 ? `, ${result.failed} skipped` : ''}`}>Download the results now: the temporary passwords are shown only once. Each user must choose a new password at first sign-in.</Alert>
          <Table className="max-h-[50vh] overflow-y-auto">
            <thead><tr><Th>Line</Th><Th>E-mail</Th><Th>Result</Th><Th>Temporary password</Th></tr></thead>
            <tbody>{result.results.map((r) => <Tr key={r.line}><Td className="tabular-nums text-faint">{r.line}</Td><Td>{r.email}</Td><Td>{r.ok ? <Badge tone="ok">Created</Badge> : <span className="text-bad">{r.error}</span>}</Td><Td className="font-mono">{r.temporaryPassword ?? '—'}</Td></Tr>)}</tbody>
          </Table>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={Upload} onClick={() => fileInput.current?.click()}>Choose a CSV file</Button>
            <Button variant="ghost" icon={Download} onClick={() => download('edusphere-accounts-template.csv', TEMPLATE)}>Download a template</Button>
            <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (file) setText(await file.text()); e.target.value = ''; }} />
          </div>
          <Field label="…or paste the rows here" hint={`Columns: ${IMPORT_COLUMNS.join(', ')}. Only role, firstName, lastName and email are required.`}>
            <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" spellCheck={false} placeholder={TEMPLATE} />
          </Field>
          {parsed?.problems.length > 0 && <Alert tone="bad" title="Fix these before importing"><ul className="list-disc pl-5">{parsed.problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert>}
          {parsed && parsed.problems.length === 0 && <Alert tone="info">{plural(parsed.rows.length, 'account')} will be created: {plural(parsed.rows.filter((r) => r.role === 'STUDENT').length, 'student')} and {plural(parsed.rows.filter((r) => r.role === 'TEACHER').length, 'teacher')}. Rows with a problem (for example an e-mail that is already used) are skipped and reported.</Alert>}
        </div>
      )}
    </Modal>
  );
}
