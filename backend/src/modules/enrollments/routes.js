// Enrolment: joining with a code, approval workflow, roster management, bulk enrolment and
// e-mail invitations.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, zEmail, zId } from '../../lib/http.js';
import { plainText } from '../../lib/sanitize.js';
import { normalizeCode } from '../../lib/tokens.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { hasPermission } from '../../services/permissions.js';
import { classLabel, loadClassAccess, requireWritableClassManager } from '../classes/access.js';

export const enrollmentsRouter = Router();
enrollmentsRouter.use(requireAuth);

const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const classSummaryInclude = {
  course: { select: { code: true, title: true } },
  section: { select: { name: true } },
  semester: { select: { name: true, academicYear: { select: { name: true } } } },
  teacher: { select: { firstName: true, lastName: true } },
};

const classSummary = (cls) => ({
  id: cls.id,
  title: `${cls.course.code} — ${cls.course.title}`,
  course: cls.course,
  section: cls.section,
  semester: cls.semester,
  teacherName: fullName(cls.teacher),
  color: cls.color,
});

// ── Student: join a class with its code ──────────────────────────────────────
enrollmentsRouter.post(
  '/join',
  requireRole('STUDENT'),
  validate({ body: z.object({ code: z.string().trim().min(4, 'Enter the class code').max(20) }) }),
  async (req, res) => {
    const code = normalizeCode(req.valid.body.code);
    const cls = await prisma.class.findUnique({ where: { enrollmentCode: code }, include: classSummaryInclude });
    // One message for "no such code", "code switched off" and "class archived":
    // the response must not help anyone guess codes.
    if (!cls || !cls.enrollmentCodeEnabled || cls.status !== 'ACTIVE') {
      throw new AppError(404, 'INVALID_CLASS_CODE', 'That class code is not valid. Check it with your teacher and try again.');
    }
    const existing = await prisma.enrollment.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: req.user.id } },
    });
    if (existing?.status === 'ENROLLED') throw conflict('You are already enrolled in this class.', 'ALREADY_ENROLLED');
    if (existing?.status === 'PENDING') throw conflict('Your request to join this class is still waiting for the teacher.', 'REQUEST_PENDING');

    const status = cls.enrollmentRequiresApproval ? 'PENDING' : 'ENROLLED';
    const now = new Date();
    const data = {
      status,
      source: 'CODE',
      requestedAt: now,
      enrolledAt: status === 'ENROLLED' ? now : null,
      decidedAt: null,
      decidedById: null,
      droppedAt: null,
      note: null,
    };
    const enrollment = await prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.enrollment.update({ where: { id: existing.id }, data })
        : await tx.enrollment.create({ data: { classId: cls.id, studentId: req.user.id, ...data } });
      await audit(req, {
        action: status === 'ENROLLED' ? 'enrollment.join' : 'enrollment.request',
        entityType: 'Enrollment', entityId: row.id, classId: cls.id,
        summary: status === 'ENROLLED' ? 'Joined the class with the class code' : 'Requested to join the class',
      }, tx);
      return row;
    });
    await notify([cls.teacherId], {
      type: status === 'ENROLLED' ? 'enrollment.joined' : 'enrollment.requested',
      title: status === 'ENROLLED' ? `${fullName(req.user)} joined ${classLabel(cls)}` : `${fullName(req.user)} asked to join ${classLabel(cls)}`,
      body: status === 'PENDING' ? 'Review the request on the People tab.' : undefined,
      link: `/classes/${cls.id}/people`,
      classId: cls.id,
    });
    created(res, {
      id: enrollment.id,
      status,
      class: classSummary(cls),
      message: status === 'ENROLLED' ? `You joined ${classLabel(cls)}.` : 'Request sent. You will be notified when your teacher approves it.',
    });
  },
);

// ── Student: my enrolments (including pending / rejected) and invitations ───
enrollmentsRouter.get('/mine', requireRole('STUDENT'), async (req, res) => {
  const [enrollments, invitations] = await Promise.all([
    prisma.enrollment.findMany({
      where: { studentId: req.user.id },
      include: { class: { include: classSummaryInclude } },
      orderBy: { requestedAt: 'desc' },
    }),
    prisma.classInvitation.findMany({
      where: { email: req.user.email, status: 'PENDING', expiresAt: { gt: new Date() }, class: { status: 'ACTIVE' } },
      include: { class: { include: classSummaryInclude } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  ok(res, {
    enrollments: enrollments.map((e) => ({
      id: e.id, status: e.status, requestedAt: e.requestedAt, enrolledAt: e.enrolledAt, note: e.status === 'REJECTED' ? e.note : null,
      classStatus: e.class.status, class: classSummary(e.class),
    })),
    invitations: invitations.map((i) => ({ id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt, class: classSummary(i.class) })),
  });
});

async function loadMyInvitation(req) {
  const invitation = await prisma.classInvitation.findUnique({
    where: { id: req.valid.params.invitationId },
    include: { class: { include: classSummaryInclude } },
  });
  // Invitations are addressed to an e-mail address; only the account with that address may act.
  if (!invitation || invitation.email !== req.user.email) throw notFound('Invitation');
  if (invitation.status !== 'PENDING' || invitation.expiresAt <= new Date()) {
    throw conflict('This invitation is no longer valid.', 'INVITATION_INVALID');
  }
  return invitation;
}

enrollmentsRouter.post('/invitations/:invitationId/accept', requireRole('STUDENT'), validate({ params: idParams('invitationId') }), async (req, res) => {
  const invitation = await loadMyInvitation(req);
  if (invitation.class.status !== 'ACTIVE') throw conflict('This class is archived.', 'CLASS_ARCHIVED');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.classInvitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED', respondedAt: now } });
    const data = { status: 'ENROLLED', source: 'INVITE', enrolledAt: now, decidedAt: now, decidedById: invitation.invitedById, droppedAt: null, note: null };
    const row = await tx.enrollment.upsert({
      where: { classId_studentId: { classId: invitation.classId, studentId: req.user.id } },
      create: { classId: invitation.classId, studentId: req.user.id, ...data },
      update: data,
    });
    await audit(req, { action: 'enrollment.invite_accepted', entityType: 'Enrollment', entityId: row.id, classId: invitation.classId, summary: 'Accepted a class invitation' }, tx);
  });
  await notify([invitation.class.teacherId], {
    type: 'enrollment.joined',
    title: `${fullName(req.user)} accepted your invitation to ${classLabel(invitation.class)}`,
    link: `/classes/${invitation.classId}/people`,
    classId: invitation.classId,
  });
  ok(res, { class: classSummary(invitation.class) });
});

enrollmentsRouter.post('/invitations/:invitationId/decline', requireRole('STUDENT'), validate({ params: idParams('invitationId') }), async (req, res) => {
  const invitation = await loadMyInvitation(req);
  await prisma.classInvitation.update({ where: { id: invitation.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
  noContent(res);
});

// ─────────────────────────────── Class roster ────────────────────────────────
export const classPeopleRouter = Router({ mergeParams: true });
classPeopleRouter.use(requireAuth);

const classParams = idParams('classId');

classPeopleRouter.get('/', validate({ params: classParams }), async (req, res) => {
  const { classId } = req.valid.params;
  const access = await loadClassAccess(req.user, classId);
  const teacher = await prisma.user.findUnique({
    where: { id: access.cls.teacherId },
    select: { id: true, firstName: true, lastName: true, email: true, avatarFileId: true, teacherProfile: { select: { position: true, consultationHours: true } } },
  });
  const teacherInfo = {
    id: teacher.id, name: fullName(teacher), email: teacher.email, avatarFileId: teacher.avatarFileId,
    position: teacher.teacherProfile?.position ?? null, consultationHours: teacher.teacherProfile?.consultationHours ?? null,
  };

  if (access.canManage) {
    const [enrollments, invitations] = await Promise.all([
      prisma.enrollment.findMany({
        where: { classId },
        include: { student: { select: { id: true, firstName: true, lastName: true, email: true, avatarFileId: true, status: true, studentProfile: { select: { studentNumber: true, yearLevel: true, program: { select: { code: true } } } } } } },
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      }),
      prisma.classInvitation.findMany({ where: { classId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } }),
    ]);
    return ok(res, {
      teacher: teacherInfo,
      canManage: true,
      classmatesVisible: access.cls.classmatesVisible,
      students: enrollments.map((e) => ({
        enrollmentId: e.id,
        status: e.status,
        source: e.source,
        requestedAt: e.requestedAt,
        enrolledAt: e.enrolledAt,
        droppedAt: e.droppedAt,
        note: e.note,
        id: e.student.id,
        name: fullName(e.student),
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        email: e.student.email,
        avatarFileId: e.student.avatarFileId,
        accountStatus: e.student.status,
        studentNumber: e.student.studentProfile?.studentNumber ?? null,
        yearLevel: e.student.studentProfile?.yearLevel ?? null,
        program: e.student.studentProfile?.program?.code ?? null,
      })),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt, expired: i.expiresAt <= new Date() })),
    });
  }

  // Students: the teacher's contact details, plus classmates only when both the class setting
  // and the institution's permission allow it. Classmates are listed by name only.
  const mayViewClassmates = access.cls.classmatesVisible && (await hasPermission('STUDENT', 'class.view_classmates'));
  const classmates = mayViewClassmates
    ? await prisma.enrollment.findMany({
        where: { classId, status: 'ENROLLED' },
        select: { student: { select: { id: true, firstName: true, lastName: true, avatarFileId: true } } },
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      })
    : [];
  return ok(res, {
    teacher: teacherInfo,
    canManage: false,
    classmatesVisible: mayViewClassmates,
    students: classmates.map((e) => ({ id: e.student.id, name: fullName(e.student), avatarFileId: e.student.avatarFileId, status: 'ENROLLED' })),
    invitations: [],
  });
});

async function loadEnrollment(classId, enrollmentId) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { student: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!enrollment || enrollment.classId !== classId) throw notFound('Enrolment');
  return enrollment;
}

const enrollmentParams = idParams('classId', 'enrollmentId');
const noteBody = z.object({ note: z.string().trim().max(500).optional() });

classPeopleRouter.post('/:enrollmentId/approve', validate({ params: enrollmentParams }), async (req, res) => {
  const { classId, enrollmentId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const enrollment = await loadEnrollment(classId, enrollmentId);
  if (enrollment.status !== 'PENDING') throw conflict('This request has already been decided.', 'NOT_PENDING');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const changed = await tx.enrollment.updateMany({
      where: { id: enrollmentId, status: 'PENDING' },
      data: { status: 'ENROLLED', enrolledAt: now, decidedAt: now, decidedById: req.user.id, note: null },
    });
    if (changed.count !== 1) throw conflict('This request has already been decided.', 'NOT_PENDING');
    await audit(req, { action: 'enrollment.approve', entityType: 'Enrollment', entityId: enrollmentId, classId, summary: `Approved ${fullName(enrollment.student)}` }, tx);
  });
  await notify([enrollment.studentId], {
    type: 'enrollment.approved',
    title: `You are now enrolled in ${classLabel(cls)}`,
    body: 'Your teacher approved your request to join the class.',
    link: `/classes/${classId}`,
    classId,
  });
  ok(res, { status: 'ENROLLED' });
});

classPeopleRouter.post('/:enrollmentId/reject', validate({ params: enrollmentParams, body: noteBody }), async (req, res) => {
  const { classId, enrollmentId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const enrollment = await loadEnrollment(classId, enrollmentId);
  if (enrollment.status !== 'PENDING') throw conflict('This request has already been decided.', 'NOT_PENDING');
  const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
  await prisma.$transaction(async (tx) => {
    const changed = await tx.enrollment.updateMany({
      where: { id: enrollmentId, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedById: req.user.id, note },
    });
    if (changed.count !== 1) throw conflict('This request has already been decided.', 'NOT_PENDING');
    await audit(req, { action: 'enrollment.reject', entityType: 'Enrollment', entityId: enrollmentId, classId, summary: `Rejected ${fullName(enrollment.student)}` }, tx);
  });
  await notify([enrollment.studentId], {
    type: 'enrollment.rejected',
    title: `Your request to join ${classLabel(cls)} was not approved`,
    body: note ?? undefined,
    link: '/classes',
  });
  ok(res, { status: 'REJECTED' });
});

classPeopleRouter.post('/:enrollmentId/drop', validate({ params: enrollmentParams, body: noteBody }), async (req, res) => {
  const { classId, enrollmentId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const enrollment = await loadEnrollment(classId, enrollmentId);
  if (enrollment.status !== 'ENROLLED') throw conflict('Only enrolled students can be removed from the roster.', 'NOT_ENROLLED');
  const note = req.valid.body.note ? plainText(req.valid.body.note, 500) : null;
  await prisma.$transaction(async (tx) => {
    // The student's records (submissions, attendance, grades) are kept; only access ends.
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'DROPPED', droppedAt: new Date(), decidedById: req.user.id, note } });
    await audit(req, { action: 'enrollment.drop', entityType: 'Enrollment', entityId: enrollmentId, classId, summary: `Removed ${fullName(enrollment.student)} from the roster`, after: { note } }, tx);
  });
  await notify([enrollment.studentId], { type: 'enrollment.dropped', title: `You were removed from ${classLabel(cls)}`, body: note ?? undefined, link: '/classes' });
  ok(res, { status: 'DROPPED' });
});

classPeopleRouter.post('/:enrollmentId/reinstate', validate({ params: enrollmentParams }), async (req, res) => {
  const { classId, enrollmentId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const enrollment = await loadEnrollment(classId, enrollmentId);
  if (enrollment.status !== 'DROPPED' && enrollment.status !== 'REJECTED') {
    throw conflict('Only removed or rejected students can be reinstated.', 'INVALID_STATUS');
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'ENROLLED', enrolledAt: now, decidedAt: now, decidedById: req.user.id, droppedAt: null, note: null } });
    await audit(req, { action: 'enrollment.reinstate', entityType: 'Enrollment', entityId: enrollmentId, classId, summary: `Reinstated ${fullName(enrollment.student)}` }, tx);
  });
  await notify([enrollment.studentId], { type: 'enrollment.approved', title: `You are enrolled in ${classLabel(cls)} again`, link: `/classes/${classId}`, classId });
  ok(res, { status: 'ENROLLED' });
});

// ── Bulk enrolment by e-mail address ──────────────────────────────────────────
const bulkBody = z.object({
  // Raw strings are validated one by one so a single typo does not reject the whole batch.
  emails: z.array(z.string().max(254)).min(1, 'Enter at least one e-mail address').max(500),
});

classPeopleRouter.post('/bulk', validate({ params: classParams, body: bulkBody }), async (req, res) => {
  const { classId } = req.valid.params;
  const { cls } = await requireWritableClassManager(req.user, classId);
  const result = { enrolled: [], alreadyEnrolled: [], invited: [], alreadyInvited: [], invalid: [] };

  const seen = new Set();
  const emails = [];
  for (const raw of req.valid.body.emails) {
    const parsed = zEmail.safeParse(raw);
    if (!parsed.success) {
      if (raw.trim() !== '') result.invalid.push({ email: raw.trim().slice(0, 100), reason: 'Not a valid e-mail address' });
      continue;
    }
    if (!seen.has(parsed.data)) {
      seen.add(parsed.data);
      emails.push(parsed.data);
    }
  }

  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, role: true, status: true, firstName: true, lastName: true },
  });
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const now = new Date();
  const newlyEnrolledIds = [];

  await prisma.$transaction(async (tx) => {
    for (const email of emails) {
      const user = byEmail.get(email);
      if (user) {
        if (user.role !== 'STUDENT') {
          result.invalid.push({ email, reason: 'This account is not a student account' });
          continue;
        }
        if (user.status !== 'ACTIVE') {
          result.invalid.push({ email, reason: 'This student account is not active' });
          continue;
        }
        const existing = await tx.enrollment.findUnique({ where: { classId_studentId: { classId, studentId: user.id } } });
        if (existing?.status === 'ENROLLED') {
          result.alreadyEnrolled.push({ email, name: fullName(user) });
          continue;
        }
        const data = { status: 'ENROLLED', source: 'BULK', enrolledAt: now, decidedAt: now, decidedById: req.user.id, droppedAt: null, note: null };
        if (existing) await tx.enrollment.update({ where: { id: existing.id }, data });
        else await tx.enrollment.create({ data: { classId, studentId: user.id, ...data } });
        result.enrolled.push({ email, name: fullName(user) });
        newlyEnrolledIds.push(user.id);
      } else {
        // No account yet: leave an invitation that the student sees after registering.
        const existing = await tx.classInvitation.findUnique({ where: { classId_email: { classId, email } } });
        if (existing?.status === 'PENDING' && existing.expiresAt > now) {
          result.alreadyInvited.push({ email });
          continue;
        }
        const data = { status: 'PENDING', invitedById: req.user.id, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS), respondedAt: null };
        if (existing) await tx.classInvitation.update({ where: { id: existing.id }, data });
        else await tx.classInvitation.create({ data: { classId, email, ...data } });
        result.invited.push({ email });
      }
    }
    await audit(req, {
      action: 'enrollment.bulk', entityType: 'Class', entityId: classId, classId,
      summary: `Bulk enrolment: ${result.enrolled.length} enrolled, ${result.invited.length} invited, ${result.invalid.length} rejected`,
    }, tx);
  });

  await notify(newlyEnrolledIds, {
    type: 'enrollment.approved',
    title: `You were enrolled in ${classLabel(cls)}`,
    body: `${fullName(req.user)} added you to the class.`,
    link: `/classes/${classId}`,
    classId,
  });
  ok(res, result);
});

classPeopleRouter.delete('/invitations/:invitationId', validate({ params: idParams('classId', 'invitationId') }), async (req, res) => {
  const { classId, invitationId } = req.valid.params;
  await requireWritableClassManager(req.user, classId);
  const invitation = await prisma.classInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.classId !== classId) throw notFound('Invitation');
  if (invitation.status !== 'PENDING') throw forbidden('This invitation was already answered.');
  await prisma.classInvitation.update({ where: { id: invitationId }, data: { status: 'REVOKED', respondedAt: new Date() } });
  await audit(req, { action: 'enrollment.invite_revoked', entityType: 'ClassInvitation', entityId: invitationId, classId, summary: 'Invitation revoked' });
  noContent(res);
});

export { zId };
