// Class analytics for the teacher: how the class is doing and who may need help.
// "At risk" is a transparent rule (thresholds set by the administrator), never a hidden score.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, BookOpen, CheckCircle2, GraduationCap, Mail, TrendingDown, UserCheck } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Badge, Button, Card, CardHeader, cn, EmptyState, QueryState, Segmented, Skeleton, StatCard } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDay, formatPercent, plural } from '../../lib/format.js';
import { useClass } from './useClass.js';

const Charts = lazy(() => import('./AnalyticsCharts.jsx'));

export default function Analytics() {
  const { cls, canManage, base } = useClass();
  const [filter, setFilter] = useState('ALL');
  const query = useQuery({ queryKey: ['class', cls.id, 'analytics'], queryFn: () => api.get(`${base}/analytics`), enabled: canManage });
  if (!canManage) return <EmptyState title="Analytics are for the teacher" />;
  return (
    <QueryState query={query}>
      {(a) => {
        const { summary: s, thresholds: t } = a;
        if (s.students === 0) return <Card><EmptyState icon={BarChart3} title="No students yet" description="Analytics appear once students join and work is graded." /></Card>;
        const shown = a.students.filter((x) => filter === 'ALL' || (filter === 'RISK' ? x.risk.level !== 'NONE' : x.risk.level === 'NONE'));
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Class average" value={s.averageGrade === null ? '—' : formatPercent(s.averageGrade)} icon={GraduationCap} hint="Running grade of graded work" />
              <StatCard label="Attendance" value={s.averageAttendance === null ? '—' : formatPercent(s.averageAttendance)} icon={UserCheck} tone={s.averageAttendance !== null && s.averageAttendance < t.attendanceBelow ? 'warn' : 'ok'} hint="Present or late, all meetings" />
              <StatCard label="Lessons completed" value={s.lessonCompletion === null ? '—' : formatPercent(s.lessonCompletion, 0)} icon={BookOpen} hint="Average across students" />
              <StatCard label="May need help" value={s.atRisk} icon={TrendingDown} tone={s.atRisk > 0 ? 'bad' : 'ok'} hint={s.highRisk > 0 ? `${s.highRisk} at high risk` : `of ${plural(s.students, 'student')}`} />
            </div>

            <Suspense fallback={<div className="grid grid-cols-1 gap-5 lg:grid-cols-2"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>}>
              <Charts data={a} />
            </Suspense>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <Card>
                <CardHeader title="Submissions" description="Assignments and quizzes with a deadline" />
                <dl className="space-y-2.5 text-sm">
                  {[['On time', s.onTime, 'bg-ok'], ['Late', s.late, 'bg-warn'], ['Missing', s.missing, 'bg-bad']].map(([label, n, color]) => {
                    const total = s.onTime + s.late + s.missing;
                    return (
                      <div key={label}>
                        <div className="flex justify-between"><dt className="text-soft">{label}</dt><dd className="font-semibold tabular-nums text-ink">{n}</dd></div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"><div className={cn('h-full rounded-full', color)} style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></div>
                      </div>
                    );
                  })}
                </dl>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader title="Average score by assessment" description="Lower averages may point to a topic worth reviewing" />
                {a.assessments.length === 0 ? <p className="text-sm text-faint">Nothing has been graded yet.</p> : (
                  <ul className="space-y-2.5">
                    {a.assessments.map((x) => (
                      <li key={x.id} className="grid grid-cols-[minmax(0,1fr)_7rem_3.5rem] items-center gap-3 text-sm">
                        <span className="min-w-0"><span className="block truncate text-ink">{x.title}</span><span className="text-xs text-faint">{plural(x.graded, 'score')}</span></span>
                        <span className="h-2 overflow-hidden rounded-full bg-raised"><span className={cn('block h-full rounded-full', x.average < 60 ? 'bg-bad' : x.average < t.gradeBelow ? 'bg-warn' : 'bg-ok')} style={{ width: `${x.average ?? 0}%` }} /></span>
                        <span className="text-right font-semibold tabular-nums text-ink">{x.average === null ? '—' : formatPercent(x.average, 0)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
                <div>
                  <h2 className="text-[15px] font-semibold text-ink">Students</h2>
                  <p className="text-[13px] text-faint">Flagged when the running grade is below {t.gradeBelow}%, attendance is below {t.attendanceBelow}%, or {t.missingAtLeast}+ submissions are missing.</p>
                </div>
                <Segmented size="sm" label="Show" value={filter} onChange={setFilter} options={[{ value: 'ALL', label: 'Everyone' }, { value: 'RISK', label: 'May need help' }, { value: 'OK', label: 'On track' }]} />
              </div>
              {shown.length === 0 ? <EmptyState compact icon={CheckCircle2} title={filter === 'RISK' ? 'No one is flagged' : 'No students in this group'} /> : (
                <ul className="divide-y divide-line">
                  {shown.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                      <Avatar name={x.name} size={36} />
                      <div className="min-w-0 flex-1 basis-52">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">{x.name}{x.risk.level === 'HIGH' ? <Badge tone="bad" icon={AlertTriangle}>High risk</Badge> : x.risk.level !== 'NONE' ? <Badge tone="warn">Watch</Badge> : null}</p>
                        {x.risk.reasons.length > 0
                          ? <p className="text-[13px] text-soft">{x.risk.reasons.map((r) => r.text).join(' · ')}</p>
                          : <p className="text-[13px] text-faint">On track</p>}
                        {x.missingItems.length > 0 && <p className="mt-0.5 text-xs text-faint">Missing: {x.missingItems.map((m) => m.title).join(', ')}{x.missing > x.missingItems.length ? '…' : ''}</p>}
                      </div>
                      <dl className="flex shrink-0 gap-5 text-right text-xs text-faint">
                        <div><dt>Grade</dt><dd className={cn('text-sm font-bold tabular-nums', x.percent !== null && x.percent < t.gradeBelow ? 'text-bad' : 'text-ink')}>{x.percent === null ? '—' : formatPercent(x.percent, 0)}</dd></div>
                        <div><dt>Attendance</dt><dd className={cn('text-sm font-bold tabular-nums', x.attendanceRate !== null && x.attendanceRate < t.attendanceBelow ? 'text-bad' : 'text-ink')}>{x.attendanceRate === null ? '—' : formatPercent(x.attendanceRate, 0)}</dd></div>
                        <div><dt>Missing</dt><dd className={cn('text-sm font-bold tabular-nums', x.missing >= t.missingAtLeast ? 'text-bad' : 'text-ink')}>{x.missing}</dd></div>
                      </dl>
                      <Button to={`/messages?to=${x.id}`} variant="secondary" size="sm" icon={Mail}>Message</Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="border-t border-line px-5 py-3 text-xs text-faint">These flags are a prompt to check in with a student, not a judgement. They are visible only to you and the administrator. <Link to={`${base}/gradebook`} className="text-brand hover:underline">Open the gradebook</Link></p>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

export const dayLabel = (key) => formatDay(`${key}T12:00:00Z`).replace(/^\w+, /, '');
