// AI studio: drafts of modules, questions, assignments and rubrics.
// Everything the AI writes is a draft. Nothing reaches students until the teacher has
// reviewed it and published it like any other content.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Bot, ClipboardList, Copy, FileQuestion, Layers, Send, Sparkles, Table2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { FileUpload } from '../components/Files.jsx';
import RichText from '../components/RichText.jsx';
import { toast } from '../components/toast.jsx';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, QueryState, Select, Switch, Tabs, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatScore, plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import AiDraftReview from './ai/DraftReview.jsx';
import QuestionDrafts from './ai/QuestionDrafts.jsx';
import { QUESTION_TYPES } from './classes/quiz/QuestionParts.jsx';
import { classLabel } from './classes/useClass.js';
import { RubricDialog } from './Rubrics.jsx';

const TOOLS = [
  { value: 'module', label: 'Module', icon: Layers },
  { value: 'questions', label: 'Questions', icon: FileQuestion },
  { value: 'assignment', label: 'Assignment', icon: ClipboardList },
  { value: 'rubric', label: 'Rubric', icon: Table2 },
  { value: 'assistant', label: 'Writing help', icon: Wand2 },
];

/** Messages for the ways an AI request can fail. Returns true so the default toast is not shown. */
function aiError(err, setError) {
  const text = {
    AI_UNAVAILABLE: 'AI assistance is not set up on this server. Ask your administrator to configure an AI provider.',
    AI_QUOTA_EXCEEDED: 'You have used all of today’s AI requests. The limit resets tomorrow.',
    AI_IN_PROGRESS: 'Another draft is still being generated. Wait for it to finish, then try again.',
    RATE_LIMITED: 'Too many requests in a short time. Wait a minute and try again.',
  }[err.code] ?? err.fields?.topic ?? err.fields?.task ?? err.fields?.prompt ?? err.message;
  setError(text);
  return true;
}

const lines = (text) => text.split('\n').map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);

export default function AiStudio() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const tool = TOOLS.some((t) => t.value === params.get('tool')) ? params.get('tool') : 'module';
  const draftId = params.get('draft');
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.get('/ai/status') });
  const refreshQuota = () => client.invalidateQueries({ queryKey: ['ai', 'status'] });

  if (draftId) return <AiDraftReview generatedId={draftId} onBack={() => setParams({ tool: 'module' })} configured={Boolean(status.data?.configured)} />;

  const ready = Boolean(status.data?.configured);
  const quota = status.data?.quota;
  return (
    <>
      <PageHeader title="AI studio" description="Get a first draft in seconds, then make it yours. Nothing is shown to students until you review and publish it."
        actions={quota && ready ? <Badge tone={quota.remaining > 5 ? 'neutral' : 'warn'}>{quota.remaining} of {quota.limit} requests left today</Badge> : null} />
      {status.data && !ready && (
        <Alert tone="warn" className="mb-5" title="AI assistance is not set up on this server">
          An administrator needs to add an AI provider key to the server configuration (<code>AI_PROVIDER</code>, <code>AI_API_KEY</code>, <code>AI_MODEL</code>). The forms below show what will be available; nothing is generated until then.
        </Alert>
      )}
      <Tabs className="mb-5" value={tool} onChange={(next) => setParams({ tool: next })} tabs={TOOLS} />
      {tool === 'module' && <ModuleTool ready={ready} onDone={refreshQuota} onOpen={(id) => setParams({ draft: id })} />}
      {tool === 'questions' && <QuestionsTool ready={ready} onDone={refreshQuota} />}
      {tool === 'assignment' && <AssignmentTool ready={ready} onDone={refreshQuota} />}
      {tool === 'rubric' && <RubricTool ready={ready} onDone={refreshQuota} />}
      {tool === 'assistant' && <AssistantTool ready={ready} onDone={refreshQuota} />}
      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-faint"><Bot className="mt-0.5 size-4 shrink-0" aria-hidden="true" />AI drafts can contain mistakes, outdated facts or made-up references. Check everything before you use it. Only what you type or attach here is sent to the AI service — never student names, scores or submissions.</p>
    </>
  );
}

// ── Module ───────────────────────────────────────────────────────────────────
function useTeachingClasses() {
  return useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }) });
}

function ModuleTool({ ready, onDone, onOpen }) {
  const classes = useTeachingClasses();
  const requests = useQuery({ queryKey: ['ai', 'requests'], queryFn: () => api.get('/ai/requests') });
  const [v, setV] = useState({ topic: '', title: '', classId: '', subtopics: '', objectives: '', yearLevel: '', difficulty: 'INTERMEDIATE', durationMinutes: '', language: 'ENGLISH', contentLength: 'STANDARD', teachingApproach: '', instructions: '', includeAssessment: true, files: [] });
  const [error, setError] = useState(null);
  // One id per filled-in form: pressing the button twice returns the same draft instead of two.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const set = (name) => (e) => setV((s) => ({ ...s, [name]: e.target.value }));
  const generate = useAction(() => api.post('/ai/modules/generate', {
    clientRequestId: requestId, topic: v.topic.trim(), title: v.title.trim() || null, classId: v.classId || null,
    subtopics: lines(v.subtopics).slice(0, 15), objectives: lines(v.objectives).slice(0, 12), yearLevel: v.yearLevel.trim() || null, difficulty: v.difficulty,
    durationMinutes: v.durationMinutes ? Number(v.durationMinutes) : null, language: v.language, contentLength: v.contentLength,
    teachingApproach: v.teachingApproach.trim() || null, instructions: v.instructions.trim() || null, includeAssessment: v.includeAssessment, referenceFileIds: v.files.map((f) => f.id),
  }), {
    invalidate: [['ai', 'requests']],
    onSuccess: (request) => { onDone(); setRequestId(crypto.randomUUID()); if (request.generated) { toast.success('Draft ready. Review it before using it.'); onOpen(request.generated.id); } },
    onError: (err) => { if (err.code !== 'AI_IN_PROGRESS') setRequestId(crypto.randomUUID()); return aiError(err, setError); },
  });

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="min-w-0">
        <CardHeader icon={Sparkles} title="Draft a learning module" description="Lessons with worked examples, practice activities and a short assessment." />
        <form onSubmit={(e) => { e.preventDefault(); setError(null); generate.mutate(); }} className="space-y-4">
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Topic"><Input value={v.topic} onChange={set('topic')} required minLength={3} maxLength={300} placeholder="e.g. Binary and hexadecimal number systems" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Working title" optional><Input value={v.title} onChange={set('title')} maxLength={200} /></Field>
            <Field label="For class" optional hint="Used for the course name. You choose the class again when you approve the draft.">
              <Select value={v.classId} onChange={set('classId')}><option value="">No class yet</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Subtopics to cover" optional hint="One per line."><Textarea rows={3} value={v.subtopics} onChange={set('subtopics')} /></Field>
            <Field label="Learning objectives" optional hint="One per line. Leave empty to let the draft propose them."><Textarea rows={3} value={v.objectives} onChange={set('objectives')} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Learners" optional><Input value={v.yearLevel} onChange={set('yearLevel')} placeholder="e.g. First-year BSIT" maxLength={60} /></Field>
            <Field label="Level"><Select value={v.difficulty} onChange={set('difficulty')}><option value="BEGINNER">Beginner</option><option value="INTERMEDIATE">Intermediate</option><option value="ADVANCED">Advanced</option></Select></Field>
            <Field label="Language"><Select value={v.language} onChange={set('language')}><option value="ENGLISH">English</option><option value="FILIPINO">Filipino</option><option value="BILINGUAL">English + Filipino</option></Select></Field>
            <Field label="Length"><Select value={v.contentLength} onChange={set('contentLength')}><option value="SHORT">Short (3 lessons)</option><option value="STANDARD">Standard (4–5)</option><option value="COMPREHENSIVE">Comprehensive (6–8)</option></Select></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Study time (minutes)" optional><Input type="number" min="10" max="1200" value={v.durationMinutes} onChange={set('durationMinutes')} placeholder="e.g. 120" /></Field>
            <Field label="Teaching approach" optional><Input value={v.teachingApproach} onChange={set('teachingApproach')} maxLength={200} placeholder="e.g. Problem-based, with local examples" /></Field>
          </div>
          <Field label="Other instructions" optional><Textarea rows={2} value={v.instructions} onChange={set('instructions')} maxLength={2000} placeholder="Anything the draft should include or avoid." /></Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink">Reference material <span className="text-xs font-normal text-faint">optional — the draft is based on it</span></p>
            <FileUpload value={v.files} onChange={(files) => setV((s) => ({ ...s, files }))} max={5} accept=".pdf,.docx,.txt,.md" label="Attach a syllabus or handout" hint="PDF, Word or text, up to 5 files. Their text is sent to the AI service." compact />
          </div>
          <Switch checked={v.includeAssessment} onChange={(on) => setV((s) => ({ ...s, includeAssessment: on }))} label="Include assessment questions" description="6 to 10 questions of mixed types that you can save to a question bank." />
          <div className="flex flex-wrap items-center justify-end gap-3">
            {generate.isPending && <span className="text-sm text-soft" role="status">Writing the draft — this can take up to a minute…</span>}
            <Button type="submit" icon={Sparkles} loading={generate.isPending} disabled={!ready || v.topic.trim().length < 3}>Generate draft</Button>
          </div>
        </form>
      </Card>

      <Card className="min-w-0 xl:self-start">
        <CardHeader title="Your drafts" description="Open one to review, edit and approve it." />
        <QueryState query={requests} loader={<p className="text-sm text-faint">Loading…</p>}>
          {(rows) => rows.length === 0 ? <EmptyState compact icon={Layers} title="No drafts yet" /> : (
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const review = r.generated?.reviewStatus;
                return (
                  <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                    <p className="truncate text-sm font-medium text-ink">{r.generated?.title ?? r.title ?? r.topic}</p>
                    <p className="truncate text-xs text-faint">{r.classLabel ? `${r.classLabel} · ` : ''}{relativeTime(r.createdAt)}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {r.status === 'FAILED' ? <Badge tone="bad">Failed</Badge> : r.status !== 'COMPLETED' ? <Badge tone="info">Generating…</Badge> : review === 'APPROVED' ? <Badge tone="ok">Approved</Badge> : review === 'REJECTED' ? <Badge>Discarded</Badge> : <Badge tone="warn">Needs review</Badge>}
                      {r.generated && review !== 'APPROVED' && <Button size="sm" variant="secondary" onClick={() => onOpen(r.generated.id)}>{review === 'REJECTED' ? 'Open' : 'Review'}</Button>}
                      {review === 'APPROVED' && r.generated.moduleId && r.classId && <Button size="sm" variant="ghost" to={`/classes/${r.classId}/modules/${r.generated.moduleId}`}>Open module</Button>}
                    </div>
                    {r.status === 'FAILED' && r.error && <p className="mt-1 text-xs text-bad">{r.error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

// ── Questions ────────────────────────────────────────────────────────────────
const AI_TYPES = ['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'IDENTIFICATION', 'SHORT_ANSWER', 'FILL_BLANKS', 'MATCHING', 'ORDERING', 'ESSAY'];

function QuestionsTool({ ready, onDone }) {
  const [v, setV] = useState({ topic: '', sourceText: '', count: 5, types: ['MULTIPLE_CHOICE', 'TRUE_FALSE'], difficulty: 'MIXED' });
  const [drafts, setDrafts] = useState([]);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const generate = useAction(() => api.post('/ai/questions', { topic: v.topic.trim() || undefined, sourceText: v.sourceText.trim() || undefined, count: Number(v.count) || 5, types: v.types, difficulty: v.difficulty }), {
    onSuccess: (r) => {
      onDone();
      setDrafts((list) => [...list, ...r.questions.map((q, i) => ({ ...q, key: `${Date.now()}-${i}`, include: true }))]);
      setNote(r.questions.length === 0 ? 'No usable questions came back. Try again with a more specific topic.' : r.rejected > 0 ? `${plural(r.rejected, 'question')} from the AI were incomplete and were left out.` : null);
    },
    onError: (err) => aiError(err, setError),
  });
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader icon={FileQuestion} title="Draft assessment questions" description="From a topic, or from text you paste — for example a lesson or a reading." />
        <form onSubmit={(e) => { e.preventDefault(); setError(null); generate.mutate(); }} className="space-y-4">
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Topic" hint="Required unless you paste source text."><Input value={v.topic} onChange={(e) => setV({ ...v, topic: e.target.value })} maxLength={300} placeholder="e.g. Parts of the CPU and the fetch–execute cycle" /></Field>
          <Field label="Source text" optional hint="Questions are based only on this text."><Textarea rows={4} value={v.sourceText} onChange={(e) => setV({ ...v, sourceText: e.target.value })} maxLength={40000} /></Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Question types</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">{AI_TYPES.map((t) => <Checkbox key={t} label={QUESTION_TYPES[t].label} checked={v.types.includes(t)} onChange={(e) => setV({ ...v, types: e.target.checked ? [...v.types, t] : v.types.filter((x) => x !== t) })} />)}</div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="How many" className="w-28"><Input type="number" min="1" max="20" value={v.count} onChange={(e) => setV({ ...v, count: e.target.value })} /></Field>
            <Field label="Difficulty" className="w-44"><Select value={v.difficulty} onChange={(e) => setV({ ...v, difficulty: e.target.value })}><option value="MIXED">Mixed</option><option value="EASY">Easy</option><option value="MEDIUM">Medium</option><option value="HARD">Hard</option></Select></Field>
            <Button type="submit" icon={Sparkles} className="ml-auto" loading={generate.isPending} disabled={!ready || v.types.length === 0 || (!v.topic.trim() && !v.sourceText.trim())}>Draft questions</Button>
          </div>
        </form>
      </Card>
      {note && <Alert tone="info">{note}</Alert>}
      {drafts.length > 0 && (
        <Card>
          <CardHeader title={`${plural(drafts.length, 'draft question')} to review`} description="Check each answer key. Untick or discard what you do not want, then save the rest to a question bank." />
          <QuestionDrafts drafts={drafts} setDrafts={setDrafts} defaultBankTitle={v.topic.trim().slice(0, 120)} />
        </Card>
      )}
    </div>
  );
}

// ── Assignment ───────────────────────────────────────────────────────────────
function AssignmentTool({ ready, onDone }) {
  const navigate = useNavigate();
  const classes = useTeachingClasses();
  const [v, setV] = useState({ topic: '', details: '', points: 100, withRubric: true });
  const [draft, setDraft] = useState(null);
  const [classId, setClassId] = useState('');
  const [error, setError] = useState(null);
  const generate = useAction(() => api.post('/ai/assignment', { topic: v.topic.trim(), details: v.details.trim() || undefined, points: Number(v.points) || 100, withRubric: v.withRubric }), {
    onSuccess: (r) => { onDone(); setDraft(r); },
    onError: (err) => aiError(err, setError),
  });
  const create = useAction(async () => {
    const rubric = draft.rubric ? await api.post('/rubrics', draft.rubric) : null;
    return api.post(`/classes/${classId}/assignments`, { title: draft.title, instructionsHtml: draft.instructionsHtml, points: rubric?.totalPoints ?? draft.points, rubricId: rubric?.id ?? null, status: 'DRAFT' });
  }, {
    invalidate: [['rubrics'], ['class', classId]], success: 'Saved as a draft assignment. Set the dates and publish it when you are ready.',
    onSuccess: (a) => navigate(`/classes/${classId}/assignments/${a.id}`),
  });
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Card className="min-w-0 xl:self-start">
        <CardHeader icon={ClipboardList} title="Draft an assignment" description="Instructions for students, with an optional grading rubric." />
        <form onSubmit={(e) => { e.preventDefault(); setError(null); generate.mutate(); }} className="space-y-4">
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="What is the assignment about?"><Input value={v.topic} onChange={(e) => setV({ ...v, topic: e.target.value })} required minLength={3} maxLength={300} placeholder="e.g. A reflection essay on technology in daily life" /></Field>
          <Field label="Details" optional hint="Length, format, what to submit, anything specific to your class."><Textarea rows={3} value={v.details} onChange={(e) => setV({ ...v, details: e.target.value })} maxLength={2000} /></Field>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Points" className="w-28"><Input type="number" min="1" max="1000" value={v.points} onChange={(e) => setV({ ...v, points: e.target.value })} /></Field>
            <Checkbox className="mb-2" label="Also draft a rubric" checked={v.withRubric} onChange={(e) => setV({ ...v, withRubric: e.target.checked })} />
            <Button type="submit" icon={Sparkles} className="ml-auto" loading={generate.isPending} disabled={!ready || v.topic.trim().length < 3}>Draft assignment</Button>
          </div>
        </form>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="Draft" description={draft ? 'Review it. You can edit everything after saving it to a class.' : null} />
        {!draft ? <EmptyState compact icon={BookOpenCheck} title="The draft appears here" /> : (
          <div className="space-y-4">
            <div><p className="text-lg font-semibold text-ink">{draft.title}</p><p className="text-[13px] text-faint">{formatScore(draft.points)} points</p></div>
            <RichText html={draft.instructionsHtml} />
            {draft.rubric && (
              <div>
                <p className="mb-1.5 text-sm font-semibold text-ink">Rubric: {draft.rubric.title}</p>
                <ul className="divide-y divide-line rounded-xl border border-line text-[13px]">
                  {draft.rubric.criteria.map((c) => <li key={c.title} className="p-2.5"><span className="font-medium text-ink">{c.title}</span> <span className="text-faint">· {formatScore(c.maxPoints)} pts</span>{c.description && <span className="block text-soft">{c.description}</span>}<span className="mt-0.5 block text-faint">{c.levels.map((l) => `${l.title} ${formatScore(l.points)}`).join(' · ')}</span></li>)}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <Field label="Save as a draft assignment in" className="min-w-0 flex-1 basis-56"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choose a class…</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>
              <Button loading={create.isPending} disabled={!classId} onClick={() => create.mutate()}>Save draft</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Rubric ───────────────────────────────────────────────────────────────────
function RubricTool({ ready, onDone }) {
  const [v, setV] = useState({ task: '', points: 100, criteriaCount: 4 });
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const generate = useAction(() => api.post('/ai/rubric', { task: v.task.trim(), points: Number(v.points) || 100, criteriaCount: Number(v.criteriaCount) || 4 }), {
    onSuccess: (r) => { onDone(); setDraft(r.rubric); setSaved(null); },
    onError: (err) => aiError(err, setError),
  });
  return (
    <Card className="max-w-3xl">
      <CardHeader icon={Table2} title="Draft a rubric" description="Criteria with four levels of performance. It opens in the rubric editor so that you can adjust it before saving." />
      <form onSubmit={(e) => { e.preventDefault(); setError(null); generate.mutate(); }} className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="What will students do?"><Textarea rows={3} value={v.task} onChange={(e) => setV({ ...v, task: e.target.value })} required minLength={3} maxLength={2000} placeholder="e.g. A five-minute group presentation explaining how a network router works" /></Field>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Total points" className="w-32"><Input type="number" min="1" max="1000" value={v.points} onChange={(e) => setV({ ...v, points: e.target.value })} /></Field>
          <Field label="Criteria" className="w-28"><Input type="number" min="2" max="8" value={v.criteriaCount} onChange={(e) => setV({ ...v, criteriaCount: e.target.value })} /></Field>
          <Button type="submit" icon={Sparkles} className="ml-auto" loading={generate.isPending} disabled={!ready || v.task.trim().length < 3}>Draft rubric</Button>
        </div>
      </form>
      {saved && <Alert tone="ok" className="mt-4" action={<Button size="sm" variant="secondary" to="/rubrics">Open rubrics</Button>}>“{saved.title}” was saved to your rubrics.</Alert>}
      {draft && <RubricDialog draft={draft} onClose={() => setDraft(null)} onSaved={setSaved} />}
    </Card>
  );
}

// ── Writing help ─────────────────────────────────────────────────────────────
const PROMPTS = ['Simplify this for first-year students', 'Suggest three in-class activities for this topic', 'Rewrite this announcement to be clear and friendly', 'Give two real-life examples from the Philippines'];

function AssistantTool({ ready, onDone }) {
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const ask = useAction(() => api.post('/ai/assistant', { prompt: prompt.trim(), context: context.trim() || undefined }), {
    onSuccess: (r) => { onDone(); setAnswer(r.text); },
    onError: (err) => aiError(err, setError),
  });
  const paragraphs = useMemo(() => (answer ?? '').split(/\n{2,}/), [answer]);
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Card className="min-w-0 xl:self-start">
        <CardHeader icon={Wand2} title="Writing help" description="Ask for ideas, or paste text to improve, shorten, simplify or translate." />
        <form onSubmit={(e) => { e.preventDefault(); setError(null); ask.mutate(); }} className="space-y-4">
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="What do you need?"><Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required minLength={3} maxLength={4000} /></Field>
          <div className="flex flex-wrap gap-1.5">{PROMPTS.map((p) => <button key={p} type="button" onClick={() => setPrompt(p)} className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-soft hover:border-brand hover:text-brand">{p}</button>)}</div>
          <Field label="Text to work on" optional><Textarea rows={5} value={context} onChange={(e) => setContext(e.target.value)} maxLength={20000} /></Field>
          <div className="flex justify-end"><Button type="submit" icon={Send} loading={ask.isPending} disabled={!ready || prompt.trim().length < 3}>Ask</Button></div>
        </form>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="Answer" action={answer ? <Button size="sm" variant="secondary" icon={Copy} onClick={() => navigator.clipboard?.writeText(answer).then(() => toast.success('Copied.'), () => toast.error('Could not copy. Select the text and copy it manually.'))}>Copy</Button> : null} />
        {answer === null ? <EmptyState compact icon={Bot} title="The answer appears here" /> : (
          // Shown as plain text: the answer is never interpreted as HTML.
          <div className="space-y-3 text-[15px] leading-relaxed text-ink">{paragraphs.map((p, i) => <p key={`${i}-${p.slice(0, 12)}`} className="whitespace-pre-wrap">{p}</p>)}</div>
        )}
      </Card>
    </div>
  );
}

