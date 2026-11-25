// In-app notifications (stored, pushed over Socket.IO) with optional e-mail copies.
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { runInBackground } from '../lib/background.js';
import { logger } from '../lib/logger.js';
import { emitToUser } from './realtime.js';
import { getSetting } from './settings.js';
import { mailConfigured, sendMail } from './mail.js';
import { pushConfigured, sendPushToUsers } from './push.js';

/**
 * Notify users.
 * @param {string[]} userIds
 * @param {{ type: string, title: string, body?: string, link?: string, classId?: string }} notification
 * @param {{ tx?: object, excludeUserId?: string }} [options] pass `tx` to create the rows inside a
 *        transaction (the real-time push then happens after the insert, best effort).
 */
export async function notify(userIds, notification, options = {}) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== options.excludeUserId);
  if (ids.length === 0) return;
  const db = options.tx ?? prisma;
  // Normalize the visible content once so the notification centre, real-time event, e-mail,
  // and Web Push all start from the same title, body, and destination.
  const visible = {
    type: notification.type,
    title: String(notification.title).trim().slice(0, 200),
    body: notification.body ? String(notification.body).trim().slice(0, 500) : null,
    link: notification.link ?? null,
    classId: notification.classId ?? null,
  };
  const data = ids.map((userId) => ({ userId, ...visible }));
  try {
    await db.notification.createMany({ data });
  } catch (err) {
    if (options.tx) throw err;
    logger.error({ err, type: notification.type }, 'failed to store notifications');
    return;
  }
  for (const userId of ids) {
    emitToUser(userId, 'notification:new', visible);
  }
  // E-mail copies and Web Push alerts are optional and never block or fail the calling request.
  // Inside a transaction they wait a tick, so that the rows are usually committed by the time
  // deliveries run.
  if (mailConfigured() || pushConfigured()) {
    runInBackground(async () => {
      if (options.tx) await new Promise((resolve) => setImmediate(resolve));
      await Promise.all([
        mailConfigured() ? sendEmailCopies(ids, visible) : Promise.resolve(),
        pushConfigured() ? sendPushToUsers(ids, visible) : Promise.resolve(),
      ]);
    }, 'delivering notification copies');
  }
}

async function sendEmailCopies(userIds, notification) {
  if (!(await getSetting('email.notificationsEnabled'))) return;
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, emailNotifications: true, status: 'ACTIVE', anonymizedAt: null },
    select: { id: true, email: true },
  });
  for (const user of users) {
    await sendMail({
      to: user.email,
      subject: notification.title,
      text: notification.body ?? notification.title,
      title: notification.title,
      paragraphs: notification.body ? [notification.body] : [],
      action: notification.link ? { label: 'Open in Discenda', url: `${env.appUrl}${notification.link}` } : undefined,
    });
  }
  if (users.length > 0) {
    await prisma.notification.updateMany({
      where: { userId: { in: users.map((u) => u.id) }, type: notification.type, emailedAt: null, link: notification.link ?? null },
      data: { emailedAt: new Date() },
    });
  }
}

/** Ids of students currently enrolled in a class. */
export async function enrolledStudentIds(classId, db = prisma) {
  const rows = await db.enrollment.findMany({
    where: { classId, status: 'ENROLLED' },
    select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}

/** Ids of students in a class, optionally including dropped students kept on the roster. */
export async function classStudentIds(classId, { includeDropped = false, db = prisma } = {}) {
  const rows = await db.enrollment.findMany({
    where: { classId, status: { in: includeDropped ? ['ENROLLED', 'DROPPED'] : ['ENROLLED'] } },
    select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}
