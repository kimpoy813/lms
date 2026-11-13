// Housekeeping: expired sessions and tokens, abandoned uploads, location-data retention, and what
// the code runner left on the Vercel account.
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { removeCodeRunnerLeftovers } from '../services/codeRunner.js';
import { registerJob } from '../services/scheduler.js';
import { getSetting } from '../services/settings.js';
import { purgeOrphanFiles } from '../services/storage.js';

const DAY = 24 * 60 * 60 * 1000;

export async function purgeExpiredAuthData(now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [sessions, tokens] = await Promise.all([
    // Keep revoked/expired sessions for a week for incident review, then delete them.
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: weekAgo } }, { revokedAt: { lt: weekAgo } }] } }),
    prisma.authToken.deleteMany({ where: { OR: [{ expiresAt: { lt: weekAgo } }, { usedAt: { lt: weekAgo } }] } }),
  ]);
  return { sessions: sessions.count, tokens: tokens.count };
}

/**
 * Data retention for location verification (RA 10173 — keep personal data no longer than needed).
 * After the configured period the distance / accuracy values are erased and the individual
 * check-in attempts are deleted. The attendance status itself is an academic record and stays.
 */
export async function applyLocationRetention(now = new Date()) {
  const days = await getSetting('attendance.locationRetentionDays');
  const cutoff = new Date(now.getTime() - days * DAY);
  const [records, attempts] = await Promise.all([
    prisma.attendanceRecord.updateMany({
      where: { createdAt: { lt: cutoff }, OR: [{ distanceMeters: { not: null } }, { reportedAccuracyMeters: { not: null } }] },
      data: { distanceMeters: null, reportedAccuracyMeters: null },
    }),
    prisma.attendanceAttempt.deleteMany({ where: { attemptedAt: { lt: cutoff } } }),
  ]);
  return { recordsScrubbed: records.count, attemptsDeleted: attempts.count };
}

export async function purgeOldNotifications(now = new Date()) {
  const result = await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 180 * DAY) } } });
  return { notifications: result.count };
}

registerJob('maintenance', 60 * 60 * 1000, async () => {
  const auth = await purgeExpiredAuthData();
  const files = await purgeOrphanFiles();
  const location = await applyLocationRetention();
  const notifications = await purgeOldNotifications();
  logger.debug({ auth, files, location, notifications }, 'maintenance job finished');
});

// Once a day; does nothing unless programs are checked in Vercel Sandbox machines.
registerJob('codeRunner.leftovers', DAY, async () => {
  const left = await removeCodeRunnerLeftovers();
  if (left?.removed) logger.info(left, 'removed machines of the code runner that had been left on the Vercel account');
});
