// One module: its lesson list on the left, the selected lesson on the right.
// Teachers write and edit lessons here; students read them and mark them as completed.
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, CheckCircle2, ChevronLeft, Circle, Clock, FilePlus2, Lock, Pencil, Plus, Printer, Save, Target, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import LazyEditor from '../../components/LazyEditor.jsx';
import { StatusBadge } from '../../components/Publish.jsx';
import RichText from '../../components/RichText.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, Field, Input, PageLoader, QueryState, Segmented, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { LESSON_KINDS } from './Modules.jsx';
import { ResourceDialog, ResourceItem } from './ResourceParts.jsx';
import { useClass } from './useClass.js';

export default function ModuleView() {
  const { cls, canManage, base } = useClass();
  const { moduleId } = useParams();
  const [params, setParams] = useSearchParams();
  const query = useQuery({ queryKey: ['class', cls.id, 'modules', moduleId], queryFn: () => api.get(`/modules/${moduleId}`) });
  const creating = canManage && params.get('new') === '1';
  const lessonId = params.get('lesson');

  // Open the first lesson a student has not finished (or simply the first one).
  useEffect(() => {
    if (!query.data || lessonId || creating) return;
    const lessons = query.data.lessons;
    const first = (canManage ? lessons[0] : lessons.find((l) => !l.completed && !l.locked) ?? lessons.find((l) => !l.locked));
    if (first) setParams({ lesson: first.id }, { replace: true });
  }, [query.data, lessonId, creating, canManage, setParams]);

  return (
    <QueryState query={query}>
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
  const { cls, canManage, base } = useClass();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState(null);
  const query = useQuery({ queryKey: ['class', cls.id, 'lesson', lessonId], queryFn: () => api.get(`/lessons/${lessonId}`) });
  const invalidate = [['class', cls.id], ['dashboard']];
  const complete = useAction((done) => (done ? api.post(`/lessons/${lessonId}/complete`) : api.delete(`/lessons/${lessonId}/complete`)), { invalidate });
  const bookmark = useAction((on) => (on ? api.post('/bookmarks', { lessonId }) : api.delete('/bookmarks', { lessonId })), { invalidate: [['class', cls.id, 'lesson', lessonId], ['bookmarks']] });
  const remove = useAction(() => api.delete(`/lessons/${lessonId}`), { invalidate, success: 'Lesson deleted.', onSuccess: () => navigate(`${base}/modules/${mod.id}`, { replace: true }) });
  const readOnly = cls.status === 'ARCHIVED';

  if (query.isError && query.error.code === 'LESSON_LOCKED') {
    return <Card><EmptyState icon={Lock} title="This lesson is locked" description={query.error.message} /></Card>;
  }
  return (
    <QueryState query={query}>
      {(lesson) => editing ? <LessonEditor mod={mod} lesson={lesson} onDone={() => setEditing(false)} /> : (
        <article>
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
                <div className="no-print flex shrink-0 items-center gap-1.5">
                  {!canManage && <Button variant="ghost" size="sm" icon={lesson.bookmarked ? BookmarkCheck : Bookmark} aria-pressed={lesson.bookmarked} className={lesson.bookmarked ? 'text-brand' : ''} onClick={() => bookmark.mutate(!lesson.bookmarked)}>{lesson.bookmarked ? 'Saved' : 'Save'}</Button>}
                  <Button variant="ghost" size="sm" icon={Printer} onClick={() => window.print()} aria-label="Print this lesson" />
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

            {(lesson.resources.length > 0 || (canManage && !readOnly)) && (
              <section className="mt-8 border-t border-line pt-5" aria-labelledby="lesson-resources">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 id="lesson-resources" className="text-sm font-semibold text-ink">Attachments and links</h2>
                  {canManage && !readOnly && <Button variant="ghost" size="sm" icon={Plus} className="no-print" onClick={() => setDialog('resource')}>Add</Button>}
                </div>
                {lesson.resources.length === 0 ? <p className="text-sm text-faint">Nothing attached.</p> : (
                  <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                    {lesson.resources.map((r) => <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} />)}
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

          {dialog === 'resource' && <ResourceDialog classId={cls.id} placement={{ moduleId: mod.id, lessonId }} onClose={() => setDialog(null)} />}
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
  const [values, setValues] = useState({
    title: lesson?.title ?? '', kind: lesson?.kind ?? 'LESSON', estimatedMinutes: lesson?.estimatedMinutes ?? '', status: lesson?.status ?? 'PUBLISHED',
    prerequisiteLessonId: lesson?.prerequisiteLessonId ?? '', objectives: (lesson?.objectives ?? []).join('\n'), contentHtml: lesson?.contentHtml ?? '',
  });
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
    };
    return lesson ? api.patch(`/lessons/${lesson.id}`, body) : api.post(`/modules/${mod.id}/lessons`, body);
  }, {
    invalidate: [['class', cls.id]],
    success: lesson ? 'Lesson saved.' : 'Lesson added.',
    onSuccess: (saved) => { setDirty(false); onDone(saved); },
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
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={() => onDone(null)}>Cancel</Button>
        <Button icon={Save} loading={save.isPending} disabled={!values.title.trim()} onClick={() => save.mutate()}>Save lesson</Button>
      </div>
    </Card>
  );
}
