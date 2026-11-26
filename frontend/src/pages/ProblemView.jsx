// One coding problem: the statement, an editor, and the history of submissions.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Code2, History, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import CodeWorkbench, { ProblemStatement, TestResults } from '../components/CodeWorkbench.jsx';
import { Badge, Button, Card, CardHeader, cn, EmptyState, PageHeader, QueryState, Select } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDateTime, formatPercent, plural } from '../lib/format.js';
import { ProblemDialog } from './Programming.jsx';

const EMPTY_SUBMISSIONS = [];

export default function ProblemView() {
  const { problemId } = useParams();
  const { isStudent } = useAuth();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(null);
  const [submissionFilter, setSubmissionFilter] = useState('all');
  const problem = useQuery({ queryKey: ['programming', 'problem', problemId, undefined], queryFn: () => api.get(`/programming/problems/${problemId}`) });
  const submissions = useQuery({ queryKey: ['programming', 'submissions', problemId], queryFn: () => api.get(`/programming/problems/${problemId}/submissions`) });
  const submissionRows = submissions.data ?? EMPTY_SUBMISSIONS;
  const visibleSubmissions = useMemo(() => submissionRows.filter((s) => {
    if (submissionFilter === 'passed') return s.status === 'COMPLETED' && s.scorePercent >= 100;
    if (submissionFilter === 'needs-work') return s.status === 'COMPLETED' && s.scorePercent < 100;
    if (submissionFilter === 'errors') return s.status === 'ERROR';
    return true;
  }), [submissionRows, submissionFilter]);
  const completedSubmissions = submissionRows.filter((s) => s.status === 'COMPLETED');
  const bestScore = completedSubmissions.length ? Math.max(...completedSubmissions.map((s) => s.scorePercent ?? 0)) : null;
  const fullScoreCount = completedSubmissions.filter((s) => s.scorePercent >= 100).length;

  return (
    <QueryState query={problem}>
      {(p) => (
        <>
          <PageHeader back={{ to: '/programming', label: isStudent ? 'Coding practice' : 'Coding problems' }} title={p.title} description={[p.classLabel, p.runner?.languages.filter((l) => p.allowedLanguages.includes(l.id)).map((l) => l.label).join(', ')].filter(Boolean).join(' · ')}
            actions={!isStudent && <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit problem</Button>} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="min-w-0 space-y-5">
              <Card><CardHeader icon={Code2} title="Problem" /><ProblemStatement problem={p} /></Card>
              <Card>
                <CardHeader icon={History} title={isStudent ? 'My submissions' : 'Submissions'} description={isStudent ? 'Latest first. Practice does not count toward your grade.' : 'Latest first.'} />
                <QueryState query={submissions} loader={<p className="text-sm text-faint">Loading submissions…</p>}>
                  {(rows) => rows.length === 0 ? <EmptyState compact icon={History} title="No submissions yet" description={isStudent ? 'Your submitted solutions will appear here.' : 'Student attempts will appear here once the problem is shared.'} /> : (
                    <>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1.5" aria-label="Submission summary">
                          <Badge>{plural(rows.length, 'submission')}</Badge>
                          {bestScore != null && <Badge tone={bestScore >= 100 ? 'ok' : 'info'}>Best {formatPercent(bestScore, 0)}</Badge>}
                          {fullScoreCount > 0 && <Badge tone="ok">{plural(fullScoreCount, 'full-score attempt')}</Badge>}
                        </div>
                        <Select value={submissionFilter} onChange={(e) => setSubmissionFilter(e.target.value)} aria-label="Filter submissions" className="w-full sm:w-48">
                          <option value="all">All submissions</option><option value="passed">Full score</option><option value="needs-work">Needs work</option><option value="errors">Could not run</option>
                        </Select>
                      </div>
                      {visibleSubmissions.length === 0 ? (
                        <EmptyState compact icon={History} title="No submissions in this group" description="Choose another result filter or show the full history." action={<Button size="sm" variant="secondary" onClick={() => setSubmissionFilter('all')}>Show all submissions</Button>} />
                      ) : (
                        <ul className="divide-y divide-line">
                          {visibleSubmissions.map((s) => <li key={s.id} className="py-2.5 first:pt-0 last:pb-0"><Submission s={s} showStudent={!isStudent} languageLabel={p.runner?.languages.find((l) => l.id === s.language)?.label ?? s.language} onLoad={() => setLoaded({ language: s.language, code: s.code, key: s.id })} /></li>)}
                        </ul>
                      )}
                    </>
                  )}
                </QueryState>
              </Card>
            </div>
            <Card className="min-w-0 xl:sticky xl:top-24 xl:self-start">
              <CardHeader title={isStudent ? 'Your solution' : 'Try a solution'} description={isStudent ? null : 'Check that your test cases accept a correct program before giving the problem to students.'} />
              <CodeWorkbench key={loaded?.key ?? 'fresh'} problem={p} value={loaded ?? undefined} canSubmit={isStudent} onSubmitted={() => { client.invalidateQueries({ queryKey: ['programming'] }); }} />
            </Card>
          </div>
          {editing && <ProblemDialog problemId={p.id} languages={p.runner?.languages ?? []} onClose={() => setEditing(false)} />}
        </>
      )}
    </QueryState>
  );
}

function Submission({ s, showStudent, languageLabel, onLoad }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-left">
          <ChevronDown className={cn('size-4 shrink-0 text-faint transition-transform', !open && '-rotate-90')} aria-hidden="true" />
          <span className="min-w-0"><span className="block truncate font-medium text-ink">{showStudent ? s.student?.name : formatDateTime(s.createdAt)}</span><span className="block text-xs text-faint">{showStudent ? `${formatDateTime(s.createdAt)} · ` : ''}{languageLabel}</span></span>
        </button>
        {s.status === 'ERROR' ? <Badge tone="bad">Did not run</Badge> : <Badge tone={s.scorePercent >= 100 ? 'ok' : s.scorePercent > 0 ? 'warn' : 'bad'}>{s.passedCount}/{s.totalCount} tests · {formatPercent(s.scorePercent, 0)}</Badge>}
        <Button size="sm" variant="ghost" onClick={onLoad}>Load into editor</Button>
      </div>
      {open && (
        <div className="mt-3 space-y-3 pl-6">
          <pre className="max-h-72 overflow-auto rounded-lg bg-[#151826] p-3 text-[13px] leading-relaxed text-[#e6e8f2]"><code>{s.code}</code></pre>
          <TestResults result={{ ...s, mode: 'SUBMIT' }} />
        </div>
      )}
    </div>
  );
}
