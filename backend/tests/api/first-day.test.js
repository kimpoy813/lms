// A new installation on its first day: one administrator, no e-mail server, nothing else.
//
// Covers what that situation needs from the API: the administrator's set-up guide, and honest
// answers where a message would have been promised. (Migrations have a file of their own.)
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { actor, anonymous, clearSetting, createClass, createCourse, createUser, loginAs, PASSWORD, prepare, prisma, setSetting, uid } from '../helpers/index.js';
import { passwordPolicyError } from '../../src/lib/password.js';
import { setMailAvailable } from '../../src/services/mail.js';

beforeAll(prepare);

describe('the administrator’s set-up guide', () => {
  const stepsOf = async (admin) => {
    const res = await admin.get('/api/dashboard');
    expect(res.status).toBe(200);
    return { setup: res.body.data.setup, done: Object.fromEntries(res.body.data.setup.steps.map((s) => [s.key, s.done])) };
  };

  it('lists the steps in the order they are needed, and reads each one from the data', async () => {
    // The first administrator of a real installation is created with this placeholder name.
    const admin = await loginAs(await createUser('ADMIN', { firstName: 'System', lastName: 'Administrator' }));
    await clearSetting('institution.name');
    const before = await stepsOf(admin);
    expect(before.setup.steps.map((s) => s.key)).toEqual(['institution', 'profile', 'semester', 'courses', 'teachers', 'classes', 'students']);
    expect(before.done.institution).toBe(false);
    expect(before.done.profile).toBe(false);
    expect(before.setup.complete).toBe(false);

    try {
      // Each step is done when the thing exists — nobody ticks a box.
      await admin.patch('/api/admin/settings', { values: { 'institution.name': 'Ilocos Sur Polytechnic State College' } });
      await admin.patch('/api/auth/profile', { firstName: 'Kim Dave', lastName: 'Rafael' });
      const year = await prisma.academicYear.create({ data: { name: uid('AY'), startDate: new Date('2026-08-03'), endDate: new Date('2027-05-28'), isCurrent: true } });
      const semester = await prisma.semester.create({ data: { academicYearId: year.id, name: 'First Semester', startDate: new Date('2026-08-03'), endDate: new Date('2026-12-18'), isCurrent: true } });
      const course = await createCourse();
      const teacher = await createUser('TEACHER');
      await createClass(teacher, { courseId: course.id, semesterId: semester.id });
      await createUser('STUDENT');

      const after = await stepsOf(await loginAs(await prisma.user.findUnique({ where: { id: admin.user.id } })));
      expect(after.done).toEqual({ institution: true, profile: true, semester: true, courses: true, teachers: true, classes: true, students: true });
      expect(after.setup.complete).toBe(true);
    } finally {
      await clearSetting('institution.name');
      await prisma.semester.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    }
  });

  it('is for administrators only', async () => {
    for (const role of ['TEACHER', 'STUDENT']) {
      const res = await (await actor(role)).get('/api/dashboard');
      expect(res.body.data.setup).toBeUndefined();
    }
  });

  it('names a semester by its school year without repeating "AY"', async () => {
    const admin = await actor('ADMIN');
    const year = await prisma.academicYear.create({ data: { name: 'AY 2031–2032', startDate: new Date('2031-08-01'), endDate: new Date('2032-05-31') } });
    await prisma.semester.create({ data: { academicYearId: year.id, name: 'First Semester', startDate: new Date('2031-08-01'), endDate: new Date('2031-12-20') } });
    const list = await admin.get('/api/catalog/semesters');
    expect(list.body.data.map((s) => s.label)).toContain('First Semester, AY 2031–2032');
  });
});

describe('a site that cannot send e-mail', () => {
  afterEach(async () => {
    setMailAvailable(null);
    await clearSetting('registration.requireEmailVerification');
    await clearSetting('email.notificationsEnabled');
  });

  it('says so, to the sign-in pages and to the signed-in web app', async () => {
    expect((await anonymous().get('/api/auth/config')).body.data.emailEnabled).toBe(true); // development mailbox
    setMailAvailable(false);
    expect((await anonymous().get('/api/auth/config')).body.data.emailEnabled).toBe(false);
    const admin = await actor('ADMIN');
    expect((await admin.get('/api/auth/session')).body.data.runtime.email).toBe(false);
    expect((await admin.get('/api/admin/status')).body.data.mailAvailable).toBe(false);
    expect((await admin.get('/api/dashboard')).body.data.system.mailAvailable).toBe(false);
  });

  it('does not promise a reset link that would never arrive', async () => {
    const user = await createUser('STUDENT');
    setMailAvailable(false);
    const res = await anonymous().post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_NOT_AVAILABLE');
    expect(res.body.error.message).toMatch(/administrator/);
    // The same answer for an address nobody has: it reveals nothing about accounts.
    const unknown = await anonymous().post('/api/auth/forgot-password').send({ email: `${uid('nobody')}@test.edu` });
    expect(unknown.body).toEqual(res.body);
    expect(await prisma.authToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it('does not record an invitation as sent, and points to the temporary password instead', async () => {
    const admin = await actor('ADMIN');
    const teacher = await createUser('TEACHER');
    setMailAvailable(false);
    const res = await admin.post(`/api/admin/users/${teacher.id}/send-invite`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Reset password/);
    expect(await prisma.authToken.count({ where: { userId: teacher.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'user.invite_sent', entityId: teacher.id } })).toBe(0);

    // The temporary password is the way that works, and it does.
    const reset = await admin.post(`/api/admin/users/${teacher.id}/reset-password`);
    expect(reset.status).toBe(200);
    const signedIn = await anonymous().post('/api/auth/login').send({ email: teacher.email, password: reset.body.data.temporaryPassword });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.mustChangePassword).toBe(true);
  });

  it('refuses to switch on what needs e-mail, and says which setting', async () => {
    const admin = await actor('ADMIN');
    setMailAvailable(false);
    const res = await admin.patch('/api/admin/settings', { values: { 'registration.requireEmailVerification': true, 'email.notificationsEnabled': true } });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['email.notificationsEnabled', 'registration.requireEmailVerification']);
    // Other settings are saved as usual, and switching the two off is always possible.
    const other = await admin.patch('/api/admin/settings', { values: { 'security.lockoutMinutes': 20, 'registration.requireEmailVerification': false } });
    expect(other.status).toBe(200);
    await clearSetting('security.lockoutMinutes');

    setMailAvailable(null);
    expect((await admin.patch('/api/admin/settings', { values: { 'registration.requireEmailVerification': true } })).status).toBe(200);
  });

  it('never keeps anyone out for an address they have no way to verify', async () => {
    // The requirement was switched on while e-mail still worked; then the SMTP settings went away.
    await setSetting('registration.requireEmailVerification', true);
    const student = await createUser('STUDENT', { emailVerifiedAt: null });
    expect((await anonymous().post('/api/auth/login').send({ email: student.email, password: PASSWORD })).status).toBe(403);

    setMailAvailable(false);
    expect((await anonymous().post('/api/auth/login').send({ email: student.email, password: PASSWORD })).status).toBe(200);
    const registered = await anonymous().post('/api/auth/register').send({
      role: 'STUDENT', firstName: 'Maria', lastName: 'Santos', email: `${uid('reg')}@test.edu`, password: 'Lakbay-Aral-2026', studentNumber: uid('SN'), acceptPrivacyNotice: true,
    });
    expect(registered.status).toBe(201);
    expect(registered.body.data).toMatchObject({ requiresEmailVerification: false, message: 'Account created. You can sign in now.' });
    expect((await anonymous().post('/api/auth/resend-verification').send({ email: student.email })).status).toBe(409);
  });
});

describe('photos from a phone', () => {
  it('are reduced by the web app only when they would be refused, on a server with a disk of its own', async () => {
    // The limit in the test-suite is 2 MB (tests/setup/env.js). A function platform, where files
    // live in the database, asks for more: see serverless.test.js.
    const student = await actor('STUDENT');
    const runtime = (await student.get('/api/auth/session')).body.data.runtime;
    expect(runtime).toEqual({ realtime: true, maxUploadBytes: 2 * 1024 * 1024, reducePhotosOverBytes: 2 * 1024 * 1024, email: true });
    const admin = await actor('ADMIN');
    expect((await admin.get('/api/admin/status')).body.data.reducePhotosOverBytes).toBe(2 * 1024 * 1024);
  });
});

describe('a password that contains the person’s own name', () => {
  it('is refused with the word that has to go', () => {
    // The first administrator is called "System Administrator" until they change it.
    const who = { email: 'kimdave.rafael@ispsc.edu.ph', firstName: 'System', lastName: 'Administrator' };
    expect(passwordPolicyError('My LMS system 2026', who)).toBe('A password should not contain your name or e-mail address: leave out “system”.');
    expect(passwordPolicyError('kimdave.rafael-2026!', who)).toMatch(/leave out “kimdave\.rafael”/);
    expect(passwordPolicyError('Mangoes ripen in summer', who)).toBeNull();
  });
});
