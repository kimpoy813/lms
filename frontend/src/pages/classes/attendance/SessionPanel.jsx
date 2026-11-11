// One attendance session for the teacher: the rotating QR code and attendance code while it is
// open, the live roster, and corrections afterwards.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { AlertTriangle, CheckCheck, ChevronLeft, Clock, Download, Hash, Lock, MapPin, Maximize2, MoreHorizontal, QrCode, Radio, RefreshCw, RotateCcw, Save, Timer, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext.jsx';
import LazyMap from '../../../components/LazyMap.jsx';
import { toast } from '../../../components/toast.jsx';
import { Alert, Avatar, Badge, Button, Card, cn, ConfirmDialog, Field, IconButton, Input, Menu, MenuItem, Modal, QueryState, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatDateKey, formatDuration, formatTime, plural } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { getSocket } from '../../../lib/socket.js';
import { useClass } from '../useClass.js';
import { ATT, ATT_ORDER, Counts, METHOD } from './shared.jsx';

const REJECTION = {
  OUTSIDE_RADIUS: 'outside the allowed area', LOW_ACCURACY: 'location too imprecise', QR_EXPIRED: 'expired QR code', QR_INVALID: 'invalid QR code', CODE_INVALID: 'wrong code',
  CODE_EXPIRED: 'expired code', SESSION_ENDED: 'after check-in ended', SESSION_CLOSED: 'session closed', LOCATION_INVALID: 'unusable location', METHOD_NOT_ALLOWED: 'method not enabled', NOT_STARTED: 'before the start',
};

export default function SessionPanel({ sessionId, onBack }) {
  const { cls } = useClass();
  const client = useQueryClient();
  const key = useMemo(() => ['class', cls.id, 'attendance', 'session', sessionId], [cls.id, sessionId]);
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/attendance/sessions/${sessionId}`), refetchInterval: (q) => (q.state.data?.status === 'OPEN' ? 15_000 : false) });

  // Live updates: every check-in (or rejected attempt) arrives over the socket.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const watch = () => socket.emit('attendance:watch', sessionId);
    const onUpdate = (payload) => { if (payload.sessionId === sessionId) client.invalidateQueries({ queryKey: key }); };
    watch();
    socket.on('connect', watch);
    socket.on('attendance:update', onUpdate);
    return () => {
      socket.off('connect', watch);
      socket.off('attendance:update', onUpdate);
      socket.emit('attendance:unwatch', sessionId);
    };
  }, [sessionId, client, key]);

  return (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />All sessions</button>
      <QueryState query={query}>{(session) => <Session session={session} queryKey={key} />}</QueryState>
    </>
  );
}

function Session({ session, queryKey }) {
  const { cls } = useClass();
  const { can } = useAuth();
  const client = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const invalidate = [['class', cls.id, 'attendance'], ['attendance'], ['dashboard'], ['class', cls.id, 'gradebook']];
  const apply = (data) => client.setQueryData(queryKey, data);
  const open = session.status === 'OPEN';
  const readOnly = cls.status === 'ARCHIVED';

  const close = useAction(() => api.post(`/attendance/sessions/${session.id}/close`), { invalidate, success: 'Session closed. Students without a record were marked absent.', onSuccess: (d) => { apply(d); setDialog(null); } });
  const reopen = useAction(() => api.post(`/attendance/sessions/${session.id}/reopen`, { minutes: 15 }), { invalidate, success: 'Reopened for 15 minutes.', onSuccess: apply });
  const extend = useAction((minutes) => api.patch(`/attendance/sessions/${session.id}`, { extendMinutes: minutes }), { invalidate, success: 'Check-in time extended.', onSuccess: apply });
  const cancel = useAction(() => api.post(`/attendance/sessions/${session.id}/cancel`, { reason: cancelReason.trim() }), { invalidate, success: 'Session cancelled. It no longer counts.', onSuccess: (d) => { apply(d); setDialog(null); } });
  const exportAs = async (format) => {
    try {
      await api.download(`/attendance/sessions/${session.id}/export`, { format }, `attendance.${format}`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              {open ? <Badge tone="ok" icon={Radio}>Open for check-in</Badge> : session.status === 'CANCELLED' ? <Badge tone="bad" icon={XCircle}>Cancelled</Badge> : <Badge icon={Lock}>Closed</Badge>}
              {session.requireLocation && <Badge tone="brand" icon={MapPin}>Location check · {session.radiusMeters} m</Badge>}
              {session.allowQr && <Badge icon={QrCode}>QR</Badge>}
              {session.allowCode && <Badge icon={Hash}>Code</Badge>}
            </p>
            <h2 className="mt-2 text-xl font-bold tracking-tight text-ink">{session.title ?? 'Class meeting'} · {formatDateKey(session.date)}</h2>
            <p className="mt-0.5 text-sm text-soft">{formatTime(session.startTime)} – {formatTime(session.endTime)}{session.lateAfter ? ` · late after ${formatTime(session.lateAfter)}` : ''}{session.cancelReason ? ` · ${session.cancelReason}` : ''}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {open && !readOnly && <Button icon={Lock} onClick={() => setDialog('close')}>Close session</Button>}
            {session.status === 'CLOSED' && !readOnly && <Button variant="secondary" icon={RotateCcw} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen 15 min</Button>}
            <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} variant="secondary" label="More actions" onClick={toggle} {...props} />}>
              {open && !readOnly && <MenuItem icon={Timer} onClick={() => extend.mutate(10)}>Add 10 minutes</MenuItem>}
              {can('attendance.export') && <MenuItem icon={Download} onClick={() => exportAs('xlsx')}>Export to Excel</MenuItem>}
              {can('attendance.export') && <MenuItem icon={Download} onClick={() => exportAs('pdf')}>Export to PDF</MenuItem>}
              {session.status !== 'CANCELLED' && !readOnly && <MenuItem icon={XCircle} tone="danger" onClick={() => setDialog('cancel')}>Cancel this session</MenuItem>}
            </Menu>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
          <Counts counts={session.counts} />
          <p className="text-sm text-soft"><strong className="font-semibold text-ink">{session.counts.enrolled - session.counts.unmarked}</strong> of {session.counts.enrolled} recorded{session.pendingCorrections > 0 ? ` · ${plural(session.pendingCorrections, 'request')} waiting` : ''}</p>
        </div>
      </Card>

      {open && (session.allowQr || session.allowCode) && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {session.allowQr && <QrCard session={session} onProject={() => setDialog('project')} />}
          <div className="space-y-5">
            {session.allowCode && <CodeCard session={session} onChange={apply} readOnly={readOnly} />}
            {session.requireLocation && session.location && <LocationCard session={session} />}
          </div>
        </div>
      )}

      {session.rejectedAttempts.length > 0 && (
        <Card className="border-warn/40">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="size-4 text-warn" aria-hidden="true" />Check-ins that were not accepted</h3>
          <p className="mb-3 text-[13px] text-faint">A weak GPS signal is the usual cause. If the student is in the room, mark them yourself below — you will be asked for a reason.</p>
          <ul className="divide-y divide-line text-sm">
            {session.rejectedAttempts.slice(0, 12).map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
                <span className="font-medium text-ink">{a.studentName}</span>
                <span className="text-soft">{REJECTION[a.reason] ?? a.reason?.toLowerCase().replace(/_/g, ' ')}{a.distanceMeters != null ? ` · about ${a.distanceMeters} m away` : ''}{a.accuracyMeters != null ? ` · accuracy ±${a.accuracyMeters} m` : ''}</span>
                <span className="ml-auto text-xs text-faint">{formatTime(a.attemptedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {session.status !== 'CANCELLED' && <Roster key={session.status} session={session} onSaved={apply} invalidate={invalidate} readOnly={readOnly} />}

      <ConfirmDialog open={dialog === 'close'} onClose={() => setDialog(null)} onConfirm={() => close.mutate()} loading={close.isPending} tone="primary" title="Close this session?" confirmLabel="Close session">
        {session.counts.unmarked > 0 ? <>{plural(session.counts.unmarked, 'student')} without a record will be marked <strong className="text-ink">absent</strong>. You can still correct individual records afterwards.</> : 'Everyone has a record. Students can no longer check in.'}
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} onConfirm={() => cancel.mutate()} loading={cancel.isPending} title="Cancel this session?" confirmLabel="Cancel session">
        <p>A cancelled session does not count toward anyone’s attendance — for example when the class did not meet.</p>
        <Field label="Reason" className="mt-3"><Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. Class suspended due to typhoon" maxLength={300} /></Field>
      </ConfirmDialog>
      {dialog === 'project' && <ProjectQr session={session} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Fetches the current QR token and replaces it shortly before it expires. */
function useRotatingQr(session, size) {
  const [state, setState] = useState({ dataUrl: null, expiresAt: 0, rotation: session.qrRotationSeconds, error: null });
  const [left, setLeft] = useState(0);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const qr = await api.get(`/attendance/sessions/${session.id}/qr`);
      const dataUrl = await QRCode.toDataURL(qr.url, { errorCorrectionLevel: 'M', margin: 2, width: size, color: { dark: '#0f1222', light: '#ffffff' } });
      // Schedule against our own clock using the server's "expires in", so clock differences do not matter.
      const expiresAt = Date.now() + qr.expiresInMs;
      setState({ dataUrl, expiresAt, rotation: qr.rotationSeconds, error: null });
      clearTimeout(timer.current);
      if (qr.rotationSeconds > 0) timer.current = setTimeout(load, Math.max(500, qr.expiresInMs - 150));
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
      clearTimeout(timer.current);
      if (err.code !== 'SESSION_NOT_OPEN' && err.code !== 'QR_DISABLED') timer.current = setTimeout(load, 4000);
    }
  }, [session.id, size]);

  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000))), 250);
    return () => clearInterval(id);
  }, [state.expiresAt]);
  return { ...state, left };
}

function QrImage({ qr, className }) {
  if (qr.error && !qr.dataUrl) return <div className={cn('grid place-items-center rounded-2xl bg-raised p-6 text-center text-sm text-bad', className)}>{qr.error}</div>;
  if (!qr.dataUrl) return <div className={cn('animate-pulse rounded-2xl bg-raised', className)} />;
  // The code is always dark-on-white so that phone cameras read it in both colour themes.
  return <img src={qr.dataUrl} alt="QR code for attendance. Students scan it with the EduSphere check-in page or their phone camera." className={cn('rounded-2xl bg-white p-2', className)} />;
}

function Rotation({ qr }) {
  if (!qr.rotation) return <p className="text-[13px] text-faint">This code stays the same until the session closes.</p>;
  return (
    <div className="w-full max-w-xs">
      <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-brand-fill transition-[width] duration-300 ease-linear" style={{ width: `${Math.min(100, (qr.left / qr.rotation) * 100)}%` }} /></div>
      <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[13px] text-faint"><RefreshCw className="size-3.5" aria-hidden="true" />New code in {qr.left}s — photos of an old code will not work</p>
    </div>
  );
}

function QrCard({ session, onProject }) {
  const qr = useRotatingQr(session, 520);
  return (
    <Card className="flex flex-col items-center text-center">
      <div className="mb-3 flex w-full items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><QrCode className="size-4 text-brand" aria-hidden="true" />Scan to check in</h3>
        <Button size="sm" variant="secondary" icon={Maximize2} onClick={onProject}>Show full screen</Button>
      </div>
      <QrImage qr={qr} className="aspect-square w-full max-w-[19rem]" />
      <div className="mt-4 flex w-full flex-col items-center gap-2"><Rotation qr={qr} /></div>
      <p className="mt-3 text-[13px] text-soft">Students open <strong className="font-semibold text-ink">Check in</strong> in EduSphere, or point their phone camera at the code.</p>
    </Card>
  );
}

function CodeCard({ session, onChange, readOnly }) {
  const renew = useAction(() => api.post(`/attendance/sessions/${session.id}/code`, {}), { success: 'New code created. The old one no longer works.', onSuccess: (r) => onChange({ ...session, code: r.code, codeExpiresAt: r.codeExpiresAt }) });
  return (
    <Card className="text-center">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Hash className="size-4 text-brand" aria-hidden="true" />Attendance code</h3>
        {!readOnly && <Button size="sm" variant="ghost" icon={RefreshCw} loading={renew.isPending} onClick={() => renew.mutate()}>New code</Button>}
      </div>
      <p className="font-mono text-5xl font-bold tracking-[0.2em] text-ink tabular-nums" aria-label={`Attendance code ${session.code?.split('').join(' ')}`}>{session.code}</p>
      <p className="mt-2 text-[13px] text-soft">Students type this under <strong className="font-semibold text-ink">Check in</strong>.{session.requireLocation ? ' Their location is still checked.' : ''}</p>
    </Card>
  );
}

function LocationCard({ session }) {
  const policy = useQuery({ queryKey: ['attendance', 'policy'], queryFn: () => api.get('/attendance/policy'), staleTime: 300_000 });
  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><MapPin className="size-4 text-brand" aria-hidden="true" />Allowed area · {session.location.radiusMeters} m radius</h3>
      <LazyMap center={session.location} radius={session.location.radiusMeters} tileUrl={policy.data?.map?.tileUrl} attribution={policy.data?.map?.attribution} height={190} />
      <p className="mt-2 text-xs text-faint">Readings less precise than ±{session.location.maxAccuracyMeters} m are refused. Students’ coordinates are never stored — only how far they were.</p>
    </Card>
  );
}

function ProjectQr({ session, onClose }) {
  const qr = useRotatingQr(session, 900);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, (new Date(session.endTime).getTime() - Date.now()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { clearInterval(id); document.removeEventListener('keydown', onKey); };
  }, [session.endTime, onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-white p-6 text-[#0f1222]" role="dialog" aria-modal="true" aria-label="QR code for the class">
      <button type="button" onClick={onClose} className="absolute right-4 top-4 grid size-11 place-items-center rounded-full bg-black/5 hover:bg-black/10" aria-label="Close full screen"><X className="size-6" /></button>
      <p className="text-center text-2xl font-bold sm:text-3xl">{session.classLabel} — scan to check in</p>
      <QrImage qr={qr} className="aspect-square h-[min(62vh,90vw)] w-auto" />
      <div className="flex flex-col items-center gap-2 [&_p]:text-[#5b6178]"><Rotation qr={qr} /></div>
      <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2 text-center">
        {session.allowCode && <p className="text-lg">or enter code <span className="ml-2 font-mono text-4xl font-bold tracking-[0.2em]">{session.code}</span></p>}
        <p className="flex items-center gap-2 text-lg text-[#5b6178]"><Clock className="size-5" aria-hidden="true" />closes in {formatDuration(remaining)}</p>
      </div>
    </div>
  );
}

function Roster({ session, onSaved, invalidate, readOnly }) {
  const initial = useMemo(() => Object.fromEntries(session.roster.map((r) => [r.studentId, { status: r.record?.status ?? null, remarks: r.record?.remarks ?? '' }])), [session.roster]);
  const [marks, setMarks] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [reasonPrompt, setReasonPrompt] = useState(null);
  const [reason, setReason] = useState('');

  // Merge live check-ins into the form without discarding what the teacher is editing.
  if (seen !== initial) {
    setSeen(initial);
    setMarks((current) => Object.fromEntries(session.roster.map((r) => {
      const mine = current[r.studentId];
      const before = seen[r.studentId];
      const edited = mine && before && (mine.status !== before.status || mine.remarks !== before.remarks);
      return [r.studentId, edited ? mine : initial[r.studentId]];
    })));
  }

  const changed = session.roster.filter((r) => marks[r.studentId]?.status && (marks[r.studentId].status !== initial[r.studentId].status || (marks[r.studentId].remarks ?? '') !== (initial[r.studentId].remarks ?? '')));
  const save = useAction(({ withReason, andClose } = {}) => api.put(`/attendance/sessions/${session.id}/records`, {
    records: changed.map((r) => ({ studentId: r.studentId, status: marks[r.studentId].status, remarks: marks[r.studentId].remarks?.trim() || null })),
    ...(withReason ? { reason: reason.trim() } : {}),
    ...(andClose ? { close: true } : {}),
  }), {
    invalidate,
    success: (_, vars) => (vars?.andClose ? 'Attendance saved and session closed.' : 'Attendance saved.'),
    onSuccess: (data) => { setReasonPrompt(null); setReason(''); onSaved(data); },
    // Overriding a location check, or changing a closed session, needs a reason: ask for it and retry.
    onError: (err, vars) => { if (err.fields?.reason) { setReasonPrompt({ message: err.fields.reason, andClose: vars?.andClose }); return true; } return false; },
  });

  const setAll = (status) => setMarks((m) => Object.fromEntries(session.roster.map((r) => [r.studentId, m[r.studentId]?.status ? m[r.studentId] : { ...m[r.studentId], status }])));
  const open = session.status === 'OPEN';

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h3 className="text-[15px] font-semibold">Students</h3>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {session.counts.unmarked > 0 && <Button size="sm" variant="secondary" icon={CheckCheck} onClick={() => setAll('PRESENT')}>Mark the rest present</Button>}
            <Button size="sm" icon={Save} loading={save.isPending} disabled={changed.length === 0} onClick={() => save.mutate({})}>Save{changed.length > 0 ? ` ${changed.length} change${changed.length === 1 ? '' : 's'}` : ''}</Button>
          </div>
        )}
      </div>
      <ul className="divide-y divide-line">
        {session.roster.map((r) => {
          const mark = marks[r.studentId] ?? { status: null, remarks: '' };
          const dirty = changed.some((c) => c.studentId === r.studentId);
          return (
            <li key={r.studentId} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5', dirty && 'bg-brand-soft/40')}>
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <Avatar name={r.name} fileId={r.avatarFileId} size={34} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{r.name}</p>
                  <p className="truncate text-xs text-faint">
                    {r.record ? <>{METHOD[r.record.method] ?? r.record.method}{r.record.checkInTime && !['MANUAL', 'AUTO_ABSENT', 'TEACHER_OVERRIDE'].includes(r.record.method) ? ` · ${formatTime(r.record.checkInTime)}` : ''}{r.record.distanceMeters != null ? ` · ${Math.round(r.record.distanceMeters)} m from the pin` : ''}{r.record.overrideReason ? ` · “${r.record.overrideReason}”` : ''}</> : open ? 'Has not checked in yet' : 'No record'}
                    {r.rejectedAttempts > 0 && <span className="text-warn"> · {plural(r.rejectedAttempts, 'refused attempt')}</span>}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div role="radiogroup" aria-label={`Attendance for ${r.name}`} className="inline-flex rounded-lg border border-line bg-raised p-0.5">
                  {ATT_ORDER.map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={mark.status === k} disabled={readOnly} title={ATT[k].label} onClick={() => setMarks((m) => ({ ...m, [r.studentId]: { ...mark, status: k } }))}
                      className={cn('rounded-md px-2.5 py-1 text-xs font-semibold transition-colors sm:px-3', mark.status === k ? cn('shadow-sm', ATT[k].bg) : 'text-faint hover:text-ink')}>
                      <span className="sm:hidden">{ATT[k].short}</span><span className="max-sm:hidden">{ATT[k].label}</span>
                    </button>
                  ))}
                </div>
                <Input value={mark.remarks ?? ''} disabled={readOnly} onChange={(e) => setMarks((m) => ({ ...m, [r.studentId]: { ...mark, remarks: e.target.value } }))} placeholder="Remark" maxLength={300} aria-label={`Remark for ${r.name}`} className="h-8 w-36 text-[13px] max-sm:w-full" />
              </div>
            </li>
          );
        })}
      </ul>
      {open && !readOnly && changed.length > 0 && (
        <div className="flex justify-end border-t border-line px-4 py-3 sm:px-5">
          <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate({ andClose: true })}>Save and close the session</Button>
        </div>
      )}

      <Modal open={Boolean(reasonPrompt)} onClose={() => setReasonPrompt(null)} title="A reason is needed" size="sm"
        footer={<><Button variant="secondary" onClick={() => setReasonPrompt(null)}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 5} onClick={() => save.mutate({ withReason: true, andClose: reasonPrompt?.andClose })}>Save</Button></>}>
        <Alert tone="info" className="mb-4">{reasonPrompt?.message}</Alert>
        <Field label="Reason" hint="Kept with the record and in the audit log."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Student was in the room; phone GPS was not working" data-autofocus /></Field>
      </Modal>
    </Card>
  );
}
