// Integration tests for academic & PH school workflows + Web Push subscriptions:
//   • Calendar .ics export
//   • Student Term Report Card PDF/CSV export
//   • Monthly attendance matrix (DepEd SF2 style) filter & export
//   • One-click section enrollment
//   • Web Push subscription registration & stale subscription cleanup
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { actor, createClass, createUser, enroll, loginAs, prepare, prisma, uid } from '../helpers/index.js';
import { sendPushToUsers } from '../../src/services/push.js';
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
    expect(res.headers['content-disposition']).toContain('edusphere-calendar.ics');
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
      subject: 'mailto:test@edusphere.local',
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

      // Re-subscribe then manually unsubscribe
      await student.post('/api/notifications/push/subscribe', {
        endpoint,
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
      });
      const unsub = await student.post('/api/notifications/push/unsubscribe', { endpoint });
      expect(unsub.status).toBe(200);
      expect(unsub.body.data.removed).toBe(1);
    } finally {
      Object.assign(env.push, origPush);
    }
  });
});
