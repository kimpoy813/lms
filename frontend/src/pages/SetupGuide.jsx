// The administrator's guide through a new installation.
//
// A fresh EduSphere has one administrator and nothing else. This card on the dashboard lists what
// is needed before the first class can meet, in the order it is needed. The server reads each
// step from the data (dashboard → setup.steps), so a step is ticked when the thing exists — not
// when somebody clicked "done" — and the card goes away by itself once everything is there.
import { ArrowRight, Check, ListChecks, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, cn, ProgressBar } from '../components/ui.jsx';

const HIDDEN_KEY = 'edusphere.setupGuide.hidden';

const readHidden = () => {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false; // storage is blocked: the guide simply stays visible
  }
};
const writeHidden = (hidden) => {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, '1');
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* see readHidden */
  }
};

/** What each step is called, why it matters and where it is done. */
const describe = (key, { registrationOpen }) =>
  ({
    institution: {
      title: 'Name your school',
      text: 'The name is shown on the sign-in page and on exports. Check the time zone too: it decides what “today” means for attendance.',
      to: '/admin/settings', action: 'Open settings',
    },
    profile: {
      title: 'Put your own name on this account',
      text: 'It is still called “System Administrator”, and that is the name teachers and students see.',
      to: '/profile', action: 'Open my profile',
    },
    semester: {
      title: 'Add the school year and its semesters',
      text: 'Every class belongs to a semester. Mark the one that is running now as current.',
      to: '/admin/catalog?tab=terms', action: 'Add a school year',
    },
    courses: {
      title: 'Add the courses that are taught',
      text: 'For example “IT 101 — Introduction to Computing”. Departments, programs and sections are optional and can follow later.',
      to: '/admin/catalog?tab=courses', action: 'Add courses',
    },
    teachers: {
      title: 'Create accounts for the teachers',
      text: 'One at a time, or many at once from a spreadsheet. Each account gets a temporary password for you to hand over.',
      to: '/admin/users', action: 'Open users',
    },
    classes: {
      title: 'Create the first class',
      text: 'A class is one course taught by one teacher in one semester. Teachers can create their own classes too, unless you switch that off under Permissions.',
      to: '/classes', action: 'Open classes',
    },
    students: {
      title: 'Let the students in',
      text: registrationOpen
        ? 'Students can create their own account from the sign-in page and join a class with the code their teacher shows them. You can also create or import their accounts under Users.'
        : 'Self-registration is switched off, so create or import the student accounts under Users. They then join a class with its code, or a teacher adds them.',
      to: '/admin/users', action: 'Open users',
    },
  })[key];

/**
 * `setup` is { steps: [{ key, done }], complete } from the dashboard; `system` tells whether
 * students may register themselves and whether this server can send e-mail.
 */
export default function SetupGuide({ setup, system }) {
  const [hidden, setHidden] = useState(readHidden);
  if (!setup || setup.complete) return null;

  const steps = setup.steps.map((s) => ({ ...s, ...describe(s.key, system) })).filter((s) => s.title);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  const hide = (value) => { writeHidden(value); setHidden(value); };

  if (hidden) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
        <ListChecks className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <span className="text-soft">Setting up: {done} of {steps.length} steps done.</span>
        <button type="button" onClick={() => hide(false)} className="font-medium text-brand hover:underline">Show the guide</button>
      </div>
    );
  }

  return (
    <Card as="section" aria-labelledby="setup-guide-title" className="border-brand/30">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><ListChecks className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id="setup-guide-title" className="text-base font-semibold text-ink">Getting your school started</h2>
            <p className="text-[13px] text-soft">{done} of {steps.length} steps done. Each one is ticked by itself when it is there.</p>
          </div>
        </div>
        <button type="button" onClick={() => hide(true)} className="-m-1 flex shrink-0 items-center gap-1 rounded-md p-1 text-[13px] font-medium text-faint hover:bg-raised hover:text-ink" title="You can bring the guide back from the same place">
          <X className="size-4" aria-hidden="true" />Hide
        </button>
      </div>
      <ProgressBar className="mt-4" value={done} max={steps.length} label="Set-up steps done" />

      <ol className="mt-4 divide-y divide-line">
        {steps.map((step, index) => {
          const current = step === next;
          return (
            <li key={step.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0" aria-current={current ? 'step' : undefined}>
              <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold', step.done ? 'bg-ok-soft text-ok' : current ? 'bg-brand-fill text-white' : 'bg-raised text-faint')}>
                {step.done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
              </span>
              {/* On a phone the button sits under the text, so the text keeps the full width. */}
              <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm font-semibold', step.done ? 'text-soft' : 'text-ink')}>
                    {step.title}
                    {step.done && <span className="sr-only"> — done</span>}
                  </p>
                  {!step.done && <p className="mt-0.5 text-[13px] leading-relaxed text-soft">{step.text}</p>}
                </div>
                {!step.done && <Button to={step.to} size="sm" variant={current ? 'primary' : 'secondary'} className="mt-2 shrink-0 sm:mt-0">{step.action}{current && <ArrowRight className="size-3.5" aria-hidden="true" />}</Button>}
              </div>
            </li>
          );
        })}
      </ol>

      {system.mailAvailable === false && (
        <p className="mt-4 rounded-xl bg-raised px-3.5 py-2.5 text-[13px] leading-relaxed text-soft">
          <span className="font-semibold text-ink">Forgotten passwords.</span> This site does not send e-mail, so nobody can reset a password alone. When someone forgets theirs, open the account under Users and choose “Reset password”: you get a temporary password to give them.
        </p>
      )}
    </Card>
  );
}
