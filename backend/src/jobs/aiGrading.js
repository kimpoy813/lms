// Recover private rubric-suggestion work that was left pending by an interrupted request. Every
// submission is claimed with a conditional update in the service, so more than one server instance
// can run this job without grading the same attempt concurrently.
import { prisma } from '../db/prisma.js';
import { generateAiRubricSuggestion } from '../services/aiRubricGrading.js';
import { registerJob } from '../services/scheduler.js';

const STALE_AFTER_MS = 10 * 60 * 1000;
const BATCH_SIZE = 5;

export async function recoverPendingAiRubricSuggestions(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const stuck = await prisma.assignmentSubmission.findMany({
    where: {
      aiGradingStatus: 'RUNNING',
      aiGradingStartedAt: { lt: staleBefore },
      status: { in: ['SUBMITTED', 'GRADED', 'RETURNED'] },
    },
    select: { id: true, attemptNumber: true, aiGradingStartedAt: true },
    take: BATCH_SIZE,
  });
  for (const submission of stuck) {
    await prisma.assignmentSubmission.updateMany({
      where: {
        id: submission.id,
        attemptNumber: submission.attemptNumber,
        aiGradingStatus: 'RUNNING',
        aiGradingStartedAt: submission.aiGradingStartedAt,
      },
      data: { aiGradingStatus: 'PENDING', aiGradingStartedAt: null },
    });
  }

  const pending = await prisma.assignmentSubmission.findMany({
    where: { aiGradingStatus: 'PENDING', status: { in: ['SUBMITTED', 'GRADED', 'RETURNED'] } },
    select: { id: true, attemptNumber: true },
    orderBy: { submittedAt: 'asc' },
    take: BATCH_SIZE,
  });
  for (const submission of pending) await generateAiRubricSuggestion(submission.id, submission.attemptNumber);
  return { recovered: stuck.length, processed: pending.length };
}

registerJob('ai.rubricGrading', 60_000, recoverPendingAiRubricSuggestions);
