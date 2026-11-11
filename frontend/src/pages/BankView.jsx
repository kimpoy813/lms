// One question bank: its questions, and importing an existing test paper into it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, FileUp, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { toast } from '../components/toast.jsx';
import { Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, Modal, PageHeader, Pagination, QueryState, SearchInput, Select, Textarea, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatScore, plural } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { AnswerKey } from './classes/QuizDetail.jsx';
import QuestionEditor from './classes/quiz/QuestionEditor.jsx';
import { DIFFICULTY, QUESTION_TYPES, QuestionText, typeLabel } from './classes/quiz/QuestionParts.jsx';

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
  const meta = query.data?.meta;
  const setFilter = (name, value) => { setFilters((f) => ({ ...f, [name]: value })); setPage(1); };

  return (
    <>
      <PageHeader back={{ to: '/question-banks', label: 'Question banks' }} title={bank?.title ?? 'Question bank'} description={bank ? [bank.subject, plural(bank.questionCount, 'question')].filter(Boolean).join(' · ') : null}
        actions={<>
          <Button variant="secondary" icon={Sparkles} to="/ai?tool=questions">Draft with AI</Button>
          <Button variant="secondary" icon={FileUp} onClick={() => setDialog({ import: true })}>Import a test paper</Button>
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
          <Card><EmptyState icon={Plus} title={term || filters.type || filters.difficulty || filters.topic ? 'No questions match' : 'This bank is empty'} description={term || filters.type ? null : 'Write a question, or import the questions of an existing test paper.'} action={<div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" icon={FileUp} onClick={() => setDialog({ import: true })}>Import a test paper</Button><Button icon={Plus} onClick={() => setDialog({ edit: null })}>New question</Button></div>} /></Card>
        ) : (
          <ol className="space-y-3">
            {questions.map((q, i) => (
              <li key={q.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-sm font-bold tabular-nums text-soft">{(meta.page - 1) * meta.pageSize + i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                        <Badge>{typeLabel(q.type)}</Badge><span>{DIFFICULTY[q.difficulty]}</span>{q.topic && <span>· {q.topic}</span>}<span>· {formatScore(q.points)} pt</span>
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
        <QuestionEditor question={dialog.edit ?? undefined} onClose={() => setDialog(null)}
          onSave={async (question) => { if (dialog.edit) await api.put(`/question-banks/questions/${dialog.edit.id}`, question); else await api.post(`/question-banks/${bankId}/questions`, question); refresh(); toast.success('Question saved.'); }} />
      )}
      {dialog?.import && <ImportDialog bankId={bankId} onClose={() => setDialog(null)} onSaved={refresh} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title="Delete this question?" confirmLabel="Delete">
        {dialog?.remove?.usedInQuizzes > 0 ? `It is used in ${plural(dialog.remove.usedInQuizzes, 'quiz', 'quizzes')}. Attempts that students already made keep their copy; the question is removed from quizzes nobody has started.` : 'The question is removed from this bank.'}
      </ConfirmDialog>
    </>
  );
}

/** Import: upload or paste → review what the parser understood → save the good ones. */
function ImportDialog({ bankId, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const receive = (result) => { setPreview(result); setDrafts(result.questions.map((q, i) => ({ ...q, key: i, include: q.errors.length === 0 }))); setError(null); };
  const parse = useAction((file) => (file ? api.postForm(`/question-banks/${bankId}/import/preview`, { file }) : api.post(`/question-banks/${bankId}/import/preview`, { text })), {
    onSuccess: receive,
    onError: (err) => { setError(err.fields?.file ?? err.fields?.text ?? err.message); return true; },
  });
  const chosen = drafts.filter((d) => d.include);
  const save = useAction(() => api.post(`/question-banks/${bankId}/questions/bulk`, { questions: chosen.map(({ key, include, warnings, errors, number, ...q }) => q) }), {
    success: (r) => `${plural(r.saved, 'question')} added to the bank.`,
    onSuccess: () => { onSaved(); onClose(); },
    onError: (err) => {
      // The server names the questions that still have problems.
      const bad = err.details?.questions;
      if (bad) { setDrafts((list) => { const included = list.filter((d) => d.include); return list.map((d) => { const n = included.indexOf(d); const problem = bad.find((b) => b.index === n); return problem ? { ...d, errors: problem.errors } : d; }); }); setError(err.message); return true; }
      return false;
    },
  });

  return (
    <Modal open onClose={onClose} size="xl" title="Import a test paper" description={preview ? `${preview.source} — review what was understood before saving.` : 'Reuse a quiz you already have as a Word, PDF or text file.'}
      footer={preview ? <><Button variant="secondary" onClick={() => { setPreview(null); setDrafts([]); }}>Start over</Button><Button loading={save.isPending} disabled={chosen.length === 0 || chosen.some((d) => d.errors.length > 0)} onClick={() => save.mutate()}>Add {plural(chosen.length, 'question')} to the bank</Button></> : <Button variant="secondary" onClick={onClose}>Cancel</Button>}>
      {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
      {!preview ? (
        <div className="space-y-5">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={parse.isPending} className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center hover:border-brand hover:text-brand">
            <Upload className="size-7 text-brand" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink">{parse.isPending ? 'Reading the document…' : 'Choose a Word (.docx), PDF or text file'}</span>
            <span className="text-xs text-faint">Up to 10 MB. Nothing is saved until you review the questions.</span>
          </button>
          <input ref={fileInput} type="file" hidden accept=".docx,.pdf,.txt,.md" onChange={(e) => { const file = e.target.files?.[0]; if (file) parse.mutate(file); e.target.value = ''; }} />
          <div>
            <label htmlFor="import-text" className="mb-1.5 block text-sm font-medium text-ink">…or paste the questions</label>
            <Textarea id="import-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" placeholder={'1. Which part of the computer is known as its "brain"?\nA. RAM\n*B. CPU\nC. Hard disk\nD. Monitor\n\n2. True or False: One byte is made of 8 bits.\nAnswer: True'} />
            <div className="mt-2 flex justify-end"><Button variant="secondary" loading={parse.isPending} disabled={!text.trim()} onClick={() => parse.mutate(null)}>Read pasted text</Button></div>
          </div>
          <details className="rounded-xl bg-raised p-3.5 text-[13px] text-soft">
            <summary className="cursor-pointer font-semibold text-ink">How to prepare the document</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Number the questions: <code>1.</code> or <code>1)</code>. Letter the choices: <code>A.</code> <code>B.</code> …</li>
              <li>Mark the correct choice with a <code>*</code>, or make it <strong>bold</strong> or highlighted in Word, or add a line <code>Answer: B</code>.</li>
              <li>An answer key at the end (<code>Answer Key</code> then <code>1. B</code>, <code>2. True</code>…) is also understood.</li>
              <li>Section headings such as “Part II. True or False” or “Identification” set the question type.</li>
              <li>Scanned pictures of text cannot be read. Pictures and equations need to be added by hand afterwards.</li>
            </ul>
          </details>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="brand">{plural(preview.summary.found, 'question')} found</Badge>
            <Badge tone="ok" icon={CheckCircle2}>{drafts.filter((d) => d.errors.length === 0 && d.warnings.length === 0).length} ready</Badge>
            {drafts.some((d) => d.warnings.length > 0 && d.errors.length === 0) && <Badge tone="warn" icon={AlertTriangle}>{drafts.filter((d) => d.warnings.length > 0 && d.errors.length === 0).length} to double-check</Badge>}
            {drafts.some((d) => d.errors.length > 0) && <Badge tone="bad" icon={XCircle}>{drafts.filter((d) => d.errors.length > 0).length} need fixing</Badge>}
          </div>
          {preview.notes.map((n) => <Alert key={n} tone="info">{n}</Alert>)}
          {drafts.length === 0 ? <EmptyState compact title="No questions were recognised" description="Check that each question starts with a number, then try again." /> : (
            <ol className="space-y-2.5">
              {drafts.map((d) => (
                <li key={d.key} className={cn('rounded-xl border p-3.5', d.errors.length > 0 ? 'border-bad/50' : d.warnings.length > 0 ? 'border-warn/50' : 'border-line', !d.include && 'opacity-55')}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={d.include} onChange={(e) => setDrafts((list) => list.map((x) => (x.key === d.key ? { ...x, include: e.target.checked } : x)))} className="mt-1 size-[18px] shrink-0 accent-[var(--brand-fill)]" aria-label={`Include question ${d.number ?? d.key + 1}`} />
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-faint"><span className="font-semibold text-soft">#{d.number ?? d.key + 1}</span><Badge>{typeLabel(d.type)}</Badge>{d.section && <span>{d.section}</span>}<span>{formatScore(d.points ?? 1)} pt</span></p>
                      <QuestionText question={d} className="text-sm" />
                      <AnswerKey q={{ choices: [], pairs: [], items: [], ...d }} />
                      {d.errors.map((e) => <p key={e} className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium text-bad"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{e}</p>)}
                      {d.warnings.map((w) => <p key={w} className="mt-1.5 flex items-start gap-1.5 text-[13px] text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{w}</p>)}
                    </div>
                    <Button size="sm" variant={d.errors.length > 0 ? 'primary' : 'ghost'} icon={Pencil} onClick={() => setEditing(d)}>{d.errors.length > 0 ? 'Fix' : 'Edit'}</Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {editing && (
        <QuestionEditor title={`Question ${editing.number ?? editing.key + 1}`} question={{ ...editing, id: undefined }} onClose={() => setEditing(null)}
          onSave={async (question) => { setDrafts((list) => list.map((x) => (x.key === editing.key ? { ...x, ...question, errors: [], warnings: [], include: true } : x))); }} />
      )}
    </Modal>
  );
}
