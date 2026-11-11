// Coding problems: teachers write them (statement + test cases); students practise.
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Code2, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import LazyCodeEditor from '../components/LazyCodeEditor.jsx';
import LazyEditor from '../components/LazyEditor.jsx';
import { Alert, Badge, Button, Card, Checkbox, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, PageHeader, PageLoader, QueryState, SearchInput, Select, Switch, Textarea, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatPercent, plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { classLabel } from './classes/useClass.js';

export default function Programming() {
  const { isStudent } = useAuth();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const term = useDebounced(search.trim());
  const status = useQuery({ queryKey: ['programming', 'status'], queryFn: () => api.get('/programming/status'), staleTime: 300_000 });
  const query = useQuery({ queryKey: ['programming', 'problems', term], queryFn: () => api.get('/programming/problems', { search: term || undefined }) });
  const remove = useAction((id) => api.delete(`/programming/problems/${id}`), { invalidate: [['programming']], success: 'Problem deleted.', onSuccess: () => setDialog(null) });
  const label = (id) => status.data?.languages.find((l) => l.id === id)?.label ?? id;

  return (
    <>
      <PageHeader title={isStudent ? 'Coding practice' : 'Coding problems'} description={isStudent ? 'Practice problems shared by your teachers. Your program is checked against test cases.' : 'Write a problem once, then use it for practice, as an assignment, or as a question in a quiz.'}
        actions={!isStudent && <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New problem</Button>} />
      {status.data && !status.data.configured && (
        <Alert tone="warn" className="mb-5" title="Programs are not run automatically on this server yet">
          {isStudent ? 'You can still write and save your code; your teacher checks it.' : 'An administrator needs to connect a code runner (set CODE_RUNNER_PROVIDER and CODE_RUNNER_URL). Until then, problems can be written and code is saved, but nothing is executed.'}
        </Alert>
      )}
      <SearchInput value={search} onChange={setSearch} placeholder="Search problems…" className="mb-4 w-full sm:w-72" />
      <QueryState query={query}>
        {(problems) => problems.length === 0 ? (
          <Card><EmptyState icon={Code2} title={term ? 'No problems match' : isStudent ? 'No practice problems yet' : 'No coding problems yet'} description={term ? null : isStudent ? 'Problems appear here when a teacher shares them with one of your classes.' : 'A problem has a statement, sample tests that students can see, and hidden tests that decide the score.'} action={!isStudent && !term ? <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New problem</Button> : null} /></Card>
        ) : (
          <ul className="space-y-3">
            {problems.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface p-4 shadow-card">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Code2 className="size-5" aria-hidden="true" /></span>
                <Link to={`/programming/${p.id}`} className="min-w-0 flex-1 basis-56">
                  <span className="block truncate font-semibold text-ink hover:text-brand">{p.title}</span>
                  <span className="block truncate text-[13px] text-faint">{p.allowedLanguages.map(label).join(', ')}{p.classLabel ? ` · ${isStudent ? p.classLabel : `practice for ${p.classLabel}`}` : isStudent ? '' : ' · not shared as practice'}{p.testCases != null ? ` · ${plural(p.testCases, 'test')}` : ''}{p.updatedAt ? ` · updated ${relativeTime(p.updatedAt)}` : ''}</span>
                </Link>
                {isStudent ? (
                  p.bestScore == null ? <Badge>Not attempted</Badge> : <Badge tone={p.bestScore >= 100 ? 'ok' : p.bestScore > 0 ? 'warn' : 'bad'} icon={p.bestScore >= 100 ? CheckCircle2 : undefined}>Best {formatPercent(p.bestScore, 0)}</Badge>
                ) : (
                  <>
                    <span className="text-[13px] text-soft">{plural(p.submissions, 'submission')}</span>
                    <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Options for ${p.title}`} onClick={toggle} {...props} />}>
                      <MenuItem icon={Pencil} onClick={() => setDialog({ edit: p.id })}>Edit</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: p })}>Delete</MenuItem>
                    </Menu>
                  </>
                )}
                <Button size="sm" variant="secondary" to={`/programming/${p.id}`}>{isStudent ? 'Solve' : 'Open'}</Button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {dialog?.edit !== undefined && <ProblemDialog problemId={dialog.edit} languages={status.data?.languages ?? []} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title={`Delete “${dialog?.remove?.title}”?`} confirmLabel="Delete problem">
        Students’ past submissions are kept on record, but the problem can no longer be opened or used in new quizzes.
      </ConfirmDialog>
    </>
  );
}

const blankCase = { input: '', expectedOutput: '', isHidden: false, weight: 1, comparison: 'TRIMMED' };

export function ProblemDialog({ problemId, languages, onClose }) {
  const existing = useQuery({ queryKey: ['programming', 'problem', problemId, undefined], queryFn: () => api.get(`/programming/problems/${problemId}`), enabled: Boolean(problemId) });
  return (
    <Modal open onClose={onClose} title={problemId ? 'Edit coding problem' : 'New coding problem'} size="xl">
      {problemId && existing.isPending ? <PageLoader /> : <ProblemForm key={problemId ?? 'new'} problem={existing.data} languages={languages} onClose={onClose} />}
    </Modal>
  );
}

function ProblemForm({ problem, languages, onClose }) {
  const navigate = useNavigate();
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }) });
  const [v, setV] = useState(() => ({
    title: problem?.title ?? '', statementHtml: problem?.statementHtml ?? '', classId: problem?.classId ?? '', allowedLanguages: problem?.allowedLanguages ?? ['PYTHON'],
    starterCode: problem?.starterCode ?? {}, timeLimitMs: problem?.timeLimitMs ?? 3000, partialCredit: problem?.partialCredit ?? true,
    testCases: problem?.testCases?.map(({ input, expectedOutput, isHidden, weight, comparison }) => ({ input, expectedOutput, isHidden, weight, comparison })) ?? [{ ...blankCase }, { ...blankCase, isHidden: true }],
  }));
  const [starterFor, setStarterFor] = useState(v.allowedLanguages[0]);
  const [errors, setErrors] = useState({});
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));
  const setCase = (i, patch) => set('testCases', v.testCases.map((t, n) => (n === i ? { ...t, ...patch } : t)));
  const save = useAction(() => {
    const body = {
      title: v.title.trim(), statementHtml: v.statementHtml, classId: v.classId || null, allowedLanguages: v.allowedLanguages,
      starterCode: Object.fromEntries(Object.entries(v.starterCode).filter(([lang, code]) => v.allowedLanguages.includes(lang) && code.trim())),
      timeLimitMs: Number(v.timeLimitMs) || 3000, partialCredit: v.partialCredit,
      testCases: v.testCases.map((t) => ({ ...t, weight: Number(t.weight) || 0 })),
    };
    return problem ? api.patch(`/programming/problems/${problem.id}`, body) : api.post('/programming/problems', body);
  }, {
    invalidate: [['programming']], success: problem ? 'Problem saved.' : 'Problem created.',
    onSuccess: (saved) => { onClose(); if (!problem) navigate(`/programming/${saved.id}`); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  const activeStarter = v.allowedLanguages.includes(starterFor) ? starterFor : v.allowedLanguages[0];

  return (
    <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-5">
      {Object.keys(errors).length > 0 && <Alert tone="bad">{Object.values(errors).join(' ')}</Alert>}
      <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} placeholder="e.g. Sum of an array" /></Field>
      <Field label="Problem statement" hint="Describe the input format, the output format and any limits.">
        <LazyEditor value={v.statementHtml} onChange={(html) => set('statementHtml', html)} minHeight={150} ariaLabel="Problem statement" placeholder="The first line contains n. The second line contains n integers. Print their sum." />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">Languages students may use</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {languages.map((l) => <Checkbox key={l.id} label={l.label} checked={v.allowedLanguages.includes(l.id)} onChange={(e) => set('allowedLanguages', e.target.checked ? [...v.allowedLanguages, l.id] : v.allowedLanguages.filter((x) => x !== l.id))} />)}
          </div>
          {v.allowedLanguages.length === 0 && <p className="mt-1.5 text-[13px] text-bad">Choose at least one language.</p>}
        </fieldset>
        <Field label="Time limit per test (seconds)" error={errors.timeLimitMs}><Input type="number" min="0.5" max="15" step="0.5" value={v.timeLimitMs / 1000} onChange={(e) => set('timeLimitMs', Math.round(Number(e.target.value) * 1000))} /></Field>
      </div>

      {v.allowedLanguages.length > 0 && (
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium text-ink" htmlFor="starter-language">Starter code <span className="text-xs font-normal text-faint">optional — what students see when they open the problem</span></label>
            <Select id="starter-language" value={activeStarter} onChange={(e) => setStarterFor(e.target.value)} className="h-8 w-44 text-[13px]">{v.allowedLanguages.map((id) => <option key={id} value={id}>{languages.find((l) => l.id === id)?.label ?? id}</option>)}</Select>
          </div>
          <LazyCodeEditor key={activeStarter} value={v.starterCode[activeStarter] ?? ''} language={activeStarter} minHeight={150} onChange={(code) => set('starterCode', { ...v.starterCode, [activeStarter]: code })} ariaLabel="Starter code" />
        </div>
      )}

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink">Test cases</legend>
        <p className="mb-2 text-[13px] text-faint">Students see the input and expected output of sample tests. For hidden tests they only learn whether their program passed.</p>
        {errors.testCases && <p className="mb-2 text-[13px] text-bad" role="alert">{errors.testCases}</p>}
        <ol className="space-y-3">
          {v.testCases.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className={cn('rounded-xl border p-3', t.isHidden ? 'border-line bg-raised/50' : 'border-line')}>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold text-ink">Test {i + 1}</span>
                <Checkbox checked={t.isHidden} onChange={(e) => setCase(i, { isHidden: e.target.checked })} label="Hidden" />
                <label className="flex items-center gap-1.5 text-[13px] text-soft">Weight<Input type="number" min="0" max="100" step="any" value={t.weight} onChange={(e) => setCase(i, { weight: e.target.value })} className="h-8 w-16 px-2 text-right" /></label>
                <Select value={t.comparison} onChange={(e) => setCase(i, { comparison: e.target.value })} aria-label="How the output is compared" className="h-8 w-52 text-[13px]">
                  <option value="TRIMMED">Ignore spaces at line ends</option>
                  <option value="TOKENS">Compare words only (any spacing)</option>
                  <option value="EXACT">Exact match</option>
                </Select>
                <Button variant="ghost" size="sm" icon={X} className="ml-auto" disabled={v.testCases.length <= 1} onClick={() => set('testCases', v.testCases.filter((_, n) => n !== i))} aria-label={`Remove test ${i + 1}`} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Input (stdin)"><Textarea rows={3} value={t.input} onChange={(e) => setCase(i, { input: e.target.value })} className="font-mono text-[13px]" spellCheck={false} /></Field>
                <Field label="Expected output"><Textarea rows={3} value={t.expectedOutput} onChange={(e) => setCase(i, { expectedOutput: e.target.value })} className="font-mono text-[13px]" spellCheck={false} required /></Field>
              </div>
            </li>
          ))}
        </ol>
        <Button variant="secondary" size="sm" icon={Plus} className="mt-2" disabled={v.testCases.length >= 25} onClick={() => set('testCases', [...v.testCases, { ...blankCase, isHidden: true }])}>Add a test case</Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Switch checked={v.partialCredit} onChange={(on) => set('partialCredit', on)} label="Partial credit" description="Score by the share of tests passed. Off: all tests must pass." />
        <Field label="Share as practice with" optional hint="Students of that class can open it under Coding practice.">
          <Select value={v.classId} onChange={(e) => set('classId', e.target.value)}><option value="">Not shared</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select>
        </Field>
      </div>

      <ModalActions>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={save.isPending} disabled={!v.title.trim() || v.allowedLanguages.length === 0}>{problem ? 'Save problem' : 'Create problem'}</Button>
      </ModalActions>
    </form>
  );
}
