// Shown when an administrator issued a temporary password: it must be replaced before anything else.
import { KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';
import { toast } from '../../components/toast.jsx';
import { api } from '../../lib/api.js';
import AuthLayout, { PasswordHints } from './AuthLayout.jsx';

export default function ChangePassword() {
  const { user, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  // Someone who has just replaced a temporary password starts on the dashboard. Someone who opens
  // this page without having to is sent to the profile, where a password is changed at will.
  const changedHere = useRef(false);
  if (!user.mustChangePassword) return <Navigate to={changedHere.current ? '/' : '/profile'} replace />;

  const set = (name) => (e) => setValues((v) => ({ ...v, [name]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (values.newPassword !== values.confirm) return setErrors({ confirm: 'The two passwords do not match.' });
    setBusy(true);
    setErrors({});
    try {
      await api.post('/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      changedHere.current = true;
      toast.success('Password changed.');
      await refresh(); // the session no longer demands a change: the line above the form redirects
    } catch (err) {
      setErrors(err.fields ?? { form: err.message });
      setBusy(false);
    }
    return undefined;
  };

  return (
    <AuthLayout title="Choose your own password" subtitle={`Hello ${user.firstName}. You signed in with a temporary password — replace it to continue.`} footer={<button type="button" onClick={() => logout().then(() => navigate('/login'))} className="font-semibold text-brand hover:underline">Sign out</button>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {errors.form && <Alert tone="bad">{errors.form}</Alert>}
        <Field label="Temporary password" error={errors.currentPassword}><Input type="password" autoComplete="current-password" required value={values.currentPassword} onChange={set('currentPassword')} autoFocus /></Field>
        <Field label="New password" error={errors.newPassword} hint={<PasswordHints />}><Input type="password" autoComplete="new-password" required value={values.newPassword} onChange={set('newPassword')} /></Field>
        <Field label="Repeat the new password" error={errors.confirm}><Input type="password" autoComplete="new-password" required value={values.confirm} onChange={set('confirm')} /></Field>
        <Button type="submit" size="lg" icon={KeyRound} className="w-full" loading={busy}>Save password</Button>
      </form>
    </AuthLayout>
  );
}
