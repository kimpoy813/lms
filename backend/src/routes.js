// Mounts every feature router under /api.
import { Router } from 'express';
import { env } from './config/env.js';
import { ok } from './lib/http.js';
import { requireAuth } from './middleware/auth.js';
import { clearDevOutbox, devOutbox } from './services/mail.js';
import { adminSystemRouter } from './modules/admin/system.js';
import { adminUsersRouter } from './modules/admin/users.js';
import { catalogRouter } from './modules/admin/catalog.js';
import { authRouter } from './modules/auth/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { classPeopleRouter, enrollmentsRouter } from './modules/enrollments/routes.js';
import { filesRouter } from './modules/files/routes.js';

// Background jobs register themselves when imported.
import './jobs/maintenance.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/enrollments', enrollmentsRouter);
apiRouter.use('/classes/:classId/people', classPeopleRouter);
apiRouter.use('/classes', classesRouter);
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
