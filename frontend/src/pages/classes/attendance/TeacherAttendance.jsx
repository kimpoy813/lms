import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Check, ClipboardList, Download, Hash, Inbox, MapPin, QrCode, Radio, Table2, UserCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { FileList } from '../../../components/Files.jsx';
import { toast } from '../../../components/toast.jsx';
import { Avatar, Badge, Button, Card, cn, EmptyState, Field, Menu, MenuItem, Modal, QueryState, Tabs, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatDateKey, formatPercent, formatTime, relativeTime } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';
import SessionPanel from './SessionPanel.jsx';
import { Counts, StatusCell, StatusPill } from './shared.jsx';
import StartSession from './StartSession.jsx';

export default function TeacherAttendance() {
  const { cls, base } = useClass();
  const [params, setParams] = useSearchParams();
  const [starting, setStarting] = useState(false);
  const sessionId = params.get('session');
  const tab = params.get('tab') ?? 'sessions';
  const sessions = useQuery({ queryKey: ['class', cls.id, 'attendance', 'sessions'], queryFn: () => api.get(`${base}/attendance/sessions`) });
  const requests = useQuery({ queryKey: ['class', cls.id, 'attendance', 'corrections'], queryFn: () => api.get('/attendance/corrections', { classId: cls.id, status: 'PENDING' }) });
  const readOnly = cls.status === 'ARCHIVED';

  if (sessionId) return <SessionPanel key={sessionId} sessionId={sessionId} onBack={() => setParams({})} />;
  const openSession = (sessions.data ?? []).find((s) => s.status === 'OPEN');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs className="min-w-0 flex-1 border-b-0" value={tab} onChange={(t) => setParams(t === 'sessions' ? {} : { tab: t })} tabs={[
          { value: 'sessions', label: 'Sessions', icon: CalendarCheck },
          { value: 'summary', label: 'Summary', icon: Table2 },
          { value: 'requests', label: 'Requests', icon: Inbox, count: requests.data?.length },
        ]} />
        {openSession
          ? <Button icon={Radio} onClick={() => setParams({ session: openSession.id })}>Open session in progress</Button>
          : <Button icon={UserCheck} onClick={() => setStarting(true)} disabled={readOnly}>Take attendance</Button>}
      </div>

      {tab === 'sessions' && (
        <QueryState query={sessions}>
          {(list) => list.length === 0 ? (
            <Card><EmptyState icon={CalendarCheck} title="No attendance has been taken yet" description="Start a session to mark students yourself, or let them check in with a QR code, a short code and an optional location check." action={readOnly ? null : <Button icon={UserCheck} onClick={() => setStarting(true)}>Take attendance</Button>} /></Card>
          ) : (
            <ul className="space-y-2.5">
              {list.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setParams({ session: s.id })} className={cn('flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-surface p-4 text-left shadow-card transition-colors hover:border-line-strong', s.status === 'OPEN' ? 'border-ok/50' : 'border-line')}>
                    <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', s.status === 'OPEN' ? 'bg-ok-soft text-ok' : s.status === 'CANCELLED' ? 'bg-raised text-faint' : 'bg-brand-soft text-brand')}>{s.status === 'OPEN' ? <Radio className="size-5" aria-hidden="true" /> : <ClipboardList className="size-5" aria-hidden="true" />}</span>
                    <span className="min-w-0 flex-1 basis-52">
                      <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">{formatDateKey(s.date)}{s.status === 'OPEN' && <Badge tone="ok">Open</Badge>}{s.status === 'CANCELLED' && <Badge tone="bad">Cancelled</Badge>}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-faint">
                        {s.title ?? 'Class meeting'} · {formatTime(s.startTime)}–{formatTime(s.endTime)}
                        {s.allowQr && <QrCode className="size-3.5" aria-label="QR check-in" />}
                        {s.allowCode && <Hash className="size-3.5" aria-label="Code check-in" />}
                        {s.requireLocation && <span className="inline-flex items-center gap-0.5"><MapPin className="size-3.5" aria-hidden="true" />{s.radiusMeters} m</span>}
                      </span>
                    </span>
                    {s.status !== 'CANCELLED' && <Counts counts={s.counts} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      )}
      {tab === 'summary' && <Summary onOpen={(id) => setParams({ session: id })} />}
      {tab === 'requests' && <Requests />}
      {starting && <StartSession onClose={() => setStarting(false)} onStarted={(s) => setParams({ session: s.id })} />}
    </>
  );
}

function Summary({ onOpen }) {
  const { cls, base } = useClass();
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['class', cls.id, 'attendance', 'summary'], queryFn: () => api.get(`${base}/attendance/summary`) });
  const exportAs = async (format) => {
    try {
      await api.download(`${base}/attendance/export`, { format }, `attendance.${format}`);
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <QueryState query={query}>
      {(data) => data.sessions.length === 0 ? <Card><EmptyState icon={Table2} title="Nothing to summarise yet" description="The summary fills in after the first session is closed." /></Card> : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-soft">Rate = present + late, out of all recorded meetings. Excused meetings are left out. <span className="whitespace-nowrap">P present · L late · A absent · E excused</span></p>
            {can('attendance.export') && (
              <Menu trigger={({ toggle, props }) => <Button variant="secondary" size="sm" icon={Download} onClick={toggle} {...props}>Export</Button>}>
                <MenuItem onClick={() => exportAs('xlsx')}>Excel (.xlsx)</MenuItem>
                <MenuItem onClick={() => exportAs('csv')}>CSV</MenuItem>
                <MenuItem onClick={() => exportAs('pdf')}>PDF</MenuItem>
              </Menu>
            )}
          </div>
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-raised/60 text-xs font-semibold uppercase tracking-wide text-faint">
                  <th scope="col" className="sticky left-0 z-10 border-b border-line bg-raised px-4 py-2.5 text-left">Student</th>
                  <th scope="col" className="border-b border-line px-3 py-2.5 text-right">Rate</th>
                  {data.sessions.map((s) => (
                    <th key={s.id} scope="col" className="border-b border-line px-1 py-1.5 text-center font-medium normal-case">
                      <button type="button" onClick={() => onOpen(s.id)} className="rounded px-1 py-1 hover:bg-raised hover:text-brand" title={`${s.title ?? 'Meeting'} · ${formatDateKey(s.date)}`}>
                        {new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${s.date}T00:00:00Z`))}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.students.map((st) => (
                  <tr key={st.id} className="hover:bg-raised/40">
                    <th scope="row" className="sticky left-0 z-10 border-b border-line bg-surface px-4 py-2 text-left font-medium text-ink whitespace-nowrap">{st.lastName}, {st.firstName}</th>
                    <td className={cn('border-b border-line px-3 py-2 text-right font-semibold tabular-nums', st.rate === null ? 'text-faint' : st.rate < 80 ? 'text-bad' : 'text-ink')}>{st.rate === null ? '—' : formatPercent(st.rate, 0)}</td>
                    {data.sessions.map((s) => <td key={s.id} className="border-b border-line px-1 py-1.5"><span className="flex justify-center"><StatusCell status={s.status === 'CANCELLED' ? null : st.statuses[s.id]} /></span></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </QueryState>
  );
}

function Requests() {
  const { cls } = useClass();
  const [status, setStatus] = useState('PENDING');
  const [reviewing, setReviewing] = useState(null);
  const query = useQuery({ queryKey: ['class', cls.id, 'attendance', 'corrections', status], queryFn: () => api.get('/attendance/corrections', { classId: cls.id, status }) });
  return (
    <>
      <div className="mb-3 flex gap-2">
        {[['PENDING', 'Waiting'], ['APPROVED', 'Approved'], ['REJECTED', 'Declined']].map(([value, label]) => (
          <button key={value} type="button" onClick={() => setStatus(value)} aria-pressed={status === value} className={cn('rounded-full border px-3 py-1 text-[13px] font-medium', status === value ? 'border-brand bg-brand-soft text-brand' : 'border-line text-soft hover:border-line-strong')}>{label}</button>
        ))}
      </div>
      <QueryState query={query}>
        {(list) => list.length === 0 ? <Card><EmptyState icon={Inbox} title={status === 'PENDING' ? 'No requests are waiting' : 'Nothing here'} description={status === 'PENDING' ? 'Students can ask for a correction or an excused absence from their attendance page.' : null} /></Card> : (
          <ul className="space-y-3">
            {list.map((c) => (
              <li key={c.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <Avatar name={c.student?.name} size={38} />
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-sm font-semibold text-ink">{c.student?.name} <span className="font-normal text-faint">· {c.type === 'EXCUSE' ? 'asks for an excused absence' : 'asks for a correction'}</span></p>
                      <p className="text-[13px] text-faint">{c.sessionTitle ?? 'Class meeting'} · {formatDateKey(c.sessionDate)} · sent {relativeTime(c.createdAt)}</p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-soft">Recorded as <StatusPill status={c.currentStatus} /> → requested <StatusPill status={c.requestedStatus} /></p>
                      <p className="mt-2 whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-sm text-ink">{c.reason}</p>
                      {c.files?.length > 0 && <FileList files={c.files} className="mt-2" />}
                      {c.reviewNote && <p className="mt-2 text-[13px] text-soft"><span className="font-medium text-ink">Your note:</span> {c.reviewNote}</p>}
                    </div>
                    {c.status === 'PENDING' ? (
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" icon={Check} onClick={() => setReviewing({ request: c, approve: true })}>Approve</Button>
                        <Button size="sm" variant="secondary" icon={X} onClick={() => setReviewing({ request: c, approve: false })}>Decline</Button>
                      </div>
                    ) : <Badge tone={c.status === 'APPROVED' ? 'ok' : 'bad'}>{c.status === 'APPROVED' ? 'Approved' : 'Declined'}</Badge>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {reviewing && <ReviewDialog {...reviewing} onClose={() => setReviewing(null)} />}
    </>
  );
}

function ReviewDialog({ request, approve, onClose }) {
  const { cls } = useClass();
  const [note, setNote] = useState('');
  const review = useAction(() => api.post(`/attendance/corrections/${request.id}/${approve ? 'approve' : 'reject'}`, { note: note.trim() || undefined }), {
    invalidate: [['class', cls.id, 'attendance'], ['dashboard'], ['class', cls.id, 'gradebook']],
    success: approve ? 'Request approved. The record was updated.' : 'Request declined.',
    onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} size="sm" title={approve ? 'Approve this request?' : 'Decline this request?'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={approve ? 'primary' : 'danger'} loading={review.isPending} onClick={() => review.mutate()}>{approve ? 'Approve' : 'Decline'}</Button></>}>
      <p className="text-sm text-soft">{approve ? <>{request.student?.name}’s record for {formatDateKey(request.sessionDate)} changes to <strong className="text-ink">{request.requestedStatus.toLowerCase()}</strong>.</> : `${request.student?.name} is told that the record stays as it is.`}</p>
      <Field label="Note to the student" optional className="mt-4"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
    </Modal>
  );
}
