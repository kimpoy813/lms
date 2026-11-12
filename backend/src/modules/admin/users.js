// Administrator: account management (create, edit, approve, suspend, recover, anonymise).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, ok, pageMeta, pageQuery, paging, zEmail, zId, zName } from '../../lib/http.js';
import { hashPassword, passwordPolicyError } from '../../lib/password.js';
import { plainText } from '../../lib/sanitize.js';
import { randomToken } from '../../lib/tokens.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { mailAvailable, mailConfigured } from '../../services/mail.js';
import { notify } from '../../services/notifications.js';
import { disconnectUser } from '../../services/realtime.js';
import { sendInviteEmail } from '../auth/routes.js';
import { serializeAdminUser } from '../users/serialize.js';

export const adminUsersRouter = Router();
adminUsersRouter.use(requireRole('ADMIN'));

const include = {
  studentProfile: { include: { program: true, section: true } },
  teacherProfile: { include: { department: true } },
};

/** A readable one-time password that satisfies the password policy. */
function temporaryPassword() {
  const words = ['Maple', 'River', 'Cobalt', 'Harbor', 'Summit', 'Lantern', 'Meadow', 'Orbit', 'Quartz', 'Willow'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${randomToken(3).replace(/[^A-Za-z0-9]/g, 'x')}${Math.floor(10 + Math.random() * 89)}`;
}

const profileFields = {
  studentNumber: z.string().trim().max(40).optional(),
  programId: zId.nullable().optional(),
  sectionId: zId.nullable().optional(),
  yearLevel: z.number().int().min(1).max(10).nullable().optional(),
  employeeNumber: z.string().trim().max(40).nullable().optional(),
  departmentId: zId.nullable().optional(),
  position: z.string().trim().max(120).nullable().optional(),
};

const createSchema = z.object({
  role: z.enum(['ADMIN', 'TEACHER', 'STUDENT']),
  firstName: zName,
  lastName: zName,
  middleName: z.string().trim().max(80).nullable().optional(),
  email: zEmail,
  /** Optional. When omitted a temporary password is generated and shown once. */
  password: z.string().max(200).optional(),
  ...profileFields,
});

async function validateReferences(body) {
  if (body.programId && !(await prisma.academicProgram.findUnique({ where: { id: body.programId }, select: { id: true } }))) {
    throw fieldErrors({ programId: 'Choose a program from the list.' });
  }
  if (body.sectionId && !(await prisma.section.findUnique({ where: { id: body.sectionId }, select: { id: true } }))) {
    throw fieldErrors({ sectionId: 'Choose a section from the list.' });
  }
  if (body.departmentId && !(await prisma.department.findUnique({ where: { id: body.departmentId }, select: { id: true } }))) {
    throw fieldErrors({ departmentId: 'Choose a department from the list.' });
  }
}

/** Create one account. Shared by the single-create and bulk-import endpoints. */
async function createAccount(req, body) {
  const firstName = plainText(body.firstName, 80);
  const lastName = plainText(body.lastName, 80);
  if (!firstName || !lastName) throw fieldErrors({ firstName: 'First and last name are required.' });
  if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
    throw fieldErrors({ email: 'An account with this e-mail address already exists.' });
  }
  if (body.role === 'STUDENT') {
    if (!body.studentNumber) throw fieldErrors({ studentNumber: 'A student number is required.' });
    if (await prisma.studentProfile.findUnique({ where: { studentNumber: body.studentNumber }, select: { id: true } })) {
      throw fieldErrors({ studentNumber: 'This student number is already registered.' });
    }
  }
  if (body.role === 'TEACHER' && body.employeeNumber) {
    if (await prisma.teacherProfile.findUnique({ where: { employeeNumber: body.employeeNumber }, select: { id: true } })) {
      throw fieldErrors({ employeeNumber: 'This employee number is already registered.' });
    }
  }
  await validateReferences(body);

  let generated = null;
  let password = body.password;
  if (password) {
    const policy = passwordPolicyError(password, { email: body.email, firstName, lastName });
    if (policy) throw fieldErrors({ password: policy });
  } else {
    generated = temporaryPassword();
    password = generated;
  }

  const user = await prisma.$transaction(async (tx) => {
    const row = await tx.user.create({
      data: {
        email: body.email,
        passwordHash: await hashPassword(password),
        role: body.role,
        status: 'ACTIVE',
        firstName,
        lastName,
        middleName: body.middleName ? plainText(body.middleName, 80) : null,
        // Whoever knows an administrator-issued password must replace it at first sign-in.
        mustChangePassword: true,
        // The administrator vouches for the address.
        emailVerifiedAt: new Date(),
        ...(body.role === 'STUDENT'
          ? { studentProfile: { create: { studentNumber: plainText(body.studentNumber, 40), programId: body.programId ?? null, sectionId: body.sectionId ?? null, yearLevel: body.yearLevel ?? null } } }
          : {}),
        ...(body.role === 'TEACHER'
          ? { teacherProfile: { create: { employeeNumber: body.employeeNumber || null, departmentId: body.departmentId ?? null, position: body.position ? plainText(body.position, 120) : null } } }
          : {}),
      },
      include,
    });
    await audit(req, { action: 'user.create', entityType: 'User', entityId: row.id, summary: `Created ${body.role.toLowerCase()} account for ${fullName(row)}` }, tx);
    return row;
  });
  return { user, temporaryPassword: generated };
}

// ── List ──────────────────────────────────────────────────────────────────────
adminUsersRouter.get(
  '/',
  validate({
    query: z.object({
      search: z.string().trim().max(100).optional(),
      role: z.enum(['ADMIN', 'TEACHER', 'STUDENT']).optional(),
      status: z.enum(['ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED']).optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' } },
              { lastName: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
              { studentProfile: { studentNumber: { contains: q.search, mode: 'insensitive' } } },
              { teacherProfile: { employeeNumber: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, users, byStatus] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, include, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], ...paging(q) }),
      prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    ok(res, users.map(serializeAdminUser), {
      ...pageMeta(q, total),
      statusCounts: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    });
  },
);

adminUsersRouter.get('/:userId', validate({ params: idParams('userId') }), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.valid.params.userId }, include });
  if (!user) throw notFound('User');
  const [classesTaught, enrollments, sessions] = await Promise.all([
    user.role === 'TEACHER'
      ? prisma.class.findMany({ where: { teacherId: user.id }, select: { id: true, status: true, course: { select: { code: true, title: true } }, section: { select: { name: true } }, semester: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 })
      : [],
    user.role === 'STUDENT'
      ? prisma.enrollment.findMany({ where: { studentId: user.id }, select: { id: true, status: true, class: { select: { id: true, status: true, course: { select: { code: true, title: true } }, section: { select: { name: true } }, semester: { select: { name: true } } } } }, orderBy: { requestedAt: 'desc' }, take: 50 })
      : [],
    prisma.session.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  ok(res, { ...serializeAdminUser(user), classesTaught, enrollments, activeSessions: sessions });
});

// ── Create ────────────────────────────────────────────────────────────────────
adminUsersRouter.post('/', validate({ body: createSchema }), async (req, res) => {
  const { user, temporaryPassword: temp } = await createAccount(req, req.valid.body);
  created(res, {
    user: serializeAdminUser(user),
    // Returned exactly once and never stored in readable form.
    temporaryPassword: temp,
    mailConfigured: mailConfigured(),
  });
});

// ── Bulk import ───────────────────────────────────────────────────────────────
const importRow = z.object({
  role: z.enum(['TEACHER', 'STUDENT']),
  firstName: z.string().max(200),
  lastName: z.string().max(200),
  email: z.string().max(300),
  studentNumber: z.string().max(60).optional(),
  employeeNumber: z.string().max(60).optional(),
  programCode: z.string().max(40).optional(),
  sectionName: z.string().max(80).optional(),
  departmentCode: z.string().max(40).optional(),
  yearLevel: z.union([z.number(), z.string()]).optional(),
});

adminUsersRouter.post('/import', validate({ body: z.object({ rows: z.array(importRow).min(1).max(500) }) }), async (req, res) => {
  const [programs, sections, departments] = await Promise.all([
    prisma.academicProgram.findMany({ select: { id: true, code: true } }),
    prisma.section.findMany({ select: { id: true, name: true } }),
    prisma.department.findMany({ select: { id: true, code: true } }),
  ]);
  const lookup = (list, key, value) => (value ? list.find((x) => x[key].toLowerCase() === String(value).trim().toLowerCase())?.id : undefined);
  const results = [];
  for (const [index, raw] of req.valid.body.rows.entries()) {
    const line = index + 1;
    const parsed = createSchema.safeParse({
      role: raw.role,
      firstName: raw.firstName,
      lastName: raw.lastName,
      email: raw.email,
      studentNumber: raw.studentNumber || undefined,
      employeeNumber: raw.employeeNumber || undefined,
      yearLevel: raw.yearLevel === undefined || raw.yearLevel === '' ? undefined : Number(raw.yearLevel),
      programId: lookup(programs, 'code', raw.programCode),
      sectionId: lookup(sections, 'name', raw.sectionName),
      departmentId: lookup(departments, 'code', raw.departmentCode),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      results.push({ line, email: String(raw.email).slice(0, 100), ok: false, error: `${issue.path.join('.')}: ${issue.message}` });
      continue;
    }
    if (raw.programCode && !parsed.data.programId) {
      results.push({ line, email: parsed.data.email, ok: false, error: `Unknown program code "${raw.programCode}"` });
      continue;
    }
    if (raw.sectionName && !parsed.data.sectionId) {
      results.push({ line, email: parsed.data.email, ok: false, error: `Unknown section "${raw.sectionName}"` });
      continue;
    }
    if (raw.departmentCode && !parsed.data.departmentId) {
      results.push({ line, email: parsed.data.email, ok: false, error: `Unknown department code "${raw.departmentCode}"` });
      continue;
    }
    try {
      const { user, temporaryPassword: temp } = await createAccount(req, parsed.data);
      results.push({ line, email: user.email, ok: true, name: fullName(user), role: user.role, temporaryPassword: temp });
    } catch (err) {
      const fields = err?.details?.fields;
      results.push({ line, email: parsed.data.email, ok: false, error: fields ? Object.values(fields)[0] : err.message });
    }
  }
  ok(res, { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});

// ── Update ────────────────────────────────────────────────────────────────────
const updateSchema = z.object({
  firstName: zName.optional(),
  lastName: zName.optional(),
  middleName: z.string().trim().max(80).nullable().optional(),
  email: zEmail.optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  ...profileFields,
});

async function loadTarget(req) {
  const user = await prisma.user.findUnique({ where: { id: req.valid.params.userId }, include });
  if (!user) throw notFound('User');
  if (user.anonymizedAt) throw conflict('This account has been anonymised and can no longer be changed.', 'ANONYMISED');
  return user;
}

adminUsersRouter.patch('/:userId', validate({ params: idParams('userId'), body: updateSchema }), async (req, res) => {
  const target = await loadTarget(req);
  const body = req.valid.body;
  const data = {};
  if (body.firstName !== undefined) data.firstName = plainText(body.firstName, 80);
  if (body.lastName !== undefined) data.lastName = plainText(body.lastName, 80);
  if (body.middleName !== undefined) data.middleName = body.middleName ? plainText(body.middleName, 80) : null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.email !== undefined && body.email !== target.email) {
    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw fieldErrors({ email: 'An account with this e-mail address already exists.' });
    }
    data.email = body.email;
  }
  await validateReferences(body);

  if (target.role === 'STUDENT') {
    const profile = {};
    if (body.studentNumber !== undefined && body.studentNumber !== target.studentProfile?.studentNumber) {
      if (!body.studentNumber) throw fieldErrors({ studentNumber: 'A student number is required.' });
      if (await prisma.studentProfile.findUnique({ where: { studentNumber: body.studentNumber }, select: { id: true } })) {
        throw fieldErrors({ studentNumber: 'This student number is already registered.' });
      }
      profile.studentNumber = plainText(body.studentNumber, 40);
    }
    for (const key of ['programId', 'sectionId', 'yearLevel']) if (body[key] !== undefined) profile[key] = body[key];
    if (Object.keys(profile).length > 0) {
      data.studentProfile = { upsert: { create: { studentNumber: profile.studentNumber ?? target.studentProfile?.studentNumber ?? `S-${Date.now()}`, ...profile }, update: profile } };
    }
  }
  if (target.role === 'TEACHER') {
    const profile = {};
    if (body.employeeNumber !== undefined && (body.employeeNumber || null) !== target.teacherProfile?.employeeNumber) {
      if (body.employeeNumber && (await prisma.teacherProfile.findUnique({ where: { employeeNumber: body.employeeNumber }, select: { id: true } }))) {
        throw fieldErrors({ employeeNumber: 'This employee number is already registered.' });
      }
      profile.employeeNumber = body.employeeNumber || null;
    }
    if (body.departmentId !== undefined) profile.departmentId = body.departmentId;
    if (body.position !== undefined) profile.position = body.position ? plainText(body.position, 120) : null;
    if (Object.keys(profile).length > 0) data.teacherProfile = { upsert: { create: profile, update: profile } };
  }

  const user = await prisma.user.update({ where: { id: target.id }, data, include });
  await audit(req, {
    action: 'user.update', entityType: 'User', entityId: target.id, summary: `Updated account of ${fullName(user)}`,
    before: { firstName: target.firstName, lastName: target.lastName, email: target.email },
    after: { firstName: user.firstName, lastName: user.lastName, email: user.email },
  });
  ok(res, serializeAdminUser(user));
});

// ── Status changes ────────────────────────────────────────────────────────────
function assertNotSelf(req, target, what) {
  if (target.id === req.user.id) throw forbidden(`You cannot ${what} your own account.`, 'SELF_ACTION');
}

async function endAllSessions(userId) {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  disconnectUser(userId);
}

adminUsersRouter.post('/:userId/approve', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  if (target.status !== 'PENDING') throw conflict('This account is not waiting for approval.', 'INVALID_STATUS');
  const user = await prisma.user.update({ where: { id: target.id }, data: { status: 'ACTIVE' }, include });
  await audit(req, { action: 'user.approve', entityType: 'User', entityId: target.id, summary: `Approved account of ${fullName(target)}` });
  await notify([target.id], { type: 'account.approved', title: 'Your account was approved', body: 'You now have full access to EduSphere.', link: '/dashboard' });
  ok(res, serializeAdminUser(user));
});

adminUsersRouter.post(
  '/:userId/suspend',
  validate({ params: idParams('userId'), body: z.object({ reason: z.string().trim().min(3, 'Give a reason for the suspension').max(500) }) }),
  async (req, res) => {
    const target = await loadTarget(req);
    assertNotSelf(req, target, 'suspend');
    if (target.status === 'SUSPENDED') throw conflict('This account is already suspended.', 'INVALID_STATUS');
    const reason = plainText(req.valid.body.reason, 500);
    const user = await prisma.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: reason }, include });
    await endAllSessions(target.id);
    await audit(req, { action: 'user.suspend', entityType: 'User', entityId: target.id, summary: `Suspended ${fullName(target)}`, after: { reason } });
    ok(res, serializeAdminUser(user));
  },
);

adminUsersRouter.post('/:userId/reactivate', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  if (target.status !== 'SUSPENDED' && target.status !== 'DEACTIVATED') throw conflict('This account is already active.', 'INVALID_STATUS');
  const user = await prisma.user.update({
    where: { id: target.id },
    data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null, failedLoginCount: 0, lockedUntil: null },
    include,
  });
  await audit(req, { action: 'user.reactivate', entityType: 'User', entityId: target.id, summary: `Reactivated ${fullName(target)}` });
  ok(res, serializeAdminUser(user));
});

adminUsersRouter.post('/:userId/deactivate', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  assertNotSelf(req, target, 'deactivate');
  if (target.status === 'DEACTIVATED') throw conflict('This account is already deactivated.', 'INVALID_STATUS');
  const user = await prisma.user.update({ where: { id: target.id }, data: { status: 'DEACTIVATED' }, include });
  await endAllSessions(target.id);
  await audit(req, { action: 'user.deactivate', entityType: 'User', entityId: target.id, summary: `Deactivated ${fullName(target)}` });
  ok(res, serializeAdminUser(user));
});

adminUsersRouter.post('/:userId/unlock', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  const user = await prisma.user.update({ where: { id: target.id }, data: { failedLoginCount: 0, lockedUntil: null }, include });
  await audit(req, { action: 'user.unlock', entityType: 'User', entityId: target.id, summary: `Cleared sign-in lockout for ${fullName(target)}` });
  ok(res, serializeAdminUser(user));
});

// ── Account recovery ──────────────────────────────────────────────────────────
adminUsersRouter.post('/:userId/reset-password', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  const temp = temporaryPassword();
  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash: await hashPassword(temp), mustChangePassword: true, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
  if (target.id !== req.user.id) await endAllSessions(target.id);
  await audit(req, { action: 'user.reset_password', entityType: 'User', entityId: target.id, summary: `Issued a temporary password for ${fullName(target)}` });
  ok(res, { temporaryPassword: temp, message: 'Give this temporary password to the user. They must choose a new one when they sign in.' });
});

adminUsersRouter.post('/:userId/send-invite', validate({ params: idParams('userId') }), async (req, res) => {
  const target = await loadTarget(req);
  // Nothing is created or logged as "sent" when no message can leave this server.
  if (!mailAvailable()) throw conflict('This server cannot send e-mail, so a link cannot be sent. Use “Reset password” to give the user a temporary password instead.', 'EMAIL_NOT_AVAILABLE');
  await sendInviteEmail(target, fullName(req.user));
  await audit(req, { action: 'user.invite_sent', entityType: 'User', entityId: target.id, summary: `Sent a set-password link to ${fullName(target)}` });
  ok(res, {
    delivered: mailConfigured(),
    message: mailConfigured()
      ? 'A link to choose a password was e-mailed to the user.'
      : 'The message is in the development mailbox (GET /api/dev/mailbox): this server has no SMTP settings.',
  });
});

// ── Privacy erasure (RA 10173 deletion request) ───────────────────────────────
adminUsersRouter.post(
  '/:userId/anonymize',
  validate({
    params: idParams('userId'),
    body: z.object({ confirm: z.literal('ANONYMIZE', { error: 'Type ANONYMIZE to confirm.' }), reason: z.string().trim().min(5, 'Record why the data is being erased').max(500) }),
  }),
  async (req, res) => {
    const target = await loadTarget(req);
    assertNotSelf(req, target, 'anonymise');
    if (target.role === 'ADMIN') throw forbidden('Administrator accounts cannot be anonymised. Deactivate the account instead.');
    const tag = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    await prisma.$transaction(async (tx) => {
      // Academic records stay (they belong to the institution's retention schedule) but nothing
      // in the row identifies a person any more.
      await tx.user.update({
        where: { id: target.id },
        data: {
          email: `removed-${tag}@anonymised.invalid`,
          firstName: 'Removed',
          lastName: 'User',
          middleName: null,
          phone: null,
          avatarFileId: null,
          passwordHash: `disabled$${randomToken(24)}`,
          status: 'DEACTIVATED',
          anonymizedAt: new Date(),
          emailNotifications: false,
          suspendedReason: null,
        },
      });
      if (target.studentProfile) {
        await tx.studentProfile.update({ where: { userId: target.id }, data: { studentNumber: `removed-${tag}`, programId: null, sectionId: null, yearLevel: null } });
      }
      if (target.teacherProfile) {
        await tx.teacherProfile.update({ where: { userId: target.id }, data: { employeeNumber: null, position: null, specialization: null, consultationHours: null, bio: null } });
      }
      await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.authToken.deleteMany({ where: { userId: target.id } });
      await tx.notification.deleteMany({ where: { userId: target.id } });
      await tx.task.deleteMany({ where: { userId: target.id } });
      await tx.bookmark.deleteMany({ where: { userId: target.id } });
      await tx.classInvitation.deleteMany({ where: { email: target.email } });
      await audit(req, {
        action: 'user.anonymize', entityType: 'User', entityId: target.id,
        summary: 'Personal data erased on request; academic records retained without identity',
        after: { reason: plainText(req.valid.body.reason, 500) },
      }, tx);
    });
    disconnectUser(target.id);
    ok(res, { message: 'Personal data was erased. Academic records are retained without any identifying details.' });
  },
);
