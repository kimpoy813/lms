// "Take attendance": choose how students check in and, optionally, where they must be.
import { useQuery } from '@tanstack/react-query';
import { Hash, LocateFixed, MapPin, QrCode, UserCheck } from 'lucide-react';
import { useState } from 'react';
import LazyMap from '../../../components/LazyMap.jsx';
import { Alert, Button, Checkbox, cn, Field, Input, Modal, ModalActions, Select, Switch } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { readLocation } from '../../../lib/geo.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';

const MODES = [
  { key: 'manual', icon: UserCheck, title: 'Roll call', text: 'You mark each student yourself.' },
  { key: 'code', icon: Hash, title: 'Attendance code', text: 'Students type a 6-digit code you show them.' },
  { key: 'qr', icon: QrCode, title: 'QR code', text: 'Students scan a code on your screen. It changes every few seconds.' },
];

export default function StartSession({ onClose, onStarted }) {
  const { cls, base } = useClass();
  const policy = useQuery({ queryKey: ['attendance', 'policy'], queryFn: () => api.get('/attendance/policy'), staleTime: 300_000 });
  const saved = useQuery({ queryKey: ['attendance', 'locations'], queryFn: () => api.get('/attendance/locations') });
  const [mode, setMode] = useState('qr');
  const [alsoCode, setAlsoCode] = useState(true);
  const [v, setV] = useState({ title: '', durationMinutes: 15, lateAfterMinutes: '', requireLocation: false, radiusMeters: null, savedLocationId: '', point: null, name: '', save: false });
  const [errors, setErrors] = useState({});
  const [locating, setLocating] = useState(null); // null | 'busy' | error message
  const [manual, setManual] = useState(false);
  const [coords, setCoords] = useState({ latitude: '', longitude: '' });
  const typeCoords = (next) => {
    setCoords(next);
    const latitude = Number(next.latitude);
    const longitude = Number(next.longitude);
    if (next.latitude.trim() !== '' && next.longitude.trim() !== '' && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      setV((s) => ({ ...s, savedLocationId: '', point: { latitude, longitude }, accuracy: null }));
    }
  };
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));

  const p = policy.data;
  const radius = v.radiusMeters ?? p?.defaultRadiusMeters ?? 50;
  const selfCheckIn = mode !== 'manual';
  const savedLocation = (saved.data ?? []).find((l) => l.id === v.savedLocationId);
  const point = savedLocation ? { latitude: savedLocation.latitude, longitude: savedLocation.longitude } : v.point;

  const useMyLocation = async () => {
    setLocating('busy');
    try {
      const reading = await readLocation({ goodEnoughMeters: 25, maxWaitMs: 10_000 });
      setV((s) => ({ ...s, savedLocationId: '', point: { latitude: reading.latitude, longitude: reading.longitude }, accuracy: Math.round(reading.accuracy) }));
      setLocating(null);
    } catch (err) {
      setLocating(err.message);
    }
  };

  const start = useAction(() => api.post(`${base}/attendance/sessions`, {
    title: v.title.trim() || undefined,
    durationMinutes: Number(v.durationMinutes) || 15,
    lateAfterMinutes: v.lateAfterMinutes === '' ? null : Number(v.lateAfterMinutes),
    allowQr: mode === 'qr',
    allowCode: mode === 'code' || (mode === 'qr' && alsoCode),
    requireLocation: selfCheckIn && v.requireLocation,
    ...(selfCheckIn && v.requireLocation ? {
      radiusMeters: radius,
      location: savedLocation ? { savedLocationId: savedLocation.id } : { latitude: point?.latitude, longitude: point?.longitude, name: v.name.trim() || undefined, save: v.save && Boolean(v.name.trim()) },
    } : {}),
  }), {
    invalidate: [['class', cls.id, 'attendance'], ['attendance'], ['dashboard']],
    onSuccess: (session) => { onClose(); onStarted(session); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  const needsPoint = selfCheckIn && v.requireLocation && !point;

  return (
    <Modal open onClose={onClose} title="Take attendance" description={`${cls.course.code}${cls.section ? ` · ${cls.section.name}` : ''} — today`} size="lg">
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); start.mutate(); }} className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">How will students be marked?</legend>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
            {MODES.map((m) => (
              <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)} className={cn('flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors', mode === m.key ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong')}>
                <m.icon className={cn('size-5', mode === m.key ? 'text-brand' : 'text-faint')} aria-hidden="true" />
                <span className="text-sm font-semibold text-ink">{m.title}</span>
                <span className="text-[13px] leading-snug text-soft">{m.text}</span>
              </button>
            ))}
          </div>
          {mode === 'qr' && <Checkbox className="mt-3" checked={alsoCode} onChange={(e) => setAlsoCode(e.target.checked)} label="Also show a 6-digit code" description="For students whose camera does not work." />}
        </fieldset>

        {selfCheckIn && (
          <fieldset className="rounded-xl border border-line p-4">
            <Switch checked={v.requireLocation} onChange={(on) => set('requireLocation', on)} label={<span className="flex items-center gap-2"><MapPin className="size-4 text-brand" aria-hidden="true" />Students must be in the classroom</span>} description="Their phone’s location is checked against a radius around the room. Only the distance is kept — never their coordinates." />
            {errors.requireLocation && <p className="mt-2 text-[13px] text-bad" role="alert">{errors.requireLocation}</p>}
            {v.requireLocation && (
              <div className="mt-4 space-y-4 border-t border-line pt-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Field label="Classroom location">
                    <Select value={v.savedLocationId} onChange={(e) => setV((s) => ({ ...s, savedLocationId: e.target.value, radiusMeters: (saved.data ?? []).find((l) => l.id === e.target.value)?.defaultRadiusMeters ?? s.radiusMeters }))}>
                      <option value="">{point && !savedLocation ? 'Pin placed on the map' : 'Choose a saved location…'}</option>
                      {(saved.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                  </Field>
                  <Button variant="secondary" icon={LocateFixed} loading={locating === 'busy'} onClick={useMyLocation} className="self-end">Use where I am now</Button>
                </div>
                {locating && locating !== 'busy' && <Alert tone="warn">{locating}</Alert>}
                {errors.location && <p className="text-[13px] text-bad" role="alert">{errors.location}</p>}
                {point ? (
                  <>
                    <LazyMap center={point} radius={radius} tileUrl={p?.map?.tileUrl} attribution={p?.map?.attribution} height={230} onPick={savedLocation ? undefined : (pt) => setV((s) => ({ ...s, point: pt, accuracy: null }))} />
                    <p className="-mt-2 text-xs text-faint">{savedLocation ? 'Saved location.' : `Drag the pin or tap the map to adjust.${v.accuracy ? ` Your device reported ±${v.accuracy} m.` : ''}`} Students inside the circle can check in.</p>
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-soft">
                    <p>Choose a saved location, or tap <strong className="font-semibold text-ink">Use where I am now</strong> while you are in the classroom. You can fine-tune the pin on the map afterwards.</p>
                    {!manual && <button type="button" onClick={() => setManual(true)} className="mt-2 text-[13px] font-medium text-brand hover:underline">Enter coordinates instead</button>}
                  </div>
                )}
                {manual && !savedLocation && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Latitude" hint="For example 15.14500 (copy it from a maps app)."><Input inputMode="decimal" value={coords.latitude} onChange={(e) => typeCoords({ ...coords, latitude: e.target.value })} placeholder="15.14500" /></Field>
                    <Field label="Longitude"><Input inputMode="decimal" value={coords.longitude} onChange={(e) => typeCoords({ ...coords, longitude: e.target.value })} placeholder="120.58870" /></Field>
                  </div>
                )}
                <Field label={`Allowed radius: ${radius} m`} error={errors.radiusMeters} hint={p ? `GPS indoors is often off by 10–30 m. ${p.minRadiusMeters}–${p.maxRadiusMeters} m is allowed.` : null}>
                  <div className="flex flex-wrap gap-2">
                    {(p?.radiusPresets ?? [25, 50, 100]).map((r) => (
                      <button key={r} type="button" onClick={() => set('radiusMeters', r)} aria-pressed={radius === r} className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium', radius === r ? 'border-brand bg-brand-soft text-brand' : 'border-line text-soft hover:border-line-strong')}>{r} m</button>
                    ))}
                    <Input type="number" min={p?.minRadiusMeters ?? 10} max={p?.maxRadiusMeters ?? 300} value={radius} onChange={(e) => set('radiusMeters', Number(e.target.value))} className="h-9 w-24" aria-label="Radius in metres" />
                  </div>
                </Field>
                {point && !savedLocation && (
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field label="Name this place" optional><Input value={v.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Room 204, Main Building" maxLength={80} /></Field>
                    <Checkbox checked={v.save} onChange={(e) => set('save', e.target.checked)} label="Save for next time" className="pb-2.5" />
                  </div>
                )}
              </div>
            )}
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={selfCheckIn ? 'Open for (minutes)' : 'Meeting length (minutes)'} error={errors.durationMinutes ?? errors.endTime} hint={selfCheckIn ? 'Check-in closes automatically.' : null}>
            <Input type="number" min="5" max="720" value={v.durationMinutes} onChange={(e) => set('durationMinutes', e.target.value)} />
          </Field>
          {selfCheckIn && (
            <Field label="Late after (minutes)" optional error={errors.lateAfterMinutes} hint="Later check-ins are marked late.">
              <Input type="number" min="0" max="720" value={v.lateAfterMinutes} onChange={(e) => set('lateAfterMinutes', e.target.value)} placeholder="e.g. 10" />
            </Field>
          )}
          <Field label="Label" optional error={errors.title} className={selfCheckIn ? '' : 'sm:col-span-2'}><Input value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={120} placeholder="e.g. Laboratory session" /></Field>
        </div>

        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={start.isPending} disabled={needsPoint}>{selfCheckIn ? 'Open check-in' : 'Start roll call'}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
