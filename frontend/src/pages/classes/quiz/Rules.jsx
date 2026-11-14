// The strict rules of a quiz, in words: what students are shown before they start and while they
// answer, and how a teacher's choice reads. What follows from a violation is decided by the
// server (backend/src/modules/quizzes/rules.js); the sentences here say the same things.
import { Ban, Check, ShieldAlert } from 'lucide-react';
import { cn } from '../../../components/ui.jsx';
import { plural } from '../../../lib/format.js';

/** Each kind of violation as the rest of a sentence that starts with "You …" or a name. */
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

/** How long the file chooser of a "file upload" question may stay open, in minutes (lib/quizGuard.js). */
export const FILE_CHOOSER_MINUTES = 3;

/** For the teacher: what the setting amounts to, in a few words. */
export const rulesSummary = (quiz) => (!quiz.strictMode ? 'Off' : quiz.violationWarnings > 0 ? `On · ${plural(quiz.violationWarnings, 'warning')}, then the attempt ends` : 'On · the first violation ends the attempt');

/** For the student: what a violation leads to. `used` = warnings already given in this attempt. */
export const consequenceText = (warnings, used = 0) => {
  const left = Math.max(0, warnings - used);
  if (warnings === 0) return 'The first violation ends your attempt at once.';
  if (left === 0) return 'You have no warnings left: the next violation ends your attempt at once.';
  return `${used > 0 ? `You have ${plural(left, 'warning')} left` : `You get ${plural(left, 'warning')}`}. The violation after ${left === 1 ? 'it' : 'them'} ends your attempt.`;
};

const VIOLATIONS = [
  ['Leaving the page', 'switching to another tab, window or app, minimising the browser, or letting the screen lock.'],
  ['Clicking outside the page', 'another window, the address bar, a pop-up or a notification.'],
  ['Closing or reloading the page', 'or opening it a second time, in another tab or on another device.'],
  ['Copying and pasting', 'copying the text of the questions, or pasting text that you did not write in your answers.'],
  ['Screenshots and printing', 'pressing a screenshot key or sending the page to the printer.'],
];
const ADVICE = [
  'Close your other tabs and apps, and switch on Do Not Disturb. A call or a pop-up that takes over the screen counts as leaving.',
  'Charge your device and keep the screen on.',
  'Finish with Submit. Do not go back, reload the page or, on a phone, pull it down to refresh: where the browser does not let the page stop that, it counts as leaving.',
  'You may move between questions, and cut, copy and paste within your own answers.',
  'If something outside your control interrupts you, such as a power cut, tell your teacher. They can reopen your attempt.',
];

/** The rules as a student reads them before starting. `noun` is "quiz" or "examination". */
export function RulesForStudents({ warnings, noun = 'quiz', className }) {
  return (
    <div className={cn('space-y-4 text-sm text-soft', className)}>
      <p>From the moment you start until you submit, stay on the page of the {noun}. Each of these is a violation:</p>
      <ul className="space-y-2">
        {VIOLATIONS.map(([title, text]) => (
          <li key={title} className="flex gap-2.5"><Ban className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" /><span><strong className="font-semibold text-ink">{title}:</strong> {text}</span></li>
        ))}
      </ul>
      <p className="flex gap-2.5 rounded-xl border border-bad/30 bg-bad-soft p-3 text-ink">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden="true" />
        <span><strong className="font-semibold">{consequenceText(warnings)}</strong> An attempt that is ended is marked as failed with 0 points, and only your teacher can reopen it.</span>
      </p>
      <div>
        <p className="mb-2 font-semibold text-ink">Before you start</p>
        <ul className="space-y-1.5">
          {ADVICE.map((text) => <li key={text} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" /><span>{text}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
