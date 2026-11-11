// Write or edit one question. The same dialog serves the quiz builder and the question banks.
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import LazyEditor from '../../../components/LazyEditor.jsx';
import { Alert, Button, Checkbox, cn, Field, Input, Modal, ModalActions, Segmented, Select, Switch, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { DIFFICULTY, QUESTION_TYPES } from './QuestionParts.jsx';

const countBlanks = (html) => (String(html ?? '').replace(/<[^>]*>/g, ' ').match(/_{3,}/g) ?? []).length;
const lines = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

const blank = (type) => ({
  type, text: '', points: 1, difficulty: 'MEDIUM', topic: '', explanation: '', settings: {},
  choices: [{ text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }],
  answer: true, correction: [], accepted: [], blanks: [], pairs: [{ left: '', right: '' }, { left: '', right: '' }, { left: '', right: '' }], items: ['', '', ''], programmingProblemId: '',
});

/**
 * @param {{ question?: object, onSave: (question: object) => Promise<unknown>, onClose: () => void, title?: string }} props
 * `onSave` receives the question in the API's editor shape and should reject with an ApiError on failure.
 */
export default function QuestionEditor({ question, onSave, onClose, title }) {
  const [q, setQ] = useState(() => ({ ...blank(question?.type ?? 'MULTIPLE_CHOICE'), ...question, topic: question?.topic ?? '', explanation: question?.explanation ?? '', programmingProblemId: question?.programmingProblemId ?? '' }));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const set = (name, value) => setQ((s) => ({ ...s, [name]: value }));
  const setSetting = (name, value) => setQ((s) => ({ ...s, settings: { ...s.settings, [name]: value } }));
  const programming = useQuery({ queryKey: ['programming', 'problems'], queryFn: () => api.get('/programming/problems'), enabled: q.type === 'PROGRAMMING' });

  const blanksNeeded = q.type === 'FILL_BLANKS' ? countBlanks(q.text) : 0;
  const blanks = Array.from({ length: blanksNeeded }, (_, i) => q.blanks?.[i] ?? []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    const base = { type: q.type, text: q.text, points: Number(q.points), difficulty: q.difficulty, topic: q.topic.trim() || null, explanation: q.explanation.trim() || null, settings: q.settings };
    const byType = {
      MULTIPLE_CHOICE: { choices: q.choices }, MULTIPLE_RESPONSE: { choices: q.choices },
      TRUE_FALSE: { answer: q.answer }, MODIFIED_TRUE_FALSE: { answer: q.answer, correction: q.correction },
      IDENTIFICATION: { accepted: q.accepted }, SHORT_ANSWER: { accepted: q.accepted },
      FILL_BLANKS: { blanks }, MATCHING: { pairs: q.pairs }, ORDERING: { items: q.items },
      PROGRAMMING: { programmingProblemId: q.programmingProblemId || null },
    }[q.type] ?? {};
    try {
      await onSave({ ...base, ...byType });
      onClose();
    } catch (err) {
      setProblems(err.details?.errors ?? [err.message]);
      setBusy(false);
    }
  };

  const setChoice = (i, patch) => set('choices', q.choices.map((c, n) => (n === i ? { ...c, ...patch } : q.type === 'MULTIPLE_CHOICE' && patch.isCorrect ? { ...c, isCorrect: false } : c)));

  return (
    <Modal open onClose={onClose} title={title ?? (question?.id ? 'Edit question' : 'New question')} size="lg">
      <form onSubmit={submit} className="space-y-5">
        {problems.length > 0 && <Alert tone="bad" title="This question cannot be saved yet"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert>}

        <div className="grid gap-4 sm:grid-cols-[1fr_6rem_8rem]">
          <Field label="Question type" hint={QUESTION_TYPES[q.type]?.hint}>
            <Select value={q.type} onChange={(e) => set('type', e.target.value)} disabled={Boolean(question?.id)}>
              {Object.entries(QUESTION_TYPES).map(([value, t]) => <option key={value} value={value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Points"><Input type="number" min="0.25" max="1000" step="any" value={q.points} onChange={(e) => set('points', e.target.value)} /></Field>
          <Field label="Difficulty"><Select value={q.difficulty} onChange={(e) => set('difficulty', e.target.value)}>{Object.entries(DIFFICULTY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        </div>

        <Field label={q.type === 'TRUE_FALSE' || q.type === 'MODIFIED_TRUE_FALSE' ? 'Statement' : 'Question'} hint={q.type === 'FILL_BLANKS' ? 'Type three underscores (___) wherever a blank should be.' : null}>
          <LazyEditor value={q.text} onChange={(html) => set('text', html)} minHeight={90} placeholder={q.type === 'FILL_BLANKS' ? 'One byte is made of ___ bits.' : 'Type the question'} ariaLabel="Question" />
        </Field>

        {(q.type === 'MULTIPLE_CHOICE' || q.type === 'MULTIPLE_RESPONSE') && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Choices <span className="text-xs font-normal text-faint">— mark the correct {q.type === 'MULTIPLE_CHOICE' ? 'one' : 'ones'}</span></legend>
            <ul className="space-y-2">
              {q.choices.map((c, i) => (
                <li key={i} className="flex items-center gap-2.5">
                  <input type={q.type === 'MULTIPLE_CHOICE' ? 'radio' : 'checkbox'} name="correct-choice" checked={c.isCorrect} onChange={(e) => setChoice(i, { isCorrect: q.type === 'MULTIPLE_CHOICE' ? true : e.target.checked })} className="size-[18px] shrink-0 accent-[var(--ok)]" aria-label={`Choice ${i + 1} is correct`} />
                  <Input value={c.text} onChange={(e) => setChoice(i, { text: e.target.value })} placeholder={`Choice ${i + 1}`} maxLength={1000} aria-label={`Choice ${i + 1}`} className={cn(c.isCorrect && 'border-ok')} />
                  <Button variant="ghost" size="sm" icon={X} aria-label={`Remove choice ${i + 1}`} disabled={q.choices.length <= 2} onClick={() => set('choices', q.choices.filter((_, n) => n !== i))} />
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" icon={Plus} className="mt-2" disabled={q.choices.length >= 10} onClick={() => set('choices', [...q.choices, { text: '', isCorrect: false }])}>Add a choice</Button>
          </fieldset>
        )}

        {(q.type === 'TRUE_FALSE' || q.type === 'MODIFIED_TRUE_FALSE') && (
          <div className="space-y-3">
            <Field label="The statement is">
              <Segmented label="Correct answer" value={q.answer ? 'T' : 'F'} onChange={(v) => set('answer', v === 'T')} options={[{ value: 'T', label: 'True', tone: 'text-ok' }, { value: 'F', label: 'False', tone: 'text-bad' }]} />
            </Field>
            {q.type === 'MODIFIED_TRUE_FALSE' && !q.answer && (
              <Field label="Word or phrase that makes it true" hint="One accepted answer per line.">
                <Textarea rows={2} value={q.correction.join('\n')} onChange={(e) => set('correction', e.target.value.split('\n'))} onBlur={() => set('correction', lines(q.correction.join('\n')))} />
              </Field>
            )}
          </div>
        )}

        {(q.type === 'IDENTIFICATION' || q.type === 'SHORT_ANSWER') && (
          <div className="space-y-3">
            <Field label="Accepted answers" hint={q.type === 'SHORT_ANSWER' ? 'One per line. Leave empty to grade the answers yourself.' : 'One per line. Spelling variants count as separate answers.'}>
              <Textarea rows={3} value={q.accepted.join('\n')} onChange={(e) => set('accepted', e.target.value.split('\n'))} onBlur={() => set('accepted', lines(q.accepted.join('\n')))} placeholder={'CPU\nCentral Processing Unit'} />
            </Field>
            <Checkbox checked={q.settings.caseSensitive === true} onChange={(e) => setSetting('caseSensitive', e.target.checked)} label="Capital letters matter" description="Off: “cpu” and “CPU” are both accepted." />
          </div>
        )}

        {q.type === 'FILL_BLANKS' && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Answers for the blanks</legend>
            {blanksNeeded === 0 ? <p className="text-sm text-warn">No blank found yet. Type ___ in the question where each blank goes.</p> : (
              <ol className="space-y-2">
                {blanks.map((b, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand">{i + 1}</span>
                    <Input value={b.join(' | ')} onChange={(e) => set('blanks', blanks.map((x, n) => (n === i ? e.target.value.split('|').map((s) => s.trimStart()) : x)))} onBlur={() => set('blanks', blanks.map((x) => x.map((s) => s.trim()).filter(Boolean)))} placeholder="Accepted answer (separate alternatives with |)" aria-label={`Accepted answers for blank ${i + 1}`} />
                  </li>
                ))}
              </ol>
            )}
          </fieldset>
        )}

        {q.type === 'MATCHING' && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Pairs <span className="text-xs font-normal text-faint">— the right-hand column is shuffled for students</span></legend>
            <ul className="space-y-2">
              {q.pairs.map((p, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input value={p.left} onChange={(e) => set('pairs', q.pairs.map((x, n) => (n === i ? { ...x, left: e.target.value } : x)))} placeholder="Item" aria-label={`Pair ${i + 1}, item`} maxLength={500} />
                  <span className="text-faint" aria-hidden="true">→</span>
                  <Input value={p.right} onChange={(e) => set('pairs', q.pairs.map((x, n) => (n === i ? { ...x, right: e.target.value } : x)))} placeholder="Matches with" aria-label={`Pair ${i + 1}, match`} maxLength={500} />
                  <Button variant="ghost" size="sm" icon={X} aria-label={`Remove pair ${i + 1}`} disabled={q.pairs.length <= 2} onClick={() => set('pairs', q.pairs.filter((_, n) => n !== i))} />
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" icon={Plus} className="mt-2" disabled={q.pairs.length >= 20} onClick={() => set('pairs', [...q.pairs, { left: '', right: '' }])}>Add a pair</Button>
          </fieldset>
        )}

        {q.type === 'ORDERING' && (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Items in the correct order <span className="text-xs font-normal text-faint">— students see them shuffled</span></legend>
            <ol className="space-y-2">
              {q.items.map((item, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right text-sm font-semibold text-faint">{i + 1}.</span>
                  <Input value={item} onChange={(e) => set('items', q.items.map((x, n) => (n === i ? e.target.value : x)))} aria-label={`Item ${i + 1}`} maxLength={500} />
                  <Button variant="ghost" size="sm" icon={X} aria-label={`Remove item ${i + 1}`} disabled={q.items.length <= 2} onClick={() => set('items', q.items.filter((_, n) => n !== i))} />
                </li>
              ))}
            </ol>
            <Button variant="secondary" size="sm" icon={Plus} className="mt-2" disabled={q.items.length >= 20} onClick={() => set('items', [...q.items, ''])}>Add an item</Button>
          </fieldset>
        )}

        {q.type === 'ESSAY' && (
          <Field label="Word limit" optional hint="Shown to students as a guide; longer answers are still accepted.">
            <Input type="number" min="1" max="10000" value={q.settings.wordLimit ?? ''} onChange={(e) => setSetting('wordLimit', e.target.value === '' ? undefined : Number(e.target.value))} className="w-40" />
          </Field>
        )}
        {(q.type === 'ESSAY' || q.type === 'FILE_UPLOAD') && <Alert tone="info">You grade this question yourself. Scores stay hidden from students until every answer is graded.</Alert>}

        {q.type === 'PROGRAMMING' && (
          <Field label="Coding problem" hint="Create problems under “Coding problems” in the menu.">
            <Select value={q.programmingProblemId} onChange={(e) => set('programmingProblemId', e.target.value)}>
              <option value="">Choose a problem…</option>
              {(programming.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </Field>
        )}

        {['MULTIPLE_RESPONSE', 'MATCHING', 'ORDERING', 'FILL_BLANKS'].includes(q.type) && (
          <Switch checked={q.settings.partialCredit !== false} onChange={(on) => setSetting('partialCredit', on)} label="Give partial credit" description="Part of the points for a partly correct answer. Off: all or nothing." />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Topic" optional hint="Used to filter the question bank and to draw random questions."><Input value={q.topic} onChange={(e) => set('topic', e.target.value)} maxLength={120} placeholder="e.g. Number systems" /></Field>
          <Field label="Explanation" optional hint="Shown with the correct answer after results are released."><Textarea rows={2} value={q.explanation} onChange={(e) => set('explanation', e.target.value)} maxLength={5000} /></Field>
        </div>

        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save question</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
