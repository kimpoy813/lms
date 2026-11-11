// Choose a password from an e-mailed link: either a password reset or a new-account invitation.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import AuthLayout, { PasswordHints } from './AuthLayout.jsx';

export default function SetPassword({ mode }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const invite = mode === 'invite';

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setErrors({ confirm: 'The two passwords do not match.' });
    setBusy(true);
    setErrors({});
    try {
      const result = await api.post(invite ? '/auth/accept-invite' : '/auth/reset-password', { token, password });
      navigate('/login', { replace: true, state: { notice: result.message } });
    } catch (err) {
      setErrors(err.fields ?? { form: err.message });
      setBusy(false);
    }
    return undefined;
  };

  if (!token) {
    return (
      <AuthLayout title="This link is incomplete" footer={<Link to="/login" className="font-semibold text-brand hover:underline">Back to sign in</Link>}>
        <Alert tone="warn">Open the link from your e-mail again, or copy the whole address into the browser.</Alert>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={invite ? 'Set up your account' : 'Choose a new password'} subtitle={invite ? 'Choose a password to finish creating your EduSphere account.' : 'After saving, every device signed in to your account is signed out.'} footer={<Link to="/login" className="font-semibold text-brand hover:underline">Back to sign in</Link>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {(errors.form || errors.token) && (
          <Alert tone="bad" title={errors.form ?? errors.token}>
            {!invite && <Link to="/forgot-password" className="font-semibold text-brand hover:underline">Request a new link</Link>}
          </Alert>
        )}
        <Field label="New password" error={errors.password} hint={<PasswordHints />}><Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
        <Field label="Repeat the password" error={errors.confirm}><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!password || !confirm}>{invite ? 'Save and continue' : 'Change password'}</Button>
      </form>
    </AuthLayout>
  );
}
