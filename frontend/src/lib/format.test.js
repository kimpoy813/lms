import { describe, expect, it } from 'vitest';
import { dateKeyOf, dueLabel, formatBytes, formatClock, formatDuration, formatScore, fromLocalInput, initials, plural, relativeTime, setTimeZone, toLocalInput } from './format.js';

describe('time zone aware formatting', () => {
  it('shows institution time, not device time', () => {
    setTimeZone('Asia/Manila');
    // 16:30 UTC is 00:30 the next day in Manila.
    expect(dateKeyOf('2026-11-11T16:30:00Z')).toBe('2026-11-12');
    expect(toLocalInput('2026-11-11T16:30:00Z')).toBe('2026-11-12T00:30');
  });

  it('round-trips datetime-local values through the institution zone', () => {
    setTimeZone('Asia/Manila');
    expect(fromLocalInput('2026-11-12T00:30')).toBe('2026-11-11T16:30:00.000Z');
    setTimeZone('America/New_York'); // a zone with daylight saving time
    for (const local of ['2026-01-15T09:00', '2026-07-15T09:00', '2026-11-01T12:00']) expect(toLocalInput(fromLocalInput(local))).toBe(local);
    setTimeZone('Asia/Manila');
    expect(fromLocalInput('')).toBeNull();
  });

  it('ignores an unknown time zone', () => {
    setTimeZone('Mars/Olympus');
    expect(dateKeyOf('2026-11-11T16:30:00Z')).toBe('2026-11-12');
  });
});

describe('wording', () => {
  const now = Date.parse('2026-11-11T04:00:00Z'); // noon in Manila
  it('describes relative times', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now + 2 * 3_600_000, now)).toBe('in 2 hours');
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday');
  });
  it('describes due dates', () => {
    expect(dueLabel(now + 3_600_000, now)).toMatch(/^Due today, 1:00/);
    expect(dueLabel(now - 3_600_000, now)).toMatch(/^Was due today, 11:00/);
    expect(dueLabel(now + 2 * 86_400_000, now)).toMatch(/^Due Fri, Nov 13/);
    expect(dueLabel(null)).toBe('No due date');
  });
  it('formats small things', () => {
    expect(formatClock('14:30')).toBe('2:30 PM');
    expect(formatClock('00:05')).toBe('12:05 AM');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatScore(4.3333)).toBe('4.33');
    expect(formatScore(null)).toBe('—');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(65)).toBe('1:05');
    expect(plural(1, 'student')).toBe('1 student');
    expect(plural(3, 'class', 'classes')).toBe('3 classes');
    expect(initials('Juan Dela Cruz')).toBe('JD');
  });
});
