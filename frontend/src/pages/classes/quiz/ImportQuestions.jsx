// Bring in questions that exist already: paste JSON or a test paper, or choose a file. The
// server reads them into drafts and saves nothing; the teacher looks at what was understood —
// the answer key is shown on every question — corrects what needs it, and adds what is wanted.
//
// The same dialog serves a quiz and a question bank. docs/QUESTION-IMPORT.md has the format.
import { AlertTriangle, Bot, Braces, CheckCircle2, Copy, FileText, Info, Pencil, Upload, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { toast } from '../../../components/toast.jsx';
import { Alert, Badge, Button, cn, EmptyState, Field, Input, Modal, Select, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatLimit, formatScore, plural } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { ALL_TYPES, buildPrompt, DEFAULT_TYPES, DIFFICULTY_CHOICES, exampleJson, FORMAT_TYPES, isOwnRequest, questionCount } from '../../../lib/questionFormat.js';
import QuestionEditor from './QuestionEditor.jsx';
import { AnswerKey, MarkedByBadge, QuestionText, typeLabel } from './QuestionParts.jsx';

/** The server reads documents of up to 10 MB, or less where it accepts only smaller uploads. */
const IMPORT_LIMIT_BYTES = 10 * 1024 * 1024;
const PLACEHOLDER = `{
  "questions": [
    { "type": "multiple_choice", "question": "Which part of a computer is its brain?", "choices": ["RAM", "CPU", "Hard disk"], "answer": "CPU" },
    { "type": "true_false", "question": "One byte is made of 8 bits.", "answer": true }
  ]
}`;

const copy = (text, done) => {
  const failed = () => toast.error('Could not copy. Select the text and copy it by hand.');
  if (!navigator.clipboard) failed();
  else navigator.clipboard.writeText(text).then(() => toast.success(done), failed);
};

/**
 * @param {object} props
 * @param {'quiz'|'bank'} props.target where the questions go
 * @param {string} [props.noun] what the dialog calls it: "examination" for a quiz that is one
 * @param {string} props.previewUrl POST here with a file or { text }: answers the drafts
 * @param {(questions: object[]) => Promise<unknown>} props.onSave store the chosen questions; rejects with an ApiError
 * @param {() => void} props.onClose
 */
export default function ImportQuestions({ target = 'quiz', noun = target, previewUrl, onSave, onClose }) {
  const { runtime } = useAuth();
  const importLimit = Math.min(IMPORT_LIMIT_BYTES, runtime.maxUploadBytes ?? IMPORT_LIMIT_BYTES);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef(null);
  // With a mouse and keyboard the box is ready to be pasted into. On a touch screen that would
  // open the keyboard over the dialog before anything was chosen.
  const [touch] = useState(() => window.matchMedia?.('(pointer: coarse)').matches === true);

  const receive = (result) => {
    setPreview(result);
    // What is there already is left out unless the teacher asks for it.
    setDrafts(result.questions.map((q, i) => ({ ...q, key: i, include: q.errors.length === 0 && !q.duplicate })));
    setError(null);
  };
  const parse = useAction((file) => (file ? api.postForm(previewUrl, { file }) : api.post(previewUrl, { text })), {
    onSuccess: receive,
    onError: (err) => { setError(err.fields?.file ?? err.fields?.text ?? err.message); return true; },
  });
  const readText = () => {
    // The request was copied last, so it is what gets pasted when the answer was not copied.
    if (isOwnRequest(text)) setError('This is the request for the chat assistant, not its answer. Send it to the assistant, then copy what it answers and paste that here.');
    else parse.mutate(null);
  };
  // Check the size here: a host that caps request sizes answers with an error page, not a message.
  const readFile = (file) => {
    if (file.size > importLimit) setError(`“${file.name}” is larger than ${formatLimit(importLimit)}. Paste the text instead, or split the document.`);
    else parse.mutate(file);
  };

  const chosen = drafts.filter((d) => d.include);
  const save = useAction(() => onSave(chosen.map(({ key, include, warnings, errors, number, duplicate, ...question }) => question)), {
    onSuccess: onClose,
    onError: (err) => {
      // The server names the questions that still have problems.
      const bad = err.details?.questions;
      if (!bad) return false;
      setDrafts((list) => {
        const included = list.filter((d) => d.include);
        return list.map((d) => { const problem = bad.find((b) => b.index === included.indexOf(d)); return problem ? { ...d, errors: problem.errors } : d; });
      });
      setError(err.message);
      return true;
    },
  });
  const set = (key, patch) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const count = (test) => drafts.filter(test).length;
  // Four groups that add up to what was found: one the quiz or bank has already counts as that only.
  const already = count((d) => d.duplicate);
  const toFix = count((d) => !d.duplicate && d.errors.length > 0);
  const toCheck = count((d) => !d.duplicate && d.errors.length === 0 && d.warnings.length > 0);
  const ready = drafts.length - already - toFix - toCheck;

  return (
    <Modal open onClose={onClose} size="xl" title="Import questions"
      description={preview ? `${preview.source} — look at what was read before anything is added.` : `Questions you already have, with their answers. Nothing is added to the ${noun} until you have looked at them.`}
      footer={preview
        ? <><Button variant="secondary" onClick={() => { setPreview(null); setDrafts([]); setError(null); }}>Start over</Button><Button loading={save.isPending} disabled={chosen.length === 0 || chosen.some((d) => d.errors.length > 0)} onClick={() => save.mutate()}>Add {plural(chosen.length, 'question')} to the {noun}</Button></>
        : <Button variant="secondary" onClick={onClose}>Cancel</Button>}>
      {error && <Alert tone="bad" className="mb-4" title={preview ? undefined : 'These could not be read'}><span className="break-words">{error}</span></Alert>}
      {!preview ? (
        <div className="space-y-5">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={parse.isPending}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const file = e.dataTransfer.files?.[0]; if (file) readFile(file); }}
            className={cn('flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-7 text-center hover:border-brand', over ? 'border-brand bg-brand-soft' : 'border-line-strong')}>
            <Upload className="size-7 text-brand" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink">{parse.isPending ? 'Reading…' : 'Choose a file, or drop it here'}</span>
            <span className="text-xs text-faint">JSON, Word (.docx), PDF or text · up to {formatLimit(importLimit)}</span>
          </button>
          <input ref={fileInput} type="file" hidden accept=".json,.docx,.pdf,.txt,.md,application/json" onChange={(e) => { const file = e.target.files?.[0]; if (file) readFile(file); e.target.value = ''; }} />

          <div>
            <label htmlFor="import-text" className="mb-1.5 block text-sm font-medium text-ink">…or paste the questions</label>
            <Textarea id="import-text" data-autofocus={touch ? undefined : ''} rows={9} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="font-mono text-[13px]" placeholder={PLACEHOLDER}
              // A file that was copied, not its text: read it like a file that was chosen.
              onPaste={(e) => { const file = e.clipboardData?.files?.[0]; if (file) { e.preventDefault(); readFile(file); } }} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-faint">JSON, or a test paper typed as numbered questions.</p>
              <Button loading={parse.isPending} disabled={!text.trim()} onClick={readText}>Read the questions</Button>
            </div>
          </div>

          <div className="space-y-2">
            <Help icon={Braces} title="How to write the JSON"><JsonHelp /></Help>
            <Help icon={Bot} title="Let an AI chat write the questions"><PromptHelp /></Help>
            <Help icon={FileText} title="Import a test paper: Word, PDF or text"><PaperHelp /></Help>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="brand">{plural(drafts.length, 'question')} found</Badge>
            <Badge tone="ok" icon={CheckCircle2}>{ready} ready</Badge>
            {toCheck > 0 && <Badge tone="warn" icon={AlertTriangle}>{toCheck} to double-check</Badge>}
            {toFix > 0 && <Badge tone="bad" icon={XCircle}>{toFix} {toFix === 1 ? 'needs' : 'need'} fixing</Badge>}
            {already > 0 && <Badge tone="info" icon={Info}>{already} already in the {noun}</Badge>}
            {drafts.length > 1 && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setDrafts((list) => list.map((d) => ({ ...d, include: d.errors.length === 0 })))}>Tick all</Button>
                <Button size="sm" variant="ghost" onClick={() => setDrafts((list) => list.map((d) => ({ ...d, include: false })))}>Untick all</Button>
              </span>
            )}
          </div>
          {preview.notes.map((n) => <Alert key={n} tone="info"><span className="break-words">{n}</span></Alert>)}
          {toCheck > 0 && <p className="text-[13px] text-soft">Check the answer shown on each question marked in amber: there the reader had to choose between two ways of reading the file.</p>}
          {drafts.length === 0 ? <EmptyState compact title="No questions were recognised" description="Check that each question starts with a number, then try again." /> : (
            <ol className="space-y-2.5" aria-label="Questions that were read">
              {drafts.map((d) => (
                <li key={d.key} className={cn('rounded-xl border p-3.5', d.errors.length > 0 ? 'border-bad/50' : d.warnings.length > 0 ? 'border-warn/50' : 'border-line')}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={d.include} onChange={(e) => set(d.key, { include: e.target.checked })} className="mt-1 size-[18px] shrink-0 accent-[var(--brand-fill)]" aria-label={`Include question ${d.number ?? d.key + 1}`} />
                    {/* Left out: stepped back, but still readable. One that needs fixing is not left out by choice. */}
                    <div className={cn('min-w-0 flex-1', !d.include && d.errors.length === 0 && 'opacity-60')}>
                      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                        <span className="font-semibold text-soft">#{d.number ?? d.key + 1}</span><Badge>{typeLabel(d.type)}</Badge>
                        {d.section && <span>{d.section}</span>}<span>{formatScore(d.points ?? 1)} pt</span>
                        <MarkedByBadge q={d} />
                      </p>
                      <QuestionText question={d} className="text-sm" />
                      <AnswerKey q={d} />
                      {d.explanation && <p className="mt-1.5 text-[13px] text-faint">Explanation: {d.explanation}</p>}
                      {d.errors.map((e) => <p key={e} className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium text-bad"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{e}</p>)}
                      {d.warnings.map((w) => <p key={w} className="mt-1.5 flex items-start gap-1.5 text-[13px] text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{w}</p>)}
                      {d.duplicate && <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-info"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{target === 'quiz'
                        ? `The ${noun} already has a question with this text. Tick this one only if it is a different question: the very same question is not added twice.`
                        : 'The bank already has a question with this text. Tick this one to add it as well.'}</p>}
                    </div>
                    <Button size="sm" variant={d.errors.length > 0 ? 'primary' : 'ghost'} icon={Pencil} onClick={() => setEditing(d)}>{d.errors.length > 0 ? 'Fix' : 'Edit'}</Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {editing && (
        <QuestionEditor title={`Question ${editing.number ?? editing.key + 1}`} question={{ ...editing, id: undefined }} parts={[...new Set(drafts.map((d) => d.section).filter(Boolean))]} onClose={() => setEditing(null)}
          // Corrected by hand: nothing is left to flag, and it goes in.
          onSave={async (question) => { set(editing.key, { ...question, errors: [], warnings: [], duplicate: false, include: true }); }} />
      )}
    </Modal>
  );
}

function Help({ icon: Icon, title, children }) {
  return (
    // Opened at the bottom of the dialog: bring what it holds into view.
    <details className="group rounded-xl bg-raised text-[13px] text-soft" onToggle={(e) => { if (e.currentTarget.open) e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
      <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-3 font-semibold text-ink"><Icon className="size-4 shrink-0 text-brand" aria-hidden="true" />{title}</summary>
      <div className="space-y-3 px-3.5 pb-3.5">{children}</div>
    </details>
  );
}

const Code = ({ children }) => <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink">{children}</pre>;

function JsonHelp() {
  const short = useMemo(() => exampleJson(['multiple_choice', 'true_false', 'identification']), []);
  return (
    <>
      <p>A list of questions. Each one has its <code>type</code>, the <code>question</code>, and the <code>answer</code>:</p>
      <Code>{short}</Code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(short, 'Example copied.')}>Copy this example</Button>
        <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(exampleJson(ALL_TYPES), 'Example copied.')}>Copy an example of every kind</Button>
      </div>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Choices:</strong> <code>answer</code> is the text of the correct choice, or its letter. Give a list when several are correct.</li>
        <li><strong>True or false:</strong> <code>"answer": true</code> or <code>false</code>. <strong>A typed answer:</strong> one text, or a list of the texts that count as correct.</li>
        <li><strong>Other kinds:</strong> fill in the blanks, matching, ordering and essay. The example of every kind shows each of them.</li>
        <li><code>points</code>, <code>difficulty</code> (easy, medium, hard), <code>topic</code> and <code>explanation</code> can be left out.</li>
        <li>Other common ways of writing it are understood too, such as <code>options</code> and <code>correctAnswer</code>, or an answer key at the end of the file. Where the reader was not sure, the question is marked for you to check.</li>
      </ul>
    </>
  );
}

function PromptHelp() {
  const [options, setOptions] = useState({ count: 10, types: DEFAULT_TYPES, topic: '', difficulty: '' });
  const change = (patch) => setOptions((o) => ({ ...o, ...patch }));
  const request = useMemo(() => buildPrompt(options), [options]);
  const toggle = (type) => change({ types: options.types.includes(type) ? options.types.filter((t) => t !== type) : [...options.types, type] });
  return (
    <>
      <p>Use any chat assistant you have, such as ChatGPT, Gemini, Copilot or Claude. EduSphere sends nothing to it: you copy a request, give it to the assistant together with your lesson, and paste what it answers into the box above.</p>
      <div className="grid gap-3 sm:grid-cols-[8rem_10rem_1fr]">
        <Field label="How many"><Input type="number" min="1" max="100" value={options.count} onChange={(e) => change({ count: e.target.value })} onBlur={() => change({ count: questionCount(options.count) })} /></Field>
        <Field label="Difficulty"><Select value={options.difficulty} onChange={(e) => change({ difficulty: e.target.value })}>{DIFFICULTY_CHOICES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select></Field>
        <Field label="Topic, and anything else to tell it" optional><Input value={options.topic} onChange={(e) => change({ topic: e.target.value })} maxLength={300} placeholder="Number systems, for first-year students" /></Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink">Kinds of question</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {FORMAT_TYPES.map((t) => (
            <label key={t.value} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4 accent-[var(--brand-fill)]" checked={options.types.includes(t.value)} onChange={() => toggle(t.value)} />{t.label}</label>
          ))}
        </div>
      </fieldset>
      <ol className="list-decimal space-y-1 pl-5">
        <li><Button size="sm" icon={Copy} className="mr-1.5 align-middle" onClick={() => copy(request, 'Request copied. Paste it into your chat assistant.')}>Copy the request</Button> and paste it into the chat assistant.</li>
        <li>Paste your lesson, notes or reading where the request ends with “Material:”, and send it.</li>
        <li>Copy the whole answer and paste it into the box above. Read every question and its answer before you add them: an assistant can be wrong.</li>
      </ol>
      <details>
        <summary className="cursor-pointer font-medium text-ink">See the request</summary>
        <div className="mt-2"><Code>{request}</Code></div>
      </details>
    </>
  );
}

function PaperHelp() {
  return (
    <ul className="list-disc space-y-1 pl-5">
      <li>Number the questions: <code>1.</code> or <code>1)</code>. Letter the choices: <code>A.</code> <code>B.</code> …</li>
      <li>Mark the correct choice with a <code>*</code>, or make it <strong>bold</strong> or highlighted in Word, or add a line <code>Answer: B</code>.</li>
      <li>An answer key at the end (<code>Answer Key</code> then <code>1. B</code>, <code>2. True</code>…) is also understood.</li>
      <li>Section headings such as “Part II. True or False” or “Identification” set the question type.</li>
      <li>Scanned pictures of text cannot be read. Pictures and equations need to be added by hand afterwards.</li>
    </ul>
  );
}
