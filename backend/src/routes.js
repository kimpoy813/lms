// Mounts every feature router under /api.
import { Router } from 'express';
import { env } from './config/env.js';
import { ok } from './lib/http.js';
import { requireAuth } from './middleware/auth.js';
import { clearDevOutbox, devOutbox } from './services/mail.js';
import { adminSystemRouter } from './modules/admin/system.js';
import { adminUsersRouter } from './modules/admin/users.js';
import { catalogRouter } from './modules/admin/catalog.js';
import { announcementsRouter } from './modules/announcements/routes.js';
import { assignmentsRouter, classAssignmentsRouter } from './modules/assignments/routes.js';
import { rubricsRouter } from './modules/assignments/rubrics.js';
import { attendanceRouter, classAttendanceRouter } from './modules/attendance/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { CONTENT_PREFIXES, classContentRouter, contentRouter } from './modules/content/routes.js';
import { classPeopleRouter, enrollmentsRouter } from './modules/enrollments/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { classGradebookRouter, gradesRouter } from './modules/gradebook/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { banksRouter } from './modules/quizzes/banks.js';
import { attemptsRouter, classQuizzesRouter, quizzesRouter } from './modules/quizzes/routes.js';

// Background jobs register themselves when imported.
import './jobs/maintenance.js';
import './jobs/attendance.js';
import './jobs/publishing.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/enrollments', enrollmentsRouter);
apiRouter.use('/classes/:classId/people', classPeopleRouter);
apiRouter.use('/classes/:classId/attendance', classAttendanceRouter);
apiRouter.use('/classes/:classId/gradebook', classGradebookRouter);
apiRouter.use('/classes/:classId/assignments', classAssignmentsRouter);
apiRouter.use('/classes/:classId/quizzes', classQuizzesRouter);
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
apiRouter.use(CONTENT_PREFIXES, requireAuth);
apiRouter.use('/', contentRouter);
apiRouter.use('/admin/users', requireAuth, adminUsersRouter);
apiRouter.use('/admin', requireAuth, adminSystemRouter);

// Development conveniences. This router does not exist when NODE_ENV=production.
if (!env.isProduction) {
  const dev = Router();
  // E-mails captured because SMTP is not configured (verification / reset links for local testing).
  dev.get('/mailbox', (req, res) => ok(res, devOutbox()));
  dev.delete('/mailbox', (req, res) => {
    clearDevOutbox();
    res.status(204).end();
  });
  apiRouter.use('/dev', dev);
}
