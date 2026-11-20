// One module: its lesson list on the left, the selected lesson on the right.
// Teachers write and edit lessons here; students read them and mark them as completed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, Check, CheckCircle2, ChevronLeft, Circle, Clock, Download, FilePlus2, HelpCircle, Layers, Lock, Pencil, Plus, Printer, RotateCcw, Save, Share2, Sparkles, Target, Trash2, Undo2, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { AlsoPostToClasses, PostToClassesModal } from '../../components/ClassTargets.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, Input, PageLoader, QueryState, Segmented, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { relativeTime } from '../../lib/format.js';
import { getOfflineLesson, isLessonSavedOffline, removeOfflineLesson, saveLessonOffline } from '../../lib/offlineLessons.js';
import { useAction } from '../../lib/query.js';
import { LESSON_KINDS } from './Modules.jsx';
import { ResourceDialog, ResourceItem } from './ResourceParts.jsx';
import { useClass } from './useClass.js';

export default function ModuleView() {
  const { user } = useAuth();
  const { cls, canManage, base } = useClass();
  const { moduleId } = useParams();
  const [params, setParams] = useSearchParams();
  const query = useQuery({ queryKey: ['class', cls.id, 'modules', moduleId], queryFn: () => api.get(`/modules/${moduleId}`) });
  const creating = canManage && params.get('new') === '1';
  const lessonId = params.get('lesson');
  const offlineFallback = lessonId ? getOfflineLesson(user?.id, lessonId) : null;
  const effectiveQuery = query.isError && query.error?.code === 'NETWORK' && offlineFallback?.mod?.id === moduleId
    ? { ...query, isError: false, isSuccess: true, data: offlineFallback.mod }
    : query;

  // Open the first lesson a student has not finished (or simply the first one).
  useEffect(() => {
    if (!effectiveQuery.data || lessonId || creating) return;
    const lessons = effectiveQuery.data.lessons;
    const first = (canManage ? lessons[0] : lessons.find((l) => !l.completed && !l.locked) ?? lessons.find((l) => !l.locked));
    if (first) setParams({ lesson: first.id }, { replace: true });
  }, [effectiveQuery.data, lessonId, creating, canManage, setParams]);

  return (
    <QueryState query={effectiveQuery}>
      {(mod) => (
        <>
          <div className="no-print mb-4 flex flex-wrap items-center gap-3">
            <Link to={`${base}/modules`} className="inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />All lessons</Link>
            <h2 className="min-w-0 flex-1 basis-60 truncate text-lg font-semibold text-ink">{mod.title}</h2>
            {canManage && <StatusBadge status={mod.status} publishAt={mod.publishAt} />}
          </div>
          {!canManage && mod.locked ? (
            <Card><EmptyState icon={Lock} title="This module is locked" description={mod.lockedReason} action={<Button to={`${base}/modules`}>Back to lessons</Button>} /></Card>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <LessonList mod={mod} activeId={creating ? null : lessonId} />
              <div className="min-w-0">
                {creating ? <LessonEditor mod={mod} onDone={(saved) => setParams(saved ? { lesson: saved.id } : mod.lessons[0] ? { lesson: mod.lessons[0].id } : {}, { replace: true })} />
                  : lessonId ? <Lesson key={lessonId} mod={mod} lessonId={lessonId} />
                    : mod.lessons.length === 0 ? (
                      <Card><EmptyState icon={FilePlus2} title="This module has no lessons yet" description={canManage ? 'Write the first lesson: text, pictures, videos and attachments.' : 'Check back soon.'} action={canManage ? <Button icon={Plus} onClick={() => setParams({ new: '1' })}>Add a lesson</Button> : null} /></Card>
                    ) : <PageLoader />}
              </div>
            </div>
          )}
        </>
      )}
    </QueryState>
  );
}

function LessonList({ mod, activeId }) {
  const { canManage, base } = useClass();
  const [, setParams] = useSearchParams();
  return (
    <aside className="no-print lg:sticky lg:top-32 lg:self-start">
      {/* A compact picker on phones, the full list on larger screens. */}
      <div className="lg:hidden">
        <Select aria-label="Choose a lesson" value={activeId ?? ''} onChange={(e) => setParams({ lesson: e.target.value })}>
          {!activeId && <option value="">Choose a lesson…</option>}
          {mod.lessons.map((l, i) => <option key={l.id} value={l.id} disabled={!canManage && l.locked}>{i + 1}. {l.title}{!canManage && l.completed ? ' (done)' : ''}</option>)}
        </Select>
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
        <nav aria-label="Lessons in this module" className="p-2">
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

function Lesson({ mod, lessonId }) {
  const { user } = useAuth();
  const { cls, canManage, base } = useClass();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [savedOffline, setSavedOffline] = useState(() => isLessonSavedOffline(user?.id, lessonId));
  const [savingOffline, setSavingOffline] = useState(false);
  const query = useQuery({ queryKey: ['class', cls.id, 'lesson', lessonId], queryFn: () => api.get(`/lessons/${lessonId}`) });
  const offlineEntry = getOfflineLesson(user?.id, lessonId);
  const readingOffline = Boolean(query.isError && query.error?.code === 'NETWORK' && offlineEntry);
  const effectiveQuery = readingOffline
    ? { ...query, isError: false, isSuccess: true, data: offlineEntry.lesson }
    : query;
  const invalidate = [['class', cls.id], ['dashboard']];
  const complete = useAction((done) => (done ? api.post(`/lessons/${lessonId}/complete`) : api.delete(`/lessons/${lessonId}/complete`)), { invalidate });
  const bookmark = useAction((on) => (on ? api.post('/bookmarks', { lessonId }) : api.delete('/bookmarks', { lessonId })), { invalidate: [['class', cls.id, 'lesson', lessonId], ['bookmarks']] });
  const remove = useAction(() => api.delete(`/lessons/${lessonId}`), { invalidate, success: 'Lesson deleted.', onSuccess: () => navigate(`${base}/modules/${mod.id}`, { replace: true }) });
  const readOnly = cls.status === 'ARCHIVED';

  useEffect(() => {
    setSavedOffline(isLessonSavedOffline(user?.id, lessonId));
  }, [user?.id, lessonId]);

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
      {(lesson) => editing ? <LessonEditor mod={mod} lesson={lesson} onDone={() => setEditing(false)} /> : (
        <article>
          {readingOffline && (
            <Alert tone="info" className="mb-4">
              <WifiOff className="mr-1.5 inline size-4" aria-hidden="true" />
              You are offline. Reading copy saved on this device {relativeTime(offlineEntry.savedAt)}.
            </Alert>
          )}
          <Card className="print:border-0 print:shadow-none">
            <header className="mb-5 border-b border-line pb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-faint">
                    <Badge tone="brand">{LESSON_KINDS[lesson.kind] ?? 'Lesson'}</Badge>
                    {lesson.estimatedMinutes ? <span className="flex items-center gap-1"><Clock className="size-3.5" aria-hidden="true" />about {lesson.estimatedMinutes} min</span> : null}
                    {canManage && lesson.status === 'DRAFT' && <Badge tone="warn">Draft — hidden from students</Badge>}
                    <span>Updated {relativeTime(lesson.updatedAt)}</span>
                  </p>
                  <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink text-balance">{lesson.title}</h1>
                </div>
                <div className="no-print flex shrink-0 flex-wrap items-center gap-1.5">
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
                  {canManage && !readOnly && <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
                  {canManage && !readOnly && <Button variant="dangerGhost" size="sm" icon={Trash2} onClick={() => setDialog('delete')} aria-label="Delete this lesson" />}
                </div>
              </div>
              {lesson.objectives.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-soft">
                  {lesson.objectives.map((o) => <li key={o} className="flex gap-2"><Target className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />{o}</li>)}
                </ul>
              )}
            </header>

            <RichText html={lesson.contentHtml} className="text-[15.5px]" empty={<p className="text-sm text-faint">{canManage ? 'This lesson has no content yet. Choose Edit to write it.' : 'This lesson has no content yet.'}</p>} />

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
          </Card>

          <nav className="no-print mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Lesson navigation">
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
  });
  const [targetClassIds, setTargetClassIds] = useState([]);
  const [errors, setErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const set = (name, value) => { setValues((v) => ({ ...v, [name]: value })); setDirty(true); };

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
