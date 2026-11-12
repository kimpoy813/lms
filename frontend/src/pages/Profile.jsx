// Account page: personal details, picture, notifications, password and signed-in devices.
import { useQuery } from '@tanstack/react-query';
import { Camera, KeyRound, Laptop, LogOut, Save, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { toast } from '../components/toast.jsx';
import { Alert, Avatar, Badge, Button, Card, CardHeader, Field, Input, PageHeader, QueryState, Spinner, Switch, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDateTime, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { PasswordHints } from './auth/AuthLayout.jsx';

const ROLE = { STUDENT: 'Student', TEACHER: 'Teacher', ADMIN: 'Administrator' };

/** A short, human description of a browser's user-agent string. */
function describeDevice(ua = '') {
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iPhone / iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return { label: `${browser} on ${os}`, mobile: /Android|iPhone|iPad|iPod|Mobile/.test(ua) };
}

export default function Profile() {
  const { user, refresh, runtime } = useAuth();
  const [v, setV] = useState({
    firstName: user.firstName, lastName: user.lastName, middleName: user.middleName ?? '', phone: user.phone ?? '',
    position: user.teacherProfile?.position ?? '', specialization: user.teacherProfile?.specialization ?? '', consultationHours: user.teacherProfile?.consultationHours ?? '', bio: user.teacherProfile?.bio ?? '',
  });
  const [errors, setErrors] = useState({});
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);
  const set = (name) => (e) => setV((s) => ({ ...s, [name]: e.target.value }));

  const save = useAction((body) => api.patch('/auth/profile', body), {
    onSuccess: async () => { setErrors({}); await refresh(); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  const saveDetails = () => save.mutate({
    firstName: v.firstName.trim(), lastName: v.lastName.trim(), middleName: v.middleName.trim() || null, phone: v.phone.trim() || null,
    ...(user.role === 'TEACHER' ? { teacherProfile: { position: v.position.trim() || null, specialization: v.specialization.trim() || null, consultationHours: v.consultationHours.trim() || null, bio: v.bio.trim() || null } } : {}),
  }, { onSuccess: () => toast.success('Profile saved.') });

  const changePicture = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const [saved] = await api.upload([file], '/files?kind=image');
      await api.patch('/auth/profile', { avatarFileId: saved.id });
      await refresh();
      toast.success('Profile picture updated.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Profile and security" description="Your account details. Other people only see your name and picture." />
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-center gap-5">
            <div className="relative">
              <Avatar name={user.name} fileId={user.avatarFileId} size={84} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} className="absolute -bottom-1 -right-1 grid size-8 place-items-center rounded-full border-2 border-surface bg-brand-fill text-white hover:bg-brand-fill-hover" aria-label="Change profile picture">{uploading ? <Spinner className="size-4 text-white" label="Uploading" /> : <Camera className="size-4" />}</button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { changePicture(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-xl font-bold text-ink">{user.name}<Badge tone="brand">{ROLE[user.role]}</Badge>{user.isDemo && <Badge tone="warn">Demo account</Badge>}</p>
              <p className="text-sm text-soft">{user.email}{user.emailVerified || !runtime.email ? '' : ' · not verified'}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 text-[13px] text-faint">
                {user.studentProfile?.studentNumber && <span>Student no. {user.studentProfile.studentNumber}</span>}
                {user.teacherProfile?.employeeNumber && <span>Employee no. {user.teacherProfile.employeeNumber}</span>}
                {user.lastLoginAt && <span>Last sign-in {relativeTime(user.lastLoginAt)}</span>}
              </div>
            </div>
            {user.avatarFileId && <Button variant="ghost" size="sm" icon={Trash2} onClick={() => save.mutate({ avatarFileId: null }, { onSuccess: () => toast.success('Profile picture removed.') })}>Remove picture</Button>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Personal details" description="Your e-mail address and school numbers are managed by the administrator." />
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="First name" error={errors.firstName}><Input value={v.firstName} onChange={set('firstName')} autoComplete="given-name" maxLength={80} /></Field>
              <Field label="Middle name" optional error={errors.middleName}><Input value={v.middleName} onChange={set('middleName')} autoComplete="additional-name" maxLength={80} /></Field>
              <Field label="Last name" error={errors.lastName}><Input value={v.lastName} onChange={set('lastName')} autoComplete="family-name" maxLength={80} /></Field>
            </div>
            <Field label="Mobile number" optional error={errors.phone} hint="Visible only to the administrator." className="max-w-xs"><Input value={v.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="+63 9XX XXX XXXX" maxLength={30} /></Field>
            {user.role === 'TEACHER' && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Position" optional error={errors['teacherProfile.position']}><Input value={v.position} onChange={set('position')} placeholder="e.g. Assistant Professor" maxLength={120} /></Field>
                  <Field label="Specialization" optional><Input value={v.specialization} onChange={set('specialization')} maxLength={200} /></Field>
                </div>
                <Field label="Consultation hours" optional hint="Shown to your students on the class page."><Input value={v.consultationHours} onChange={set('consultationHours')} placeholder="e.g. Tue & Thu, 3:00–5:00 PM, Faculty Room" maxLength={300} /></Field>
                <Field label="About you" optional><Textarea rows={3} value={v.bio} onChange={set('bio')} maxLength={2000} /></Field>
              </>
            )}
            <div className="flex justify-end"><Button icon={Save} loading={save.isPending} onClick={saveDetails}>Save details</Button></div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Notifications" />
          <Switch checked={user.emailNotifications} onChange={(on) => save.mutate({ emailNotifications: on }, { onSuccess: () => toast.success(on ? 'E-mail notifications are on.' : 'E-mail notifications are off.') })} label="Also send important notifications by e-mail" disabled={!runtime.email && !user.emailNotifications}
            description={runtime.email ? 'Announcements, returned grades and attendance requests. You always receive them inside EduSphere.' : 'Not available: this site does not send e-mail. You receive every notification inside EduSphere.'} />
        </Card>

        <PasswordCard />
        <Sessions />

        <Card>
          <CardHeader icon={ShieldCheck} title="Your data" />
          <p className="text-sm leading-relaxed text-soft">EduSphere keeps the records your school needs: your classes, submissions, grades and attendance. Attendance location checks store only the distance to the classroom, never your coordinates. To correct or export your records, or to ask about deletion, contact your school’s registrar or data protection officer. See the <Link to="/privacy" className="font-medium text-brand hover:underline">privacy notice</Link>.</p>
        </Card>
      </div>
    </div>
  );
}

function PasswordCard() {
  const [v, setV] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const set = (name) => (e) => setV((s) => ({ ...s, [name]: e.target.value }));
  const change = useAction(() => api.post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }), {
    invalidate: [['auth', 'sessions']],
    success: (r) => r.message,
    onSuccess: () => { setV({ currentPassword: '', newPassword: '', confirm: '' }); setErrors({}); },
    onError: (err) => { setErrors(err.fields ?? { form: err.message }); return true; },
  });
  const submit = (e) => {
    e.preventDefault();
    if (v.newPassword !== v.confirm) return setErrors({ confirm: 'The two passwords do not match.' });
    setErrors({});
    return change.mutate();
  };
  return (
    <Card>
      <CardHeader icon={KeyRound} title="Password" description="Changing it signs you out on every other device." />
      <form onSubmit={submit} className="space-y-4">
        {errors.form && <Alert tone="bad">{errors.form}</Alert>}
        <Field label="Current password" error={errors.currentPassword} className="max-w-sm"><Input type="password" autoComplete="current-password" value={v.currentPassword} onChange={set('currentPassword')} required /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" error={errors.newPassword} hint={<PasswordHints />}><Input type="password" autoComplete="new-password" value={v.newPassword} onChange={set('newPassword')} required /></Field>
          <Field label="Repeat the new password" error={errors.confirm}><Input type="password" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} required /></Field>
        </div>
        <div className="flex justify-end"><Button type="submit" loading={change.isPending} disabled={!v.currentPassword || !v.newPassword}>Change password</Button></div>
      </form>
    </Card>
  );
}

function Sessions() {
  const { logout } = useAuth();
  const query = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => api.get('/auth/sessions') });
  const revoke = useAction((id) => api.delete(`/auth/sessions/${id}`), { invalidate: [['auth', 'sessions']], success: 'That device was signed out.' });
  return (
    <Card>
      <CardHeader title="Where you are signed in" description="Sign out any device you do not recognise, then change your password." />
      <QueryState query={query} loader={<Spinner />}>
        {(sessions) => (
          <ul className="divide-y divide-line">
            {sessions.map((s) => {
              const device = describeDevice(s.userAgent ?? '');
              const Icon = device.mobile ? Smartphone : Laptop;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-soft"><Icon className="size-5" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink">{device.label}{s.current && <Badge tone="ok">This device</Badge>}</p>
                    <p className="text-xs text-faint">Signed in {formatDateTime(s.createdAt)} · active {relativeTime(s.lastSeenAt)}{s.ipAddress ? ` · ${s.ipAddress}` : ''}</p>
                  </div>
                  {s.current ? <Button size="sm" variant="secondary" icon={LogOut} onClick={() => logout()}>Sign out</Button> : <Button size="sm" variant="secondary" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}
