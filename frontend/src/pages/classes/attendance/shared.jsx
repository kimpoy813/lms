import { CheckCircle2, Clock, MinusCircle, XCircle } from 'lucide-react';
import { Badge, cn } from '../../../components/ui.jsx';

export const ATT = {
  PRESENT: { label: 'Present', short: 'P', tone: 'ok', text: 'text-ok', bg: 'bg-ok-soft text-ok', icon: CheckCircle2 },
  LATE: { label: 'Late', short: 'L', tone: 'warn', text: 'text-warn', bg: 'bg-warn-soft text-warn', icon: Clock },
  ABSENT: { label: 'Absent', short: 'A', tone: 'bad', text: 'text-bad', bg: 'bg-bad-soft text-bad', icon: XCircle },
  EXCUSED: { label: 'Excused', short: 'E', tone: 'info', text: 'text-info', bg: 'bg-info-soft text-info', icon: MinusCircle },
};
export const ATT_ORDER = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];

export const METHOD = {
  MANUAL: 'Marked by teacher', TEACHER_OVERRIDE: 'Teacher override', AUTO_ABSENT: 'No check-in',
  QR: 'QR code', CODE: 'Attendance code', QR_GPS: 'QR code + location', CORRECTION_APPROVED: 'Approved request',
};

export function StatusPill({ status, className }) {
  const s = ATT[status];
  if (!s) return <Badge className={className}>Not marked</Badge>;
  return <Badge tone={s.tone} icon={s.icon} className={className}>{s.label}</Badge>;
}

/** One letter in a coloured square, for the summary grid. */
export function StatusCell({ status }) {
  const s = ATT[status];
  return <span className={cn('grid size-7 place-items-center rounded-md text-xs font-bold', s ? s.bg : 'bg-raised text-faint')} title={s?.label ?? 'Not recorded'} aria-label={s?.label ?? 'Not recorded'}>{s?.short ?? '·'}</span>;
}

export function Counts({ counts, className }) {
  return (
    <dl className={cn('flex gap-4 text-center text-xs text-faint', className)}>
      {ATT_ORDER.map((k) => (
        <div key={k}><dd className={cn('text-base font-bold tabular-nums', counts[k.toLowerCase()] > 0 ? ATT[k].text : 'text-faint')}>{counts[k.toLowerCase()]}</dd><dt>{ATT[k].label}</dt></div>
      ))}
    </dl>
  );
}
