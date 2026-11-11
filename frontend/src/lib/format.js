// Dates, numbers and small text helpers. Dates are shown in the institution's time zone
// (Asia/Manila unless the administrator changed it), not the device's.
let timeZone = 'Asia/Manila';
export const setTimeZone = (tz) => {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-PH', { timeZone: tz });
    timeZone = tz;
  } catch {
    /* unknown zone: keep the default */
  }
};
export const getTimeZone = () => timeZone;

const cache = new Map();
function fmt(options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('en-PH', { timeZone, ...options }));
  return cache.get(key);
}
const toDate = (v) => (v instanceof Date ? v : v ? new Date(v) : null);
const valid = (d) => d && !Number.isNaN(d.getTime());

/** "Nov 11, 2026" */
export const formatDate = (v) => (valid(toDate(v)) ? fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(toDate(v)) : '—');
/** "Wed, Nov 11" */
export const formatDay = (v) => (valid(toDate(v)) ? fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(toDate(v)) : '—');
/** "9:05 AM" */
export const formatTime = (v) => (valid(toDate(v)) ? fmt({ hour: 'numeric', minute: '2-digit' }).format(toDate(v)) : '—');
/** "Nov 11, 2026, 9:05 AM" */
export const formatDateTime = (v) => (valid(toDate(v)) ? fmt({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(toDate(v)) : '—');
/** A calendar date stored as YYYY-MM-DD (no time zone shift). */
export function formatDateKey(key) {
  if (!key) return '—';
  const [y, m, d] = String(key).slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** YYYY-MM-DD of an instant in the institution's time zone. */
export function dateKeyOf(v = new Date()) {
  const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(toDate(v));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** "14:30" → "2:30 PM" */
export function formatClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** "in 3 days", "2 hours ago", "yesterday" */
export function relativeTime(v, now = Date.now()) {
  const d = toDate(v);
  if (!valid(d)) return '—';
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return formatDate(d);
}
/** Due-date wording: "Due tomorrow, 11:59 PM" / "Was due Nov 3" */
export function dueLabel(v, now = Date.now()) {
  const d = toDate(v);
  if (!valid(d)) return 'No due date';
  const past = d.getTime() < now;
  const sameDay = dateKeyOf(d) === dateKeyOf(new Date(now));
  if (sameDay) return `${past ? 'Was due' : 'Due'} today, ${formatTime(d)}`;
  return `${past ? 'Was due' : 'Due'} ${formatDay(d)}, ${formatTime(d)}`;
}

/** Value for <input type="datetime-local"> in the institution's zone, and back to ISO. */
export function toLocalInput(v) {
  const d = toDate(v);
  if (!valid(d)) return '';
  const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function fromLocalInput(value) {
  if (!value) return null;
  const [date, time] = value.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time ?? '00:00').split(':').map(Number);
  // Find the UTC instant whose wall-clock time in the institution's zone equals the input.
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i += 1) {
    const shown = toLocalInput(new Date(guess));
    const [sd, st] = shown.split('T');
    const [sy, smo, sdd] = sd.split('-').map(Number);
    const [sh, smi] = st.split(':').map(Number);
    const delta = Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(sy, smo - 1, sdd, sh, smi);
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess).toISOString();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
/** 4 → "4", 4.5 → "4.5", 4.333 → "4.33" */
export const formatScore = (n, digits = 2) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : String(Math.round(Number(n) * 10 ** digits) / 10 ** digits));
export const formatPercent = (n, digits = 1) => (n === null || n === undefined ? '—' : `${formatScore(n, digits)}%`);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
export const titleCase = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
