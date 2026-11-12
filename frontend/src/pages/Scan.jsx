// Student check-in. Three ways in: scanning the teacher's QR code with this page, opening the
// link behind the QR code with the phone's camera app (?t=…), or typing the attendance code.
// When the teacher requires it, the device's location is read once and checked by the server.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Hash, Loader2, LocateFixed, MapPin, QrCode, Radio, RotateCcw, ScanLine, ShieldCheck } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Alert, Badge, Button, Card, cn, EmptyState, Input, PageHeader, Skeleton, Tabs } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { readLocation } from '../lib/geo.js';

const QrScanner = lazy(() => import('../components/QrScanner.jsx'));

/** The token inside a scanned QR code: either the check-in link or the bare token. */
function tokenFrom(text) {
  try {
    const url = new URL(text);
    return url.searchParams.get('t');
  } catch {
    return /^[\w.-]{20,}$/.test(text) ? text : null;
  }
}

export default function Scan() {
  const { isStudent } = useAuth();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  // Until the student picks a tab, the page opens on the way the open class meeting accepts.
  const [chosenMethod, setMethod] = useState(null);
  const [code, setCode] = useState('');
  // stage: idle | sending | locating | done | failed
  const [state, setState] = useState({ stage: 'idle' });
  const busy = useRef(false);
  const active = useQuery({ queryKey: ['attendance', 'active'], queryFn: () => api.get('/attendance/active'), enabled: isStudent, refetchInterval: 20_000 });

  const run = useCallback(async (credential) => {
    if (busy.current) return;
    busy.current = true;
    let current = credential;
    let location;
    try {
      for (let step = 0; step < 3; step += 1) {
        setState((s) => ({ stage: location ? 'sending' : s.stage === 'locating' ? 'locating' : 'sending', session: s.session }));
        const result = await api.post('/attendance/check-in', { ...current, ...(location ? { location } : {}) });
        if (result.status !== 'LOCATION_REQUIRED') {
          setState({ stage: 'done', result });
          client.invalidateQueries({ queryKey: ['attendance'] });
          client.invalidateQueries({ queryKey: ['dashboard'] });
          client.invalidateQueries({ queryKey: ['class', result.session.classId, 'attendance'] });
          return;
        }
        // The code was accepted; now the server needs to know where this device is.
        current = { ticket: result.ticket };
        setState({ stage: 'locating', session: result.session, accuracy: null });
        location = await readLocation({ goodEnoughMeters: 25, maxWaitMs: 14_000, onProgress: (accuracy) => setState((s) => (s.stage === 'locating' ? { ...s, accuracy } : s)) });
      }
      setState({ stage: 'failed', message: 'Your location could not be confirmed. Please try again.', retry: current });
    } catch (err) {
      const details = err.details ?? {};
      setState({
        stage: 'failed', code: err.code ?? (err.name === 'LocationError' ? `LOCATION_${err.code}` : 'ERROR'), message: err.message, details,
        // A ticket means the QR code or attendance code was already accepted: only the location must be retried.
        retry: details.ticket ? { ticket: details.ticket } : err.name === 'LocationError' ? current : null,
      });
    } finally {
      busy.current = false;
    }
  }, [client]);

  // Arriving from the phone's camera app: the link carries the token.
  const linkToken = params.get('t');
  useEffect(() => {
    if (!linkToken || !isStudent) return;
    setParams({}, { replace: true });
    run({ token: linkToken });
  }, [linkToken, isStudent, run, setParams]);

  if (!isStudent) {
    return (
      <>
        <PageHeader title="Check in" />
        <Card><EmptyState icon={ScanLine} title="Check-in is for students" description="To take attendance, open a class and choose Attendance → Take attendance." /></Card>
      </>
    );
  }

  const reset = () => { setState({ stage: 'idle' }); setCode(''); };
  const open = (active.data ?? []).filter((s) => !s.record);
  const recorded = (active.data ?? []).filter((s) => s.record);
  const method = chosenMethod ?? (open.length > 0 && open.every((s) => !s.allowQr) ? 'code' : 'qr');

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Check in" description="Record your attendance for a class that is meeting now." />

      {state.stage === 'done' && <Done result={state.result} onAgain={reset} />}
      {state.stage === 'failed' && <Failed state={state} onRetry={() => run(state.retry)} onStartOver={reset} />}
      {(state.stage === 'sending' || state.stage === 'locating') && (
        <Card className="py-10 text-center" role="status">
          {state.stage === 'locating' ? (
            <>
              <span className="mx-auto grid size-16 place-items-center rounded-full bg-brand-soft text-brand"><LocateFixed className="size-8 animate-pulse" aria-hidden="true" /></span>
              <p className="mt-4 text-lg font-semibold text-ink">Checking that you are in the classroom…</p>
              <p className="mt-1 text-sm text-soft">{state.session?.classLabel} · allowed within {state.session?.radiusMeters} m</p>
              <p className="mt-3 text-sm tabular-nums text-faint">{state.accuracy ? `Current accuracy: ±${state.accuracy} m` : 'Allow location access if your browser asks.'}</p>
              <p className="mx-auto mt-4 flex max-w-sm items-start gap-2 text-left text-xs text-faint"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />Your location is used once, to measure the distance to the classroom. Your coordinates are not stored and you are not tracked.</p>
            </>
          ) : (
            <><Loader2 className="mx-auto size-10 animate-spin text-brand" aria-hidden="true" /><p className="mt-4 font-semibold text-ink">Recording your attendance…</p></>
          )}
        </Card>
      )}

      {state.stage === 'idle' && (
        <div className="space-y-5">
          {active.isSuccess && open.length === 0 && recorded.length === 0 && <Alert tone="info" title="No class is taking attendance right now">When your teacher opens attendance, scan the QR code or type the code they show.</Alert>}
          {open.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-brand/30 bg-brand-soft p-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-fill text-white"><Radio className="size-5" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-ink">{s.classLabel} — attendance is open</p>
                <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-soft">Closes {formatTime(s.endTime)}{s.lateAfter ? ` · late after ${formatTime(s.lateAfter)}` : ''}{s.requireLocation && <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden="true" />in the classroom ({s.radiusMeters} m)</span>}</p>
              </div>
            </div>
          ))}
          {recorded.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-ok/30 bg-ok-soft p-4">
              <CheckCircle2 className="size-6 shrink-0 text-ok" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm font-medium text-ink">{s.classLabel}: you are marked {s.record.status.toLowerCase()}.</p>
            </div>
          ))}

          <Card>
            <Tabs className="mb-5" value={method} onChange={setMethod} tabs={[{ value: 'qr', label: 'Scan QR code', icon: QrCode }, { value: 'code', label: 'Type the code', icon: Hash }]} />
            {method === 'qr' ? (
              <Suspense fallback={<Skeleton className="aspect-square w-full rounded-2xl" />}>
                <QrScanner onResult={(text) => { const token = tokenFrom(text); if (token) run({ token }); else setState({ stage: 'failed', code: 'QR_INVALID', message: 'That is not an EduSphere attendance code. Scan the code on your teacher’s screen.', retry: null }); }} />
              </Suspense>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); if (code.length >= 4) run({ code }); }} className="space-y-4">
                <label className="block text-sm font-medium text-ink" htmlFor="attendance-code">Attendance code from your teacher</label>
                <Input id="attendance-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className="h-16 text-center font-mono text-3xl tracking-[0.3em]" autoFocus />
                <Button type="submit" size="lg" className="w-full" disabled={code.length < 4}>Check in</Button>
              </form>
            )}
          </Card>
          <p className="flex items-start gap-2 px-1 text-xs text-faint"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />If your teacher requires a location check, your phone’s location is read once and only the distance to the classroom is kept. Checking in for someone else is a violation of school rules.</p>
        </div>
      )}
    </div>
  );
}

function Done({ result, onAgain }) {
  const { record, session } = result;
  const late = record.status === 'LATE';
  return (
    <Card className={cn('py-10 text-center', late ? 'border-warn/50' : 'border-ok/50')} role="status">
      <span className={cn('mx-auto grid size-20 place-items-center rounded-full', late ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok')}><CheckCircle2 className="size-11" aria-hidden="true" /></span>
      <p className="mt-5 text-2xl font-bold text-ink">{result.status === 'ALREADY_RECORDED' ? 'Already recorded' : late ? 'Checked in — late' : 'You are checked in'}</p>
      <p className="mt-1 text-soft">{session.classLabel}{session.courseTitle ? ` · ${session.courseTitle}` : ''}</p>
      <p className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm">
        <Badge tone={late ? 'warn' : record.status === 'PRESENT' ? 'ok' : 'neutral'}>{record.status.charAt(0) + record.status.slice(1).toLowerCase()}</Badge>
        {record.checkInTime && <span className="text-faint">at {formatTime(record.checkInTime)}</span>}
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <Button to={`/classes/${session.classId}/attendance`} variant="secondary">My attendance</Button>
        <Button variant="ghost" onClick={onAgain}>Check in to another class</Button>
      </div>
    </Card>
  );
}

const TIPS = {
  OUTSIDE_RADIUS: (d) => [`Your device appears to be about ${d.distanceMeters} m from the classroom; the limit is ${d.radiusMeters} m.`, 'If you are in the room, your phone’s GPS may be off — move near a window and try again, or ask your teacher to mark you.'],
  LOW_ACCURACY: (d) => [`Your phone could only place you within ±${d.accuracyMeters ?? '?'} m; ±${d.requiredAccuracyMeters} m or better is needed.`, 'Turn on precise location (GPS and Wi-Fi), move near a window, wait a few seconds and try again.'],
  LOCATION_DENIED: () => ['On Android: tap the lock icon in the address bar → Permissions → Location → Allow.', 'On iPhone: Settings → Privacy → Location Services → your browser → While Using.'],
  LOCATION_UNAVAILABLE: () => ['Turn on Location in your phone’s quick settings, then try again.'],
  LOCATION_TIMEOUT: () => ['Move near a window or outdoors so your phone can see GPS satellites, then try again.'],
  QR_EXPIRED: () => ['The code on your teacher’s screen changes every few seconds. Scan the one showing now.'],
  TOO_MANY_ATTEMPTS: () => ['Wait a minute before trying again, or ask your teacher to mark you.'],
};

function Failed({ state, onRetry, onStartOver }) {
  const tips = TIPS[state.code]?.(state.details ?? {}) ?? [];
  return (
    <Card className="border-bad/40 py-8 text-center" role="alert">
      <span className="mx-auto grid size-16 place-items-center rounded-full bg-bad-soft text-bad"><AlertTriangle className="size-8" aria-hidden="true" /></span>
      <p className="mt-4 text-xl font-bold text-ink">Not checked in yet</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-soft">{state.message}</p>
      {tips.length > 0 && <ul className="mx-auto mt-4 max-w-md space-y-1.5 rounded-xl bg-raised p-4 text-left text-[13px] text-soft">{tips.map((t) => <li key={t} className="flex gap-2"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden="true" />{t}</li>)}</ul>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {state.retry && <Button icon={LocateFixed} onClick={onRetry}>Check my location again</Button>}
        <Button variant={state.retry ? 'secondary' : 'primary'} icon={RotateCcw} onClick={onStartOver}>{state.retry ? 'Start over' : 'Try again'}</Button>
      </div>
      <p className="mt-4 text-xs text-faint">Your teacher can see that a check-in was refused and why, and can mark you present if you are in the room.</p>
    </Card>
  );
}
