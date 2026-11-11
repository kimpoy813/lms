// Direct (one-to-one) messages.
//
// Who may write to whom:
//   administrator → anyone
//   teacher       → students of their classes, other teachers and administrators
//   student       → teachers of classes they are enrolled in   (permission messaging.student_to_teacher)
//                   classmates, where the class shows its list  (permission messaging.student_to_student)
// A student can always answer a teacher or administrator who wrote to them first.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { created, fullName, idParams, noContent, ok, zId } from '../../lib/http.js';
import { cleanText } from '../../lib/sanitize.js';
import { requireAuth } from '../../middleware/auth.js';
import { messageLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { hasPermission } from '../../services/permissions.js';
import { emitToUser } from '../../services/realtime.js';
import { attachFiles, fileSummary } from '../../services/storage.js';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const person = { id: true, firstName: true, lastName: true, role: true, status: true, avatarFileId: true };
const personView = (u) => ({ id: u.id, name: fullName(u), role: u.role, avatarFileId: u.avatarFileId ?? null, active: u.status === 'ACTIVE' });
const directKey = (a, b) => [a, b].sort().join(':');

/** Ids the user may start a conversation with — or null for "anyone". */
async function contactScope(user) {
  if (user.role === 'ADMIN') return null;
  if (user.role === 'TEACHER') {
    const [students, staff] = await Promise.all([
      prisma.enrollment.findMany({ where: { status: 'ENROLLED', class: { teacherId: user.id } }, select: { studentId: true }, distinct: ['studentId'] }),
      prisma.user.findMany({ where: { role: { in: ['TEACHER', 'ADMIN'] }, status: 'ACTIVE' }, select: { id: true } }),
    ]);
    return new Set([...students.map((s) => s.studentId), ...staff.map((s) => s.id)]);
  }
  const [toTeacher, toStudent] = await Promise.all([hasPermission('STUDENT', 'messaging.student_to_teacher'), hasPermission('STUDENT', 'messaging.student_to_student')]);
  const enrollments = await prisma.enrollment.findMany({ where: { studentId: user.id, status: 'ENROLLED' }, select: { classId: true, class: { select: { teacherId: true, classmatesVisible: true } } } });
  const ids = new Set();
  if (toTeacher) for (const e of enrollments) ids.add(e.class.teacherId);
  if (toStudent) {
    const visible = enrollments.filter((e) => e.class.classmatesVisible).map((e) => e.classId);
    if (visible.length > 0) {
      const mates = await prisma.enrollment.findMany({ where: { classId: { in: visible }, status: 'ENROLLED' }, select: { studentId: true }, distinct: ['studentId'] });
      for (const m of mates) ids.add(m.studentId);
    }
  }
  return ids;
}

async function canWriteTo(user, target, conversationId) {
  if (target.id === user.id || target.status !== 'ACTIVE') return false;
  const scope = await contactScope(user);
  if (scope === null || scope.has(target.id)) return true;
  // Replying to staff who wrote first is always allowed.
  if (conversationId && target.role !== 'STUDENT') {
    return (await prisma.message.count({ where: { conversationId, senderId: target.id } })) > 0;
  }
  return false;
}

async function loadConversation(user, id) {
  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { participants: { include: { user: { select: person } } } } });
  const me = conversation?.participants.find((p) => p.userId === user.id);
  if (!conversation || !me) throw notFound('Conversation');
  const other = conversation.participants.find((p) => p.userId !== user.id);
  return { conversation, me, other };
}

const messageView = (m) => ({
  id: m.id, conversationId: m.conversationId, senderId: m.senderId, createdAt: m.createdAt, deleted: Boolean(m.deletedAt),
  body: m.deletedAt ? '' : m.body,
  attachments: m.deletedAt ? [] : (m.attachments ?? []).filter((f) => !f.deletedAt).map(fileSummary),
});

export async function unreadCount(userId) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "Message" m
    JOIN "ConversationParticipant" p ON p."conversationId" = m."conversationId" AND p."userId" = ${userId}
    WHERE m."senderId" <> ${userId} AND m."deletedAt" IS NULL AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")`;
  return rows[0]?.count ?? 0;
}

messagesRouter.get('/unread-count', async (req, res) => {
  ok(res, { count: await unreadCount(req.user.id) });
});

messagesRouter.get('/conversations', async (req, res) => {
  const rows = await prisma.conversation.findMany({
    where: { participants: { some: { userId: req.user.id } }, messages: { some: {} } },
    include: { participants: { include: { user: { select: person } } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
  });
  const unread = await prisma.$queryRaw`
    SELECT m."conversationId" AS id, COUNT(*)::int AS count
    FROM "Message" m
    JOIN "ConversationParticipant" p ON p."conversationId" = m."conversationId" AND p."userId" = ${req.user.id}
    WHERE m."senderId" <> ${req.user.id} AND m."deletedAt" IS NULL AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
    GROUP BY m."conversationId"`;
  const unreadOf = new Map(unread.map((u) => [u.id, u.count]));
  ok(res, rows.map((c) => {
    const other = c.participants.find((p) => p.userId !== req.user.id);
    const last = c.messages[0];
    return {
      id: c.id, with: other ? personView(other.user) : null, lastMessageAt: c.lastMessageAt, unread: unreadOf.get(c.id) ?? 0,
      lastMessage: last ? { senderId: last.senderId, preview: last.deletedAt ? 'Message deleted' : last.body.slice(0, 120), createdAt: last.createdAt } : null,
    };
  }));
});

/** People the user may write to. */
messagesRouter.get('/contacts', validate({ query: z.object({ search: z.string().trim().max(80).optional() }) }), async (req, res) => {
  const scope = await contactScope(req.user);
  const search = req.valid.query.search;
  if (scope && scope.size === 0) return ok(res, []);
  const users = await prisma.user.findMany({
    where: {
      id: scope ? { in: [...scope].filter((id) => id !== req.user.id) } : { not: req.user.id },
      status: 'ACTIVE', anonymizedAt: null,
      ...(search ? { OR: search.split(/\s+/).slice(0, 3).map((word) => ({ OR: [{ firstName: { contains: word, mode: 'insensitive' } }, { lastName: { contains: word, mode: 'insensitive' } }] })) } : {}),
    },
    select: person,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 50,
  });
  return ok(res, users.map(personView));
});

/** Open (or find) the conversation with one person. */
messagesRouter.post('/conversations', validate({ body: z.object({ userId: zId }) }), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.valid.body.userId }, select: person });
  if (!target) throw notFound('User');
  const key = directKey(req.user.id, target.id);
  let conversation = await prisma.conversation.findUnique({ where: { directKey: key } });
  if (!conversation) {
    if (!(await canWriteTo(req.user, target))) throw forbidden('You cannot send messages to this person.', 'MESSAGING_NOT_ALLOWED');
    conversation = await prisma.conversation
      .create({ data: { directKey: key, participants: { create: [{ userId: req.user.id, lastReadAt: new Date() }, { userId: target.id }] } } })
      .catch(async (err) => {
        if (err.code === 'P2002') return prisma.conversation.findUnique({ where: { directKey: key } });
        throw err;
      });
  }
  ok(res, { id: conversation.id, with: personView(target), canSend: await canWriteTo(req.user, target, conversation.id) });
});

messagesRouter.get(
  '/conversations/:conversationId',
  validate({ params: idParams('conversationId'), query: z.object({ before: zId.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }) }),
  async (req, res) => {
    const { conversation, other } = await loadConversation(req.user, req.valid.params.conversationId);
    const { before, limit } = req.valid.query;
    const cursor = before ? await prisma.message.findFirst({ where: { id: before, conversationId: conversation.id }, select: { createdAt: true } }) : null;
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id, ...(cursor ? { createdAt: { lt: cursor.createdAt } } : {}) },
      include: { attachments: true }, orderBy: { createdAt: 'desc' }, take: limit + 1,
    });
    const hasMore = rows.length > limit;
    ok(res, {
      id: conversation.id,
      with: other ? personView(other.user) : null,
      canSend: other ? await canWriteTo(req.user, other.user, conversation.id) : false,
      otherLastReadAt: other?.lastReadAt ?? null,
      messages: rows.slice(0, limit).reverse().map(messageView),
      hasMore,
    });
  },
);

messagesRouter.post(
  '/conversations/:conversationId/messages',
  messageLimiter,
  validate({ params: idParams('conversationId'), body: z.object({ body: z.string().max(5000).default(''), fileIds: z.array(zId).max(5).default([]) }) }),
  async (req, res) => {
    const { conversation, other } = await loadConversation(req.user, req.valid.params.conversationId);
    if (!other || !(await canWriteTo(req.user, other.user, conversation.id))) throw forbidden('You cannot send messages to this person.', 'MESSAGING_NOT_ALLOWED');
    const text = cleanText(req.valid.body.body, 5000);
    const { fileIds } = req.valid.body;
    if (!text && fileIds.length === 0) throw fieldErrors({ body: 'Write a message or attach a file.' });
    const now = new Date();
    const message = await prisma.$transaction(async (tx) => {
      const row = await tx.message.create({ data: { conversationId: conversation.id, senderId: req.user.id, body: text } });
      await attachFiles(tx, { fileIds, ownerId: req.user.id, field: 'messageId', parentId: row.id, max: 5 });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
      await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId: conversation.id, userId: req.user.id } }, data: { lastReadAt: now } });
      return tx.message.findUnique({ where: { id: row.id }, include: { attachments: true } });
    });
    const view = messageView(message);
    emitToUser(other.userId, 'message:new', { ...view, from: { id: req.user.id, name: fullName(req.user) } });
    emitToUser(req.user.id, 'message:sent', view);
    created(res, view);
  },
);

messagesRouter.post('/conversations/:conversationId/read', validate({ params: idParams('conversationId') }), async (req, res) => {
  const { conversation, other } = await loadConversation(req.user, req.valid.params.conversationId);
  const now = new Date();
  await prisma.conversationParticipant.update({ where: { conversationId_userId: { conversationId: conversation.id, userId: req.user.id } }, data: { lastReadAt: now } });
  if (other) emitToUser(other.userId, 'message:read', { conversationId: conversation.id, readAt: now });
  ok(res, { unread: await unreadCount(req.user.id) });
});

/** Take back a message you sent. The other person sees that a message was deleted. */
messagesRouter.delete('/messages/:messageId', validate({ params: idParams('messageId') }), async (req, res) => {
  const message = await prisma.message.findUnique({ where: { id: req.valid.params.messageId }, include: { conversation: { include: { participants: true } } } });
  if (!message || message.senderId !== req.user.id) throw notFound('Message');
  if (!message.deletedAt) {
    await prisma.$transaction([
      prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date(), body: '' } }),
      prisma.file.updateMany({ where: { messageId: message.id }, data: { deletedAt: new Date() } }),
    ]);
    for (const p of message.conversation.participants) emitToUser(p.userId, 'message:deleted', { id: message.id, conversationId: message.conversationId });
  }
  noContent(res);
});
