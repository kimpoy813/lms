// Which attempt counts when a quiz allows several (pure).
const FINISHED = new Set(['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED']);

/** Attempts that have a complete score: finished and with no answer still waiting for the teacher. */
export const scoredAttempts = (attempts) =>
  attempts.filter((a) => FINISHED.has(a.status) && !a.needsManualGrading && a.totalScore !== null && a.totalScore !== undefined);

/**
 * The score a student receives for a quiz, as a fraction (0–1) of the quiz total.
 * Attempts are compared by percentage because their totals can differ (random pools, edits).
 *
 * @param {Array<{ status: string, needsManualGrading: boolean, totalScore: number|null, maxScore: number, attemptNumber: number }>} attempts
 * @param {'HIGHEST'|'LATEST'|'AVERAGE'} scoring
 * @returns {{ fraction: number, attemptId: string|null, pending: boolean } | null} null when nothing was submitted
 */
export function quizOutcome(attempts, scoring) {
  const finished = attempts.filter((a) => FINISHED.has(a.status));
  if (finished.length === 0) return null;
  const scored = scoredAttempts(finished);
  // An attempt that still needs manual grading could change the result, so the grade waits.
  const pending = finished.length !== scored.length;
  if (scored.length === 0) return { fraction: null, attemptId: null, pending: true };
  const fractionOf = (a) => (a.maxScore > 0 ? Math.max(0, Math.min(1, a.totalScore / a.maxScore)) : 0);
  if (scoring === 'LATEST') {
    const latestFinished = finished.reduce((a, b) => (b.attemptNumber > a.attemptNumber ? b : a));
    if (!scored.includes(latestFinished)) return { fraction: null, attemptId: latestFinished.id ?? null, pending: true };
    return { fraction: fractionOf(latestFinished), attemptId: latestFinished.id ?? null, pending: false };
  }
  if (scoring === 'AVERAGE') {
    if (pending) return { fraction: null, attemptId: null, pending: true };
    return { fraction: scored.reduce((s, a) => s + fractionOf(a), 0) / scored.length, attemptId: null, pending: false };
  }
  const best = scored.reduce((a, b) => (fractionOf(b) > fractionOf(a) ? b : a));
  return { fraction: fractionOf(best), attemptId: best.id ?? null, pending };
}
