// Shared AI permission, configuration and daily-quota checks for authored AI requests and
// private rubric-grading suggestions. Usage is charged to the teacher who owns the assignment.
import { prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';
import { dateKey, startOfDay } from '../lib/time.js';
import { assertPermission } from '../middleware/auth.js';
import { aiStatus } from './ai.js';
import { getSetting, getTimeZone } from './settings.js';

export async function aiQuota(userId) {
  const limit = await getSetting('ai.dailyRequestLimit');
  const tz = await getTimeZone();
  const used = await prisma.aIGenerationUsage.count({ where: { userId, createdAt: { gte: startOfDay(dateKey(new Date(), tz), tz) } } });
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** Check teacher permission, provider availability, and the daily request limit before a model call. */
export async function guardAiUse(user, { allowBuiltin = true } = {}) {
  await assertPermission(user, 'ai.use');
  const status = await aiStatus();
  if (!status.configured) throw new AppError(503, 'AI_UNAVAILABLE', status.message);
  if (!allowBuiltin && status.provider === 'builtin') {
    throw new AppError(503, 'AI_UNAVAILABLE', 'Rubric-based grading suggestions require an external AI service. The built-in assistant does not evaluate student submissions.');
  }
  const quota = await aiQuota(user.id);
  if (quota.limit === 0) throw new AppError(503, 'AI_UNAVAILABLE', 'AI assistance has been turned off by the administrator.');
  if (quota.remaining <= 0) throw new AppError(429, 'AI_QUOTA_EXCEEDED', `You have used all ${quota.limit} AI requests for today. The limit resets at midnight.`);
  return status;
}

export function recordAiUsage(userId, requestType, out, requestId = null) {
  return prisma.aIGenerationUsage.create({
    data: {
      userId,
      requestId,
      requestType,
      usageAmount: 1,
      promptTokens: out.promptTokens,
      completionTokens: out.completionTokens,
      estimatedCost: out.estimatedCost,
      modelIdentifier: out.model,
    },
  });
}
