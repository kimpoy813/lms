// Calendar schedule-overlap and affected-class notification helpers.
import { addDays, atTime, dateKey, timeKey, weekdayOf } from '../../lib/time.js';
import { notify } from '../../services/notifications.js';
import { classLabel } from '../classes/access.js';

export const MAX_OVERLAP_SPAN_DAYS = 180;

/** Normalize [startMs, endMs] in `tz`, handling all-day boundaries cleanly. */
export function effectiveWindow(startAt, endAt, allDay, tz) {
  const start = new Date(startAt);
  const end = new Date(endAt ?? startAt);
  if (allDay) {
    const startDay = dateKey(start, tz);
    const startMs = atTime(startDay, '00:00', tz).getTime();
    let endDay = dateKey(end, tz);
    if (end.getTime() > startMs && timeKey(end, tz) === '00:00' && endDay > startDay) {
      endDay = dateKey(new Date(end.getTime() - 1), tz);
    }
    if (endDay < startDay) endDay = startDay;
    const endMs = atTime(endDay, '23:59', tz).getTime() + 60_000;
    return { startMs, endMs, isInstant: false };
  }
  const startMs = start.getTime();
  const endMs = end.getTime();
  return { startMs, endMs, isInstant: endMs === startMs };
}

/**
 * Find scheduled class meetings in `[startAt, endAt]` in timezone `tz`.
 * Classes passed in should include `course`, `section`, `schedules`, and optionally `_count.enrollments`.
 */
export function findOverlappingClassMeetings(classes, { startAt, endAt, allDay = false, tz }) {
  const { startMs, endMs, isInstant } = effectiveWindow(startAt, endAt, allDay, tz);
  const firstDay = dateKey(new Date(startMs), tz);
  const lastDay = dateKey(new Date(Math.max(startMs, endMs - (isInstant ? 0 : 1))), tz);

  const hitsByClassId = new Map();
  for (let day = firstDay, guard = 0; day <= lastDay && guard <= MAX_OVERLAP_SPAN_DAYS; day = addDays(day, 1), guard += 1) {
    const weekday = weekdayOf(day);
    for (const cls of classes) {
      for (const s of cls.schedules ?? []) {
        if (s.dayOfWeek !== weekday) continue;
        const mStart = atTime(day, s.startTime, tz);
        const mEnd = atTime(day, s.endTime, tz);
        const mStartMs = mStart.getTime();
        const mEndMs = mEnd.getTime();
        if (mEndMs <= mStartMs) continue;

        const overlaps = isInstant
          ? mStartMs <= startMs && mEndMs > startMs
          : mStartMs < endMs && mEndMs > startMs;
        if (!overlaps) continue;

        const list = hitsByClassId.get(cls.id) ?? [];
        list.push({
          date: day,
          startTime: s.startTime,
          endTime: s.endTime,
          room: s.room ?? cls.room ?? null,
          startAt: mStart,
          endAt: mEnd,
        });
        hitsByClassId.set(cls.id, list);
      }
    }
  }

  for (const list of hitsByClassId.values()) {
    list.sort((a, b) => a.startAt - b.startAt);
  }

  const formatClass = (cls) => ({
    classId: cls.id,
    label: classLabel(cls),
    title: cls.course.title,
    color: cls.color,
    studentCount: cls._count?.enrollments ?? 0,
    hits: hitsByClassId.get(cls.id) ?? [],
  });

  const overlapping = classes
    .filter((c) => hitsByClassId.has(c.id))
    .map(formatClass)
    .sort((a, b) => a.hits[0].startAt - b.hits[0].startAt || a.label.localeCompare(b.label));

  const otherClasses = classes
    .filter((c) => !hitsByClassId.has(c.id))
    .map(formatClass)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { overlapping, otherClasses, hitsByClassId };
}

function formatClock12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatShortDate(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatDateSpan(startAt, endAt, allDay, tz) {
  const { startMs, endMs, isInstant } = effectiveWindow(startAt, endAt, allDay, tz);
  const firstDay = dateKey(new Date(startMs), tz);
  const lastDay = dateKey(new Date(Math.max(startMs, endMs - (isInstant ? 0 : 1))), tz);
  if (firstDay === lastDay) return formatShortDate(firstDay);
  return `${formatShortDate(firstDay)} – ${formatShortDate(lastDay)}`;
}

function describeClassHit(cls, hits, multiDay) {
  const label = classLabel(cls);
  if (!hits || hits.length === 0) return label;
  if (hits.length === 1) {
    const h = hits[0];
    const timeRange = `${formatClock12(h.startTime)}–${formatClock12(h.endTime)}`;
    return multiDay ? `${label} (${formatShortDate(h.date)}, ${timeRange})` : `${label} (${timeRange})`;
  }
  return `${label} (${hits.length} meetings)`;
}

/**
 * Notify every student enrolled in `classes`, grouping students who share the same set
 * of affected classes so no student receives duplicate alerts or sees classes they are not in.
 */
export async function notifyAffectedClasses({ prisma, event, classes, hitsByClassId, tz, actorName, action = 'created' }) {
  if (!classes || classes.length === 0) return { notifiedStudents: 0 };
  const classIds = classes.map((c) => c.id);
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const enrollments = await prisma.enrollment.findMany({
    where: { classId: { in: classIds }, status: 'ENROLLED' },
    select: { studentId: true, classId: true },
  });
  if (enrollments.length === 0) return { notifiedStudents: 0 };

  const byStudent = new Map();
  for (const e of enrollments) {
    const list = byStudent.get(e.studentId) ?? [];
    list.push(e.classId);
    byStudent.set(e.studentId, list);
  }

  const groups = new Map();
  for (const [studentId, cids] of byStudent) {
    const sorted = [...new Set(cids)].sort();
    const sig = sorted.join(',');
    const entry = groups.get(sig) ?? { studentIds: [], classIds: sorted };
    entry.studentIds.push(studentId);
    groups.set(sig, entry);
  }

  const { startMs, endMs, isInstant } = effectiveWindow(event.startAt, event.endAt, event.allDay, tz);
  const firstDay = dateKey(new Date(startMs), tz);
  const lastDay = dateKey(new Date(Math.max(startMs, endMs - (isInstant ? 0 : 1))), tz);
  const multiDay = firstDay !== lastDay;
  const dateSpan = formatDateSpan(event.startAt, event.endAt, event.allDay, tz);
  const link = `/calendar?date=${firstDay}`;

  let title;
  if (action === 'cancelled') title = `Cancelled on the calendar (${dateSpan}): ${event.title}`;
  else if (action === 'updated') title = `Updated on the calendar (${dateSpan}): ${event.title}`;
  else if (event.type === 'TEACHER_LEAVE') title = `Class notice (${dateSpan}): ${event.title}`;
  else title = `New on the calendar (${dateSpan}): ${event.title}`;

  for (const group of groups.values()) {
    const affectedText = group.classIds
      .map((cid) => describeClassHit(classMap.get(cid), hitsByClassId?.get(cid), multiDay))
      .join(', ');

    let body;
    if (action === 'cancelled') {
      body = `${actorName} removed this notice affecting ${affectedText}.`;
    } else {
      const prefix = event.type === 'TEACHER_LEAVE' ? `${actorName} is unavailable` : actorName;
      const parts = [`${prefix} · Affects: ${affectedText}`];
      if (event.location) parts.push(event.location);
      if (event.description) parts.push(event.description);
      body = parts.join(' — ');
    }

    await notify(group.studentIds, {
      type: 'calendar.event',
      title,
      body,
      link,
      classId: group.classIds.length === 1 ? group.classIds[0] : null,
    });
  }

  return { notifiedStudents: byStudent.size };
}
