// Quiz settings: when it is open, how long it takes, how it is scored and what students see afterwards.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import LazyEditor from '../../components/LazyEditor.jsx';
import { PublishFields } from '../../components/Publish.jsx';
import { Alert, Button, Field, Input, Modal, ModalActions, Segmented, Select, Switch } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { fromLocalInput, toLocalInput } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { useClass } from './useClass.js';

export const QUIZ_KINDS = { QUIZ: 'Quiz', EXAM: 'Examination', PRACTICE: 'Practice (not graded)' };
export const RESULT_VISIBILITY = {
  IMMEDIATE: 'Right after submitting',
  AFTER_CLOSE: 'After the quiz closes',
  MANUAL: 'When I release the results',
  NEVER: 'Only through the gradebook',
};
export const ANSWER_VISIBILITY = { SCORE_ONLY: 'Score only', RESPONSES: 'Their own answers', CORRECT_ANSWERS: 'Answers with the correct ones' };

const blank = {
  title: '', instructionsHtml: '', kind: 'QUIZ', status: 'DRAFT', publishAt: null, availableFrom: null, availableUntil: null, timeLimitMinutes: '', maxAttempts: 1,
  attemptScoring: 'HIGHEST', passingPercent: '', shuffleQuestions: false, shuffleChoices: false, resultVisibility: 'MANUAL', answerVisibility: 'SCORE_ONLY', moduleId: '', categoryId: '',
};

export default function QuizDialog({ quiz, onClose, onSaved }) {
  const { cls, base } = useClass();
  const modules = useQuery({ queryKey: ['class', cls.id, 'modules'], queryFn: () => api.get(`${base}/modules`) });
  const categories = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'categories'], queryFn: () => api.get(`${base}/gradebook/categories`) });
  const [v, setV] = useState(() => quiz ? { ...blank, ...quiz, timeLimitMinutes: quiz.timeLimitMinutes ?? '', passingPercent: quiz.passingPercent ?? '', moduleId: quiz.module?.id ?? '', categoryId: quiz.gradeCategory?.id ?? '' } : blank);
  const [errors, setErrors] = useState({});
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));

  const save = useAction(() => {
    const body = {
      title: v.title.trim(), instructionsHtml: v.instructionsHtml, kind: v.kind, availableFrom: v.availableFrom, availableUntil: v.availableUntil,
      timeLimitMinutes: v.timeLimitMinutes === '' ? null : Number(v.timeLimitMinutes), maxAttempts: Number(v.maxAttempts) || 1, attemptScoring: v.attemptScoring,
      passingPercent: v.passingPercent === '' ? null : Number(v.passingPercent), shuffleQuestions: v.shuffleQuestions, shuffleChoices: v.shuffleChoices,
      resultVisibility: v.resultVisibility, answerVisibility: v.answerVisibility, moduleId: v.moduleId || null, categoryId: v.kind === 'PRACTICE' ? null : v.categoryId || null,
      // A new quiz starts as a draft: it can only be published once it has questions.
      ...(quiz ? { status: v.status, publishAt: v.publishAt } : {}),
    };
    return quiz ? api.patch(`/quizzes/${quiz.id}`, body) : api.post(`${base}/quizzes`, body);
  }, {
    invalidate: [['class', cls.id], ['dashboard'], ['calendar']],
    success: quiz ? 'Quiz settings saved.' : 'Quiz created. Now add the questions.',
    onSuccess: (saved) => { onClose(); onSaved?.(saved); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <Modal open onClose={onClose} title={quiz ? 'Quiz settings' : 'New quiz'} size="xl">
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-5">
        {Object.keys(errors).length > 0 && <Alert tone="bad">Please check the highlighted fields.</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
          <Field label="Title" required error={errors.title}><Input value={v.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} placeholder="e.g. Quiz 3: Algorithms" /></Field>
          <Field label="Kind" error={errors.kind}><Select value={v.kind} onChange={(e) => set('kind', e.target.value)}>{Object.entries(QUIZ_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </div>
        <Field label="Instructions" optional error={errors.instructionsHtml}>
          <LazyEditor value={v.instructionsHtml} onChange={(html) => set('instructionsHtml', html)} minHeight={90} placeholder="Coverage, allowed materials, reminders…" ariaLabel="Instructions" />
        </Field>

        <fieldset className="grid gap-4 rounded-xl border border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="px-1 text-sm font-medium text-ink">Schedule and attempts</legend>
          <Field label="Opens" optional error={errors.availableFrom}><Input type="datetime-local" value={toLocalInput(v.availableFrom)} onChange={(e) => set('availableFrom', fromLocalInput(e.target.value))} /></Field>
          <Field label="Closes" optional error={errors.availableUntil}><Input type="datetime-local" value={toLocalInput(v.availableUntil)} onChange={(e) => set('availableUntil', fromLocalInput(e.target.value))} /></Field>
          <Field label="Time limit (minutes)" optional error={errors.timeLimitMinutes} hint="Empty = no timer."><Input type="number" min="1" max="600" value={v.timeLimitMinutes} onChange={(e) => set('timeLimitMinutes', e.target.value)} /></Field>
          <Field label="Attempts allowed" error={errors.maxAttempts}><Input type="number" min="1" max="20" value={v.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} /></Field>
          {Number(v.maxAttempts) > 1 && (
            <Field label="Score that counts" error={errors.attemptScoring} className="sm:col-span-2">
              <Segmented label="Score that counts" value={v.attemptScoring} onChange={(s) => set('attemptScoring', s)} options={[{ value: 'HIGHEST', label: 'Highest' }, { value: 'LATEST', label: 'Latest' }, { value: 'AVERAGE', label: 'Average' }]} />
            </Field>
          )}
          <Field label="Passing score (%)" optional error={errors.passingPercent}><Input type="number" min="0" max="100" step="any" value={v.passingPercent} onChange={(e) => set('passingPercent', e.target.value)} /></Field>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">Fairness</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch checked={v.shuffleQuestions} onChange={(on) => set('shuffleQuestions', on)} label="Shuffle the questions" description="Each student gets a different order." />
            <Switch checked={v.shuffleChoices} onChange={(on) => set('shuffleChoices', on)} label="Shuffle the choices" description="For multiple-choice questions." />
          </div>
          <p className="text-[13px] text-faint">The timer runs on the server. Leaving the tab is recorded and shown to you in the results, but students are not blocked or accused automatically.</p>
        </fieldset>

        <fieldset className="grid gap-4 rounded-xl border border-line p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-ink">After submitting</legend>
          <Field label="Students see their score" error={errors.resultVisibility}>
            <Select value={v.resultVisibility} onChange={(e) => set('resultVisibility', e.target.value)}>{Object.entries(RESULT_VISIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
          <Field label="And can review" error={errors.answerVisibility} hint="Correct answers are never shown while the quiz is still open.">
            <Select value={v.answerVisibility} onChange={(e) => set('answerVisibility', e.target.value)}>{Object.entries(ANSWER_VISIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Counts toward" optional error={errors.categoryId} hint={v.kind === 'PRACTICE' ? 'Practice quizzes are never graded.' : 'Adds a column to the gradebook.'}>
            <Select value={v.kind === 'PRACTICE' ? '' : v.categoryId} disabled={v.kind === 'PRACTICE'} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Not graded in the gradebook</option>
              {(categories.data ?? []).map((p) => (
                <optgroup key={p.id} label={`${p.name}${p.locked ? ' (locked)' : ''}`}>
                  {p.categories.map((c) => <option key={c.id} value={c.id} disabled={p.locked}>{c.name} ({c.weight}%)</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Module" optional error={errors.moduleId}>
            <Select value={v.moduleId} onChange={(e) => set('moduleId', e.target.value)}>
              <option value="">None</option>
              {(modules.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </Select>
          </Field>
        </div>

        {quiz && <PublishFields status={v.status} publishAt={v.publishAt} onChange={(p) => setV((s) => ({ ...s, ...p }))} error={errors.publishAt ?? errors.status} noun="quiz" />}

        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{quiz ? 'Save settings' : 'Create and add questions'}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
