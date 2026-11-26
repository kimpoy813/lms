// Questions written as JSON — by hand, by a chat assistant, or downloaded from Discenda — turned
// into draft questions for the teacher to review. Nothing here writes to the database.
//
// The format that is documented (docs/QUESTION-IMPORT.md) is small:
//
//   { "questions": [
//       { "type": "multiple_choice", "question": "…", "choices": ["…", "…"], "answer": "…" },
//       { "type": "true_false", "question": "…", "answer": true } ] }
//
// What people paste is looser: other names for the same things, an answer given as a letter or
// a number, the whole reply of a chat assistant with a sentence before the JSON, a comma too
// many. This reader takes those where the meaning is clear. Where it had to choose between two
// readings it says so in a warning on that question, and where it cannot tell it leaves the
// answer open, which the teacher then has to fill in: an answer key that is wrong without
// anyone noticing is worse than a question that needs one more look.
import { countBlanks, normalizeAnswer, normalizeQuestion } from './quizScoring.js';
import { escapeHtml, sanitizeRichText } from './sanitize.js';

/** The most questions one import reads, and the most a quiz holds. */
export const MAX_IMPORT_QUESTIONS = 300;
const MAX_TEXT_CHARS = 400_000;
/** The note on JSON whose end is missing. (A caller that cut the text itself says why instead.) */
export const CUT_OFF_NOTE = 'The JSON stops before its end, as if it was cut off when it was copied. The questions that are complete were read: check that none is missing at the end.';

/** The pasted text cannot be read as questions. The message is written for the teacher. */
export class QuestionImportError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A name as people write it ("correctAnswer", "correct_answer", "Correct Answer") in one form. */
const norm = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
// Keep namespaced question-export markers lossless without coupling imports to a particular brand.
const isQuestionExportFormat = (value) => typeof value === 'string' && /^[a-z0-9-]+\.questions$/i.test(value);
const same = (a, b) => normalizeAnswer(a) === normalizeAnswer(b) && normalizeAnswer(a) !== '';
const clip = (value, max = 60) => { const s = String(value).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => ORDINALS[n - 1] ?? `${n}th`;

// ── Finding the JSON in what was pasted ──────────────────────────────────────

const startsLikeJson = (t) => /^\{/.test(t) || /^\[\s*(?:[[{"\]]|$)/.test(t);

/** Is this JSON (and not a test paper written as text)? */
export function looksLikeJson(text, filename = '') {
  if (/\.json$/i.test(String(filename ?? ''))) return true;
  const t = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (startsLikeJson(t)) return true;
  // The reply of a chat assistant: a sentence, then the JSON, often inside a ``` block.
  for (const m of t.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)/g)) if (startsLikeJson(m[1].trim())) return true;
  return /[[{]\s*[[{"]/.test(t) && /"(?:questions?|prompt|stem|choices|options|answers?|correct[A-Za-z_]*|type)"\s*:/i.test(t);
}

// A line break, a tab or a carriage return typed inside a text stands for itself. JSON does not
// allow them there, so they travel through the parser as these stand-ins.
const NEWLINE = '\uE000';
const TAB = '\uE001';
const RETURN = '\uE002';

/**
 * The same text with what people and chat assistants add to JSON made harmless: comments, a
 * comma before a closing bracket, a line break typed inside a text. Each character is replaced
 * by exactly one other, so a position in the result is the same position in what was pasted.
 */
function relax(text) {
  const out = text.split('');
  let inString = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      else if (ch === '\n') out[i] = NEWLINE;
      else if (ch === '\t') out[i] = TAB;
      else if (ch === '\r') out[i] = RETURN;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') { out[i] = ' '; i += 1; }
    } else if (ch === '/' && out[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? out.length : end + 2;
      for (; i < stop; i += 1) if (out[i] !== '\n') out[i] = ' ';
      i -= 1;
    } else if (ch === ',') {
      let next = i + 1;
      while (next < out.length && /\s/.test(out[next])) next += 1;
      if (out[next] === '}' || out[next] === ']') out[i] = ' ';
    }
  }
  return out.join('');
}

/** Put the line breaks and tabs back that `relax` carried through the parser. */
function restore(value) {
  if (typeof value === 'string') return /[\uE000-\uE002]/.test(value) ? value.replace(/\uE000/g, '\n').replace(/\uE001/g, '\t').replace(/\uE002/g, '') : value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = restore(value[i]);
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) if (key !== '__proto__') value[key] = restore(value[key]);
  }
  return value;
}

/**
 * Where JSON goes wrong and why, in plain words. Only called for text the parser refused: the
 * parser's own message differs from one version of Node.js to the next and is written for
 * programmers.
 * @returns {{ at: number, reason: string, ended: boolean } | null}  `ended`: the text stops in
 *          the middle of something, which is what a text that was cut off looks like
 */
export function findJsonError(text) {
  let i = 0;
  const fail = (at, reason) => { throw Object.assign(new Error(reason), { at, reason, jsonProblem: true }); };
  const skip = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i += 1; };
  const ended = 'the JSON stops before its end: a bracket or a brace is not closed';

  const string = () => {
    const start = i;
    i += 1;
    for (;;) {
      const ch = text[i];
      if (ch === undefined) fail(start, 'this text is not closed with a double quote (")');
      if (ch === '"') { i += 1; return; }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i, 'after \\u come four digits or letters a to f');
          i += 6;
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) {
          i += 2;
        } else {
          fail(i, 'a backslash (\\) inside a text has to be written twice: \\\\');
        }
      } else if (ch < ' ') {
        fail(i, 'a text has a character in it that JSON does not allow');
      } else {
        i += 1;
      }
    }
  };
  const number = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 60));
    if (!m) fail(i, 'this number is not written the way JSON writes numbers');
    i += m[0].length;
  };
  const value = () => {
    skip();
    const ch = text[i];
    if (ch === undefined) fail(i, ended);
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i) && !/[A-Za-z0-9_]/.test(text[i + word.length] ?? '')) { i += word.length; return undefined; }
    }
    if (ch === "'") fail(i, 'texts and names go in double quotes ("), not single quotes');
    if (ch === '}' || ch === ']' || ch === ',') fail(i, 'a value is missing just before this');
    if (ch === '\u201C' || ch === '\u201D') fail(i, 'this is a curly quote (“ ”). JSON needs the straight one (")');
    return fail(i, 'a text has to be inside double quotes ("), or this is not something JSON knows');
  };
  const object = () => {
    i += 1;
    skip();
    if (text[i] === '}') { i += 1; return; }
    for (;;) {
      skip();
      if (text[i] === undefined) fail(i, ended);
      if (text[i] === '}') fail(i, 'there is one comma too many before this brace');
      if (text[i] !== '"') fail(i, text[i] === "'" ? 'names go in double quotes ("), not single quotes' : 'a name in double quotes is expected here, such as "question"');
      string();
      skip();
      if (text[i] !== ':') fail(i, 'a colon (:) is missing after the name');
      i += 1;
      value();
      skip();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === '}') { i += 1; return; }
      fail(i, text[i] === undefined ? ended : 'a comma is missing before this, or the text before it is not closed with a double quote (")');
    }
  };
  const array = () => {
    i += 1;
    skip();
    if (text[i] === ']') { i += 1; return; }
    for (;;) {
      value();
      skip();
      if (text[i] === ',') {
        i += 1;
        skip();
        if (text[i] === ']') fail(i, 'there is one comma too many before this bracket');
        continue;
      }
      if (text[i] === ']') { i += 1; return; }
      fail(i, text[i] === undefined ? ended : 'a comma is missing before this, or the text before it is not closed with a double quote (")');
    }
  };

  try {
    value();
    skip();
    if (i < text.length) fail(i, 'something follows the end of the JSON');
    return null;
  } catch (err) {
    if (err.jsonProblem) return { at: err.at, reason: err.reason, ended: i >= text.length };
    throw err;
  }
}

/** One value of JSON, read leniently. Throws an error with `at` (the place in `piece`) and `reason`. */
function parseRelaxed(piece) {
  const relaxed = relax(piece);
  try {
    return restore(JSON.parse(relaxed));
  } catch (err) {
    throw Object.assign(new Error('Invalid JSON'), whatIsWrong(relaxed, err) ?? { at: 0, reason: 'it is not written the way JSON is written' });
  }
}

function whatIsWrong(text, err) {
  // Brackets inside brackets thousands deep exhaust the parser itself, and would this one.
  if (err instanceof RangeError) return { at: 0, reason: 'its brackets are nested too deeply' };
  try {
    return findJsonError(text);
  } catch {
    return null;
  }
}

/**
 * Every {...} or [...] that stands on its own between `from` and `to`, in order. What lies
 * between them is passed over: the sentences of a chat reply, the commas of a list.
 * `strings`: quoted texts outside the brackets count too (inside a value they always do).
 */
function spansIn(text, from, to, strings) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = from; i < to; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"' && (depth > 0 || strings)) {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if ((ch === '}' || ch === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push({ start, end: i + 1, open: false });
    }
  }
  if (depth > 0) spans.push({ start, end: to, open: true });
  return spans;
}

// A name that only a question carries. A value that cannot be read as a whole and carries one
// is a broken question: what is inside it are its choices, not more questions.
const QUESTION_NAME = /"(?:q|question|question[ _-]?text|prompt|stem|statement|text|question[ _-]?html|html)"\s*:/i;
// Any name at all: what tells a piece of JSON from a bracket in a sentence.
const ANY_NAME = /"[^"\n]{1,60}"\s*:/;

/** The part of a value that is its own: without the values nested in it. */
function ownText(text, span) {
  const from = span.start + 1;
  const to = span.open ? span.end : span.end - 1;
  let out = '';
  let at = from;
  for (const inner of spansIn(text, from, to, true)) {
    out += text.slice(at, inner.start);
    at = inner.end;
  }
  return out + text.slice(at, to);
}

function harvest(text, from, to, strings, state, depth) {
  for (const span of spansIn(text, from, to, strings)) {
    const piece = text.slice(span.start, span.end);
    // "[see below]" in a sentence is not JSON that went wrong.
    const meant = ANY_NAME.test(piece);
    if (span.open) {
      if (meant) {
        // Cut off at its end, or wrong somewhere before it (a quote that was never closed
        // swallows the brackets after it)?
        const problem = whatIsWrong(relax(piece), null);
        if (problem && !problem.ended) state.failures.push({ at: span.start + problem.at, reason: problem.reason, size: piece.length });
        else state.cut = true;
      }
    } else {
      try {
        state.values.push(parseRelaxed(piece));
        continue;
      } catch (err) {
        (meant ? state.failures : state.others).push({ at: span.start + err.at, reason: err.reason, size: piece.length });
      }
    }
    // It cannot be read as a whole: read what is inside it piece by piece.
    if (meant && depth < 5 && !QUESTION_NAME.test(ownText(text, span))) harvest(text, span.start + 1, span.open ? span.end : span.end - 1, true, state, depth + 1);
  }
}

/** The line of a place in the text, and what stands there: the rest of that line. */
const whereIs = (text, at) => {
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  const lineEnd = text.indexOf('\n', at);
  const rest = text.slice(at, lineEnd < 0 ? text.length : lineEnd).trim();
  // At the end of a line (or of everything): the line itself.
  return { line, near: clip(rest || text.slice(before.lastIndexOf('\n') + 1, at), 60) };
};

/**
 * The JSON values in what was pasted, however it was wrapped.
 * @returns {{ values: unknown[], notes: string[] }}
 */
function readJson(text) {
  const attempt = (source) => {
    const state = { values: [], failures: [], others: [], cut: false, source };
    harvest(source, 0, source.length, false, state, 0);
    return state;
  };
  const holds = (state) => state.values.some((value) => { const found = []; collect(value, {}, found, 0, false); return found.length > 0; });
  let state = attempt(text);
  if (!holds(state) && /[\u201C\u201D]/.test(text)) {
    // Copied through a word processor: the quotes around names and texts have become curly.
    const straight = attempt(text.replace(/[\u201C\u201D]/g, '"'));
    if (holds(straight)) state = straight;
  }
  const describe = (failure) => {
    const { line, near } = whereIs(state.source, failure.at);
    return `Line ${line}: ${failure.reason}.${near ? ` It is at: ${near}` : ''}`;
  };
  if (!holds(state)) {
    // Nothing readable. Say what is wrong with the largest piece that was meant as JSON.
    const worst = state.failures[0] ?? [...state.others].sort((a, b) => b.size - a.size)[0];
    if (worst) throw new QuestionImportError(`This JSON cannot be read. ${describe(worst)}`);
    if (state.cut) throw new QuestionImportError('This JSON stops before its end: a bracket or a brace is not closed. It may have been cut off when it was copied.');
    if (state.values.length === 0) throw new QuestionImportError('No JSON was found. JSON starts with [ or {. To import a test paper written as text instead, number its questions: 1. 2. 3.');
  }
  const notes = [];
  if (state.failures.length > 0) notes.push(`The JSON has a mistake. ${describe(state.failures[0])} — What could be read around it was read piece by piece: check that no question is missing.`);
  if (state.cut) notes.push(CUT_OFF_NOTE);
  return { values: state.values, notes };
}

// ── Which objects are questions ──────────────────────────────────────────────

// The text of a question, under the names it goes by …
const TEXT_KEYS = ['question', 'questiontext', 'text', 'prompt', 'stem', 'statement', 'q', 'query', 'questionstem'];
// … and under names that say "question" only next to choices or an answer.
const LOOSE_TEXT_KEYS = ['title', 'name', 'body', 'content', 'problem', 'description'];
const HTML_KEYS = ['questionhtml', 'texthtml', 'html'];
const LIST_KEYS = ['questions', 'questionlist', 'quizquestions', 'problems', 'entries'];
const ANSWER_KEYS = ['answer', 'correctanswer', 'correctanswers', 'correct', 'answerkey', 'key', 'solution', 'correctoption', 'correctoptions', 'correctchoice', 'correctchoices', 'rightanswer', 'correctresponse', 'expectedanswer'];
const INDEX_KEYS = ['correctindex', 'answerindex', 'correctanswerindex', 'correctoptionindex', 'correctchoiceindex', 'correctindices', 'correctindexes', 'answerindices', 'answerindexes'];
const CHOICE_KEYS = ['choices', 'options', 'selections', 'choicelist', 'optionlist', 'answeroptions', 'answerchoices', 'possibleanswers'];
// The wrong choices of a question that gives its correct answer apart from them.
const WRONG_KEYS = ['incorrectanswers', 'wronganswers', 'distractors', 'incorrectoptions', 'wrongoptions', 'incorrectchoices', 'wrongchoices', 'incorrect', 'wrong', 'decoys'];
// Names under which a file keeps the answers apart from its questions …
const KEY_NAMES = ['answerkey', 'answerkeys', 'answers', 'key', 'keys', 'solutions', 'correctanswers', 'answersheet'];
// … and what a question, or a line of such a key, is numbered by.
const ID_NAMES = ['id', 'number', 'no', 'num', 'questionnumber', 'questionno', 'questionid', 'qid', 'itemnumber'];
// What belongs to one question. Never searched for more questions: a choice has a "text" too.
const INNER_KEYS = new Set([...CHOICE_KEYS, ...WRONG_KEYS, 'answers', 'alternatives', 'pairs', 'matches', 'matchpairs', 'pairings', 'blanks', 'accepted', 'settings', 'correction']);

/** Read the names of an object the way people write them. */
function reader(raw) {
  const map = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const name = norm(key);
    if (name && !map.has(name) && value !== null && value !== undefined) map.set(name, value);
  }
  return {
    /** The value under the first of these names that is there. */
    get: (...names) => { for (const name of names) if (map.has(name)) return map.get(name); return undefined; },
    has: (name) => map.has(name),
  };
}

const TYPE_NAMES = new Map(Object.entries({
  MULTIPLE_CHOICE: ['multiplechoice', 'multiple', 'mc', 'mcq', 'singlechoice', 'single', 'singleanswer', 'singleselect', 'singleresponse', 'choice', 'radio', 'select', 'multiplechoicesingleanswer', 'multiplechoicesingle'],
  MULTIPLE_RESPONSE: ['multipleresponse', 'multipleanswer', 'multipleanswers', 'multiselect', 'multipleselect', 'multiplecorrect', 'checkbox', 'checkboxes', 'selectall', 'selectallthatapply', 'multi', 'mr', 'mrq', 'msq', 'multiplechoicemultipleanswer', 'multiplechoicemultipleanswers', 'multiplechoicemultiple'],
  TRUE_FALSE: ['truefalse', 'trueorfalse', 'tf', 'boolean', 'bool', 'yesno'],
  MODIFIED_TRUE_FALSE: ['modifiedtruefalse', 'modifiedtrueorfalse', 'modifiedtf', 'mtf'],
  IDENTIFICATION: ['identification', 'identify', 'ident'],
  SHORT_ANSWER: ['shortanswer', 'short', 'shorttext', 'shortresponse', 'text', 'textinput', 'enumeration', 'enumerate'],
  FILL_BLANKS: ['fillblanks', 'fillblank', 'fillintheblank', 'fillintheblanks', 'fillin', 'fillins', 'blank', 'blanks', 'cloze', 'fib', 'fitb', 'completion', 'gapfill'],
  MATCHING: ['matching', 'match', 'pairs', 'pairing'],
  ORDERING: ['ordering', 'order', 'sequence', 'sequencing', 'arrange', 'arrangement', 'arranging', 'ranking', 'rank', 'sort', 'sorting', 'reorder', 'chronology'],
  ESSAY: ['essay', 'longanswer', 'long', 'longtext', 'longresponse', 'openended', 'open', 'paragraph', 'discussion', 'freeresponse', 'written', 'explain'],
  FILE_UPLOAD: ['fileupload', 'file', 'upload', 'attachment'],
  PROGRAMMING: ['programming', 'coding', 'code'],
}).flatMap(([type, names]) => names.map((name) => [name, type])));

const TYPE_HINTS = [
  [/multi.*(?:resp|answ|sel|corr)/, 'MULTIPLE_RESPONSE'], [/multiplechoice|choice/, 'MULTIPLE_CHOICE'], [/modif.*true/, 'MODIFIED_TRUE_FALSE'], [/true.*false|false.*true/, 'TRUE_FALSE'],
  [/ident/, 'IDENTIFICATION'], [/fill|blank|cloze|gap/, 'FILL_BLANKS'], [/match|pair/, 'MATCHING'], [/order|sequen|arrang|rank|sort/, 'ORDERING'],
  [/essay|long|open|discuss/, 'ESSAY'], [/short/, 'SHORT_ANSWER'], [/upload|file/, 'FILE_UPLOAD'], [/program|coding/, 'PROGRAMMING'],
];

/** "multiple_choice", "Multiple Choice", "MCQ", "True/False questions", "Matching type" → the type, or null. */
export function typeFromName(value) {
  if (typeof value !== 'string') return null;
  let name = norm(value);
  if (!name) return null;
  if (TYPE_NAMES.has(name)) return TYPE_NAMES.get(name);
  const bare = name.replace(/(?:questions?|items?|type|test)$/, '');
  if (bare && TYPE_NAMES.has(bare)) return TYPE_NAMES.get(bare);
  name = bare || name;
  return name.length >= 4 ? TYPE_HINTS.find(([pattern]) => pattern.test(name))?.[1] ?? null : null;
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';
/** The text of the question an object is, or undefined when it is not one. */
function questionText(r) {
  const sure = r.get(...TEXT_KEYS);
  if (filled(sure)) return sure;
  const loose = r.get(...LOOSE_TEXT_KEYS);
  return filled(loose) && r.get(...CHOICE_KEYS, ...ANSWER_KEYS, ...INDEX_KEYS) !== undefined ? loose : undefined;
}
const hasText = (node) => { const r = reader(node); return filled(r.get(...HTML_KEYS)) || questionText(r) !== undefined; };
/** A list of questions under a name of its own choosing: this object wraps them. */
const holdsQuestions = (node) => Object.entries(node).some(([key, value]) => !INNER_KEYS.has(norm(key)) && Array.isArray(value) && value.some((item) => isObject(item) && hasText(item)));

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
};
/** 2, "2", "2 points", "2 pts" */
const toPoints = (value) => toNumber(typeof value === 'string' ? value.replace(/\s*(?:points?|pts?|marks?)\s*$/i, '') : value);

/**
 * Walk what was parsed and gather the questions, whatever they are wrapped in: a plain list,
 * { "questions": [...] }, sections with their own type and points, lists named after a type.
 */
function collect(node, defaults, out, depth, inList, keys = null) {
  if (depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, defaults, out, depth + 1, true, keys);
    return;
  }
  if (!isObject(node)) return;
  const r = reader(node);
  const type = typeFromName(r.get('type', 'questiontype', 'kind'));
  const listKey = LIST_KEYS.find((key) => r.has(key) && typeof r.get(key) === 'object');
  // A matching or an ordering question has a list of its own that may look like questions.
  if (!listKey && hasText(node) && (type === 'MATCHING' || type === 'ORDERING' || !holdsQuestions(node))) {
    out.push({ raw: node, defaults });
    return;
  }
  // A wrapper. What it says about its questions holds for each of them.
  const next = { ...defaults };
  if (type) next.type = type;
  // Only a name that says "each": "points" on a wrapper is as often the total of the quiz.
  const points = toPoints(r.get('pointseach', 'pointsperquestion', 'pointsperitem', 'markseach', 'marksperquestion'));
  if (points !== null && points > 0) next.points = points;
  // A file downloaded from Discenda is read back exactly as it was written.
  if (isQuestionExportFormat(r.get('format'))) next.exact = true;
  // One of several parts, with a heading of its own.
  const heading = r.get('section', 'part', 'heading') ?? (inList ? r.get('title', 'name') : undefined);
  if (filled(heading)) next.section = heading.trim();
  // The answers may stand apart from the questions: { "questions": [...], "answer_key": {...} }
  const keyName = next.exact ? undefined : KEY_NAMES.find((key) => r.has(key) && typeof r.get(key) === 'object');
  const start = out.length;
  if (listKey) {
    collect(r.get(listKey), next, out, depth + 1, false, keys);
  } else {
    for (const [key, value] of Object.entries(node)) {
      if (value === null || typeof value !== 'object' || INNER_KEYS.has(norm(key)) || norm(key) === keyName) continue;
      // A list named after a type: { "true_false": [...], "essay": [...] }
      const named = typeFromName(key);
      collect(value, named ? { ...next, type: named } : next, out, depth + 1, false, keys);
    }
    // Nothing else holds questions, so this is no key to them: it may be the list itself.
    if (keyName && out.length === start && !INNER_KEYS.has(keyName)) collect(r.get(keyName), next, out, depth + 1, false, keys);
  }
  if (keyName && out.length > start) keys?.push({ entries: out.slice(start), value: r.get(keyName) });
}

/** What a question, or a line of an answer key, goes by: "#3" for 3, "Q3", "3." or "question 3". */
function idForms(value) {
  if (!scalar(value) || typeof value === 'boolean') return [];
  const name = String(value).trim().toLowerCase();
  if (!name) return [];
  const numbered = /^(?:q(?:uestion)?|item|no|number|#)?[\s._#:-]*(\d{1,4})[.):]?$/.exec(name);
  return [numbered ? `#${Number(numbered[1])}` : name];
}

const isNumber = (form) => /^#\d+$/.test(form);

/**
 * The lines of an answer key, in their order: [{ ids, answer }]. `ids` is empty where a line
 * only has its place; `answer` is undefined where a line is empty (its place still counts).
 */
function keyLines(value) {
  const answerOf = (item) => {
    const answer = isObject(item) ? reader(item).get(...ANSWER_KEYS, 'value', 'a', 'ans') : item;
    return answer === null || answer === '' ? undefined : answer;
  };
  if (Array.isArray(value)) {
    return value.map((item) => ({ ids: isObject(item) ? [...ID_NAMES, 'question', 'q', 'item'].flatMap((name) => idForms(reader(item).get(name))) : [], answer: answerOf(item) }));
  }
  return Object.entries(value).map(([name, item]) => ({ ids: idForms(name), answer: answerOf(item) }));
}

/**
 * Give the questions of one list the answers of a key that stands apart from them. An answer
 * goes to the question that has its number, its name or its text; where the questions have
 * none of those, by their order. A question that has an answer of its own keeps it.
 *
 * Nothing is taken from a key that does not show whose its answers are: a wrong answer in the
 * key of a quiz is worse than a missing one, which the teacher is asked to fill in.
 *
 * @returns {string | null} a note when the key could not be used
 */
function applyAnswerKey(entries, value) {
  const places = keyLines(value);
  const lines = places.filter((line) => line.answer !== undefined);
  if (lines.length === 0) return null;
  const apart = 'The file keeps its answers apart from the questions';
  const unclear = 'They were not used: it is not clear which answer belongs to which question.';
  const repeated = (lists) => {
    const count = new Map();
    for (const forms of lists) for (const form of new Set(forms)) count.set(form, (count.get(form) ?? 0) + 1);
    return (form) => count.get(form) > 1;
  };
  const own = entries.map((entry) => {
    const r = reader(entry.raw);
    const text = questionText(r);
    return [...ID_NAMES.flatMap((name) => idForms(r.get(name))), ...(typeof text === 'string' ? [text.trim().toLowerCase()] : [])];
  });
  const twiceInKey = repeated(lines.map((line) => line.ids));
  const twiceAsked = repeated(own);
  // Numbers that start again, in every part of a test say, tell neither the answers apart nor
  // the questions: not even the ones that happen to occur once.
  const keyRestarts = lines.some((line) => line.ids.some((form) => isNumber(form) && twiceInKey(form)));
  const questionsRestart = own.some((forms) => forms.some((form) => isNumber(form) && twiceAsked(form)));
  const tells = (form) => !isNumber(form) || (!keyRestarts && !questionsRestart);
  const byForm = new Map();
  for (const line of lines) for (const form of line.ids) if (tells(form) && !twiceInKey(form)) byForm.set(form, line);
  let hits = own.map((forms) => forms.filter((form) => tells(form) && !twiceAsked(form)).map((form) => byForm.get(form)).find(Boolean) ?? null);
  let by = 'number';
  if (hits.some(Boolean)) {
    // Answers without a question and questions without an answer, both at once: the key may
    // count in another way than the questions do (from 0, or by their place), and the numbers
    // that do agree would then agree by chance.
    const asked = new Set(own.flat().filter(isNumber));
    const strayLine = lines.some((line) => line.ids.some(isNumber) && !line.ids.some((form) => asked.has(form)));
    const strayQuestion = own.some((forms) => forms.some(isNumber) && !forms.some((form) => byForm.has(form)));
    if (tells('#1') && strayLine && strayQuestion) return `${apart}, under numbers that only partly agree with the numbers of the questions. ${unclear}`;
  } else {
    by = 'order';
    if (places.every((line) => line.ids.length === 0)) {
      // A plain list of answers: one place for each question, or it is not clear whose they are.
      if (places.length !== entries.length) return `${apart}, and has ${places.length} of them for ${entries.length} questions. ${unclear}`;
      hits = places.map((line) => (line.answer === undefined ? null : line));
    } else if (lines.every((line) => line.ids.some(isNumber))) {
      // Numbered, where the questions are not (or not in one count): the number is the place
      // of the question.
      if (keyRestarts) return `${apart}, and gives the same number to several of them. ${unclear}`;
      const numbered = new Map(lines.flatMap((line) => line.ids.filter(isNumber).map((form) => [form, line])));
      const base = numbered.has('#0') ? 0 : 1;
      const last = Math.max(...[...numbered.keys()].map((form) => Number(form.slice(1))));
      if (last - base >= entries.length) return `${apart}, numbered up to ${last}, and there are ${entries.length} questions. ${unclear}`;
      hits = entries.map((_, i) => numbered.get(`#${i + base}`) ?? null);
    } else {
      return `${apart}, under names that none of the questions has. They were not used.`;
    }
  }
  entries.forEach((entry, i) => {
    if (hits[i] && entry.keyed === undefined) Object.assign(entry, { keyed: hits[i].answer, keyedBy: by });
  });
  return null;
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** Written by a rich-text editor (or downloaded from Discenda), not typed as plain text. */
const isMarkup = (s) => /^\s*<(p|div|h[1-6]|ul|ol|pre|blockquote|table)[\s>][\s\S]*<\/(p|div|h[1-6]|ul|ol|pre|blockquote|table)>\s*$/i.test(s);

const inline = (line) => escapeHtml(line).replace(/`([^`]+)`/g, '<code>$1</code>');
// Indentation is part of a program: kept, where a paragraph would swallow it.
const indent = (line) => line.replace(/^[ \t]{2,}/, (space) => '\u00A0'.repeat(space.replace(/\t/g, '    ').length));
const prose = (text) => text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).map((line) => `<p>${inline(indent(line))}</p>`).join('');

/**
 * Plain text as the HTML the app stores: a paragraph for each line, and code kept as code —
 * `like this` inside a line, or a block between lines of ``` (the way chat assistants write it).
 * Everything else is taken literally: "<br>" in a question about HTML stays "<br>".
 */
export function textToHtml(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').replace(/```([^`\n]+)```/g, '`$1`');
  const fence = /(^|\n)[ \t]*(```|~~~)[ \t]*([A-Za-z0-9+#-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  const parts = [];
  let at = 0;
  for (const m of source.matchAll(fence)) {
    parts.push(prose(source.slice(at, m.index)));
    // A block that is never closed runs to the end; one that is empty holds only its own closing line.
    const code = m[4].replace(/(?:^|\n)[ \t]*(?:```|~~~)[ \t]*$/, '').replace(/\s+$/, '');
    if (code.trim()) parts.push(`<pre><code${m[3] ? ` class="language-${m[3].toLowerCase()}"` : ''}>${escapeHtml(code)}</code></pre>`);
    at = m.index + m[0].length;
  }
  parts.push(prose(source.slice(at)));
  return parts.join('');
}

const decode = (s) => s.replace(/&nbsp;|\u00A0/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Stored HTML back as plain text, when it is nothing more than paragraphs and code — or null
 * when it has formatting that plain text cannot carry. Only text that `textToHtml` turns into
 * the very same HTML is returned.
 */
export function htmlToText(html) {
  const source = String(html ?? '').trim();
  const block = /\s*(?:<p>([\s\S]*?)<\/p>|<pre><code(?: class="language-([A-Za-z0-9+#-]+)")?>([\s\S]*?)<\/code><\/pre>)/y;
  const lines = [];
  let at = 0;
  for (let m = block.exec(source); m !== null; m = block.exec(source)) {
    at = block.lastIndex;
    if (m[1] !== undefined) {
      const inner = m[1];
      if (/<(?!\/?code>)/.test(inner) || /`/.test(inner)) return null;
      lines.push(decode(inner.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')));
    } else {
      if (/</.test(m[3])) return null;
      lines.push(`\`\`\`${m[2] ?? ''}\n${decode(m[3])}\n\`\`\``);
    }
  }
  if (at !== source.length || lines.length === 0) return null;
  const text = lines.join('\n');
  return !isMarkup(text) && sanitizeRichText(textToHtml(text)) === source ? text : null;
}

// ── One question ─────────────────────────────────────────────────────────────

const CHOICE_TEXT = ['text', 'option', 'choice', 'value', 'content', 'answer', 'answertext', 'optiontext', 'choicetext', 'title', 'description', 'name', 'label'];
const CHOICE_FLAG = ['iscorrect', 'correct', 'isanswer', 'iscorrectanswer', 'right', 'isright', 'answer'];
const DIFFICULTIES = {
  easy: 'EASY', e: 'EASY', beginner: 'EASY', basic: 'EASY', simple: 'EASY', low: 'EASY', 1: 'EASY',
  medium: 'MEDIUM', m: 'MEDIUM', average: 'MEDIUM', moderate: 'MEDIUM', intermediate: 'MEDIUM', normal: 'MEDIUM', 2: 'MEDIUM',
  hard: 'HARD', h: 'HARD', difficult: 'HARD', advanced: 'HARD', high: 'HARD', challenging: 'HARD', 3: 'HARD',
};

const scalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** The texts in a value: one text, a list of them, or objects that carry one. */
function strings(value) {
  const out = [];
  const add = (v) => {
    if (scalar(v)) {
      const s = String(v).trim();
      if (s) out.push(s);
    } else if (Array.isArray(v)) {
      v.forEach(add);
    } else if (isObject(v)) {
      const r = reader(v);
      add(r.get('text', 'answer', 'value', 'answers', 'accepted'));
      add(r.get('alternatives', 'alternateanswers', 'aliases', 'variants'));
    }
  };
  add(value);
  return out;
}
const unique = (list) => list.filter((item, i) => list.findIndex((other) => normalizeAnswer(other) === normalizeAnswer(item)) === i);

const TRUE_WORD = /^(?:true|t|yes|y|tama|correct|right|1)$/i;
const FALSE_WORD = /^(?:false|f|no|n|mali|incorrect|wrong|0)$/i;
/** true, false, or null when the value says neither. `loose`: also "T", "yes", 1 — for a question known to be true-or-false. */
function toBool(value, loose = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return loose && (value === 1 || value === 0) ? value === 1 : null;
  if (typeof value !== 'string') return null;
  const word = value.trim().replace(/[.!]+$/, '');
  if (/^true$/i.test(word)) return true;
  if (/^false$/i.test(word)) return false;
  if (!loose) return null;
  if (TRUE_WORD.test(word)) return true;
  if (FALSE_WORD.test(word)) return false;
  // "False. A byte has eight bits."
  const lead = /^(true|false)\b/i.exec(word);
  return lead ? lead[1].toLowerCase() === 'true' : null;
}

// "B", "b)", "(B)", "Option B", "choice 2"
const LABEL = /^(?:(?:option|choice|answer|letter|item)[\s_:-]*)?\(?([A-Za-z]|\d{1,3})\)?[.):]?$/i;
const PREFIX = /^\s*\(?([A-Za-z]|\d{1,2})\s*[.):]\s+(\S[\s\S]*)$/;
const PREFIX_PAREN = /^\s*\(([A-Za-z]|\d{1,2})\)\s*(\S[\s\S]*)$/;

const text1 = (value) => (scalar(value) && typeof value !== 'boolean' ? String(value).trim() : '');

/**
 * Choices that each stand under a name of their own, the way a spreadsheet has them in columns:
 * "option_a", "option_b" …, "A", "B" …, "choice1", "choice2" ….
 */
function namedChoices(r) {
  const run = (prefix, labels) => {
    const list = [];
    for (const label of labels) {
      const text = text1(r.get(`${prefix}${label}`));
      if (!text) break;
      list.push({ text, label: label.toUpperCase(), flag: false });
    }
    return list.length >= 2 ? list : null;
  };
  for (const prefix of ['option', 'choice', 'opt', 'answer', '']) {
    const list = run(prefix, [...'abcdefgh']);
    if (list) return list;
  }
  for (const prefix of ['option', 'choice', 'opt']) {
    const list = run(prefix, ['1', '2', '3', '4', '5', '6', '7', '8']);
    if (list) return list;
  }
  return null;
}

/** A choice that belongs at the end whatever the order of the others: "All of the above". */
const CLOSING_CHOICE = /^(?:all|none|both|neither|any)\b.*\b(?:above|these|those|them|choices|options|answers)\b/i;

/**
 * The choices of a question that names its correct answer and lists the wrong ones apart from
 * it ("correct_answer" and "incorrect_answers"). They are put in alphabetical order: with the
 * correct one always first, students would soon know where to look.
 */
function mixedChoices(r) {
  const wrong = r.get(...WRONG_KEYS);
  const right = r.get(...ANSWER_KEYS);
  if (!Array.isArray(wrong) || right === undefined || !listOf(right).every(scalar)) return null;
  const rights = unique(strings(right));
  const wrongs = unique(strings(wrong)).filter((w) => !rights.some((x) => same(x, w)));
  if (rights.length === 0 || wrongs.length === 0) return null;
  const list = [...rights.map((text) => ({ text, label: null, flag: true })), ...wrongs.map((text) => ({ text, label: null, flag: false }))];
  list.sort((x, y) => (CLOSING_CHOICE.test(x.text) - CLOSING_CHOICE.test(y.text)) || x.text.localeCompare(y.text, 'en', { numeric: true, sensitivity: 'base' }));
  list.mixed = true;
  return list;
}

/**
 * The choices of a question: [{ text, label, flag }], or null when it has none.
 * @param {boolean} answered the answer of the question is given in a key apart from it
 */
function readChoices(r, exact, answered = false) {
  let source = r.get(...CHOICE_KEYS);
  // "answers" holds the choices when the answer itself is given elsewhere, or marked on them.
  const answers = r.get('answers');
  if (source === undefined && Array.isArray(answers) && answers.length >= 2) {
    const flagged = answers.some((a) => isObject(a) && CHOICE_FLAG.some((flag) => typeof reader(a).get(flag) === 'boolean'));
    if (flagged || answered || r.get('answer', 'correctanswer', 'correct', ...INDEX_KEYS) !== undefined) source = answers;
  }
  if (source === undefined) return exact ? null : namedChoices(r) ?? mixedChoices(r);
  const list = [];
  const one = (item, label) => {
    if (scalar(item)) {
      list.push({ text: String(item).trim(), label: label ?? null, flag: false });
    } else if (isObject(item)) {
      const c = reader(item);
      const textKey = CHOICE_TEXT.find((key) => scalar(c.get(key)) && typeof c.get(key) !== 'boolean');
      const own = ['id', 'key', 'letter', 'label'].filter((key) => key !== textKey).map((key) => c.get(key)).find((v) => scalar(v) && String(v).trim().length <= 3);
      const flag = CHOICE_FLAG.map((key) => c.get(key)).find((v) => typeof v === 'boolean');
      list.push({ text: textKey ? String(c.get(textKey)).trim() : '', label: label ?? (own !== undefined ? String(own).trim() : null), flag: flag === true });
    }
  };
  if (Array.isArray(source)) source.forEach((item) => one(item, null));
  else if (isObject(source)) for (const [key, item] of Object.entries(source)) one(item, key.trim());
  else return null;
  // "A. RAM", "B. CPU": the letters are numbering, not part of the choice.
  if (!exact && list.length >= 2) {
    const parts = list.map((c) => PREFIX.exec(c.text) ?? PREFIX_PAREN.exec(c.text));
    if (parts.every(Boolean)) {
      const labels = parts.map((m) => m[1].toLowerCase());
      const inOrder = labels.every((l, i) => l === String.fromCharCode(97 + i)) || labels.every((l, i) => l === String(i + 1));
      if (inOrder) list.forEach((c, i) => { c.text = parts[i][2].trim(); c.label ??= parts[i][1]; });
    }
  }
  return list.filter((c) => c.text);
}

const isTrueFalsePair = (list) => list.length === 2 && toBool(list[0].text) !== null && toBool(list[1].text) !== null && toBool(list[0].text) !== toBool(list[1].text);

/** A whole number given as an answer: the position of a choice, counted from 0 or from 1. */
function byNumber(n, list, ctx, warn, namedIndex) {
  if (!Number.isInteger(n)) return null;
  ctx.numbers?.push({ n, count: list.length });
  const index = n - (ctx.base ?? 0);
  if (index < 0 || index >= list.length) return null;
  if (ctx.base === null && !namedIndex) {
    warn(`The answer was given as the number ${n}. It was read as the ${ordinal(index + 1)} choice, “${clip(list[index].text)}”, counting from 0. Check that this is the one.`);
  }
  return index;
}

function byLabel(label, list, ctx, warn) {
  const lower = label.toLowerCase();
  const own = list.findIndex((c) => c.label !== null && c.label.toLowerCase() === lower);
  if (own >= 0) return own;
  if (/^[a-z]$/.test(lower)) {
    // The file lettered its choices itself and this is not one of its letters.
    if (list.some((c) => c.label !== null && /^[a-z]$/i.test(c.label))) return null;
    const index = lower.charCodeAt(0) - 97;
    return index < list.length ? index : null;
  }
  // The file numbered its choices itself and this is not one of its numbers.
  if (!/^\d+$/.test(lower) || list.some((c) => c.label !== null && /^\d+$/.test(c.label))) return null;
  return byNumber(Number(lower), list, ctx, warn, false);
}

/** Which choices one given answer means: its text, its letter, its number, or several of those. */
function resolveToken(token, list, ctx, warn) {
  if (typeof token === 'boolean') {
    const index = list.findIndex((c) => toBool(c.text, true) === token);
    return index >= 0 ? [index] : [];
  }
  if (isObject(token)) {
    const t = reader(token);
    const index = toNumber(t.get('index'));
    if (index !== null) { const hit = byNumber(index, list, ctx, warn, true); return hit === null ? [] : [hit]; }
    const inner = t.get('text', 'answer', 'value', 'option', 'choice', 'label', 'letter', 'id', 'key');
    return scalar(inner) ? resolveToken(inner, list, ctx, warn) : [];
  }
  if (!scalar(token)) return [];
  const s = String(token).trim();
  if (!s) return [];
  // 1. The text of a choice, word for word.
  const byText = list.findIndex((c) => same(c.text, s));
  if (byText >= 0) return [byText];
  // 2. Its letter or number.
  const label = LABEL.exec(s);
  if (label) { const hit = byLabel(label[1], list, ctx, warn); return hit === null ? [] : [hit]; }
  // 3. Letter and text together: "B. CPU".
  const both = PREFIX.exec(s) ?? PREFIX_PAREN.exec(s);
  if (both) {
    const text = list.findIndex((c) => same(c.text, both[2]));
    if (text >= 0) return [text];
    const hit = byLabel(both[1], list, ctx, warn);
    if (hit !== null) return [hit];
  }
  // 4. Several at once: "A, C", "A and C".
  const parts = s.split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => LABEL.test(p))) {
    const hits = parts.map((p) => byLabel(LABEL.exec(p)[1], list, ctx, warn));
    if (hits.every((h) => h !== null)) return hits;
  }
  return [];
}

const listOf = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const show = (token) => clip(scalar(token) ? token : JSON.stringify(token), 40);

/** The choices that the answer of the file names. `missing`: answers that fit no choice. */
function resolveAnswers(list, answer, indexAnswer, ctx, warn) {
  const indexes = [];
  const missing = [];
  const add = (index) => { if (!indexes.includes(index)) indexes.push(index); };
  for (const token of listOf(indexAnswer)) {
    const hit = toNumber(token) === null ? null : byNumber(toNumber(token), list, ctx, warn, true);
    if (hit === null) missing.push(show(token));
    else add(hit);
  }
  for (const token of listOf(answer)) {
    const hits = resolveToken(token, list, ctx, warn);
    if (hits.length === 0) missing.push(show(token));
    else hits.forEach(add);
  }
  return { indexes, missing, given: answer !== undefined || indexAnswer !== undefined };
}

const PAIR_LEFT = ['left', 'term', 'item', 'premise', 'prompt', 'key', 'question', 'a', 'columna', 'from', 'source', 'name', 'word', 'concept', 'stem'];
const PAIR_RIGHT = ['right', 'definition', 'match', 'answer', 'response', 'value', 'b', 'columnb', 'to', 'target', 'description', 'meaning'];

/** One pair from [left, right] or { left, right } (under several names). */
function pairOf(item) {
  if (Array.isArray(item) && item.length >= 2 && scalar(item[0]) && scalar(item[1])) return { left: String(item[0]).trim(), right: String(item[1]).trim() };
  if (!isObject(item)) return null;
  const p = reader(item);
  const left = PAIR_LEFT.map((key) => p.get(key)).find(scalar);
  const right = PAIR_RIGHT.map((key) => p.get(key)).find(scalar);
  return left !== undefined && right !== undefined ? { left: String(left).trim(), right: String(right).trim() } : null;
}

/** An entry of a column named by its text, its letter or its number. */
function inColumn(column, token, zeroBased) {
  const s = String(token).trim();
  const text = column.find((entry) => same(entry, s));
  if (text !== undefined) return text;
  const label = LABEL.exec(s);
  if (!label || column.length === 0) return s;
  const index = /\d/.test(label[1]) ? Number(label[1]) - (zeroBased ? 0 : 1) : label[1].toLowerCase().charCodeAt(0) - 97;
  return column[index] ?? s;
}

/** The pairs of a matching question, or null when the question gives none. `explicit`: it said it is a matching question. */
function readPairs(r, answer, explicit, warn) {
  const left = strings(r.get('left', 'lefts', 'leftitems', 'leftcolumn', 'columna', 'cola', 'lista', 'premises', 'terms', 'prompts'));
  const right = strings(r.get('right', 'rights', 'rightitems', 'rightcolumn', 'columnb', 'colb', 'listb', 'responses', 'definitions', 'matchoptions'));
  const columns = left.length > 0 && right.length > 0;
  let source = r.get('pairs', 'matches', 'matchpairs', 'pairings', 'correctmatches', 'correctpairs', 'matching');
  if (source === undefined && (explicit || columns)) source = answer ?? r.get('answers');
  if (source === undefined && explicit && Array.isArray(r.get('items')) && r.get('items').some((item) => pairOf(item))) source = r.get('items');
  if (Array.isArray(source) && source.length > 0) {
    const pairs = source.map(pairOf);
    if (pairs.every(Boolean)) return pairs;
    // One entry for each item on the left: which one on the right belongs to it.
    if (columns && source.length === left.length && source.every(scalar)) {
      const zero = source.some((token) => String(token).trim() === '0');
      return left.map((entry, i) => ({ left: entry, right: inColumn(right, source[i], zero) }));
    }
    return null;
  }
  if (isObject(source)) {
    const entries = Object.entries(source).filter(([, value]) => scalar(value));
    if (entries.length === 0) return null;
    const zero = entries.some(([key, value]) => key.trim() === '0' || String(value).trim() === '0');
    return entries.map(([key, value]) => ({ left: inColumn(left, key, zero), right: inColumn(right, value, zero) }));
  }
  if (columns && left.length === right.length) {
    warn('The two columns were paired in the order they were given. Check each pair.');
    return left.map((entry, i) => ({ left: entry, right: right[i] }));
  }
  return null;
}

/** The items of an ordering question in their correct order. */
function readOrder(r, warn) {
  const given = strings(r.get('items', 'steps', 'elements', 'events', 'list', ...CHOICE_KEYS, 'sequence'));
  const key = r.get('correctorder', 'correctsequence', 'orderedanswer', 'correctanswer', 'answer', 'answers', 'order', 'solution');
  const tokens = Array.isArray(key) ? key.filter(scalar) : typeof key === 'string' && given.length > 0 ? key.split(/\s*(?:,|;|>|→|->)\s*/).filter(Boolean) : [];
  if (tokens.length === 0) return given;
  if (given.length === 0) return tokens.map((t) => String(t).trim());
  const texts = tokens.map((t) => given.find((entry) => same(entry, t)));
  if (texts.every((t) => t !== undefined)) return texts;
  // The order as positions in the list that was given: letters, or numbers from 0 or from 1.
  const labels = tokens.map((t) => LABEL.exec(String(t).trim())?.[1] ?? null);
  if (labels.every(Boolean) && labels.length === given.length) {
    const numbers = labels.every((l) => /\d/.test(l));
    const zero = numbers && labels.includes('0');
    const places = labels.map((l) => (numbers ? Number(l) - (zero ? 0 : 1) : l.toLowerCase().charCodeAt(0) - 97));
    if (new Set(places).size === places.length && places.every((p) => p >= 0 && p < given.length)) return places.map((p) => given[p]);
  }
  warn('The order given as the answer does not fit the items. The items were kept in the order they are listed: check it.');
  return given;
}

// "[blank]", "{{blank}}", "(____)", two underscores: other ways of writing a blank.
const BLANK_MARKS = /\[\s*(?:blank|_+)\s*\]|\{\{?\s*(?:blank|_+)\s*\}\}?|\(\s*(?:blank|_+)\s*\)|<\s*blank\s*>|(?<![_\w])__(?![_\w])/gi;

const wordy = (answer) => answer.split(/\s+/).length > 6;

/**
 * One object of the file as a question in editor shape.
 * @returns {{ question: object, warnings: string[] }}
 */
function readQuestion({ raw, defaults, keyed }, ctx) {
  const r = reader(raw);
  const warnings = [];
  const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };
  const exact = defaults.exact === true;

  const named = r.get('type', 'questiontype', 'kind');
  const explicit = typeFromName(named) ?? defaults.type ?? null;
  let type = explicit;
  if (typeof named === 'string' && named.trim() && !typeFromName(named)) warn(`“${clip(named, 30)}” is not a type of question Discenda has. The type was worked out from the rest of the question.`);

  // ── The question itself ──
  const htmlGiven = r.get(...HTML_KEYS);
  const textGiven = questionText(r);
  const markup = filled(htmlGiven) ? htmlGiven : textGiven !== undefined && isMarkup(textGiven) ? textGiven : null;
  let plain = markup === null ? String(textGiven ?? '') : '';
  if (markup === null && !exact) {
    const passage = r.get('passage', 'context', 'scenario', 'reading');
    if (typeof passage === 'string' && passage.trim()) plain = `${passage.trim()}\n${plain}`;
    const code = r.get('code', 'codesnippet', 'snippet', 'codeblock');
    if (typeof code === 'string' && code.trim() && explicit !== 'PROGRAMMING' && !plain.includes(code.trim())) {
      const language = r.get('language', 'lang', 'codelanguage');
      plain = `${plain}\n\`\`\`${typeof language === 'string' && /^[A-Za-z0-9+#-]{1,20}$/.test(language.trim()) ? language.trim() : ''}\n${code.replace(/\s+$/, '')}\n\`\`\``;
    }
  }
  if (r.get('image', 'imageurl', 'img', 'picture', 'figure', 'diagram') !== undefined) warn('The picture of this question was not imported. Add it in the editor.');

  // { "q": …, "a": … }: "a" is the answer, unless "a", "b", … are the choices.
  const ownAnswer = r.get(...ANSWER_KEYS, ...(exact || r.has('b') ? [] : ['a']), 'ans');
  const indexAnswer = r.get(...INDEX_KEYS);
  // An answer of its own comes before the one an answer key has for it.
  const fromKey = ownAnswer === undefined && indexAnswer === undefined && keyed !== undefined;
  const answer = fromKey ? keyed : ownAnswer;
  const choiceList = readChoices(r, exact, fromKey);
  if ((explicit === 'FILL_BLANKS' || (explicit === null && !choiceList)) && markup === null && !exact && countBlanks(plain) === 0) {
    const marked = plain.replace(BLANK_MARKS, '___');
    if (explicit === 'FILL_BLANKS' || (marked !== plain && (answer !== undefined || r.has('blanks')))) plain = marked;
  }
  const text = sanitizeRichText(markup ?? textToHtml(plain));

  // ── What kind of question, when the file does not say ──
  const pairs = (explicit === null || explicit === 'MATCHING') ? readPairs(r, answer, explicit === 'MATCHING', warn) : null;
  if (type === null) {
    if (r.has('correctorder') || r.has('correctsequence')) type = 'ORDERING';
    else if (pairs) type = 'MATCHING';
    else if (choiceList && choiceList.length >= 2) type = isTrueFalsePair(choiceList) ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE';
    else if (Array.isArray(r.get('items', 'steps')) && strings(r.get('items', 'steps')).length >= 2) type = 'ORDERING';
    else if (toBool(answer) !== null) type = 'TRUE_FALSE';
    else if (countBlanks(text) > 0 && (answer !== undefined || r.has('blanks'))) type = 'FILL_BLANKS';
    else if (typeof answer === 'string' && /^[tf]$/i.test(answer.trim())) {
      // "T" could be an answer to type. It is far more often short for "true": read so, and said.
      type = 'TRUE_FALSE';
      warn(`The answer “${answer.trim()}” was read as “${/^t$/i.test(answer.trim()) ? 'true' : 'false'}”, which makes this a true-or-false question. Check that it is one.`);
    }
    else if (strings(answer ?? r.get('answers', 'accepted', 'acceptedanswers')).length > 0) type = strings(answer ?? r.get('answers', 'accepted', 'acceptedanswers')).some(wordy) ? 'SHORT_ANSWER' : 'IDENTIFICATION';
    else {
      type = 'ESSAY';
      warn('No choices and no answer were found, so this was read as an essay question.');
    }
  }

  // ── Its answer ──
  const fields = {};
  let explanation = strings(r.get('explanation', 'rationale', 'feedback', 'reason', 'why', 'justification', 'answerexplanation', 'solutionexplanation')).join('\n');
  switch (type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE': {
      const list = choiceList ?? [];
      const flagged = list.map((c, i) => (c.flag ? i : -1)).filter((i) => i >= 0);
      const keyed = resolveAnswers(list, answer, indexAnswer, ctx, warn);
      const correct = flagged.length > 0 ? flagged : keyed.indexes;
      if (flagged.length > 0 && keyed.given && (keyed.missing.length > 0 || keyed.indexes.length !== flagged.length || keyed.indexes.some((i) => !flagged.includes(i)))) {
        warn('The choices marked as correct and the answer that is given do not agree. The marks on the choices were used: check them.');
      } else if (flagged.length === 0) {
        for (const token of keyed.missing) warn(`The answer “${token}” does not match any choice. Mark the correct choice.`);
        if (!keyed.given && list.length > 0) warn('No answer was found. Mark the correct choice.');
      }
      if (type === 'MULTIPLE_CHOICE' && correct.length > 1) {
        type = 'MULTIPLE_RESPONSE';
        if (explicit === 'MULTIPLE_CHOICE') warn(`${correct.length} choices are correct, so this was read as “multiple response”.`);
      }
      fields.choices = list.map((c, i) => ({ text: c.text, isCorrect: correct.includes(i) }));
      break;
    }
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE': {
      let value = Array.isArray(answer) ? null : toBool(answer, true);
      let correction = unique(strings(r.get('correction', 'corrections', 'correctword', 'correctedword', 'correctterm', 'correctedterm', 'replacement')));
      // "False - mitochondria": the answer and the word that makes the statement true, in one.
      const joined = type === 'MODIFIED_TRUE_FALSE' && typeof answer === 'string' ? /^(?:false|f|mali)\s*[-–—:;,]\s*(.+)$/i.exec(answer.trim()) : null;
      if (joined) {
        value = false;
        if (correction.length === 0) correction = [joined[1].trim()];
      }
      if (value === null && choiceList) {
        // True and False listed as choices, the answer marked on them or named by its letter.
        const flagged = choiceList.filter((c) => c.flag);
        const keyed = flagged.length === 1 ? [choiceList.indexOf(flagged[0])] : resolveAnswers(choiceList, answer, indexAnswer, ctx, warn).indexes;
        if (keyed.length === 1) value = toBool(choiceList[keyed[0]].text, true);
      }
      if (value === null) warn(answer === undefined ? 'No answer was found. Choose true or false.' : `The answer “${show(answer)}” is neither true nor false. Choose true or false.`);
      else fields.answer = value;
      if (type === 'MODIFIED_TRUE_FALSE') fields.correction = correction;
      break;
    }
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER': {
      fields.accepted = unique([
        ...strings(r.get('accepted', 'acceptedanswers', 'acceptableanswers', 'accept')), ...strings(answer ?? r.get('answers')),
        ...strings(r.get('alternatives', 'alternateanswers', 'alternativeanswers', 'aliases', 'synonyms', 'variants', 'alsoaccept')),
      ]);
      if (fields.accepted.length === 0 && type === 'IDENTIFICATION') warn('No answer was found. Add the accepted answer.');
      break;
    }
    case 'FILL_BLANKS': {
      const count = countBlanks(text);
      const source = r.get('blanks', 'blankanswers') ?? answer ?? r.get('answers', 'accepted', 'acceptedanswers');
      if (Array.isArray(source)) {
        // One blank and a list of texts: the ways of writing its one answer.
        fields.blanks = count === 1 && source.length !== 1 && source.every(scalar) ? [unique(strings(source))] : source.map((entry) => unique(strings(entry)));
      } else if (isObject(source)) {
        fields.blanks = Object.keys(source).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((key) => unique(strings(source[key])));
      } else if (source !== undefined) {
        const parts = String(source).split(/\s*[;,]\s*/).filter(Boolean);
        if (count > 1 && parts.length === count) {
          fields.blanks = parts.map((part) => [part]);
          warn('One answer was given for several blanks. It was split at the commas, one part for each blank: check each blank.');
        } else {
          fields.blanks = [[String(source).trim()]];
        }
      } else {
        fields.blanks = [];
        warn('No answer was found for the blanks.');
      }
      break;
    }
    case 'MATCHING':
      fields.pairs = pairs ?? [];
      break;
    case 'ORDERING':
      fields.items = readOrder(r, warn);
      break;
    case 'PROGRAMMING': {
      const id = r.get('programmingproblemid', 'problemid');
      if (typeof id === 'string') fields.programmingProblemId = id;
      break;
    }
    default: { // ESSAY, FILE_UPLOAD: read by the teacher
      const model = strings(r.get('modelanswer', 'sampleanswer', 'expectedanswer', ...ANSWER_KEYS, 'answers')).join('\n');
      const guide = strings(r.get('rubric', 'criteria', 'keypoints', 'markingguide', 'guide')).join('\n');
      explanation = [explanation, model && `Model answer: ${model}`, guide && `Marking guide: ${guide}`].filter(Boolean).join('\n');
      break;
    }
  }

  // ── The rest ──
  const s = isObject(r.get('settings')) ? reader(r.get('settings')) : null;
  const setting = (...names) => r.get(...names) ?? s?.get(...names);
  const settings = {};
  if (setting('casesensitive', 'matchcase') === true) settings.caseSensitive = true;
  if (typeof setting('partialcredit') === 'boolean') settings.partialCredit = setting('partialcredit');
  const wordLimit = toNumber(setting('wordlimit', 'maxwords'));
  if (wordLimit !== null) settings.wordLimit = wordLimit;
  // A short answer: does an answer that matches none of the accepted ones wait for the teacher?
  const review = setting('reviewotheranswers', 'reviewmismatch', 'teacherreview', 'manualreview');
  if (type === 'SHORT_ANSWER' && typeof review === 'boolean') settings.reviewMismatch = review;
  // A short answer: are the key words of the accepted answers looked for? Left out: for a sentence.
  const byKeyWords = setting('keywords', 'checkbykeywords', 'bykeywords', 'usekeywords');
  if (type === 'SHORT_ANSWER' && typeof byKeyWords === 'boolean') settings.keyWords = byKeyWords;

  const pointsGiven = r.get('points', 'point', 'pts', 'score', 'marks', 'mark', 'weight', 'maxpoints', 'maxscore');
  const topic = strings(r.get('topic', 'category', 'subject', 'tag', 'tags', 'lesson', 'chapter', 'unit'))[0];
  const section = strings(r.get('section', 'part'))[0] ?? defaults.section;
  const question = {
    type, text,
    points: toPoints(pointsGiven) ?? defaults.points ?? 1,
    difficulty: DIFFICULTIES[norm(String(r.get('difficulty', 'level', 'difficultylevel') ?? ''))] ?? 'MEDIUM',
    ...(topic ? { topic: clip(topic, 120) } : {}),
    ...(section ? { section: clip(section, 120) } : {}),
    explanation,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...fields,
  };
  // The order of its choices is the reader's, not the file's.
  const mixed = choiceList?.mixed === true && (type === 'MULTIPLE_CHOICE' || type === 'MULTIPLE_RESPONSE');
  return { question, warnings, mixed, fromKey };
}

// ── The whole file ───────────────────────────────────────────────────────────

/**
 * @param {string} rawText what was pasted, or the contents of a .json file
 * @returns {{ questions: Array<object>, summary: { found: number, ready: number, needsReview: number, sections: string[] }, notes: string[] }}
 *          the same shape as `parseQuestions` gives for a test paper: each question in editor
 *          shape plus `number`, `warnings` and `errors`.
 * @throws {QuestionImportError} when nothing in it can be read as a question
 */
export function parseQuestionJson(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT_CHARS);
  const { values, notes } = readJson(text);
  const found = [];
  const keys = [];
  for (const value of values) collect(value, {}, found, 0, false, keys);
  if (found.length === 0) {
    throw new QuestionImportError('No questions were found in this JSON. Every question needs its text under the name "question", for example { "question": "2 + 2 = ?", "answer": "4" }.');
  }
  if (found.length > MAX_IMPORT_QUESTIONS) notes.push(`The file has ${found.length} questions. The first ${MAX_IMPORT_QUESTIONS} were read: one import takes no more. Put the rest in a second file.`);
  // The key of an inner list was noted before the one of the list around it.
  for (const key of keys) {
    const unused = applyAnswerKey(key.entries, key.value);
    if (unused && !notes.includes(unused)) notes.push(unused);
  }
  const entries = found.slice(0, MAX_IMPORT_QUESTIONS);

  // Answers given as a number are positions counted from 0 or from 1. A file uses one way
  // throughout: a 0 anywhere shows the first, a number as large as its list shows the second.
  const probe = { base: 0, numbers: [] };
  for (const entry of entries) readQuestion(entry, probe);
  const base = probe.numbers.some((x) => x.n === 0) ? 0 : probe.numbers.some((x) => x.n === x.count) ? 1 : null;

  const seen = new Map();
  const sections = [];
  let mixed = 0;
  const keyed = { number: 0, order: 0 };
  const questions = entries.map((entry, i) => {
    const { question, warnings, mixed: reordered, fromKey } = readQuestion(entry, { base });
    if (reordered) mixed += 1;
    if (fromKey) keyed[entry.keyedBy] += 1;
    const fingerprint = normalizeAnswer(question.text.replace(/<[^>]*>/g, ' '));
    if (fingerprint && seen.has(fingerprint)) warnings.push(`This looks like a duplicate of question ${seen.get(fingerprint)}.`);
    else if (fingerprint) seen.set(fingerprint, i + 1);
    if (question.section && !sections.includes(question.section)) sections.push(question.section);
    return { number: i + 1, ...question, warnings, errors: normalizeQuestion(question).errors };
  });

  if (keyed.number + keyed.order > 0) {
    const total = keyed.number + keyed.order;
    const each = total === 1 ? 'for' : 'each for';
    const how = keyed.order === 0 ? `${each} the question with its number or its text` : keyed.number === 0 ? 'in the order of the questions: the first answer for the first question' : `${each} the question with its number, or in the order of the questions where they have no numbers`;
    notes.push(`The file keeps its answers apart from the questions. ${total === 1 ? 'One answer was' : `${total} answers were`} taken from there, ${how}. Check that each answer is with the right question.`);
  }
  if (mixed > 0) {
    notes.push(`${mixed === 1 ? 'One question lists' : `${mixed} questions list`} the wrong answers apart from the correct one. ${mixed === 1 ? 'Its' : 'Their'} choices were put in alphabetical order, so that the correct one is not always the first.`);
  }
  const ready = questions.filter((q) => q.errors.length === 0 && q.warnings.length === 0).length;
  return { questions, summary: { found: questions.length, ready, needsReview: questions.length - ready, sections }, notes };
}

// ── Writing questions as JSON ────────────────────────────────────────────────

const TYPE_WORDS = {
  MULTIPLE_CHOICE: 'multiple_choice', MULTIPLE_RESPONSE: 'multiple_response', TRUE_FALSE: 'true_false', MODIFIED_TRUE_FALSE: 'modified_true_false',
  IDENTIFICATION: 'identification', SHORT_ANSWER: 'short_answer', ESSAY: 'essay', MATCHING: 'matching', FILL_BLANKS: 'fill_blanks',
  ORDERING: 'ordering', PROGRAMMING: 'programming', FILE_UPLOAD: 'file_upload',
};

/** One question in editor shape, written the way the format is documented. */
function writeQuestion(q) {
  const out = { type: TYPE_WORDS[q.type] ?? String(q.type).toLowerCase() };
  // Plain text where the question is plain; the HTML itself where it has formatting or pictures.
  const plain = htmlToText(q.text);
  if (plain === null) out.questionHtml = q.text;
  else out.question = plain;
  const choices = q.choices ?? [];
  switch (q.type) {
    case 'MULTIPLE_CHOICE':
      out.choices = choices.map((c) => c.text);
      out.answer = choices.find((c) => c.isCorrect)?.text ?? null;
      break;
    case 'MULTIPLE_RESPONSE':
      out.choices = choices.map((c) => c.text);
      out.answer = choices.filter((c) => c.isCorrect).map((c) => c.text);
      break;
    case 'TRUE_FALSE':
      out.answer = q.answer === true;
      break;
    case 'MODIFIED_TRUE_FALSE':
      out.answer = q.answer === true;
      if (q.answer !== true) out.correction = [...(q.correction ?? [])];
      break;
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      out.answer = [...(q.accepted ?? [])];
      break;
    case 'FILL_BLANKS':
      out.answer = (q.blanks ?? []).map((blank) => [...blank]);
      break;
    case 'MATCHING':
      out.pairs = (q.pairs ?? []).map((p) => ({ left: p.left, right: p.right }));
      break;
    case 'ORDERING':
      out.items = [...(q.items ?? [])];
      break;
    case 'PROGRAMMING':
      out.programmingProblemId = q.programmingProblemId ?? null;
      break;
    default:
      break;
  }
  out.points = q.points;
  out.difficulty = String(q.difficulty ?? 'MEDIUM').toLowerCase();
  if (q.topic) out.topic = q.topic;
  if (q.section) out.section = q.section;
  if (q.explanation) out.explanation = q.explanation;
  const settings = q.settings ?? {};
  if (settings.caseSensitive === true) out.caseSensitive = true;
  if (typeof settings.partialCredit === 'boolean') out.partialCredit = settings.partialCredit;
  if (settings.wordLimit) out.wordLimit = settings.wordLimit;
  if (q.type === 'SHORT_ANSWER' && typeof settings.reviewMismatch === 'boolean') out.reviewOtherAnswers = settings.reviewMismatch;
  if (q.type === 'SHORT_ANSWER' && typeof settings.keyWords === 'boolean') out.keyWords = settings.keyWords;
  return out;
}

/**
 * Questions in editor shape as a file that `parseQuestionJson` reads back as the same questions.
 * @param {Array<object>} questions
 * @param {{ title?: string }} [about]
 */
export function questionsToJson(questions, { title } = {}) {
  return { format: 'discenda.questions', version: 1, ...(title ? { title } : {}), questions: questions.map(writeQuestion) };
}
