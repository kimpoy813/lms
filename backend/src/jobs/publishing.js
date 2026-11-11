// Publishes scheduled content on time and sends deadline reminders.
//
// Students already see a scheduled item as soon as its time passes (visibility is evaluated at
// read time); this job flips the stored status and sends the "new …" notifications exactly once.
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { classLabel } from '../modules/classes/access.js';
import { notifyAnnouncement } from '../modules/announcements/routes.js';
import { enrolledStudentIds, notify } from '../services/notifications.js';
import { registerJob } from '../services/scheduler.js';

const classInclude = { class: { include: { course: { select: { code: true, title: true } }, section: { select: { name: true } } } } };

/** Claim due rows one by one so that concurrent instances never announce the same item twice. */
async function claimDue(model, now, extraWhere = {}) {
  const due = await prisma[model].findMany({ where: { status: 'SCHEDULED', publishAt: { lte: now }, deletedAt: null, ...extraWhere }, select: { id: true }, take: 200 });
  const claimed = [];
  for (const { id } of due) {
    const result = await prisma[model].updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'PUBLISHED', publishedAt: now, publishAt: null } });
    if (result.count === 1) claimed.push(id);
  }
  return claimed;
}

export async function publishScheduled(now = new Date()) {
  const counts = { modules: 0, assignments: 0, quizzes: 0, announcements: 0 };

  for (const id of await claimDue('learningModule', now)) {
    const m = await prisma.learningModule.findUnique({ where: { id }, include: classInclude });
    await notify(await enrolledStudentIds(m.classId), { type: 'module.published', title: `New module in ${classLabel(m.class)}: ${m.title}`, link: `/classes/${m.classId}/modules/${m.id}`, classId: m.classId });
    counts.modules += 1;
  }
  for (const id of await claimDue('assignment', now)) {
    const a = await prisma.assignment.findUnique({ where: { id }, include: classInclude });
    await notify(await enrolledStudentIds(a.classId), {
      type: 'assignment.published', title: `New assignment in ${classLabel(a.class)}: ${a.title}`,
      body: a.dueAt ? `Due ${a.dueAt.toISOString()}` : undefined, link: `/classes/${a.classId}/assignments/${a.id}`, classId: a.classId,
    });
    counts.assignments += 1;
  }
  for (const id of await claimDue('quiz', now)) {
    const q = await prisma.quiz.findUnique({ where: { id }, include: classInclude });
    await notify(await enrolledStudentIds(q.classId), {
      type: 'quiz.published', title: `New ${q.kind.toLowerCase()} in ${classLabel(q.class)}: ${q.title}`, link: `/classes/${q.classId}/quizzes/${q.id}`, classId: q.classId,
    });
    counts.quizzes += 1;
  }
  for (const id of await claimDue('announcement', now)) {
    await notifyAnnouncement(await prisma.announcement.findUnique({ where: { id } }));
    counts.announcements += 1;
  }
  return counts;
}

const DAY = 24 * 60 * 60 * 1000;

/** One reminder per assignment / quiz, about a day before it is due, to students who still owe it. */
export async function sendDeadlineReminders(now = new Date()) {
  const soon = new Date(now.getTime() + DAY);
  let sent = 0;

  const assignments = await prisma.assignment.findMany({
    where: { status: 'PUBLISHED', deletedAt: null, reminderSentAt: null, dueAt: { gt: now, lte: soon }, class: { status: 'ACTIVE' } },
    include: classInclude,
    take: 200,
  });
  for (const a of assignments) {
    const claimed = await prisma.assignment.updateMany({ where: { id: a.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claimed.count === 0) continue;
    const done = await prisma.assignmentSubmission.findMany({ where: { assignmentId: a.id, status: { not: 'DRAFT' } }, select: { studentId: true } });
    const doneIds = new Set(done.map((d) => d.studentId));
    const pending = (await enrolledStudentIds(a.classId)).filter((id) => !doneIds.has(id));
    await notify(pending, { type: 'assignment.due_soon', title: `Due soon: ${a.title}`, body: `${classLabel(a.class)} — due within 24 hours.`, link: `/classes/${a.classId}/assignments/${a.id}`, classId: a.classId });
    sent += pending.length;
  }

  const quizzes = await prisma.quiz.findMany({
    where: { status: 'PUBLISHED', deletedAt: null, reminderSentAt: null, availableUntil: { gt: now, lte: soon }, class: { status: 'ACTIVE' } },
    include: classInclude,
    take: 200,
  });
  for (const q of quizzes) {
    const claimed = await prisma.quiz.updateMany({ where: { id: q.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claimed.count === 0) continue;
    const attempted = await prisma.quizAttempt.findMany({ where: { quizId: q.id }, select: { studentId: true } });
    const attemptedIds = new Set(attempted.map((d) => d.studentId));
    const pending = (await enrolledStudentIds(q.classId)).filter((id) => !attemptedIds.has(id));
    await notify(pending, { type: 'quiz.closing_soon', title: `Closing soon: ${q.title}`, body: `${classLabel(q.class)} — closes within 24 hours.`, link: `/classes/${q.classId}/quizzes/${q.id}`, classId: q.classId });
    sent += pending.length;
  }
  return sent;
}

registerJob('publishing', 60_000, async () => {
  const counts = await publishScheduled();
  const reminders = await sendDeadlineReminders();
  const published = Object.values(counts).reduce((a, b) => a + b, 0);
  if (published > 0 || reminders > 0) logger.info({ ...counts, reminders }, 'published scheduled content / sent reminders');
});
