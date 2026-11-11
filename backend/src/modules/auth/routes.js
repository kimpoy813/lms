// Authentication: sign-in/out, self-registration, e-mail verification, password reset,
// invitations, session management and the signed-in user's own profile.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { AppError, badRequest, fieldErrors, forbidden, unauthorized } from '../../lib/errors.js';
import { created, noContent, ok, zEmail, zId, zName } from '../../lib/http.js';
import { dummyHash, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from '../../lib/password.js';
import { randomToken, sha256 } from '../../lib/tokens.js';
import { plainText } from '../../lib/sanitize.js';
import {
  clearSessionCookie, requireAuth, revokeAllSessions, revokeSession, startSession,
} from '../../middleware/auth.js';
import { authLimiter, loginLimiter, signInLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { sendMail } from '../../services/mail.js';
import { permissionsFor } from '../../services/permissions.js';
import { getPublicSettings, getSettings } from '../../services/settings.js';
import { disconnectUser } from '../../services/realtime.js';
import { serializeSelf } from '../users/serialize.js';

export const authRouter = Router();

const TOKEN_TTL = {
  EMAIL_VERIFICATION: 48 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  ACCOUNT_INVITE: 7 * 24 * 60 * 60 * 1000,
};

const userInclude = { studentProfile: true, teacherProfile: true };

/** Create a single-use token; only its hash is stored. Older unused tokens of the type are voided. */
export async function issueAuthToken(userId, type, db = prisma) {
  const token = randomToken(32);
  await db.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await db.authToken.create({
    data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TOKEN_TTL[type]) },
  });
  return token;
}

async function consumeAuthToken(token, type, tx) {
  const row = await tx.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw badRequest('This link is invalid or has expired. Please request a new one.', 'INVALID_TOKEN');
  }
  // Conditional update makes the token strictly single-use even under concurrent requests.
  const claimed = await tx.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) {
    throw badRequest('This link is invalid or has expired. Please request a new one.', 'INVALID_TOKEN');
  }
  return row;
}

export async function sendVerificationEmail(user) {
  const token = await issueAuthToken(user.id, 'EMAIL_VERIFICATION');
  await sendMail({
    to: user.email,
    subject: 'Verify your EduSphere e-mail address',
    title: 'Confirm your e-mail address',
    text: `Hello ${user.firstName}, please confirm your e-mail address to finish setting up your EduSphere account.`,
    paragraphs: [`Hello ${user.firstName},`, 'Please confirm your e-mail address to finish setting up your EduSphere account. The link is valid for 48 hours.'],
    action: { label: 'Verify e-mail address', url: `${env.appUrl}/verify-email?token=${token}` },
  });
}

export async function sendInviteEmail(user, invitedByName) {
  const token = await issueAuthToken(user.id, 'ACCOUNT_INVITE');
  await sendMail({
    to: user.email,
    subject: 'Your EduSphere account is ready',
    title: 'Set up your EduSphere account',
    text: `Hello ${user.firstName}, an EduSphere account was created for you${invitedByName ? ` by ${invitedByName}` : ''}. Choose a password to start using it.`,
    paragraphs: [`Hello ${user.firstName},`, `An EduSphere account was created for you${invitedByName ? ` by ${invitedByName}` : ''}. Choose a password to start using it. The link is valid for 7 days.`],
    action: { label: 'Choose a password', url: `${env.appUrl}/accept-invite?token=${token}` },
  });
  return token;
}

async function sessionPayload(user, csrfToken) {
  return {
    user: serializeSelf(user),
    csrfToken,
    permissions: await permissionsFor(user.role),
    settings: await getPublicSettings(),
  };
}

// ── Public configuration for the sign-in / registration screens ──────────────
authRouter.get('/config', async (req, res) => {
  const settings = await getPublicSettings();
  let demoAccounts = [];
  if (env.demoAccountsEnabled) {
    const demo = await prisma.user.findMany({
      where: { isDemo: true, status: 'ACTIVE' },
      select: { email: true, role: true, firstName: true, lastName: true },
      take: 200,
    });
    // Administrator first, then teachers, then students; within a role the main account
    // ("teacher@…") comes before the numbered ones ("teacher2@…").
    const rank = { ADMIN: 0, TEACHER: 1, STUDENT: 2 };
    demo.sort((a, b) => rank[a.role] - rank[b.role] || a.email.length - b.email.length || a.email.localeCompare(b.email));
    const perRole = { ADMIN: 0, TEACHER: 0, STUDENT: 0 };
    demoAccounts = demo
      .filter((u) => (perRole[u.role] += 1) <= 4)
      .map((u) => ({ email: u.email, role: u.role, name: `${u.firstName} ${u.lastName}` }));
  }
  ok(res, {
    institutionName: settings['institution.name'],
    allowStudentSelfSignup: settings['registration.allowStudentSelfSignup'],
    allowTeacherSelfSignup: settings['registration.allowTeacherSelfSignup'],
    // Demo accounts are a development convenience and never exist in production.
    demoAccounts,
  });
});

// ── Current session ───────────────────────────────────────────────────────────
authRouter.get('/session', async (req, res) => {
  if (!req.user) throw unauthorized('You are not signed in.');
  ok(res, await sessionPayload(req.user, req.session.csrfToken));
});

// ── Sign in ───────────────────────────────────────────────────────────────────
authRouter.post(
  '/login',
  signInLimiter,
  loginLimiter,
  validate({ body: z.object({ email: zEmail, password: z.string().min(1, 'Enter your password').max(200) }) }),
  async (req, res) => {
    const { email, password } = req.valid.body;
    const settings = await getSettings();
    const user = await prisma.user.findUnique({ where: { email }, include: userInclude });
    const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect e-mail address or password.');

    if (!user || user.anonymizedAt) {
      await verifyPassword(password, await dummyHash());
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
      throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= settings['security.maxFailedLogins'];
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + settings['security.lockoutMinutes'] * 60_000) : null,
        },
      });
      await audit({ user: null, ip: req.ip }, {
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'User',
        entityId: user.id,
        summary: lock ? 'Account locked after repeated failed sign-ins' : 'Failed sign-in attempt',
      });
      throw invalid();
    }

    if (user.isDemo && !env.demoAccountsEnabled) {
      throw forbidden('Demo accounts are disabled in production.', 'DEMO_DISABLED');
    }
    if (user.status === 'SUSPENDED') {
      throw forbidden('This account has been suspended. Please contact your administrator.', 'ACCOUNT_SUSPENDED');
    }
    if (user.status === 'DEACTIVATED') {
      throw forbidden('This account has been deactivated. Please contact your administrator.', 'ACCOUNT_DEACTIVATED');
    }
    if (user.status === 'PENDING') {
      throw forbidden('Your account is waiting for approval by an administrator.', 'ACCOUNT_PENDING');
    }
    if (settings['registration.requireEmailVerification'] && !user.emailVerifiedAt && user.role !== 'ADMIN') {
      throw forbidden('Please verify your e-mail address before signing in.', 'EMAIL_NOT_VERIFIED');
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
      },
      include: userInclude,
    });
    const { csrfToken } = await startSession(req, res, updated);
    await audit({ user: updated, ip: req.ip }, { action: 'auth.login', entityType: 'User', entityId: user.id, summary: 'Signed in' });
    ok(res, await sessionPayload(updated, csrfToken));
  },
);

// ── Sign out ──────────────────────────────────────────────────────────────────
authRouter.post('/logout', async (req, res) => {
  if (req.session) {
    await revokeSession(req.session.id);
    await audit(req, { action: 'auth.logout', entityType: 'User', entityId: req.user.id, summary: 'Signed out' });
  }
  clearSessionCookie(req, res);
  noContent(res);
});

// ── Self-registration ─────────────────────────────────────────────────────────
const registerSchema = z.object({
  role: z.enum(['STUDENT', 'TEACHER']).default('STUDENT'),
  firstName: zName,
  lastName: zName,
  email: zEmail,
  password: z.string().max(200),
  studentNumber: z.string().trim().max(40).optional(),
  acceptPrivacyNotice: z.literal(true, { error: 'You must accept the privacy notice to create an account.' }),
});

authRouter.post('/register', authLimiter, validate({ body: registerSchema }), async (req, res) => {
  const body = req.valid.body;
  const settings = await getSettings();
  if (body.role === 'STUDENT' && !settings['registration.allowStudentSelfSignup']) {
    throw forbidden('Student self-registration is turned off. Ask your administrator for an account.', 'SIGNUP_DISABLED');
  }
  if (body.role === 'TEACHER' && !settings['registration.allowTeacherSelfSignup']) {
    throw forbidden('Teacher accounts are created by the administrator.', 'SIGNUP_DISABLED');
  }
  const firstName = plainText(body.firstName, 80);
  const lastName = plainText(body.lastName, 80);
  const errors = {};
  const policy = passwordPolicyError(body.password, { email: body.email, firstName, lastName });
  if (policy) errors.password = policy;
  if (body.role === 'STUDENT' && !body.studentNumber) errors.studentNumber = 'Enter your student number.';
  if (!firstName) errors.firstName = 'Required';
  if (!lastName) errors.lastName = 'Required';
  if (Object.keys(errors).length > 0) throw fieldErrors(errors);

  if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
    throw fieldErrors({ email: 'An account with this e-mail address already exists.' });
  }
  if (body.role === 'STUDENT') {
    const taken = await prisma.studentProfile.findUnique({ where: { studentNumber: body.studentNumber }, select: { id: true } });
    if (taken) throw fieldErrors({ studentNumber: 'This student number is already registered.' });
  }

  const needsVerification = settings['registration.requireEmailVerification'];
  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      // Teacher requests wait for an administrator; students can start immediately.
      status: body.role === 'TEACHER' ? 'PENDING' : 'ACTIVE',
      firstName,
      lastName,
      passwordChangedAt: new Date(),
      ...(body.role === 'STUDENT'
        ? { studentProfile: { create: { studentNumber: plainText(body.studentNumber, 40) } } }
        : { teacherProfile: { create: {} } }),
    },
    include: userInclude,
  });
  await audit({ user, ip: req.ip }, { action: 'auth.register', entityType: 'User', entityId: user.id, summary: `Self-registered as ${body.role.toLowerCase()}` });
  if (needsVerification) await sendVerificationEmail(user);

  created(res, {
    status: user.status,
    requiresApproval: user.status === 'PENDING',
    requiresEmailVerification: needsVerification,
    message:
      user.status === 'PENDING'
        ? 'Your request was received. An administrator will review it before you can sign in.'
        : needsVerification
          ? 'Account created. Check your e-mail for a verification link before signing in.'
          : 'Account created. You can sign in now.',
  });
});

// ── E-mail verification ───────────────────────────────────────────────────────
authRouter.post('/verify-email', authLimiter, validate({ body: z.object({ token: z.string().min(10).max(200) }) }), async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const row = await consumeAuthToken(req.valid.body.token, 'EMAIL_VERIFICATION', tx);
    await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
    await audit({ user: { id: row.userId }, ip: req.ip }, { action: 'auth.email_verified', entityType: 'User', entityId: row.userId, summary: 'E-mail address verified' }, tx);
  });
  ok(res, { message: 'Your e-mail address is verified. You can sign in now.' });
});

authRouter.post('/resend-verification', authLimiter, validate({ body: z.object({ email: zEmail }) }), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.valid.body.email } });
  if (user && !user.emailVerifiedAt && !user.anonymizedAt) await sendVerificationEmail(user);
  // Same answer whether or not the address exists.
  ok(res, { message: 'If that address belongs to an unverified account, a new verification link is on its way.' });
});

// ── Password reset ────────────────────────────────────────────────────────────
authRouter.post('/forgot-password', authLimiter, validate({ body: z.object({ email: zEmail }) }), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.valid.body.email } });
  if (user && !user.anonymizedAt && user.status !== 'DEACTIVATED' && !(user.isDemo && !env.demoAccountsEnabled)) {
    const token = await issueAuthToken(user.id, 'PASSWORD_RESET');
    await sendMail({
      to: user.email,
      subject: 'Reset your EduSphere password',
      title: 'Reset your password',
      text: `Hello ${user.firstName}, we received a request to reset your EduSphere password. If you did not ask for this you can ignore this message.`,
      paragraphs: [`Hello ${user.firstName},`, 'We received a request to reset your EduSphere password. The link below is valid for one hour and can be used once.', 'If you did not ask for this, you can safely ignore this message — your password stays the same.'],
      action: { label: 'Choose a new password', url: `${env.appUrl}/reset-password?token=${token}` },
    });
    await audit({ user: null, ip: req.ip }, { action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id, summary: 'Password reset requested' });
  }
  ok(res, { message: 'If an account exists for that address, a password reset link has been sent.' });
});

const newPasswordSchema = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) });

async function setPasswordWithToken(req, type, action, summary) {
  const { token, password } = req.valid.body;
  const invalid = () => badRequest('This link is invalid or has expired. Please request a new one.', 'INVALID_TOKEN');
  const found = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!found || found.type !== type || found.usedAt || found.expiresAt.getTime() <= Date.now()) throw invalid();
  const policy = passwordPolicyError(password, found.user);
  if (policy) throw fieldErrors({ password: policy });
  // Hash before opening the transaction so no database connection is held during the slow KDF.
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const row = await consumeAuthToken(token, type, tx);
    await tx.user.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        // Following a link that was e-mailed to the address proves control of it.
        emailVerifiedAt: found.user.emailVerifiedAt ?? new Date(),
      },
    });
    await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ user: { id: row.userId, role: found.user.role }, ip: req.ip }, { action, entityType: 'User', entityId: row.userId, summary }, tx);
  });
  disconnectUser(found.userId);
}

authRouter.post('/reset-password', authLimiter, validate({ body: newPasswordSchema }), async (req, res) => {
  await setPasswordWithToken(req, 'PASSWORD_RESET', 'auth.password_reset', 'Password reset with an e-mailed link');
  ok(res, { message: 'Your password has been changed. Sign in with the new password.' });
});

authRouter.post('/accept-invite', authLimiter, validate({ body: newPasswordSchema }), async (req, res) => {
  await setPasswordWithToken(req, 'ACCOUNT_INVITE', 'auth.invite_accepted', 'Account invitation accepted');
  ok(res, { message: 'Your password is set. You can sign in now.' });
});

// ── Signed-in account management ──────────────────────────────────────────────
authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate({ body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }) }),
  async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    if (!(await verifyPassword(currentPassword, req.user.passwordHash))) {
      throw fieldErrors({ currentPassword: 'Your current password is incorrect.' });
    }
    const policy = passwordPolicyError(newPassword, req.user);
    if (policy) throw fieldErrors({ newPassword: policy });
    if (currentPassword === newPassword) throw fieldErrors({ newPassword: 'Choose a password different from the current one.' });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false },
    });
    // Sign out everywhere else; the current session stays valid.
    await revokeAllSessions(req.user.id, req.session.id);
    await audit(req, { action: 'auth.password_changed', entityType: 'User', entityId: req.user.id, summary: 'Password changed' });
    ok(res, { message: 'Password changed. Other devices have been signed out.' });
  },
);

authRouter.get('/sessions', requireAuth, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true },
  });
  ok(res, sessions.map((s) => ({ ...s, current: s.id === req.session.id })));
});

authRouter.delete('/sessions/:sessionId', requireAuth, validate({ params: z.object({ sessionId: zId }) }), async (req, res) => {
  const { sessionId } = req.valid.params;
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId: req.user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw new AppError(404, 'NOT_FOUND', 'Session not found.');
  if (sessionId === req.session.id) clearSessionCookie(req, res);
  await audit(req, { action: 'auth.session_revoked', entityType: 'Session', entityId: sessionId, summary: 'Signed out a device' });
  noContent(res);
});

const profileSchema = z.object({
  firstName: zName.optional(),
  lastName: zName.optional(),
  middleName: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(30).regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, + ( ) -').nullable().optional(),
  emailNotifications: z.boolean().optional(),
  avatarFileId: zId.nullable().optional(),
  teacherProfile: z
    .object({
      position: z.string().trim().max(120).nullable().optional(),
      specialization: z.string().trim().max(200).nullable().optional(),
      consultationHours: z.string().trim().max(300).nullable().optional(),
      bio: z.string().trim().max(2000).nullable().optional(),
    })
    .optional(),
});

authRouter.patch('/profile', requireAuth, validate({ body: profileSchema }), async (req, res) => {
  const body = req.valid.body;
  const data = {};
  if (body.firstName !== undefined) data.firstName = plainText(body.firstName, 80);
  if (body.lastName !== undefined) data.lastName = plainText(body.lastName, 80);
  if (body.middleName !== undefined) data.middleName = body.middleName ? plainText(body.middleName, 80) : null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.emailNotifications !== undefined) data.emailNotifications = body.emailNotifications;
  if (data.firstName === '' || data.lastName === '') throw fieldErrors({ firstName: 'Required' });

  if (body.avatarFileId !== undefined) {
    if (body.avatarFileId === null) {
      data.avatarFileId = null;
    } else {
      const file = await prisma.file.findFirst({ where: { id: body.avatarFileId, ownerId: req.user.id, deletedAt: null } });
      if (!file || !file.mimeType.startsWith('image/')) throw fieldErrors({ avatarFileId: 'Choose an image you uploaded.' });
      data.avatarFileId = file.id;
    }
  }
  if (body.teacherProfile && req.user.role === 'TEACHER') {
    const t = body.teacherProfile;
    const profile = {};
    for (const key of ['position', 'specialization', 'consultationHours', 'bio']) {
      if (t[key] !== undefined) profile[key] = t[key] ? plainText(t[key], key === 'bio' ? 2000 : 300) : null;
    }
    data.teacherProfile = { upsert: { create: profile, update: profile } };
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data, include: userInclude });
  ok(res, serializeSelf(user));
});
