// Review of an AI-generated module draft. The teacher reads and edits every lesson, then
// approves it into a class as an ordinary unpublished module — or discards it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, Download, Plus, Save, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import LazyEditor from '../../components/LazyEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { toast } from '../../components/toast.jsx';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, cn, ConfirmDialog, Field, IconButton, Input, Modal, PageHeader, PageLoader, Select, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import QuestionDrafts from './QuestionDrafts.jsx';
import { LESSON_KINDS } from '../classes/Modules.jsx';
import { classLabel } from '../classes/useClass.js';

export default function AiDraftReview({ generatedId, onBack, configured }) {
  const query = useQuery({ queryKey: ['ai', 'generated', generatedId], queryFn: () => api.get(`/ai/generated/${generatedId}`), retry: false });
  if (query.isPending) return <PageLoader />;
  if (query.isError) return <><Button variant="ghost" icon={ChevronLeft} onClick={onBack}>AI studio</Button><Alert tone="bad" className="mt-4">{query.error.message}</Alert></>;
  return <Review key={`${generatedId}-${query.data.version}`} draft={query.data} onBack={onBack} configured={configured} />;
}

function Review({ draft, onBack, configured }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }) });
  const [c, setC] = useState(() => ({ ...draft.content, objectives: draft.content.objectives ?? [], lessons: draft.content.lessons ?? [], activities: draft.content.activities ?? [], references: draft.content.references ?? [] }));
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [questions, setQuestions] = useState(() => (draft.content.assessment ?? []).map((q, i) => ({ ...q, key: `q${i}`, include: true })));
  const locked = draft.reviewStatus === 'APPROVED';
  const change = (patch) => { setC((s) => ({ ...s, ...patch })); setDirty(true); };
  const setLesson = (i, patch) => change({ lessons: c.lessons.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const move = (i, by) => { const next = [...c.lessons]; const [l] = next.splice(i, 1); next.splice(i + by, 0, l); change({ lessons: next }); setOpen(i + by); };

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const content = () => ({ ...c, assessment: questions.map(({ key, include, ...q }) => q) });
  const save = useAction(() => api.put(`/ai/generated/${draft.id}`, { content: content() }), {
    success: 'Draft saved.',
    onSuccess: (saved) => { setDirty(false); client.setQueryData(['ai', 'generated', draft.id], (old) => ({ ...old, ...saved })); client.invalidateQueries({ queryKey: ['ai', 'requests'] }); },
  });
  const discard = useAction(() => api.post(`/ai/generated/${draft.id}/reject`), { invalidate: [['ai']], success: 'Draft discarded.', onSuccess: onBack });

  return (
    <>
      <PageHeader back={{ to: '/ai', label: 'AI studio' }} eyebrow="AI draft — review before use" title={c.title || 'Untitled module'} description={`${draft.request.topic}${draft.request.classLabel ? ` · ${draft.request.classLabel}` : ''} · updated ${relativeTime(draft.updatedAt)}${draft.model ? ` · ${draft.model}` : ''}`}
        actions={<>
          <Button variant="ghost" icon={Download} onClick={() => api.download(`/ai/generated/${draft.id}/export`, { format: 'docx' }, 'module.docx').catch((e) => toast.error(e.message))}>Word</Button>
          <Button variant="ghost" icon={Download} onClick={() => api.download(`/ai/generated/${draft.id}/export`, { format: 'pdf' }, 'module.pdf').catch((e) => toast.error(e.message))}>PDF</Button>
          {!locked && <Button variant="secondary" icon={Save} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>{dirty ? 'Save changes' : 'Saved'}</Button>}
          {!locked && <Button icon={Check} onClick={() => setDialog('approve')}>Approve…</Button>}
        </>} />

      {locked ? (
        <Alert tone="ok" className="mb-5" title="This draft was approved" action={draft.moduleId && draft.request.classId ? <Button size="sm" variant="secondary" to={`/classes/${draft.request.classId}/modules/${draft.moduleId}`}>Open the module</Button> : null}>It is now an ordinary module. Edit and publish it from the class.</Alert>
      ) : (
        <Alert tone="warn" className="mb-5" title="Written by AI — you are the author of record">Read every lesson. Check facts, examples, computations and references, and adapt the wording to your class. Students see nothing until you approve this draft <em>and</em> publish the module.</Alert>
      )}
      {(draft.content.notes ?? []).map((n) => <Alert key={n} tone="info" className="mb-5">{n}</Alert>)}

      <div className="space-y-5">
        <Card>
          <CardHeader title="Overview" />
          <div className="space-y-4">
            <Field label="Module title"><Input value={c.title} disabled={locked} onChange={(e) => change({ title: e.target.value })} maxLength={200} /></Field>
            <Field label="Overview"><Textarea rows={3} value={c.overview ?? ''} disabled={locked} onChange={(e) => change({ overview: e.target.value })} maxLength={2000} /></Field>
            <Field label="Learning objectives" hint="One per line."><Textarea rows={Math.max(3, c.objectives.length)} value={c.objectives.join('\n')} disabled={locked} onChange={(e) => change({ objectives: e.target.value.split('\n') })} /></Field>
          </div>
        </Card>

        <section aria-label="Lessons">
          <div className="mb-2 flex items-center justify-between"><h2 className="text-base font-semibold text-ink">{plural(c.lessons.length, 'lesson')}</h2>{!locked && <Button size="sm" variant="secondary" icon={Plus} disabled={c.lessons.length >= 20} onClick={() => { change({ lessons: [...c.lessons, { title: 'New lesson', kind: 'LESSON', estimatedMinutes: null, contentHtml: '' }] }); setOpen(c.lessons.length); }}>Add a lesson</Button>}</div>
          <ol className="space-y-3">
            {c.lessons.map((l, i) => (
              <li key={i} className="rounded-2xl border border-line bg-surface shadow-card">
                <div className="flex items-center gap-2 p-3">
                  <button type="button" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <ChevronDown className={cn('size-4 shrink-0 text-faint transition-transform', open !== i && '-rotate-90')} aria-hidden="true" />
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-soft text-xs font-bold text-brand">{i + 1}</span>
                    <span className="min-w-0"><span className="block truncate font-medium text-ink">{l.title}</span><span className="block text-xs text-faint">{LESSON_KINDS[l.kind] ?? 'Lesson'}{l.estimatedMinutes ? ` · ${l.estimatedMinutes} min` : ''}</span></span>
                  </button>
                  {!locked && <>
                    <IconButton size="sm" icon={ArrowUp} label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton size="sm" icon={ArrowDown} label="Move down" disabled={i === c.lessons.length - 1} onClick={() => move(i, 1)} />
                    <IconButton size="sm" icon={Trash2} variant="dangerGhost" label="Remove lesson" disabled={c.lessons.length <= 1} onClick={() => { change({ lessons: c.lessons.filter((_, n) => n !== i) }); setOpen(-1); }} />
                  </>}
                </div>
                {open === i && (
                  <div className="space-y-4 border-t border-line p-4">
                    {locked ? <RichText html={l.contentHtml} /> : (
                      <>
                        <div className="grid gap-4 sm:grid-cols-[1fr_11rem_8rem]">
                          <Field label="Title"><Input value={l.title} onChange={(e) => setLesson(i, { title: e.target.value })} maxLength={200} /></Field>
                          <Field label="Kind"><Select value={l.kind} onChange={(e) => setLesson(i, { kind: e.target.value })}>{Object.entries(LESSON_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
                          <Field label="Minutes"><Input type="number" min="1" max="600" value={l.estimatedMinutes ?? ''} onChange={(e) => setLesson(i, { estimatedMinutes: e.target.value ? Number(e.target.value) : null })} /></Field>
                        </div>
                        <LazyEditor key={`${i}-${l.rewriteKey ?? 0}`} value={l.contentHtml} onChange={(html) => setLesson(i, { contentHtml: html })} minHeight={260} ariaLabel={`Content of lesson ${i + 1}`} />
                        <div className="flex justify-end"><Button size="sm" variant="secondary" icon={Wand2} disabled={!configured} title={configured ? undefined : 'AI is not set up on this server'} onClick={() => setDialog({ rewrite: i })}>Rewrite with AI…</Button></div>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        {(c.activities.length > 0 || !locked) && (
          <Card>
            <CardHeader title="Practice activities" description="Added to the module as one “Practice activities” lesson." action={!locked && <Button size="sm" variant="secondary" icon={Plus} disabled={c.activities.length >= 10} onClick={() => change({ activities: [...c.activities, { title: '', instructions: '' }] })}>Add</Button>} />
            <ul className="space-y-3">
              {c.activities.map((a, i) => (
                <li key={i} className="rounded-xl border border-line p-3">
                  <div className="flex gap-2"><Input value={a.title} disabled={locked} onChange={(e) => change({ activities: c.activities.map((x, n) => (n === i ? { ...x, title: e.target.value } : x)) })} placeholder="Activity title" aria-label={`Activity ${i + 1} title`} maxLength={200} />{!locked && <IconButton icon={X} label="Remove activity" onClick={() => change({ activities: c.activities.filter((_, n) => n !== i) })} />}</div>
                  <Textarea rows={3} className="mt-2" value={a.instructions} disabled={locked} onChange={(e) => change({ activities: c.activities.map((x, n) => (n === i ? { ...x, instructions: e.target.value } : x)) })} placeholder="Instructions" aria-label={`Activity ${i + 1} instructions`} maxLength={3000} />
                </li>
              ))}
              {c.activities.length === 0 && <li className="text-sm text-faint">No activities.</li>}
            </ul>
          </Card>
        )}

        {questions.length > 0 && (
          <Card>
            <CardHeader title="Assessment questions" description="These are not added to the module. Save the ones you want to a question bank, then build a quiz from the bank." />
            <QuestionDrafts drafts={questions} setDrafts={(next) => { setQuestions(next); setDirty(true); }} defaultBankTitle={c.title?.slice(0, 120)} />
          </Card>
        )}

        <Card>
          <CardHeader title="References" description="AI can invent sources that do not exist. Keep only those you have checked." />
          <Textarea rows={Math.max(2, c.references.length)} value={c.references.join('\n')} disabled={locked} onChange={(e) => change({ references: e.target.value.split('\n') })} aria-label="References, one per line" />
        </Card>

        {!locked && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="dangerGhost" icon={Trash2} onClick={() => setDialog('discard')}>Discard this draft</Button>
            <div className="flex gap-2"><Button variant="secondary" icon={Save} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save changes</Button><Button icon={Check} onClick={() => setDialog('approve')}>Approve…</Button></div>
          </div>
        )}
      </div>

      {dialog === 'approve' && <ApproveDialog draft={draft} classes={classes.data ?? []} dirty={dirty} saveDraft={() => api.put(`/ai/generated/${draft.id}`, { content: content() })} lessons={c.lessons.length} onClose={() => setDialog(null)} onDone={(r) => { setDirty(false); client.invalidateQueries({ queryKey: ['ai'] }); client.invalidateQueries({ queryKey: ['class', r.classId] }); navigate(`/classes/${r.classId}/modules/${r.moduleId}`); }} />}
      {dialog?.rewrite !== undefined && <RewriteDialog draftId={draft.id} index={dialog.rewrite} lesson={c.lessons[dialog.rewrite]} dirty={dirty} saveDraft={() => api.put(`/ai/generated/${draft.id}`, { content: content() })} onClose={() => setDialog(null)} onAccept={(lesson) => { setLesson(dialog.rewrite, { ...lesson, rewriteKey: Date.now() }); setDialog(null); }} />}
      <ConfirmDialog open={dialog === 'discard'} onClose={() => setDialog(null)} onConfirm={() => discard.mutate()} loading={discard.isPending} title="Discard this draft?" confirmLabel="Discard">The draft is marked as discarded and nothing is added to any class.</ConfirmDialog>
    </>
  );
}

function ApproveDialog({ draft, classes, dirty, saveDraft, lessons, onClose, onDone }) {
  const [classId, setClassId] = useState(draft.request.classId ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const approve = useAction(async () => {
    if (dirty) await saveDraft();
    return api.post(`/ai/generated/${draft.id}/approve`, { classId, confirmReviewed: true });
  }, { success: 'Module created as a draft. Publish it when you are ready.', onSuccess: onDone });
  return (
    <Modal open onClose={onClose} title="Approve this draft" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Check} loading={approve.isPending} disabled={!classId || !confirmed} onClick={() => approve.mutate()}>Create the module</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-soft">The {plural(lessons, 'lesson')} become a new module in the class you choose. The module is <strong className="text-ink">not published</strong>: students see it only after you publish it from the class.</p>
        <Field label="Add to class"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choose a class…</option>{classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>
        <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label="I have read and checked this content" description="I take responsibility for its accuracy and suitability for my students." />
      </div>
    </Modal>
  );
}

function RewriteDialog({ draftId, index, lesson, dirty, saveDraft, onClose, onAccept }) {
  const [instruction, setInstruction] = useState('');
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState(null);
  const rewrite = useAction(async () => {
    // The server rewrites the lesson as it was last saved, so save pending edits first.
    if (dirty) await saveDraft();
    return api.post(`/ai/generated/${draftId}/lessons/${index}/rewrite`, { instruction: instruction.trim() });
  }, { onSuccess: (r) => setSuggestion(r.lesson), onError: (err) => { setError(err.code === 'AI_UNAVAILABLE' ? 'AI assistance is not set up on this server.' : err.message); return true; } });
  return (
    <Modal open onClose={onClose} size="lg" title={`Rewrite “${lesson.title}”`} description="You see the suggestion first. The lesson changes only if you accept it."
      footer={suggestion ? <><Button variant="secondary" onClick={() => setSuggestion(null)}>Try again</Button><Button icon={Check} onClick={() => onAccept(suggestion)}>Use this version</Button></> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Sparkles} loading={rewrite.isPending} disabled={instruction.trim().length < 3} onClick={() => { setError(null); rewrite.mutate(); }}>Rewrite</Button></>}>
      {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
      {suggestion ? (
        <div><p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">{suggestion.title}<Badge tone="warn">Suggestion</Badge></p><div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line p-4"><RichText html={suggestion.contentHtml} /></div></div>
      ) : (
        <Field label="How should it change?"><Textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={1000} placeholder="e.g. Add a worked example using peso amounts, and shorten the introduction." data-autofocus /></Field>
      )}
    </Modal>
  );
}
