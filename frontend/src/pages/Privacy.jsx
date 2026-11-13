// The privacy notice shown before registration and from every sign-in screen.
// It describes what this software does with personal data. A school deploying it should
// review the text with its data protection officer and add its own contact details.
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Logo } from '../layout/AppShell.jsx';

const SECTIONS = [
  ['What we collect', [
    'Account details: your name, e-mail address, role, and student or employee number.',
    'Academic records: the classes you belong to, lessons you completed, work you submitted, quiz answers, scores, grades and feedback.',
    'Attendance records: the date, time and status of each class meeting, and how you checked in.',
    'Messages, discussion posts and files you upload.',
    'Security information: when you signed in, from which browser and IP address, and a log of sensitive actions such as grade changes.',
  ]],
  ['Location checks for attendance', [
    'A teacher may require a location check when you record your attendance. Your browser asks for your permission each time.',
    'Your position is sent once and compared with the classroom on the server. Only the result is stored: the distance in metres and the accuracy your device reported.',
    'Your coordinates are not stored, you are not tracked, and no location is read at any other time.',
    'If you refuse or your device cannot determine its location, your teacher can still mark you manually.',
  ]],
  ['Why we use it', [
    'To run classes: delivering lessons, collecting and grading work, recording attendance and computing grades.',
    'To keep accounts secure and to investigate misuse.',
    'To give teachers and administrators the reports their work requires.',
    'Your data is not sold and is not used for advertising.',
  ]],
  ['Who can see it', [
    'You see your own records. Classmates see your name and picture, and only if your teacher shows the class list.',
    'Your teachers see your work, scores and attendance in their own classes only.',
    'School administrators can see records as needed to manage accounts and classes; what they do is logged.',
    'If a teacher uses the AI drafting tool, the text they provide (for example a topic, a reference document, or the lessons of a module they choose) is sent to the AI service the school configured. Student records are never sent to it.',
    'When you try out a Python program, it usually runs on your own device, inside your browser, and is sent nowhere. When a program is checked for a score, or cannot be run in the browser, the program and the test inputs are sent to a separate computer that exists only for that run, at the service the school uses for it. Your name and your other records are not sent with it. That computer has no access to the internet and is deleted afterwards.',
  ]],
  ['How long we keep it', [
    'Academic records are kept for as long as the school is required to keep them. Classes are archived, not deleted, at the end of a term.',
    'Sign-in sessions and security logs are removed on a schedule set by the school.',
    'When an account is anonymised, the name and contact details are removed while grades that the school must retain are kept without them.',
  ]],
  ['Your rights', [
    'Under the Data Privacy Act of 2012 (Republic Act No. 10173) you have the right to be informed, to access and correct your data, to object, and to complain to the National Privacy Commission.',
    'To exercise these rights, contact your school’s registrar or data protection officer.',
  ]],
];

export default function Privacy() {
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
          <Logo />
          <button type="button" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/login'))} className="inline-flex items-center gap-1.5 text-sm font-medium text-soft hover:text-brand"><ArrowLeft className="size-4" aria-hidden="true" />Back</button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Privacy notice</h1>
        <p className="mt-2 text-soft">How EduSphere handles personal data on behalf of your school.</p>
        <div className="mt-8 space-y-8">
          {SECTIONS.map(([heading, items]) => (
            <section key={heading}>
              <h2 className="text-lg font-semibold text-ink">{heading}</h2>
              <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-soft">
                {items.map((item) => <li key={item} className="flex gap-3"><span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" aria-hidden="true" />{item}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-10 rounded-xl border border-line bg-surface p-4 text-sm text-faint">Your school is the personal information controller for the records in this system. This notice describes how the software works; your school may publish additional policies.</p>
      </main>
    </div>
  );
}
