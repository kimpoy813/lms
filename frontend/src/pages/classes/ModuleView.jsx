// One module: chapter-by-chapter reading or full-module "book view".
// Teachers write and edit chapters here; students read them like a textbook and mark chapters as completed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, BookOpen, BookText, Check, CheckCircle2, ChevronLeft, Circle, ClipboardList, Clock, Download, FilePlus2, FileQuestion, Fullscreen, HelpCircle, Layers, Lock, Maximize2, Minimize2, MoreHorizontal, Pencil, Plus, Printer, RotateCcw, Save, Share2, Shrink, Sparkles, Target, Trash2, Type, Undo2, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { AlsoPostToClasses, PostToClassesModal } from '../../components/ClassTargets.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { LearningFeaturesEditor, LearningVisual, QuickCheck } from '../../components/LearningFeatures.jsx';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, PageLoader, ProgressBar, QueryState, Segmented, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { plural, relativeTime } from '../../lib/format.js';
import { useBookNavigation } from '../../lib/bookNavigation.js';
import { getOfflineLesson, getOfflineModuleBook, isLessonSavedOffline, removeOfflineLesson, saveLessonOffline } from '../../lib/offlineLessons.js';
import { useAction } from '../../lib/query.js';
import AssignmentDialog from './AssignmentDialog.jsx';
import AssignmentDraftDialog from './AssignmentDraftDialog.jsx';
import QuizDialog from './QuizDialog.jsx';
import { LESSON_KINDS } from './Modules.jsx';
import { ResourceDialog, ResourceItem } from './ResourceParts.jsx';
import { useClass } from './useClass.js';

const READER_PREFS_KEY = 'discenda.readerPrefs';
const BOOK_POSITION_END = '__end_of_book__';
const DEFAULT_READER_PREFS = { font: 'serif', size: 'md', focus: false };

function bookPositionKey(userId, moduleId) {
  return userId && moduleId ? `discenda.bookPosition.v1.${userId}.${moduleId}` : null;
}

function readBookPosition(userId, moduleId) {
  const key = bookPositionKey(userId, moduleId);
  if (!key || typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeBookPosition(userId, moduleId, position) {
  const key = bookPositionKey(userId, moduleId);
  if (!key || typeof window === 'undefined') return;
  try {
    if (position) window.localStorage?.setItem(key, position);
    else window.localStorage?.removeItem(key);
  } catch {
    // Reading still works if storage is unavailable or full.
  }
}

function useReaderPrefs() {
  const [prefs, setPrefs] = useState(() => {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_READER_PREFS;
    try {
      const saved = JSON.parse(window.localStorage.getItem(READER_PREFS_KEY) || '{}');
      return {
        font: saved.font === 'sans' ? 'sans' : 'serif',
        size: ['sm', 'md', 'lg'].includes(saved.size) ? saved.size : 'md',
        focus: Boolean(saved.focus),
      };
    } catch {
      return DEFAULT_READER_PREFS;
    }
  });
  const update = (patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage?.setItem(READER_PREFS_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };
  return [prefs, update];
}

function bookTextClasses(prefs) {
  return cn(
    'rich-book mx-auto',
    prefs.font === 'serif' && 'rich-book-serif',
    prefs.size === 'sm' ? 'rich-book-sm' : prefs.size === 'lg' ? 'rich-book-lg' : '',
  );
}

function formatDuration(minutes) {
  const m = Number(minutes) || 0;
  if (m <= 0) return null;
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function ReaderControls({ prefs, onChange, isFullscreen, onToggleFullscreen }) {
  return (
    <div className="no-print grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:gap-1.5" role="group" aria-label="Reading display options">
      <div className="inline-flex w-full items-center justify-center rounded-lg border border-line bg-surface p-0.5 text-xs sm:w-auto sm:justify-start">
        <button
          type="button"
          onClick={() => onChange({ font: 'serif' })}
          aria-pressed={prefs.font === 'serif'}
          className={cn('rounded-md px-2 py-1 font-serif font-medium transition-colors', prefs.font === 'serif' ? 'bg-brand-soft text-brand' : 'text-soft hover:text-ink')}
          title="Book serif font"
        >
          Serif
        </button>
        <button
          type="button"
          onClick={() => onChange({ font: 'sans' })}
          aria-pressed={prefs.font === 'sans'}
          className={cn('rounded-md px-2 py-1 font-sans font-medium transition-colors', prefs.font === 'sans' ? 'bg-brand-soft text-brand' : 'text-soft hover:text-ink')}
          title="Clean sans-serif font"
        >
          Sans
        </button>
      </div>
      <div className="inline-flex w-full items-center justify-center rounded-lg border border-line bg-surface p-0.5 text-xs sm:w-auto sm:justify-start">
        <span className="px-1.5 text-faint" aria-hidden="true"><Type className="size-3.5" /></span>
        {[
          ['sm', 'A−', 'Smaller text'],
          ['md', 'A', 'Default text size'],
          ['lg', 'A+', 'Larger text'],
        ].map(([val, label, title]) => (
          <button
            key={val}
            type="button"
            onClick={() => onChange({ size: val })}
            aria-label={title}
            aria-pressed={prefs.size === val}
            title={title}
            className={cn('min-w-8 rounded-md px-2 py-1 font-semibold transition-colors', prefs.size === val ? 'bg-brand-soft text-brand' : 'text-soft hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      <Button
        variant={prefs.focus ? 'soft' : 'ghost'}
        size="sm"
        icon={prefs.focus ? Minimize2 : Maximize2}
        aria-pressed={prefs.focus}
        onClick={() => onChange({ focus: !prefs.focus })}
        className="hidden lg:inline-flex"
      >
        {prefs.focus ? 'Show contents' : 'Focus mode'}
      </Button>
      <Button
        variant={isFullscreen ? 'soft' : 'ghost'}
        size="sm"
        icon={isFullscreen ? Shrink : Fullscreen}
        aria-pressed={isFullscreen}
        onClick={onToggleFullscreen}
        title={isFullscreen ? 'Exit full screen (or press Escape)' : 'View lesson full screen'}
        className="col-span-2 w-full justify-center sm:col-span-1 sm:w-auto"
      >
        {isFullscreen ? 'Exit full screen' : 'Full screen'}
      </Button>
    </div>
  );
}

export default function ModuleView() {
  const { user } = useAuth();
  const { cls, canManage, base } = useClass();
  const { moduleId } = useParams();
  const [params, setParams] = useSearchParams();
  const [prefs, updatePrefs] = useReaderPrefs();
  const readerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const query = useQuery({ queryKey: ['class', cls.id, 'modules', moduleId], queryFn: () => api.get(`/modules/${moduleId}`) });
  const creating = canManage && params.get('new') === '1';
  const viewMode = !creating && params.get('view') === 'book' ? 'book' : 'chapter';
  const lessonId = params.get('lesson');
  const offlineFallback = lessonId ? getOfflineLesson(user?.id, lessonId) : getOfflineModuleBook(user?.id, moduleId);
  const effectiveQuery = query.isError && query.error?.code === 'NETWORK' && offlineFallback?.mod?.id === moduleId
    ? { ...query, isError: false, isSuccess: true, data: offlineFallback.mod }
    : query;

  useEffect(() => {
    const syncFullscreen = () => {
      const current = document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
      setIsFullscreen(current === readerRef.current);
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncFullscreen);
    };
  }, []);

  const toggleFullscreen = async () => {
    const reader = readerRef.current;
    if (!reader) return;
    const current = document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
    const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
    const request = reader.requestFullscreen ?? reader.webkitRequestFullscreen;
    try {
      if (current === reader) {
        if (exit) await exit.call(document);
        return;
      }
      if (current && exit) await exit.call(document);
      if (!request) {
        updatePrefs({ focus: true });
        toast.info('This browser does not support full screen for lessons. Focus mode has been enabled instead.');
        return;
      }
      await request.call(reader);
    } catch {
      updatePrefs({ focus: true });
      toast.info('The browser could not open full screen. Focus mode has been enabled instead.');
    }
  };

  // In chapter view, automatically open the first unfinished unlocked chapter (unless already in book view).
  useEffect(() => {
    if (!effectiveQuery.data || viewMode === 'book' || lessonId || creating) return;
    const lessons = effectiveQuery.data.lessons;
    const first = (canManage ? lessons[0] : lessons.find((l) => !l.completed && !l.locked) ?? lessons.find((l) => !l.locked));
    if (first) setParams({ lesson: first.id }, { replace: true });
  }, [effectiveQuery.data, viewMode, lessonId, creating, canManage, setParams]);

  const switchView = (next, mod) => {
    const currentChapterId = lessonId ?? params.get('chapter');
    if (next === 'book') {
      setParams({ view: 'book', ...(currentChapterId ? { chapter: currentChapterId } : {}) });
      return;
    }
    const targetLesson = currentChapterId
      || (canManage ? mod.lessons[0]?.id : (mod.lessons.find((l) => !l.completed && !l.locked) ?? mod.lessons.find((l) => !l.locked))?.id);
    setParams(targetLesson ? { lesson: targetLesson } : {});
  };

  return (
    <QueryState query={effectiveQuery}>
      {(mod) => (
        <div
          ref={readerRef}
          data-module-reader
          className={cn('min-w-0', isFullscreen && 'min-h-dvh overflow-y-auto bg-canvas p-3 sm:p-6')}
        >
          <div className="no-print mb-4 space-y-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Link to={`${base}/modules`} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-soft hover:text-brand sm:text-sm"><ChevronLeft className="size-4" aria-hidden="true" />All lessons</Link>
              <span className="shrink-0 text-line-strong" aria-hidden="true">/</span>
              <h2 className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-ink sm:truncate sm:text-lg">{mod.title}</h2>
              {canManage && <span className="shrink-0"><StatusBadge status={mod.status} publishAt={mod.publishAt} /></span>}
            </div>
            {!creating && mod.lessons.length > 0 && (canManage || !mod.locked) && (
              <div className="grid gap-2.5 border-b border-line pb-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
                <Segmented
                  label="Module reading mode"
                  value={viewMode}
                  onChange={(next) => switchView(next, mod)}
                  className="w-full sm:w-auto"
                  options={[
                    { value: 'chapter', label: 'Chapter view', icon: BookText },
                    { value: 'book', label: 'Read as book', icon: BookOpen },
                  ]}
                />
                <ReaderControls prefs={prefs} onChange={updatePrefs} isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
              </div>
            )}
          </div>
          {!canManage && mod.locked ? (
            <Card><EmptyState icon={Lock} title="This module is locked" description={mod.lockedReason} action={<Button to={`${base}/modules`}>Back to lessons</Button>} /></Card>
          ) : viewMode === 'book' && mod.lessons.length > 0 ? (
            <BookReader key={mod.id} modSummary={mod} prefs={prefs} />
          ) : (
            <div className={cn('grid grid-cols-1 gap-5', prefs.focus ? 'mx-auto max-w-4xl' : 'lg:grid-cols-[18rem_minmax(0,1fr)]')}>
              <LessonList mod={mod} activeId={creating ? null : lessonId} focus={prefs.focus} />
              <div className="min-w-0">
                {creating ? <LessonEditor mod={mod} onDone={(saved) => setParams(saved ? { lesson: saved.id } : mod.lessons[0] ? { lesson: mod.lessons[0].id } : {}, { replace: true })} />
                  : lessonId ? <Lesson key={lessonId} mod={mod} lessonId={lessonId} prefs={prefs} />
                    : mod.lessons.length === 0 ? (
                      <Card><EmptyState icon={FilePlus2} title="This module has no lessons yet" description={canManage ? 'Write the first lesson: text, pictures, videos and attachments.' : 'Check back soon.'} action={canManage ? <Button icon={Plus} onClick={() => setParams({ new: '1' })}>Add a lesson</Button> : null} /></Card>
                    ) : <PageLoader />}
              </div>
            </div>
          )}
        </div>
      )}
    </QueryState>
  );
}

function LessonList({ mod, activeId, focus = false }) {
  const { canManage, base } = useClass();
  const [, setParams] = useSearchParams();
  const activeIndex = mod.lessons.findIndex((l) => l.id === activeId);
  const completedCount = mod.lessons.filter((l) => l.completed).length;
  return (
    <aside className={cn('no-print lg:sticky lg:top-32 lg:self-start', focus && 'lg:hidden')}>
      {/* A compact picker on phones, the full table of contents on larger screens. */}
      <div className="lg:hidden">
        <Card padded={false} className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand">Chapters</p>
              <p className="mt-0.5 text-xs text-faint">{activeIndex >= 0 ? `Chapter ${activeIndex + 1} of ${mod.lessons.length}` : `${mod.lessons.length} chapters`}</p>
            </div>
            {!canManage && <span className="shrink-0 text-xs font-medium tabular-nums text-soft">{completedCount}/{mod.lessons.length} complete</span>}
          </div>
          <div className="p-3">
            <Select aria-label="Choose a chapter" value={activeId ?? ''} onChange={(e) => setParams({ lesson: e.target.value })}>
              {!activeId && <option value="">Choose a chapter…</option>}
              {mod.lessons.map((l, i) => <option key={l.id} value={l.id} disabled={!canManage && l.locked}>Ch. {i + 1}: {l.title}{!canManage && l.completed ? ' (done)' : ''}</option>)}
            </Select>
            {!canManage && mod.lessonCount > 0 && (
              <div className="mt-3 flex items-center gap-2.5 text-xs text-faint">
                <ProgressBar value={mod.progressPercent} tone={mod.progressPercent === 100 ? 'ok' : 'brand'} label="Module reading progress" className="h-1.5" />
                <span className="shrink-0 tabular-nums">{mod.progressPercent}%</span>
              </div>
            )}
          </div>
        </Card>
      </div>
      <Card padded={false} className="hidden lg:block">
        {(mod.description || mod.objectives.length > 0) && (
          <div className="border-b border-line p-4">
            {mod.description && <p className="text-[13px] leading-relaxed text-soft">{mod.description}</p>}
            {mod.objectives.length > 0 && (
              <ul className="mt-2.5 space-y-1.5 text-[13px] text-soft">
                {mod.objectives.map((o) => <li key={o} className="flex gap-2"><Target className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden="true" />{o}</li>)}
              </ul>
            )}
          </div>
        )}
        <nav aria-label="Chapters in this module" className="p-2">
          <ol>
            {mod.lessons.map((l, i) => {
              const locked = !canManage && l.locked;
              const content = (
                <>
                  {canManage ? <span className="grid size-5 shrink-0 place-items-center text-xs font-semibold tabular-nums text-faint">{i + 1}</span>
                    : l.completed ? <CheckCircle2 className="size-[18px] shrink-0 text-ok" aria-label="Completed" /> : locked ? <Lock className="size-[18px] shrink-0 text-faint" aria-label="Locked" /> : <Circle className="size-[18px] shrink-0 text-line-strong" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{l.title}</span>
                  {canManage && l.status === 'DRAFT' && <span className="size-2 shrink-0 rounded-full bg-warn" title="Draft" aria-label="Draft" />}
                </>
              );
              return (
                <li key={l.id}>
                  {locked ? <span className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-faint">{content}</span>
                    : <Link to={`${base}/modules/${mod.id}?lesson=${l.id}`} aria-current={l.id === activeId ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2', l.id === activeId ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-raised')}>{content}</Link>}
                </li>
              );
            })}
          </ol>
          {canManage && <Button variant="ghost" size="sm" icon={Plus} className="mt-1 w-full justify-start" onClick={() => setParams({ new: '1' })}>Add a lesson</Button>}
        </nav>
      </Card>
    </aside>
  );
}

function BookPageNavigation({ label, page, total, canPrevious, canNext, onPrevious, onNext, showHint = false, helpId }) {
  const progress = total > 1 ? Math.round(((page - 1) / (total - 1)) * 100) : 0;
  return (
    <div className="no-print">
      <div className="mb-2 flex items-center gap-2.5">
        <ProgressBar value={progress} label="Progress through this book" className="h-1.5" />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-faint">{progress}%</span>
      </div>
      <nav aria-label="Book page navigation" className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface/80 p-2 sm:px-3 sm:py-2.5">
        <Button variant="secondary" size="sm" icon={ArrowLeft} disabled={!canPrevious} onClick={onPrevious} aria-label="Previous page" className="shrink-0">
          Previous
        </Button>
        <span className="min-w-0 text-center text-xs font-medium text-soft">
          <span className="block truncate">{label}</span>
          <span className="block text-faint tabular-nums">Page {page} of {total}</span>
        </span>
        <Button variant="secondary" size="sm" icon={ArrowRight} disabled={!canNext} onClick={onNext} aria-label="Next page" className="shrink-0">
          Next
        </Button>
      </nav>
      {showHint && <p id={helpId} className="mt-1.5 text-center text-xs text-faint">Swipe left or right, use a horizontal trackpad gesture, or focus the reader and press ← / →.</p>}
    </div>
  );
}

function BookReader({ modSummary, prefs }) {
  const { user } = useAuth();
  const { cls, canManage, base } = useClass();
  const [params, setParams] = useSearchParams();
  const [savingId, setSavingId] = useState(null);
  const lastPage = (modSummary.lessons?.length ?? 0) + 1;
  const initialChapterIndex = (modSummary.lessons ?? []).findIndex((chapter) => chapter.id === params.get('chapter'));
  const [pageIndex, setPageIndex] = useState(() => (
    params.get('end') === '1' ? lastPage : initialChapterIndex >= 0 ? initialChapterIndex + 1 : 0
  ));
  const [resumePosition, setResumePosition] = useState(() => readBookPosition(user?.id, modSummary.id));
  const [turnDirection, setTurnDirection] = useState(null);
  const pageStartRef = useRef(null);
  const goToPage = (nextPage) => {
    if (nextPage < 0 || nextPage > lastPage || nextPage === pageIndex) return;
    setTurnDirection(nextPage > pageIndex ? 'next' : 'previous');
    setPageIndex(nextPage);
    const nextPosition = nextPage === lastPage ? BOOK_POSITION_END : nextPage === 0 ? null : modSummary.lessons?.[nextPage - 1]?.id ?? null;
    writeBookPosition(user?.id, modSummary.id, nextPosition);
    setResumePosition(nextPosition);
    const nextParams = { view: 'book' };
    if (nextPosition === BOOK_POSITION_END) nextParams.end = '1';
    else if (nextPosition) nextParams.chapter = nextPosition;
    setParams(nextParams, { replace: true });
  };
  const pageNavigation = useBookNavigation({
    canPrevious: pageIndex > 0,
    canNext: pageIndex < lastPage,
    onPrevious: () => goToPage(pageIndex - 1),
    onNext: () => goToPage(pageIndex + 1),
  });

  useEffect(() => {
    if (pageIndex === 0) return;
    const position = pageIndex === lastPage ? BOOK_POSITION_END : modSummary.lessons?.[pageIndex - 1]?.id;
    if (!position) return;
    writeBookPosition(user?.id, modSummary.id, position);
    setResumePosition((current) => (current === position ? current : position));
  }, [lastPage, modSummary.id, modSummary.lessons, pageIndex, user?.id]);

  const [offlineMap, setOfflineMap] = useState(() => {
    const map = {};
    for (const l of modSummary.lessons ?? []) map[l.id] = isLessonSavedOffline(user?.id, l.id);
    return map;
  });

  const bookQuery = useQuery({
    queryKey: ['class', cls.id, 'modules', modSummary.id, 'book'],
    queryFn: () => api.get(`/modules/${modSummary.id}/book`),
  });
  const offlineBook = getOfflineModuleBook(user?.id, modSummary.id);
  const readingOffline = Boolean(bookQuery.isError && bookQuery.error?.code === 'NETWORK' && offlineBook);
  const effectiveQuery = readingOffline
    ? { ...bookQuery, isError: false, isSuccess: true, data: offlineBook.book }
    : bookQuery;

  const readerReady = Boolean(effectiveQuery.data);

  useEffect(() => {
    if (!readerReady) return;
    pageStartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pageIndex, readerReady]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, lastPage));
  }, [lastPage]);

  const invalidate = [['class', cls.id], ['dashboard']];
  const toggleComplete = useAction(({ lessonId, done }) => (
    done ? api.post(`/lessons/${lessonId}/complete`) : api.delete(`/lessons/${lessonId}/complete`)
  ), { invalidate });
  const toggleBookmark = useAction(({ lessonId, on }) => (
    on ? api.post('/bookmarks', { lessonId }) : api.delete('/bookmarks', { lessonId })
  ), { invalidate: [['class', cls.id, 'modules', modSummary.id, 'book'], ['bookmarks']] });

  const toggleOfflineChapter = async (mod, ch) => {
    setSavingId(ch.id);
    try {
      if (offlineMap[ch.id]) {
        await removeOfflineLesson(user?.id, ch.id);
        setOfflineMap((m) => ({ ...m, [ch.id]: false }));
        toast.info('Removed offline copy from this device.');
      } else {
        const entry = await saveLessonOffline(user?.id, { mod, lesson: ch });
        setOfflineMap((m) => ({ ...m, [ch.id]: true }));
        toast.success(`Saved Chapter ${ch.chapterNumber} offline${entry.cachedFiles > 0 ? ` (${entry.cachedFiles} file${entry.cachedFiles === 1 ? '' : 's'} cached)` : ''}.`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingId(null);
    }
  };

  if (effectiveQuery.isError && effectiveQuery.error?.code === 'MODULE_LOCKED') {
    return <Card><EmptyState icon={Lock} title="This module is locked" description={effectiveQuery.error.message} /></Card>;
  }

  return (
    <QueryState query={effectiveQuery}>
      {(book) => {
        const chapters = book.chapters ?? [];
        const totalReadTime = formatDuration(book.totalEstimatedMinutes || chapters.reduce((s, c) => s + (Number(c.estimatedMinutes) || 0), 0));
        const completedCount = chapters.filter((c) => c.completed).length;
        const progressPercent = chapters.length ? Math.round((completedCount / chapters.length) * 100) : 0;
        const resumeChapterIndex = chapters.findIndex((chapter) => chapter.id === resumePosition);
        const resumePageIndex = resumePosition === BOOK_POSITION_END ? chapters.length + 1 : resumeChapterIndex >= 0 ? resumeChapterIndex + 1 : 0;
        const resumeChapter = resumeChapterIndex >= 0 ? chapters[resumeChapterIndex] : null;
        const activeChapter = pageIndex > 0 && pageIndex <= chapters.length ? chapters[pageIndex - 1] : null;
        const pageLabel = pageIndex === 0
          ? 'Module cover'
          : activeChapter
            ? `Chapter ${activeChapter.chapterNumber} of ${chapters.length}: ${activeChapter.title}`
            : `End of ${book.title}`;
        const pageAnnouncement = pageIndex === 0
          ? `Module cover: ${book.title}`
          : activeChapter
            ? `Chapter ${activeChapter.chapterNumber} of ${chapters.length}: ${activeChapter.title}`
            : `End of ${book.title}`;
        const scrollToChapter = (id) => {
          const index = chapters.findIndex((chapter) => chapter.id === id);
          if (index >= 0) goToPage(index + 1);
        };

        return (
          <div
            ref={pageStartRef}
            data-book-reader
            role="region"
            tabIndex={0}
            aria-label={`Book reader: ${book.title}`}
            aria-describedby={`book-page-turn-help-${modSummary.id}`}
            {...pageNavigation}
            className={cn('book-reader-surface grid min-w-0 grid-cols-1 gap-4 sm:gap-6', prefs.focus ? 'mx-auto max-w-4xl' : 'lg:grid-cols-[18rem_minmax(0,1fr)]')}
          >
            <p className="sr-only" aria-live="polite" aria-atomic="true">{pageAnnouncement}</p>
            <aside className={cn('no-print lg:sticky lg:top-32 lg:self-start', prefs.focus && 'lg:hidden')}>
              <div className="lg:hidden">
                <Card padded={false} className="overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand">Table of contents</p>
                      {totalReadTime && <p className="mt-0.5 flex items-center gap-1 text-xs text-faint"><Clock className="size-3.5" aria-hidden="true" />About {totalReadTime} total</p>}
                    </div>
                    <span className="shrink-0 text-xs font-medium tabular-nums text-soft">{canManage ? `${chapters.length} chapters` : `${completedCount}/${chapters.length} complete`}</span>
                  </div>
                  {!canManage && chapters.length > 0 && (
                    <div className="flex items-center gap-2.5 px-3.5 pt-3 text-xs text-faint">
                      <ProgressBar value={progressPercent} tone={progressPercent === 100 ? 'ok' : 'brand'} label="Module reading progress" className="h-1.5" />
                      <span className="shrink-0 tabular-nums">{progressPercent}%</span>
                    </div>
                  )}
                  <div className="p-3">
                    <Select
                      aria-label="Jump to chapter"
                      value={activeChapter ? String(pageIndex - 1) : ''}
                      onChange={(e) => goToPage(Number(e.target.value) + 1)}
                    >
                      <option value="" disabled>Jump to chapter…</option>
                      {chapters.map((ch, index) => (
                        <option key={ch.id} value={index}>
                          Ch. {ch.chapterNumber}: {ch.title}{!canManage && ch.completed ? ' (done)' : !canManage && ch.locked ? ' (locked)' : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Card>
              </div>
              <Card padded={false} className="hidden lg:block">
                <div className="border-b border-line p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand">Table of contents</p>
                  {!canManage && chapters.length > 0 && (
                    <div className="mt-2.5 flex items-center gap-2.5 text-xs text-faint">
                      <ProgressBar value={progressPercent} tone={progressPercent === 100 ? 'ok' : 'brand'} label="Module reading progress" className="h-1.5" />
                      <span className="shrink-0 tabular-nums">{completedCount}/{chapters.length}</span>
                    </div>
                  )}
                  {totalReadTime && <p className="mt-2 flex items-center gap-1 text-xs text-faint"><Clock className="size-3.5" aria-hidden="true" />About {totalReadTime} total</p>}
                </div>
                <nav aria-label="Module book table of contents" className="max-h-[65vh] overflow-y-auto p-2">
                  <ol className="space-y-0.5">
                    {chapters.map((ch) => {
                      const locked = !canManage && ch.locked;
                      return (
                        <li key={ch.id}>
                          <a
                            href={`#chapter-${ch.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              scrollToChapter(ch.id);
                            }}
                            aria-current={activeChapter?.id === ch.id ? 'page' : undefined}
                            className={cn(
                              'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                              activeChapter?.id === ch.id ? 'bg-brand-soft text-brand' : locked ? 'text-faint hover:bg-raised/60' : 'text-ink hover:bg-raised',
                            )}
                          >
                            {canManage ? (
                              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-raised text-[11px] font-semibold tabular-nums text-soft">{ch.chapterNumber}</span>
                            ) : ch.completed ? (
                              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Completed" />
                            ) : locked ? (
                              <Lock className="mt-0.5 size-4 shrink-0 text-faint" aria-label="Locked" />
                            ) : (
                              <Circle className="mt-0.5 size-4 shrink-0 text-line-strong" aria-hidden="true" />
                            )}
                            <span className="min-w-0 flex-1 leading-snug">
                              <span className="block font-medium">{ch.title}</span>
                              {ch.estimatedMinutes ? <span className="block text-[11px] text-faint">{ch.estimatedMinutes} min</span> : null}
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ol>
                </nav>
              </Card>
            </aside>

            <div className="min-w-0 space-y-6">
              {readingOffline && (
                <Alert tone="info">
                  <WifiOff className="mr-1.5 inline size-4" aria-hidden="true" />
                  You are offline. Showing chapters saved on this device {relativeTime(offlineBook.savedAt)}.
                </Alert>
              )}
              <BookPageNavigation
                label={pageLabel}
                page={pageIndex + 1}
                total={chapters.length + 2}
                canPrevious={pageIndex > 0}
                canNext={pageIndex < chapters.length + 1}
                onPrevious={() => goToPage(pageIndex - 1)}
                onNext={() => goToPage(pageIndex + 1)}
                showHint
                helpId={`book-page-turn-help-${modSummary.id}`}
              />
              {/* Module Title / Front-Matter Page */}
              <Card className={cn('overflow-hidden border-t-4 border-t-brand p-4 sm:p-6 print:border-0 print:shadow-none', pageIndex !== 0 && 'hidden print:block', pageIndex === 0 && turnDirection && `book-page-turn-${turnDirection}`)}>
                <div className="reader-scaled-content mx-auto max-w-[68ch]" data-reader-size={prefs.size}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand">
                      <BookOpen className="size-4" aria-hidden="true" />
                      Learning Module
                      <span>· {plural(chapters.length, 'chapter')}</span>
                      {totalReadTime && <span>· {totalReadTime}</span>}
                    </p>
                    <Button variant="ghost" size="sm" icon={Printer} className="no-print" onClick={() => window.print()}>
                      Print module
                    </Button>
                  </div>
                  <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl text-balance">{book.title}</h1>
                  {book.description && (
                    <p className={cn('mt-3 text-base leading-relaxed text-soft', prefs.font === 'serif' && 'font-serif text-[1.06rem]')}>
                      {book.description}
                    </p>
                  )}

                  {pageIndex === 0 && resumePageIndex > 0 && (
                    <div className="no-print mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft p-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">Continue where you left off</p>
                        <p className="mt-0.5 truncate text-xs text-soft">{resumeChapter ? `Chapter ${resumeChapter.chapterNumber}: ${resumeChapter.title}` : `End of ${book.title}`}</p>
                      </div>
                      <Button variant="secondary" size="sm" icon={ArrowRight} onClick={() => goToPage(resumePageIndex)}>
                        {resumePageIndex === chapters.length + 1 ? 'Return to end' : 'Continue reading'}
                      </Button>
                    </div>
                  )}

                  {book.objectives?.length > 0 && (
                    <section className="mt-5 rounded-xl border border-line bg-raised/55 p-4" aria-labelledby="module-cover-objectives">
                      <h2 id="module-cover-objectives" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink">
                        <Target className="size-4 text-brand" aria-hidden="true" />
                        Learning Objectives
                      </h2>
                      <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-soft">
                        {book.objectives.map((obj) => <li key={obj}>{obj}</li>)}
                      </ol>
                    </section>
                  )}

                  <section className="mt-6 border-t border-line pt-5" aria-labelledby="module-cover-toc">
                    <h2 id="module-cover-toc" className="text-xs font-semibold uppercase tracking-wider text-faint">Chapters in this module</h2>
                    <ol className="mt-3 divide-y divide-line rounded-xl border border-line">
                      {chapters.map((ch) => (
                        <li key={ch.id}>
                          <a
                            href={`#chapter-${ch.id}`}
                            aria-current={activeChapter?.id === ch.id ? 'page' : undefined}
                            onClick={(e) => {
                              e.preventDefault();
                              scrollToChapter(ch.id);
                            }}
                            className={cn('flex items-start gap-3 px-3 py-3 text-sm transition-colors hover:bg-raised sm:px-3.5', activeChapter?.id === ch.id && 'bg-brand-soft/60')}
                          >
                            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-xs font-bold tabular-nums text-brand">
                              {ch.chapterNumber}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className={cn('block line-clamp-2 break-words font-medium leading-snug', !canManage && ch.locked ? 'text-faint' : 'text-ink')}>{ch.title}</span>
                              <span className="block text-xs text-faint">
                                {LESSON_KINDS[ch.kind] ?? 'Lesson'}{ch.estimatedMinutes ? ` · ${ch.estimatedMinutes} min` : ''}
                              </span>
                            </span>
                            {!canManage && ch.completed && <Badge tone="ok" icon={CheckCircle2}>Done</Badge>}
                            {!canManage && ch.locked && <Badge icon={Lock}>Locked</Badge>}
                            {canManage && ch.status === 'DRAFT' && <Badge tone="warn">Draft</Badge>}
                          </a>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {book.resources?.length > 0 && (
                    <section className="mt-6 border-t border-line pt-5" aria-labelledby="module-cover-resources">
                      <h2 id="module-cover-resources" className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">Module Resources</h2>
                      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {book.resources.map((r) => (
                          <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} teacherId={cls.teacher?.id} />
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              </Card>

              {/* Inactive chapter pages stay mounted for printing, but only the selected page is visible while reading. */}
              {chapters.map((ch, idx) => {
                const nextChapter = chapters[idx + 1];
                const locked = !canManage && ch.locked;
                const visiblePage = pageIndex === idx + 1;
                const pageClassName = cn('book-chapter scroll-mt-24', !visiblePage && 'hidden print:block', visiblePage && turnDirection && `book-page-turn-${turnDirection}`);

                if (locked) {
                  return (
                    <article key={ch.id} id={`chapter-${ch.id}`} className={pageClassName}>
                      <Card className="border-dashed bg-raised/35 p-4 sm:p-6">
                        <div className="reader-scaled-content mx-auto flex max-w-[68ch] items-start gap-3" data-reader-size={prefs.size}>
                          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-raised text-faint"><Lock className="size-4" aria-hidden="true" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold uppercase tracking-wider text-faint">Chapter {ch.chapterNumber} of {chapters.length} · Locked</p>
                            <h2 className="mt-1 text-lg font-bold text-ink">{ch.title}</h2>
                            <p className="mt-1 text-sm text-soft">{ch.lockedReason || 'Complete the previous required chapter above to unlock this reading.'}</p>
                          </div>
                        </div>
                      </Card>
                    </article>
                  );
                }

                return (
                  <article key={ch.id} id={`chapter-${ch.id}`} className={pageClassName}>
                    <Card className="p-4 sm:p-6 print:border-0 print:shadow-none">
                      <div className="reader-scaled-content mx-auto max-w-[68ch]" data-reader-size={prefs.size}>
                        <header className="mb-6 border-b border-line pb-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand">
                                <span>Chapter {ch.chapterNumber} of {chapters.length}</span>
                                <span className="text-faint">·</span>
                                <Badge tone="brand">{LESSON_KINDS[ch.kind] ?? 'Lesson'}</Badge>
                                {ch.estimatedMinutes ? <span className="flex items-center gap-1 font-medium normal-case tracking-normal text-faint"><Clock className="size-3.5" aria-hidden="true" />~{ch.estimatedMinutes} min read</span> : null}
                                {canManage && ch.status === 'DRAFT' && <Badge tone="warn">Draft</Badge>}
                              </p>
                              <h2 className="mt-2.5 text-2xl font-bold tracking-tight text-ink sm:text-[1.65rem] text-balance">{ch.title}</h2>
                            </div>
                            <div className="no-print flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0">
                              <Button
                                variant={offlineMap[ch.id] ? 'soft' : 'ghost'}
                                size="sm"
                                icon={offlineMap[ch.id] ? Check : Download}
                                loading={savingId === ch.id}
                                aria-pressed={Boolean(offlineMap[ch.id])}
                                className={offlineMap[ch.id] ? 'text-ok' : ''}
                                onClick={() => toggleOfflineChapter(book, ch)}
                              >
                                {offlineMap[ch.id] ? 'Offline' : 'Save offline'}
                              </Button>
                              {!canManage && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={ch.bookmarked ? BookmarkCheck : Bookmark}
                                  aria-pressed={Boolean(ch.bookmarked)}
                                  className={ch.bookmarked ? 'text-brand' : ''}
                                  onClick={() => toggleBookmark.mutate({ lessonId: ch.id, on: !ch.bookmarked })}
                                >
                                  {ch.bookmarked ? 'Saved' : 'Save'}
                                </Button>
                              )}
                              {canManage && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  icon={Pencil}
                                  onClick={() => setParams({ lesson: ch.id, edit: '1' })}
                                >
                                  Edit
                                </Button>
                              )}
                            </div>
                          </div>
                          {ch.objectives?.length > 0 && (
                            <ul className="mt-3.5 space-y-1 text-sm text-soft">
                              {ch.objectives.map((o) => <li key={o} className="flex gap-2"><Target className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />{o}</li>)}
                            </ul>
                          )}
                        </header>

                        <RichText
                          html={ch.contentHtml}
                          className={bookTextClasses(prefs)}
                          empty={<p className="text-sm text-faint">{canManage ? 'This chapter has no content yet. Choose Edit to write it.' : 'This chapter has no content yet.'}</p>}
                        />
                        {ch.visual && <LearningVisual visual={ch.visual} />}
                        {ch.selfCheck && <QuickCheck check={ch.selfCheck} />}

                        {(book.aiStudyCoachEnabled || canManage) && Boolean(ch.contentHtml?.trim()) && (
                          <StudyCoachPanel lessonId={ch.id} lessonTitle={ch.title} canManage={canManage} enabledForStudents={book.aiStudyCoachEnabled} />
                        )}

                        {ch.resources?.length > 0 && (
                          <section className="mt-8 border-t border-line pt-5" aria-label={`Attachments for ${ch.title}`}>
                            <h3 className="mb-3 text-sm font-semibold text-ink">Chapter attachments</h3>
                            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {ch.resources.map((r) => (
                                <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} teacherId={cls.teacher?.id} />
                              ))}
                            </ul>
                          </section>
                        )}

                        {!canManage && (
                          <footer className="no-print mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                            {ch.completed ? (
                              <span className="inline-flex items-center gap-2.5 text-sm font-medium text-ok">
                                <CheckCircle2 className="size-5" aria-hidden="true" />
                                Chapter {ch.chapterNumber} completed
                                <button
                                  type="button"
                                  onClick={() => toggleComplete.mutate({ lessonId: ch.id, done: false })}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-faint hover:text-ink"
                                >
                                  <Undo2 className="size-3.5" aria-hidden="true" />
                                  Undo
                                </button>
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                icon={CheckCircle2}
                                loading={toggleComplete.isPending}
                                onClick={() => toggleComplete.mutate({ lessonId: ch.id, done: true })}
                              >
                                Mark Chapter {ch.chapterNumber} as completed
                              </Button>
                            )}
                            {nextChapter && !nextChapter.locked && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => scrollToChapter(nextChapter.id)}
                              >
                                Next: {nextChapter.title}
                                <ArrowRight className="size-4" aria-hidden="true" />
                              </Button>
                            )}
                            {nextChapter?.locked && (
                              <span className="flex items-center gap-1.5 text-xs text-faint">
                                <Lock className="size-3.5" aria-hidden="true" />
                                Complete this chapter to unlock Chapter {nextChapter.chapterNumber}
                              </span>
                            )}
                          </footer>
                        )}
                      </div>
                    </Card>
                  </article>
                );
              })}

              {/* End-of-Module Epilogue */}
              <Card className={cn('no-print bg-raised/40 p-4 sm:p-6', pageIndex !== chapters.length + 1 && 'hidden', pageIndex === chapters.length + 1 && turnDirection && `book-page-turn-${turnDirection}`)}>
                <div className="reader-scaled-content mx-auto flex max-w-[68ch] flex-wrap items-center justify-between gap-4" data-reader-size={prefs.size}>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {!canManage && progressPercent === 100
                        ? `You have completed all ${plural(chapters.length, 'chapter')} in “${book.title}”.`
                        : `End of “${book.title}”`}
                    </p>
                    <p className="mt-0.5 text-xs text-soft">
                      {!canManage
                        ? `${completedCount} of ${chapters.length} chapters marked complete.`
                        : 'Switch back to Chapter view or open individual lessons to reorder or add attachments.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" icon={Printer} onClick={() => window.print()}>Print module</Button>
                    <Button variant="secondary" size="sm" to={`${base}/modules`}>Back to all lessons</Button>
                  </div>
                </div>
              </Card>
              <BookPageNavigation
                label={pageLabel}
                page={pageIndex + 1}
                total={chapters.length + 2}
                canPrevious={pageIndex > 0}
                canNext={pageIndex < chapters.length + 1}
                onPrevious={() => goToPage(pageIndex - 1)}
                onNext={() => goToPage(pageIndex + 1)}
              />
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}

function Lesson({ mod, lessonId, prefs = DEFAULT_READER_PREFS }) {
  const { user } = useAuth();
  const { cls, canManage, base } = useClass();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(() => canManage && params.get('edit') === '1');
  const [dialog, setDialog] = useState(null);
  const [assignmentNotice, setAssignmentNotice] = useState(null);
  const [savedOffline, setSavedOffline] = useState(() => isLessonSavedOffline(user?.id, lessonId));
  const [savingOffline, setSavingOffline] = useState(false);
  const lessonReaderRef = useRef(null);
  const query = useQuery({ queryKey: ['class', cls.id, 'lesson', lessonId], queryFn: () => api.get(`/lessons/${lessonId}`) });
  const offlineEntry = getOfflineLesson(user?.id, lessonId);
  const readingOffline = Boolean(query.isError && query.error?.code === 'NETWORK' && offlineEntry);
  const effectiveQuery = readingOffline
    ? { ...query, isError: false, isSuccess: true, data: offlineEntry.lesson }
    : query;
  const loadedLesson = effectiveQuery.data;
  const canGoPrevious = Boolean(loadedLesson?.previous);
  const canGoNext = Boolean(loadedLesson?.next && (canManage || !loadedLesson.next.locked));
  const goToLesson = (target) => {
    if (target) navigate(`${base}/modules/${mod.id}?lesson=${target.id}`);
  };
  const pageNavigation = useBookNavigation({
    canPrevious: canGoPrevious,
    canNext: canGoNext,
    onPrevious: () => goToLesson(loadedLesson?.previous),
    onNext: () => goToLesson(loadedLesson?.next),
  });
  const invalidate = [['class', cls.id], ['dashboard']];
  const complete = useAction((done) => (done ? api.post(`/lessons/${lessonId}/complete`) : api.delete(`/lessons/${lessonId}/complete`)), { invalidate });
  const bookmark = useAction((on) => (on ? api.post('/bookmarks', { lessonId }) : api.delete('/bookmarks', { lessonId })), { invalidate: [['class', cls.id, 'lesson', lessonId], ['bookmarks']] });
  const remove = useAction(() => api.delete(`/lessons/${lessonId}`), { invalidate, success: 'Lesson deleted.', onSuccess: () => navigate(`${base}/modules/${mod.id}`, { replace: true }) });
  const readOnly = cls.status === 'ARCHIVED';

  const chapterIndex = useMemo(() => {
    const idx = (mod.lessons ?? []).findIndex((l) => l.id === lessonId);
    return idx >= 0 ? idx : 0;
  }, [mod.lessons, lessonId]);

  useEffect(() => {
    setSavedOffline(isLessonSavedOffline(user?.id, lessonId));
  }, [user?.id, lessonId]);

  useEffect(() => {
    if (loadedLesson?.id !== lessonId) return;
    lessonReaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loadedLesson?.id, lessonId]);

  useEffect(() => {
    setEditing(canManage && params.get('edit') === '1');
  }, [canManage, params, lessonId]);

  const closeEditor = () => {
    setEditing(false);
    if (params.get('edit')) setParams({ lesson: lessonId }, { replace: true });
  };

  const toggleOffline = async (lesson) => {
    setSavingOffline(true);
    try {
      if (savedOffline) {
        await removeOfflineLesson(user?.id, lesson.id);
        setSavedOffline(false);
        toast.info('Removed offline copy from this device.');
      } else {
        const entry = await saveLessonOffline(user?.id, { mod, lesson });
        setSavedOffline(true);
        toast.success(`Saved for offline study${entry.cachedFiles > 0 ? ` (${entry.cachedFiles} file${entry.cachedFiles === 1 ? '' : 's'} cached)` : ''}.`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingOffline(false);
    }
  };

  if (effectiveQuery.isError && effectiveQuery.error.code === 'LESSON_LOCKED') {
    return <Card><EmptyState icon={Lock} title="This lesson is locked" description={effectiveQuery.error.message} /></Card>;
  }
  return (
    <QueryState query={effectiveQuery}>
      {(lesson) => editing ? <LessonEditor mod={mod} lesson={lesson} onDone={closeEditor} /> : (
        <article
          ref={lessonReaderRef}
          data-lesson-reader
          role="region"
          tabIndex={0}
          aria-label={`Lesson reader: ${lesson.title}`}
          aria-describedby={`lesson-page-turn-help-${lessonId}`}
          {...pageNavigation}
          className="book-reader-surface"
        >
          {assignmentNotice && (
            <Alert
              tone="ok"
              className="mb-4"
              title="Draft assignment created"
              action={<Button size="sm" variant="secondary" to={`/classes/${assignmentNotice.classId}/assignments/${assignmentNotice.id}`}>Review draft</Button>}
            >
              “{assignmentNotice.title}” was saved as a draft{assignmentNotice.withRubric ? ' with a grading rubric' : ''}. {assignmentNotice.countedInGradebook
                ? 'It will count toward its selected gradebook category when graded.'
                : 'It is not counted in the gradebook, but the teacher can still score it.'} Students will not see it until you publish it.
            </Alert>
          )}
          {readingOffline && (
            <Alert tone="info" className="mb-4">
              <WifiOff className="mr-1.5 inline size-4" aria-hidden="true" />
              You are offline. Reading copy saved on this device {relativeTime(offlineEntry.savedAt)}.
            </Alert>
          )}
          <Card className="p-4 sm:p-6 print:border-0 print:shadow-none">
            <div className="reader-scaled-content mx-auto max-w-[68ch]" data-reader-size={prefs.size}>
              <header className="mb-6 border-b border-line pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand">
                      {mod.lessons?.length > 0 && <span>Chapter {chapterIndex + 1} of {mod.lessons.length}</span>}
                      <Badge tone="brand">{LESSON_KINDS[lesson.kind] ?? 'Lesson'}</Badge>
                      {lesson.estimatedMinutes ? <span className="flex items-center gap-1 font-medium normal-case tracking-normal text-faint"><Clock className="size-3.5" aria-hidden="true" />about {lesson.estimatedMinutes} min</span> : null}
                      {canManage && lesson.status === 'DRAFT' && <Badge tone="warn">Draft — hidden from students</Badge>}
                      <span className="font-normal normal-case tracking-normal text-faint">Updated {relativeTime(lesson.updatedAt)}</span>
                    </p>
                    <h1 className="mt-2.5 text-2xl font-bold tracking-tight text-ink sm:text-[1.7rem] text-balance">{lesson.title}</h1>
                  </div>
                  <div className="no-print hidden max-w-full flex-wrap items-center gap-1.5 sm:flex sm:w-full sm:justify-end lg:w-auto">
                    <Button
                      variant={savedOffline ? 'soft' : 'ghost'}
                      size="sm"
                      icon={savedOffline ? Check : Download}
                      loading={savingOffline}
                      aria-pressed={savedOffline}
                      className={savedOffline ? 'text-ok' : ''}
                      onClick={() => toggleOffline(lesson)}
                    >
                      {savedOffline ? 'Offline ready' : 'Save offline'}
                    </Button>
                    {!canManage && <Button variant="ghost" size="sm" icon={lesson.bookmarked ? BookmarkCheck : Bookmark} aria-pressed={lesson.bookmarked} className={lesson.bookmarked ? 'text-brand' : ''} onClick={() => bookmark.mutate(!lesson.bookmarked)}>{lesson.bookmarked ? 'Saved' : 'Save'}</Button>}
                    <Button variant="ghost" size="sm" icon={Printer} onClick={() => window.print()} aria-label="Print this lesson" />
                    {canManage && <Button variant="secondary" size="sm" icon={Share2} onClick={() => setDialog('post')}>Post to classes</Button>}
                    {canManage && !readOnly && <Button variant="secondary" size="sm" icon={FilePlus2} onClick={() => setDialog('new-assignment')}>New assignment</Button>}
                    {canManage && !readOnly && <Button variant="secondary" size="sm" icon={ClipboardList} onClick={() => { setAssignmentNotice(null); setDialog('assignment'); }}>Create assignment draft</Button>}
                    {canManage && !readOnly && <Button variant="secondary" size="sm" icon={FileQuestion} onClick={() => setDialog('quiz')}>Create quiz</Button>}
                    {canManage && !readOnly && <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
                    {canManage && !readOnly && <Button variant="dangerGhost" size="sm" icon={Trash2} onClick={() => setDialog('delete')} aria-label="Delete this lesson" />}
                  </div>
                  {canManage ? (
                    <div className="no-print flex w-full items-center gap-2 sm:hidden">
                      {!readOnly && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)} className="min-w-0 flex-1">Edit lesson</Button>}
                      <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label="More lesson actions" onClick={toggle} {...props} />}>
                        <MenuItem icon={Download} onClick={() => toggleOffline(lesson)}>{savedOffline ? 'Remove offline copy' : 'Save offline'}</MenuItem>
                        <MenuItem icon={Printer} onClick={() => window.print()}>Print lesson</MenuItem>
                        <MenuItem icon={Share2} onClick={() => setDialog('post')}>Post to classes</MenuItem>
                        {!readOnly && <MenuItem icon={FilePlus2} onClick={() => setDialog('new-assignment')}>New assignment</MenuItem>}
                        {!readOnly && <MenuItem icon={ClipboardList} onClick={() => { setAssignmentNotice(null); setDialog('assignment'); }}>Create assignment draft</MenuItem>}
                        {!readOnly && <MenuItem icon={FileQuestion} onClick={() => setDialog('quiz')}>Create quiz</MenuItem>}
                        {!readOnly && <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog('delete')}>Delete lesson</MenuItem>}
                      </Menu>
                    </div>
                  ) : (
                    <div className="no-print grid w-full grid-cols-2 gap-1.5 sm:hidden">
                      <Button variant={savedOffline ? 'soft' : 'ghost'} size="sm" icon={savedOffline ? Check : Download} loading={savingOffline} aria-pressed={savedOffline} className={cn('w-full', savedOffline && 'text-ok')} onClick={() => toggleOffline(lesson)}>
                        {savedOffline ? 'Offline ready' : 'Save offline'}
                      </Button>
                      <Button variant="ghost" size="sm" icon={lesson.bookmarked ? BookmarkCheck : Bookmark} aria-pressed={lesson.bookmarked} className={cn('w-full', lesson.bookmarked && 'text-brand')} onClick={() => bookmark.mutate(!lesson.bookmarked)}>
                        {lesson.bookmarked ? 'Saved' : 'Save'}
                      </Button>
                      <Button variant="ghost" size="sm" icon={Printer} onClick={() => window.print()} className="col-span-2 w-full">Print lesson</Button>
                    </div>
                  )}
                </div>
                {lesson.objectives.length > 0 && (
                  <ul className="mt-3.5 space-y-1 text-sm text-soft">
                    {lesson.objectives.map((o) => <li key={o} className="flex gap-2"><Target className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />{o}</li>)}
                  </ul>
                )}
              </header>

              <RichText html={lesson.contentHtml} className={bookTextClasses(prefs)} empty={<p className="text-sm text-faint">{canManage ? 'This lesson has no content yet. Choose Edit to write it.' : 'This lesson has no content yet.'}</p>} />
              {lesson.visual && <LearningVisual visual={lesson.visual} />}
              {lesson.selfCheck && <QuickCheck check={lesson.selfCheck} />}

              {(lesson.aiStudyCoachEnabled || canManage) && Boolean(lesson.contentHtml?.trim()) && (
                <StudyCoachPanel lessonId={lesson.id} lessonTitle={lesson.title} canManage={canManage} enabledForStudents={lesson.aiStudyCoachEnabled} />
              )}

              {(lesson.resources.length > 0 || (canManage && !readOnly)) && (
                <section className="mt-8 border-t border-line pt-5" aria-labelledby="lesson-resources">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 id="lesson-resources" className="text-sm font-semibold text-ink">Attachments and links</h2>
                    {canManage && !readOnly && <Button variant="ghost" size="sm" icon={Plus} className="no-print" onClick={() => setDialog('resource')}>Add</Button>}
                  </div>
                  {lesson.resources.length === 0 ? <p className="text-sm text-faint">Nothing attached.</p> : (
                    <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                      {lesson.resources.map((r) => <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} teacherId={cls.teacher?.id} />)}
                    </ul>
                  )}
                </section>
              )}
            </div>
          </Card>

          <nav className="no-print mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Chapter navigation">
            {lesson.previous ? <Button variant="secondary" icon={ArrowLeft} to={`${base}/modules/${mod.id}?lesson=${lesson.previous.id}`} className="max-w-[45%]"><span className="truncate">{lesson.previous.title}</span></Button> : <span />}
            {!canManage && (
              lesson.completed
                ? <span className="order-first flex w-full items-center justify-center gap-3 text-sm font-medium text-ok sm:order-none sm:w-auto"><CheckCircle2 className="size-5" aria-hidden="true" />Completed<button type="button" onClick={() => complete.mutate(false)} className="inline-flex items-center gap-1 text-xs font-medium text-faint hover:text-ink"><Undo2 className="size-3.5" aria-hidden="true" />Undo</button></span>
                : <Button icon={CheckCircle2} loading={complete.isPending} onClick={() => complete.mutate(true)} className="order-first w-full sm:order-none sm:w-auto">Mark as completed</Button>
            )}
            {lesson.next
              ? lesson.next.locked && !canManage
                ? <span className="flex items-center gap-1.5 text-[13px] text-faint"><Lock className="size-4" aria-hidden="true" />Complete this lesson to unlock the next one</span>
                : <Button variant={lesson.completed || canManage ? 'primary' : 'secondary'} to={`${base}/modules/${mod.id}?lesson=${lesson.next.id}`} className="max-w-[45%]"><span className="truncate">{lesson.next.title}</span><ArrowRight className="size-4 shrink-0" aria-hidden="true" /></Button>
              : <Button variant="secondary" to={`${base}/modules`}>Back to all lessons</Button>}
            <p id={`lesson-page-turn-help-${lessonId}`} className="order-last basis-full text-center text-xs text-faint">Swipe left or right, use a horizontal trackpad gesture, focus the reader and press ← / →, or use the lesson buttons.</p>
          </nav>

          {dialog === 'resource' && <ResourceDialog classId={cls.id} teacherId={cls.teacher?.id} placement={{ moduleId: mod.id, lessonId }} onClose={() => setDialog(null)} />}
          <PostToClassesModal
            open={dialog === 'post'}
            onClose={() => setDialog(null)}
            title={`Post “${lesson.title}” to other classes`}
            excludeClassId={cls.id}
            teacherId={cls.teacher?.id}
            defaultStatus={lesson.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT'}
            hint={`Copies this lesson and its attachments into “${mod.title}” in each selected class (creating the module if needed).`}
            onSubmit={({ targetClassIds, status }) => api.post(`/lessons/${lesson.id}/copy`, { targetClassIds, status })}
          />
          {dialog === 'new-assignment' && (
            <AssignmentDialog
              initialModuleId={mod.id}
              initialLessonId={lesson.id}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog === 'assignment' && (
            <AssignmentDraftDialog
              source={{ title: lesson.title, instructionsHtml: lesson.contentHtml ?? '' }}
              sourceNumber={chapterIndex + 1}
              moduleTitle={mod.title}
              classes={[cls]}
              defaultClassId={cls.id}
              moduleId={mod.id}
              moduleClassId={cls.id}
              lessonId={lesson.id}
              sourceLabel="lesson"
              onClose={() => setDialog(null)}
              onCreated={(assignment, classId, withRubric) => {
                setDialog(null);
                setAssignmentNotice({ ...assignment, classId, withRubric, countedInGradebook: Boolean(assignment.gradeCategory) });
              }}
            />
          )}
          {dialog === 'quiz' && (
            <QuizDialog
              initialModuleId={mod.id}
              initialLessonId={lesson.id}
              onClose={() => setDialog(null)}
              onSaved={(quiz) => navigate(`${base}/quizzes/${quiz.id}`)}
            />
          )}
          <ConfirmDialog open={dialog === 'delete'} onClose={() => setDialog(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title={`Delete “${lesson.title}”?`} confirmLabel="Delete lesson">
            The lesson is removed for everyone, together with students’ completion marks for it.
          </ConfirmDialog>
        </article>
      )}
    </QueryState>
  );
}

function LessonEditor({ mod, lesson, onDone }) {
  const { cls } = useClass();
  const client = useQueryClient();
  const [values, setValues] = useState({
    title: lesson?.title ?? '', kind: lesson?.kind ?? 'LESSON', estimatedMinutes: lesson?.estimatedMinutes ?? '', status: lesson?.status ?? 'PUBLISHED',
    prerequisiteLessonId: lesson?.prerequisiteLessonId ?? '', objectives: (lesson?.objectives ?? []).join('\n'), contentHtml: lesson?.contentHtml ?? '',
    visual: lesson?.visual ?? null, selfCheck: lesson?.selfCheck ?? null,
  });
  const [targetClassIds, setTargetClassIds] = useState([]);
  const [errors, setErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const set = (name, value) => { setValues((v) => ({ ...v, [name]: value })); setDirty(true); };
  const setLearningFeatures = (patch) => { setValues((v) => ({ ...v, ...patch })); setDirty(true); };

  // Do not lose a half-written lesson to an accidental tab close.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useAction(() => {
    const body = {
      title: values.title.trim(), kind: values.kind, status: values.status, contentHtml: values.contentHtml,
      visual: values.visual, selfCheck: values.selfCheck,
      estimatedMinutes: values.estimatedMinutes === '' ? null : Number(values.estimatedMinutes),
      prerequisiteLessonId: values.prerequisiteLessonId || null,
      objectives: values.objectives.split('\n').map((o) => o.trim()).filter(Boolean),
      ...(lesson ? {} : { targetClassIds }),
    };
    return lesson ? api.patch(`/lessons/${lesson.id}`, body) : api.post(`/modules/${mod.id}/lessons`, body);
  }, {
    invalidate: [['class', cls.id]],
    success: lesson
      ? 'Lesson saved.'
      : targetClassIds.length > 0
        ? `Lesson added to ${targetClassIds.length + 1} classes.`
        : 'Lesson added.',
    onSuccess: (saved) => {
      for (const id of targetClassIds) client.invalidateQueries({ queryKey: ['class', id] });
      setDirty(false);
      onDone(saved);
    },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{lesson ? 'Edit lesson' : 'New lesson'}</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onDone(null)}>Cancel</Button>
          <Button icon={Save} loading={save.isPending} disabled={!values.title.trim()} onClick={() => save.mutate()}>Save lesson</Button>
        </div>
      </div>
      {mod.status !== 'PUBLISHED' && <Alert tone="info" className="mb-4">This module is not published yet, so students cannot see its lessons.</Alert>}
      <div className="space-y-4">
        <Field label="Title" required error={errors.title}><Input value={values.title} onChange={(e) => set('title', e.target.value)} maxLength={200} placeholder="e.g. Binary and decimal number systems" data-autofocus /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Type" error={errors.kind}>
            <Select value={values.kind} onChange={(e) => set('kind', e.target.value)}>{Object.entries(LESSON_KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select>
          </Field>
          <Field label="Reading time" optional error={errors.estimatedMinutes}>
            <div className="relative"><Input type="number" min="1" max="600" value={values.estimatedMinutes} onChange={(e) => set('estimatedMinutes', e.target.value)} className="pr-12" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">min</span></div>
          </Field>
          <Field label="Unlocks after" optional error={errors.prerequisiteLessonId}>
            <Select value={values.prerequisiteLessonId} onChange={(e) => set('prerequisiteLessonId', e.target.value)}>
              <option value="">No prerequisite</option>
              {mod.lessons.filter((l) => l.id !== lesson?.id).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Content" error={errors.contentHtml}>
          <LazyEditor value={values.contentHtml} onChange={(html) => set('contentHtml', html)} placeholder="Write the lesson. Use headings to organise it, and add pictures, videos or tables from the toolbar." minHeight={360} ariaLabel="Lesson content" />
        </Field>
        <LearningFeaturesEditor visual={values.visual} selfCheck={values.selfCheck} onChange={setLearningFeatures} />
        <Field label="Learning objectives" optional hint="One per line." error={errors.objectives}><Textarea rows={3} value={values.objectives} onChange={(e) => set('objectives', e.target.value)} /></Field>
        <Field label="Visibility">
          <Segmented label="Lesson visibility" value={values.status} onChange={(s) => set('status', s)} options={[{ value: 'DRAFT', label: 'Draft' }, { value: 'PUBLISHED', label: 'Published' }]} />
        </Field>
        {!lesson && (
          <AlsoPostToClasses
            excludeClassId={cls.id}
            teacherId={cls.teacher?.id}
            value={targetClassIds}
            onChange={setTargetClassIds}
            hint={`Added to a module named “${mod.title}” in each selected class (created automatically if that class does not have one yet).`}
          />
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={() => onDone(null)}>Cancel</Button>
        <Button icon={Save} loading={save.isPending} disabled={!values.title.trim()} onClick={() => save.mutate()}>Save lesson</Button>
      </div>
    </Card>
  );
}

function StudyCoachPanel({ lessonId, lessonTitle, canManage, enabledForStudents }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('summary');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({});
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [answers, setAnswers] = useState({});
  const [checked, setChecked] = useState(false);

  const loadMode = async (mode, extra = {}) => {
    setTab(mode);
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/lessons/${lessonId}/study-coach`, { mode, ...extra });
      setData((prev) => ({ ...prev, [mode]: res }));
      if (mode === 'flashcards') {
        setCardIndex(0);
        setFlipped(false);
      }
      if (mode === 'practice') {
        setAnswers({});
        setChecked(false);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const openPanel = () => {
    const next = !open;
    setOpen(next);
    if (next && !data.summary) loadMode('summary');
  };

  const summary = data.summary;
  const cards = data.flashcards?.cards ?? [];
  const activeCard = cards[cardIndex];
  const practiceQuestions = data.practice?.questions ?? [];
  const explain = data.explain;

  return (
    <section className="no-print mt-8 rounded-2xl border border-brand/25 bg-brand-soft/35 p-4" aria-label="AI Study Coach">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Sparkles className="size-4 text-brand" aria-hidden="true" />
            Study Coach
            {canManage && !enabledForStudents && <Badge tone="warn">Teacher preview</Badge>}
          </p>
          <p className="text-xs text-soft">
            {canManage && !enabledForStudents
              ? 'Built strictly from this lesson. Turn on “Enable AI Study Coach for students” in Class Settings to share this with enrolled students.'
              : 'Review key ideas, flip flashcards, or try an ungraded quick check built strictly from this published lesson.'}
          </p>
        </div>
        <Button size="sm" variant={open ? 'secondary' : 'primary'} icon={Sparkles} onClick={openPanel} aria-expanded={open}>
          {open ? 'Hide Study Coach' : 'Study this lesson'}
        </Button>
      </div>

      {open && (
        <div className="mt-4 space-y-4 border-t border-brand/15 pt-4">
          <div className="flex flex-wrap gap-2">
            {[
              ['summary', 'Key takeaways'],
              ['flashcards', 'Flashcards'],
              ['practice', 'Quick check'],
              ['explain', 'Ask about this lesson'],
            ].map(([mode, label]) => (
              <Button
                key={mode}
                size="sm"
                variant={tab === mode ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => {
                  setTab(mode);
                  if (mode !== 'explain' && !data[mode]) loadMode(mode);
                }}
              >
                {label}
              </Button>
            ))}
          </div>

          {error && <Alert tone="bad">{error}</Alert>}
          {busy && <p className="text-sm text-soft" role="status">Preparing study material…</p>}

          {tab === 'summary' && summary && !busy && (
            <div className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
              <p className="font-medium text-ink">{summary.summary}</p>
              {summary.takeaways?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Key takeaways</p>
                  <ul className="list-disc space-y-1 pl-5 text-soft">
                    {summary.takeaways.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}
              {summary.keyTerms?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Key terms</p>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {summary.keyTerms.map((k, i) => (
                      <div key={i} className="rounded-lg bg-raised/70 p-2.5">
                        <dt className="font-semibold text-ink">{k.term}</dt>
                        <dd className="text-xs text-soft">{k.definition}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {summary.pitfall && <Alert tone="info" title="Common pitfall to watch out for">{summary.pitfall}</Alert>}
            </div>
          )}

          {tab === 'flashcards' && !busy && (
            cards.length === 0 ? (
              <p className="text-sm text-soft">Not enough structured definitions or key facts in this lesson for flashcards yet.</p>
            ) : (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setFlipped((f) => !f)}
                  className="flex min-h-[9rem] w-full flex-col items-center justify-center rounded-xl border border-line bg-surface p-5 text-center shadow-card transition-colors hover:border-brand"
                >
                  <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
                    <Layers className="size-3.5" aria-hidden="true" />
                    {flipped ? 'Answer' : activeCard?.hint || 'Term / Prompt'} ({cardIndex + 1} of {cards.length})
                  </span>
                  <span className="max-w-xl whitespace-pre-wrap text-base font-medium text-ink">
                    {flipped ? activeCard?.back : activeCard?.front}
                  </span>
                  <span className="mt-2 text-xs text-faint">Click card to {flipped ? 'see prompt' : 'reveal answer'}</span>
                </button>
                <div className="flex items-center justify-between">
                  <Button size="sm" variant="secondary" disabled={cardIndex === 0} onClick={() => { setCardIndex((i) => i - 1); setFlipped(false); }}>Previous</Button>
                  <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setFlipped((f) => !f)}>Flip</Button>
                  <Button size="sm" variant="secondary" disabled={cardIndex >= cards.length - 1} onClick={() => { setCardIndex((i) => i + 1); setFlipped(false); }}>Next</Button>
                </div>
              </div>
            )
          )}

          {tab === 'practice' && !busy && (
            practiceQuestions.length === 0 ? (
              <p className="text-sm text-soft">Not enough facts in this lesson to generate self-check questions yet.</p>
            ) : (
              <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-faint">Ungraded self-check for “{lessonTitle}”</p>
                  <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => loadMode('practice')}>New set</Button>
                </div>
                <ol className="space-y-3">
                  {practiceQuestions.map((q, idx) => {
                    const userVal = answers[idx];
                    const isMcq = q.type === 'MULTIPLE_CHOICE' || q.type === 'TRUE_FALSE';
                    const correctChoiceIdx = Array.isArray(q.choices) ? q.choices.findIndex((c) => c.isCorrect) : -1;
                    const accepted = q.answerKey?.accepted ?? (Array.isArray(q.answerKey?.blanks) ? q.answerKey.blanks[0] : []);
                    const expectedText = Array.isArray(accepted) ? accepted[0] : '';
                    const isCorrect = checked && (isMcq
                      ? Number(userVal) === correctChoiceIdx
                      : String(userVal ?? '').trim().toLowerCase() === String(expectedText ?? '').trim().toLowerCase());

                    return (
                      <li key={idx} className="rounded-xl border border-line p-3 text-sm">
                        <p className="font-medium text-ink">{idx + 1}. {q.text}</p>
                        {isMcq && Array.isArray(q.choices) ? (
                          <div className="mt-2 space-y-1.5">
                            {q.choices.map((ch, cIdx) => (
                              <label key={cIdx} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]', Number(userVal) === cIdx ? 'border-brand bg-brand-soft/40' : 'border-line')}>
                                <input
                                  type="radio"
                                  name={`coach-q-${idx}`}
                                  disabled={checked}
                                  checked={Number(userVal) === cIdx}
                                  onChange={() => setAnswers((a) => ({ ...a, [idx]: cIdx }))}
                                />
                                <span>{ch.text}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <Input
                            className="mt-2"
                            disabled={checked}
                            value={userVal ?? ''}
                            onChange={(e) => setAnswers((a) => ({ ...a, [idx]: e.target.value }))}
                            placeholder="Type your answer…"
                          />
                        )}
                        {checked && (
                          <p className={cn('mt-2 text-xs font-medium', isCorrect ? 'text-ok' : 'text-bad')}>
                            {isCorrect ? 'Correct! ' : `Suggested answer: ${isMcq ? (q.choices?.[correctChoiceIdx]?.text ?? '') : expectedText}. `}
                            {q.explanation && <span className="font-normal text-soft">{q.explanation}</span>}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <div className="flex justify-end gap-2">
                  {checked ? (
                    <Button size="sm" variant="secondary" onClick={() => { setAnswers({}); setChecked(false); }}>Try again</Button>
                  ) : (
                    <Button size="sm" onClick={() => setChecked(true)}>Check answers</Button>
                  )}
                </div>
              </div>
            )
          )}

          {tab === 'explain' && (
            <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (question.trim().length >= 2) loadMode('explain', { question: question.trim() });
                }}
                className="flex flex-wrap gap-2"
              >
                <Input
                  className="min-w-0 flex-1"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={600}
                  placeholder={`Ask a question about “${lessonTitle}”…`}
                />
                <Button type="submit" size="sm" icon={HelpCircle} loading={busy} disabled={question.trim().length < 2}>Ask</Button>
              </form>
              {explain && !busy && (
                <div className="space-y-2 rounded-lg bg-raised/70 p-3 text-sm">
                  <p className="font-medium text-ink">{explain.answer}</p>
                  {explain.keyPoints?.length > 1 && (
                    <ul className="list-disc space-y-1 pl-5 text-xs text-soft">
                      {explain.keyPoints.slice(1).map((pt, i) => <li key={i}>{pt}</li>)}
                    </ul>
                  )}
                  {explain.tip && <p className="text-xs text-faint">Tip: {explain.tip}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
