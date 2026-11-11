// In-app notification centre.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { idParams, noContent, ok, pageMeta, pageQuery, paging, zBoolQuery } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { unreadCount as unreadMessages } from '../messages/routes.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const view = (n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, classId: n.classId, readAt: n.readAt, createdAt: n.createdAt });

notificationsRouter.get('/', validate({ query: z.object({ unread: zBoolQuery.optional(), ...pageQuery }) }), async (req, res) => {
  const q = req.valid.query;
  const where = { userId: req.user.id, ...(q.unread ? { readAt: null } : {}) };
  const [total, rows, unread] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paging(q) }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);
  ok(res, rows.map(view), { ...pageMeta(q, total), unread });
});

// Both numbers the page header shows, in one request: every signed-in tab asks for them again
// and again, so one round trip instead of two is the largest saving there is.
notificationsRouter.get('/badges', async (req, res) => {
  const [notifications, messages] = await Promise.all([
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    unreadMessages(req.user.id),
  ]);
  ok(res, { notifications, messages });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  ok(res, { unread: await prisma.notification.count({ where: { userId: req.user.id, readAt: null } }) });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  ok(res, { updated: result.count });
});

// Scoping every statement by userId means one user can never touch another user's notifications.
notificationsRouter.post('/:notificationId/read', validate({ params: idParams('notificationId') }), async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.valid.params.notificationId, userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  ok(res, { unread: await prisma.notification.count({ where: { userId: req.user.id, readAt: null } }) });
});

notificationsRouter.delete('/:notificationId', validate({ params: idParams('notificationId') }), async (req, res) => {
  await prisma.notification.deleteMany({ where: { id: req.valid.params.notificationId, userId: req.user.id } });
  noContent(res);
});
