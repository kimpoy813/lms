import { useQuery } from '@tanstack/react-query';
import { KeyRound, MailCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import AuthLayout from './AuthLayout.jsx';

export default function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email ?? '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  // A site without e-mail cannot send a link. It says so instead of promising one.
  const config = useQuery({ queryKey: ['auth', 'config'], queryFn: () => api.get('/auth/config'), staleTime: 300_000, retry: 1 });
  const [refused, setRefused] = useState(false);
  const noEmail = refused || config.data?.emailEnabled === false;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      if (err.code === 'EMAIL_NOT_AVAILABLE') setRefused(true);
      else setError(err.fields?.email ?? err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={noEmail ? 'Forgot your password?' : 'Reset your password'} subtitle={sent || noEmail ? null : 'Enter the e-mail address of your account and we will send you a link to choose a new password.'} footer={<Link to="/login" className="font-semibold text-brand hover:underline">Back to sign in</Link>}>
      {noEmail ? (
        <div className="flex flex-col items-center rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          <KeyRound className="size-12 text-brand" aria-hidden="true" />
          <p className="mt-4 font-semibold text-ink">Ask your school for a temporary password</p>
          <p className="mt-1.5 text-sm leading-relaxed text-soft">This site does not send e-mail, so it cannot send you a reset link. Tell your teacher or the school’s EduSphere administrator: an administrator can give you a temporary password, and you choose a new one when you sign in with it.</p>
        </div>
      ) : sent ? (
        <div className="flex flex-col items-center rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          <MailCheck className="size-12 text-brand" aria-hidden="true" />
          <p className="mt-4 font-semibold text-ink">Check your e-mail</p>
          <p className="mt-1.5 text-sm leading-relaxed text-soft">If an account exists for <strong className="font-semibold text-ink">{email}</strong>, a reset link has been sent. The link works once and expires after one hour.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="E-mail address"><Input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!email}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}
