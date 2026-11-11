// Publication rules shared by modules, assignments, quizzes and announcements.
//
// A record is visible to students when it is PUBLISHED, or when it is SCHEDULED and its
// publishAt instant has passed. Evaluating the schedule at read time means a scheduled item
// becomes visible on time even if the background job that flips its status is late.

/** In-memory check for a loaded record. */
export function isPublished(record, now = new Date()) {
  if (!record) return false;
  if (record.status === 'PUBLISHED') return true;
  return record.status === 'SCHEDULED' && record.publishAt instanceof Date && record.publishAt <= now;
}

/** Prisma `where` fragment selecting records students may see. */
export function publishedWhere(now = new Date()) {
  return {
    OR: [{ status: 'PUBLISHED' }, { status: 'SCHEDULED', publishAt: { lte: now } }],
  };
}

/**
 * Normalise the publication fields of a create/update payload.
 *   status DRAFT                      → draft
 *   status PUBLISHED                  → published now
 *   status SCHEDULED + future publishAt → scheduled
 *   status SCHEDULED + past publishAt   → published now
 */
export function resolvePublication({ status, publishAt }, existing, now = new Date()) {
  if (status === undefined) return {};
  if (status === 'PUBLISHED') {
    return { status: 'PUBLISHED', publishAt: null, publishedAt: existing?.publishedAt ?? now };
  }
  if (status === 'SCHEDULED') {
    if (!publishAt) return { error: 'Choose when this should be published.' };
    if (publishAt <= now) return { status: 'PUBLISHED', publishAt: null, publishedAt: existing?.publishedAt ?? now };
    return { status: 'SCHEDULED', publishAt, publishedAt: null };
  }
  if (status === 'ARCHIVED') return { status: 'ARCHIVED', publishAt: null };
  return { status: 'DRAFT', publishAt: null, publishedAt: null };
}

/**
 * May students see their quiz score now?
 *   IMMEDIATE   → as soon as the attempt is scored
 *   AFTER_CLOSE → once the quiz's availability window has ended
 *   MANUAL      → after the teacher's "publish results" action
 *   NEVER       → only through a published grading period
 */
export function quizResultsVisible(quiz, now = new Date()) {
  if (!quiz) return false;
  if (quiz.resultVisibility === 'IMMEDIATE') return true;
  if (quiz.resultVisibility === 'AFTER_CLOSE') return Boolean(quiz.availableUntil) && quiz.availableUntil <= now;
  if (quiz.resultVisibility === 'MANUAL') return Boolean(quiz.resultsPublishedAt);
  return false;
}
