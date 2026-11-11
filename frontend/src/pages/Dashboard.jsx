// The first screen after signing in. One endpoint returns everything a role needs to decide
// what to do next, so the page loads in a single round trip.
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, BookOpen, CalendarClock, CheckCircle2, ClipboardCheck, ClipboardList, Clock, FileQuestion, GraduationCap, HardDrive, History, Inbox,
  Mail, MapPin, Megaphone, PenLine, Radio, ScanLine, Server, Sparkles, TrendingDown, UserCheck, UserPlus, Users,
} from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Avatar, Badge, Button, Card, CardHeader, cn, EmptyState, PageHeader, ProgressBar, QueryState, Skeleton, StatCard } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dueLabel, formatBytes, formatClock, formatDateKey, formatDay, formatPercent, formatScore, formatTime, getTimeZone, plural, relativeTime } from '../lib/format.js';
import { classColor } from './classes/classColors.js';

const AdminCharts = lazy(() => import('./DashboardCharts.jsx'));

const greeting = () => {
  // The hour on the school's clock, not the device's.
  const hour = Number(new Intl.DateTimeFormat('en-PH', { hour: 'numeric', hourCycle: 'h23', timeZone: getTimeZone() }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

export default function Dashboard() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard'), refetchInterval: 120_000 });
  return (
    <>
      <PageHeader title={`${greeting()}, ${user.firstName}`} description={query.data ? formatDateKey(query.data.date) : ' '} />
      <QueryState query={query} loader={<DashboardSkeleton />}>
        {(data) => (data.role === 'STUDENT' ? <StudentDashboard data={data} /> : data.role === 'TEACHER' ? <TeacherDashboard data={data} /> : <AdminDashboard data={data} />)}
      </QueryState>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading your dashboard">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}</div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3"><Skeleton className="h-72 rounded-2xl lg:col-span-2" /><Skeleton className="h-72 rounded-2xl" /></div>
    </div>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────
const kindIcon = (kind) => (kind === 'ASSIGNMENT' ? ClipboardList : FileQuestion);

function ItemRow({ to, icon: Icon, title, meta, right, tone = 'brand' }) {
  return (
    <li>
      <Link to={to} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-raised">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', { brand: 'bg-brand-soft text-brand', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', ok: 'bg-ok-soft text-ok' }[tone])}><Icon className="size-[18px]" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{title}</span>
          <span className="block truncate text-xs text-faint">{meta}</span>
        </span>
        {right}
        <ArrowRight className="size-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </Link>
    </li>
  );
}

function TodaySchedule({ items, emptyText }) {
  return (
    <Card>
      <CardHeader icon={CalendarClock} title="Today’s classes" action={<Link to="/calendar" className="text-[13px] font-medium text-brand hover:underline">Calendar</Link>} />
      {items.length === 0 ? <EmptyState compact icon={CalendarClock} title="No classes today" description={emptyText} /> : (
        <ol className="space-y-2">
          {items.map((m) => (
            <li key={`${m.classId}-${m.startTime}`}>
              <Link to={`/classes/${m.classId}`} className="flex items-stretch gap-3 rounded-xl border border-line p-3 hover:border-line-strong hover:bg-raised">
                <span className={cn('w-1 shrink-0 rounded-full', classColor(m.color).bar)} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{m.label}</span>
                  <span className="block truncate text-xs text-faint">{m.title}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums text-ink">{formatClock(m.startTime)}</span>
                  <span className="flex items-center justify-end gap-1 text-xs text-faint">{m.room ? <><MapPin className="size-3" aria-hidden="true" />{m.room}</> : `until ${formatClock(m.endTime)}`}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function AnnouncementsCard({ items }) {
  return (
    <Card>
      <CardHeader icon={Megaphone} title="Announcements" action={<Link to="/announcements" className="text-[13px] font-medium text-brand hover:underline">See all</Link>} />
      {items.length === 0 ? <EmptyState compact icon={Megaphone} title="No announcements yet" /> : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li key={a.id} className="py-3 first:pt-0 last:pb-0">
              <Link to={a.classId ? `/classes/${a.classId}/announcements?open=${a.id}` : `/announcements?open=${a.id}`} className="block hover:opacity-80">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{a.title}</span>
                  {a.priority === 'URGENT' && <Badge tone="bad">Urgent</Badge>}
                  {a.priority === 'HIGH' && <Badge tone="warn">Important</Badge>}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[13px] text-soft">{a.excerpt}</span>
                <span className="mt-1 block text-xs text-faint">{a.classLabel ?? 'Institution'} · {a.author} · {relativeTime(a.publishedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Student ──────────────────────────────────────────────────────────────────
function StudentDashboard({ data }) {
  const { stats } = data;
  return (
    <div className="space-y-5">
      {data.checkIns.filter((c) => !c.recorded).map((c) => (
        <div key={c.sessionId} className="flex flex-wrap items-center gap-3 rounded-2xl border border-brand/30 bg-brand-soft p-4">
          <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-brand-fill text-white"><Radio className="size-5" aria-hidden="true" /><span className="absolute -right-0.5 -top-0.5 size-3 animate-ping rounded-full bg-ok" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">Attendance is open for {c.classLabel}</p>
            <p className="text-sm text-soft">{c.title ?? 'Class meeting'}{c.endTime ? ` · closes ${formatClock(c.endTime)}` : ''}{c.requireLocation ? ' · location check required' : ''}</p>
          </div>
          <Button to="/attendance/scan" icon={ScanLine}>Check in now</Button>
        </div>
      ))}
      {(stats.invitations > 0 || stats.pendingEnrollments > 0) && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
          <UserPlus className="size-5 text-brand" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-soft">
            {stats.invitations > 0 && <><strong className="font-semibold text-ink">{plural(stats.invitations, 'class invitation')}</strong> waiting for your answer. </>}
            {stats.pendingEnrollments > 0 && <><strong className="font-semibold text-ink">{plural(stats.pendingEnrollments, 'join request')}</strong> waiting for the teacher’s approval.</>}
          </p>
          <Button to="/classes" variant="secondary" size="sm">Review</Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="My classes" value={stats.classes} icon={BookOpen} to="/classes" />
        <StatCard label="Due this week" value={stats.dueThisWeek} icon={ClipboardList} tone={stats.dueThisWeek > 0 ? 'info' : 'ok'} hint={stats.dueThisWeek === 0 ? 'Nothing due' : 'Assignments and quizzes'} />
        <StatCard label="Missing work" value={stats.missing} icon={AlertTriangle} tone={stats.missing > 0 ? 'bad' : 'ok'} hint={stats.missing > 0 ? 'Past the due date' : 'All caught up'} />
        <StatCard label="Attendance" value={stats.attendanceRate === null ? '—' : formatPercent(stats.attendanceRate, 0)} icon={UserCheck} tone={stats.attendanceRate !== null && stats.attendanceRate < 80 ? 'warn' : 'ok'} hint="Across all classes" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card>
            <CardHeader icon={ClipboardList} title="To do" description="Open work, soonest first" />
            {data.todo.length === 0 ? <EmptyState compact icon={CheckCircle2} title="Nothing due this week" description="New assignments and quizzes will show up here." /> : (
              <ul className="-mx-2">
                {data.todo.map((t) => {
                  const soon = new Date(t.dueAt).getTime() - Date.now() < 36 * 3_600_000;
                  return <ItemRow key={`${t.kind}-${t.id}`} to={t.link} icon={kindIcon(t.kind)} title={t.title} meta={`${t.classLabel} · ${dueLabel(t.dueAt)}`} tone={soon ? 'warn' : 'brand'} right={t.points != null ? <span className="hidden shrink-0 text-xs font-medium text-faint sm:block">{formatScore(t.points)} pts</span> : null} />;
                })}
              </ul>
            )}
          </Card>

          {data.missing.length > 0 && (
            <Card className="border-bad/25">
              <CardHeader icon={AlertTriangle} title="Missing work" description="Past the due date and not submitted" />
              <ul className="-mx-2">
                {data.missing.map((m) => (
                  <ItemRow key={`${m.kind}-${m.id}`} to={m.link} icon={kindIcon(m.kind)} title={m.title} meta={`${m.classLabel} · ${dueLabel(m.dueAt)}`} tone="bad" right={m.canStillSubmit ? <Badge tone="warn">Late submission allowed</Badge> : <Badge>Closed</Badge>} />
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader icon={BookOpen} title="My classes" action={<Link to="/classes" className="text-[13px] font-medium text-brand hover:underline">All classes</Link>} />
            {data.classes.length === 0 ? <EmptyState compact icon={BookOpen} title="You are not in a class yet" description="Join with the class code your teacher gave you." action={<Button to="/classes" size="sm">Join a class</Button>} /> : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {data.classes.map((c) => (
                  <li key={c.id}>
                    <Link to={`/classes/${c.id}`} className="block h-full rounded-xl border border-line p-4 hover:border-line-strong hover:bg-raised">
                      <span className="flex items-center gap-2.5">
                        <span className={cn('size-2.5 shrink-0 rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                        <span className="truncate text-sm font-semibold text-ink">{c.label}</span>
                        {c.openWork > 0 && <Badge tone="info" className="ml-auto">{c.openWork} to do</Badge>}
                      </span>
                      <span className="mt-1 block truncate text-[13px] text-soft">{c.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-faint">{c.teacher}</span>
                      <span className="mt-3 flex items-center gap-2 text-xs text-faint">
                        <ProgressBar value={c.lessonProgress ?? 0} label={`Lessons completed in ${c.label}`} className="h-1.5 flex-1" />
                        <span className="w-24 shrink-0 text-right tabular-nums">{c.lessonProgress ?? 0}% of lessons</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <TodaySchedule items={data.today} emptyText="Enjoy the break, or get ahead on your to-do list." />
          <Card>
            <CardHeader icon={GraduationCap} title="Recent grades" action={<Link to="/grades" className="text-[13px] font-medium text-brand hover:underline">All grades</Link>} />
            {data.recentGrades.length === 0 ? <EmptyState compact icon={GraduationCap} title="No grades yet" description="Scores appear here when your teacher returns your work." /> : (
              <ul className="divide-y divide-line">
                {data.recentGrades.map((g) => {
                  const pct = g.maxScore > 0 ? (g.score / g.maxScore) * 100 : null;
                  return (
                    <li key={`${g.kind}-${g.id}`} className="py-2.5 first:pt-0 last:pb-0">
                      <Link to={g.link} className="flex items-center gap-3 hover:opacity-80">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{g.title}</span>
                          <span className="block truncate text-xs text-faint">{g.classLabel} · {relativeTime(g.at)}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-bold tabular-nums text-ink">{formatScore(g.score)}<span className="font-medium text-faint"> / {formatScore(g.maxScore)}</span></span>
                          {pct !== null && <span className={cn('block text-xs font-semibold tabular-nums', pct >= 75 ? 'text-ok' : 'text-bad')}>{formatPercent(pct, 0)}</span>}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <AnnouncementsCard items={data.announcements} />
        </div>
      </div>
    </div>
  );
}

// ── Teacher ──────────────────────────────────────────────────────────────────
function TeacherDashboard({ data }) {
  const { stats, requests, drafts, thresholds } = data;
  const draftTotal = drafts.assignments + drafts.quizzes + drafts.modules;
  return (
    <div className="space-y-5">
      {data.openSessions.map((s) => (
        <div key={s.sessionId} className="flex flex-wrap items-center gap-3 rounded-2xl border border-ok/30 bg-ok-soft p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok text-white dark:text-[#06281a]"><Radio className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">Attendance is open for {s.classLabel}</p>
            <p className="text-sm text-soft">{plural(s.recorded, 'student')} recorded so far{s.endTime ? ` · scheduled until ${formatClock(s.endTime)}` : ''}</p>
          </div>
          <Button to={`/classes/${s.classId}/attendance?session=${s.sessionId}`} variant="secondary">Open session</Button>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active classes" value={stats.classes} icon={BookOpen} to="/classes" hint={plural(stats.students, 'student')} />
        <StatCard label="To grade" value={stats.toGrade} icon={PenLine} tone={stats.toGrade > 0 ? 'info' : 'ok'} hint={stats.toGrade > 0 ? 'Submissions waiting' : 'All graded'} />
        <StatCard label="Pending requests" value={stats.pendingRequests} icon={Inbox} tone={stats.pendingRequests > 0 ? 'warn' : 'ok'} hint="Enrolment, corrections, appeals" />
        <StatCard label="Students at risk" value={stats.atRisk} icon={TrendingDown} tone={stats.atRisk > 0 ? 'bad' : 'ok'} hint={`Below ${thresholds.gradeBelow}% or ${thresholds.attendanceBelow}% attendance`} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card>
            <CardHeader icon={PenLine} title="Needs grading" description="Submitted work waiting for a score" />
            {data.toGrade.length === 0 ? <EmptyState compact icon={CheckCircle2} title="Nothing to grade" description="New submissions will appear here." /> : (
              <ul className="-mx-2">
                {data.toGrade.map((t) => (
                  <ItemRow key={`${t.kind}-${t.id}`} to={t.link} icon={kindIcon(t.kind)} title={t.title} meta={t.classLabel} right={<Badge tone="info">{t.count} to grade</Badge>} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={TrendingDown} title="Students who may need help" description={`Running grade below ${thresholds.gradeBelow}%, attendance below ${thresholds.attendanceBelow}%, or ${thresholds.missingAtLeast}+ missing submissions`} />
            {data.atRisk.length === 0 ? <EmptyState compact icon={CheckCircle2} title="No one is flagged right now" /> : (
              <ul className="divide-y divide-line">
                {data.atRisk.map((s) => (
                  <li key={`${s.classId}-${s.studentId}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0" title={s.reasons.join(' · ')}>
                    <Avatar name={s.name} size={36} />
                    <div className="min-w-0 flex-1 basis-44">
                      <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                      <p className="flex items-center gap-2 text-xs text-faint"><Badge tone={s.level === 'HIGH' ? 'bad' : 'warn'}>{s.level === 'HIGH' ? 'High risk' : 'Watch'}</Badge><span className="truncate">{s.classLabel}</span></p>
                    </div>
                    <dl className="flex shrink-0 gap-4 text-right text-xs">
                      <div><dt className="text-faint">Grade</dt><dd className={cn('text-sm font-bold tabular-nums', s.percent !== null && s.percent < thresholds.gradeBelow ? 'text-bad' : 'text-ink')}>{s.percent === null ? '—' : formatPercent(s.percent, 0)}</dd></div>
                      <div><dt className="text-faint">Attendance</dt><dd className={cn('text-sm font-bold tabular-nums', s.attendanceRate !== null && s.attendanceRate < thresholds.attendanceBelow ? 'text-bad' : 'text-ink')}>{s.attendanceRate === null ? '—' : formatPercent(s.attendanceRate, 0)}</dd></div>
                      <div><dt className="text-faint">Missing</dt><dd className={cn('text-sm font-bold tabular-nums', s.missing >= thresholds.missingAtLeast ? 'text-bad' : 'text-ink')}>{s.missing}</dd></div>
                    </dl>
                    <div className="flex shrink-0 gap-1">
                      <Button to={`/messages?to=${s.studentId}`} variant="secondary" size="sm" icon={Mail} aria-label={`Message ${s.name}`}><span className="max-xl:sr-only">Message</span></Button>
                      <Button to={`/classes/${s.classId}/analytics`} variant="ghost" size="sm" aria-label={`Open class analytics for ${s.name}`}>Details</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={Clock} title="Coming up" description="Deadlines in your classes" />
            {data.upcoming.length === 0 ? <EmptyState compact icon={Clock} title="No upcoming deadlines" /> : (
              <ul className="-mx-2">
                {data.upcoming.map((u) => (
                  <ItemRow key={`${u.kind}-${u.id}`} to={u.link} icon={kindIcon(u.kind)} title={u.title} meta={`${u.classLabel} · ${u.kind === 'ASSIGNMENT' ? dueLabel(u.dueAt) : `Closes ${formatDay(u.dueAt)}, ${formatTime(u.dueAt)}`}`} right={u.enrolled != null ? <span className="hidden shrink-0 text-xs font-medium tabular-nums text-faint sm:block">{u.submitted} of {u.enrolled} submitted</span> : null} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <TodaySchedule items={data.today} emptyText="No meetings are scheduled for today." />

          <Card>
            <CardHeader icon={Inbox} title="Requests" />
            <ul className="space-y-1.5 text-sm">
              {[
                ['Enrolment requests', requests.enrollments, UserPlus, data.classes.filter((c) => c.pendingEnrollments > 0), 'people'],
                ['Attendance corrections', requests.attendanceCorrections, ClipboardCheck, data.classes.filter((c) => c.pendingCorrections > 0), 'attendance?tab=requests'],
                ['Grade appeals', requests.gradeAppeals, GraduationCap, data.classes.filter((c) => c.pendingAppeals > 0), 'gradebook?tab=appeals'],
              ].map(([label, count, Icon, waiting, path]) => (
                <li key={label} className="flex items-center gap-3 rounded-xl px-2 py-2">
                  <Icon className="size-[18px] text-faint" aria-hidden="true" />
                  <span className="flex-1 text-soft">{label}</span>
                  {count > 0 ? <Badge tone="warn">{count} pending</Badge> : <span className="text-xs text-faint">None</span>}
                  {/* Goes to the first class with something waiting; its label is spoken when several classes do. */}
                  {count > 0 && waiting[0] && <Link to={`/classes/${waiting[0].id}/${path}`} title={waiting.map((c) => c.label).join(', ')} className="text-[13px] font-medium text-brand hover:underline">Review<span className="sr-only"> {label.toLowerCase()} in {waiting[0].label}</span></Link>}
                </li>
              ))}
            </ul>
            {draftTotal > 0 && (
              <p className="mt-3 border-t border-line pt-3 text-[13px] text-soft">
                <Sparkles className="mr-1.5 inline size-4 text-brand" aria-hidden="true" />
                Unpublished drafts: {[drafts.modules && plural(drafts.modules, 'module'), drafts.assignments && plural(drafts.assignments, 'assignment'), drafts.quizzes && plural(drafts.quizzes, 'quiz', 'quizzes')].filter(Boolean).join(', ')}. Students cannot see drafts.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader icon={BookOpen} title="My classes" action={<Link to="/classes" className="text-[13px] font-medium text-brand hover:underline">All classes</Link>} />
            {data.classes.length === 0 ? <EmptyState compact icon={BookOpen} title="No classes yet" action={<Button to="/classes" size="sm">Create a class</Button>} /> : (
              <ul className="space-y-2">
                {data.classes.map((c) => (
                  <li key={c.id}>
                    <Link to={`/classes/${c.id}`} className="flex items-center gap-3 rounded-xl border border-line p-3 hover:border-line-strong hover:bg-raised">
                      <span className={cn('w-1 self-stretch rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{c.label}</span>
                        <span className="block truncate text-xs text-faint">{c.title}</span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-faint">
                        <span className="block font-medium text-soft">{plural(c.students, 'student')}</span>
                        {c.toGrade > 0 ? <span className="text-info">{c.toGrade} to grade</span> : c.pendingEnrollments > 0 ? <span className="text-warn">{c.pendingEnrollments} pending</span> : <span>Up to date</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <AnnouncementsCard items={data.announcements} />
        </div>
      </div>
    </div>
  );
}

// ── Administrator ────────────────────────────────────────────────────────────
function AdminDashboard({ data }) {
  const { stats, system, attendance14d } = data;
  const services = [
    ['E-mail delivery', system.mailConfigured, 'Messages are written to the development mailbox until SMTP is configured.'],
    ['AI authoring', system.aiConfigured, 'Teachers cannot generate drafts until an AI provider key is set.'],
    ['Code runner', system.codeRunnerConfigured, 'Programming problems cannot be executed until a judge service is connected.'],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Students" value={stats.students} icon={GraduationCap} to="/admin/users?role=STUDENT" hint={`${plural(stats.enrollments, 'enrolment')}`} />
        <StatCard label="Teachers" value={stats.teachers} icon={Users} to="/admin/users?role=TEACHER" hint={plural(stats.admins, 'administrator')} />
        <StatCard label="Active classes" value={stats.activeClasses} icon={BookOpen} to="/classes" hint={stats.archivedClasses > 0 ? `${stats.archivedClasses} archived` : data.currentSemester ?? 'No current semester'} />
        <StatCard label="Waiting for approval" value={stats.pendingApprovals} icon={UserPlus} tone={stats.pendingApprovals > 0 ? 'warn' : 'ok'} to="/admin/users?status=PENDING" hint={stats.suspended + stats.lockedOut > 0 ? `${stats.suspended} suspended · ${stats.lockedOut} locked out` : 'Teacher accounts'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card>
            <CardHeader icon={Users} title="People signing in" description={`Distinct users per day, last 14 days${data.currentSemester ? ` · ${data.currentSemester}` : ''}`} />
            <Suspense fallback={<Skeleton className="h-56" />}>
              <AdminCharts signIns={data.signIns} />
            </Suspense>
          </Card>

          <Card>
            <CardHeader icon={History} title="Recent activity" action={<Link to="/admin/audit" className="text-[13px] font-medium text-brand hover:underline">Audit log</Link>} />
            {data.recentAudit.length === 0 ? <EmptyState compact icon={History} title="No activity recorded yet" /> : (
              <ul className="divide-y divide-line text-sm">
                {data.recentAudit.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1"><span className="font-medium text-ink">{a.actor ?? 'System'}</span> <span className="text-soft">— {a.summary}</span></span>
                    <span className="shrink-0 text-xs text-faint">{relativeTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader icon={UserPlus} title="Accounts to review" action={<Link to="/admin/users?status=PENDING" className="text-[13px] font-medium text-brand hover:underline">All</Link>} />
            {data.pendingUsers.length === 0 ? <EmptyState compact icon={CheckCircle2} title="No one is waiting" /> : (
              <ul className="space-y-2">
                {data.pendingUsers.map((u) => (
                  <li key={u.id}>
                    <Link to={`/admin/users?open=${u.id}`} className="flex items-center gap-3 rounded-xl border border-line p-3 hover:border-line-strong hover:bg-raised">
                      <Avatar name={u.name} size={34} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{u.name}</span>
                        <span className="block truncate text-xs text-faint">{u.email}</span>
                      </span>
                      <Badge tone="warn">{u.role === 'TEACHER' ? 'Teacher' : 'Student'}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={UserCheck} title="Attendance, last 14 days" />
            <p className="text-3xl font-bold tabular-nums text-ink">{attendance14d.rate === null ? '—' : formatPercent(attendance14d.rate)}</p>
            <p className="text-xs text-faint">present or late, of all recorded meetings</p>
            <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
              {[['Present', attendance14d.present, 'text-ok'], ['Late', attendance14d.late, 'text-warn'], ['Absent', attendance14d.absent, 'text-bad'], ['Excused', attendance14d.excused, 'text-info']].map(([label, n, tone]) => (
                <div key={label} className="rounded-xl bg-raised py-2.5">
                  <dd className={cn('text-lg font-bold tabular-nums', tone)}>{n}</dd>
                  <dt className="text-[11px] font-medium text-faint">{label}</dt>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <CardHeader icon={Server} title="System" action={<Link to="/admin/settings" className="text-[13px] font-medium text-brand hover:underline">Settings</Link>} />
            <ul className="space-y-3 text-sm">
              {services.map(([label, on, off]) => (
                <li key={label} className="flex items-start gap-2.5">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', on ? 'bg-ok' : 'bg-warn')} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{label}</span> <span className={on ? 'text-ok' : 'text-warn'}>{on ? 'connected' : 'not configured'}</span>
                    {!on && <span className="block text-xs text-faint">{off}</span>}
                  </span>
                </li>
              ))}
              <li className="flex items-center gap-2.5 border-t border-line pt-3 text-soft"><HardDrive className="size-4 text-faint" aria-hidden="true" />{plural(system.storedFiles, 'file')} · {formatBytes(system.storageBytes)} stored</li>
              <li className="flex items-center gap-2.5 text-soft"><UserPlus className="size-4 text-faint" aria-hidden="true" />Self-registration is {system.registrationOpen ? 'open' : 'closed'}</li>
              <li className="flex items-center gap-2.5 text-soft"><Server className="size-4 text-faint" aria-hidden="true" /><span>Running in <span className="font-medium text-ink">{system.environment}</span> mode</span></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
