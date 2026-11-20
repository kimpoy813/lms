// Write or edit one question. The same dialog serves the quiz builder and the question banks.
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import LazyEditor from '../../../components/LazyEditor.jsx';
import { Alert, Badge, Button, Checkbox, cn, Field, Input, Modal, ModalActions, Segmented, Select, Switch, Textarea, useDebounced } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { isSentence, usesKeyWords } from '../../../lib/quizMarking.js';
import { DIFFICULTY, KeyWordsFound, QUESTION_TYPES, markedBy } from './QuestionParts.jsx';

const countBlanks = (html) => (String(html ?? '').replace(/<[^>]*>/g, ' ').match(/_{3,}/g) ?? []).length;
const lines = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

const OUTCOME = {
  RIGHT: { tone: 'ok', label: 'Right: all the points' },
  HALF: { tone: 'warn', label: 'Half right: half the points' },
  WRONG: { tone: 'bad', label: 'Wrong: no points' },
  WAITS: { tone: 'info', label: 'Waits for your grade' },
};

/** "right with 3 of 4, half right with 2" */
function needs({ keyWords, right, half }) {
  const all = keyWords.length;
  if (all === 1) return 'the answer has to have it';
  const full = right === all ? `right with ${all === 2 ? 'both' : `all ${all}`}` : `right with ${right} of ${all}`;
  return half ? `${full}, half right with ${half}` : full;
}

/**
 * For a typed question that is being written: the key words the system will look for, and a box
 * to try an answer in before any student gives it. The server does the marking, so what shows
 * here is what a student's answer gets.
 */
function TryAnswer({ q }) {
  const [answer, setAnswer] = useState('');
  const accepted = lines((q.accepted ?? []).join('\n'));
  const payload = useDebounced(JSON.stringify({ question: { type: q.type, text: q.text ?? '', accepted, settings: { caseSensitive: q.settings?.caseSensitive === true, partialCredit: q.settings?.partialCredit, reviewMismatch: q.settings?.reviewMismatch, keyWords: q.settings?.keyWords } }, answer: answer.trim() }), 350);
  const check = useQuery({ queryKey: ['try-answer', payload], queryFn: () => api.post('/question-banks/try-answer', JSON.parse(payload)), enabled: accepted.length > 0, placeholderData: (prev) => prev, staleTime: 60_000, retry: false });
  if (accepted.length === 0) return null;
  const { keyWords = [], result = null } = check.data ?? {};
  const outcome = answer.trim() && result ? OUTCOME[result.outcome] : null;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-canvas p-3.5" data-testid="try-answer">
      {keyWords.length > 0 && (
        <div className="space-y-1.5 text-[13px] text-soft" data-testid="key-words">
          <p><strong className="font-semibold text-ink">The system looks for these key words</strong> in what the student wrote, in any order and in the student’s own words. The words that your question already gives do not count.</p>
          <ul className="space-y-1">
            {keyWords.map((entry) => (
              <li key={entry.accepted} className="flex flex-wrap items-center gap-1.5">
                {keyWords.length > 1 && <span className="text-faint">“{entry.accepted.length > 40 ? `${entry.accepted.slice(0, 40)}…` : entry.accepted}”:</span>}
                {entry.keyWords.map((word) => <Badge key={word} tone="brand">{word}</Badge>)}
                <span className="text-faint">{needs(entry)}</span>
              </li>
            ))}
          </ul>
          <p className="text-faint">Leave out of your answer the words that a right answer does not need. The system looks for words, it does not understand: you can change any score it gives.</p>
        </div>
      )}
      {q.type === 'SHORT_ANSWER' && check.data && keyWords.length === 0 && q.settings?.caseSensitive !== true && (
        <p className="text-[13px] text-soft" data-testid="phrase-note">
          <strong className="font-semibold text-ink">An answer has to be one of yours, as it stands.</strong> “The”, “is”, “it” and the words of your question may be added or left out, nothing else. Tick <em>Check by key words</em> to have the words looked for in the student’s own sentence instead.
        </p>
      )}
      <Field label="Try an answer" hint="Type what a student might write, and see how the system marks it.">
        <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="A student’s answer" maxLength={2000} />
      </Field>
      {outcome && (
        <div className="space-y-1 text-sm" role="status" data-testid="try-result">
          <p><Badge tone={outcome.tone}>{outcome.label}</Badge></p>
          <KeyWordsFound check={result} className="text-[13px]" />
        </div>
      )}
    </div>
  );
}

const blank = (type) => ({
  type, text: '', points: 1, difficulty: 'MEDIUM', topic: '', section: '', explanation: '', settings: {},
  choices: [{ text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }],
  answer: true, correction: [], accepted: [], blanks: [], pairs: [{ left: '', right: '' }, { left: '', right: '' }, { left: '', right: '' }], items: ['', '', ''], programmingProblemId: '',
});

/**
 * @param {{ question?: object, onSave: (question: object) => Promise<unknown>, onClose: () => void, title?: string, parts?: string[] }} props
 * `onSave` receives the question in the API's editor shape and should reject with an ApiError on failure.
 * `parts`: the part names already in use where the question goes, offered while typing one.
 */
export default function QuestionEditor({ question, onSave, onClose, title, parts = [] }) {
  const [q, setQ] = useState(() => ({ ...blank(question?.type ?? 'MULTIPLE_CHOICE'), ...question, topic: question?.topic ?? '', section: question?.section ?? '', explanation: question?.explanation ?? '', programmingProblemId: question?.programmingProblemId ?? '' }));
  const partsId = useId();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const set = (name, value) => setQ((s) => ({ ...s, [name]: value }));
  const setSetting = (name, value) => setQ((s) => ({ ...s, settings: { ...s.settings, [name]: value } }));
  const programming = useQuery({ queryKey: ['programming', 'problems'], queryFn: () => api.get('/programming/problems'), enabled: q.type === 'PROGRAMMING' });

  // Who marks the answers, as the question stands in the form.
  const marking = markedBy(q);
  const byKeyWords = usesKeyWords(q);
  const blanksNeeded = q.type === 'FILL_BLANKS' ? countBlanks(q.text) : 0;
  const blanks = Array.from({ length: blanksNeeded }, (_, i) => q.blanks?.[i] ?? []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    const base = { type: q.type, text: q.text, points: Number(q.points), difficulty: q.difficulty, topic: q.topic.trim() || null, section: q.section.trim() || null, explanation: q.explanation.trim() || null, settings: q.settings };
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
            <Field label="Accepted answers" hint="One per line: every answer that is right. Capital letters, spacing, punctuation and accents make no difference, and neither does “the” in front or a number written as a word.">
              <Textarea rows={3} value={q.accepted.join('\n')} onChange={(e) => set('accepted', e.target.value.split('\n'))} onBlur={() => set('accepted', lines(q.accepted.join('\n')))} placeholder={'CPU\nCentral Processing Unit'} />
            </Field>
            <Checkbox checked={q.settings.caseSensitive === true} onChange={(e) => setSetting('caseSensitive', e.target.checked)} label="Exactly as written" description="Off: “cpu”, “C.P.U.” and “the CPU” are all right for “CPU”. On: only “CPU” is, letter for letter." />
            {q.type === 'SHORT_ANSWER' && marking.why === 'NO_KEY' && <Alert tone="info">Without an accepted answer there is nothing to check against: you grade every answer yourself, as for an essay.</Alert>}
            {q.type === 'SHORT_ANSWER' && marking.why !== 'NO_KEY' && q.settings.caseSensitive !== true && (
              // Left alone, it follows what is typed: on for a sentence, off for a word or a phrase.
              <Checkbox checked={byKeyWords} onChange={(e) => setSetting('keyWords', e.target.checked === lines(q.accepted.join('\n')).some(isSentence) ? undefined : e.target.checked)} label="Check by key words"
                description={byKeyWords
                  ? 'On: the system looks for the key words of your answer in what the student wrote, in any order and in the student’s own words.'
                  : 'Off: an answer has to be one of yours, as it stands. The system turns this on by itself for a sentence.'} />
            )}
            {q.type === 'SHORT_ANSWER' && marking.why !== 'NO_KEY' && (
              <Checkbox checked={marking.by === 'BOTH'} onChange={(e) => setSetting('reviewMismatch', e.target.checked)} label="I look at the answers that match none of these"
                description={marking.by === 'BOTH'
                  ? 'An answer that is right is marked at once. Any other waits for your grade, and the student’s score with it.'
                  : marking.why === 'KEY_WORDS' ? 'Off: the system checks every answer at once, by the key words shown below.' : 'Off: the system checks every answer at once, and an answer that matches none of these is wrong.'} />
            )}
            <TryAnswer q={q} />
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
                <li key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <Input value={p.left} onChange={(e) => set('pairs', q.pairs.map((x, n) => (n === i ? { ...x, left: e.target.value } : x)))} placeholder="Item" aria-label={`Pair ${i + 1}, item`} maxLength={500} className="min-w-0 flex-1 basis-32" />
                  <span className="text-faint" aria-hidden="true">→</span>
                  <Input value={p.right} onChange={(e) => set('pairs', q.pairs.map((x, n) => (n === i ? { ...x, right: e.target.value } : x)))} placeholder="Matches with" aria-label={`Pair ${i + 1}, match`} maxLength={500} className="min-w-0 flex-1 basis-32" />
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
          // An ordering is right or wrong as a whole unless the teacher asks for partial credit; the others give it unless it is switched off.
          <Switch checked={q.type === 'ORDERING' ? q.settings.partialCredit === true : q.settings.partialCredit !== false} onChange={(on) => setSetting('partialCredit', on)} label="Give partial credit" description="Part of the points for a partly correct answer. Off: all or nothing." />
        )}
        {q.type === 'SHORT_ANSWER' && marking.why === 'KEY_WORDS' && (
          <Switch checked={q.settings.partialCredit !== false} onChange={(on) => setSetting('partialCredit', on)} label="Give partial credit" description="Half the points for an answer with some of the key words: “half right with …” above says how many. Off: right or wrong." />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Part" optional hint="Questions with the same part name are given together, one part after the other. Empty: with the other questions of its type.">
            <Input value={q.section} onChange={(e) => set('section', e.target.value)} maxLength={120} placeholder="e.g. Part I. Multiple Choice" list={partsId} autoComplete="off" />
            <datalist id={partsId}>{parts.map((name) => <option key={name} value={name} />)}</datalist>
          </Field>
          <Field label="Topic" optional hint="Used to filter the question bank and to draw random questions."><Input value={q.topic} onChange={(e) => set('topic', e.target.value)} maxLength={120} placeholder="e.g. Number systems" /></Field>
        </div>
        <Field label="Explanation" optional hint="Shown with the correct answer after results are released."><Textarea rows={2} value={q.explanation} onChange={(e) => set('explanation', e.target.value)} maxLength={5000} /></Field>

        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save question</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
