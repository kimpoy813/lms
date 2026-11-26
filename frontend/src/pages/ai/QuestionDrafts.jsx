// A list of draft questions (from the AI) that the teacher reviews and edits, and then makes a
// quiz or an examination of, or saves to a question bank.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, ListChecks, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlsoPostToClasses } from '../../components/ClassTargets.jsx';
import { Badge, Button, cn, Field, Input, Select } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatScore, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import QuestionEditor from '../classes/quiz/QuestionEditor.jsx';
import { AnswerKey, QuestionText, typeLabel } from '../classes/quiz/QuestionParts.jsx';
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
  const allSelected = drafts.length > 0 && chosen.length === drafts.length;
  const updateDrafts = (updater) => setDrafts(typeof updater === 'function' ? updater(drafts) : updater);
  const save = useAction(async () => {
    let target = bankId;
    if (!target || target === 'new') target = (await api.post('/question-banks', { title: defaultBankTitle || 'AI drafts' })).id;
    const result = await api.post(`/question-banks/${target}/questions/bulk`, { questions: chosen.map(({ key, include, ...q }) => q) });
    return { ...result, bankId: target };
  }, {
    success: (r) => `${plural(r.saved, 'question')} saved to the bank.`,
    onSuccess: (r) => { client.invalidateQueries({ queryKey: ['question-banks'] }); setBankId(r.bankId); updateDrafts((list) => list.filter((d) => !d.include)); },
  });

  // A quiz or an examination made of the chosen questions. They are kept in a question bank too,
  // as every question of a quiz is.
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }), enabled: Boolean(quiz) });
  const [quizKind, setQuizKind] = useState(quiz?.kind ?? 'QUIZ');
  useEffect(() => { if (quiz?.kind) setQuizKind(quiz.kind); }, [quiz?.kind]);
  const noun = quizKind === 'EXAM' ? 'examination' : quizKind === 'PRACTICE' ? 'practice quiz' : (quiz?.noun ?? 'quiz');
  const suggestedTitle = quiz ? `${quiz.module?.title ?? defaultBankTitle ?? 'Untitled'}: ${noun}`.slice(0, 200) : '';
  const [quizTitle, setQuizTitle] = useState(suggestedTitle);
  const [quizClassId, setQuizClassId] = useState(quiz?.module?.classId ?? '');
  const [targetClassIds, setTargetClassIds] = useState([]);
  // The suggestion follows the form above until the teacher has typed a title of their own.
  const [titleTouched, setTitleTouched] = useState(false);
  useEffect(() => { if (!titleTouched) setQuizTitle(suggestedTitle); }, [suggestedTitle, titleTouched]);
  useEffect(() => { if (quiz?.module?.classId) setQuizClassId(quiz.module.classId); }, [quiz?.module?.classId]);
  const extraClassIds = targetClassIds.filter((id) => id && id !== quizClassId);
  const makeQuiz = useAction(async () => {
    const bank = bankId && bankId !== 'new' ? bankId : (await api.post('/question-banks', { title: defaultBankTitle || quizTitle.trim() || 'AI drafts' })).id;
    // The questions first: a question that still has a mistake is reported before anything is created.
    const saved = await api.post(`/question-banks/${bank}/questions/bulk`, { questions: chosen.map(({ key, include, ...q }) => q) });
    const made = await api.post(`/classes/${quizClassId}/quizzes`, {
      title: quizTitle.trim(),
      kind: quizKind,
      ...(quiz.module?.id && quiz.module?.classId === quizClassId ? { moduleId: quiz.module.id } : {}),
      targetClassIds: extraClassIds,
    });
    await api.put(`/quizzes/${made.id}/questions`, { items: saved.questionIds.map((questionId, i) => ({ questionId, points: Number(chosen[i].points) > 0 ? Number(chosen[i].points) : 1 })) });
    if (made.createdCopies?.length > 0) {
      await api.post(`/quizzes/${made.id}/sync`, { targetQuizIds: made.createdCopies.map((c) => c.id), publish: false });
    }
    return made;
  }, {
    invalidate: [['question-banks'], ['class', quizClassId]],
    success: () => extraClassIds.length > 0
      ? `Saved as a draft ${noun} in ${extraClassIds.length + 1} classes. Set the dates and publish each when you are ready.`
      : `Saved as a draft ${noun}. Set the dates and the time limit, then publish it when you are ready.`,
    onSuccess: (made) => {
      for (const id of extraClassIds) client.invalidateQueries({ queryKey: ['class', id] });
      navigate(`/classes/${quizClassId}/quizzes/${made.id}`);
    },
  });

  if (drafts.length === 0) return null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-raised px-3 py-2.5">
        <p className="text-[13px] text-soft"><span className="font-semibold text-ink">{chosen.length} of {drafts.length} selected</span> · choose what to keep</p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={allSelected} onClick={() => updateDrafts((list) => list.map((d) => ({ ...d, include: true })))}>Select all</Button>
          <Button size="sm" variant="ghost" disabled={chosen.length === 0} onClick={() => updateDrafts((list) => list.map((d) => ({ ...d, include: false })))}>Clear selection</Button>
        </div>
      </div>
      <ol className="space-y-2.5">
        {drafts.map((d, i) => (
          <li key={d.key} className={cn('rounded-xl border border-line p-3.5', !d.include && 'opacity-55')}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={d.include} onChange={(e) => updateDrafts((list) => list.map((x) => (x.key === d.key ? { ...x, include: e.target.checked } : x)))} className="mt-1 size-[18px] shrink-0 accent-[var(--brand-fill)]" aria-label={`Keep question ${i + 1}`} />
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-faint"><Badge>{typeLabel(d.type)}</Badge><span>{d.difficulty?.toLowerCase()}</span>{d.topic && <span>· {d.topic}</span>}<span>· {formatScore(d.points ?? 1)} pt</span></p>
                <QuestionText question={d} className="text-sm" />
                <AnswerKey q={{ choices: [], pairs: [], items: [], ...d }} />
                {d.explanation && <p className="mt-1.5 text-[13px] text-faint">Explanation: {d.explanation}</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(d)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Discard question ${i + 1}`} onClick={() => updateDrafts((list) => list.filter((x) => x.key !== d.key))} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      {quiz && (
        <div className="mt-4 rounded-xl border border-line bg-raised p-3.5">
          <p className="text-sm font-semibold text-ink">Make a draft {noun} of the {plural(chosen.length, 'selected question')}</p>
          <p className="mt-0.5 text-[13px] text-faint">Students do not see it until you publish it. You can still add, change and remove questions there.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Title" className={quiz.allowTypeChoice ? 'min-w-0 flex-1 basis-64' : 'w-full'}><Input value={quizTitle} maxLength={200} onChange={(e) => { setTitleTouched(true); setQuizTitle(e.target.value); }} /></Field>
            {quiz.allowTypeChoice && (
              <Field label="Type" className="w-full sm:w-44">
                <Select value={quizKind} onChange={(e) => setQuizKind(e.target.value)}>
                  <option value="QUIZ">Quiz</option>
                  <option value="EXAM">Examination</option>
                  <option value="PRACTICE">Practice quiz</option>
                </Select>
              </Field>
            )}
            <Field label="In the class" className="min-w-0 flex-1 basis-56"><Select value={quizClassId} onChange={(e) => setQuizClassId(e.target.value)}><option value="">Choose a class…</option>{(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}</Select></Field>
            <Button icon={FilePlus2} className="w-full sm:w-auto" loading={makeQuiz.isPending} disabled={!quizClassId || !quizTitle.trim() || chosen.length === 0 || save.isPending} onClick={() => makeQuiz.mutate()}>Create the {noun}</Button>
          </div>
          {quizClassId && (
            <AlsoPostToClasses
              className="mt-3 bg-surface"
              excludeClassId={quizClassId}
              value={extraClassIds}
              onChange={setTargetClassIds}
              hint={`Creates the same draft ${noun} with all selected questions in each checked class.`}
            />
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-end justify-end gap-3">
        <Field label={quiz ? 'Or only keep them in a question bank' : 'Save the selected questions to'} className="w-full sm:w-72">
          <Select value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Choose a question bank…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}<option value="new">A new bank{defaultBankTitle ? ` “${defaultBankTitle}”` : ''}</option></Select>
        </Field>
        <Button icon={ListChecks} loading={save.isPending} disabled={!bankId || chosen.length === 0} onClick={() => save.mutate()}>Save {plural(chosen.length, 'question')}</Button>
      </div>
      {editing && <QuestionEditor title="Edit draft question" question={{ ...editing, id: undefined }} onClose={() => setEditing(null)} onSave={async (question) => { updateDrafts((list) => list.map((x) => (x.key === editing.key ? { ...x, ...question, include: true } : x))); }} />}
    </div>
  );
}
