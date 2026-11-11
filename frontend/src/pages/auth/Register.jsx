import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Checkbox, Field, Input, PageLoader, Segmented, useForm } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import AuthLayout, { PasswordHints } from './AuthLayout.jsx';

export default function Register() {
  const config = useQuery({ queryKey: ['auth', 'config'], queryFn: () => api.get('/auth/config'), staleTime: 300_000 });
  const form = useForm({ role: 'STUDENT', firstName: '', lastName: '', email: '', password: '', studentNumber: '', acceptPrivacyNotice: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  if (config.isPending) return <AuthLayout title="Create your account"><PageLoader /></AuthLayout>;
  const student = config.data?.allowStudentSelfSignup;
  const teacher = config.data?.allowTeacherSelfSignup;

  if (done) {
    return (
      <AuthLayout title={done.requiresApproval ? 'Request received' : 'Account created'}>
        <div className="flex flex-col items-center rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          <CheckCircle2 className="size-12 text-ok" aria-hidden="true" />
          <p className="mt-4 text-sm leading-relaxed text-soft">{done.message}</p>
          <Button to="/login" state={{ email: form.values.email }} className="mt-6">Go to sign in</Button>
        </div>
      </AuthLayout>
    );
  }
  if (!student && !teacher) {
    return (
      <AuthLayout title="Registration is closed" footer={<Link to="/login" className="font-semibold text-brand hover:underline">Back to sign in</Link>}>
        <Alert tone="info">Accounts for this school are created by the administrator. Ask your registrar or teacher for an invitation.</Alert>
      </AuthLayout>
    );
  }

  const role = student && teacher ? form.values.role : student ? 'STUDENT' : 'TEACHER';
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { studentNumber, ...rest } = form.values;
      setDone(await api.post('/auth/register', { ...rest, role, ...(role === 'STUDENT' ? { studentNumber: studentNumber.trim() } : {}) }));
    } catch (err) {
      if (!form.fail(err)) setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create your account" subtitle={config.data?.institutionName} footer={<>Already have an account? <Link to="/login" className="font-semibold text-brand hover:underline">Sign in</Link></>}>
      {error && <Alert tone="bad" className="mb-5">{error}</Alert>}
      <form onSubmit={submit} className="space-y-4" noValidate>
        {student && teacher && (
          <Field label="I am a">
            <Segmented label="Account type" value={role} onChange={(v) => form.set('role', v)} options={[{ value: 'STUDENT', label: 'Student' }, { value: 'TEACHER', label: 'Teacher' }]} className="w-full [&>button]:flex-1" />
          </Field>
        )}
        {role === 'TEACHER' && <Alert tone="info">Teacher accounts are reviewed by an administrator before they can be used.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" error={form.errors.firstName}><Input autoComplete="given-name" required {...form.bind('firstName')} /></Field>
          <Field label="Last name" error={form.errors.lastName}><Input autoComplete="family-name" required {...form.bind('lastName')} /></Field>
        </div>
        {role === 'STUDENT' && (
          <Field label="Student number" error={form.errors.studentNumber} hint="As printed on your school ID."><Input required autoCapitalize="characters" {...form.bind('studentNumber')} placeholder="2026-00123" /></Field>
        )}
        <Field label="E-mail address" error={form.errors.email}><Input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" required {...form.bind('email')} /></Field>
        <Field label="Password" error={form.errors.password} hint={<PasswordHints />}><Input type="password" autoComplete="new-password" required {...form.bind('password')} /></Field>
        <div>
          <Checkbox
            checked={form.values.acceptPrivacyNotice}
            onChange={(e) => form.set('acceptPrivacyNotice', e.target.checked)}
            label={<>I have read the <Link to="/privacy" target="_blank" className="text-brand underline">privacy notice</Link> and agree to the processing of my personal data for school purposes.</>}
          />
          {form.errors.acceptPrivacyNotice && <p className="mt-1.5 text-[13px] text-bad" role="alert">Please accept the privacy notice to continue.</p>}
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy}>{role === 'TEACHER' ? 'Request a teacher account' : 'Create account'}</Button>
      </form>
    </AuthLayout>
  );
}
