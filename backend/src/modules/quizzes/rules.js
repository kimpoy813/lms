// The strict rules of a quiz (pure): what counts as a violation, what one leads to, and how the
// clock is set when a teacher reopens an attempt. See docs/QUIZ-RULES.md.

/**
 * What the student's browser can report.
 *   LEFT_PAGE    the quiz page was hidden: another tab or app in front, the window minimised, the screen locked
 *   LOST_FOCUS   the page stayed on screen but something else became the active window
 *   CLOSED_PAGE  the page was closed, reloaded or left for another address
 *   COPY         text of the quiz was copied or cut
 *   PASTE        text that was not written in this quiz was pasted in
 *   SCREENSHOT   a key that takes a picture of the screen was pressed
 *   PRINT        the page was sent to the printer (which also saves it as a PDF)
 */
export const VIOLATION_KINDS = ['LEFT_PAGE', 'LOST_FOCUS', 'CLOSED_PAGE', 'COPY', 'PASTE', 'SCREENSHOT', 'PRINT'];

/** Each kind as the rest of a sentence that starts with the student ("Ana …", "You …"). */
export const VIOLATION_TEXT = {
  LEFT_PAGE: 'switched to another tab or app',
  LOST_FOCUS: 'clicked outside the quiz window',
  CLOSED_PAGE: 'closed, reloaded or left the quiz page',
  COPY: 'copied text from the quiz',
  PASTE: 'pasted text that was not written in the quiz',
  SCREENSHOT: 'pressed a screenshot key',
  PRINT: 'tried to print the quiz',
};
export const violationText = (kind) => VIOLATION_TEXT[kind] ?? 'broke a rule of the quiz';

/** The kinds that mean the student is no longer on the page. */
export const LEAVING_KINDS = ['LEFT_PAGE', 'LOST_FOCUS', 'CLOSED_PAGE'];

/**
 * The quiz page says it has opened an attempt. The first opening after the start (or after a
 * reopening) is expected. A later one means the page was closed or reloaded in between: that is
 * a violation of its own unless leaving was already counted and the student has not been seen
 * back since — one act is not counted twice. This is what catches a page that could not report
 * its own closing: a browser that was killed, a device that lost power, a private window closed
 * while offline.
 * @returns {'FIRST' | 'AFTER_LEAVING' | 'UNREPORTED'}
 */
export function pageOpening(attempt) {
  if (!attempt.pageOpenedAt) return 'FIRST';
  return attempt.awaySince ? 'AFTER_LEAVING' : 'UNREPORTED';
}

/** The most warnings a teacher can allow before an attempt is ended. */
export const MAX_WARNINGS = 5;

/**
 * Do the strict rules bind this attempt? Only when the quiz has them switched on now and the
 * student started under them — an attempt begun before the rules existed, or before the teacher
 * switched them on, was never shown them.
 */
export const rulesApply = (quiz, attempt) => Boolean(quiz?.strictMode && attempt?.rulesAcceptedAt);

/**
 * What one more violation leads to.
 * @returns {{ number: number, allowed: number, terminate: boolean, warningsLeft: number }}
 *   `number` counts from the start or the last reopening; `allowed` is how many only draw a warning.
 */
export function violationOutcome(quiz, attempt) {
  const number = (attempt.violationCount ?? 0) + 1;
  const allowed = Math.max(0, Math.min(MAX_WARNINGS, quiz.violationWarnings ?? 0));
  return { number, allowed, terminate: number > allowed, warningsLeft: Math.max(0, allowed - number) };
}

/** Seconds that were left on the clock when an attempt was ended; null when it had no clock. */
export function secondsLeftWhenEnded(attempt) {
  if (!attempt.deadlineAt || !attempt.terminatedAt) return null;
  return Math.max(0, Math.round((attempt.deadlineAt.getTime() - attempt.terminatedAt.getTime()) / 1000));
}

/** A reopened attempt always leaves the student at least this long to finish. */
export const MIN_RESUME_SECONDS = 60;

/**
 * The clock of a reopened attempt.
 *
 *   minutes     how long the student gets, counted from the moment they continue — not from the
 *               moment the teacher presses the button, who may do so hours later.
 *               Empty: a timed quiz gives back the time that was left; an untimed one has no timer.
 *   continueBy  until when the student may continue. Until they do, this is the attempt's deadline:
 *               when it passes, the attempt is handed in with the answers it has. With no timer it
 *               stays the deadline. Empty: the quiz's closing time; a quiz that never closes sets none.
 *
 * @returns {{ resumeSeconds: number|null, deadlineAt: Date|null } | { errors: Record<string, string> }}
 */
export function reopenClock(quiz, attempt, { minutes = null, continueBy = null } = {}, now = new Date()) {
  const errors = {};
  const left = secondsLeftWhenEnded(attempt);
  let resumeSeconds = null;
  if (minutes !== null && minutes !== undefined) resumeSeconds = Math.round(minutes * 60);
  else if (quiz.timeLimitMinutes) resumeSeconds = Math.max(MIN_RESUME_SECONDS, left ?? quiz.timeLimitMinutes * 60);

  let deadlineAt = continueBy ?? null;
  if (deadlineAt && deadlineAt.getTime() <= now.getTime()) errors.continueBy = 'Choose a time that has not passed yet.';
  if (!deadlineAt) {
    if (quiz.availableUntil && quiz.availableUntil.getTime() > now.getTime()) deadlineAt = quiz.availableUntil;
    else if (quiz.availableUntil) errors.continueBy = 'This quiz has closed. Say until when the student may continue.';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { resumeSeconds, deadlineAt };
}

/** "12 minutes", "1 hour 5 minutes", "45 seconds" — for messages to people. */
export function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}
