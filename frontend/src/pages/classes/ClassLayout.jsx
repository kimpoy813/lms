// The frame around every page of one class: its header and the tabs.
import { useQuery } from '@tanstack/react-query';
import { Archive, BarChart3, BookOpen, CalendarDays, ChevronLeft, ClipboardList, FileQuestion, FolderOpen, GraduationCap, LayoutGrid, MapPin, Megaphone, MessagesSquare, Settings, UserCheck, Users } from 'lucide-react';
import { Suspense } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { Alert, Avatar, cn, PageLoader, QueryState, Tabs } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { classColor } from './classColors.js';
import { scheduleSummary } from './Classes.jsx';
import { classLabel } from './useClass.js';

export default function ClassLayout() {
  const { classId } = useParams();
  const location = useLocation();
  const query = useQuery({ queryKey: ['class', classId], queryFn: () => api.get(`/classes/${classId}`) });
  const base = `/classes/${classId}`;
  const segment = location.pathname.slice(base.length).split('/').filter(Boolean)[0] ?? '';

  return (
    <QueryState query={query}>
      {(cls) => {
        const canManage = cls.myRole !== 'STUDENT';
        const tabs = [
          { value: '', label: 'Overview', icon: LayoutGrid, to: base },
          { value: 'modules', label: 'Lessons', icon: BookOpen, to: `${base}/modules` },
          { value: 'assignments', label: 'Assignments', icon: ClipboardList, to: `${base}/assignments` },
          { value: 'quizzes', label: 'Quizzes', icon: FileQuestion, to: `${base}/quizzes` },
          { value: 'attendance', label: 'Attendance', icon: UserCheck, to: `${base}/attendance` },
          canManage
            ? { value: 'gradebook', label: 'Gradebook', icon: GraduationCap, to: `${base}/gradebook` }
            : { value: 'grades', label: 'Grades', icon: GraduationCap, to: `${base}/grades` },
          { value: 'discussions', label: 'Discussions', icon: MessagesSquare, to: `${base}/discussions` },
          { value: 'resources', label: 'Resources', icon: FolderOpen, to: `${base}/resources` },
          { value: 'announcements', label: 'Announcements', icon: Megaphone, to: `${base}/announcements` },
          { value: 'people', label: 'People', icon: Users, to: `${base}/people`, count: canManage ? cls.pendingCount : 0 },
          ...(canManage ? [
            { value: 'analytics', label: 'Analytics', icon: BarChart3, to: `${base}/analytics` },
            { value: 'settings', label: 'Settings', icon: Settings, to: `${base}/settings` },
          ] : []),
        ];
        const color = classColor(cls.color);
        return (
          <>
            <header className={cn('no-print relative -mx-4 -mt-6 mb-0 overflow-hidden bg-gradient-to-br px-4 pb-5 pt-6 text-white sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8', color.banner)}>
              <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-white/10" aria-hidden="true" />
              <Link to="/classes" className="relative inline-flex items-center gap-1 text-[13px] font-medium text-white/80 hover:text-white"><ChevronLeft className="size-4" aria-hidden="true" />All classes</Link>
              <div className="relative mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{classLabel(cls)}</h1>
                  <p className="mt-0.5 text-[15px] text-white/90">{cls.course.title}</p>
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-white/90 max-sm:hidden">
                  <span className="flex items-center gap-2"><Avatar name={cls.teacher.name} fileId={cls.teacher.avatarFileId} size={22} className="ring-1 ring-white/40" />{cls.teacher.name}</span>
                  <span className="flex items-center gap-1.5"><CalendarDays className="size-4 opacity-80" aria-hidden="true" />{scheduleSummary(cls.schedules)}</span>
                  {cls.room && <span className="flex items-center gap-1.5"><MapPin className="size-4 opacity-80" aria-hidden="true" />{cls.room}</span>}
                </div>
              </div>
            </header>
            <div className="no-print sticky top-16 z-10 -mx-4 mb-6 bg-surface px-4 shadow-[0_1px_0_var(--line)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
              <Tabs tabs={tabs} value={segment} className="border-b-0" />
            </div>
            {cls.status === 'ARCHIVED' && (
              <Alert tone="warn" title="This class is archived" className="mb-5">
                <span className="inline-flex items-center gap-1.5"><Archive className="size-4" aria-hidden="true" />Records are kept and can be viewed, but nothing can be changed.{canManage ? ' Restore the class in Settings to make changes.' : ''}</span>
              </Alert>
            )}
            <Suspense fallback={<PageLoader />}>
              <Outlet context={{ cls, canManage, isStudent: !canManage, base }} />
            </Suspense>
          </>
        );
      }}
    </QueryState>
  );
}
