// Class discussion boards: threads with (one level of) nested replies.
// Teachers moderate: pin, lock, hide and delete. Hidden posts stay visible to the teacher and to
// their author (marked as hidden) and are placeholders for everybody else.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, pageMeta, pageQuery, paging, patchOf, zHtml, zId, zTitle } from '../../lib/http.js';
import { excerpt, plainText, sanitizeRichText } from '../../lib/sanitize.js';
import { assertPermission, requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { attachFiles, fileSummary, syncAttachments } from '../../services/storage.js';
import { assertClassWritable, classLabel, loadClassAccess } from '../classes/access.js';

export const classDiscussionsRouter = Router({ mergeParams: true }); // /classes/:classId/discussions
export const discussionsRouter = Router(); // /discussions
classDiscussionsRouter.use(requireAuth);
discussionsRouter.use(requireAuth);

const author = { select: { id: true, firstName: true, lastName: true, role: true, avatarFileId: true } };
const authorView = (u) => ({ id: u.id, name: fullName(u), role: u.role, avatarFileId: u.avatarFileId ?? null });
const files = (list) => (list ?? []).filter((f) => !f.deletedAt).map(fileSummary);

function threadSummary(t, user, canManage) {
  return {
    id: t.id, classId: t.classId, title: t.title, topic: t.topic, excerpt: excerpt(t.body, 180), author: authorView(t.author),
    isPinned: t.isPinned, isLocked: t.isLocked, isHidden: t.isHidden, replyCount: t._count?.replies ?? 0,
    createdAt: t.createdAt, lastActivityAt: t.lastActivityAt,
    canEdit: t.authorId === user.id, canModerate: canManage,
  };
}

function replyView(r, user, canManage) {
  const concealed = r.isHidden && !canManage && r.authorId !== user.id;
  return {
    id: r.id, parentReplyId: r.parentReplyId, author: concealed ? null : authorView(r.author), isHidden: r.isHidden,
    body: concealed ? '' : r.body, attachments: concealed ? [] : files(r.attachments),
    createdAt: r.createdAt, edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
    canEdit: r.authorId === user.id, canModerate: canManage,
  };
}

async function loadThread(user, threadId) {
  const thread = await prisma.discussionThread.findFirst({ where: { id: threadId, deletedAt: null }, include: { author, attachments: true, _count: { select: { replies: { where: { deletedAt: null } } } } } });
  if (!thread) throw notFound('Discussion');
  const access = await loadClassAccess(user, thread.classId);
  if (thread.isHidden && !access.canManage && thread.authorId !== user.id) throw notFound('Discussion');
  return { thread, access };
}

// ── Threads ──────────────────────────────────────────────────────────────────
classDiscussionsRouter.get(
  '/',
  validate({ params: idParams('classId'), query: z.object({ ...pageQuery, search: z.string().trim().max(100).optional(), topic: z.string().trim().max(60).optional() }) }),
  async (req, res) => {
    const access = await loadClassAccess(req.user, req.valid.params.classId);
    const { search, topic } = req.valid.query;
    const where = {
      classId: access.cls.id, deletedAt: null,
      ...(access.canManage ? {} : { OR: [{ isHidden: false }, { authorId: req.user.id }] }),
      ...(topic ? { topic } : {}),
      ...(search ? { AND: [{ OR: [{ title: { contains: search, mode: 'insensitive' } }, { body: { contains: search, mode: 'insensitive' } }] }] } : {}),
    };
    const [total, rows, topics] = await Promise.all([
      prisma.discussionThread.count({ where }),
      prisma.discussionThread.findMany({ where, include: { author, _count: { select: { replies: { where: { deletedAt: null } } } } }, orderBy: [{ isPinned: 'desc' }, { lastActivityAt: 'desc' }], ...paging(req.valid.query) }),
      prisma.discussionThread.findMany({ where: { classId: access.cls.id, deletedAt: null, topic: { not: null } }, distinct: ['topic'], select: { topic: true }, orderBy: { topic: 'asc' }, take: 50 }),
    ]);
    ok(res, rows.map((t) => threadSummary(t, req.user, access.canManage)), { ...pageMeta(req.valid.query, total), topics: topics.map((t) => t.topic), canCreate: true });
  },
);

const threadBody = z.object({
  title: zTitle,
  body: zHtml,
  topic: z.string().trim().max(60).nullable().optional(),
  fileIds: z.array(zId).max(5).default([]),
});

classDiscussionsRouter.post('/', validate({ params: idParams('classId'), body: threadBody }), async (req, res) => {
  const access = await loadClassAccess(req.user, req.valid.params.classId);
  assertClassWritable(access.cls);
  if (access.isStudent) await assertPermission(req.user, 'discussion.create_thread');
  const b = req.valid.body;
  const thread = await prisma.$transaction(async (tx) => {
    const row = await tx.discussionThread.create({ data: { classId: access.cls.id, authorId: req.user.id, title: plainText(b.title, 200), body: sanitizeRichText(b.body), topic: b.topic ? plainText(b.topic, 60) : null } });
    await attachFiles(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'threadId', parentId: row.id, max: 5 });
    return row;
  });
  // A thread opened by the teacher is a prompt for the whole class; a student's thread notifies the teacher.
  if (access.canManage) {
    const students = await prisma.enrollment.findMany({ where: { classId: access.cls.id, status: 'ENROLLED' }, select: { studentId: true } });
    await notify(students.map((s) => s.studentId), { type: 'discussion.thread', title: `New discussion: ${thread.title}`, body: classLabel(access.cls), link: `/classes/${access.cls.id}/discussions/${thread.id}`, classId: access.cls.id });
  } else {
    await notify([access.cls.teacherId], { type: 'discussion.thread', title: `${fullName(req.user)} started a discussion`, body: thread.title, link: `/classes/${access.cls.id}/discussions/${thread.id}`, classId: access.cls.id });
  }
  const { thread: full } = await loadThread(req.user, thread.id);
  created(res, { ...threadSummary(full, req.user, access.canManage), body: full.body, attachments: files(full.attachments), replies: [] });
});

discussionsRouter.get('/threads/:threadId', validate({ params: idParams('threadId') }), async (req, res) => {
  const { thread, access } = await loadThread(req.user, req.valid.params.threadId);
  const replies = await prisma.discussionReply.findMany({ where: { threadId: thread.id, deletedAt: null }, include: { author, attachments: true }, orderBy: { createdAt: 'asc' }, take: 2000 });
  ok(res, {
    ...threadSummary(thread, req.user, access.canManage),
    body: thread.body,
    attachments: files(thread.attachments),
    canReply: access.cls.status === 'ACTIVE' && (!thread.isLocked || access.canManage),
    replies: replies.map((r) => replyView(r, req.user, access.canManage)),
  });
});

discussionsRouter.patch(
  '/threads/:threadId',
  validate({ params: idParams('threadId'), body: patchOf(threadBody).extend({ isPinned: z.boolean().optional(), isLocked: z.boolean().optional(), isHidden: z.boolean().optional() }) }),
  async (req, res) => {
    const { thread, access } = await loadThread(req.user, req.valid.params.threadId);
    assertClassWritable(access.cls);
    const b = req.valid.body;
    const editing = b.title !== undefined || b.body !== undefined || b.topic !== undefined || b.fileIds !== undefined;
    const moderating = b.isPinned !== undefined || b.isLocked !== undefined || b.isHidden !== undefined;
    if (editing && thread.authorId !== req.user.id) throw forbidden('Only the author can edit this post.');
    if (moderating && !access.canManage) throw forbidden('Only the class teacher can moderate discussions.');
    await prisma.$transaction(async (tx) => {
      await tx.discussionThread.update({
        where: { id: thread.id },
        data: {
          ...(b.title !== undefined ? { title: plainText(b.title, 200) } : {}),
          ...(b.body !== undefined ? { body: sanitizeRichText(b.body) } : {}),
          ...(b.topic !== undefined ? { topic: b.topic ? plainText(b.topic, 60) : null } : {}),
          ...(b.isPinned !== undefined ? { isPinned: b.isPinned } : {}),
          ...(b.isLocked !== undefined ? { isLocked: b.isLocked } : {}),
          ...(b.isHidden !== undefined ? { isHidden: b.isHidden } : {}),
        },
      });
      if (b.fileIds !== undefined) await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'threadId', parentId: thread.id, max: 5 });
    });
    if (b.isHidden !== undefined && b.isHidden !== thread.isHidden) {
      await audit(req, { action: b.isHidden ? 'discussion.hide' : 'discussion.unhide', entityType: 'DiscussionThread', entityId: thread.id, classId: thread.classId, summary: `${b.isHidden ? 'Hid' : 'Restored'} the discussion "${thread.title}"` });
    }
    const { thread: full } = await loadThread(req.user, thread.id);
    ok(res, { ...threadSummary(full, req.user, access.canManage), body: full.body, attachments: files(full.attachments) });
  },
);

discussionsRouter.delete('/threads/:threadId', validate({ params: idParams('threadId') }), async (req, res) => {
  const { thread, access } = await loadThread(req.user, req.valid.params.threadId);
  if (!access.canManage && thread.authorId !== req.user.id) throw forbidden('Only the author or the class teacher can delete this discussion.');
  await prisma.discussionThread.update({ where: { id: thread.id }, data: { deletedAt: new Date() } });
  if (thread.authorId !== req.user.id) await audit(req, { action: 'discussion.delete', entityType: 'DiscussionThread', entityId: thread.id, classId: thread.classId, summary: `Deleted the discussion "${thread.title}"` });
  noContent(res);
});

// ── Replies ──────────────────────────────────────────────────────────────────
const replyBody = z.object({ body: zHtml, parentReplyId: zId.nullable().optional(), fileIds: z.array(zId).max(5).default([]) });

discussionsRouter.post('/threads/:threadId/replies', validate({ params: idParams('threadId'), body: replyBody }), async (req, res) => {
  const { thread, access } = await loadThread(req.user, req.valid.params.threadId);
  assertClassWritable(access.cls);
  if (thread.isLocked && !access.canManage) throw conflict('This discussion is locked.', 'THREAD_LOCKED');
  const b = req.valid.body;
  const html = sanitizeRichText(b.body);
  let parent = null;
  if (b.parentReplyId) {
    parent = await prisma.discussionReply.findFirst({ where: { id: b.parentReplyId, threadId: thread.id, deletedAt: null } });
    if (!parent) throw notFound('Reply');
  }
  const reply = await prisma.$transaction(async (tx) => {
    // Replies to a reply are kept one level deep: answering a nested reply attaches to its parent.
    const row = await tx.discussionReply.create({ data: { threadId: thread.id, authorId: req.user.id, parentReplyId: parent ? parent.parentReplyId ?? parent.id : null, body: html } });
    await attachFiles(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'replyId', parentId: row.id, max: 5 });
    await tx.discussionThread.update({ where: { id: thread.id }, data: { lastActivityAt: new Date() } });
    return tx.discussionReply.findUnique({ where: { id: row.id }, include: { author, attachments: true } });
  });
  await notify([thread.authorId, parent?.authorId], { type: 'discussion.reply', title: `${fullName(req.user)} replied in "${thread.title}"`, body: excerpt(html, 140), link: `/classes/${thread.classId}/discussions/${thread.id}`, classId: thread.classId }, { excludeUserId: req.user.id });
  created(res, replyView(reply, req.user, access.canManage));
});

async function loadReply(user, replyId) {
  const reply = await prisma.discussionReply.findFirst({ where: { id: replyId, deletedAt: null }, include: { author, attachments: true } });
  if (!reply) throw notFound('Reply');
  const { thread, access } = await loadThread(user, reply.threadId);
  return { reply, thread, access };
}

discussionsRouter.patch(
  '/replies/:replyId',
  validate({ params: idParams('replyId'), body: z.object({ body: zHtml.optional(), fileIds: z.array(zId).max(5).optional(), isHidden: z.boolean().optional() }) }),
  async (req, res) => {
    const { reply, thread, access } = await loadReply(req.user, req.valid.params.replyId);
    assertClassWritable(access.cls);
    const b = req.valid.body;
    if ((b.body !== undefined || b.fileIds !== undefined) && reply.authorId !== req.user.id) throw forbidden('Only the author can edit this reply.');
    if (b.isHidden !== undefined && !access.canManage) throw forbidden('Only the class teacher can moderate discussions.');
    if (b.body !== undefined && thread.isLocked && !access.canManage) throw conflict('This discussion is locked.', 'THREAD_LOCKED');
    const updated = await prisma.$transaction(async (tx) => {
      if (b.fileIds !== undefined) await syncAttachments(tx, { fileIds: b.fileIds, ownerId: req.user.id, field: 'replyId', parentId: reply.id, max: 5 });
      return tx.discussionReply.update({
        where: { id: reply.id },
        data: { ...(b.body !== undefined ? { body: sanitizeRichText(b.body) } : {}), ...(b.isHidden !== undefined ? { isHidden: b.isHidden } : {}) },
        include: { author, attachments: true },
      });
    });
    if (b.isHidden !== undefined && b.isHidden !== reply.isHidden) {
      await audit(req, { action: b.isHidden ? 'discussion.reply.hide' : 'discussion.reply.unhide', entityType: 'DiscussionReply', entityId: reply.id, classId: thread.classId, summary: `${b.isHidden ? 'Hid' : 'Restored'} a reply in "${thread.title}"` });
    }
    ok(res, replyView(updated, req.user, access.canManage));
  },
);

discussionsRouter.delete('/replies/:replyId', validate({ params: idParams('replyId') }), async (req, res) => {
  const { reply, thread, access } = await loadReply(req.user, req.valid.params.replyId);
  if (!access.canManage && reply.authorId !== req.user.id) throw forbidden('Only the author or the class teacher can delete this reply.');
  await prisma.discussionReply.update({ where: { id: reply.id }, data: { deletedAt: new Date() } });
  if (reply.authorId !== req.user.id) await audit(req, { action: 'discussion.reply.delete', entityType: 'DiscussionReply', entityId: reply.id, classId: thread.classId, summary: `Deleted a reply in "${thread.title}"` });
  noContent(res);
});
