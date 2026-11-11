import { beforeAll, describe, expect, it } from 'vitest';
import { actor, anonymous, classroom, createClass, minutesFromNow, prepare, prisma } from '../helpers/index.js';
import { publishScheduled } from '../../src/jobs/publishing.js';

beforeAll(prepare);

const mk = async (teacher, cls, body = {}) => (await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Module', status: 'PUBLISHED', ...body })).body.data;
const mkLesson = async (teacher, moduleId, body = {}) => (await teacher.post(`/api/modules/${moduleId}/lessons`, { title: 'Lesson', contentHtml: '<p>Hello</p>', ...body })).body.data;

describe('learning modules', () => {
  it('hides drafts from students and publishes on demand with a notification', async () => {
    const { teacher, cls, students } = await classroom(1);
    const draft = await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Week 1 — Introduction', objectives: ['Define an algorithm'] });
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    await mkLesson(teacher, draft.body.data.id);

    expect((await students[0].get(`/api/classes/${cls.id}/modules`)).body.data).toHaveLength(0);
    expect((await students[0].get(`/api/modules/${draft.body.data.id}`)).status).toBe(404);

    const published = await teacher.patch(`/api/modules/${draft.body.data.id}`, { status: 'PUBLISHED' });
    expect(published.body.data.status).toBe('PUBLISHED');
    const list = await students[0].get(`/api/classes/${cls.id}/modules`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ title: 'Week 1 — Introduction', lessonCount: 1, progressPercent: 0, locked: false });
    expect(list.body.data[0].status).toBeUndefined();
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'module.published' } })).toBe(1);
  });

  it('changes only the fields that were sent', async () => {
    const { teacher, cls } = await classroom(0);
    const mod = await mk(teacher, cls, { objectives: ['One', 'Two'] });
    const lesson = await mkLesson(teacher, mod.id, { kind: 'ACTIVITY', status: 'DRAFT', estimatedMinutes: 15 });
    expect((await teacher.patch(`/api/modules/${mod.id}`, { title: 'Renamed' })).body.data).toMatchObject({ title: 'Renamed', status: 'PUBLISHED', objectives: ['One', 'Two'] });
    const patched = (await teacher.patch(`/api/lessons/${lesson.id}`, { title: 'Renamed lesson' })).body.data;
    expect(patched).toMatchObject({ title: 'Renamed lesson', kind: 'ACTIVITY', status: 'DRAFT', estimatedMinutes: 15, contentHtml: '<p>Hello</p>' });
    const a = await teacher.post('/api/announcements', { classId: cls.id, title: 'Pinned', contentHtml: '<p>Body</p>', priority: 'URGENT', isPinned: true, allowComments: true });
    expect((await teacher.patch(`/api/announcements/${a.body.data.id}`, { title: 'Still pinned' })).body.data).toMatchObject({ title: 'Still pinned', priority: 'URGENT', isPinned: true, allowComments: true, status: 'PUBLISHED' });
  });

  it('publishes scheduled modules when their time comes', async () => {
    const { teacher, cls, students } = await classroom(1);
    const noDate = await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Later', status: 'SCHEDULED' });
    expect(noDate.status).toBe(422);
    const scheduled = await mk(teacher, cls, { status: 'SCHEDULED', publishAt: minutesFromNow(60).toISOString() });
    expect(scheduled.status).toBe('SCHEDULED');
    expect((await students[0].get(`/api/classes/${cls.id}/modules`)).body.data).toHaveLength(0);

    await prisma.learningModule.update({ where: { id: scheduled.id }, data: { publishAt: minutesFromNow(-1) } });
    // Visible immediately, even before the job runs …
    expect((await students[0].get(`/api/classes/${cls.id}/modules`)).body.data).toHaveLength(1);
    // … and the job announces it exactly once.
    expect((await publishScheduled()).modules).toBeGreaterThanOrEqual(1);
    await publishScheduled();
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'module.published' } })).toBe(1);
    expect((await prisma.learningModule.findUnique({ where: { id: scheduled.id } })).status).toBe('PUBLISHED');
  });

  it('sanitises lesson content', async () => {
    const { teacher, cls, students } = await classroom(1);
    const mod = await mk(teacher, cls);
    const lesson = await mkLesson(teacher, mod.id, { contentHtml: '<h2>Loops</h2><script>alert(1)</script><img src=x onerror="alert(2)"><p onclick="x()">Body</p>' });
    const seen = await students[0].get(`/api/lessons/${lesson.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.contentHtml).toContain('<h2>Loops</h2>');
    expect(seen.body.data.contentHtml).not.toMatch(/script|onerror|onclick/);
  });

  it('tracks progress and enforces lesson and module prerequisites', async () => {
    const { teacher, cls, students } = await classroom(2);
    const [s1, s2] = students;
    const m1 = await mk(teacher, cls, { title: 'Module 1' });
    const l1 = await mkLesson(teacher, m1.id, { title: 'L1' });
    const l2 = await mkLesson(teacher, m1.id, { title: 'L2', prerequisiteLessonId: l1.id });
    const m2 = await mk(teacher, cls, { title: 'Module 2', prerequisiteModuleId: m1.id });
    const l3 = await mkLesson(teacher, m2.id, { title: 'L3' });

    let list = (await s1.get(`/api/classes/${cls.id}/modules`)).body.data;
    expect(list[1]).toMatchObject({ locked: true, lockedReason: 'Complete "Module 1" first.' });
    expect(list[0].lessons.map((l) => l.locked)).toEqual([false, true]);
    expect((await s1.get(`/api/lessons/${l2.id}`)).body.error.code).toBe('LESSON_LOCKED');
    expect((await s1.get(`/api/lessons/${l3.id}`)).status).toBe(403);
    expect((await s1.post(`/api/lessons/${l2.id}/complete`)).status).toBe(403);

    expect((await s1.post(`/api/lessons/${l1.id}/complete`)).body.data.completed).toBe(true);
    expect((await s1.get(`/api/lessons/${l2.id}`)).status).toBe(200);
    await s1.post(`/api/lessons/${l2.id}/complete`);
    list = (await s1.get(`/api/classes/${cls.id}/modules`)).body.data;
    expect(list[0]).toMatchObject({ progressPercent: 100, completedLessons: 2 });
    expect(list[1].locked).toBe(false);
    expect((await s1.get(`/api/lessons/${l3.id}`)).status).toBe(200);

    // Progress is personal: the other student is still locked out.
    expect((await s2.get(`/api/lessons/${l3.id}`)).status).toBe(403);
    const progress = (await teacher.get(`/api/classes/${cls.id}/modules-progress`)).body.data;
    expect(progress.totalLessons).toBe(3);
    expect(progress.students.find((s) => s.id === s1.user.id)).toMatchObject({ completedLessons: 2, percent: 67 });
    expect(progress.students.find((s) => s.id === s2.user.id).completedLessons).toBe(0);
    expect((await s1.get(`/api/classes/${cls.id}/modules-progress`)).status).toBe(403);
    // Teachers do not "complete" lessons.
    expect((await teacher.post(`/api/lessons/${l1.id}/complete`)).status).toBe(403);
  });

  it('rejects circular prerequisites and modules from other classes', async () => {
    const { teacher, cls } = await classroom(0);
    const other = await createClass(teacher.user);
    const a = await mk(teacher, cls, { title: 'A' });
    const b = await mk(teacher, cls, { title: 'B', prerequisiteModuleId: a.id });
    const foreign = await mk(teacher, other, { title: 'Foreign' });
    expect((await teacher.patch(`/api/modules/${a.id}`, { prerequisiteModuleId: b.id })).status).toBe(422);
    expect((await teacher.patch(`/api/modules/${a.id}`, { prerequisiteModuleId: a.id })).status).toBe(422);
    expect((await teacher.patch(`/api/modules/${a.id}`, { prerequisiteModuleId: foreign.id })).status).toBe(422);
  });

  it('reorders modules and lessons and detects stale lists', async () => {
    const { teacher, cls } = await classroom(0);
    const a = await mk(teacher, cls, { title: 'A' });
    const b = await mk(teacher, cls, { title: 'B' });
    const c = await mk(teacher, cls, { title: 'C' });
    const res = await teacher.put(`/api/classes/${cls.id}/modules/order`, { ids: [c.id, a.id, b.id] });
    expect(res.body.data.map((m) => m.title)).toEqual(['C', 'A', 'B']);
    expect((await teacher.put(`/api/classes/${cls.id}/modules/order`, { ids: [c.id, a.id] })).status).toBe(409);
    const l1 = await mkLesson(teacher, a.id, { title: 'one' });
    const l2 = await mkLesson(teacher, a.id, { title: 'two' });
    const lessons = await teacher.put(`/api/modules/${a.id}/lessons/order`, { ids: [l2.id, l1.id] });
    expect(lessons.body.data.lessons.map((l) => l.title)).toEqual(['two', 'one']);
  });

  it('copies a module into another class as a draft', async () => {
    const { teacher, cls } = await classroom(0);
    const target = await createClass(teacher.user);
    const stranger = await actor('TEACHER');
    const strangerClass = await createClass(stranger.user);
    const mod = await mk(teacher, cls, { title: 'Reusable' });
    await mkLesson(teacher, mod.id, { title: 'Reusable lesson' });
    const copy = await teacher.post(`/api/modules/${mod.id}/copy`, { targetClassId: target.id });
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ classId: target.id, status: 'DRAFT', title: 'Reusable', lessonCount: 1 });
    // Not into, or out of, somebody else's class.
    expect((await teacher.post(`/api/modules/${mod.id}/copy`, { targetClassId: strangerClass.id })).status).toBe(404);
    expect((await stranger.post(`/api/modules/${mod.id}/copy`, { targetClassId: strangerClass.id })).status).toBe(404);
  });

  it('is only editable by the class teacher', async () => {
    const { teacher, cls, students } = await classroom(1);
    const other = await actor('TEACHER');
    const mod = await mk(teacher, cls);
    const lesson = await mkLesson(teacher, mod.id);
    for (const who of [students[0], other]) {
      const expected = who === other ? 404 : 403;
      expect((await who.post(`/api/classes/${cls.id}/modules`, { title: 'x' })).status).toBe(expected);
      expect((await who.patch(`/api/modules/${mod.id}`, { title: 'x' })).status).toBe(expected);
      expect((await who.delete(`/api/modules/${mod.id}`)).status).toBe(expected);
      expect((await who.patch(`/api/lessons/${lesson.id}`, { title: 'x' })).status).toBe(expected);
      expect((await who.post(`/api/modules/${mod.id}/lessons`, { title: 'x' })).status).toBe(expected);
    }
    expect((await other.get(`/api/lessons/${lesson.id}`)).status).toBe(404);
    expect((await anonymous().get(`/api/lessons/${lesson.id}`)).status).toBe(401);
  });
});

describe('resources', () => {
  it('serves uploaded files to class members only, and respects publication', async () => {
    const { teacher, cls, students } = await classroom(1);
    const outsider = await actor('STUDENT');
    const mod = await mk(teacher, cls, { status: 'DRAFT' });
    const upload = await teacher.upload([{ name: 'Syllabus.pdf', content: '%PDF-1.4 syllabus' }]);
    const fileId = upload.body.data[0].id;
    const res = await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Syllabus', type: 'FILE', fileId, moduleId: mod.id });
    expect(res.status).toBe(201);

    // The module is still a draft: students cannot list or download the file.
    expect((await students[0].get(`/api/classes/${cls.id}/resources`)).body.data).toHaveLength(0);
    expect((await students[0].get(`/api/files/${fileId}`)).status).toBe(404);

    await teacher.patch(`/api/modules/${mod.id}`, { status: 'PUBLISHED' });
    expect((await students[0].get(`/api/classes/${cls.id}/resources`)).body.data).toHaveLength(1);
    const download = await students[0].get(`/api/files/${fileId}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('Syllabus.pdf');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect((await outsider.get(`/api/files/${fileId}`)).status).toBe(404);
    expect((await anonymous().get(`/api/files/${fileId}`)).status).toBe(401);

    // Hiding the resource hides the file again.
    await teacher.patch(`/api/resources/${res.body.data.id}`, { isPublished: false });
    expect((await students[0].get(`/api/files/${fileId}`)).status).toBe(404);
  });

  it('cannot turn somebody else\'s upload into a class resource', async () => {
    const { teacher, cls, students } = await classroom(1);
    const upload = await students[0].upload([{ name: 'private.pdf', content: '%PDF-1.4 private' }]);
    const res = await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Grab', type: 'FILE', fileId: upload.body.data[0].id });
    expect(res.status).toBe(422);
  });

  it('accepts links and converts video links to privacy-friendly embeds', async () => {
    const { teacher, cls } = await classroom(0);
    const link = await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Docs', type: 'LINK', url: 'https://developer.mozilla.org/en-US/' });
    expect(link.status).toBe(201);
    const video = await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Video', type: 'EMBED', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5' });
    expect(video.body.data.url).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'not a url', 'ftp://example.com/x']) {
      expect((await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Bad', type: 'LINK', url })).status, url).toBe(422);
    }
    expect((await teacher.post(`/api/classes/${cls.id}/resources`, { title: 'Bad', type: 'EMBED', url: 'https://evil.example/embed/1' })).status).toBe(422);
  });

  it('rejects dangerous uploads', async () => {
    const teacher = await actor('TEACHER');
    const exe = await teacher.upload([{ name: 'setup.exe', content: 'MZ\u0090\u0000' }]);
    expect(exe.status).toBe(415);
    expect(exe.body.error.code).toBe('FILE_TYPE_REJECTED');
    const disguised = await teacher.upload([{ name: 'notes.pdf', content: '<html><script>alert(1)</script></html>' }]);
    expect(disguised.status).toBe(415);
    const svg = await teacher.upload([{ name: 'logo.svg', content: '<svg onload="alert(1)"/>' }]);
    expect(svg.status).toBe(415);
    const tooBig = await teacher.upload([{ name: 'big.pdf', content: Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(3 * 1024 * 1024)]) }]);
    expect(tooBig.status).toBe(413);
    expect((await anonymous().post('/api/files').attach('files', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(401);
    // Path tricks in the file name are neutralised, never used as a path.
    const traversal = await teacher.upload([{ name: '../../../etc/cron.d/evil.txt', content: 'hello' }]);
    expect(traversal.status).toBe(201);
    expect(traversal.body.data[0].name).not.toContain('/');
    const stored = await prisma.file.findUnique({ where: { id: traversal.body.data[0].id } });
    expect(stored.storedName).toMatch(/^[a-f0-9-]+$/i);
  });

  it('supports bookmarks that belong to their owner', async () => {
    const { teacher, cls, students } = await classroom(2);
    const mod = await mk(teacher, cls);
    const lesson = await mkLesson(teacher, mod.id);
    expect((await students[0].post('/api/bookmarks', { lessonId: lesson.id })).status).toBe(201);
    expect((await students[0].post('/api/bookmarks', { lessonId: lesson.id })).status).toBe(201); // idempotent
    expect((await students[0].get('/api/bookmarks')).body.data).toHaveLength(1);
    expect((await students[1].get('/api/bookmarks')).body.data).toHaveLength(0);
    expect((await (await actor('STUDENT')).post('/api/bookmarks', { lessonId: lesson.id })).status).toBe(404);
    expect((await students[0].delete('/api/bookmarks', { lessonId: lesson.id })).status).toBe(204);
    expect((await students[0].get('/api/bookmarks')).body.data).toHaveLength(0);
  });
});

describe('announcements', () => {
  const post = (who, body) => who.post('/api/announcements', { title: 'Quiz moved', contentHtml: '<p>The quiz is moved to Friday.</p>', ...body });

  it('reach the whole class, or only the selected students', async () => {
    const { teacher, cls, students } = await classroom(3);
    const outsider = await actor('STUDENT');
    const all = await post(teacher, { classId: cls.id, priority: 'HIGH', isPinned: true });
    expect(all.status).toBe(201);
    const some = await post(teacher, { classId: cls.id, title: 'For two of you', audience: 'SELECTED', recipientIds: [students[0].user.id, students[1].user.id] });
    expect(some.status).toBe(201);

    const titles = async (who) => (await who.get(`/api/announcements?classId=${cls.id}`)).body.data.map((a) => a.title);
    expect(await titles(students[0])).toEqual(['Quiz moved', 'For two of you']); // pinned first
    expect(await titles(students[2])).toEqual(['Quiz moved']);
    expect((await students[2].get(`/api/announcements/${some.body.data.id}`)).status).toBe(404);
    expect((await outsider.get(`/api/announcements?classId=${cls.id}`)).status).toBe(404);
    expect((await outsider.get(`/api/announcements/${all.body.data.id}`)).status).toBe(404);
    expect((await outsider.get('/api/announcements')).body.data).toHaveLength(0);

    // The recipient list is not disclosed to students.
    expect((await students[0].get(`/api/announcements/${some.body.data.id}`)).body.data.recipientIds).toBeUndefined();
    expect(await prisma.notification.count({ where: { type: 'announcement.new', userId: students[2].user.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'announcement.new', userId: students[0].user.id } })).toBe(2);
    const bad = await post(teacher, { classId: cls.id, audience: 'SELECTED', recipientIds: [outsider.user.id] });
    expect(bad.status).toBe(422);
  });

  it('keeps drafts and scheduled posts private until they are published', async () => {
    const { teacher, cls, students } = await classroom(1);
    const draft = await post(teacher, { classId: cls.id, status: 'DRAFT' });
    const scheduled = await post(teacher, { classId: cls.id, title: 'Later', status: 'SCHEDULED', publishAt: minutesFromNow(30).toISOString() });
    expect((await students[0].get('/api/announcements')).body.data).toHaveLength(0);
    expect((await teacher.get(`/api/announcements?classId=${cls.id}`)).body.data).toHaveLength(2);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id } })).toBe(0);

    await prisma.announcement.update({ where: { id: scheduled.body.data.id }, data: { publishAt: minutesFromNow(-1) } });
    await publishScheduled();
    expect((await students[0].get('/api/announcements')).body.data.map((a) => a.title)).toEqual(['Later']);
    await teacher.patch(`/api/announcements/${draft.body.data.id}`, { status: 'PUBLISHED' });
    expect((await students[0].get('/api/announcements')).body.data).toHaveLength(2);
    expect(await prisma.notification.count({ where: { userId: students[0].user.id, type: 'announcement.new' } })).toBe(2);
  });

  it('allows comments only when enabled, with moderation by the teacher', async () => {
    const { teacher, cls, students } = await classroom(2);
    const closed = await post(teacher, { classId: cls.id });
    expect((await students[0].post(`/api/announcements/${closed.body.data.id}/comments`, { body: 'Hi' })).status).toBe(409);
    const open = await post(teacher, { classId: cls.id, allowComments: true });
    const comment = await students[0].post(`/api/announcements/${open.body.data.id}/comments`, { body: '<b>Noted</b>, thank you!' });
    expect(comment.status).toBe(201);
    expect(comment.body.data.body).toBe('Noted, thank you!');
    expect((await students[1].delete(`/api/announcements/${open.body.data.id}/comments/${comment.body.data.id}`)).status).toBe(403);
    expect((await teacher.delete(`/api/announcements/${open.body.data.id}/comments/${comment.body.data.id}`)).status).toBe(204);
    expect((await students[0].get(`/api/announcements/${open.body.data.id}`)).body.data.comments).toHaveLength(0);
  });

  it('can only be posted and edited by the class teacher; institution-wide posts are for administrators', async () => {
    const { teacher, cls, students } = await classroom(1);
    const other = await actor('TEACHER');
    const admin = await actor('ADMIN');
    expect((await post(students[0], { classId: cls.id })).status).toBe(403);
    expect((await post(other, { classId: cls.id })).status).toBe(404);
    expect((await post(teacher, {})).status).toBe(422);
    const a = await post(teacher, { classId: cls.id });
    expect((await students[0].patch(`/api/announcements/${a.body.data.id}`, { title: 'Hacked' })).status).toBe(403);
    expect((await students[0].delete(`/api/announcements/${a.body.data.id}`)).status).toBe(403);
    expect((await other.patch(`/api/announcements/${a.body.data.id}`, { title: 'Hacked' })).status).toBe(404);

    const wide = await post(admin, { title: 'Enrolment week' });
    expect(wide.status).toBe(201);
    expect(wide.body.data.audience).toBe('INSTITUTION');
    expect((await students[0].get('/api/announcements')).body.data.map((x) => x.title)).toContain('Enrolment week');
    expect((await other.get('/api/announcements')).body.data.map((x) => x.title)).toContain('Enrolment week');
    await admin.delete(`/api/announcements/${wide.body.data.id}`);
  });
});

describe('notifications', () => {
  it('belong to their owner', async () => {
    const { teacher, cls, students } = await classroom(2);
    await teacher.post('/api/announcements', { classId: cls.id, title: 'Hello', contentHtml: '<p>Hi</p>' });
    const mine = await students[0].get('/api/notifications');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.meta.unread).toBe(1);
    const id = mine.body.data[0].id;

    // Another user can neither read nor change it.
    await students[1].post(`/api/notifications/${id}/read`);
    await students[1].delete(`/api/notifications/${id}`);
    expect((await students[0].get('/api/notifications/unread-count')).body.data.unread).toBe(1);

    expect((await students[0].post(`/api/notifications/${id}/read`)).body.data.unread).toBe(0);
    expect((await students[0].delete(`/api/notifications/${id}`)).status).toBe(204);
    expect((await students[0].get('/api/notifications')).body.data).toHaveLength(0);
    expect((await students[1].get('/api/notifications')).body.data).toHaveLength(1);
    expect((await students[1].post('/api/notifications/read-all')).body.data.updated).toBe(1);
  });
});
