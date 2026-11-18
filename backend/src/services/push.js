// Web Push (VAPID) notification delivery across a user's subscribed PWA/browser devices.
import * as webpushNs from 'web-push';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

const webpush = webpushNs.default?.setVapidDetails ? webpushNs.default : webpushNs;
let configuredVapid = false;

export function pushConfigured() {
  return env.push.configured;
}

function ensureVapid() {
  if (!env.push.configured) return false;
  if (!configuredVapid) {
    webpush.setVapidDetails(env.push.subject, env.push.publicKey, env.push.privateKey);
    configuredVapid = true;
  }
  return true;
}

/**
 * Send a Web Push message to all active subscriptions of `userIds`.
 * Automatically removes expired/unsubscribed endpoints (HTTP 404 / 410).
 */
export async function sendPushToUsers(userIds, notification, { sender = webpush.sendNotification.bind(webpush) } = {}) {
  if (!ensureVapid() || !userIds?.length) return { sent: 0, removed: 0 };
  const subs = await prisma.pushSubscription.findMany({
    where: {
      userId: { in: userIds },
      user: { status: 'ACTIVE', anonymizedAt: null },
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return { sent: 0, removed: 0 };

  const payload = JSON.stringify({
    title: String(notification.title ?? 'EduSphere').slice(0, 120),
    body: notification.body ? String(notification.body).slice(0, 240) : '',
    link: notification.link ?? '/notifications',
    tag: notification.type ?? 'edusphere-notification',
  });

  let sent = 0;
  const staleIds = [];
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await sender(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 24 * 60 * 60 },
        );
        sent += 1;
      } catch (err) {
        const status = err?.statusCode ?? err?.status;
        if (status === 404 || status === 410) {
          staleIds.push(sub.id);
        } else {
          logger.debug({ err, status, subId: sub.id }, 'web push delivery failed');
        }
      }
    }),
  );

  if (staleIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } });
  }
  return { sent, removed: staleIds.length };
}
