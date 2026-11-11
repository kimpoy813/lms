import { BarChart3, MapPin, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { Logo } from '../../layout/AppShell.jsx';

const POINTS = [
  [MapPin, 'Attendance that proves presence', 'Rotating QR codes and an optional GPS check — without storing anyone’s coordinates.'],
  [BarChart3, 'Grades computed the same way every time', 'Weighted categories, grading periods and transmutation, calculated on the server.'],
  [Sparkles, 'AI drafts, teacher decides', 'Generate a lesson or quiz draft, then review and publish it yourself.'],
  [ShieldCheck, 'Private by default', 'Students only ever see their own records. Every sensitive change is logged.'],
];

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden bg-[#312e81] p-12 text-white lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:justify-between" aria-hidden="true">
        <div className="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-[#6366f1]/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 size-[28rem] rounded-full bg-[#0ea5e9]/25 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10 rounded-xl ring-1 ring-white/20" />
          <span className="text-xl font-bold tracking-tight">EduSphere</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-[2rem] font-bold leading-tight tracking-tight text-balance">One place for classes, attendance and grades.</h2>
          <ul className="mt-9 space-y-6">
            {POINTS.map(([Icon, heading, text]) => (
              <li key={heading} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15"><Icon className="size-5" /></span>
                <span>
                  <span className="block font-semibold">{heading}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-indigo-100/85">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-indigo-200/70">Built for schools in the Philippines · Data Privacy Act of 2012 aware</p>
      </aside>

      <main className="flex min-h-dvh flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-[26rem]">
          <Link to="/login" className="mb-8 inline-block lg:hidden" aria-label="EduSphere"><Logo /></Link>
          <h1 className="text-[1.7rem] font-bold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-soft">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-soft">{footer}</div>}
          <p className="mt-10 text-center text-xs text-faint">
            <Link to="/privacy" className="hover:text-brand hover:underline">Privacy notice</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export function PasswordHints() {
  return <span>At least 10 characters. A short sentence works well. Avoid your name, e-mail address and common passwords.</span>;
}
