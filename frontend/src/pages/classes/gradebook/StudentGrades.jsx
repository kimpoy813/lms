// One student's grades, with the arithmetic shown. Used by the student's own Grades page and by
// the teacher's "how is this computed" dialog.
import { ClipboardList, FileQuestion, Info, PenLine, UserCheck } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Card, cn, ProgressBar } from '../../../components/ui.jsx';
import { formatPercent, formatScore } from '../../../lib/format.js';
import { useClass } from '../useClass.js';

const ENTRY = {
  GRADED: null,
  UNGRADED: { label: 'Not graded yet', tone: 'neutral' },
  MISSING: { label: 'Missing', tone: 'bad' },
  EXEMPT: { label: 'Exempt', tone: 'info' },
};

export function GradeBadge({ grade, size = 'md' }) {
  if (!grade || grade.percent === null) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className={cn('font-bold tabular-nums', size === 'lg' ? 'text-4xl' : 'text-xl', grade.isPassing === false ? 'text-bad' : 'text-ink')}>{grade.label ?? formatPercent(grade.percent, 2)}</span>
      {grade.label && <span className={cn('tabular-nums text-soft', size === 'lg' ? 'text-lg' : 'text-sm')}>{formatPercent(grade.percent, 2)}</span>}
    </span>
  );
}

export default function StudentGrades({ data, teacher = false, onAppeal }) {
  const { base } = useClass();
  const visible = data.periods.filter((p) => teacher || p.published);
  return (
    <div className="space-y-5">
      {(data.overall || teacher) && (
        <div className={cn('flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border p-5', data.overall?.isPassing === false ? 'border-bad/40 bg-bad-soft' : 'border-line bg-raised')}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">{data.finalized ? 'Final grade' : teacher ? 'Overall so far' : 'Grade so far'}</p>
            <GradeBadge grade={data.overall} size="lg" />
            {data.overall?.remark && <p className={cn('text-sm font-medium', data.overall.isPassing === false ? 'text-bad' : 'text-ok')}>{data.overall.remark}</p>}
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            {data.periods.map((p) => (
              <div key={p.id}>
                <dt className="text-xs font-medium text-faint">{p.name} · {p.weight}%{teacher && !p.published ? ' · hidden' : ''}</dt>
                <dd>{teacher || p.published ? <GradeBadge grade={p} /> : <span className="text-sm text-faint">Not released</span>}</dd>
              </div>
            ))}
          </dl>
          {data.overall?.isOverridden && <p className="basis-full text-[13px] text-soft"><Info className="mr-1 inline size-3.5" aria-hidden="true" />Adjusted by your teacher{data.overall.overrideReason ? `: ${data.overall.overrideReason}` : ''} (computed {formatPercent(data.overall.computedPercent, 2)}).</p>}
        </div>
      )}

      {visible.length === 0 && !teacher && (
        <Card className="text-center text-sm text-soft">Your teacher has not released grades for this class yet. Scores of returned assignments and quizzes are shown on their own pages.</Card>
      )}

      {visible.map((p) => (
        <section key={p.id} aria-label={p.name}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-ink">{p.name} <span className="text-sm font-normal text-faint">· {p.weight}% of the final grade</span></h3>
            {p.isOverridden && <Badge tone="warn">Adjusted · computed {formatPercent(p.computedPercent, 2)}</Badge>}
          </div>
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            {p.categories.map((c) => (
              <div key={c.id} className="border-b border-line last:border-b-0">
                <div className="flex flex-wrap items-center gap-3 bg-raised/60 px-4 py-2.5">
                  <p className="min-w-0 flex-1 text-sm font-semibold text-ink">{c.name} <span className="font-normal text-faint">· {c.weight}%</span></p>
                  {c.percent === null ? <span className="text-xs text-faint">nothing graded yet</span> : (
                    <span className="flex items-center gap-3">
                      <ProgressBar value={c.percent} tone={c.percent < 75 ? 'warn' : 'ok'} label={`${c.name} average`} className="h-1.5 w-24 max-sm:hidden" />
                      <span className="w-16 text-right text-sm font-semibold tabular-nums text-ink">{formatPercent(c.percent, 2)}</span>
                    </span>
                  )}
                </div>
                {c.kind === 'ATTENDANCE' ? (
                  <p className="flex items-center gap-2 px-4 py-2.5 text-[13px] text-soft"><UserCheck className="size-4 text-faint" aria-hidden="true" />{c.attendance ? `Present ${c.attendance.present} · late ${c.attendance.late} · absent ${c.attendance.absent} · excused ${c.attendance.excused}` : 'Attendance is not counted toward grades at this school.'}</p>
                ) : c.items.length === 0 ? <p className="px-4 py-2.5 text-[13px] text-faint">No graded work in this category yet.</p> : (
                  <ul>
                    {c.items.map((item) => {
                      const Icon = item.source === 'QUIZ' ? FileQuestion : item.source === 'ASSIGNMENT' ? ClipboardList : PenLine;
                      const state = ENTRY[item.status];
                      const to = item.source === 'QUIZ' ? `${base}/quizzes/${item.quizId}` : item.source === 'ASSIGNMENT' ? `${base}/assignments/${item.assignmentId}` : null;
                      return (
                        <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 first:border-t-0">
                          <Icon className="size-4 shrink-0 text-faint" aria-hidden="true" />
                          <span className="min-w-0 flex-1 basis-40 text-sm">
                            {to ? <Link to={to} className="text-ink hover:text-brand hover:underline">{item.title}</Link> : <span className="text-ink">{item.title}</span>}
                            {item.isLate && <Badge tone="warn" className="ml-2">Late</Badge>}
                            {item.feedback && <span className="block text-xs text-faint">{item.feedback}</span>}
                          </span>
                          {state ? <Badge tone={state.tone}>{state.label}</Badge> : <span className="text-sm font-semibold tabular-nums text-ink">{formatScore(item.score)}<span className="font-normal text-faint"> / {formatScore(item.maxPoints)}</span></span>}
                          {onAppeal && item.status === 'GRADED' && <button type="button" onClick={() => onAppeal(item)} className="text-xs font-medium text-brand hover:underline">Question this score</button>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 bg-raised px-4 py-3">
              <p className="text-sm font-semibold text-ink">{p.name} grade{!p.isComplete && p.percent !== null ? <span className="ml-2 text-xs font-normal text-faint">so far — some work is not graded yet</span> : null}</p>
              <GradeBadge grade={p} />
            </div>
          </div>
        </section>
      ))}

      {data.explanation?.length > 0 && (visible.length > 0 || teacher) && (
        <details className="rounded-2xl border border-line bg-surface p-4 text-sm" open={teacher}>
          <summary className="cursor-pointer font-semibold text-ink">How this grade is computed</summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-soft">
            {data.explanation.map((line) => <li key={line}>{line}</li>)}
          </ol>
          {data.policy?.transmutationBase > 0 && <p className="mt-2 text-[13px] text-faint">Transmutation: the raw percentage is rescaled so that 0% becomes {data.policy.transmutationBase}%.</p>}
        </details>
      )}

      {data.scale?.entries?.length > 0 && (
        <details className="rounded-2xl border border-line bg-surface p-4 text-sm">
          <summary className="cursor-pointer font-semibold text-ink">Grading scale — {data.scale.name}</summary>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3 lg:grid-cols-5">
            {data.scale.entries.map((e) => (
              <div key={e.label} className="flex items-baseline justify-between gap-2 border-b border-line py-1">
                <dt className={cn('font-semibold tabular-nums', e.isPassing ? 'text-ink' : 'text-bad')}>{e.label}</dt>
                <dd className="text-faint">{e.minPercent}%+ · {e.remark}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
