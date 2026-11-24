// RFC 5545 iCalendar (.ics) serializer for Discenda calendars.
// Outputs CRLF-delimited, folded lines suitable for Google Calendar, Apple Calendar, and Outlook.

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < line.length) {
    let chunk = '';
    let chunkBytes = 0;
    while (start < line.length) {
      const ch = line[start];
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (chunkBytes + chBytes > limit && chunk.length > 0) break;
      chunk += ch;
      chunkBytes += chBytes;
      start += 1;
    }
    out.push(out.length === 0 ? chunk : ` ${chunk}`);
    limit = 74; // leading continuation space uses 1 byte
  }
  return out.join('\r\n');
}

function formatUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function formatDateOnly(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function addUtcDay(date) {
  const d = new Date((date instanceof Date ? date : new Date(date)).getTime() + 86_400_000);
  return d;
}

/**
 * @param {{ name?: string, timeZone?: string, appUrl?: string, events: Array<{ id: string, title: string, description?: string | null, location?: string | null, startAt: Date | string, endAt?: Date | string | null, allDay?: boolean, link?: string | null, classLabel?: string | null }> }} options
 */
export function buildIcsCalendar({ name = 'Discenda Calendar', timeZone = 'Asia/Manila', appUrl = '', events = [] }) {
  const stamp = formatUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Discenda//LMS//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${escapeText(timeZone)}`,
  ];

  for (const ev of events) {
    const start = new Date(ev.startAt);
    const rawEnd = ev.endAt ? new Date(ev.endAt) : start;
    // Give point-in-time deadlines a 30-minute display span so calendar clients render them clearly.
    const end = !ev.allDay && rawEnd <= start ? new Date(start.getTime() + 30 * 60_000) : rawEnd;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeText(`${ev.id}@discenda`)}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      const startDay = formatDateOnly(start);
      let endDay = formatDateOnly(end);
      if (endDay <= startDay) endDay = formatDateOnly(addUtcDay(start));
      lines.push(`DTSTART;VALUE=DATE:${startDay}`);
      lines.push(`DTEND;VALUE=DATE:${endDay}`);
    } else {
      lines.push(`DTSTART:${formatUtc(start)}`);
      lines.push(`DTEND:${formatUtc(end)}`);
    }
    const summary = ev.classLabel ? `[${ev.classLabel}] ${ev.title}` : ev.title;
    lines.push(`SUMMARY:${escapeText(summary)}`);
    const descParts = [ev.description, ev.link && appUrl ? `${appUrl}${ev.link}` : null].filter(Boolean);
    if (descParts.length > 0) lines.push(`DESCRIPTION:${escapeText(descParts.join('\n\n'))}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
