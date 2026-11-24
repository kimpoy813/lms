// In-app notification centre and Web Push subscriptions.
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { idParams, noContent, ok, pageMeta, pageQuery, paging, zBoolQuery } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { pushConfigured, sendPushToUsers } from '../../services/push.js';
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

// ── Web Push (VAPID) subscriptions ────────────────────────────────────────────
const subscribeBody = z.object({
  endpoint: z.string().url().max(1000).refine((v) => v.startsWith('https://'), 'Push endpoint must use HTTPS'),
  keys: z.object({
    p256dh: z.string().min(10).max(300),
    auth: z.string().min(6).max(200),
  }),
});

notificationsRouter.get('/push/config', async (req, res) => {
  const count = await prisma.pushSubscription.count({ where: { userId: req.user.id } });
  ok(res, {
    supported: pushConfigured(),
    publicKey: pushConfigured() ? env.push.publicKey : null,
    subscribedDevices: count,
  });
});

notificationsRouter.post('/push/subscribe', validate({ body: subscribeBody }), async (req, res) => {
  if (!pushConfigured()) throw badRequest('Web Push notifications are not configured on this server.', 'PUSH_NOT_CONFIGURED');
  const { endpoint, keys } = req.valid.body;
  const userAgent = String(req.get('user-agent') ?? '').slice(0, 300) || null;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent },
  });
  ok(res, { subscribed: true });
});

notificationsRouter.post('/push/unsubscribe', validate({ body: z.object({ endpoint: z.string().url().max(1000) }) }), async (req, res) => {
  const result = await prisma.pushSubscription.deleteMany({
    where: { userId: req.user.id, endpoint: req.valid.body.endpoint },
  });
  ok(res, { removed: result.count });
});

notificationsRouter.post('/push/test', async (req, res) => {
  if (!pushConfigured()) throw badRequest('Web Push notifications are not configured on this server.', 'PUSH_NOT_CONFIGURED');
  const result = await sendPushToUsers([req.user.id], {
    type: 'push.test',
    title: 'Discenda alerts are active',
    body: 'You will receive grade, deadline, announcement, and attendance notifications on this device.',
    link: '/notifications',
  });
  ok(res, result);
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
