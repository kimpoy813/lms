// Calendar: one feed that merges
//   • events people created (institution-wide, per class, personal)
//   • class meetings from the weekly schedule
//   • assignment deadlines and quiz closing times
//   • consultation slots and bookings
// plus consultation scheduling and a personal to-do list.
import { Router } from 'express';
import { z } from 'zod';
import { lockKey, prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, patchOf, zDateTime, zId, zTitle } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { addDays, atTime, dateKey, weekdayOf } from '../../lib/time.js';
import { publishedWhere } from '../../lib/visibility.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { notify } from '../../services/notifications.js';
import { getTimeZone } from '../../services/settings.js';
import { classIdsFor, classLabel, requireWritableClassManager } from '../classes/access.js';

export const calendarRouter = Router();
export const consultationsRouter = Router();
export const tasksRouter = Router();
for (const r of [calendarRouter, consultationsRouter, tasksRouter]) r.use(requireAuth);

const MAX_RANGE_DAYS = 62;
const classInclude = { course: { select: { code: true, title: true } }, section: { select: { name: true } } };

// ── Feed ─────────────────────────────────────────────────────────────────────
calendarRouter.get(
  '/',
  validate({ query: z.object({ from: zDateTime, to: zDateTime, classId: zId.optional() }) }),
  async (req, res) => {
    const { from, to, classId } = req.valid.query;
    if (to <= from) throw fieldErrors({ to: 'The end of the range must be after its start.' });
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw fieldErrors({ to: `Choose a range of at most ${MAX_RANGE_DAYS} days.` });
    const tz = await getTimeZone();
    const now = new Date();
    const user = req.user;
    // Administrators see institution events (and one class when they ask for it), not every class meeting.
    let classIds = user.role === 'ADMIN' && !classId ? [] : await classIdsFor(user, { includeArchived: false });
    if (classId) classIds = classIds.filter((id) => id === classId);
    const classes = await prisma.class.findMany({ where: { id: { in: classIds } }, include: { ...classInclude, schedules: true } });
    const labelOf = new Map(classes.map((c) => [c.id, classLabel(c)]));
    const colorOf = new Map(classes.map((c) => [c.id, c.color]));
    const forStudents = user.role === 'STUDENT';

    const [events, assignments, quizzes, slots, bookings] = await Promise.all([
      prisma.calendarEvent.findMany({
        where: {
          startAt: { lt: to }, endAt: { gte: from },
          OR: [
            ...(classId ? [] : [{ scope: 'INSTITUTION' }, { scope: 'PERSONAL', ownerId: user.id }]),
            { scope: 'CLASS', classId: { in: classIds } },
          ],
        },
        orderBy: { startAt: 'asc' }, take: 1000,
      }),
      prisma.assignment.findMany({ where: { classId: { in: classIds }, deletedAt: null, dueAt: { gte: from, lt: to }, ...(forStudents ? publishedWhere(now) : {}) }, select: { id: true, classId: true, title: true, dueAt: true, status: true } }),
      prisma.quiz.findMany({ where: { classId: { in: classIds }, deletedAt: null, availableUntil: { gte: from, lt: to }, ...(forStudents ? publishedWhere(now) : {}) }, select: { id: true, classId: true, title: true, kind: true, availableUntil: true, status: true } }),
      user.role === 'TEACHER' && !classId
        ? prisma.consultationSlot.findMany({ where: { teacherId: user.id, startAt: { lt: to }, endAt: { gte: from } }, include: { bookings: { where: { status: 'BOOKED' }, include: { student: { select: { firstName: true, lastName: true } } } } } })
        : [],
      user.role === 'STUDENT' && !classId
        ? prisma.consultationBooking.findMany({ where: { studentId: user.id, status: 'BOOKED', slot: { startAt: { lt: to }, endAt: { gte: from } } }, include: { slot: { include: { teacher: { select: { firstName: true, lastName: true } } } } } })
        : [],
    ]);

    const items = [];
    for (const e of events) {
      const canEdit = e.ownerId === user.id || (e.scope === 'INSTITUTION' && user.role === 'ADMIN') || (e.scope === 'CLASS' && user.role === 'ADMIN');
      items.push({
        id: `event:${e.id}`, eventId: e.id, kind: 'EVENT', type: e.type, scope: e.scope, title: e.title, description: e.description, location: e.location,
        startAt: e.startAt, endAt: e.endAt, allDay: e.allDay, classId: e.classId, classLabel: e.classId ? labelOf.get(e.classId) : null, color: e.classId ? colorOf.get(e.classId) : null, canEdit,
      });
    }
    // Weekly class meetings, expanded for every day of the range (institution timezone).
    const lastDay = dateKey(new Date(to.getTime() - 1), tz);
    for (let day = dateKey(from, tz), guard = 0; day <= lastDay && guard <= MAX_RANGE_DAYS + 1; day = addDays(day, 1), guard += 1) {
      const weekday = weekdayOf(day);
      for (const cls of classes) {
        for (const s of cls.schedules) {
          if (s.dayOfWeek !== weekday) continue;
          const startAt = atTime(day, s.startTime, tz);
          const endAt = atTime(day, s.endTime, tz);
          if (endAt < from || startAt >= to) continue;
          items.push({ id: `meeting:${cls.id}:${day}:${s.startTime}`, kind: 'CLASS_MEETING', type: 'CLASS_MEETING', title: cls.course.title, location: s.room ?? cls.room ?? null, startAt, endAt, allDay: false, classId: cls.id, classLabel: labelOf.get(cls.id), color: cls.color, link: `/classes/${cls.id}` });
        }
      }
    }
    for (const a of assignments) {
      items.push({ id: `assignment:${a.id}`, kind: 'ASSIGNMENT_DUE', type: 'DEADLINE', title: `Due: ${a.title}`, startAt: a.dueAt, endAt: a.dueAt, allDay: false, classId: a.classId, classLabel: labelOf.get(a.classId), color: colorOf.get(a.classId), draft: a.status === 'DRAFT', link: `/classes/${a.classId}/assignments/${a.id}` });
    }
    for (const q of quizzes) {
      items.push({ id: `quiz:${q.id}`, kind: 'QUIZ_CLOSES', type: q.kind === 'EXAM' ? 'EXAM' : 'DEADLINE', title: `${q.kind === 'EXAM' ? 'Exam' : 'Quiz'} closes: ${q.title}`, startAt: q.availableUntil, endAt: q.availableUntil, allDay: false, classId: q.classId, classLabel: labelOf.get(q.classId), color: colorOf.get(q.classId), draft: q.status === 'DRAFT', link: `/classes/${q.classId}/quizzes/${q.id}` });
    }
    for (const s of slots) {
      items.push({ id: `slot:${s.id}`, kind: 'CONSULTATION', type: 'CONSULTATION', title: s.bookings.length > 0 ? `Consultation: ${s.bookings.map((b) => fullName(b.student)).join(', ')}` : 'Consultation hours (open)', location: s.location, startAt: s.startAt, endAt: s.endAt, allDay: false, link: '/consultations' });
    }
    for (const b of bookings) {
      items.push({ id: `booking:${b.id}`, kind: 'CONSULTATION', type: 'CONSULTATION', title: `Consultation with ${fullName(b.slot.teacher)}`, location: b.slot.location, startAt: b.slot.startAt, endAt: b.slot.endAt, allDay: false, link: '/consultations' });
    }
    items.sort((a, b) => a.startAt - b.startAt || a.title.localeCompare(b.title));
    ok(res, items, { timeZone: tz });
  },
);

// ── Events ───────────────────────────────────────────────────────────────────
const eventBody = z.object({
  scope: z.enum(['INSTITUTION', 'CLASS', 'PERSONAL']).default('PERSONAL'),
  classId: zId.nullable().optional(),
  type: z.enum(['HOLIDAY', 'INSTITUTIONAL', 'CLASS_ACTIVITY', 'EXAM', 'CONSULTATION', 'OTHER']).default('OTHER'),
  title: zTitle,
  description: z.string().trim().max(2000).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  startAt: zDateTime,
  endAt: zDateTime,
  allDay: z.boolean().default(false),
});

async function assertEventScope(user, scope, classId) {
  if (scope === 'INSTITUTION') {
    if (user.role !== 'ADMIN') throw forbidden('Only administrators can add institution-wide events.');
    return null;
  }
  if (scope === 'CLASS') {
    if (!classId) throw fieldErrors({ classId: 'Choose the class this event belongs to.' });
    const { cls } = await requireWritableClassManager(user, classId);
    return cls;
  }
  return null;
}

const eventView = (e) => ({ id: e.id, scope: e.scope, classId: e.classId, type: e.type, title: e.title, description: e.description, location: e.location, startAt: e.startAt, endAt: e.endAt, allDay: e.allDay });

calendarRouter.post('/events', validate({ body: eventBody }), async (req, res) => {
  const b = req.valid.body;
  if (b.endAt < b.startAt) throw fieldErrors({ endAt: 'The event cannot end before it starts.' });
  const cls = await assertEventScope(req.user, b.scope, b.classId);
  const event = await prisma.calendarEvent.create({
    data: {
      scope: b.scope, classId: b.scope === 'CLASS' ? cls.id : null, ownerId: req.user.id, type: b.type, title: plainText(b.title, 200),
      description: b.description ? plainText(b.description, 2000) : null, location: b.location ? plainText(b.location, 120) : null, startAt: b.startAt, endAt: b.endAt, allDay: b.allDay,
    },
  });
  if (cls) {
    const students = await prisma.enrollment.findMany({ where: { classId: cls.id, status: 'ENROLLED' }, select: { studentId: true } });
    await notify(students.map((s) => s.studentId), { type: 'calendar.event', title: `New on the calendar: ${event.title}`, body: classLabel(cls), link: '/calendar', classId: cls.id });
  }
  created(res, eventView(event));
});

async function loadOwnEvent(user, id) {
  const event = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!event) throw notFound('Event');
  const mayEdit = event.ownerId === user.id || (user.role === 'ADMIN' && event.scope !== 'PERSONAL');
  if (!mayEdit) {
    // Do not reveal other people's personal events.
    if (event.scope === 'PERSONAL') throw notFound('Event');
    throw forbidden('You cannot change this event.');
  }
  return event;
}

calendarRouter.patch('/events/:eventId', validate({ params: idParams('eventId'), body: patchOf(eventBody.omit({ scope: true, classId: true })) }), async (req, res) => {
  const event = await loadOwnEvent(req.user, req.valid.params.eventId);
  const b = req.valid.body;
  const startAt = b.startAt ?? event.startAt;
  const endAt = b.endAt ?? event.endAt;
  if (endAt < startAt) throw fieldErrors({ endAt: 'The event cannot end before it starts.' });
  const updated = await prisma.calendarEvent.update({
    where: { id: event.id },
    data: {
      ...(b.type !== undefined ? { type: b.type } : {}),
      ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
      ...(b.description !== undefined ? { description: b.description ? plainText(b.description, 2000) : null } : {}),
      ...(b.location !== undefined ? { location: b.location ? plainText(b.location, 120) : null } : {}),
      ...(b.allDay !== undefined ? { allDay: b.allDay } : {}),
      startAt, endAt,
    },
  });
  ok(res, eventView(updated));
});

calendarRouter.delete('/events/:eventId', validate({ params: idParams('eventId') }), async (req, res) => {
  const event = await loadOwnEvent(req.user, req.valid.params.eventId);
  await prisma.calendarEvent.delete({ where: { id: event.id } });
  noContent(res);
});

// ── Consultations ────────────────────────────────────────────────────────────
const slotView = (s, { forTeacher, userId }) => {
  const active = s.bookings.filter((b) => b.status === 'BOOKED');
  const mine = active.find((b) => b.studentId === userId);
  return {
    id: s.id, startAt: s.startAt, endAt: s.endAt, location: s.location, note: s.note, capacity: s.capacity, booked: active.length, available: Math.max(0, s.capacity - active.length),
    teacher: s.teacher ? { id: s.teacherId, name: fullName(s.teacher) } : undefined,
    ...(forTeacher ? { bookings: active.map((b) => ({ id: b.id, topic: b.topic, student: { id: b.studentId, name: fullName(b.student) }, createdAt: b.createdAt })) } : { myBooking: mine ? { id: mine.id, topic: mine.topic } : null }),
  };
};

/** Teachers a student may book: those teaching a class the student is enrolled in. */
async function teacherIdsOf(studentId) {
  const rows = await prisma.enrollment.findMany({ where: { studentId, status: 'ENROLLED', class: { status: 'ACTIVE' } }, select: { class: { select: { teacherId: true } } } });
  return [...new Set(rows.map((r) => r.class.teacherId))];
}

consultationsRouter.get('/slots', validate({ query: z.object({ includePast: z.enum(['true', 'false']).default('false') }) }), async (req, res) => {
  const now = new Date();
  const time = req.valid.query.includePast === 'true' ? {} : { endAt: { gte: now } };
  if (req.user.role === 'STUDENT') {
    const teacherIds = await teacherIdsOf(req.user.id);
    const slots = await prisma.consultationSlot.findMany({
      where: { teacherId: { in: teacherIds }, ...time },
      include: { teacher: { select: { firstName: true, lastName: true } }, bookings: { select: { id: true, studentId: true, status: true, topic: true } } },
      orderBy: { startAt: 'asc' }, take: 300,
    });
    return ok(res, slots.map((s) => slotView(s, { forTeacher: false, userId: req.user.id })));
  }
  const slots = await prisma.consultationSlot.findMany({
    where: { ...(req.user.role === 'TEACHER' ? { teacherId: req.user.id } : {}), ...time },
    include: { teacher: { select: { firstName: true, lastName: true } }, bookings: { include: { student: { select: { firstName: true, lastName: true } } } } },
    orderBy: { startAt: 'asc' }, take: 300,
  });
  return ok(res, slots.map((s) => slotView(s, { forTeacher: true, userId: req.user.id })));
});

const slotBody = z.object({
  startAt: zDateTime,
  endAt: zDateTime,
  location: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  capacity: z.number().int().min(1).max(50).default(1),
});

consultationsRouter.post('/slots', requireRole('TEACHER'), validate({ body: slotBody }), async (req, res) => {
  const b = req.valid.body;
  if (b.endAt <= b.startAt) throw fieldErrors({ endAt: 'The slot must end after it starts.' });
  if (b.endAt <= new Date()) throw fieldErrors({ startAt: 'Choose a time in the future.' });
  if (b.endAt.getTime() - b.startAt.getTime() > 8 * 3_600_000) throw fieldErrors({ endAt: 'A slot can be at most 8 hours long.' });
  const slot = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `consultation-slots:${req.user.id}`);
    const clash = await tx.consultationSlot.findFirst({ where: { teacherId: req.user.id, startAt: { lt: b.endAt }, endAt: { gt: b.startAt } } });
    if (clash) throw conflict('You already have consultation hours at that time.', 'SLOT_OVERLAP');
    return tx.consultationSlot.create({
      data: { teacherId: req.user.id, startAt: b.startAt, endAt: b.endAt, location: b.location ? plainText(b.location, 120) : null, note: b.note ? plainText(b.note, 300) : null, capacity: b.capacity },
      include: { teacher: { select: { firstName: true, lastName: true } }, bookings: { include: { student: { select: { firstName: true, lastName: true } } } } },
    });
  });
  created(res, slotView(slot, { forTeacher: true, userId: req.user.id }));
});

consultationsRouter.delete('/slots/:slotId', requireRole('TEACHER', 'ADMIN'), validate({ params: idParams('slotId') }), async (req, res) => {
  const slot = await prisma.consultationSlot.findUnique({ where: { id: req.valid.params.slotId }, include: { bookings: { where: { status: 'BOOKED' } } } });
  if (!slot || (req.user.role === 'TEACHER' && slot.teacherId !== req.user.id)) throw notFound('Consultation slot');
  await prisma.consultationSlot.delete({ where: { id: slot.id } });
  if (slot.endAt > new Date()) {
    await notify(slot.bookings.map((b) => b.studentId), { type: 'consultation.cancelled', title: 'A consultation was cancelled', body: `${fullName(req.user)} removed the consultation slot you booked.`, link: '/consultations' });
  }
  noContent(res);
});

consultationsRouter.post('/slots/:slotId/book', requireRole('STUDENT'), validate({ params: idParams('slotId'), body: z.object({ topic: z.string().trim().max(300).nullable().optional() }) }), async (req, res) => {
  const { slotId } = req.valid.params;
  const topic = req.valid.body.topic ? plainText(req.valid.body.topic, 300) : null;
  const result = await prisma.$transaction(async (tx) => {
    // Bookings of one slot are serialised so that the capacity can never be exceeded.
    await lockKey(tx, `consultation-slot:${slotId}`);
    const slot = await tx.consultationSlot.findUnique({ where: { id: slotId }, include: { bookings: true, teacher: { select: { firstName: true, lastName: true } } } });
    if (!slot || !(await teacherIdsOf(req.user.id)).includes(slot.teacherId)) throw notFound('Consultation slot');
    if (slot.startAt <= new Date()) throw conflict('This consultation has already started.', 'SLOT_PAST');
    const active = slot.bookings.filter((b) => b.status === 'BOOKED');
    const mine = slot.bookings.find((b) => b.studentId === req.user.id);
    if (mine?.status === 'BOOKED') return { slot, booking: mine, isNew: false };
    if (active.length >= slot.capacity) throw conflict('This slot is fully booked.', 'SLOT_FULL');
    const booking = mine
      ? await tx.consultationBooking.update({ where: { id: mine.id }, data: { status: 'BOOKED', topic } })
      : await tx.consultationBooking.create({ data: { slotId, studentId: req.user.id, topic } });
    return { slot, booking, isNew: true };
  });
  if (result.isNew) {
    await notify([result.slot.teacherId], { type: 'consultation.booked', title: `${fullName(req.user)} booked a consultation`, body: topic ?? undefined, link: '/consultations' });
  }
  (result.isNew ? created : ok)(res, { id: result.booking.id, slotId, topic: result.booking.topic, status: result.booking.status });
});

consultationsRouter.delete('/bookings/:bookingId', validate({ params: idParams('bookingId') }), async (req, res) => {
  const booking = await prisma.consultationBooking.findUnique({ where: { id: req.valid.params.bookingId }, include: { slot: true, student: { select: { firstName: true, lastName: true } } } });
  const isStudent = booking?.studentId === req.user.id;
  const isTeacher = booking?.slot.teacherId === req.user.id || req.user.role === 'ADMIN';
  if (!booking || (!isStudent && !isTeacher)) throw notFound('Booking');
  if (booking.status === 'BOOKED') {
    await prisma.consultationBooking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
    if (booking.slot.endAt > new Date()) {
      await notify([isStudent ? booking.slot.teacherId : booking.studentId], {
        type: 'consultation.cancelled', title: 'A consultation booking was cancelled',
        body: isStudent ? `${fullName(booking.student)} cancelled their booking.` : `${fullName(req.user)} cancelled your booking.`, link: '/consultations',
      });
    }
  }
  noContent(res);
});

// ── Personal tasks ───────────────────────────────────────────────────────────
const taskBody = z.object({ title: z.string().trim().min(1).max(200), dueAt: zDateTime.nullable().optional() });
const taskView = (t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, completedAt: t.completedAt, createdAt: t.createdAt });

tasksRouter.get('/', async (req, res) => {
  const tasks = await prisma.task.findMany({ where: { userId: req.user.id }, orderBy: [{ completedAt: { sort: 'desc', nulls: 'first' } }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }], take: 300 });
  ok(res, tasks.map(taskView));
});

tasksRouter.post('/', validate({ body: taskBody }), async (req, res) => {
  if ((await prisma.task.count({ where: { userId: req.user.id, completedAt: null } })) >= 200) throw conflict('You have too many open tasks. Complete or delete some first.', 'TOO_MANY_TASKS');
  const task = await prisma.task.create({ data: { userId: req.user.id, title: plainText(req.valid.body.title, 200), dueAt: req.valid.body.dueAt ?? null } });
  created(res, taskView(task));
});

tasksRouter.patch('/:taskId', validate({ params: idParams('taskId'), body: patchOf(taskBody).extend({ completed: z.boolean().optional() }) }), async (req, res) => {
  const task = await prisma.task.findFirst({ where: { id: req.valid.params.taskId, userId: req.user.id } });
  if (!task) throw notFound('Task');
  const b = req.valid.body;
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
      ...(b.dueAt !== undefined ? { dueAt: b.dueAt } : {}),
      ...(b.completed !== undefined ? { completedAt: b.completed ? task.completedAt ?? new Date() : null } : {}),
    },
  });
  ok(res, taskView(updated));
});

tasksRouter.delete('/:taskId', validate({ params: idParams('taskId') }), async (req, res) => {
  const { count } = await prisma.task.deleteMany({ where: { id: req.valid.params.taskId, userId: req.user.id } });
  if (count === 0) throw notFound('Task');
  noContent(res);
});
