import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, PageLoader } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import AuthLayout from './AuthLayout.jsx';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState({ status: token ? 'working' : 'failed', message: token ? null : 'This verification link is incomplete.' });
  const started = useRef(false);

  useEffect(() => {
    // The link works once, so guard against the effect running twice in development.
    if (!token || started.current) return;
    started.current = true;
    api.post('/auth/verify-email', { token })
      .then((r) => setState({ status: 'done', message: r?.message ?? 'Your e-mail address is verified.' }))
      .catch((err) => setState({ status: 'failed', message: err.message }));
  }, [token]);

  return (
    <AuthLayout title="E-mail verification">
      {state.status === 'working' ? <PageLoader label="Verifying your e-mail address…" /> : (
        <div className="flex flex-col items-center rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          {state.status === 'done' ? <CheckCircle2 className="size-12 text-ok" aria-hidden="true" /> : <XCircle className="size-12 text-bad" aria-hidden="true" />}
          <p className="mt-4 text-sm leading-relaxed text-soft">{state.message}</p>
          {state.status === 'failed' && <p className="mt-2 text-[13px] text-faint">Links expire after 48 hours and work once. Sign in to request a new one.</p>}
          <Button to="/login" className="mt-6">Go to sign in</Button>
        </div>
      )}
    </AuthLayout>
  );
}
