// How a question looks: while answering, when reviewing a finished attempt, and in the builder.
import { ArrowDown, ArrowUp, Check, CheckCircle2, CircleDashed, X, XCircle } from 'lucide-react';
import { FileList, FileUpload } from '../../../components/Files.jsx';
import RichText from '../../../components/RichText.jsx';
import { Badge, cn, Input, Select, Textarea } from '../../../components/ui.jsx';
import { formatScore } from '../../../lib/format.js';

export const QUESTION_TYPES = {
  MULTIPLE_CHOICE: { label: 'Multiple choice', hint: 'One correct answer', auto: true },
  MULTIPLE_RESPONSE: { label: 'Multiple response', hint: 'Several correct answers', auto: true },
  TRUE_FALSE: { label: 'True or false', hint: '', auto: true },
  MODIFIED_TRUE_FALSE: { label: 'Modified true or false', hint: 'If false, the student gives the correct word', auto: true },
  IDENTIFICATION: { label: 'Identification', hint: 'A word or short phrase, checked automatically', auto: true },
  SHORT_ANSWER: { label: 'Short answer', hint: 'Checked automatically when you list accepted answers', auto: true },
  FILL_BLANKS: { label: 'Fill in the blanks', hint: 'Mark blanks with ___', auto: true },
  MATCHING: { label: 'Matching type', hint: 'Pair items in two columns', auto: true },
  ORDERING: { label: 'Ordering', hint: 'Arrange items in the right order', auto: true },
  ESSAY: { label: 'Essay', hint: 'You grade it', auto: false },
  FILE_UPLOAD: { label: 'File upload', hint: 'You grade it', auto: false },
  PROGRAMMING: { label: 'Programming', hint: 'Checked by the code runner', auto: true },
};
export const typeLabel = (type) => QUESTION_TYPES[type]?.label ?? type;
export const DIFFICULTY = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };

const letter = (i) => String.fromCharCode(65 + i);
const wordCount = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** The question text. In "fill in the blanks" questions every ___ becomes a numbered gap. */
export function QuestionText({ question, className }) {
  let html = question.text ?? '';
  if (question.type === 'FILL_BLANKS') {
    let n = 0;
    html = html.replace(/_{3,}/g, () => { n += 1; return `<span class="blank-gap">(${n})</span>`; });
  }
  return <RichText html={html} className={cn('[&_.blank-gap]:mx-0.5 [&_.blank-gap]:inline-block [&_.blank-gap]:min-w-14 [&_.blank-gap]:border-b-2 [&_.blank-gap]:border-brand [&_.blank-gap]:text-center [&_.blank-gap]:text-xs [&_.blank-gap]:font-semibold [&_.blank-gap]:text-brand', className)} />;
}

function Option({ type, checked, onChange, disabled, children, name }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-[15px] transition-colors', checked ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong', disabled && 'cursor-default opacity-70')}>
      <input type={type} name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 size-[18px] shrink-0 accent-[var(--brand-fill)]" />
      <span className="min-w-0 flex-1 text-ink">{children}</span>
    </label>
  );
}

/**
 * The control a student answers with. `response` has the shape the API stores
 * ({ choiceId } / { choiceIds } / { text } / { blanks } / { pairs } / { order } / { fileIds }); null = unanswered.
 */
export function AnswerInput({ question: q, response, onChange, disabled, name, files = [], onFiles, onBrowse }) {
  const r = response ?? {};
  switch (q.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      return (
        <div className="space-y-2" role="radiogroup">
          {q.choices.map((c) => <Option key={c.id} type="radio" name={name} checked={r.choiceId === c.id} disabled={disabled} onChange={() => onChange({ choiceId: c.id })}>{c.text}</Option>)}
        </div>
      );
    case 'MODIFIED_TRUE_FALSE': {
      const falseId = q.choices.find((c) => c.text === 'False')?.id;
      return (
        <div className="space-y-2">
          <div className="space-y-2" role="radiogroup">
            {q.choices.map((c) => <Option key={c.id} type="radio" name={name} checked={r.choiceId === c.id} disabled={disabled} onChange={() => onChange({ choiceId: c.id, ...(c.id === falseId && r.correction ? { correction: r.correction } : {}) })}>{c.text}</Option>)}
          </div>
          {r.choiceId === falseId && (
            <label className="block pt-1 text-sm font-medium text-ink">
              What word or phrase makes the statement true?
              <Input value={r.correction ?? ''} disabled={disabled} onChange={(e) => onChange({ choiceId: r.choiceId, correction: e.target.value })} maxLength={300} className="mt-1.5" autoComplete="off" />
            </label>
          )}
        </div>
      );
    }
    case 'MULTIPLE_RESPONSE': {
      const chosen = r.choiceIds ?? [];
      return (
        <div className="space-y-2">
          <p className="text-[13px] text-faint">Choose all that apply.</p>
          {q.choices.map((c) => (
            <Option key={c.id} type="checkbox" checked={chosen.includes(c.id)} disabled={disabled} onChange={(e) => { const next = e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id); onChange(next.length ? { choiceIds: next } : null); }}>{c.text}</Option>
          ))}
        </div>
      );
    }
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      return <Input value={r.text ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? { text: e.target.value } : null)} placeholder="Type your answer" maxLength={2000} autoComplete="off" spellCheck={false} aria-label="Your answer" className="h-11 text-[15px]" />;
    case 'ESSAY': {
      const words = wordCount(r.text ?? '');
      const limit = q.settings?.wordLimit;
      return (
        <div>
          <Textarea rows={9} value={r.text ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? { text: e.target.value } : null)} placeholder="Write your answer" aria-label="Your answer" className="text-[15px]" />
          <p className={cn('mt-1 text-right text-xs tabular-nums', limit && words > limit ? 'font-semibold text-bad' : 'text-faint')}>{words} word{words === 1 ? '' : 's'}{limit ? ` · limit ${limit}` : ''}</p>
        </div>
      );
    }
    case 'FILL_BLANKS': {
      const blanks = Array.from({ length: q.blankCount }, (_, i) => r.blanks?.[i] ?? '');
      return (
        <ol className="space-y-2">
          {blanks.map((value, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand">{i + 1}</span>
              <Input value={value} disabled={disabled} onChange={(e) => { const next = blanks.map((b, n) => (n === i ? e.target.value : b)); onChange(next.some((b) => b.trim()) ? { blanks: next } : null); }} aria-label={`Blank ${i + 1}`} maxLength={300} autoComplete="off" spellCheck={false} className="max-w-sm" />
            </li>
          ))}
        </ol>
      );
    }
    case 'MATCHING': {
      const pairs = r.pairs ?? {};
      return (
        <ul className="space-y-2">
          {q.left.map((l) => (
            <li key={l.id} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-line p-3 sm:grid-cols-2">
              <span className="text-[15px] text-ink">{l.text}</span>
              <Select value={pairs[l.id] ?? ''} disabled={disabled} aria-label={`Match for ${l.text}`} onChange={(e) => { const next = { ...pairs }; if (e.target.value) next[l.id] = e.target.value; else delete next[l.id]; onChange(Object.keys(next).length ? { pairs: next } : null); }}>
                <option value="">Choose…</option>
                {q.right.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
              </Select>
            </li>
          ))}
        </ul>
      );
    }
    case 'ORDERING': {
      const byId = new Map(q.items.map((i) => [i.id, i]));
      const order = r.order ?? q.items.map((i) => i.id);
      const move = (i, delta) => { const next = [...order]; const [id] = next.splice(i, 1); next.splice(i + delta, 0, id); onChange({ order: next }); };
      return (
        <div>
          <p className="mb-2 text-[13px] text-faint">Use the arrows to put the items in order, first at the top.</p>
          <ol className="space-y-2">
            {order.map((id, i) => (
              <li key={id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised text-xs font-bold text-soft">{i + 1}</span>
                <span className="min-w-0 flex-1 text-[15px] text-ink">{byId.get(id)?.text}</span>
                <button type="button" disabled={disabled || i === 0} onClick={() => move(i, -1)} className="grid size-9 place-items-center rounded-lg text-soft hover:bg-raised disabled:opacity-30" aria-label={`Move “${byId.get(id)?.text}” up`}><ArrowUp className="size-4" /></button>
                <button type="button" disabled={disabled || i === order.length - 1} onClick={() => move(i, 1)} className="grid size-9 place-items-center rounded-lg text-soft hover:bg-raised disabled:opacity-30" aria-label={`Move “${byId.get(id)?.text}” down`}><ArrowDown className="size-4" /></button>
              </li>
            ))}
          </ol>
          {!r.order && !disabled && <button type="button" onClick={() => onChange({ order })} className="mt-2 text-[13px] font-medium text-brand hover:underline">This order is my answer</button>}
        </div>
      );
    }
    case 'FILE_UPLOAD':
      return <FileUpload value={files} disabled={disabled} max={5} onBrowse={onBrowse} onChange={(list) => { onFiles?.(list); onChange(list.length ? { fileIds: list.map((f) => f.id) } : null); }} label="Upload your answer" hint="Up to 5 files" />;
    // PROGRAMMING answers are edited in the code workbench (components/CodeWorkbench.jsx), not here.
    default:
      return <p className="text-sm text-faint">This question type cannot be answered here.</p>;
  }
}

const Mark = ({ ok }) => (ok ? <Check className="size-4 shrink-0 text-ok" aria-label="Correct" /> : <X className="size-4 shrink-0 text-bad" aria-label="Incorrect" />);

/** A finished answer. `item` is one entry of attempt.questions; `item.correct` is present only when answers may be revealed. */
export function AnswerReview({ item }) {
  const { question: q, response, correct } = item;
  const r = response ?? {};
  const reveal = correct !== undefined && correct !== null;
  if (!item.answered && !['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'MODIFIED_TRUE_FALSE'].includes(q.type)) {
    return (
      <div>
        <p className="text-sm italic text-faint">No answer.</p>
        {reveal && <CorrectText q={q} correct={correct} />}
      </div>
    );
  }
  switch (q.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE':
    case 'MULTIPLE_RESPONSE': {
      const chosen = q.type === 'MULTIPLE_RESPONSE' ? r.choiceIds ?? [] : [r.choiceId];
      const right = reveal ? (q.type === 'MULTIPLE_RESPONSE' ? correct.choiceIds : [correct.choiceId]) : null;
      return (
        <div>
          <ul className="space-y-1.5">
            {q.choices.map((c, i) => {
              const picked = chosen.includes(c.id);
              const isRight = right?.includes(c.id);
              return (
                <li key={c.id} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm', right ? (isRight ? 'border-ok/50 bg-ok-soft' : picked ? 'border-bad/50 bg-bad-soft' : 'border-line') : picked ? 'border-brand bg-brand-soft' : 'border-line')}>
                  <span className="mt-0.5 w-4 shrink-0 text-xs font-bold text-faint">{letter(i)}</span>
                  <span className="min-w-0 flex-1 text-ink">{c.text}</span>
                  {picked && <Badge tone={right ? (isRight ? 'ok' : 'bad') : 'brand'}>Chosen</Badge>}
                  {right && isRight && !picked && <Badge tone="ok">Correct answer</Badge>}
                </li>
              );
            })}
          </ul>
          {!item.answered && <p className="mt-2 text-sm italic text-faint">No answer.</p>}
          {q.type === 'MODIFIED_TRUE_FALSE' && (r.correction || correct?.correction?.length > 0) && (
            <p className="mt-2 text-sm text-soft">{r.correction && <>Correction given: <strong className="text-ink">{r.correction}</strong>. </>}{correct?.correction?.length > 0 && <>Accepted: <strong className="text-ok">{correct.correction.join(', ')}</strong></>}</p>
          )}
        </div>
      );
    }
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      return (
        <div>
          <p className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink">{item.isCorrect !== null && item.isCorrect !== undefined && <Mark ok={item.isCorrect} />}{r.text}</p>
          {reveal && <CorrectText q={q} correct={correct} />}
        </div>
      );
    case 'ESSAY':
      return <p className="whitespace-pre-wrap rounded-lg border border-line bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink">{r.text}</p>;
    case 'FILL_BLANKS':
      return (
        <ol className="space-y-1.5 text-sm">
          {Array.from({ length: q.blankCount }, (_, i) => {
            const given = r.blanks?.[i] ?? '';
            const accepted = correct?.blanks?.[i];
            const ok = accepted ? accepted.some((a) => a.trim().toLowerCase() === given.trim().toLowerCase()) : null;
            return (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-bold text-soft">{i + 1}</span>
                <span className={cn('rounded-md border px-2.5 py-1', ok === null ? 'border-line' : ok ? 'border-ok/50 bg-ok-soft' : 'border-bad/50 bg-bad-soft')}>{given || <em className="text-faint">blank</em>}</span>
                {accepted && !ok && <span className="text-soft">Accepted: <strong className="text-ok">{accepted.join(', ')}</strong></span>}
              </li>
            );
          })}
        </ol>
      );
    case 'MATCHING': {
      const rightText = new Map(q.right.map((o) => [o.id, o.text]));
      return (
        <ul className="space-y-1.5 text-sm">
          {q.left.map((l) => {
            const given = r.pairs?.[l.id];
            const ok = reveal ? given === correct.pairs[l.id] : null;
            return (
              <li key={l.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2', ok === null ? 'border-line' : ok ? 'border-ok/50 bg-ok-soft' : 'border-bad/50 bg-bad-soft')}>
                <span className="font-medium text-ink">{l.text}</span><span className="text-faint">→</span>
                <span className="text-ink">{given ? rightText.get(given) : <em className="text-faint">no match</em>}</span>
                {ok === false && <span className="ml-auto text-soft">Correct: <strong className="text-ok">{rightText.get(correct.pairs[l.id])}</strong></span>}
              </li>
            );
          })}
        </ul>
      );
    }
    case 'ORDERING': {
      const text = new Map(q.items.map((i) => [i.id, i.text]));
      return (
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Answer given</p>
            <ol className="space-y-1">{(r.order ?? []).map((id, i) => <li key={id} className={cn('rounded-md border px-2.5 py-1.5', reveal ? (correct.order[i] === id ? 'border-ok/50 bg-ok-soft' : 'border-bad/50 bg-bad-soft') : 'border-line')}>{i + 1}. {text.get(id)}</li>)}</ol>
          </div>
          {reveal && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Correct order</p>
              <ol className="space-y-1">{correct.order.map((id, i) => <li key={id} className="rounded-md border border-line px-2.5 py-1.5">{i + 1}. {text.get(id)}</li>)}</ol>
            </div>
          )}
        </div>
      );
    }
    case 'FILE_UPLOAD':
      return item.files?.length ? <FileList files={item.files} /> : <p className="text-sm italic text-faint">No file was uploaded.</p>;
    case 'PROGRAMMING':
      return <pre className="max-h-80 overflow-auto rounded-lg bg-[#151826] p-3.5 text-[13px] leading-relaxed text-[#e6e8f2]"><code>{r.code}</code></pre>;
    default:
      return null;
  }
}

function CorrectText({ q, correct }) {
  if (q.type === 'IDENTIFICATION' || q.type === 'SHORT_ANSWER') {
    return correct.accepted?.length ? <p className="mt-2 text-sm text-soft">Accepted: <strong className="text-ok">{correct.accepted.join(', ')}</strong></p> : null;
  }
  return null;
}

/** Score chip for one reviewed answer. */
export function ScoreChip({ item }) {
  if (item.needsManual && item.manualScore === null) return <Badge tone="warn" icon={CircleDashed}>Waiting for your teacher</Badge>;
  if (item.score === null || item.score === undefined) return null;
  const full = item.score >= item.points;
  return <Badge tone={full ? 'ok' : item.score > 0 ? 'warn' : 'bad'} icon={full ? CheckCircle2 : item.score > 0 ? CircleDashed : XCircle}>{formatScore(item.score)} / {formatScore(item.points)}</Badge>;
}
