// The signed-in frame: a sidebar tailored to the role, a top bar, and the page.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BookOpen, CalendarDays, ClipboardCheck, Code2, FileQuestion, GraduationCap, History, LayoutDashboard, Library, LogOut, Megaphone, Menu as MenuIcon,
  MessageSquare, Monitor, Moon, ScanLine, Search, Settings, ShieldCheck, Sparkles, Sun, Table2, UserCog, UserRound, Users, X,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Avatar, Badge, Button, cn, EmptyState, IconButton, Menu, MenuItem, PageLoader, Spinner } from '../components/ui.jsx';
import { toast } from '../components/toast.jsx';
import { api } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { fetchBadges } from '../lib/badges.js';
import { useLiveInterval, useOnReturn } from '../lib/live.js';
import { useSocketEvent } from '../lib/socket.js';
import { useTheme } from '../lib/theme.js';
import { SearchDialog } from './SearchDialog.jsx';

const NAV = {
  STUDENT: [
    { section: 'Learn', items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/classes', label: 'My classes', icon: BookOpen },
      { to: '/attendance/scan', label: 'Check in', icon: ScanLine },
      { to: '/grades', label: 'Grades', icon: GraduationCap },
      { to: '/programming', label: 'Coding practice', icon: Code2 },
    ] },
    { section: 'Connect', items: [
      { to: '/announcements', label: 'Announcements', icon: Megaphone },
      { to: '/messages', label: 'Messages', icon: MessageSquare, badge: 'messages' },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/consultations', label: 'Consultations', icon: Users },
    ] },
  ],
  TEACHER: [
    { section: 'Teach', items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/classes', label: 'Classes', icon: BookOpen },
      { to: '/question-banks', label: 'Question banks', icon: FileQuestion },
      { to: '/rubrics', label: 'Rubrics', icon: Table2 },
      { to: '/programming', label: 'Coding problems', icon: Code2 },
      { to: '/ai', label: 'AI studio', icon: Sparkles },
    ] },
    { section: 'Connect', items: [
      { to: '/announcements', label: 'Announcements', icon: Megaphone },
      { to: '/messages', label: 'Messages', icon: MessageSquare, badge: 'messages' },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/consultations', label: 'Consultations', icon: Users },
    ] },
  ],
  ADMIN: [
    { section: 'Institution', items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/admin/users', label: 'Users', icon: UserCog },
      { to: '/classes', label: 'Classes', icon: BookOpen },
      { to: '/admin/enrollments', label: 'Enrolment', icon: ClipboardCheck },
      { to: '/admin/catalog', label: 'Academic catalogue', icon: Library },
    ] },
    { section: 'Connect', items: [
      { to: '/announcements', label: 'Announcements', icon: Megaphone },
      { to: '/messages', label: 'Messages', icon: MessageSquare, badge: 'messages' },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    ] },
    { section: 'System', items: [
      { to: '/admin/permissions', label: 'Permissions', icon: ShieldCheck },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/audit', label: 'Audit log', icon: History },
    ] },
  ],
};

export function Logo({ className, compact = false }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <img src="/favicon.svg" alt="" className="size-8 rounded-[9px]" />
      {!compact && <span className="text-[17px] font-bold tracking-tight text-ink">EduSphere</span>}
    </span>
  );
}

function Sidebar({ onNavigate, messageCount }) {
  const { user, settings } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link to="/" onClick={onNavigate} aria-label="EduSphere home"><Logo /></Link>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4 pt-2" aria-label="Main">
        {NAV[user.role].map((group) => (
          <div key={group.section}>
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-faint">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} onClick={onNavigate} className={({ isActive }) => cn('group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors', isActive ? 'bg-brand-soft text-brand' : 'text-soft hover:bg-raised hover:text-ink')}>
                    <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badge === 'messages' && messageCount > 0 && <span className="rounded-full bg-brand-fill px-1.5 text-[11px] font-bold leading-5 text-white" aria-label={`${messageCount} unread`}>{messageCount > 99 ? '99+' : messageCount}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-line px-5 py-3 text-xs text-faint">
        <p className="truncate font-medium text-soft">{settings['institution.name'] ?? 'EduSphere'}</p>
        <p>{{ STUDENT: 'Student portal', TEACHER: 'Teacher portal', ADMIN: 'Administration' }[user.role]}</p>
      </div>
    </div>
  );
}

function ThemeMenu() {
  const { preference, dark, setTheme } = useTheme();
  const options = [['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Match device', Monitor]];
  return (
    <Menu trigger={({ toggle, props }) => <IconButton icon={dark ? Moon : Sun} label="Colour theme" onClick={toggle} {...props} />}>
      {options.map(([value, label, Icon]) => (
        <MenuItem key={value} icon={Icon} onClick={() => setTheme(value)} aria-current={preference === value || undefined}>
          <span className="flex items-center justify-between gap-3">{label}{preference === value && <span className="size-1.5 rounded-full bg-brand" aria-label="selected" />}</span>
        </MenuItem>
      ))}
    </Menu>
  );
}

function NotificationBell() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const count = useQuery({ queryKey: ['notifications', 'count'], queryFn: async () => ({ unread: (await fetchBadges()).notifications }), refetchInterval: useLiveInterval(60_000, 120_000) });
  const list = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get('/notifications', { pageSize: 8 }), enabled: open });
  const unread = count.data?.unread ?? 0;

  useSocketEvent('notification:new', useCallback((n) => {
    client.invalidateQueries({ queryKey: ['notifications'] });
    client.invalidateQueries({ queryKey: ['dashboard'] });
    toast.info(n.title);
  }, [client]));

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !e.target.closest('[data-notifications]') && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const openItem = async (n) => {
    setOpen(false);
    if (!n.readAt) {
      api.post(`/notifications/${n.id}/read`).then(() => client.invalidateQueries({ queryKey: ['notifications'] })).catch(() => {});
    }
    if (n.link) navigate(n.link);
  };
  const readAll = async () => {
    await api.post('/notifications/read-all');
    client.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div className="relative" data-notifications>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} className="relative inline-flex size-10 items-center justify-center rounded-lg text-soft hover:bg-raised hover:text-ink">
        <Bell className="size-5" aria-hidden="true" />
        {unread > 0 && <span className="absolute right-1 top-1 grid min-w-[18px] place-items-center rounded-full bg-bad px-1 text-[10px] font-bold leading-[18px] text-white dark:text-[#2a0a12]">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="animate-pop absolute right-0 z-40 mt-1.5 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop max-sm:fixed max-sm:inset-x-3 max-sm:top-16 max-sm:w-auto">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && <button type="button" onClick={readAll} className="text-[13px] font-medium text-brand hover:underline">Mark all as read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {list.isPending ? <div className="grid place-items-center py-10"><Spinner /></div>
              : (list.data ?? []).length === 0 ? <EmptyState compact icon={Bell} title="You are all caught up" description="New grades, announcements and reminders appear here." />
                : (
                  <ul>
                    {list.data.map((n) => (
                      <li key={n.id}>
                        <button type="button" onClick={() => openItem(n)} className="flex w-full gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-raised">
                          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand')} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className={cn('block text-sm leading-snug', n.readAt ? 'text-soft' : 'font-semibold text-ink')}>{n.title}</span>
                            {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] text-faint">{n.body}</span>}
                            <span className="mt-1 block text-xs text-faint">{relativeTime(n.createdAt)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-[13px] font-medium text-brand hover:bg-raised">See all notifications</Link>
        </div>
      )}
    </div>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };
  return (
    <Menu trigger={({ toggle, props }) => (
      <button type="button" onClick={toggle} {...props} className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-2 hover:bg-raised" aria-label="Account menu">
        <Avatar name={user.name} fileId={user.avatarFileId} size={34} />
        <span className="hidden min-w-0 text-left md:block">
          <span className="block max-w-[10rem] truncate text-sm font-semibold leading-tight text-ink">{user.name}</span>
          <span className="block text-xs leading-tight text-faint">{{ STUDENT: 'Student', TEACHER: 'Teacher', ADMIN: 'Administrator' }[user.role]}</span>
        </span>
      </button>
    )}>
      <div className="border-b border-line px-2.5 pb-2 pt-1">
        <p className="truncate text-sm font-semibold">{user.name}</p>
        <p className="truncate text-xs text-faint">{user.email}</p>
        {user.isDemo && <Badge tone="warn" className="mt-1.5">Demo account</Badge>}
      </div>
      <div className="pt-1.5">
        <MenuItem icon={UserRound} to="/profile">Profile and security</MenuItem>
        <MenuItem icon={Bell} to="/notifications">Notifications</MenuItem>
        <MenuItem icon={LogOut} onClick={signOut} tone="danger">Sign out</MenuItem>
      </div>
    </Menu>
  );
}

export default function AppShell() {
  const location = useLocation();
  const client = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState(false);
  const messages = useQuery({ queryKey: ['messages', 'unread'], queryFn: async () => ({ count: (await fetchBadges()).messages }), refetchInterval: useLiveInterval(60_000, 120_000) });

  // Back at the keyboard after a pause: the two header numbers were not refreshed meanwhile.
  useOnReturn(useCallback(() => {
    client.invalidateQueries({ queryKey: ['notifications', 'count'] });
    client.invalidateQueries({ queryKey: ['messages', 'unread'] });
  }, [client]));

  useSocketEvent('message:new', useCallback((m) => {
    client.invalidateQueries({ queryKey: ['messages'] });
    if (!window.location.pathname.startsWith('/messages')) toast.info(`New message from ${m.from?.name ?? 'someone'}`);
  }, [client]));

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setDrawer(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand-fill focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white">Skip to content</a>

      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block">
        <Sidebar messageCount={messages.data?.count ?? 0} />
      </aside>

      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="animate-in absolute inset-0 bg-[#0b0d17]/55" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-[min(18rem,85vw)] border-r border-line bg-surface shadow-pop">
            <IconButton icon={X} label="Close menu" onClick={() => setDrawer(false)} className="absolute right-2 top-3" />
            <Sidebar onNavigate={() => setDrawer(false)} messageCount={messages.data?.count ?? 0} />
          </aside>
        </div>
      )}

      <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-surface/85 px-3 backdrop-blur-md sm:px-5">
        <IconButton icon={MenuIcon} label="Open menu" onClick={() => setDrawer(true)} className="lg:hidden" />
        <Link to="/" className="lg:hidden" aria-label="EduSphere home"><Logo compact /></Link>
        <button type="button" onClick={() => setSearch(true)} className="ml-1 hidden h-10 w-full max-w-md items-center gap-2.5 rounded-xl border border-line bg-canvas px-3 text-sm text-faint transition-colors hover:border-line-strong sm:flex" aria-label="Search">
          <Search className="size-4" aria-hidden="true" />
          <span className="flex-1 text-left">Search classes, lessons, people…</span>
          <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] font-medium text-faint">Ctrl K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={Search} label="Search" onClick={() => setSearch(true)} className="sm:hidden" />
          <ThemeMenu />
          <NotificationBell />
          <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
          <ProfileMenu />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] px-4 py-6 outline-none sm:px-6 lg:px-8">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>

      {search && <SearchDialog onClose={() => setSearch(false)} />}
    </div>
  );
}

/** Shown by the router when a page throws while rendering. */
/** True when a page's code could not be downloaded — usually because a new version was deployed. */
const isChunkError = (error) => /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(String(error?.message ?? ''));

export function PageError({ error, reset }) {
  const stale = isChunkError(error);
  return (
    <div className="grid min-h-[50vh] place-items-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold">{stale ? 'This page needs to be reloaded' : 'This page could not be displayed'}</h1>
        <p className="mt-2 text-sm text-soft">{stale ? 'Part of the app could not be downloaded. You may be offline, or a newer version of EduSphere was just installed. Reloading fixes it.' : 'Something went wrong while showing this page. Your data is safe — try again, or go back to the dashboard.'}</p>
        {import.meta.env.DEV && error && <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-raised p-3 text-left text-xs text-bad">{String(error?.stack ?? error)}</pre>}
        <div className="mt-5 flex justify-center gap-2">
          {/* A lazily loaded page that failed to download stays failed until the document is reloaded. */}
          <Button variant={stale ? 'primary' : 'secondary'} onClick={stale || !reset ? () => window.location.reload() : reset}>{stale ? 'Reload' : 'Try again'}</Button>
          {!stale && <Button to="/">Go to dashboard</Button>}
        </div>
      </div>
    </div>
  );
}
