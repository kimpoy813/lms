// One question bank: its questions, and importing an existing test paper into it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, FileUp, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { toast } from '../components/toast.jsx';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, PageHeader, Pagination, QueryState, SearchInput, Select, useDebounced } from '../components/ui.jsx';
import { api, errorMessage } from '../lib/api.js';
import { formatScore, plural } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import ImportQuestions from './classes/quiz/ImportQuestions.jsx';
import QuestionEditor from './classes/quiz/QuestionEditor.jsx';
import { AnswerKey, DIFFICULTY, MarkedByBadge, QUESTION_TYPES, QuestionText, typeLabel } from './classes/quiz/QuestionParts.jsx';

export default function BankView() {
  const { bankId } = useParams();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ type: '', difficulty: '', topic: '' });
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const term = useDebounced(search.trim());
  const banks = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const bank = (banks.data ?? []).find((b) => b.id === bankId);
  const key = ['question-banks', bankId, 'questions', { term, ...filters, page }];
  const query = useQuery({ queryKey: key, queryFn: () => api.list(`/question-banks/${bankId}/questions`, { search: term || undefined, type: filters.type || undefined, difficulty: filters.difficulty || undefined, topic: filters.topic || undefined, page }), placeholderData: (prev) => prev });
  const refresh = () => { client.invalidateQueries({ queryKey: ['question-banks'] }); };
  const remove = useAction((id) => api.delete(`/question-banks/questions/${id}`), { invalidate: [['question-banks']], success: 'Question deleted.', onSuccess: () => setDialog(null) });
  const copy = useAction((id) => api.post(`/question-banks/questions/${id}/copy`, {}), { invalidate: [['question-banks']], success: 'Question duplicated.' });
  // The whole bank with its answers, in the format the import reads.
  const download = () => api.download(`/question-banks/${bankId}/export`, undefined, 'questions.json').catch((err) => toast.error(errorMessage(err)));
  const meta = query.data?.meta;
  const setFilter = (name, value) => { setFilters((f) => ({ ...f, [name]: value })); setPage(1); };

  return (
    <>
      <PageHeader back={{ to: '/question-banks', label: 'Question banks' }} title={bank?.title ?? 'Question bank'} description={bank ? [bank.subject, plural(bank.questionCount, 'question')].filter(Boolean).join(' · ') : null}
        actions={<>
          <Button variant="secondary" icon={Sparkles} to="/ai?tool=questions">Draft with AI</Button>
          {bank?.questionCount > 0 && <IconButton icon={Download} variant="secondary" label="Download the questions as a JSON file" onClick={download} />}
          <Button variant="secondary" icon={FileUp} onClick={() => setDialog({ import: true })}>Import questions</Button>
          <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New question</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search questions…" className="w-full sm:w-72" />
        <Select value={filters.type} onChange={(e) => setFilter('type', e.target.value)} aria-label="Question type" className="w-48"><option value="">All types</option>{Object.entries(QUESTION_TYPES).map(([v, t]) => <option key={v} value={v}>{t.label}</option>)}</Select>
        <Select value={filters.difficulty} onChange={(e) => setFilter('difficulty', e.target.value)} aria-label="Difficulty" className="w-40"><option value="">Any difficulty</option>{Object.entries(DIFFICULTY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        {(meta?.topics ?? []).length > 0 && <Select value={filters.topic} onChange={(e) => setFilter('topic', e.target.value)} aria-label="Topic" className="w-44"><option value="">All topics</option>{meta.topics.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}
      </div>
      <QueryState query={{ ...query, data: query.data?.data }}>
        {(questions) => questions.length === 0 ? (
          <Card><EmptyState icon={Plus} title={term || filters.type || filters.difficulty || filters.topic ? 'No questions match' : 'This bank is empty'} description={term || filters.type ? null : 'Write a question, or import questions you already have: as JSON, or a test paper as Word, PDF or text.'} action={<div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" icon={FileUp} onClick={() => setDialog({ import: true })}>Import questions</Button><Button icon={Plus} onClick={() => setDialog({ edit: null })}>New question</Button></div>} /></Card>
        ) : (
          <ol className="space-y-3">
            {questions.map((q, i) => (
              <li key={q.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-sm font-bold tabular-nums text-soft">{(meta.page - 1) * meta.pageSize + i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                        <Badge>{typeLabel(q.type)}</Badge><span>{DIFFICULTY[q.difficulty]}</span>{q.topic && <span>· {q.topic}</span>}{q.section && <span>· {q.section}</span>}<span>· {formatScore(q.points)} pt</span>
                        <MarkedByBadge q={q} />
                        {q.usedInQuizzes > 0 && <Badge tone="info">In {plural(q.usedInQuizzes, 'quiz', 'quizzes')}</Badge>}
                      </p>
                      <QuestionText question={q} className="text-[15px]" />
                      <AnswerKey q={q} />
                      {q.explanation && <p className="mt-2 text-[13px] text-faint">Explanation: {q.explanation}</p>}
                    </div>
                    <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label="Question options" onClick={toggle} {...props} />}>
                      <MenuItem icon={Pencil} onClick={() => setDialog({ edit: q })}>Edit</MenuItem>
                      <MenuItem icon={Copy} onClick={() => copy.mutate(q.id)}>Duplicate</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: q })}>Delete</MenuItem>
                    </Menu>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </QueryState>
      <Pagination meta={meta} onPage={setPage} />

      {dialog?.edit !== undefined && (
        <QuestionEditor question={dialog.edit ?? undefined} parts={[...new Set((query.data?.data ?? []).map((q) => q.section).filter(Boolean))]} onClose={() => setDialog(null)}
          onSave={async (question) => { if (dialog.edit) await api.put(`/question-banks/questions/${dialog.edit.id}`, question); else await api.post(`/question-banks/${bankId}/questions`, question); refresh(); toast.success('Question saved.'); }} />
      )}
      {dialog?.import && (
        <ImportQuestions target="bank" previewUrl={`/question-banks/${bankId}/import/preview`} onClose={() => setDialog(null)}
          onSave={async (questions) => { const r = await api.post(`/question-banks/${bankId}/questions/bulk`, { questions }); refresh(); toast.success(`${plural(r.saved, 'question')} added to the bank.`); }} />
      )}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title="Delete this question?" confirmLabel="Delete">
        {dialog?.remove?.usedInQuizzes > 0 ? `It is used in ${plural(dialog.remove.usedInQuizzes, 'quiz', 'quizzes')}. Attempts that students already made keep their copy; the question is removed from quizzes nobody has started.` : 'The question is removed from this bank.'}
      </ConfirmDialog>
    </>
  );
}
