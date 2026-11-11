// Write code against a problem, try it on the sample tests, and (for students) submit it.
// Running needs a code runner on the server; without one the code is still saved with the
// answer and the teacher checks it.
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, Clock, EyeOff, Play, RotateCcw, Send, Terminal, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatPercent, plural } from '../lib/format.js';
import LazyCodeEditor from './LazyCodeEditor.jsx';
import RichText from './RichText.jsx';
import { Alert, Badge, Button, cn, Select, Textarea } from './ui.jsx';

const OUTCOME = {
  PASSED: { label: 'Passed', tone: 'ok', icon: CheckCircle2 },
  WRONG_ANSWER: { label: 'Wrong answer', tone: 'bad', icon: XCircle },
  RUNTIME_ERROR: { label: 'Runtime error', tone: 'bad', icon: XCircle },
  TIME_LIMIT: { label: 'Too slow', tone: 'warn', icon: Clock },
};

export function TestResults({ result }) {
  if (!result) return null;
  if (result.mode === 'CUSTOM') {
    return (
      <div className="space-y-2">
        {result.compileError && <pre className="overflow-x-auto rounded-lg bg-bad-soft p-3 text-[13px] text-bad"><code>{result.compileError}</code></pre>}
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">Output{result.timedOut ? ' — stopped: took too long' : result.exitCode ? ` — exit code ${result.exitCode}` : ''}</p>
        <pre className="max-h-60 overflow-auto rounded-lg bg-[#151826] p-3 text-[13px] leading-relaxed text-[#e6e8f2]"><code>{result.stdout || '(no output)'}</code></pre>
        {result.stderr && <pre className="max-h-40 overflow-auto rounded-lg bg-bad-soft p-3 text-[13px] text-bad"><code>{result.stderr}</code></pre>}
      </div>
    );
  }
  if (result.status === 'ERROR') {
    return <div><p className="mb-1.5 text-sm font-semibold text-bad">The program could not be compiled or started</p><pre className="max-h-60 overflow-auto rounded-lg bg-bad-soft p-3 text-[13px] text-bad"><code>{result.errorMessage}</code></pre></div>;
  }
  return (
    <div>
      <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
        {result.passedCount === result.totalCount ? <CheckCircle2 className="size-5 text-ok" aria-hidden="true" /> : <XCircle className="size-5 text-bad" aria-hidden="true" />}
        {result.passedCount} of {plural(result.totalCount, 'test')} passed
        {result.scorePercent != null && <Badge tone={result.scorePercent >= 100 ? 'ok' : result.scorePercent > 0 ? 'warn' : 'bad'}>Score {formatPercent(result.scorePercent, 0)}</Badge>}
      </p>
      <ol className="space-y-2">
        {result.results.map((r, i) => {
          const o = OUTCOME[r.outcome] ?? OUTCOME.WRONG_ANSWER;
          return (
            <li key={i} className={cn('rounded-lg border p-3 text-[13px]', r.passed ? 'border-ok/40' : 'border-bad/40')}>
              <p className="flex flex-wrap items-center gap-2 font-semibold text-ink"><o.icon className={cn('size-4', r.passed ? 'text-ok' : o.tone === 'warn' ? 'text-warn' : 'text-bad')} aria-hidden="true" />Test {i + 1}: {o.label}{r.isHidden && <Badge icon={EyeOff}>Hidden test</Badge>}</p>
              {!r.isHidden && !r.passed && (
                <dl className="mt-2 grid gap-2 sm:grid-cols-3">
                  {[['Input', r.input], ['Expected', r.expectedOutput], ['Your output', r.stdout || r.stderr || '(nothing)']].map(([label, text]) => (
                    <div key={label}><dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</dt><dd><pre className="mt-0.5 max-h-28 overflow-auto rounded bg-raised p-2 font-mono text-xs text-ink">{text}</pre></dd></div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * @param {{ problem: object, value?: { language: string, code: string }, onChange?: Function, studentAnswerId?: string,
 *           canSubmit?: boolean, onSubmitted?: Function, readOnly?: boolean, minHeight?: number }} props
 */
export default function CodeWorkbench({ problem, value, onChange, studentAnswerId, canSubmit = false, onSubmitted, readOnly = false, minHeight = 320 }) {
  const languages = problem.runner?.languages?.filter((l) => problem.allowedLanguages.includes(l.id)) ?? problem.allowedLanguages.map((id) => ({ id, label: id }));
  const [language, setLanguage] = useState(value?.language && problem.allowedLanguages.includes(value.language) ? value.language : problem.allowedLanguages[0]);
  const [code, setCode] = useState(value?.code ?? problem.starterCode?.[language] ?? '');
  const [stdin, setStdin] = useState('');
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const configured = problem.runner?.configured !== false;
  // Inside a quiz the code is part of the saved answer; in practice nothing is kept unless it is checked.
  const inQuiz = Boolean(studentAnswerId);

  const update = (next) => { setCode(next.code); setLanguage(next.language); onChange?.(next.code.trim() ? next : null); };
  const call = async (kind) => {
    setBusy(kind);
    setError(null);
    try {
      const body = { language, code, ...(studentAnswerId ? { studentAnswerId } : {}), ...(kind === 'custom' ? { stdin } : {}) };
      const data = await api.post(`/programming/problems/${problem.id}/${kind === 'submit' ? 'submit' : 'run'}`, body);
      setResult(kind === 'submit' ? { ...data, mode: 'SUBMIT' } : data);
      if (kind === 'submit') onSubmitted?.(data);
    } catch (err) {
      setResult(null);
      setError(err.code === 'CODE_RUNNER_UNAVAILABLE' ? `Automatic checking is not available on this server right now. ${inQuiz ? 'Your code is saved with your answer, and your teacher will mark it.' : 'Please try again later.'}` : err.fields?.language ?? err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[13px] font-medium text-soft">Language
          <Select value={language} disabled={readOnly || languages.length < 2} onChange={(e) => { const next = e.target.value; const untouched = !code.trim() || code === (problem.starterCode?.[language] ?? ''); update({ language: next, code: untouched ? problem.starterCode?.[next] ?? '' : code }); }} className="h-9 w-48">
            {languages.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </label>
        {!readOnly && problem.starterCode?.[language] && code !== problem.starterCode[language] && <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => update({ language, code: problem.starterCode[language] })}>Reset to starter code</Button>}
        <span className="ml-auto text-xs text-faint">Limit: {problem.timeLimitMs / 1000}s per test</span>
      </div>
      <LazyCodeEditor value={code} language={language} readOnly={readOnly} minHeight={minHeight} onChange={(next) => update({ language, code: next })} ariaLabel="Your code" />
      {!configured && <Alert tone="info" title="Code is not run automatically on this server">{inQuiz ? 'Write your program as usual: it is saved with your answer, and your teacher marks it by hand.' : 'You can write code here, but it cannot be run or checked until an administrator connects a code runner.'}</Alert>}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={Play} loading={busy === 'run'} disabled={!code.trim() || !configured || Boolean(busy)} onClick={() => call('run')}>Run sample tests</Button>
          <Button variant="ghost" icon={Terminal} onClick={() => setCustom((v) => !v)} aria-expanded={custom}>Try my own input</Button>
          {canSubmit && <Button icon={Send} className="ml-auto" loading={busy === 'submit'} disabled={!code.trim() || !configured || Boolean(busy)} onClick={() => call('submit')}>Submit for checking</Button>}
        </div>
      )}
      {custom && !readOnly && (
        <div className="rounded-xl border border-line p-3">
          <label htmlFor="custom-stdin" className="mb-1.5 block text-[13px] font-medium text-ink">Input for the program (stdin)</label>
          <Textarea id="custom-stdin" rows={3} value={stdin} onChange={(e) => setStdin(e.target.value)} className="font-mono text-[13px]" spellCheck={false} />
          <div className="mt-2 flex justify-end"><Button size="sm" variant="secondary" icon={Play} loading={busy === 'custom'} disabled={!code.trim() || !configured || Boolean(busy)} onClick={() => call('custom')}>Run</Button></div>
        </div>
      )}
      {error && <Alert tone="warn" title="Could not run"><CircleSlash className="mr-1 inline size-3.5" aria-hidden="true" />{error}</Alert>}
      <div aria-live="polite"><TestResults result={result} /></div>
    </div>
  );
}

/** For a programming question inside a quiz attempt: loads the problem, then shows the workbench. */
export function ProgrammingAnswer({ problemId, studentAnswerId, value, onChange, disabled }) {
  const problem = useQuery({ queryKey: ['programming', 'problem', problemId, studentAnswerId], queryFn: () => api.get(`/programming/problems/${problemId}`, { studentAnswerId }), enabled: Boolean(problemId), staleTime: 300_000 });
  const [ready, setReady] = useState(false);
  useEffect(() => { if (problem.data) setReady(true); }, [problem.data]);
  if (problem.isError) return <Alert tone="bad">{problem.error.message}</Alert>;
  if (!ready) return <p className="text-sm text-faint">Loading the problem…</p>;
  const p = problem.data;
  return (
    <div className="space-y-4">
      {p.statementHtml && <ProblemStatement problem={p} />}
      <CodeWorkbench problem={p} value={value} onChange={onChange} studentAnswerId={studentAnswerId} canSubmit readOnly={disabled} minHeight={300} />
      <p className="text-xs text-faint">Your code is saved with your answer as you type.{p.runner?.configured !== false && ' “Submit for checking” runs all tests, including hidden ones; your best checked result counts.'}</p>
    </div>
  );
}

export function ProblemStatement({ problem }) {
  const samples = problem.testCases.filter((t) => !t.isHidden);
  return (
    <div>
      <RichText html={problem.statementHtml} />
      {samples.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Sample tests</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {samples.map((t, i) => (
              <li key={t.id} className="rounded-xl border border-line p-3 text-[13px]">
                <p className="mb-1.5 font-semibold text-ink">Sample {i + 1}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div><p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Input</p><pre className="mt-0.5 overflow-auto rounded bg-raised p-2 font-mono text-xs text-ink">{t.input || '(none)'}</pre></div>
                  <div><p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Expected output</p><pre className="mt-0.5 overflow-auto rounded bg-raised p-2 font-mono text-xs text-ink">{t.expectedOutput}</pre></div>
                </div>
              </li>
            ))}
          </ul>
          {problem.hiddenTestCount > 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-faint"><EyeOff className="size-3.5" aria-hidden="true" />{plural(problem.hiddenTestCount, 'hidden test')} also check your program when you submit.</p>}
        </div>
      )}
    </div>
  );
}
