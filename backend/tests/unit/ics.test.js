import { describe, expect, it } from 'vitest';
import { buildIcsCalendar } from '../../src/lib/ics.js';

describe('RFC 5545 iCalendar serializer', () => {
  it('formats timed, all-day, and escaped calendar events with CRLF line endings', () => {
    const ics = buildIcsCalendar({
      name: 'STI; Campus, Calendar',
      timeZone: 'Asia/Manila',
      appUrl: 'https://lms.example.edu',
      events: [
        {
          id: 'assignment:a1',
          title: 'Essay: Algorithms, Stacks; Queues',
          classLabel: 'CS 101',
          description: 'Line 1\nLine 2',
          location: 'Room 302',
          startAt: '2026-11-20T09:00:00.000Z',
          endAt: '2026-11-20T09:00:00.000Z',
          allDay: false,
          link: '/classes/c1/assignments/a1',
        },
        {
          id: 'event:e1',
          title: 'Bonifacio Day',
          startAt: '2026-11-30T00:00:00.000Z',
          endAt: '2026-11-30T00:00:00.000Z',
          allDay: true,
        },
      ],
    });

    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0');
    expect(ics).toContain('X-WR-CALNAME:STI\\; Campus\\, Calendar');
    expect(ics).toContain('SUMMARY:[CS 101] Essay: Algorithms\\, Stacks\\; Queues');
    expect(ics).toContain('DTSTART:20261120T090000Z');
    // Point-in-time deadline receives a 30-minute end span
    expect(ics).toContain('DTEND:20261120T093000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261130');
    expect(ics).toContain('DTEND;VALUE=DATE:20261201');
  });

  it('folds lines longer than 75 UTF-8 octets cleanly', () => {
    const longTitle = 'A'.repeat(120);
    const ics = buildIcsCalendar({
      events: [{ id: 'ev1', title: longTitle, startAt: '2026-11-20T09:00:00Z', endAt: '2026-11-20T10:00:00Z' }],
    });
    const rawLines = ics.split('\r\n').filter(Boolean);
    for (const line of rawLines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${longTitle}`);
  });
});
