// Timezone-aware date helpers built on Intl (no dependency).
// The institution timezone decides what "today" is for attendance, schedules and reports.

const formatters = new Map();

function formatter(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of an instant in a timezone. */
export function dateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" of an instant in a timezone. */
export function timeKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Convert a wall-clock time in a timezone to the UTC instant it denotes. */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  // Two refinement passes settle on the right offset, including around DST changes.
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asUtc - target;
  }
  return new Date(guess);
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** UTC instant of 00:00 local time on a date key. */
export function startOfDay(key, timeZone) {
  return zonedTimeToUtc({ ...parseDateKey(key) }, timeZone);
}

/** UTC instant of a "HH:MM" wall-clock time on a date key. */
export function atTime(key, hhmm, timeZone) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return zonedTimeToUtc({ ...parseDateKey(key), hour, minute }, timeZone);
}

export function addDays(key, days) {
  const p = parseDateKey(key);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday for a date key (pure calendar arithmetic). */
export function weekdayOf(key) {
  const p = parseDateKey(key);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Value to store in a PostgreSQL DATE column for a date key. */
export const dateKeyToDb = (key) => new Date(`${key}T00:00:00.000Z`);

/** Date key from a value read out of a PostgreSQL DATE column. */
export const dbToDateKey = (date) => (date instanceof Date ? date.toISOString().slice(0, 10) : null);

export const isValidTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));

export const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
