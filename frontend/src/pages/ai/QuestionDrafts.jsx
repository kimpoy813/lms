// A list of draft questions (from the AI) that the teacher reviews and edits, and then makes a
// quiz or an examination of, or saves to a question bank.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, ListChecks, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, Button, cn, Field, Input, Select } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { AnswerKey } from '../classes/QuizDetail.jsx';
import QuestionEditor from '../classes/quiz/QuestionEditor.jsx';
import { QuestionText, typeLabel } from '../classes/quiz/QuestionParts.jsx';
import { classLabel } from '../classes/useClass.js';

/**
 * @param {{ drafts: object[], setDrafts: Function, defaultBankTitle?: string,
 *           quiz?: { kind: 'QUIZ' | 'EXAM' | 'PRACTICE', noun: string, module?: { id: string, title: string, classId: string, classLabel: string } | null } }} props
 *   quiz: offer to make a quiz of the chosen questions, in the module's class or another one.
 */
export default function QuestionDrafts({ drafts, setDrafts, defaultBankTitle, quiz }) {
  const client = useQueryClient();
  const navigate = useNavigate();
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

  // A quiz or an examination made of the chosen questions. They are kept in a question bank too,
  // as every question of a quiz is.
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }), enabled: Boolean(quiz) });
  const suggestedTitle = quiz ? `${quiz.module?.title ?? defaultBankTitle ?? 'Untitled'}: ${quiz.noun}`.slice(0, 200) : '';
  const [quizTitle, setQuizTitle] = useState(suggestedTitle);
  const [quizClassId, setQuizClassId] = useState(quiz?.module?.classId ?? '');
  // The suggestion follows the form above until the teacher has typed a title of their own.
  const [titleTouched, setTitleTouched] = useState(false);
  useEffect(() => { if (!titleTouched) setQuizTitle(suggestedTitle); }, [suggestedTitle, titleTouched]);
  useEffect(() => { if (quiz?.module?.classId) setQuizClassId(quiz.module.classId); }, [quiz?.module?.classId]);
  const makeQuiz = useAction(async () => {
    const bank = bankId && bankId !== 'new' ? bankId : (await api.post('/question-banks', { title: defaultBankTitle || quizTitle.trim() || 'AI drafts' })).id;
    // The questions first: a question that still has a mistake is reported before anything is created.
    const saved = await api.post(`/question-banks/${bank}/questions/bulk`, { questions: chosen.map(({ key, include, ...q }) => q) });
    const made = await api.post(`/classes/${quizClassId}/quizzes`, { title: quizTitle.trim(), kind: quiz.kind, ...(quiz.module?.classId === quizClassId ? { moduleId: quiz.module.id } : {}) });
    await api.put(`/quizzes/${made.id}/questions`, { items: saved.questionIds.map((questionId, i) => ({ questionId, points: Number(chosen[i].points) > 0 ? Number(chosen[i].points) : 1 })) });
    return made;
  }, {
    invalidate: [['question-banks'], ['class', quizClassId]],
    success: () => `Saved as a draft ${quiz.noun}. Set the dates and the time limit, then publish it when you are ready.`,
    onSuccess: (made) => navigate(`/classes/${quizClassId}/quizzes/${made.id}`),
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
      {quiz && (
        <div className="mt-4 rounded-xl border border-line bg-raised p-3.5">
          <p className="text-sm font-semibold text-ink">Make a draft {quiz.noun} of the {plural(chosen.length, 'selected question')}</p>
          <p className="mt-0.5 text-[13px] text-faint">Students do not see it until you publish it. You can still add, change and remove questions there.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Title" className="w-full"><Input value={quizTitle} maxLength={200} onChange={(e) => { setTitleTouched(true); setQuizTitle(e.target.value); }} /></Field>
            <Field label="In the class" className="min-w-0 flex-1 basis-56"><Select value={quizClassId} onChange={(e) => setQuizClassId(e.target.value)}><option value="">Choose a class…</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>
            <Button icon={FilePlus2} className="w-full sm:w-auto" loading={makeQuiz.isPending} disabled={!quizClassId || !quizTitle.trim() || chosen.length === 0 || save.isPending} onClick={() => makeQuiz.mutate()}>Create the {quiz.noun}</Button>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-end justify-end gap-3">
        <Field label={quiz ? 'Or only keep them in a question bank' : 'Save the selected questions to'} className="w-full sm:w-72">
          <Select value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Choose a question bank…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}<option value="new">A new bank{defaultBankTitle ? ` “${defaultBankTitle}”` : ''}</option></Select>
        </Field>
        <Button icon={ListChecks} loading={save.isPending} disabled={!bankId || chosen.length === 0} onClick={() => save.mutate()}>Save {plural(chosen.length, 'question')}</Button>
      </div>
      {editing && <QuestionEditor title="Edit draft question" question={{ ...editing, id: undefined }} onClose={() => setEditing(null)} onSave={async (question) => { setDrafts((list) => list.map((x) => (x.key === editing.key ? { ...x, ...question, include: true } : x))); }} />}
    </div>
  );
}
