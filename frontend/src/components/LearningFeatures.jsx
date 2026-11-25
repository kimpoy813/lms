import { useId, useState } from 'react';
import { CheckCircle2, Image, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from './ui.jsx';

export const DEFAULT_LEARNING_VISUAL = {
  title: 'Concept pathway',
  description: 'Follow how the key ideas connect from start to finish.',
  steps: ['Key idea', 'Apply the idea', 'Check your reasoning'],
};

export const DEFAULT_SELF_CHECK = {
  prompt: 'Which statement best describes the key idea in this lesson?',
  options: ['The correct explanation', 'A common misconception', 'An unrelated idea'],
  correctIndex: 0,
  explanation: 'Review the lesson explanation and compare each choice with the key concept.',
};

const cleanLines = (text, limit) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, limit);
const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

function wrapLabel(text, max = 20, maxLines = 3) {
  const lines = [];
  let line = '';
  for (const word of words(text)) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words(text).join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.…]+$/, '')}…`;
  }
  return lines.length ? lines : ['Step'];
}

/** A small, accessible vector concept map. Labels are plain text; no generated SVG is executed. */
export function LearningVisual({ visual }) {
  const reactId = useId();
  const markerId = `learning-arrow-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const steps = Array.isArray(visual?.steps) ? visual.steps.filter((step) => typeof step === 'string' && step.trim()).slice(0, 5) : [];
  if (steps.length < 2) return null;

  const boxWidth = 174;
  const boxHeight = 94;
  const gap = 38;
  const margin = 28;
  const width = margin * 2 + steps.length * boxWidth + (steps.length - 1) * gap;
  const y = 42;

  return (
    <figure className="my-6 overflow-hidden rounded-2xl border border-line bg-raised/35">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Image className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">Visual guide</p>
            <h3 className="mt-0.5 font-semibold text-ink">{visual.title || 'Concept pathway'}</h3>
            {visual.description && <p className="mt-1 text-sm leading-relaxed text-soft">{visual.description}</p>}
          </div>
        </div>
      </figcaption>
      <div className="overflow-x-auto px-3 py-4" role="region" aria-label={`Scrollable concept diagram: ${visual.title || 'Concept pathway'}`} tabIndex={0}>
        <svg
          role="img"
          aria-label={`${visual.title || 'Concept pathway'}: ${steps.join(', then ')}`}
          viewBox={`0 0 ${width} 176`}
          width={width}
          height="176"
          className="max-w-none"
        >
          <defs>
            <marker id={markerId} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L9,4.5 L0,9 z" fill="var(--brand)" />
            </marker>
          </defs>
          {steps.slice(0, -1).map((_, index) => {
            const x1 = margin + index * (boxWidth + gap) + boxWidth + 5;
            const x2 = margin + (index + 1) * (boxWidth + gap) - 7;
            return <line key={`link-${index}`} x1={x1} y1={y + boxHeight / 2} x2={x2} y2={y + boxHeight / 2} stroke="var(--brand)" strokeWidth="2.5" markerEnd={`url(#${markerId})`} />;
          })}
          {steps.map((step, index) => {
            const x = margin + index * (boxWidth + gap);
            const lines = wrapLabel(step);
            const firstY = y + (boxHeight - lines.length * 19) / 2 + 17;
            return (
              <g key={`${index}-${step}`}>
                <rect x={x} y={y} width={boxWidth} height={boxHeight} rx="14" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.5" />
                <circle cx={x + 19} cy={y + 19} r="11" fill="var(--brand-soft)" />
                <text x={x + 19} y={y + 23} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--brand)">{index + 1}</text>
                <text x={x + boxWidth / 2} y={firstY} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--ink)">
                  {lines.map((line, lineIndex) => <tspan key={lineIndex} x={x + boxWidth / 2} dy={lineIndex === 0 ? 0 : 18}>{line}</tspan>)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ol className="sr-only">
        {steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
      </ol>
    </figure>
  );
}

/** One ungraded multiple-choice check; answers are revealed only after the learner checks. */
export function QuickCheck({ check }) {
  const [selected, setSelected] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const options = Array.isArray(check?.options) ? check.options.filter((option) => typeof option === 'string').slice(0, 5) : [];
  const answer = Number.isInteger(check?.correctIndex) ? check.correctIndex : 0;
  if (options.length < 2 || answer < 0 || answer >= options.length) return null;
  const correct = submitted && selected === answer;

  return (
    <Card className="my-6 border-brand/25 bg-brand-soft/20">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink"><CheckCircle2 className="size-4 text-brand" aria-hidden="true" />Quick check</div>
        <Badge tone="brand">Ungraded practice</Badge>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (selected !== null) setSubmitted(true); }}>
        <fieldset>
          <legend className="text-sm font-medium leading-relaxed text-ink">{check.prompt}</legend>
          <div className="mt-3 space-y-2">
            {options.map((option, index) => {
              const isAnswer = submitted && index === answer;
              const isSelected = selected === index;
              return (
                <label key={`${index}-${option}`} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm transition-colors ${isAnswer ? 'border-ok/50 bg-ok/10' : isSelected ? 'border-brand bg-brand-soft/50' : 'border-line bg-surface hover:border-brand/40'}`}>
                  <input
                    className="mt-0.5 accent-[var(--brand)]"
                    type="radio"
                    name={`quick-check-${reactId}`}
                    value={index}
                    checked={isSelected}
                    onChange={() => { setSelected(index); setSubmitted(false); }}
                    aria-describedby={submitted && isAnswer ? `quick-check-answer-${reactId}` : undefined}
                  />
                  <span className="text-soft">{option}</span>
                  {isAnswer && <span className="ml-auto shrink-0 text-xs font-semibold text-ok">Answer</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!submitted ? (
            <Button type="submit" size="sm" disabled={selected === null}>Check answer</Button>
          ) : (
            <>
              <p role="status" aria-live="polite" className={`text-sm font-semibold ${correct ? 'text-ok' : 'text-warn'}`}>
                {correct ? 'Correct — nice work.' : `Not quite. The best answer is “${options[answer]}”.`}
              </p>
              <Button type="button" size="sm" variant="ghost" icon={RotateCcw} onClick={() => { setSelected(null); setSubmitted(false); }}>Try again</Button>
            </>
          )}
        </div>
        {submitted && check.explanation && <p id={`quick-check-answer-${reactId}`} className="mt-2 text-sm leading-relaxed text-soft">{check.explanation}</p>}
      </form>
    </Card>
  );
}

/** Teacher authoring controls for generated visual guides and ungraded practice checks. */
export function LearningFeaturesEditor({ visual, selfCheck, onChange, disabled = false }) {
  const currentVisual = visual && typeof visual === 'object' ? { ...DEFAULT_LEARNING_VISUAL, ...visual } : null;
  const currentCheck = selfCheck && typeof selfCheck === 'object' ? { ...DEFAULT_SELF_CHECK, ...selfCheck } : null;
  const setVisual = (patch) => onChange({ visual: { ...DEFAULT_LEARNING_VISUAL, ...currentVisual, ...patch } });
  const setCheck = (patch) => onChange({ selfCheck: { ...DEFAULT_SELF_CHECK, ...currentCheck, ...patch } });

  return (
    <div className="space-y-4">
      <Card className="border-dashed">
        <CardHeader title="Visual guide" description="A compact, responsive concept pathway built from safe text labels—not external images or generated scripts." action={currentVisual && !disabled && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange({ visual: null })}>Remove</Button>} />
        {currentVisual ? (
          <div className="space-y-3">
            <Field label="Diagram title"><Input disabled={disabled} value={currentVisual.title ?? ''} maxLength={120} onChange={(event) => setVisual({ title: event.target.value })} /></Field>
            <Field label="Short description"><Input disabled={disabled} value={currentVisual.description ?? ''} maxLength={240} onChange={(event) => setVisual({ description: event.target.value })} /></Field>
            <Field label="Pathway steps" hint="One step per line; use 2–5 concise steps.">
              <Textarea rows={4} disabled={disabled} maxLength={900} value={(currentVisual.steps ?? []).join('\n')} onChange={(event) => setVisual({ steps: cleanLines(event.target.value, 5) })} />
            </Field>
            {currentVisual.steps?.length < 2 && <p className="text-xs text-warn">Add at least two steps before saving.</p>}
            <LearningVisual visual={currentVisual} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-soft">Add a diagram to help learners see how the lesson’s ideas fit together.</p>
            {!disabled && <Button size="sm" variant="secondary" icon={Plus} onClick={() => onChange({ visual: DEFAULT_LEARNING_VISUAL })}>Add a visual guide</Button>}
          </div>
        )}
      </Card>

      <Card className="border-dashed">
        <CardHeader title="Interactive quick check" description="Learners choose an answer, check it, and get immediate ungraded feedback." action={currentCheck && !disabled && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange({ selfCheck: null })}>Remove</Button>} />
        {currentCheck ? (
          <div className="space-y-3">
            <Field label="Question"><Textarea rows={2} disabled={disabled} value={currentCheck.prompt ?? ''} maxLength={500} onChange={(event) => setCheck({ prompt: event.target.value })} /></Field>
            <Field label="Answer choices" hint="One choice per line; include 2–5 options.">
              <Textarea rows={4} disabled={disabled} maxLength={1200} value={(currentCheck.options ?? []).join('\n')} onChange={(event) => {
                const options = cleanLines(event.target.value, 5);
                setCheck({ options, correctIndex: Math.min(currentCheck.correctIndex ?? 0, Math.max(options.length - 1, 0)) });
              }} />
            </Field>
            <Field label="Correct answer">
              <Select disabled={disabled || currentCheck.options?.length < 2} value={String(currentCheck.correctIndex ?? 0)} onChange={(event) => setCheck({ correctIndex: Number(event.target.value) })}>
                {(currentCheck.options ?? []).map((option, index) => <option key={`${index}-${option}`} value={index}>{String.fromCharCode(65 + index)}. {option.slice(0, 90)}</option>)}
              </Select>
            </Field>
            {currentCheck.options?.length < 2 && <p className="text-xs text-warn">Add at least two answer choices before saving.</p>}
            <Field label="Feedback after checking"><Textarea rows={2} disabled={disabled} value={currentCheck.explanation ?? ''} maxLength={700} onChange={(event) => setCheck({ explanation: event.target.value })} /></Field>
            <QuickCheck check={currentCheck} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-soft">Add a short self-check with an answer and explanation.</p>
            {!disabled && <Button size="sm" variant="secondary" icon={Plus} onClick={() => onChange({ selfCheck: DEFAULT_SELF_CHECK })}>Add a quick check</Button>}
          </div>
        )}
      </Card>
    </div>
  );
}
