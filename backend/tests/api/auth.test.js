import { beforeAll, describe, expect, it } from 'vitest';
import {
  actor, anonymous, app, clearSetting, createUser, loginAs, PASSWORD, prepare, prisma, setSetting, uid,
} from '../helpers/index.js';
import request from 'supertest';

beforeAll(prepare);

const mailbox = async () => (await anonymous().get('/api/dev/mailbox')).body.data;
const tokenFrom = (mail) => new URL(mail.actionUrl).searchParams.get('token');

describe('sign in', () => {
  it('signs in with correct credentials and sets a hardened session cookie', async () => {
    const user = await createUser('STUDENT');
    const res = await anonymous().post('/api/auth/login').send({ email: user.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, role: 'STUDENT', email: user.email });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.csrfToken).toBeTruthy();
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/es_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    // The raw token is never stored: only its SHA-256.
    const token = /es_sid=([^;]+)/.exec(cookie)[1];
    expect(await prisma.session.findFirst({ where: { tokenHash: token } })).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('rejects a wrong password and an unknown e-mail with the same answer', async () => {
    const user = await createUser('STUDENT');
    const wrong = await anonymous().post('/api/auth/login').send({ email: user.email, password: 'not-the-password' });
    const unknown = await anonymous().post('/api/auth/login').send({ email: `${uid('nobody')}@test.edu`, password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('validates input', async () => {
    const res = await anonymous().post('/api/auth/login').send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details.fields)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('locks the account after repeated failures and unlocks after the lockout window', async () => {
    const user = await createUser('STUDENT');
    for (let i = 0; i < 5; i += 1) {
      const res = await anonymous().post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
      expect(res.status).toBe(401);
    }
    const locked = await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.account_locked' } })).toBe(1);

    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const after = await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(after.status).toBe(200);
  });

  it.each([
    ['SUSPENDED', 'ACCOUNT_SUSPENDED'],
    ['DEACTIVATED', 'ACCOUNT_DEACTIVATED'],
    ['PENDING', 'ACCOUNT_PENDING'],
  ])('refuses a %s account', async (status, code) => {
    const user = await createUser('TEACHER', { status });
    const res = await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(code);
  });

  it('requires e-mail verification when the institution demands it', async () => {
    await setSetting('registration.requireEmailVerification', true);
    try {
      const user = await createUser('STUDENT', { emailVerifiedAt: null });
      const res = await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    } finally {
      await clearSetting('registration.requireEmailVerification');
    }
  });
});

describe('sessions', () => {
  it('returns the current session and rejects anonymous callers', async () => {
    expect((await anonymous().get('/api/auth/session')).status).toBe(401);
    const student = await actor('STUDENT');
    const res = await student.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(student.user.id);
    expect(res.body.data.permissions).toContain('discussion.create_thread');
    expect(res.body.data.settings['institution.timezone']).toBe('Asia/Manila');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('ends the session on sign-out', async () => {
    const student = await actor('STUDENT');
    expect((await student.post('/api/auth/logout')).status).toBe(204);
    expect((await student.get('/api/auth/session')).status).toBe(401);
  });

  it('ignores a forged or expired session cookie', async () => {
    const forged = await request(app).get('/api/auth/session').set('Cookie', 'es_sid=forged-value');
    expect(forged.status).toBe(401);

    const student = await actor('STUDENT');
    await prisma.session.updateMany({ where: { userId: student.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await student.get('/api/auth/session')).status).toBe(401);
  });

  it('kills live sessions when the account is suspended', async () => {
    const admin = await actor('ADMIN');
    const teacher = await actor('TEACHER');
    expect((await teacher.get('/api/auth/session')).status).toBe(200);
    const res = await admin.post(`/api/admin/users/${teacher.user.id}/suspend`, { reason: 'Policy violation under review' });
    expect(res.status).toBe(200);
    expect((await teacher.get('/api/auth/session')).status).toBe(401);
  });

  it('lets a user list and revoke their own sessions only', async () => {
    const user = await createUser('STUDENT');
    const a = await loginAs(user);
    const b = await loginAs(user);
    const other = await actor('STUDENT');

    const list = await a.get('/api/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);
    const bSession = list.body.data.find((s) => !s.current);

    // Another user cannot revoke it …
    expect((await other.delete(`/api/auth/sessions/${bSession.id}`)).status).toBe(404);
    expect((await b.get('/api/auth/session')).status).toBe(200);
    // … the owner can.
    expect((await a.delete(`/api/auth/sessions/${bSession.id}`)).status).toBe(204);
    expect((await b.get('/api/auth/session')).status).toBe(401);
    expect((await a.get('/api/auth/session')).status).toBe(200);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the CSRF token', async () => {
    const student = await actor('STUDENT');
    const res = await student.agent.patch('/api/auth/profile').send({ phone: '0917 000 0000' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_CSRF_TOKEN');
  });

  it('rejects a wrong CSRF token and another session\'s token', async () => {
    const a = await actor('STUDENT');
    const b = await actor('STUDENT');
    const wrong = await a.agent.patch('/api/auth/profile').set('x-csrf-token', 'nope').send({ phone: '1' });
    const swapped = await a.agent.patch('/api/auth/profile').set('x-csrf-token', b.csrf).send({ phone: '1' });
    expect(wrong.status).toBe(403);
    expect(swapped.status).toBe(403);
  });

  it('accepts the request when the token matches', async () => {
    const student = await actor('STUDENT');
    const res = await student.patch('/api/auth/profile', { phone: '0917 000 0000' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('0917 000 0000');
  });

  it('blocks cross-site origins even with a valid token, and allows trusted ones', async () => {
    const student = await actor('STUDENT');
    const evil = await student.agent.patch('/api/auth/profile').set('x-csrf-token', student.csrf).set('Origin', 'https://evil.example').send({ phone: '2' });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('BAD_ORIGIN');
    const good = await student.agent.patch('/api/auth/profile').set('x-csrf-token', student.csrf).set('Origin', 'http://localhost:5173').send({ phone: '3' });
    expect(good.status).toBe(200);
  });

  it('blocks cross-site sign-in attempts (login CSRF)', async () => {
    const user = await createUser('STUDENT');
    const res = await anonymous().post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('self-registration', () => {
  const form = (overrides = {}) => ({
    role: 'STUDENT', firstName: 'Maria', lastName: 'Santos', email: `${uid('reg')}@test.edu`,
    password: 'Lakbay-Aral-2026', studentNumber: uid('SN'), acceptPrivacyNotice: true, ...overrides,
  });

  it('creates a student account that can sign in', async () => {
    const body = form();
    const res = await anonymous().post('/api/auth/register').send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { studentProfile: true } });
    expect(user.role).toBe('STUDENT');
    expect(user.passwordHash).not.toContain(body.password);
    expect(user.studentProfile.studentNumber).toBe(body.studentNumber);
    expect((await anonymous().post('/api/auth/login').send({ email: body.email, password: body.password })).status).toBe(200);
  });

  it('reports every invalid field', async () => {
    const res = await anonymous().post('/api/auth/register').send(form({ password: 'short', studentNumber: '', acceptPrivacyNotice: false, email: 'bad' }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields.email).toBeTruthy();
    expect(res.body.error.details.fields.acceptPrivacyNotice).toMatch(/privacy notice/);
    const second = await anonymous().post('/api/auth/register').send(form({ password: 'short', studentNumber: '' }));
    expect(second.body.error.details.fields).toMatchObject({ password: expect.any(String), studentNumber: expect.any(String) });
  });

  it('refuses duplicate e-mail addresses and student numbers', async () => {
    const body = form();
    await anonymous().post('/api/auth/register').send(body);
    const dupEmail = await anonymous().post('/api/auth/register').send(form({ email: body.email }));
    const dupNumber = await anonymous().post('/api/auth/register').send(form({ studentNumber: body.studentNumber }));
    expect(dupEmail.status).toBe(422);
    expect(dupEmail.body.error.details.fields.email).toBeTruthy();
    expect(dupNumber.body.error.details.fields.studentNumber).toBeTruthy();
  });

  it('never lets a visitor create an administrator', async () => {
    const res = await anonymous().post('/api/auth/register').send(form({ role: 'ADMIN' }));
    expect(res.status).toBe(422);
  });

  it('keeps teacher sign-up closed unless enabled, and pending when enabled', async () => {
    const closed = await anonymous().post('/api/auth/register').send(form({ role: 'TEACHER', studentNumber: undefined }));
    expect(closed.status).toBe(403);
    await setSetting('registration.allowTeacherSelfSignup', true);
    try {
      const body = form({ role: 'TEACHER', studentNumber: undefined });
      const open = await anonymous().post('/api/auth/register').send(body);
      expect(open.status).toBe(201);
      expect(open.body.data.requiresApproval).toBe(true);
      const login = await anonymous().post('/api/auth/login').send({ email: body.email, password: body.password });
      expect(login.body.error.code).toBe('ACCOUNT_PENDING');
    } finally {
      await clearSetting('registration.allowTeacherSelfSignup');
    }
  });

  it('can be switched off by the administrator', async () => {
    await setSetting('registration.allowStudentSelfSignup', false);
    try {
      expect((await anonymous().post('/api/auth/register').send(form())).status).toBe(403);
    } finally {
      await clearSetting('registration.allowStudentSelfSignup');
    }
  });

  it('sends a single-use verification link when verification is required', async () => {
    await setSetting('registration.requireEmailVerification', true);
    try {
      const body = form();
      await anonymous().post('/api/auth/register').send(body);
      const login = await anonymous().post('/api/auth/login').send({ email: body.email, password: body.password });
      expect(login.body.error.code).toBe('EMAIL_NOT_VERIFIED');

      const mail = (await mailbox()).find((m) => m.to === body.email);
      const token = tokenFrom(mail);
      expect((await anonymous().post('/api/auth/verify-email').send({ token })).status).toBe(200);
      expect((await anonymous().post('/api/auth/verify-email').send({ token })).status).toBe(400); // single use
      expect((await anonymous().post('/api/auth/login').send({ email: body.email, password: body.password })).status).toBe(200);
    } finally {
      await clearSetting('registration.requireEmailVerification');
    }
  });
});

describe('password reset', () => {
  it('resets the password with an e-mailed single-use link and signs out every device', async () => {
    const user = await createUser('STUDENT');
    const session = await loginAs(user);
    const res = await anonymous().post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);

    const token = tokenFrom((await mailbox()).find((m) => m.to === user.email));
    // Only the hash of the token is stored.
    expect(await prisma.authToken.findFirst({ where: { tokenHash: token } })).toBeNull();

    const weak = await anonymous().post('/api/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(422);
    const done = await anonymous().post('/api/auth/reset-password').send({ token, password: 'Brand-New-Secret-9' });
    expect(done.status).toBe(200);
    const reuse = await anonymous().post('/api/auth/reset-password').send({ token, password: 'Another-Secret-10' });
    expect(reuse.status).toBe(400);

    expect((await session.get('/api/auth/session')).status).toBe(401);
    expect((await anonymous().post('/api/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await anonymous().post('/api/auth/login').send({ email: user.email, password: 'Brand-New-Secret-9' })).status).toBe(200);
  });

  it('answers identically for unknown addresses and sends nothing', async () => {
    const email = `${uid('ghost')}@test.edu`;
    const res = await anonymous().post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    expect((await mailbox()).some((m) => m.to === email)).toBe(false);
  });

  it('rejects expired and made-up tokens', async () => {
    const user = await createUser('STUDENT');
    await anonymous().post('/api/auth/forgot-password').send({ email: user.email });
    const token = tokenFrom((await mailbox()).find((m) => m.to === user.email));
    await prisma.authToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await anonymous().post('/api/auth/reset-password').send({ token, password: 'Brand-New-Secret-9' })).status).toBe(400);
    expect((await anonymous().post('/api/auth/reset-password').send({ token: 'x'.repeat(43), password: 'Brand-New-Secret-9' })).status).toBe(400);
  });

  it('a reset token cannot be used as a verification token', async () => {
    const user = await createUser('STUDENT', { emailVerifiedAt: null });
    await anonymous().post('/api/auth/forgot-password').send({ email: user.email });
    const token = tokenFrom((await mailbox()).find((m) => m.to === user.email));
    expect((await anonymous().post('/api/auth/verify-email').send({ token })).status).toBe(400);
  });
});

describe('changing the password', () => {
  it('requires the current password, applies the policy and signs out other devices', async () => {
    const user = await createUser('TEACHER');
    const here = await loginAs(user);
    const elsewhere = await loginAs(user);

    const wrong = await here.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'Totally-New-Pass-7' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details.fields.currentPassword).toBeTruthy();
    const weak = await here.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'password123' });
    expect(weak.body.error.details.fields.newPassword).toMatch(/common/);
    const same = await here.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(422);

    const res = await here.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Totally-New-Pass-7' });
    expect(res.status).toBe(200);
    expect((await here.get('/api/auth/session')).status).toBe(200);
    expect((await elsewhere.get('/api/auth/session')).status).toBe(401);
  });
});

describe('profile', () => {
  it('lets a user edit their own details but not their role or e-mail', async () => {
    const student = await actor('STUDENT');
    const res = await student.patch('/api/auth/profile', { firstName: '<b>Ana</b>', role: 'ADMIN', email: 'x@y.z', emailNotifications: true });
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Ana');
    expect(res.body.data.role).toBe('STUDENT');
    expect(res.body.data.email).toBe(student.user.email);
    expect(res.body.data.emailNotifications).toBe(true);
  });

  it('only accepts an avatar the user uploaded themselves', async () => {
    const a = await actor('STUDENT');
    const b = await actor('STUDENT');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await a.upload([{ name: 'me.png', content: png }]);
    expect(up.status).toBe(201);
    const fileId = up.body.data[0].id;
    expect((await b.patch('/api/auth/profile', { avatarFileId: fileId })).status).toBe(422);
    expect((await a.patch('/api/auth/profile', { avatarFileId: fileId })).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('throttles repeated sign-in attempts for one account', async () => {
    const email = `${uid('rl')}@test.edu`;
    let last;
    for (let i = 0; i < 17; i += 1) {
      last = await anonymous().post('/api/auth/login').set('x-test-rate-limit', '1').send({ email, password: 'whatever-password' });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not count successful sign-ins against the limit', async () => {
    const user = await createUser('STUDENT');
    for (let i = 0; i < 18; i += 1) {
      const res = await anonymous().post('/api/auth/login').set('x-test-rate-limit', '1').send({ email: user.email, password: PASSWORD });
      expect(res.status).toBe(200);
    }
    // …while wrong passwords for the same account still add up (the account locks first, which is also a refusal).
    const wrong = await anonymous().post('/api/auth/login').set('x-test-rate-limit', '1').send({ email: user.email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
  });
});

describe('security headers', () => {
  it('sends a restrictive content security policy and no framework banner', async () => {
    const res = await anonymous().get('/api/auth/config');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('returns JSON 404s for unknown API routes without leaking internals', async () => {
    const res = await anonymous().get('/api/definitely-not-here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON cleanly', async () => {
    const res = await anonymous().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
