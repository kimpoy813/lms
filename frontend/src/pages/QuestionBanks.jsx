// A teacher's question banks: reusable questions for quizzes and exams.
import { useQuery } from '@tanstack/react-query';
import { FileQuestion, Library, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, PageHeader, QueryState, SearchInput, Select, StatCard, Textarea, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { typeLabel } from './classes/quiz/QuestionParts.jsx';

const EMPTY_BANKS = [];

export default function QuestionBanks() {
  const [dialog, setDialog] = useState(null);
  const [search, setSearch] = useState('');
  const [subject, setSubject] = useState('');
  const [sort, setSort] = useState('recent');
  const term = useDebounced(search.trim());
  const query = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const remove = useAction((id) => api.delete(`/question-banks/${id}`), { invalidate: [['question-banks']], success: 'Question bank deleted.', onSuccess: () => setDialog(null) });
  const banks = query.data ?? EMPTY_BANKS;
  const subjects = [...new Set(banks.map((b) => b.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const visibleBanks = useMemo(() => {
    const needle = term.toLocaleLowerCase();
    return banks
      .filter((b) => !subject || b.subject === subject)
      .filter((b) => !needle || `${b.title} ${b.subject ?? ''} ${b.description ?? ''}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'questions' ? b.questionCount - a.questionCount : new Date(b.updatedAt) - new Date(a.updatedAt));
  }, [banks, term, subject, sort]);
  const clearFilters = () => { setSearch(''); setSubject(''); setSort('recent'); };
  const hasFilters = Boolean(search.trim() || subject);
  return (
    <>
      <PageHeader title="Question banks" description="Keep questions organized by subject, then reuse them in quizzes or draw a different set for each student."
        actions={<Button icon={Plus} onClick={() => setDialog({ edit: null })}>New bank</Button>} />
      <QueryState query={query}>
        {(rows) => (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Banks" value={rows.length} hint="Your reusable collections" icon={Library} />
              <StatCard label="Questions" value={rows.reduce((sum, b) => sum + b.questionCount, 0).toLocaleString()} hint="Across all banks" icon={FileQuestion} tone="info" />
              <StatCard label="Subjects" value={subjects.length} hint="With a subject assigned" icon={FileQuestion} tone="ok" />
            </div>
            {rows.length === 0 ? (
              <Card><EmptyState icon={Library} title="Start your first question bank" description="Create a bank for a subject or topic. Add questions yourself, or import an existing test paper (Word, PDF or text)." action={<Button icon={Plus} onClick={() => setDialog({ edit: null })}>Create a question bank</Button>} /></Card>
            ) : (
              <>
                <div className="mb-3 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:items-center">
                  <SearchInput value={search} onChange={setSearch} placeholder="Search banks, subjects, descriptions…" className="min-w-0 flex-1" />
                  {subjects.length > 0 && <Select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Filter by subject" className="w-full sm:w-48"><option value="">All subjects</option>{subjects.map((s) => <option key={s} value={s}>{s}</option>)}</Select>}
                  <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort question banks" className="w-full sm:w-44">
                    <option value="recent">Recently updated</option><option value="title">Name A–Z</option><option value="questions">Most questions</option>
                  </Select>
                </div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-faint">
                  <p>Showing <span className="font-semibold text-ink">{visibleBanks.length}</span> of {plural(rows.length, 'bank')}</p>
                  {hasFilters && <Button size="sm" variant="ghost" onClick={clearFilters}>Clear search and filters</Button>}
                </div>
                {visibleBanks.length === 0 ? (
                  <Card><EmptyState icon={Library} title="No banks match those filters" description="Try another search or clear your filters to see every question bank." action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>} /></Card>
                ) : (
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleBanks.map((b) => (
                      <li key={b.id}>
                        <Card className="flex h-full flex-col transition-shadow hover:shadow-pop">
                          <div className="flex items-start gap-3">
                            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><FileQuestion className="size-5" aria-hidden="true" /></span>
                            <div className="min-w-0 flex-1">
                              <Link to={`/question-banks/${b.id}`} className="line-clamp-2 font-semibold leading-snug text-ink hover:text-brand">{b.title}</Link>
                              <p className="mt-0.5 line-clamp-2 text-[13px] text-faint">{b.subject ?? 'No subject'} · updated {relativeTime(b.updatedAt)}</p>
                            </div>
                            <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Options for ${b.title}`} onClick={toggle} {...props} />}>
                              <MenuItem icon={Pencil} onClick={() => setDialog({ edit: b })}>Rename</MenuItem>
                              <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: b })}>Delete</MenuItem>
                            </Menu>
                          </div>
                          {b.description && <p className="mt-3 line-clamp-2 text-sm text-soft">{b.description}</p>}
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {Object.entries(b.byType ?? {}).slice(0, 4).map(([type, n]) => <Badge key={type}>{n} {typeLabel(type).toLowerCase()}</Badge>)}
                            {Object.keys(b.byType ?? {}).length > 4 && <Badge>+{Object.keys(b.byType).length - 4} more</Badge>}
                          </div>
                          <div className="mt-auto flex items-center justify-between border-t border-line pt-4">
                            <span className="text-sm font-medium text-soft">{plural(b.questionCount, 'question')}</span>
                            <Button size="sm" variant="secondary" to={`/question-banks/${b.id}`}>Open bank</Button>
                          </div>
                        </Card>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </QueryState>
      {dialog?.edit !== undefined && <BankDialog bank={dialog.edit} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title={`Delete “${dialog?.remove?.title}”?`} confirmLabel="Delete bank">
        The bank and its {plural(dialog?.remove?.questionCount ?? 0, 'question')} are removed. Quizzes that students have already taken keep their own copy of the questions.
      </ConfirmDialog>
    </>
  );
}

export function BankDialog({ bank, onClose }) {
  const navigate = useNavigate();
  const [v, setV] = useState({ title: bank?.title ?? '', subject: bank?.subject ?? '', description: bank?.description ?? '' });
  const [errors, setErrors] = useState({});
  const save = useAction(() => {
    const body = { title: v.title.trim(), subject: v.subject.trim() || null, description: v.description.trim() || null };
    return bank ? api.patch(`/question-banks/${bank.id}`, body) : api.post('/question-banks', body);
  }, {
    invalidate: [['question-banks']], success: bank ? 'Bank saved.' : 'Bank created.',
    onSuccess: (saved) => { onClose(); if (!bank) navigate(`/question-banks/${saved.id}`); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  return (
    <Modal open onClose={onClose} title={bank ? 'Rename question bank' : 'New question bank'} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.title.trim()} onClick={() => save.mutate()}>{bank ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" error={errors.title}><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. IT 101 — Midterm coverage" maxLength={200} data-autofocus /></Field>
        <Field label="Subject" optional error={errors.subject}><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} maxLength={120} /></Field>
        <Field label="Description" optional error={errors.description}><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}
