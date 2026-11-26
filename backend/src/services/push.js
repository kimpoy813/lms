// Web Push (VAPID) notification delivery across a user's subscribed PWA/browser devices.
import { randomUUID } from 'node:crypto';
import * as webpushNs from 'web-push';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

const webpush = webpushNs.default?.setVapidDetails ? webpushNs.default : webpushNs;
let configuredSignature = null;
let defaultSender = webpush.sendNotification.bind(webpush);

export function setPushSenderForTest(fn) {
  defaultSender = fn ?? webpush.sendNotification.bind(webpush);
}

const HIGH_URGENCY_TYPES = new Set([
  'attendance.open',
  'message.new',
  'assignment.due_soon',
  'quiz.closing_soon',
  'push.test',
]);
const GENERIC_PUSH_TITLES = new Set(['discenda', 'notification', 'new notification', 'new message']);

const EMPTY_BODY_FALLBACKS = {
  'module.published': 'A new learning module is ready to read in Discenda.',
  'assignment.published': 'Open Discenda to review the assignment details and submit.',
  'assignment.updated': 'Open Discenda to view the updated assignment deadline.',
  'assignment.returned': 'Open Discenda to view your score and feedback.',
  'quiz.published': 'Open Discenda to view quiz instructions and availability.',
  'quiz.results': 'Open Discenda to check your quiz score and review.',
  'grades.published': 'Open Discenda to view your posted grades.',
  'grades.finalized': 'Open Discenda to view your final grade breakdown.',
  'grade.appeal': 'Open Discenda to review the student grade inquiry.',
  'grade.appeal.resolved': 'Open Discenda to view your teacher’s response.',
  'enrollment.approved': 'Open Discenda to access your class modules and coursework.',
  'enrollment.joined': 'Open Discenda to view the updated class roster.',
  'enrollment.requested': 'Open Discenda to review the pending enrollment request.',
  'enrollment.transferred': 'Open Discenda to view your updated class enrollment.',
  'enrollment.dropped': 'Open Discenda to view your class enrollment details.',
  'enrollment.removed': 'Open Discenda to view your class enrollment details.',
  'message.new': 'Open Discenda to read the message.',
};

export function pushConfigured() {
  return env.push.configured;
}

function ensureVapid() {
  if (!env.push.configured) return false;
  const signature = `${env.push.subject}|${env.push.publicKey}|${env.push.privateKey}`;
  if (configuredSignature !== signature) {
    try {
      webpush.setVapidDetails(env.push.subject, env.push.publicKey, env.push.privateKey);
      configuredSignature = signature;
    } catch (err) {
      logger.warn({ err }, 'invalid VAPID Web Push configuration');
      return false;
    }
  }
  return true;
}

export function buildPushPayload(notification = {}) {
  const rawBody = notification.body ? String(notification.body).trim().slice(0, 500) : '';
  const body = rawBody || EMPTY_BODY_FALLBACKS[notification.type] || 'Open Discenda to view details.';
  const suppliedTitle = String(notification.title ?? '').trim().slice(0, 200);
  const specificTitle = GENERIC_PUSH_TITLES.has(suppliedTitle.toLowerCase()) ? '' : suppliedTitle;
  // If an upstream event omitted its title (or supplied only the app name), use the event detail.
  // This keeps useful information visible on notification surfaces that collapse the body.
  const bodyTitle = body.length > 200 ? `${body.slice(0, 199).trimEnd()}…` : body;
  const title = specificTitle || bodyTitle || 'New notification';
  const tag = notification.tag
    ? String(notification.tag).slice(0, 80)
    : `${notification.type ?? 'discenda'}-${notification.id ?? randomUUID().slice(0, 8)}`;

  return JSON.stringify({
    title,
    body,
    link: notification.link ?? '/notifications',
    type: notification.type ?? 'discenda-notification',
    tag,
    timestamp: Date.now(),
  });
}

/**
 * Send a Web Push message to all active subscriptions of `userIds`.
 * Automatically removes expired/unsubscribed endpoints (HTTP 404 / 410).
 */
export async function sendPushToUsers(userIds, notification, { sender = defaultSender } = {}) {
  if (!ensureVapid() || !userIds?.length) return { sent: 0, removed: 0 };
  const subs = await prisma.pushSubscription.findMany({
    where: {
      userId: { in: userIds },
      user: { status: 'ACTIVE', anonymizedAt: null },
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return { sent: 0, removed: 0 };

  const payload = buildPushPayload(notification);
  const urgency = HIGH_URGENCY_TYPES.has(notification?.type) ? 'high' : 'normal';

  let sent = 0;
  const staleIds = [];
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await sender(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 24 * 60 * 60, urgency },
        );
        sent += 1;
      } catch (err) {
        const status = err?.statusCode ?? err?.status;
        if (status === 404 || status === 410) {
          staleIds.push(sub.id);
        } else {
          logger.warn({ err: err?.message, status, body: err?.body, subId: sub.id }, 'web push delivery failed');
        }
      }
    }),
  );

  if (staleIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } });
  }
  return { sent, removed: staleIds.length };
}
