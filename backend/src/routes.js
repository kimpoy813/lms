// Mounts every feature router under /api.
import { Router } from 'express';
import { env } from './config/env.js';
import { notFound, unauthorized } from './lib/errors.js';
import { ok } from './lib/http.js';
import { operatorToken, safeEqual } from './lib/tokens.js';
import { requireAuth } from './middleware/auth.js';
import { checkCodeRunner } from './services/codeRunner.js';
import { clearDevOutbox, devOutbox } from './services/mail.js';
import { runDueJobs } from './services/scheduler.js';
import { adminSystemRouter } from './modules/admin/system.js';
import { adminUsersRouter } from './modules/admin/users.js';
import { catalogRouter } from './modules/admin/catalog.js';
import { aiRouter } from './modules/ai/routes.js';
import { classAnalyticsRouter } from './modules/analytics/routes.js';
import { announcementsRouter } from './modules/announcements/routes.js';
import { assignmentsRouter, classAssignmentsRouter } from './modules/assignments/routes.js';
import { rubricsRouter } from './modules/assignments/rubrics.js';
import { attendanceRouter, classAttendanceRouter } from './modules/attendance/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { calendarRouter, consultationsRouter, tasksRouter } from './modules/calendar/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { CONTENT_PREFIXES, classContentRouter, contentRouter } from './modules/content/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { classDiscussionsRouter, discussionsRouter } from './modules/discussions/routes.js';
import { classPeopleRouter, enrollmentsRouter } from './modules/enrollments/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { classGradebookRouter, gradesRouter } from './modules/gradebook/routes.js';
import { messagesRouter } from './modules/messages/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { programmingRouter } from './modules/programming/routes.js';
import { banksRouter } from './modules/quizzes/banks.js';
import { attemptsRouter, classQuizzesRouter, quizzesRouter } from './modules/quizzes/routes.js';
import { searchRouter } from './modules/search/routes.js';

// Background jobs register themselves when imported.
import './jobs/maintenance.js';
import './jobs/attendance.js';
import './jobs/publishing.js';

export const apiRouter = Router();

// Scheduled call for hosts where no process stays up to run the background jobs on a timer
// (vercel.json asks Vercel to make it once a day). With CRON_SECRET set, the caller must present
// it and every job runs. Without a secret anybody can call this, so it then does no more than any
// other request does: run the jobs that are due.
apiRouter.get('/internal/cron', async (req, res) => {
  const given = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
  const trusted = Boolean(env.cronSecret) && safeEqual(given, env.cronSecret);
  if (env.cronSecret && !trusted) throw unauthorized();
  ok(res, { ran: env.jobsAllowed ? await runDueJobs({ force: trusted }) : [] });
});

// For whoever operates the site, without signing in: is the code runner in working order? Runs a
// small program in every language, exactly as "Check now" does for an administrator (with Vercel
// Sandbox that starts one machine). Opened by a value derived from CRON_SECRET; `npm run smoke`
// uses it and prints the address. Without that secret, or with another value, the address does
// not exist.
export const CODE_RUNNER_CHECK = 'code runner check';
apiRouter.get('/internal/code-runner-check', async (req, res) => {
  const given = typeof req.query.token === 'string' ? req.query.token : '';
  if (!env.cronSecret || !given || !safeEqual(given, operatorToken(env.cronSecret, CODE_RUNNER_CHECK))) throw notFound('Page');
  ok(res, await checkCodeRunner());
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/enrollments', enrollmentsRouter);
apiRouter.use('/classes/:classId/people', classPeopleRouter);
apiRouter.use('/classes/:classId/attendance', classAttendanceRouter);
apiRouter.use('/classes/:classId/gradebook', classGradebookRouter);
apiRouter.use('/classes/:classId/assignments', classAssignmentsRouter);
apiRouter.use('/classes/:classId/quizzes', classQuizzesRouter);
apiRouter.use('/classes/:classId/analytics', classAnalyticsRouter);
apiRouter.use('/classes/:classId/discussions', classDiscussionsRouter);
apiRouter.use('/classes/:classId', classContentRouter);
apiRouter.use('/classes', classesRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/announcements', announcementsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/grades', gradesRouter);
apiRouter.use('/assignments', assignmentsRouter);
apiRouter.use('/rubrics', rubricsRouter);
apiRouter.use('/question-banks', banksRouter);
apiRouter.use('/quizzes', quizzesRouter);
apiRouter.use('/attempts', attemptsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/discussions', discussionsRouter);
apiRouter.use('/calendar', calendarRouter);
apiRouter.use('/consultations', consultationsRouter);
apiRouter.use('/tasks', tasksRouter);
apiRouter.use('/search', searchRouter);
apiRouter.use('/programming', programmingRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use(CONTENT_PREFIXES, requireAuth);
apiRouter.use('/', contentRouter);
apiRouter.use('/admin/users', requireAuth, adminUsersRouter);
apiRouter.use('/admin', requireAuth, adminSystemRouter);

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * True when the request was made on this computer. The captured e-mails hold password-reset links,
 * so a development server that is reachable from elsewhere (a shared network, a tunnel, a cloud
 * workspace preview) must not hand them out. Every proxy hop has to be local as well.
 */
export function isLocalRequest(req) {
  if (!LOOPBACK.test(req.socket?.remoteAddress ?? '')) return false;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return forwarded.every((address) => LOOPBACK.test(address));
}

// Development conveniences. This router does not exist when NODE_ENV=production.
if (!env.isProduction) {
  const dev = Router();
  dev.use((req, res, next) => {
    if (isLocalRequest(req)) return next();
    throw notFound('Page');
  });
  // E-mails captured because SMTP is not configured (verification / reset links for local testing).
  dev.get('/mailbox', (req, res) => ok(res, devOutbox()));
  dev.delete('/mailbox', (req, res) => {
    clearDevOutbox();
    res.status(204).end();
  });
  apiRouter.use('/dev', dev);
}
