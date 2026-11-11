// Closes self-check-in attendance sessions when their window ends and marks the students who
// did not check in as absent. Sessions that are marked by hand are left for the teacher to close.
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { closeSession } from '../modules/attendance/service.js';
import { registerJob } from '../services/scheduler.js';

export async function autoCloseAttendance(now = new Date()) {
  const due = await prisma.attendanceSession.findMany({
    where: { status: 'OPEN', endTime: { lt: now }, OR: [{ allowCode: true }, { allowQr: true }] },
    select: { id: true },
    take: 200,
  });
  let closed = 0;
  for (const s of due) {
    if (await closeSession(s.id, { user: null }, { automatic: true })) closed += 1;
  }
  if (closed > 0) logger.info(`closed ${closed} attendance session(s) whose check-in window ended`);
  return closed;
}

registerJob('attendance.autoClose', 60_000, autoCloseAttendance);
