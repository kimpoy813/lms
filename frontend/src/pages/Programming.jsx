// Coding problems: teachers write them (statement + test cases); students practise.
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Code2, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import LazyCodeEditor from '../components/LazyCodeEditor.jsx';
import LazyEditor from '../components/LazyEditor.jsx';
import { Alert, Badge, Button, Card, Checkbox, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, PageHeader, PageLoader, QueryState, SearchInput, Select, StatCard, Switch, Textarea, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { totalTimeHint } from '../lib/codeRunner.js';
import { formatPercent, plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { classLabel } from './classes/useClass.js';

const EMPTY_PROBLEMS = [];

export default function Programming() {
  const { isStudent, can } = useAuth();
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState('');
  const [language, setLanguage] = useState('');
  const [sort, setSort] = useState('recent');
  const [dialog, setDialog] = useState(null);
  const term = useDebounced(search.trim());
  const status = useQuery({ queryKey: ['programming', 'status'], queryFn: () => api.get('/programming/status'), staleTime: 300_000 });
  const query = useQuery({ queryKey: ['programming', 'problems', term], queryFn: () => api.get('/programming/problems', { search: term || undefined }) });
  const problems = query.data ?? EMPTY_PROBLEMS;
  const classOptions = useMemo(() => [...new Map(problems.filter((p) => p.classId).map((p) => [p.classId, { id: p.classId, label: p.classLabel ?? 'Class' }])).values()].sort((a, b) => a.label.localeCompare(b.label)), [problems]);
  const visibleProblems = useMemo(() => {
    const rows = problems.filter((p) => (!classId || p.classId === classId) && (!language || p.allowedLanguages.includes(language)));
    if (sort === 'title') return rows.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'submissions') return rows.sort((a, b) => b.submissions - a.submissions);
    if (sort === 'score') return rows.sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
    return rows;
  }, [problems, classId, language, sort]);
  const languages = status.data?.languages ?? [];
  const remove = useAction((id) => api.delete(`/programming/problems/${id}`), { invalidate: [['programming']], success: 'Problem deleted.', onSuccess: () => setDialog(null) });
  const label = (id) => languages.find((l) => l.id === id)?.label ?? id;
  const canUseAi = !isStudent && can('ai.use');
  const hasFilters = Boolean(search.trim() || classId || language);
  const clearFilters = () => { setSearch(''); setClassId(''); setLanguage(''); setSort('recent'); };

  return (
    <>
      <PageHeader title={isStudent ? 'Coding practice' : 'Coding problems'} description={isStudent ? 'Practice problems shared by your teachers. Run your code against sample tests, then check it against the hidden tests.' : 'Create a problem once, then share it with a class or use it in a quiz.'}
        actions={!isStudent && (
          <div className="flex flex-wrap items-center gap-2">
            {canUseAi && <Button variant="secondary" icon={Sparkles} to="/ai?tool=programming">Draft with AI</Button>}
            <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New problem</Button>
          </div>
        )} />
      {status.data && !status.data.configured && (
        <Alert tone="warn" className="mb-5" title="Programs are not run automatically on this server yet">
          {isStudent ? 'You can read the problems and write code, but it cannot be run or checked here until your school connects a code runner. Code you write in a quiz is still saved with your answers, and your teacher marks it.' : 'An administrator needs to connect a code runner (set CODE_RUNNER_PROVIDER to vercel-sandbox, piston, or local for dev). Until then you can write problems and add them to quizzes; students’ code in a quiz is saved for you to mark by hand, and practice problems cannot be checked.'}
        </Alert>
      )}
      <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search problems…" className="min-w-0 flex-1" />
        {classOptions.length > 1 && <Select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Filter by class" className="w-full sm:w-48"><option value="">All classes</option>{classOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>}
        {languages.length > 1 && <Select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Filter by language" className="w-full sm:w-44"><option value="">All languages</option>{languages.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select>}
        <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort coding problems" className="w-full sm:w-48">
          <option value="recent">{isStudent ? 'Recently added' : 'Recently updated'}</option><option value="title">Name A–Z</option>{isStudent ? <option value="score">Best score</option> : <option value="submissions">Most submissions</option>}
        </Select>
      </div>
      <QueryState query={query}>
        {(rows) => (
          <>
            {visibleProblems.length > 0 && <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Problems" value={visibleProblems.length} hint="Matching your filters" icon={Code2} />
              <StatCard label={isStudent ? 'Attempted' : 'Submissions'} value={isStudent ? visibleProblems.filter((p) => p.bestScore != null).length : visibleProblems.reduce((sum, p) => sum + p.submissions, 0).toLocaleString()} hint={isStudent ? 'Problems with a saved result' : 'Across matching problems'} icon={CheckCircle2} tone="info" />
              <StatCard label={isStudent ? 'Completed' : 'Shared for practice'} value={isStudent ? visibleProblems.filter((p) => p.bestScore >= 100).length : visibleProblems.filter((p) => p.classId).length} hint={isStudent ? 'Best score of 100%' : 'Available to a class'} icon={ClipboardList} tone="ok" />
            </div>}
            {hasFilters && <div className="mb-3 flex justify-end"><Button size="sm" variant="ghost" onClick={clearFilters}>Clear search and filters</Button></div>}
            {rows.length === 0 || visibleProblems.length === 0 ? (
              <Card><EmptyState icon={Code2} title={hasFilters ? 'No problems match those filters' : isStudent ? 'No practice problems yet' : 'No coding problems yet'} description={hasFilters ? 'Try a different search or clear your filters to see more problems.' : isStudent ? 'Problems appear here when a teacher shares them with one of your classes.' : 'A problem has a clear statement, visible sample tests and hidden tests that decide the score.'} action={!isStudent && !hasFilters ? <Button icon={Plus} onClick={() => setDialog({ edit: null })}>Create a problem</Button> : hasFilters ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : null} /></Card>
            ) : (
              <ul className="space-y-3">
                {visibleProblems.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface p-4 shadow-card transition-shadow hover:shadow-pop">
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
          </>
        )}
      </QueryState>
      {dialog?.edit !== undefined && <ProblemDialog problemId={dialog.edit} languages={languages} onClose={() => setDialog(null)} />}
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
      {problemId && existing.isPending ? <PageLoader label="Loading problem…" /> : problemId && existing.isError && !existing.data ? (
        <Alert tone="bad" title="Could not load this problem" action={<Button variant="secondary" onClick={() => existing.refetch()}>Try again</Button>}>{existing.error?.message}</Alert>
      ) : <ProblemForm key={problemId ?? 'new'} problem={existing.data} languages={languages} onClose={onClose} />}
    </Modal>
  );
}

function ProblemForm({ problem, languages, onClose }) {
  const navigate = useNavigate();
  const runner = useQuery({ queryKey: ['programming', 'status'], queryFn: () => api.get('/programming/status'), staleTime: 300_000 });
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
  const scoredCases = v.testCases.filter((test) => Number(test.weight) > 0).length;
  const sampleCases = v.testCases.filter((test) => !test.isHidden).length;
  const hiddenCases = v.testCases.length - sampleCases;

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
        <Field label="Time limit per test (seconds)" error={errors.timeLimitMs} hint={totalTimeHint(runner.data?.totalTimeLimitMs, v.testCases.length, v.timeLimitMs)}><Input type="number" min="0.5" max="15" step="0.5" value={v.timeLimitMs / 1000} onChange={(e) => set('timeLimitMs', Math.round(Number(e.target.value) * 1000))} /></Field>
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
        <p className="mb-2 text-[13px] text-faint">Samples show students the input and expected output. Hidden tests protect edge cases; students only see whether they passed. Weights control each test’s share of the score.</p>
        <p className="mb-2 text-xs text-soft">{plural(sampleCases, 'sample')} · {plural(hiddenCases, 'hidden test')} · {plural(scoredCases, 'test')} count toward the score</p>
        {errors.testCases && <p className="mb-2 text-[13px] text-bad" role="alert">{errors.testCases}</p>}
        {scoredCases === 0 && <p className="mb-2 text-[13px] text-bad" role="alert">Give a positive weight to at least one test so submissions can be scored.</p>}
        <ol className="space-y-3">
          {v.testCases.map((t, i) => (
            <li key={i} className={cn('rounded-xl border p-3', t.isHidden ? 'border-line bg-raised/50' : 'border-line')}>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold text-ink">Test {i + 1}</span>
                <Badge tone={t.isHidden ? 'warn' : 'ok'}>{t.isHidden ? 'Hidden' : 'Sample'}</Badge>
                <Checkbox checked={t.isHidden} onChange={(e) => setCase(i, { isHidden: e.target.checked })} label="Hide from students" />
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
        <Button type="submit" loading={save.isPending} disabled={!v.title.trim() || v.allowedLanguages.length === 0 || scoredCases === 0}>{problem ? 'Save problem' : 'Create problem'}</Button>
      </ModalActions>
    </form>
  );
}
