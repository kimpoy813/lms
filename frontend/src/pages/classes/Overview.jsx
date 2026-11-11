// Class home: what is coming up, the latest announcements, and the class details.
import { useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarDays, CheckCircle2, ClipboardList, Clock, Copy, FileQuestion, KeyRound, Megaphone, MessageSquare, Target, UserCheck, Users } from 'lucide-react';
import { Link } from 'react-router';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Avatar, Badge, Button, Card, CardHeader, cn, EmptyState, ProgressBar, Skeleton } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { dueLabel, formatClock, formatDay, formatTime, plural, relativeTime } from '../../lib/format.js';
import { DAYS, useClass } from './useClass.js';

export default function Overview() {
  const { cls, canManage, base } = useClass();
  const assignments = useQuery({ queryKey: ['class', cls.id, 'assignments'], queryFn: () => api.get(`${base}/assignments`) });
  const quizzes = useQuery({ queryKey: ['class', cls.id, 'quizzes'], queryFn: () => api.get(`${base}/quizzes`) });
  const announcements = useQuery({ queryKey: ['announcements', { classId: cls.id }], queryFn: () => api.get('/announcements', { classId: cls.id, pageSize: 3 }) });
  const modules = useQuery({ queryKey: ['class', cls.id, 'modules'], queryFn: () => api.get(`${base}/modules`) });

  const now = Date.now();
  const upcoming = [
    ...(assignments.data ?? [])
      .filter((a) => (canManage ? a.status === 'PUBLISHED' && a.dueAt && new Date(a.dueAt).getTime() > now : a.window?.open && !['SUBMITTED', 'GRADED', 'RETURNED'].includes(a.myStatus)))
      .map((a) => ({ key: `a-${a.id}`, icon: ClipboardList, title: a.title, when: a.dueAt, text: dueLabel(a.dueAt), to: `${base}/assignments/${a.id}`, late: !canManage && a.dueAt && new Date(a.dueAt).getTime() < now, extra: canManage && a.stats ? `${a.stats.submitted} of ${a.stats.enrolled} submitted` : null })),
    ...(quizzes.data ?? [])
      .filter((q) => (canManage ? q.status === 'PUBLISHED' && q.availableUntil && new Date(q.availableUntil).getTime() > now : q.start?.ok || q.inProgressAttemptId))
      .map((q) => ({ key: `q-${q.id}`, icon: FileQuestion, title: q.title, when: q.availableUntil, text: q.availableUntil ? `Closes ${formatDay(q.availableUntil)}, ${formatTime(q.availableUntil)}` : 'No closing date', to: `${base}/quizzes/${q.id}`, extra: !canManage && q.inProgressAttemptId ? 'In progress' : null })),
  ].sort((a, b) => new Date(a.when ?? 8.64e15) - new Date(b.when ?? 8.64e15)).slice(0, 6);

  const lessonTotals = (modules.data ?? []).reduce((acc, m) => ({ done: acc.done + (m.completedLessons ?? 0), all: acc.all + (m.lessonCount ?? 0) }), { done: 0, all: 0 });
  const nextLesson = !canManage ? (modules.data ?? []).filter((m) => !m.locked).flatMap((m) => m.lessons.map((l) => ({ ...l, moduleTitle: m.title }))).find((l) => !l.completed && !l.locked) : null;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="min-w-0 space-y-5 lg:col-span-2">
        {canManage && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [UserCheck, 'Take attendance', `${base}/attendance`],
              [BookOpen, 'Add a lesson', `${base}/modules`],
              [ClipboardList, 'New assignment', `${base}/assignments?new=1`],
              [Megaphone, 'Post announcement', `${base}/announcements?new=1`],
            ].map(([Icon, label, to]) => (
              <Link key={label} to={to} className="flex flex-col items-start gap-2.5 rounded-2xl border border-line bg-surface p-4 text-sm font-semibold text-ink shadow-card transition-colors hover:border-brand hover:text-brand">
                <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand"><Icon className="size-[18px]" aria-hidden="true" /></span>
                {label}
              </Link>
            ))}
          </div>
        )}

        {!canManage && nextLesson && (
          <Card className="flex flex-wrap items-center gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><BookOpen className="size-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand">Continue learning</p>
              <p className="truncate font-semibold text-ink">{nextLesson.title}</p>
              <p className="truncate text-[13px] text-faint">{nextLesson.moduleTitle}{nextLesson.estimatedMinutes ? ` · about ${nextLesson.estimatedMinutes} min` : ''}</p>
            </div>
            <Button to={`${base}/modules/${nextLesson.moduleId}?lesson=${nextLesson.id}`}>Open lesson</Button>
          </Card>
        )}

        <Card>
          <CardHeader icon={Clock} title={canManage ? 'Upcoming deadlines' : 'Coming up'} />
          {assignments.isPending || quizzes.isPending ? <Skeleton className="h-24" /> : upcoming.length === 0 ? (
            <EmptyState compact icon={CheckCircle2} title={canManage ? 'No upcoming deadlines' : 'You are all caught up'} description={canManage ? 'Published assignments and quizzes with a deadline appear here.' : 'New assignments and quizzes will appear here.'} />
          ) : (
            <ul className="-mx-2">
              {upcoming.map((u) => (
                <li key={u.key}>
                  <Link to={u.to} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-raised">
                    <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', u.late ? 'bg-bad-soft text-bad' : 'bg-brand-soft text-brand')}><u.icon className="size-[18px]" aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{u.title}</span>
                      <span className={cn('block truncate text-xs', u.late ? 'text-bad' : 'text-faint')}>{u.text}</span>
                    </span>
                    {u.extra && <Badge tone="info">{u.extra}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader icon={Megaphone} title="Latest announcements" action={<Link to={`${base}/announcements`} className="text-[13px] font-medium text-brand hover:underline">See all</Link>} />
          {announcements.isPending ? <Skeleton className="h-24" /> : (announcements.data ?? []).length === 0 ? (
            <EmptyState compact icon={Megaphone} title="No announcements yet" action={canManage ? <Button size="sm" to={`${base}/announcements?new=1`}>Post the first one</Button> : null} />
          ) : (
            <ul className="divide-y divide-line">
              {announcements.data.map((a) => (
                <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                  <Link to={`${base}/announcements?open=${a.id}`} className="block hover:opacity-80">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{a.title}</span>
                      {a.isPinned && <Badge tone="brand">Pinned</Badge>}
                      {a.priority === 'URGENT' && <Badge tone="bad">Urgent</Badge>}
                      {a.priority === 'HIGH' && <Badge tone="warn">Important</Badge>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-soft">{a.excerpt}</span>
                    <span className="mt-1 block text-xs text-faint">{a.author.name} · {relativeTime(a.publishedAt ?? a.createdAt)}{a.commentCount > 0 ? ` · ${plural(a.commentCount, 'comment')}` : ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {(cls.syllabusHtml || cls.description || cls.learningOutcomes?.length > 0) && (
          <Card>
            <CardHeader icon={Target} title="About this class" />
            {cls.description && <p className="text-sm leading-relaxed text-soft">{cls.description}</p>}
            {cls.learningOutcomes?.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">Learning outcomes</h3>
                <ul className="space-y-1.5 text-sm text-soft">
                  {cls.learningOutcomes.map((o) => <li key={o} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />{o}</li>)}
                </ul>
              </>
            )}
            {cls.syllabusHtml && (
              <>
                <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">Syllabus</h3>
                <RichText html={cls.syllabusHtml} />
              </>
            )}
          </Card>
        )}
      </div>

      <div className="min-w-0 space-y-5">
        {canManage && cls.enrollmentCode && (
          <Card>
            <CardHeader icon={KeyRound} title="Class code" description={cls.enrollmentCodeEnabled ? 'Students join with this code.' : 'Joining with the code is switched off.'} />
            <div className="flex items-center gap-2">
              <code className={cn('flex-1 rounded-xl bg-raised px-4 py-3 text-center font-mono text-2xl font-bold tracking-[0.25em]', cls.enrollmentCodeEnabled ? 'text-ink' : 'text-faint line-through')}>{cls.enrollmentCode}</code>
              <Button variant="secondary" icon={Copy} aria-label="Copy the class code" onClick={() => navigator.clipboard?.writeText(cls.enrollmentCode).then(() => toast.success('Class code copied.'), () => toast.error('Could not copy. Select the code and copy it manually.'))} />
            </div>
            <p className="mt-3 flex items-center justify-between text-[13px] text-soft">
              <span className="flex items-center gap-1.5"><Users className="size-4 text-faint" aria-hidden="true" />{plural(cls.studentCount, 'student')}</span>
              {cls.pendingCount > 0 && <Link to={`${base}/people`} className="font-medium text-warn hover:underline">{cls.pendingCount} waiting for approval</Link>}
            </p>
          </Card>
        )}

        {!canManage && lessonTotals.all > 0 && (
          <Card>
            <CardHeader icon={BookOpen} title="My progress" />
            <p className="text-3xl font-bold tabular-nums text-ink">{Math.round((lessonTotals.done / lessonTotals.all) * 100)}%</p>
            <p className="mb-3 text-xs text-faint">{lessonTotals.done} of {plural(lessonTotals.all, 'lesson')} completed</p>
            <ProgressBar value={lessonTotals.done} max={lessonTotals.all} label="Lessons completed" />
          </Card>
        )}

        <Card>
          <CardHeader icon={Users} title="Teacher" />
          <div className="flex items-center gap-3">
            <Avatar name={cls.teacher.name} fileId={cls.teacher.avatarFileId} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">{cls.teacher.name}</p>
              <p className="truncate text-[13px] text-faint">{cls.teacher.position ?? 'Teacher'}</p>
            </div>
          </div>
          {cls.teacher.consultationHours && <p className="mt-3 text-[13px] text-soft"><span className="font-medium text-ink">Consultation hours:</span> {cls.teacher.consultationHours}</p>}
          {!canManage && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button to={`/messages?to=${cls.teacher.id}`} variant="secondary" size="sm" icon={MessageSquare}>Message</Button>
              <Button to="/consultations" variant="ghost" size="sm">Book a consultation</Button>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader icon={CalendarDays} title="Schedule" />
          {cls.schedules.length === 0 ? <p className="text-sm text-faint">No fixed weekly schedule.</p> : (
            <ul className="space-y-2 text-sm">
              {[...cls.schedules].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime)).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ink">{DAYS[s.dayOfWeek]}</span>
                  <span className="text-soft tabular-nums">{formatClock(s.startTime)} – {formatClock(s.endTime)}{s.room ? ` · ${s.room}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-line pt-3 text-xs text-faint">{cls.semester.name} · {cls.semester.academicYear.name} · {cls.course.units} {cls.course.units === 1 ? 'unit' : 'units'}</p>
        </Card>
      </div>
    </div>
  );
}
