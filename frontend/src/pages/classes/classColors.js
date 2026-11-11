// The eight class colours (chosen by the teacher) as complete Tailwind class names, so the
// compiler can see them.
const COLORS = {
  indigo: { bar: 'bg-indigo-500', soft: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-300', banner: 'from-indigo-500 to-indigo-700' },
  violet: { bar: 'bg-violet-500', soft: 'bg-violet-500/12 text-violet-600 dark:text-violet-300', banner: 'from-violet-500 to-purple-700' },
  sky: { bar: 'bg-sky-500', soft: 'bg-sky-500/12 text-sky-700 dark:text-sky-300', banner: 'from-sky-500 to-blue-700' },
  teal: { bar: 'bg-teal-500', soft: 'bg-teal-500/12 text-teal-700 dark:text-teal-300', banner: 'from-teal-500 to-cyan-700' },
  emerald: { bar: 'bg-emerald-500', soft: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', banner: 'from-emerald-500 to-teal-700' },
  amber: { bar: 'bg-amber-500', soft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', banner: 'from-amber-500 to-orange-600' },
  rose: { bar: 'bg-rose-500', soft: 'bg-rose-500/12 text-rose-600 dark:text-rose-300', banner: 'from-rose-500 to-pink-700' },
  slate: { bar: 'bg-slate-500', soft: 'bg-slate-500/12 text-slate-600 dark:text-slate-300', banner: 'from-slate-500 to-slate-700' },
};
export const CLASS_COLORS = Object.keys(COLORS);
export const classColor = (name) => COLORS[name] ?? COLORS.indigo;
