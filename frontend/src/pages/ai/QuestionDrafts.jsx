// A list of draft questions (from the AI) that the teacher reviews, edits and saves to a bank.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, cn, Field, Select } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { AnswerKey } from '../classes/QuizDetail.jsx';
import QuestionEditor from '../classes/quiz/QuestionEditor.jsx';
import { QuestionText, typeLabel } from '../classes/quiz/QuestionParts.jsx';

export default function QuestionDrafts({ drafts, setDrafts, defaultBankTitle }) {
  const client = useQueryClient();
  const banks = useQuery({ queryKey: ['question-banks'], queryFn: () => api.get('/question-banks') });
  const [bankId, setBankId] = useState('');
  const [editing, setEditing] = useState(null);
  const chosen = drafts.filter((d) => d.include);
  const save = useAction(async () => {
    let target = bankId;
    if (!target || target === 'new') target = (await api.post('/question-banks', { title: defaultBankTitle || 'AI drafts' })).id;
    const result = await api.post(`/question-banks/${target}/questions/bulk`, { questions: chosen.map(({ key, include, ...q }) => q) });
    return { ...result, bankId: target };
  }, {
    success: (r) => `${plural(r.saved, 'question')} saved to the bank.`,
    onSuccess: (r) => { client.invalidateQueries({ queryKey: ['question-banks'] }); setBankId(r.bankId); setDrafts((list) => list.filter((d) => !d.include)); },
  });
  if (drafts.length === 0) return null;
  return (
    <div>
      <ol className="space-y-2.5">
        {drafts.map((d, i) => (
          <li key={d.key} className={cn('rounded-xl border border-line p-3.5', !d.include && 'opacity-55')}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={d.include} onChange={(e) => setDrafts((list) => list.map((x) => (x.key === d.key ? { ...x, include: e.target.checked } : x)))} className="mt-1 size-[18px] shrink-0 accent-[var(--brand-fill)]" aria-label={`Keep question ${i + 1}`} />
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-faint"><Badge>{typeLabel(d.type)}</Badge><span>{d.difficulty?.toLowerCase()}</span>{d.topic && <span>· {d.topic}</span>}<span>· {formatScore(d.points ?? 1)} pt</span></p>
                <QuestionText question={d} className="text-sm" />
                <AnswerKey q={{ choices: [], pairs: [], items: [], ...d }} />
                {d.explanation && <p className="mt-1.5 text-[13px] text-faint">Explanation: {d.explanation}</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(d)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Discard question ${i + 1}`} onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-end justify-end gap-3">
        <Field label="Save the selected questions to" className="w-full sm:w-72">
          <Select value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Choose a question bank…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}<option value="new">A new bank{defaultBankTitle ? ` “${defaultBankTitle}”` : ''}</option></Select>
        </Field>
        <Button icon={ListChecks} loading={save.isPending} disabled={!bankId || chosen.length === 0} onClick={() => save.mutate()}>Save {plural(chosen.length, 'question')}</Button>
      </div>
      {editing && <QuestionEditor title="Edit draft question" question={{ ...editing, id: undefined }} onClose={() => setEditing(null)} onSave={async (question) => { setDrafts((list) => list.map((x) => (x.key === editing.key ? { ...x, ...question, include: true } : x))); }} />}
    </div>
  );
}
