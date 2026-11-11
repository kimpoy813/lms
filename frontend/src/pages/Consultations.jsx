// Consultation hours: teachers open time slots, students book them.
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Clock, MapPin, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { Avatar, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, QueryState, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dateKeyOf, formatDateKey, formatTime, fromLocalInput, plural, toLocalInput } from '../lib/format.js';
import { useAction } from '../lib/query.js';

export default function Consultations() {
  const { isTeacher, isStudent, isAdmin } = useAuth();
  const [dialog, setDialog] = useState(null);
  const query = useQuery({ queryKey: ['consultations', 'slots'], queryFn: () => api.get('/consultations/slots') });
  const invalidate = [['consultations'], ['calendar'], ['dashboard']];
  const cancelBooking = useAction((id) => api.delete(`/consultations/bookings/${id}`), { invalidate, success: 'Booking cancelled.', onSuccess: () => setDialog(null) });
  const removeSlot = useAction((id) => api.delete(`/consultations/slots/${id}`), { invalidate, success: 'Time slot removed. Students who booked it were notified.', onSuccess: () => setDialog(null) });

  const byDay = useMemo(() => {
    const map = new Map();
    for (const slot of query.data ?? []) {
      const key = dateKeyOf(slot.startAt);
      map.set(key, [...(map.get(key) ?? []), slot]);
    }
    return [...map.entries()];
  }, [query.data]);
  const mine = (query.data ?? []).filter((s) => s.myBooking);

  return (
    <>
      <PageHeader title="Consultations" description={isStudent ? 'Book time with your teachers for questions and advising.' : isTeacher ? 'Open time slots that your students can book.' : 'Consultation slots opened by teachers.'}
        actions={isTeacher ? <Button icon={Plus} onClick={() => setDialog({ create: true })}>Open a time slot</Button> : null} />

      {isStudent && mine.length > 0 && (
        <Card className="mb-5 border-brand/30">
          <h2 className="mb-3 text-[15px] font-semibold">My bookings</h2>
          <ul className="space-y-2">
            {mine.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-brand-soft p-3">
                <CalendarClock className="size-5 shrink-0 text-brand" aria-hidden="true" />
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block text-sm font-semibold text-ink">{formatDateKey(dateKeyOf(s.startAt))}, {formatTime(s.startAt)} – {formatTime(s.endAt)}</span>
                  <span className="block text-[13px] text-soft">{s.teacher.name}{s.location ? ` · ${s.location}` : ''}{s.myBooking.topic ? ` · “${s.myBooking.topic}”` : ''}</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => setDialog({ cancel: s })}>Cancel booking</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <QueryState query={query}>
        {(slots) => slots.length === 0 ? (
          <Card><EmptyState icon={CalendarClock} title="No consultation slots are open" description={isTeacher ? 'Open a slot for your consultation hours. Students in your classes can book it.' : isStudent ? 'When your teachers open consultation hours, you can book a slot here.' : null} action={isTeacher ? <Button icon={Plus} onClick={() => setDialog({ create: true })}>Open a time slot</Button> : null} /></Card>
        ) : (
          <div className="space-y-6">
            {byDay.map(([day, list]) => (
              <section key={day}>
                <h2 className="mb-2 text-sm font-semibold text-ink">{formatDateKey(day)}</h2>
                <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {list.map((s) => {
                    const full = s.available <= 0;
                    return (
                      <li key={s.id}>
                        <Card className={cn('h-full p-4', s.myBooking && 'border-brand/50')}>
                          <div className="flex flex-wrap items-start gap-3">
                            <Avatar name={s.teacher.name} size={40} />
                            <div className="min-w-0 flex-1 basis-40">
                              <p className="flex items-center gap-2 text-base font-semibold tabular-nums text-ink"><Clock className="size-4 text-faint" aria-hidden="true" />{formatTime(s.startAt)} – {formatTime(s.endAt)}</p>
                              <p className="text-sm text-soft">{s.teacher.name}</p>
                              {s.location && <p className="mt-1 flex items-center gap-1.5 text-[13px] text-faint"><MapPin className="size-3.5" aria-hidden="true" />{s.location}</p>}
                              {s.note && <p className="mt-1 text-[13px] text-soft">{s.note}</p>}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              {s.myBooking ? <Badge tone="brand">You booked this</Badge> : <Badge tone={full ? 'neutral' : 'ok'} icon={Users}>{full ? 'Full' : `${s.available} of ${s.capacity} open`}</Badge>}
                              {isStudent && !s.myBooking && <Button size="sm" disabled={full} onClick={() => setDialog({ book: s })}>Book</Button>}
                              {(isTeacher || isAdmin) && <Button size="sm" variant="dangerGhost" icon={Trash2} onClick={() => setDialog({ remove: s })}>Remove</Button>}
                            </div>
                          </div>
                          {s.bookings && (
                            <div className="mt-3 border-t border-line pt-3">
                              {s.bookings.length === 0 ? <p className="text-[13px] text-faint">No one has booked yet.</p> : (
                                <ul className="space-y-1.5">
                                  {s.bookings.map((b) => <li key={b.id} className="flex items-start gap-2 text-sm"><Avatar name={b.student.name} size={24} /><span className="min-w-0 flex-1"><span className="font-medium text-ink">{b.student.name}</span>{b.topic && <span className="text-soft"> — {b.topic}</span>}</span></li>)}
                                </ul>
                              )}
                            </div>
                          )}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryState>

      {dialog?.create && <SlotDialog invalidate={invalidate} onClose={() => setDialog(null)} />}
      {dialog?.book && <BookDialog slot={dialog.book} invalidate={invalidate} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.cancel)} onClose={() => setDialog(null)} onConfirm={() => cancelBooking.mutate(dialog.cancel.myBooking.id)} loading={cancelBooking.isPending} title="Cancel this booking?" confirmLabel="Cancel booking">Your teacher is notified and the slot becomes available to others.</ConfirmDialog>
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => removeSlot.mutate(dialog.remove.id)} loading={removeSlot.isPending} title="Remove this time slot?" confirmLabel="Remove slot">
        {dialog?.remove?.booked > 0 ? `${plural(dialog.remove.booked, 'student')} booked this slot and will be told it was cancelled.` : 'No one has booked it yet.'}
      </ConfirmDialog>
    </>
  );
}

function SlotDialog({ invalidate, onClose }) {
  const tomorrow = dateKeyOf(new Date(Date.now() + 86_400_000));
  const [v, setV] = useState({ date: tomorrow, start: '15:00', end: '15:30', location: '', note: '', capacity: 1 });
  const [errors, setErrors] = useState({});
  const save = useAction(() => api.post('/consultations/slots', { startAt: fromLocalInput(`${v.date}T${v.start}`), endAt: fromLocalInput(`${v.date}T${v.end}`), location: v.location.trim() || null, note: v.note.trim() || null, capacity: Number(v.capacity) || 1 }), {
    invalidate, success: 'Time slot opened.', onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } setErrors({ form: err.message }); return true; },
  });
  return (
    <Modal open onClose={onClose} title="Open a consultation slot" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => { setErrors({}); save.mutate(); }}>Open slot</Button></>}>
      <div className="space-y-4">
        {errors.form && <p className="text-sm text-bad" role="alert">{errors.form}</p>}
        <Field label="Date" error={errors.startAt}><Input type="date" min={toLocalInput(new Date()).slice(0, 10)} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From"><Input type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></Field>
          <Field label="To" error={errors.endAt}><Input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-[1fr_6rem] gap-4">
          <Field label="Place" optional error={errors.location}><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} placeholder="Faculty room" maxLength={200} /></Field>
          <Field label="Students" error={errors.capacity}><Input type="number" min="1" max="50" value={v.capacity} onChange={(e) => setV({ ...v, capacity: e.target.value })} /></Field>
        </div>
        <Field label="Note for students" optional error={errors.note}><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={500} placeholder="e.g. Bring your activity sheet." /></Field>
      </div>
    </Modal>
  );
}

function BookDialog({ slot, invalidate, onClose }) {
  const [topic, setTopic] = useState('');
  const book = useAction(() => api.post(`/consultations/slots/${slot.id}/book`, { topic: topic.trim() || null }), { invalidate, success: 'Consultation booked. It is on your calendar.', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Book this consultation" size="sm" description={`${slot.teacher.name} · ${formatDateKey(dateKeyOf(slot.startAt))}, ${formatTime(slot.startAt)} – ${formatTime(slot.endAt)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={book.isPending} onClick={() => book.mutate()}>Book</Button></>}>
      <Field label="What would you like to discuss?" optional hint="Helps your teacher prepare."><Textarea rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} data-autofocus /></Field>
    </Modal>
  );
}
