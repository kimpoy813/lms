// Integration tests for academic & PH school workflows + Web Push subscriptions:
//   • Calendar .ics export
//   • Student Term Report Card PDF/CSV export
//   • Monthly attendance matrix (DepEd SF2 style) filter & export
//   • One-click section enrollment
//   • Web Push subscription registration & stale subscription cleanup
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as webpushNs from 'web-push';
import { actor, createClass, createUser, enroll, loginAs, prepare, prisma, uid } from '../helpers/index.js';
import { buildPushPayload, sendPushToUsers, setPushSenderForTest } from '../../src/services/push.js';
import { notify } from '../../src/services/notifications.js';
import { env } from '../../src/config/env.js';

beforeAll(prepare);

describe('Academic workflows & Web Push API', () => {
  it('exports personalized .ics calendar feeds excluding teacher drafts from students', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    const student = await actor('STUDENT');
    const cls = await createClass(teacher.user);
    await enroll(cls, student.user);

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const dayAfter = new Date(now.getTime() + 2 * 86_400_000);

    await prisma.assignment.createMany({
      data: [
        { classId: cls.id, title: 'Published Lab', points: 10, status: 'PUBLISHED', publishedAt: now, dueAt: tomorrow, createdById: teacher.user.id },
        { classId: cls.id, title: 'Secret Draft Lab', points: 10, status: 'DRAFT', dueAt: tomorrow, createdById: teacher.user.id },
      ],
    });
    await prisma.calendarEvent.create({
      data: { scope: 'INSTITUTION', type: 'HOLIDAY', title: 'Foundation Day', startAt: tomorrow, endAt: dayAfter, allDay: true, ownerId: admin.user.id },
    });

    const from = new Date(now.getTime() - 86_400_000).toISOString();
    const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const res = await student.get(`/api/calendar/export.ics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['content-disposition']).toContain('discenda-calendar.ics');
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('Published Lab');
    expect(res.text).toContain('Foundation Day');
    expect(res.text).not.toContain('Secret Draft Lab');
  });

  it('generates Student Term Report Card PDF and CSV exports for students and admins', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    const student = await actor('STUDENT');
    const cls = await createClass(teacher.user);
    await enroll(cls, student.user);

    await prisma.finalGrade.create({
      data: {
        classId: cls.id,
        studentId: student.user.id,
        scope: 'OVERALL',
        percent: 93.5,
        label: '1.25',
        remark: 'Passed',
        isPassing: true,
        finalizedById: teacher.user.id,
        breakdown: { periods: [{ name: 'Midterm', published: true, percent: 92, label: '1.50' }] },
      },
    });
    await prisma.class.update({ where: { id: cls.id }, data: { gradesFinalizedAt: new Date() } });

    const pdfRes = await student.get('/api/grades/mine/export?format=pdf').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.body.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const csvRes = await student.get('/api/grades/mine/export?format=csv');
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain(cls.course.code);
    expect(csvRes.text).toContain('93.5');
    expect(csvRes.text).toContain('1.25');

    const adminRes = await admin.get(`/api/grades/students/${student.user.id}/export?format=csv`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.text).toContain(cls.course.code);

    const forbiddenRes = await student.get(`/api/grades/students/${student.user.id}/export?format=pdf`);
    expect(forbiddenRes.status).toBe(403);
  });

  it('filters and exports monthly attendance registers (DepEd SF2 style)', async () => {
    const teacher = await actor('TEACHER');
    const student = await actor('STUDENT');
    const cls = await createClass(teacher.user);
    await enroll(cls, student.user);

    const novSession = await prisma.attendanceSession.create({
      data: {
        classId: cls.id,
        teacherId: teacher.user.id,
        date: new Date('2026-11-10T00:00:00.000Z'),
        startTime: new Date('2026-11-10T01:00:00.000Z'),
        endTime: new Date('2026-11-10T02:00:00.000Z'),
        status: 'CLOSED',
        qrSecret: uid('qr'),
      },
    });
    const octSession = await prisma.attendanceSession.create({
      data: {
        classId: cls.id,
        teacherId: teacher.user.id,
        date: new Date('2026-10-05T00:00:00.000Z'),
        startTime: new Date('2026-10-05T01:00:00.000Z'),
        endTime: new Date('2026-10-05T02:00:00.000Z'),
        status: 'CLOSED',
        qrSecret: uid('qr'),
      },
    });
    await prisma.attendanceRecord.createMany({
      data: [
        { sessionId: novSession.id, studentId: student.user.id, status: 'PRESENT', verificationMethod: 'MANUAL' },
        { sessionId: octSession.id, studentId: student.user.id, status: 'ABSENT', verificationMethod: 'MANUAL' },
      ],
    });

    const summary = await teacher.get(`/api/classes/${cls.id}/attendance/summary?month=2026-11`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.availableMonths).toEqual(['2026-11', '2026-10']);
    expect(summary.body.data.sessions).toHaveLength(1);
    expect(summary.body.data.students[0]).toMatchObject({ present: 1, absent: 0, rate: 100 });

    const csv = await teacher.get(`/api/classes/${cls.id}/attendance/export?format=csv&month=2026-11`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('2026-11');
    expect(csv.text).toContain('Student No.,Name,10,Present,Late,Absent,Excused,Rate %');
    expect(csv.text).toContain(',P,1,0,0,0,100');

    const pdf = await teacher.get(`/api/classes/${cls.id}/attendance/export?format=pdf&month=2026-11`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('enrolls an entire section into an active class in one click while skipping duplicates', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    const section = await prisma.section.create({ data: { name: uid('BSIT-3A') } });
    const cls = await createClass(teacher.user, { sectionId: section.id });

    const s1 = await createUser('STUDENT');
    const s2 = await createUser('STUDENT');
    const inactive = await createUser('STUDENT', { status: 'SUSPENDED' });
    await prisma.studentProfile.updateMany({
      where: { userId: { in: [s1.id, s2.id, inactive.id] } },
      data: { sectionId: section.id },
    });
    await enroll(cls, s1.user ?? s1);

    const firstRes = await admin.post('/api/admin/enrollments/section', { classId: cls.id, sectionId: section.id });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data).toMatchObject({
      sectionId: section.id,
      classId: cls.id,
      totalInSection: 2,
      enrolledCount: 1,
      alreadyEnrolledCount: 1,
    });
    expect(await prisma.enrollment.count({ where: { classId: cls.id, status: 'ENROLLED' } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: s2.id, type: 'enrollment.approved' } })).toBe(1);

    const studentClient = await loginAs(s1);
    const forbidden = await studentClient.post('/api/admin/enrollments/section', { classId: cls.id, sectionId: section.id });
    expect(forbidden.status).toBe(403);
  });

  it('manages Web Push subscriptions and prunes stale 410 endpoints on delivery', async () => {
    const student = await actor('STUDENT');
    const endpoint = `https://push.example.com/sub/${uid('ep')}`;

    const configBefore = await student.get('/api/notifications/push/config');
    expect(configBefore.status).toBe(200);
    expect(configBefore.body.data).toMatchObject({ supported: false, subscribedDevices: 0 });

    // Temporarily enable VAPID keys on env.push for subscription endpoint & delivery verification.
    const origPush = { ...env.push };
    Object.assign(env.push, {
      configured: true,
      publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
      privateKey: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
      subject: 'mailto:test@discenda.local',
    });

    try {
      const subRes = await student.post('/api/notifications/push/subscribe', {
        endpoint,
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
      });
      expect(subRes.status).toBe(200);
      expect(await prisma.pushSubscription.count({ where: { userId: student.user.id } })).toBe(1);

      const sender = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));
      const delivery = await sendPushToUsers([student.user.id], { title: 'Test', body: 'Hello', link: '/' }, { sender });
      expect(sender).toHaveBeenCalledTimes(1);
      expect(delivery).toEqual({ sent: 0, removed: 1 });
      expect(await prisma.pushSubscription.count({ where: { userId: student.user.id } })).toBe(0);

      // Re-subscribe then verify rich payload & urgency delivery + manual unsubscribe
      await student.post('/api/notifications/push/subscribe', {
        endpoint,
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
      });

      const okSender = vi.fn().mockResolvedValueOnce({ statusCode: 201 });
      const sent = await sendPushToUsers(
        [student.user.id],
        { type: 'assignment.published', title: 'New assignment in CS 101: Lab 1' },
        { sender: okSender },
      );
      expect(sent).toEqual({ sent: 1, removed: 0 });
      expect(okSender).toHaveBeenCalledTimes(1);
      const sentPayload = JSON.parse(okSender.mock.calls[0][1]);
      expect(sentPayload.title).toBe('New assignment in CS 101: Lab 1');
      expect(sentPayload.body.length).toBeGreaterThan(10);
      expect(sentPayload.tag).toContain('assignment.published-');
      expect(typeof sentPayload.timestamp).toBe('number');

      const urgentSender = vi.fn().mockResolvedValueOnce({ statusCode: 201 });
      await sendPushToUsers([student.user.id], { type: 'message.new', title: 'Message from Prof', body: 'See you in lab' }, { sender: urgentSender });
      expect(urgentSender.mock.calls[0][2]).toMatchObject({ urgency: 'high' });

      const fallbackParsed = JSON.parse(buildPushPayload({ type: 'grades.published', title: 'Midterm grades' }));
      expect(fallbackParsed.body).toContain('posted grades');
      const bodyOnly = JSON.parse(buildPushPayload({ type: 'grades.published', body: 'Your Biology final grade is ready.' }));
      expect(bodyOnly).toMatchObject({ title: 'Your Biology final grade is ready.', body: 'Your Biology final grade is ready.' });
      const brandedOnly = JSON.parse(buildPushPayload({ type: 'grades.published', title: 'EduSphere', body: 'Your Biology final grade is ready.' }));
      expect(brandedOnly).toMatchObject({ title: 'Your Biology final grade is ready.', body: 'Your Biology final grade is ready.' });
      const emptyNotice = JSON.parse(buildPushPayload({ type: 'grades.published' }));
      expect(emptyNotice.title).not.toBe('Discenda');
      expect(emptyNotice.body).toContain('posted grades');

      const unsub = await student.post('/api/notifications/push/unsubscribe', { endpoint });
      expect(unsub.status).toBe(200);
      expect(unsub.body.data.removed).toBe(1);
    } finally {
      Object.assign(env.push, origPush);
    }
  });

  it('mirrors in-app notification details to Web Push for modules and other notices', async () => {
    const teacher = await actor('TEACHER');
    const student = await actor('STUDENT');
    const cls = await createClass(teacher.user);
    await enroll(cls, student.user);

    const modRes = await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Week 1: Variables', status: 'PUBLISHED' });
    expect(modRes.status).toBe(201);

    const assRes = await teacher.post(`/api/classes/${cls.id}/assignments`, {
      title: 'Lab 1: Expressions',
      points: 25,
      submissionType: 'ONLINE_TEXT',
      status: 'PUBLISHED',
    });
    expect(assRes.status).toBe(201);

    const notifs = (await student.get('/api/notifications')).body.data;
    const modNotif = notifs.find((n) => n.type === 'module.published');
    const assNotif = notifs.find((n) => n.type === 'assignment.published');
    expect(modNotif?.body).toContain('Week 1: Variables');
    expect(assNotif?.body).toContain('25 pts');

    // Direct message triggers Web Push with sender name & message preview when VAPID is active
    const origPush = { ...env.push };
    const keys = (webpushNs.default?.generateVAPIDKeys ? webpushNs.default : webpushNs).generateVAPIDKeys();
    Object.assign(env.push, {
      configured: true,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'https://discenda.example.edu',
    });
    const endpoint = `https://push.example.com/sub/${uid('dm')}`;
    await student.post('/api/notifications/push/subscribe', {
      endpoint,
      keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
    });
    const senderSpy = vi.fn().mockResolvedValue({ statusCode: 201 });
    setPushSenderForTest(senderSpy);
    try {
      // A regular in-app notification must reach push with the same visible content and link.
      const pushedModule = await teacher.post(`/api/classes/${cls.id}/modules`, {
        title: 'Week 2: Functions',
        description: 'Practice defining and calling functions.',
        status: 'PUBLISHED',
      });
      expect(pushedModule.status).toBe(201);
      await new Promise((r) => setTimeout(r, 30));
      expect(senderSpy).toHaveBeenCalledTimes(1);
      const inAppNotifications = (await student.get('/api/notifications')).body.data;
      const inAppModuleNotice = inAppNotifications.find((notice) => notice.body?.includes('Practice defining and calling functions.'));
      const pushModuleNotice = JSON.parse(senderSpy.mock.calls[0][1]);
      expect(inAppModuleNotice).toBeDefined();
      expect(pushModuleNotice).toMatchObject({
        title: inAppModuleNotice.title,
        body: inAppModuleNotice.body,
        link: inAppModuleNotice.link,
      });

      // Longer notification bodies stay aligned with the in-app record up to its 500-character cap.
      const longBody = 'Important course details. '.repeat(20);
      await notify([student.user.id], {
        type: 'course.update',
        title: 'Course update',
        body: longBody,
        link: '/notifications',
        classId: cls.id,
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(senderSpy).toHaveBeenCalledTimes(2);
      const longInAppNotice = (await student.get('/api/notifications')).body.data.find((notice) => notice.title === 'Course update');
      const longPushNotice = JSON.parse(senderSpy.mock.calls[1][1]);
      expect(longInAppNotice.body).toHaveLength(500);
      expect(longPushNotice).toMatchObject({ title: longInAppNotice.title, body: longInAppNotice.body, link: longInAppNotice.link });

      const conv = await teacher.post('/api/messages/conversations', { userId: student.user.id });
      const msg = await teacher.post(`/api/messages/conversations/${conv.body.data.id}/messages`, { body: 'Please check Module 1 before tomorrow.' });
      expect(msg.status).toBe(201);
      await new Promise((r) => setTimeout(r, 30));
      expect(senderSpy).toHaveBeenCalledTimes(3);
      const dmPayload = JSON.parse(senderSpy.mock.calls[2][1]);
      expect(dmPayload.title).toContain('Message from');
      expect(dmPayload.body).toBe('Please check Module 1 before tomorrow.');
      expect(dmPayload.link).toBe(`/messages?c=${conv.body.data.id}`);
    } finally {
      setPushSenderForTest(null);
      Object.assign(env.push, origPush);
    }
  });
});
