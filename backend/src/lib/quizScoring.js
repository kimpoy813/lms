// Question definitions, the per-attempt snapshot, and automatic scoring. Everything here is pure.
//
// ── Editor shape (API input / output, import preview, AI drafts) ─────────────────────────────
//   { type, text, points, difficulty, topic, section, explanation, settings,
//     choices: [{ text, isCorrect }]          MULTIPLE_CHOICE, MULTIPLE_RESPONSE
//     answer: true|false                      TRUE_FALSE, MODIFIED_TRUE_FALSE
//     correction: ["…"]                       MODIFIED_TRUE_FALSE (accepted replacements when false)
//     accepted: ["…"]                         IDENTIFICATION, SHORT_ANSWER
//     blanks: [["…", "alt"], ["…"]]           FILL_BLANKS — one list per ___ in the text
//     pairs: [{ left, right }]                MATCHING
//     items: ["first", "second", …]           ORDERING (given in the correct order)
//     programmingProblemId                    PROGRAMMING }
//   settings: caseSensitive (compare typed answers exactly), partialCredit, wordLimit (ESSAY),
//             reviewMismatch (SHORT_ANSWER: an answer that does not match the key waits for the teacher)
//
// ── Storage ──────────────────────────────────────────────────────────────────────────────────
//   Question.answerKey   { accepted } | { blanks } | { answer, correction } | null
//   AnswerChoice rows    choices / true-false options / matching pairs (text + matchText) /
//                        ordering items (position = correct order)
//
// ── Student response (StudentAnswer.response) ────────────────────────────────────────────────
//   { choiceId } | { choiceIds } | { choiceId, correction } | { text } | { blanks: [] } |
//   { pairs: { leftId: rightId } } | { order: [ids] } | { fileIds: [] } | { language, code }
import { randomInt } from 'node:crypto';
import { answersMatch, isSentence, normalizeAnswer } from './answerMatch.js';

export { normalizeAnswer };

export const QUESTION_TYPES = [
  'MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE', 'TRUE_FALSE', 'MODIFIED_TRUE_FALSE', 'IDENTIFICATION', 'SHORT_ANSWER',
  'ESSAY', 'MATCHING', 'FILL_BLANKS', 'ORDERING', 'PROGRAMMING', 'FILE_UPLOAD',
];
export const MANUAL_TYPES = new Set(['ESSAY', 'FILE_UPLOAD']);
export const TYPE_LABELS = {
  MULTIPLE_CHOICE: 'Multiple choice', MULTIPLE_RESPONSE: 'Multiple response', TRUE_FALSE: 'True or false', MODIFIED_TRUE_FALSE: 'Modified true or false',
  IDENTIFICATION: 'Identification', SHORT_ANSWER: 'Short answer', ESSAY: 'Essay', MATCHING: 'Matching', FILL_BLANKS: 'Fill in the blanks',
  ORDERING: 'Ordering', PROGRAMMING: 'Programming', FILE_UPLOAD: 'File upload',
};

const BLANK = /_{3,}/g;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clean = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ');
export const countBlanks = (text) => (stripTags(text).match(BLANK) ?? []).length;

/**
 * Who marks the answers to a question.
 *   { by: 'SYSTEM' }         every answer is marked by the answer key, at once
 *   { by: 'TEACHER', why }   every answer waits for the teacher: 'ESSAY', 'FILE' (nothing to check
 *                            against) or 'NO_KEY' (a short answer for which no answer was given)
 *   { by: 'BOTH', why }      an answer that matches the key is marked at once, one that does not
 *                            waits for the teacher: the teacher asked for that ('CHOSEN'), or the
 *                            key is a whole sentence, which nobody types word for word ('SENTENCE')
 * Takes a stored question, a snapshot, or a question in editor shape.
 */
export function markedBy(question) {
  if (question?.type === 'ESSAY') return { by: 'TEACHER', why: 'ESSAY' };
  if (question?.type === 'FILE_UPLOAD') return { by: 'TEACHER', why: 'FILE' };
  if (question?.type !== 'SHORT_ANSWER') return { by: 'SYSTEM', why: null };
  const accepted = question.answerKey?.accepted ?? question.accepted ?? [];
  if (accepted.length === 0) return { by: 'TEACHER', why: 'NO_KEY' };
  const chosen = question.settings?.reviewMismatch;
  if (chosen === true) return { by: 'BOTH', why: 'CHOSEN' };
  if (chosen !== false && accepted.every(isSentence)) return { by: 'BOTH', why: 'SENTENCE' };
  return { by: 'SYSTEM', why: null };
}

function uniqueList(list, max = 300) {
  const seen = new Set();
  const out = [];
  for (const raw of list ?? []) {
    const value = clean(raw, max);
    const key = normalizeAnswer(value);
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/**
 * Validate an editor-shape question and convert it to what is stored.
 * @returns {{ errors: string[], data?: { type, text, points, difficulty, topic, section, explanation, answerKey, settings, programmingProblemId }, choices?: Array<{ text, matchText, isCorrect, position }> }}
 */
export function normalizeQuestion(input) {
  const errors = [];
  const type = input?.type;
  if (!QUESTION_TYPES.includes(type)) return { errors: ['Choose a question type.'] };
  const text = String(input.text ?? '').trim();
  if (!stripTags(text).replace(/&nbsp;/g, ' ').trim() && !/<img/i.test(text)) errors.push('Write the question.');
  if (text.length > 20_000) errors.push('The question is too long.');
  const points = Number(input.points ?? 1);
  if (!Number.isFinite(points) || points <= 0 || points > 1000) errors.push('Points must be more than zero.');
  const settings = {};
  if (input.settings?.caseSensitive === true) settings.caseSensitive = true;
  if (typeof input.settings?.partialCredit === 'boolean') settings.partialCredit = input.settings.partialCredit;
  const wordLimit = Number(input.settings?.wordLimit);
  if (Number.isInteger(wordLimit) && wordLimit > 0 && wordLimit <= 10_000) settings.wordLimit = wordLimit;
  if (type === 'SHORT_ANSWER' && typeof input.settings?.reviewMismatch === 'boolean') settings.reviewMismatch = input.settings.reviewMismatch;

  let choices = [];
  let answerKey = null;
  const choiceList = (list) => (Array.isArray(list) ? list : []).map((c) => ({ text: clean(c?.text, 1000), isCorrect: c?.isCorrect === true })).filter((c) => c.text);
  const hasDuplicates = (values) => new Set(values.map((v) => normalizeAnswer(v))).size !== values.length;

  switch (type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE': {
      const list = choiceList(input.choices);
      if (list.length < 2) errors.push('Add at least two choices.');
      if (list.length > 10) errors.push('Use at most ten choices.');
      if (hasDuplicates(list.map((c) => c.text))) errors.push('Two choices are the same.');
      const correct = list.filter((c) => c.isCorrect).length;
      if (type === 'MULTIPLE_CHOICE' && correct !== 1) errors.push(correct === 0 ? 'Mark the correct choice.' : 'Multiple choice has exactly one correct answer. Use "multiple response" for several.');
      if (type === 'MULTIPLE_RESPONSE' && correct === 0) errors.push('Mark at least one correct choice.');
      choices = list.map((c, position) => ({ text: c.text, matchText: null, isCorrect: c.isCorrect, position }));
      break;
    }
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE': {
      if (typeof input.answer !== 'boolean') errors.push('Choose whether the statement is true or false.');
      choices = [
        { text: 'True', matchText: null, isCorrect: input.answer === true, position: 0 },
        { text: 'False', matchText: null, isCorrect: input.answer === false, position: 1 },
      ];
      if (type === 'MODIFIED_TRUE_FALSE') {
        const correction = uniqueList(input.correction);
        if (input.answer === false && correction.length === 0) errors.push('Give the word or phrase that makes the statement true.');
        answerKey = { answer: input.answer === true, correction: input.answer === false ? correction : [] };
      }
      break;
    }
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER': {
      const accepted = uniqueList(input.accepted);
      if (type === 'IDENTIFICATION' && accepted.length === 0) errors.push('Give at least one accepted answer.');
      answerKey = { accepted };
      break;
    }
    case 'FILL_BLANKS': {
      const blanks = (Array.isArray(input.blanks) ? input.blanks : []).map((b) => uniqueList(Array.isArray(b) ? b : [b]));
      const expected = countBlanks(text);
      if (expected === 0) errors.push('Mark each blank in the question with three or more underscores (___).');
      else if (blanks.length !== expected) errors.push(`The question has ${expected} blank(s) but ${blanks.length} answer(s) were given.`);
      if (blanks.some((b) => b.length === 0)) errors.push('Give an answer for every blank.');
      answerKey = { blanks };
      break;
    }
    case 'MATCHING': {
      const pairs = (Array.isArray(input.pairs) ? input.pairs : []).map((p) => ({ left: clean(p?.left, 500), right: clean(p?.right, 500) })).filter((p) => p.left || p.right);
      if (pairs.length < 2) errors.push('Add at least two pairs.');
      if (pairs.length > 20) errors.push('Use at most twenty pairs.');
      if (pairs.some((p) => !p.left || !p.right)) errors.push('Every pair needs both sides.');
      if (hasDuplicates(pairs.map((p) => p.left))) errors.push('Two items on the left are the same.');
      choices = pairs.map((p, position) => ({ text: p.left, matchText: p.right, isCorrect: true, position }));
      break;
    }
    case 'ORDERING': {
      const items = (Array.isArray(input.items) ? input.items : []).map((i) => clean(i, 500)).filter(Boolean);
      if (items.length < 2) errors.push('Add at least two items to put in order.');
      if (items.length > 20) errors.push('Use at most twenty items.');
      if (hasDuplicates(items)) errors.push('Two items are the same.');
      choices = items.map((item, position) => ({ text: item, matchText: null, isCorrect: true, position }));
      break;
    }
    case 'PROGRAMMING':
      if (!input.programmingProblemId) errors.push('Choose a programming problem.');
      break;
    default: // ESSAY, FILE_UPLOAD: graded by the teacher
      break;
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    data: {
      type, text, points: round2(points),
      difficulty: ['EASY', 'MEDIUM', 'HARD'].includes(input.difficulty) ? input.difficulty : 'MEDIUM',
      topic: clean(input.topic, 120) || null,
      section: clean(input.section, 120) || null,
      explanation: String(input.explanation ?? '').trim().slice(0, 5000) || null,
      answerKey, settings,
      programmingProblemId: type === 'PROGRAMMING' ? input.programmingProblemId : null,
    },
    choices,
  };
}

/** A stored question (with its AnswerChoice rows) back in editor shape. */
export function toEditorShape(question) {
  const choices = [...(question.choices ?? [])].sort((a, b) => a.position - b.position);
  const base = {
    id: question.id, bankId: question.bankId, type: question.type, text: question.text, points: question.points, difficulty: question.difficulty,
    topic: question.topic, section: question.section, explanation: question.explanation, settings: question.settings ?? {},
    createdAt: question.createdAt, updatedAt: question.updatedAt,
  };
  switch (question.type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE':
      return { ...base, choices: choices.map((c) => ({ text: c.text, isCorrect: c.isCorrect })) };
    case 'TRUE_FALSE':
      return { ...base, answer: choices.find((c) => c.isCorrect)?.text === 'True' };
    case 'MODIFIED_TRUE_FALSE':
      return { ...base, answer: question.answerKey?.answer === true, correction: question.answerKey?.correction ?? [] };
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      return { ...base, accepted: question.answerKey?.accepted ?? [] };
    case 'FILL_BLANKS':
      return { ...base, blanks: question.answerKey?.blanks ?? [] };
    case 'MATCHING':
      return { ...base, pairs: choices.map((c) => ({ left: c.text, right: c.matchText ?? '' })) };
    case 'ORDERING':
      return { ...base, items: choices.map((c) => c.text) };
    case 'PROGRAMMING':
      return { ...base, programmingProblemId: question.programmingProblemId };
    default:
      return base;
  }
}

export function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Shuffle so that the result differs from the original order whenever that is possible. */
function shuffleDifferent(list) {
  if (list.length < 2 || new Set(list.map((x) => JSON.stringify(x))).size < 2) return [...list];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const out = shuffle(list);
    if (out.some((item, i) => item !== list[i])) return out;
  }
  return [...list.slice(1), list[0]];
}

/**
 * Freeze a question for one attempt. The snapshot carries the answer key, so it stays on the
 * server: students only ever receive `publicQuestion(snapshot)`.
 */
export function buildSnapshot(question, { shuffleChoices = false, part = null } = {}) {
  const ordered = [...(question.choices ?? [])].sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, text: c.text, matchText: c.matchText ?? null, isCorrect: c.isCorrect }));
  const snapshot = {
    questionId: question.id, type: question.type, text: question.text, settings: question.settings ?? {}, explanation: question.explanation ?? null,
    answerKey: question.answerKey ?? null, programmingProblemId: question.programmingProblemId ?? null,
    // The part of the quiz this question was given in: { key, title } (lib/quizParts.js).
    part,
  };
  switch (question.type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE':
      return { ...snapshot, choices: shuffleChoices ? shuffle(ordered) : ordered };
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE':
      return { ...snapshot, choices: ordered };
    case 'MATCHING':
      // Left items keep their order; the right-hand options are always shuffled.
      return { ...snapshot, choices: ordered, rightOrder: shuffleDifferent(ordered.map((c) => c.id)) };
    case 'ORDERING':
      // `choices` is the correct order; `presented` is what the student sees first.
      return { ...snapshot, choices: ordered, presented: shuffleDifferent(ordered.map((c) => c.id)) };
    default:
      return snapshot;
  }
}

/** What a student may see while answering: no key, no correctness, no explanation. */
export function publicQuestion(snapshot) {
  const base = { type: snapshot.type, text: snapshot.text, settings: { wordLimit: snapshot.settings?.wordLimit ?? null }, programmingProblemId: snapshot.programmingProblemId ?? null };
  const byId = new Map((snapshot.choices ?? []).map((c) => [c.id, c]));
  switch (snapshot.type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE':
    case 'TRUE_FALSE':
    case 'MODIFIED_TRUE_FALSE':
      return { ...base, choices: snapshot.choices.map((c) => ({ id: c.id, text: c.text })) };
    case 'MATCHING':
      return { ...base, left: snapshot.choices.map((c) => ({ id: c.id, text: c.text })), right: snapshot.rightOrder.map((id) => ({ id, text: byId.get(id).matchText })) };
    case 'ORDERING':
      return { ...base, items: snapshot.presented.map((id) => ({ id, text: byId.get(id).text })) };
    case 'FILL_BLANKS':
      return { ...base, blankCount: countBlanks(snapshot.text) };
    default:
      return base;
  }
}

/** The correct answer in display form, for reviews that are allowed to show it. */
export function correctAnswer(snapshot) {
  const choices = snapshot.choices ?? [];
  switch (snapshot.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      return { choiceId: choices.find((c) => c.isCorrect)?.id ?? null };
    case 'MULTIPLE_RESPONSE':
      return { choiceIds: choices.filter((c) => c.isCorrect).map((c) => c.id) };
    case 'MODIFIED_TRUE_FALSE':
      return { choiceId: choices.find((c) => c.isCorrect)?.id ?? null, correction: snapshot.answerKey?.correction ?? [] };
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER':
      return { accepted: snapshot.answerKey?.accepted ?? [] };
    case 'FILL_BLANKS':
      return { blanks: snapshot.answerKey?.blanks ?? [] };
    case 'MATCHING':
      // A right-hand option is identified by the id of the pair it belongs to.
      return { pairs: Object.fromEntries(choices.map((c) => [c.id, c.id])) };
    case 'ORDERING':
      return { order: choices.map((c) => c.id) };
    default:
      return null;
  }
}

/** Keep only a well-formed response for this question; anything unexpected is dropped. */
export function sanitizeResponse(snapshot, raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const ids = new Set((snapshot.choices ?? []).map((c) => c.id));
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  switch (snapshot.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      return ids.has(raw.choiceId) ? { choiceId: raw.choiceId } : null;
    case 'MODIFIED_TRUE_FALSE': {
      const out = {};
      if (ids.has(raw.choiceId)) out.choiceId = raw.choiceId;
      const correction = str(raw.correction, 300).trim();
      if (correction) out.correction = correction;
      return Object.keys(out).length > 0 ? out : null;
    }
    case 'MULTIPLE_RESPONSE': {
      const chosen = [...new Set(Array.isArray(raw.choiceIds) ? raw.choiceIds.filter((id) => ids.has(id)) : [])];
      return chosen.length > 0 ? { choiceIds: chosen } : null;
    }
    case 'IDENTIFICATION':
    case 'SHORT_ANSWER': {
      const text = str(raw.text, 2000).trim();
      return text ? { text } : null;
    }
    case 'ESSAY': {
      const text = str(raw.text, 50_000);
      return text.trim() ? { text } : null;
    }
    case 'FILL_BLANKS': {
      const n = countBlanks(snapshot.text);
      const blanks = Array.from({ length: n }, (_, i) => str(Array.isArray(raw.blanks) ? raw.blanks[i] : '', 300).trim());
      return blanks.some(Boolean) ? { blanks } : null;
    }
    case 'MATCHING': {
      const pairs = {};
      if (raw.pairs && typeof raw.pairs === 'object') {
        for (const [left, right] of Object.entries(raw.pairs)) if (ids.has(left) && ids.has(right)) pairs[left] = right;
      }
      return Object.keys(pairs).length > 0 ? { pairs } : null;
    }
    case 'ORDERING': {
      const order = Array.isArray(raw.order) ? raw.order.filter((id) => ids.has(id)) : [];
      // An ordering answer is a permutation of all the items, or nothing.
      return order.length === ids.size && new Set(order).size === ids.size ? { order } : null;
    }
    case 'FILE_UPLOAD': {
      const fileIds = [...new Set(Array.isArray(raw.fileIds) ? raw.fileIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id)) : [])].slice(0, 5);
      return fileIds.length > 0 ? { fileIds } : null;
    }
    case 'PROGRAMMING': {
      const code = str(raw.code, 100_000);
      return code.trim() ? { language: str(raw.language, 20), code } : null;
    }
    default:
      return null;
  }
}

export const isAnswered = (response) => response !== null && response !== undefined;

/**
 * Score one answer.
 * @param {object} snapshot  as built by buildSnapshot
 * @param {object|null} response  as returned by sanitizeResponse
 * @param {number} points  what the question is worth in this quiz
 * @param {{ codeScorePercent?: number|null }} [extra] result of the code judge for PROGRAMMING
 * @returns {{ autoScore: number|null, isCorrect: boolean|null, needsManual: boolean }}
 */
export function scoreAnswer(snapshot, response, points, extra = {}) {
  const full = { autoScore: round2(points), isCorrect: true, needsManual: false };
  const zero = { autoScore: 0, isCorrect: false, needsManual: false };
  const part = (fraction) => {
    const f = Math.max(0, Math.min(1, fraction));
    return { autoScore: round2(points * f), isCorrect: f === 1, needsManual: false };
  };
  const partial = snapshot.settings?.partialCredit !== false;
  const exact = snapshot.settings?.caseSensitive === true;
  const choices = snapshot.choices ?? [];

  if (MANUAL_TYPES.has(snapshot.type)) {
    // Nothing handed in: zero, and nothing for the teacher to read.
    return isAnswered(response) ? { autoScore: null, isCorrect: null, needsManual: true } : { ...zero, isCorrect: null };
  }
  if (snapshot.type === 'PROGRAMMING') {
    if (!isAnswered(response)) return zero;
    if (extra.codeScorePercent === null || extra.codeScorePercent === undefined) return { autoScore: null, isCorrect: null, needsManual: true };
    return part(extra.codeScorePercent / 100);
  }
  if (!isAnswered(response)) return zero;

  switch (snapshot.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      return choices.find((c) => c.id === response.choiceId)?.isCorrect ? full : zero;
    case 'MULTIPLE_RESPONSE': {
      const correct = new Set(choices.filter((c) => c.isCorrect).map((c) => c.id));
      const chosen = response.choiceIds ?? [];
      const right = chosen.filter((id) => correct.has(id)).length;
      const wrong = chosen.length - right;
      if (right === correct.size && wrong === 0) return full;
      // Each wrong pick cancels a right one, so ticking everything earns nothing.
      return partial ? part((right - wrong) / correct.size) : zero;
    }
    case 'MODIFIED_TRUE_FALSE': {
      const picked = choices.find((c) => c.id === response.choiceId);
      const statementIsTrue = snapshot.answerKey?.answer === true;
      if (statementIsTrue) return picked?.text === 'True' ? full : zero;
      if (picked?.text !== 'False') return zero;
      if (answersMatch(response.correction, snapshot.answerKey?.correction ?? [], { exact })) return full;
      // Spotting that it is false is half of the task.
      return partial ? part(0.5) : zero;
    }
    case 'IDENTIFICATION':
      return answersMatch(response.text, snapshot.answerKey?.accepted ?? [], { exact, list: true }) ? full : zero;
    case 'SHORT_ANSWER': {
      const accepted = snapshot.answerKey?.accepted ?? [];
      // No answer was given for it: there is nothing to check against.
      if (accepted.length === 0) return { autoScore: null, isCorrect: null, needsManual: true };
      if (answersMatch(response.text, accepted, { exact, list: true })) return full;
      // Wrong, like any other answer that is not in the key — unless the teacher looks at these.
      return markedBy(snapshot).by === 'BOTH' ? { autoScore: 0, isCorrect: false, needsManual: true } : zero;
    }
    case 'FILL_BLANKS':
    case 'MATCHING': {
      const pieces = pieceResults(snapshot, response);
      if (pieces.length === 0) return zero;
      const right = pieces.filter(Boolean).length;
      if (right === pieces.length) return full;
      return partial ? part(right / pieces.length) : zero;
    }
    case 'ORDERING': {
      const correct = choices.map((c) => c.id);
      const right = correct.filter((id, i) => response.order?.[i] === id).length;
      if (right === correct.length) return full;
      // Partial credit for ordering is opt-in: a sequence is usually right or wrong as a whole.
      return snapshot.settings?.partialCredit === true ? part(right / correct.length) : zero;
    }
    default:
      return zero;
  }
}

/**
 * Which pieces of an answer are right, for the two types that are marked piece by piece: one
 * true or false for each blank (FILL_BLANKS), or for each pair in the order of the left-hand
 * items (MATCHING). Null for every other type. This is the judgement that scoreAnswer counts,
 * so a review that shows it never disagrees with the score.
 */
export function pieceResults(snapshot, response) {
  if (snapshot.type === 'FILL_BLANKS') {
    const exact = snapshot.settings?.caseSensitive === true;
    return (snapshot.answerKey?.blanks ?? []).map((accepted, i) => answersMatch(response?.blanks?.[i], accepted, { exact }));
  }
  if (snapshot.type === 'MATCHING') {
    const choices = snapshot.choices ?? [];
    const textOf = new Map(choices.map((c) => [c.id, normalizeAnswer(c.matchText)]));
    // Two pairs may share the same right-hand text; either option is then correct.
    return choices.map((c) => response?.pairs?.[c.id] !== undefined && textOf.get(response.pairs[c.id]) === textOf.get(c.id));
  }
  return null;
}

/** Totals of an attempt from its answers. */
export function attemptTotals(answers) {
  let auto = 0;
  let manual = 0;
  let total = 0;
  let needsManual = false;
  for (const a of answers) {
    if (a.manualScore !== null && a.manualScore !== undefined) {
      manual += a.manualScore;
      total += a.manualScore;
    } else {
      auto += a.autoScore ?? 0;
      total += a.autoScore ?? 0;
      if (a.needsManual) needsManual = true;
    }
  }
  return { autoScore: round2(auto), manualScore: round2(manual), totalScore: round2(total), needsManualGrading: needsManual };
}
