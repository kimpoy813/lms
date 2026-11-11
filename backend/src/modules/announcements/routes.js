// Announcements: class-wide, to selected students, or institution-wide (administrators).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, pageMeta, pageQuery, paging, patchOf, zHtml, zId, zOptionalDateTime, zTitle } from '../../lib/http.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { isPublished, publishedWhere, resolvePublication } from '../../lib/visibility.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { enrolledStudentIds, notify } from '../../services/notifications.js';
import { fileSummary, syncAttachments } from '../../services/storage.js';
import { assertClassWritable, classIdsFor, classLabel, loadClassAccess, requireClassManager } from '../classes/access.js';

export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

const include = {
  author: { select: { id: true, firstName: true, lastName: true, role: true, avatarFileId: true } },
  class: { include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } },
  attachments: { where: { deletedAt: null } },
  recipients: { select: { studentId: true } },
  _count: { select: { comments: { where: { deletedAt: null } } } },
};

function view(a, user) {
  const manage = user.role === 'ADMIN' || a.authorId === user.id || (a.class && a.class.teacherId === user.id);
  return {
    id: a.id,
    classId: a.classId,
    classLabel: a.class ? classLabel(a.class) : null,
    title: a.title,
    contentHtml: a.contentHtml,
    excerpt: excerpt(a.contentHtml, 200),
    priority: a.priority,
    audience: a.audience,
    isPinned: a.isPinned,
    allowComments: a.allowComments,
    publishedAt: a.publishedAt ?? (a.status === 'SCHEDULED' ? a.publishAt : null),
    author: { id: a.author.id, name: fullName(a.author), role: a.author.role, avatarFileId: a.author.avatarFileId },
    attachments: a.attachments.map(fileSummary),
    commentCount: a._count.comments,
    canManage: manage,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    // Draft state, schedule and the recipient list are the author's business only.
    ...(manage ? { status: a.status, publishAt: a.publishAt, recipientIds: a.recipients.map((r) => r.studentId) } : {}),
  };
}

/** Prisma filter: announcements this user is allowed to read. */
async function visibleWhere(user, now = new Date()) {
  if (user.role === 'ADMIN') return { deletedAt: null };
  const classIds = await classIdsFor(user);
  if (user.role === 'TEACHER') {
    return {
      deletedAt: null,
      OR: [{ classId: { in: classIds } }, { audience: 'INSTITUTION', ...publishedWhere(now) }],
    };
  }
  return {
    deletedAt: null,
    AND: [
      publishedWhere(now),
      {
        OR: [
          { audience: 'INSTITUTION' },
          { classId: { in: classIds }, audience: 'CLASS' },
          { classId: { in: classIds }, audience: 'SELECTED', recipients: { some: { studentId: user.id } } },
        ],
      },
    ],
  };
}

announcementsRouter.get('/', validate({ query: z.object({ classId: zId.optional(), ...pageQuery }) }), async (req, res) => {
  const q = req.valid.query;
  const base = await visibleWhere(req.user);
  if (q.classId) await loadClassAccess(req.user, q.classId);
  const where = q.classId ? { AND: [base, { classId: q.classId }] } : base;
  const [total, rows] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({ where, include, orderBy: [{ isPinned: 'desc' }, { publishedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], ...paging(q) }),
  ]);
  ok(res, rows.map((a) => view(a, req.user)), pageMeta(q, total));
});

const body = z.object({
  classId: zId.nullable().optional(),
  title: zTitle,
  contentHtml: zHtml.refine((html) => excerpt(html, 10).length > 0 || /<(img|iframe)/i.test(html), 'Write the announcement'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  audience: z.enum(['CLASS', 'SELECTED']).default('CLASS'),
  recipientIds: z.array(zId).max(500).default([]),
  isPinned: z.boolean().default(false),
  allowComments: z.boolean().default(false),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']).default('PUBLISHED'),
  publishAt: zOptionalDateTime,
  fileIds: z.array(zId).max(10).default([]),
});

async function resolveRecipients(classId, audience, recipientIds) {
  if (audience !== 'SELECTED') return [];
  const ids = [...new Set(recipientIds)];
  if (ids.length === 0) throw fieldErrors({ recipientIds: 'Choose at least one student.' });
  const enrolled = new Set(await enrolledStudentIds(classId));
  if (ids.some((id) => !enrolled.has(id))) throw fieldErrors({ recipientIds: 'Every recipient must be enrolled in this class.' });
  return ids;
}

/** Tell the audience about a newly visible announcement. */
export async function notifyAnnouncement(announcement) {
  let userIds;
  if (announcement.audience === 'INSTITUTION') {
    userIds = (await prisma.user.findMany({ where: { status: 'ACTIVE', anonymizedAt: null }, select: { id: true } })).map((u) => u.id);
  } else if (announcement.audience === 'SELECTED') {
    userIds = (await prisma.announcementRecipient.findMany({ where: { announcementId: announcement.id }, select: { studentId: true } })).map((r) => r.studentId);
  } else {
    userIds = await enrolledStudentIds(announcement.classId);
  }
  await notify(userIds, {
    type: 'announcement.new',
    title: `${announcement.priority === 'URGENT' ? 'Urgent: ' : ''}${announcement.title}`,
    body: excerpt(announcement.contentHtml, 140),
    link: announcement.classId ? `/classes/${announcement.classId}/announcements?open=${announcement.id}` : `/announcements?open=${announcement.id}`,
    classId: announcement.classId,
  }, { excludeUserId: announcement.authorId });
}

announcementsRouter.post('/', requireRole('TEACHER', 'ADMIN'), validate({ body }), async (req, res) => {
  const b = req.valid.body;
  let cls = null;
  let audience = b.audience;
  if (b.classId) {
    cls = (await requireClassManager(req.user, b.classId)).cls;
    assertClassWritable(cls);
  } else {
    if (req.user.role !== 'ADMIN') throw fieldErrors({ classId: 'Choose the class this announcement is for.' });
    audience = 'INSTITUTION';
  }
  const publication = resolvePublication(b, null);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  const recipients = cls ? await resolveRecipients(cls.id, audience, b.recipientIds) : [];

  const announcement = await prisma.$transaction(async (tx) => {
    const row = await tx.announcement.create({
      data: {
        classId: cls?.id ?? null, authorId: req.user.id, title: plainText(b.title, 200), contentHtml: sanitizeRichText(b.contentHtml),
        priority: b.priority, audience, isPinned: b.isPinned, allowComments: b.allowComments, ...publication,
        recipients: { create: recipients.map((studentId) => ({ studentId })) },
      },
    });
    await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'announcementId', parentId: row.id });
    if (!cls) await audit(req, { action: 'announcement.institution', entityType: 'Announcement', entityId: row.id, summary: `Posted institution-wide announcement "${row.title}"` }, tx);
    return row;
  });
  if (announcement.status === 'PUBLISHED') await notifyAnnouncement(announcement);
  created(res, view(await prisma.announcement.findUnique({ where: { id: announcement.id }, include }), req.user));
});

async function loadVisible(req) {
  const where = await visibleWhere(req.user);
  const a = await prisma.announcement.findFirst({ where: { AND: [where, { id: req.valid.params.announcementId }] }, include });
  if (!a) throw notFound('Announcement');
  return a;
}

async function loadManaged(req) {
  const a = await loadVisible(req);
  if (!view(a, req.user).canManage) throw forbidden();
  if (a.class) assertClassWritable(a.class);
  return a;
}

const commentView = (c, user, canModerate) => ({
  id: c.id, body: c.body, createdAt: c.createdAt,
  author: { id: c.author.id, name: fullName(c.author), role: c.author.role, avatarFileId: c.author.avatarFileId },
  canDelete: canModerate || c.authorId === user.id,
});

announcementsRouter.get('/:announcementId', validate({ params: idParams('announcementId') }), async (req, res) => {
  const a = await loadVisible(req);
  const v = view(a, req.user);
  const comments = await prisma.announcementComment.findMany({
    where: { announcementId: a.id, deletedAt: null },
    include: { author: { select: { id: true, firstName: true, lastName: true, role: true, avatarFileId: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  ok(res, { ...v, comments: comments.map((c) => commentView(c, req.user, v.canManage)) });
});

announcementsRouter.patch('/:announcementId', validate({ params: idParams('announcementId'), body: patchOf(body.omit({ classId: true })) }), async (req, res) => {
  const a = await loadManaged(req);
  const b = req.valid.body;
  const publication = resolvePublication({ status: b.status, publishAt: b.publishAt ?? a.publishAt }, a);
  if (publication.error) throw fieldErrors({ publishAt: publication.error });
  const audience = a.audience === 'INSTITUTION' ? 'INSTITUTION' : (b.audience ?? a.audience);
  const recipientsChanged = a.classId && (b.audience !== undefined || b.recipientIds !== undefined);
  const recipients = recipientsChanged ? await resolveRecipients(a.classId, audience, b.recipientIds ?? a.recipients.map((r) => r.studentId)) : null;
  const wasVisible = isPublished(a);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.announcement.update({
      where: { id: a.id },
      data: {
        ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
        ...(b.contentHtml !== undefined ? { contentHtml: sanitizeRichText(b.contentHtml) } : {}),
        ...(b.priority !== undefined ? { priority: b.priority } : {}),
        ...(b.isPinned !== undefined ? { isPinned: b.isPinned } : {}),
        ...(b.allowComments !== undefined ? { allowComments: b.allowComments } : {}),
        audience,
        ...publication,
      },
    });
    if (recipients) {
      await tx.announcementRecipient.deleteMany({ where: { announcementId: a.id } });
      if (recipients.length > 0) await tx.announcementRecipient.createMany({ data: recipients.map((studentId) => ({ announcementId: a.id, studentId })) });
    }
    if (b.fileIds !== undefined) await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'announcementId', parentId: a.id });
    return row;
  });
  if (!wasVisible && updated.status === 'PUBLISHED') await notifyAnnouncement(updated);
  ok(res, view(await prisma.announcement.findUnique({ where: { id: a.id }, include }), req.user));
});

announcementsRouter.delete('/:announcementId', validate({ params: idParams('announcementId') }), async (req, res) => {
  const a = await loadManaged(req);
  await prisma.announcement.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
  noContent(res);
});

// ── Comments ─────────────────────────────────────────────────────────────────
announcementsRouter.post(
  '/:announcementId/comments',
  validate({ params: idParams('announcementId'), body: z.object({ body: z.string().trim().min(1, 'Write a comment').max(2000) }) }),
  async (req, res) => {
    const a = await loadVisible(req);
    if (!a.allowComments) throw conflict('Comments are turned off for this announcement.', 'COMMENTS_DISABLED');
    if (!isPublished(a)) throw conflict('This announcement is not published yet.', 'NOT_PUBLISHED');
    if (a.class) assertClassWritable(a.class);
    const comment = await prisma.announcementComment.create({
      data: { announcementId: a.id, authorId: req.user.id, body: plainText(req.valid.body.body, 2000) },
      include: { author: { select: { id: true, firstName: true, lastName: true, role: true, avatarFileId: true } } },
    });
    await notify([a.authorId], {
      type: 'announcement.comment', title: `${fullName(req.user)} commented on "${a.title}"`, body: excerpt(comment.body, 120),
      link: a.classId ? `/classes/${a.classId}/announcements?open=${a.id}` : `/announcements?open=${a.id}`, classId: a.classId,
    }, { excludeUserId: req.user.id });
    created(res, commentView(comment, req.user, view(a, req.user).canManage));
  },
);

announcementsRouter.delete('/:announcementId/comments/:commentId', validate({ params: idParams('announcementId', 'commentId') }), async (req, res) => {
  const a = await loadVisible(req);
  const comment = await prisma.announcementComment.findFirst({ where: { id: req.valid.params.commentId, announcementId: a.id, deletedAt: null } });
  if (!comment) throw notFound('Comment');
  if (comment.authorId !== req.user.id && !view(a, req.user).canManage) throw forbidden();
  await prisma.announcementComment.update({ where: { id: comment.id }, data: { deletedAt: new Date() } });
  noContent(res);
});
