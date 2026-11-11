import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, FlaskConical, GraduationCap, Presentation, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';
import { toast } from '../../components/toast.jsx';
import { api } from '../../lib/api.js';
import AuthLayout from './AuthLayout.jsx';

const ROLE_META = {
  ADMIN: { label: 'Administrator', icon: ShieldCheck },
  TEACHER: { label: 'Teacher', icon: Presentation },
  STUDENT: { label: 'Student', icon: GraduationCap },
};

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const config = useQuery({ queryKey: ['auth', 'config'], queryFn: () => api.get('/auth/config'), staleTime: 300_000, retry: 1 });

  const signIn = async (address, secret, key = 'form') => {
    setBusy(key);
    setProblem(null);
    try {
      await login(address, secret);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setProblem({ code: err.code, message: err.message, email: address });
      setBusy(null);
    }
  };

  const resend = async () => {
    try {
      const result = await api.post('/auth/resend-verification', { email: problem.email });
      toast.success(result?.message ?? 'If the address needs verifying, a new link is on its way.');
    } catch (err) {
      toast.error(err.message);
    }
  };

  // One of each role is enough to explore the system.
  const demo = config.data?.demoAccounts ?? [];
  const featured = ['ADMIN', 'TEACHER', 'STUDENT'].map((role) => demo.find((a) => a.role === role)).filter(Boolean);
  const canRegister = config.data && (config.data.allowStudentSelfSignup || config.data.allowTeacherSelfSignup);

  return (
    <AuthLayout
      title="Welcome back"
      subtitle={`Sign in to ${config.data?.institutionName ?? 'your EduSphere account'}.`}
      footer={canRegister ? <>New here? <Link to="/register" className="font-semibold text-brand hover:underline">Create an account</Link></> : null}
    >
      {location.state?.notice && <Alert tone="ok" className="mb-5">{location.state.notice}</Alert>}
      {problem && (
        <Alert tone={problem.code === 'ACCOUNT_PENDING' ? 'warn' : 'bad'} className="mb-5" title={problem.message}>
          {problem.code === 'EMAIL_NOT_VERIFIED' && <button type="button" onClick={resend} className="font-semibold text-brand hover:underline">Send the verification e-mail again</button>}
          {problem.code === 'INVALID_CREDENTIALS' && 'Check for typing mistakes, or reset your password.'}
        </Alert>
      )}

      <form onSubmit={(e) => { e.preventDefault(); signIn(email.trim(), password); }} className="space-y-4" noValidate>
        <Field label="E-mail address">
          <Input type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu.ph" autoFocus />
        </Field>
        <Field label="Password">
          <div className="relative">
            <Input type={show ? 'text' : 'password'} name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="pr-11" />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" state={{ email }} className="text-[13px] font-medium text-brand hover:underline">Forgot your password?</Link>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy === 'form'} disabled={!email || !password || Boolean(busy)}>Sign in</Button>
      </form>

      {featured.length > 0 && (
        <section className="mt-8 rounded-2xl border border-dashed border-line-strong bg-raised/50 p-4" aria-labelledby="demo-heading">
          <h2 id="demo-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><FlaskConical className="size-4 text-brand" aria-hidden="true" />Explore with a demo account</h2>
          <p className="mt-1 text-[13px] text-faint">Sample data for trying things out. Demo accounts are switched off in production.</p>
          <div className="mt-3 grid gap-2">
            {featured.map((account) => {
              const meta = ROLE_META[account.role];
              return (
                <button key={account.email} type="button" disabled={Boolean(busy)} onClick={() => signIn(account.email, 'Demo-Pass-2026', account.email)} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand disabled:opacity-60">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><meta.icon className="size-[18px]" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{meta.label}</span>
                    <span className="block truncate text-xs text-faint">{account.name} · {account.email}</span>
                  </span>
                  <span className="text-[13px] font-semibold text-brand">{busy === account.email ? 'Signing in…' : 'Sign in'}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </AuthLayout>
  );
}
