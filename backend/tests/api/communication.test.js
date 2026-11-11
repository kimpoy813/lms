import { beforeAll, describe, expect, it } from 'vitest';
import { actor, anonymous, classroom, createUser, enroll, loginAs, minutesFromNow, prepare, prisma } from '../helpers/index.js';
import { setRolePermission } from '../../src/services/permissions.js';

beforeAll(async () => {
  await prepare();
});

const iso = (minutes) => minutesFromNow(minutes).toISOString();
const open = async (from, to) => from.post('/api/messages/conversations', { userId: to.user.id });

describe('direct messages', () => {
  it('delivers a message, counts it as unread and marks it read', async () => {
    const { teacher, students } = await classroom(1);
    const conv = await open(students[0], teacher);
    expect(conv.status).toBe(200);
    expect(conv.body.data.canSend).toBe(true);
    const id = conv.body.data.id;
    const sent = await students[0].post(`/api/messages/conversations/${id}/messages`, { body: 'Good day po, if a<b && c>d is this <script>alert(1)</script> right?' });
    expect(sent.status).toBe(201);
    // Stored as typed; the client renders it as text.
    expect(sent.body.data.body).toBe('Good day po, if a<b && c>d is this <script>alert(1)</script> right?');

    expect((await teacher.get('/api/messages/unread-count')).body.data.count).toBe(1);
    // The page header asks for both of its numbers at once.
    const notifications = (await teacher.get('/api/notifications/unread-count')).body.data.unread;
    expect((await teacher.get('/api/notifications/badges')).body.data).toEqual({ notifications, messages: 1 });
    expect((await anonymous().get('/api/notifications/badges')).status).toBe(401);
    const list = (await teacher.get('/api/messages/conversations')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, unread: 1 });
    expect(list[0].with.id).toBe(students[0].user.id);
    const thread = (await teacher.get(`/api/messages/conversations/${id}`)).body.data;
    expect(thread.messages).toHaveLength(1);
    expect((await teacher.post(`/api/messages/conversations/${id}/read`)).body.data.unread).toBe(0);
    expect((await teacher.post(`/api/messages/conversations/${id}/messages`, { body: 'Yes.' })).status).toBe(201);
    expect((await students[0].get('/api/messages/unread-count')).body.data.count).toBe(1);
    expect((await students[0].post(`/api/messages/conversations/${id}/messages`, { body: '   ' })).status).toBe(422);
  });

  it('keeps conversations private and lets the sender take a message back', async () => {
    const { teacher, students } = await classroom(2);
    const id = (await open(students[0], teacher)).body.data.id;
    const sent = (await students[0].post(`/api/messages/conversations/${id}/messages`, { body: 'Private question' })).body.data;
    expect((await students[1].get(`/api/messages/conversations/${id}`)).status).toBe(404);
    expect((await students[1].post(`/api/messages/conversations/${id}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await teacher.delete(`/api/messages/messages/${sent.id}`)).status).toBe(404);
    expect((await students[0].delete(`/api/messages/messages/${sent.id}`)).status).toBe(204);
    const seen = (await teacher.get(`/api/messages/conversations/${id}`)).body.data.messages[0];
    expect(seen).toMatchObject({ deleted: true, body: '' });
    expect((await prisma.message.findUnique({ where: { id: sent.id } })).body).toBe('');
  });

  it('limits who a student can write to', async () => {
    const { teacher, students } = await classroom(2);
    const stranger = await actor('TEACHER');
    const outsider = await actor('STUDENT');
    expect((await open(students[0], stranger)).status).toBe(403);
    expect((await open(students[0], outsider)).status).toBe(403);
    // Classmates: off by default.
    const mate = await open(students[0], students[1]);
    expect(mate.status).toBe(403);
    expect(mate.body.error.code).toBe('MESSAGING_NOT_ALLOWED');
    const contacts = (await students[0].get('/api/messages/contacts')).body.data.map((c) => c.id);
    expect(contacts).toEqual([teacher.user.id]);

    // A teacher outside the student's classes may not write to the student either…
    expect((await open(stranger, students[0])).status).toBe(403);
    // …but when the student's teacher writes first the student can always answer, even without the permission.
    const id = (await open(teacher, students[0])).body.data.id;
    await teacher.post(`/api/messages/conversations/${id}/messages`, { body: 'Please see me.' });
    await setRolePermission('STUDENT', 'messaging.student_to_teacher', false);
    try {
      expect((await students[0].get('/api/messages/contacts')).body.data).toEqual([]);
      expect((await students[0].post(`/api/messages/conversations/${id}/messages`, { body: 'Yes po.' })).status).toBe(201);
      expect((await open(students[1], teacher)).status).toBe(403);
    } finally {
      await setRolePermission('STUDENT', 'messaging.student_to_teacher', true);
    }
  });

  it('accepts attachments only from their uploader', async () => {
    const { teacher, students } = await classroom(1);
    const id = (await open(students[0], teacher)).body.data.id;
    const mine = (await students[0].upload([{ name: 'notes.txt', content: 'hello' }])).body.data[0];
    const theirs = (await teacher.upload([{ name: 'key.txt', content: 'answers' }])).body.data[0];
    expect((await students[0].post(`/api/messages/conversations/${id}/messages`, { body: '', fileIds: [theirs.id] })).status).toBe(400);
    const sent = await students[0].post(`/api/messages/conversations/${id}/messages`, { body: '', fileIds: [mine.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.data.attachments[0].name).toBe('notes.txt');
    expect((await teacher.get(`/api/files/${mine.id}`)).status).toBe(200);
    const outsider = await actor('STUDENT');
    expect((await outsider.get(`/api/files/${mine.id}`)).status).toBe(404);
  });
});

describe('class discussions', () => {
  it('lets the class talk, sanitises posts and notifies the people involved', async () => {
    const { teacher, cls, students } = await classroom(2);
    const made = await students[0].post(`/api/classes/${cls.id}/discussions`, { title: 'Question on loops', body: '<p>How do <strong>for</strong> loops work?</p><img src=x onerror=alert(1)>', topic: 'Week 1' });
    expect(made.status).toBe(201);
    expect(made.body.data.body).not.toMatch(/onerror/);
    const id = made.body.data.id;
    expect(await prisma.notification.count({ where: { userId: teacher.user.id, type: 'discussion.thread' } })).toBe(1);

    const reply = await teacher.post(`/api/discussions/threads/${id}/replies`, { body: '<p>They repeat a block.</p>' });
    expect(reply.status).toBe(201);
    const nested = await students[1].post(`/api/discussions/threads/${id}/replies`, { body: '<p>Thanks!</p>', parentReplyId: reply.body.data.id });
    expect(nested.body.data.parentReplyId).toBe(reply.body.data.id);
    // Deeper nesting is flattened to one level.
    const deeper = await students[0].post(`/api/discussions/threads/${id}/replies`, { body: '<p>Agreed</p>', parentReplyId: nested.body.data.id });
    expect(deeper.body.data.parentReplyId).toBe(reply.body.data.id);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'discussion.reply' } })).toBe(2);

    const list = await students[1].get(`/api/classes/${cls.id}/discussions`);
    expect(list.body.data[0]).toMatchObject({ id, replyCount: 3, topic: 'Week 1' });
    expect(list.body.meta.topics).toEqual(['Week 1']);
    expect((await students[1].get(`/api/classes/${cls.id}/discussions?search=loops`)).body.data).toHaveLength(1);
    expect((await students[1].get(`/api/classes/${cls.id}/discussions?search=recursion`)).body.data).toHaveLength(0);
    const outsider = await actor('STUDENT');
    expect((await outsider.get(`/api/discussions/threads/${id}`)).status).toBe(404);
    expect((await outsider.get(`/api/classes/${cls.id}/discussions`)).status).toBe(404);
  });

  it('gives moderation to the teacher only', async () => {
    const { teacher, cls, students } = await classroom(2);
    const id = (await students[0].post(`/api/classes/${cls.id}/discussions`, { title: 'Off topic', body: '<p>Hello</p>' })).body.data.id;
    const reply = (await students[1].post(`/api/discussions/threads/${id}/replies`, { body: '<p>Rude words</p>' })).body.data;
    expect((await students[1].patch(`/api/discussions/threads/${id}`, { isPinned: true })).status).toBe(403);
    expect((await students[1].patch(`/api/discussions/threads/${id}`, { title: 'Hijacked' })).status).toBe(403);
    expect((await students[0].patch(`/api/discussions/replies/${reply.id}`, { isHidden: true })).status).toBe(403);
    expect((await students[0].delete(`/api/discussions/replies/${reply.id}`)).status).toBe(403);

    expect((await teacher.patch(`/api/discussions/replies/${reply.id}`, { isHidden: true })).status).toBe(200);
    const forOther = (await students[0].get(`/api/discussions/threads/${id}`)).body.data.replies[0];
    expect(forOther).toMatchObject({ isHidden: true, body: '', author: null });
    const forAuthor = (await students[1].get(`/api/discussions/threads/${id}`)).body.data.replies[0];
    expect(forAuthor.body).toContain('Rude words');

    expect((await teacher.patch(`/api/discussions/threads/${id}`, { isLocked: true, isPinned: true })).status).toBe(200);
    const locked = await students[1].post(`/api/discussions/threads/${id}/replies`, { body: '<p>More</p>' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('THREAD_LOCKED');
    expect((await teacher.post(`/api/discussions/threads/${id}/replies`, { body: '<p>Closing note</p>' })).status).toBe(201);

    expect((await teacher.patch(`/api/discussions/threads/${id}`, { isHidden: true })).status).toBe(200);
    expect((await students[1].get(`/api/discussions/threads/${id}`)).status).toBe(404);
    expect((await students[1].get(`/api/classes/${cls.id}/discussions`)).body.data).toHaveLength(0);
    expect((await students[0].get(`/api/discussions/threads/${id}`)).status).toBe(200); // the author still sees it, marked hidden
    expect((await teacher.delete(`/api/discussions/threads/${id}`)).status).toBe(204);
    expect((await students[0].get(`/api/discussions/threads/${id}`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: { in: ['discussion.hide', 'discussion.delete'] } } })).toBe(2);
  });

  it('honours the permission to start threads', async () => {
    const { teacher, cls, students } = await classroom(1);
    await setRolePermission('STUDENT', 'discussion.create_thread', false);
    try {
      expect((await students[0].post(`/api/classes/${cls.id}/discussions`, { title: 'Hello', body: '<p>Hi</p>' })).status).toBe(403);
      const made = await teacher.post(`/api/classes/${cls.id}/discussions`, { title: 'Prompt of the week', body: '<p>Discuss.</p>' });
      expect(made.status).toBe(201);
      expect((await students[0].post(`/api/discussions/threads/${made.body.data.id}/replies`, { body: '<p>My answer</p>' })).status).toBe(201);
    } finally {
      await setRolePermission('STUDENT', 'discussion.create_thread', true);
    }
  });
});

describe('calendar', () => {
  it('merges events, class meetings and deadlines for the people concerned', async () => {
    const { teacher, cls, students } = await classroom(1, { schedules: { create: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '10:30' })) } });
    const outsider = await actor('STUDENT');
    const admin = await actor('ADMIN');
    await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Reflection paper', instructionsHtml: '<p>Write.</p>', points: 10, dueAt: iso(60 * 24), status: 'PUBLISHED' });
    await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Hidden draft', instructionsHtml: '<p>Write.</p>', points: 10, dueAt: iso(60 * 25), status: 'DRAFT' });
    const classEvent = await teacher.post('/api/calendar/events', { scope: 'CLASS', classId: cls.id, type: 'CLASS_ACTIVITY', title: 'Field trip', startAt: iso(60 * 30), endAt: iso(60 * 34) });
    expect(classEvent.status).toBe(201);
    expect((await students[0].post('/api/calendar/events', { scope: 'CLASS', classId: cls.id, title: 'Party', startAt: iso(60), endAt: iso(120) })).status).toBe(403);
    expect((await teacher.post('/api/calendar/events', { scope: 'INSTITUTION', title: 'Fake holiday', startAt: iso(60), endAt: iso(120) })).status).toBe(403);
    const holiday = await admin.post('/api/calendar/events', { scope: 'INSTITUTION', type: 'HOLIDAY', title: 'Foundation Day', startAt: iso(60 * 40), endAt: iso(60 * 41), allDay: true });
    expect(holiday.status).toBe(201);
    const personal = await students[0].post('/api/calendar/events', { title: 'Study group', startAt: iso(60 * 5), endAt: iso(60 * 6) });
    expect(personal.status).toBe(201);
    expect(personal.body.data.scope).toBe('PERSONAL');

    const range = `from=${encodeURIComponent(iso(-60))}&to=${encodeURIComponent(iso(60 * 24 * 3))}`;
    const mine = (await students[0].get(`/api/calendar?${range}`)).body.data;
    const titles = mine.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Field trip', 'Foundation Day', 'Study group', 'Due: Reflection paper']));
    expect(titles).not.toContain('Due: Hidden draft');
    expect(mine.filter((i) => i.kind === 'CLASS_MEETING').length).toBeGreaterThanOrEqual(2);
    expect(mine.every((i) => new Date(i.startAt).getTime() <= new Date(mine.at(-1).startAt).getTime())).toBe(true);

    const theirs = (await outsider.get(`/api/calendar?${range}`)).body.data.map((i) => i.title);
    expect(theirs).toContain('Foundation Day');
    expect(theirs).not.toContain('Field trip');
    expect(theirs).not.toContain('Study group');
    expect((await teacher.get(`/api/calendar?${range}`)).body.data.map((i) => i.title)).toContain('Due: Hidden draft');

    expect((await outsider.patch(`/api/calendar/events/${personal.body.data.id}`, { title: 'x' })).status).toBe(404);
    expect((await students[0].delete(`/api/calendar/events/${classEvent.body.data.id}`)).status).toBe(403);
    expect((await students[0].patch(`/api/calendar/events/${personal.body.data.id}`, { title: 'Study group (moved)' })).body.data.title).toBe('Study group (moved)');
    expect((await students[0].get(`/api/calendar?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(60 * 24 * 90))}`)).status).toBe(422);
  });
});

describe('consultations', () => {
  it('books up to the capacity, once per student, and only with their own teachers', async () => {
    const { teacher, cls, students } = await classroom(2);
    const third = await loginAs(await createUser('STUDENT'));
    await enroll(cls, third.user);
    const outsider = await actor('STUDENT');
    const slot = await teacher.post('/api/consultations/slots', { startAt: iso(60), endAt: iso(90), location: 'Faculty room', capacity: 2 });
    expect(slot.status).toBe(201);
    const id = slot.body.data.id;
    expect((await teacher.post('/api/consultations/slots', { startAt: iso(70), endAt: iso(100) })).status).toBe(409);
    expect((await students[0].post('/api/consultations/slots', { startAt: iso(200), endAt: iso(230) })).status).toBe(403);

    expect((await outsider.post(`/api/consultations/slots/${id}/book`, {})).status).toBe(404);
    expect((await outsider.get('/api/consultations/slots')).body.data).toEqual([]);
    const results = await Promise.all([students[0], students[1], third].map((s) => s.post(`/api/consultations/slots/${id}/book`, { topic: 'Grades' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('SLOT_FULL');
    const booked = [students[0], students[1], third][results.findIndex((r) => r.status === 201)];
    expect((await booked.post(`/api/consultations/slots/${id}/book`, { topic: 'Again' })).status).toBe(200);

    const seenByStudent = (await booked.get('/api/consultations/slots')).body.data[0];
    expect(seenByStudent).toMatchObject({ booked: 2, available: 0 });
    expect(seenByStudent.myBooking).toBeTruthy();
    expect(seenByStudent.bookings).toBeUndefined(); // other students' names stay private
    const seenByTeacher = (await teacher.get('/api/consultations/slots')).body.data[0];
    expect(seenByTeacher.bookings).toHaveLength(2);

    expect((await booked.delete(`/api/consultations/bookings/${seenByStudent.myBooking.id}`)).status).toBe(204);
    expect((await teacher.get('/api/consultations/slots')).body.data[0].booked).toBe(1);
    expect((await teacher.delete(`/api/consultations/slots/${id}`)).status).toBe(204);
    expect(await prisma.notification.count({ where: { type: 'consultation.cancelled' } })).toBeGreaterThanOrEqual(2);
  });
});

describe('tasks and search', () => {
  it('keeps a personal to-do list', async () => {
    const student = await actor('STUDENT');
    const other = await actor('STUDENT');
    const task = (await student.post('/api/tasks', { title: 'Review <b>chapter 3</b>', dueAt: iso(600) })).body.data;
    expect(task.title).toBe('Review chapter 3');
    expect((await other.get('/api/tasks')).body.data).toEqual([]);
    expect((await other.patch(`/api/tasks/${task.id}`, { completed: true })).status).toBe(404);
    const done = (await student.patch(`/api/tasks/${task.id}`, { completed: true })).body.data;
    expect(done.completedAt).toBeTruthy();
    expect(done.dueAt).toBe(task.dueAt);
    expect((await student.delete(`/api/tasks/${task.id}`)).status).toBe(204);
  });

  it('finds only what the person may see', async () => {
    const { teacher, cls, students } = await classroom(1);
    const outsider = await actor('STUDENT');
    await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Photosynthesis essay', instructionsHtml: '<p>Write.</p>', points: 10, dueAt: iso(600), status: 'PUBLISHED' });
    await teacher.post(`/api/classes/${cls.id}/assignments`, { title: 'Photosynthesis exam draft', instructionsHtml: '<p>Secret.</p>', points: 10, status: 'DRAFT' });
    await teacher.post('/api/announcements', { classId: cls.id, title: 'Photosynthesis lab moved', contentHtml: '<p>Room 2</p>' });
    await teacher.post('/api/announcements', { classId: cls.id, title: 'Photosynthesis surprise quiz', contentHtml: '<p>Soon</p>', status: 'SCHEDULED', publishAt: iso(600) });
    const draftModule = await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Photosynthesis unit (draft)', status: 'DRAFT' });
    expect(draftModule.status).toBe(201);
    expect((await teacher.post(`/api/modules/${draftModule.body.data.id}/lessons`, { title: 'Photosynthesis lesson in a draft module', contentHtml: '<p>x</p>' })).status).toBe(201);

    const flat = (res) => res.body.data.groups.flatMap((g) => g.items.map((i) => i.title));
    const forStudent = flat(await students[0].get('/api/search?q=photosynthesis'));
    expect(forStudent).toEqual(expect.arrayContaining(['Photosynthesis essay', 'Photosynthesis lab moved']));
    for (const hidden of ['Photosynthesis exam draft', 'Photosynthesis surprise quiz', 'Photosynthesis unit (draft)', 'Photosynthesis lesson in a draft module']) {
      expect(forStudent).not.toContain(hidden);
    }
    expect(forStudent).toHaveLength(2);
    expect(flat(await teacher.get('/api/search?q=photosynthesis'))).toContain('Photosynthesis exam draft');
    expect(flat(await outsider.get('/api/search?q=photosynthesis'))).toEqual([]);

    // People: teachers find their own students, students find nobody.
    const name = students[0].user.lastName;
    const people = (res) => res.body.data.groups.find((g) => g.type === 'person')?.items ?? [];
    expect(people(await teacher.get(`/api/search?q=${encodeURIComponent(name)}`)).map((p) => p.id)).toContain(students[0].user.id);
    expect(people(await outsider.get(`/api/search?q=${encodeURIComponent(name)}`))).toEqual([]);
    const stranger = await actor('TEACHER');
    expect(people(await stranger.get(`/api/search?q=${encodeURIComponent(name)}`))).toEqual([]);
    expect((await teacher.get('/api/search?q=a')).status).toBe(422);
  });
});
