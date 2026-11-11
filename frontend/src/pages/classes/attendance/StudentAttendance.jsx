// A student's own attendance in one class, with a way to ask for a correction or an excuse.
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, MessageSquareWarning, Radio, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '../../../components/Files.jsx';
import { Alert, Badge, Button, Card, CardHeader, cn, EmptyState, Field, Modal, QueryState, Segmented, Select, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatDateKey, formatPercent, formatTime, relativeTime } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';
import { ATT, ATT_ORDER, StatusPill } from './shared.jsx';

export default function StudentAttendance() {
  const { cls } = useClass();
  const [requesting, setRequesting] = useState(null);
  const mine = useQuery({ queryKey: ['class', cls.id, 'attendance', 'mine'], queryFn: () => api.get('/attendance/mine', { classId: cls.id }) });
  const active = useQuery({ queryKey: ['attendance', 'active'], queryFn: () => api.get('/attendance/active'), refetchInterval: 30_000 });
  const open = (active.data ?? []).filter((s) => s.classId === cls.id && !s.record);

  return (
    <QueryState query={mine}>
      {(data) => {
        const c = data.classes[0] ?? { present: 0, late: 0, absent: 0, excused: 0, rate: null, records: [] };
        const pending = new Map(data.corrections.filter((r) => r.status === 'PENDING').map((r) => [r.sessionId, r]));
        return (
          <div className="space-y-5">
            {open.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-brand/30 bg-brand-soft p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-fill text-white"><Radio className="size-5" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1"><p className="font-semibold text-ink">Attendance is open now</p><p className="text-sm text-soft">Closes {formatTime(s.endTime)}{s.requireLocation ? ' · you need to be in the classroom' : ''}</p></div>
                <Button to="/attendance/scan" icon={ScanLine}>Check in</Button>
              </div>
            ))}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Card className="col-span-2 flex flex-col justify-center sm:col-span-1">
                <p className="text-[13px] font-medium text-soft">Attendance rate</p>
                <p className={cn('text-3xl font-bold tabular-nums', c.rate !== null && c.rate < 80 ? 'text-bad' : 'text-ink')}>{c.rate === null ? '—' : formatPercent(c.rate, 0)}</p>
              </Card>
              {ATT_ORDER.map((k) => (
                <Card key={k} className="p-4 text-center">
                  <p className={cn('text-2xl font-bold tabular-nums', c[k.toLowerCase()] > 0 ? ATT[k].text : 'text-faint')}>{c[k.toLowerCase()]}</p>
                  <p className="text-xs font-medium text-faint">{ATT[k].label}</p>
                </Card>
              ))}
            </div>

            <Card padded={false}>
              <div className="px-5 pt-5"><CardHeader icon={CalendarCheck} title="Class meetings" description="Something wrong? Ask your teacher for a correction, or send an excuse letter." /></div>
              {c.records.length === 0 ? <EmptyState compact icon={CalendarCheck} title="No attendance has been recorded yet" /> : (
                <ul className="divide-y divide-line border-t border-line">
                  {c.records.map((r) => {
                    const waiting = pending.get(r.sessionId);
                    return (
                      <li key={r.sessionId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                        <div className="min-w-0 flex-1 basis-48">
                          <p className="text-sm font-medium text-ink">{formatDateKey(r.date)}</p>
                          <p className="text-xs text-faint">{r.title ?? 'Class meeting'} · {r.methodLabel ?? 'Not recorded'}{r.checkInTime && ['QR', 'CODE', 'QR_GPS'].includes(r.method) ? ` at ${formatTime(r.checkInTime)}` : ''}{r.remarks ? ` · ${r.remarks}` : ''}</p>
                        </div>
                        {waiting ? <Badge tone="warn">Request sent {relativeTime(waiting.createdAt)}</Badge> : null}
                        <StatusPill status={r.status} />
                        {!waiting && r.sessionStatus !== 'OPEN' && cls.status !== 'ARCHIVED' && (
                          <Button size="sm" variant="ghost" icon={MessageSquareWarning} onClick={() => setRequesting(r)}>{r.status === 'ABSENT' ? 'Explain' : 'Request change'}</Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {data.corrections.length > 0 && (
              <Card>
                <CardHeader title="My requests" />
                <ul className="divide-y divide-line">
                  {data.corrections.map((r) => (
                    <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium text-ink">{formatDateKey(r.sessionDate)}</span><span className="text-soft">{r.type === 'EXCUSE' ? 'Excuse' : 'Correction'} → {r.requestedStatus.toLowerCase()}</span><Badge tone={r.status === 'APPROVED' ? 'ok' : r.status === 'REJECTED' ? 'bad' : 'warn'}>{r.status === 'APPROVED' ? 'Approved' : r.status === 'REJECTED' ? 'Declined' : 'Waiting'}</Badge></p>
                      <p className="mt-1 text-[13px] text-soft">{r.reason}</p>
                      {r.reviewNote && <p className="mt-1 text-[13px] text-soft"><span className="font-medium text-ink">Teacher:</span> {r.reviewNote}</p>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {requesting && <RequestDialog record={requesting} onClose={() => setRequesting(null)} />}
          </div>
        );
      }}
    </QueryState>
  );
}

function RequestDialog({ record, onClose }) {
  const { cls } = useClass();
  const [type, setType] = useState(record.status === 'ABSENT' ? 'EXCUSE' : 'CORRECTION');
  const [requested, setRequested] = useState(record.status === 'ABSENT' ? 'PRESENT' : 'PRESENT');
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState([]);
  const [errors, setErrors] = useState({});
  const send = useAction(() => api.post(`/attendance/sessions/${record.sessionId}/corrections`, { type, requestedStatus: type === 'EXCUSE' ? 'EXCUSED' : requested, reason: reason.trim(), fileIds: files.map((f) => f.id) }), {
    invalidate: [['class', cls.id, 'attendance'], ['dashboard']],
    success: 'Request sent to your teacher.',
    onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  return (
    <Modal open onClose={onClose} title={`Attendance on ${formatDateKey(record.date)}`} description="Your teacher decides. You will be notified of the answer."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={send.isPending} disabled={reason.trim().length < 5} onClick={() => send.mutate()}>Send request</Button></>}>
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm text-soft">Currently recorded as <StatusPill status={record.status} /></p>
        <Field label="What are you asking for?">
          <Segmented label="Kind of request" value={type} onChange={setType} className="w-full [&>button]:flex-1" options={[{ value: 'CORRECTION', label: 'The record is wrong' }, { value: 'EXCUSE', label: 'Excuse my absence' }]} />
        </Field>
        {type === 'CORRECTION' && (
          <Field label="It should be" error={errors.requestedStatus}>
            <Select value={requested} onChange={(e) => setRequested(e.target.value)}>
              {ATT_ORDER.filter((k) => k !== record.status && k !== 'EXCUSED').map((k) => <option key={k} value={k}>{ATT[k].label}</option>)}
            </Select>
          </Field>
        )}
        <Field label={type === 'EXCUSE' ? 'Reason for the absence' : 'What happened?'} error={errors.reason} hint="At least a short sentence.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder={type === 'EXCUSE' ? 'e.g. I had a fever and went to the health centre.' : 'e.g. I was in class but my phone could not get a GPS signal.'} />
        </Field>
        <Field label={type === 'EXCUSE' ? 'Excuse letter or medical certificate' : 'Proof'} optional error={errors.fileIds}>
          <FileUpload value={files} onChange={setFiles} max={3} compact label="Attach a photo or PDF" accept="image/*,application/pdf" />
        </Field>
        {type === 'EXCUSE' && <Alert tone="info">Documents you attach are visible only to your teacher and the school administrator.</Alert>}
      </div>
    </Modal>
  );
}
