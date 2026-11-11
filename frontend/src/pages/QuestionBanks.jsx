// A teacher's question banks: reusable questions for quizzes and exams.
import { useQuery } from '@tanstack/react-query';
import { FileQuestion, Library, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, PageHeader, QueryState, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { typeLabel } from './classes/quiz/QuestionParts.jsx';

export default function QuestionBanks() {
  const [dialog, setDialog] = useState(null);
  const query = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const remove = useAction((id) => api.delete(`/question-banks/${id}`), { invalidate: [['question-banks']], success: 'Question bank deleted.', onSuccess: () => setDialog(null) });
  return (
    <>
      <PageHeader title="Question banks" description="Keep your questions here and reuse them in any quiz — one by one, or as a random draw so that every student gets a different set."
        actions={<Button icon={Plus} onClick={() => setDialog({ edit: null })}>New bank</Button>} />
      <QueryState query={query}>
        {(banks) => banks.length === 0 ? (
          <Card><EmptyState icon={Library} title="No question banks yet" description="Create a bank per subject or topic. You can type questions, or import an existing test paper (Word, PDF or text)." action={<Button icon={Plus} onClick={() => setDialog({ edit: null })}>New bank</Button>} /></Card>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {banks.map((b) => (
              <li key={b.id}>
                <Card className="flex h-full flex-col">
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
                    {Object.entries(b.byType ?? {}).map(([type, n]) => <Badge key={type}>{n} {typeLabel(type).toLowerCase()}</Badge>)}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-4">
                    <span className="text-sm font-medium text-soft">{plural(b.questionCount, 'question')}</span>
                    <Button size="sm" variant="secondary" to={`/question-banks/${b.id}`}>Open</Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
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
