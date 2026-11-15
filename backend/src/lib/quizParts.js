// The parts of a quiz or examination ("Part I. Multiple Choice", "Part II. True or False", …).
// Everything here is pure.
//
// ── Which part a question belongs to ─────────────────────────────────────────
//   • A question with a part name (Question.section) belongs to the part of that name. Capital
//     letters, spacing and punctuation make no difference: "PART I: MULTIPLE CHOICE" is
//     "Part I. Multiple Choice".
//   • A question without one goes with the questions of its kind: into the first named part
//     that speaks of its kind ("Part II. True or False" takes a true-or-false question), and
//     otherwise into a part called after the kind ("Essay").
//   • Parts come in the order in which they first appear among the quiz's questions.
//
// ── When a quiz is taken part by part ────────────────────────────────────────
//   • When any of its questions has a part name, or when it is shuffled and has parts to keep
//     (hasParts): the questions of a part are kept together, and shuffling changes the order
//     inside each part only. The parts themselves are never shuffled.
//   • A quiz without part names that is not shuffled is given exactly in the teacher's order.
//   • A quiz without part names whose questions are all of one kind, or all of different kinds,
//     has no parts: shuffled, it is shuffled as a whole.
//
// A student is shown the parts whenever the order they received goes part by part (partsInOrder).
import { TYPE_LABELS, shuffle } from './quizScoring.js';

const SECTION_TYPES = [
  [/multiple\s+(choice|choices)/i, 'MULTIPLE_CHOICE'],
  [/multiple\s+(response|answer|select)/i, 'MULTIPLE_RESPONSE'],
  [/modified\s+true/i, 'MODIFIED_TRUE_FALSE'],
  [/true\s*(or|\/|and)?\s*false/i, 'TRUE_FALSE'],
  [/identif/i, 'IDENTIFICATION'],
  [/fill[\s-]*in|blank/i, 'FILL_BLANKS'],
  [/match/i, 'MATCHING'],
  [/essay|discussion|explain/i, 'ESSAY'],
  [/short\s+answer/i, 'SHORT_ANSWER'],
  [/enumerat/i, 'SHORT_ANSWER'],
  [/order|sequenc|arrange/i, 'ORDERING'],
];

/** The kind of question a heading speaks of: "Part II. True or False" → TRUE_FALSE. Null when it names none. */
export const sectionType = (text) => SECTION_TYPES.find(([re]) => re.test(String(text ?? '')))?.[1] ?? null;

// "Part I.", "TEST 2:", "Section B –", and a bare "II." or "A)" in front of a heading.
const NUMBERING = /^(?:(?:part|section|test)\s+(?:[ivx]{1,5}|\d{1,2}|[a-z])\b|(?:[ivx]{1,5}|\d{1,2}|[a-h])(?=[.):]))[\s.:)\-–—]*/i;

const fold = (text) => String(text ?? '').normalize('NFKC').toLocaleLowerCase('en').normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');

/** A part name without its own numbering: "Part I. Multiple Choice" → "Multiple Choice", "Part II" → null. */
export function partTitle(label) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  const title = text.replace(NUMBERING, '').replace(/[\s:–—-]+$/, '').trim();
  return title || null;
}

/**
 * Sort out the parts of a list of questions.
 *
 * @param {Array<{ type: string, section?: string|null }>} outline  the questions, in the teacher's order
 * @returns {{ parts: Array<{ key: string, label: string|null, title: string|null }>, keyOf: (question: { type: string, section?: string|null }) => string }}
 *   `parts` in order; `label` is the part name as the teacher wrote it (null for a part that is
 *   called after a kind), `title` what students read.
 */
export function planParts(outline) {
  const named = new Map(); // key → { label, kind }
  for (const q of outline) {
    const label = String(q.section ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const key = `n:${fold(label) || label}`;
    if (!named.has(key)) named.set(key, { label, kind: sectionType(label) });
  }
  const homeOfKind = new Map();
  for (const [key, part] of named) if (part.kind && !homeOfKind.has(part.kind)) homeOfKind.set(part.kind, key);

  const keyOf = (q) => {
    const label = String(q.section ?? '').replace(/\s+/g, ' ').trim();
    if (label) return `n:${fold(label) || label}`;
    return homeOfKind.get(q.type) ?? `k:${q.type}`;
  };

  const order = [];
  const kinds = new Map(); // key → Set of the question types in it
  for (const q of outline) {
    const key = keyOf(q);
    if (!kinds.has(key)) {
      kinds.set(key, new Set());
      order.push(key);
    }
    kinds.get(key).add(q.type);
  }
  const parts = order.map((key) => {
    const label = named.get(key)?.label ?? null;
    const only = kinds.get(key).size === 1 ? [...kinds.get(key)][0] : null;
    // A part named only by its number ("Part II") is told by the kind of its questions.
    const title = label ? partTitle(label) ?? (only ? TYPE_LABELS[only] : null) : TYPE_LABELS[key.slice(2)] ?? null;
    return { key, label, title };
  });
  return { parts, keyOf };
}

/** Does this list of questions carry part names of its own? */
export const hasNamedParts = (questions) => questions.some((q) => String(q.section ?? '').trim() !== '');

/**
 * Does this list of questions fall into parts that are worth keeping together? It does when
 * the teacher named parts, or when it has several kinds of question and at least two questions
 * of one kind. Five questions of five kinds are not five parts, and neither is one kind alone.
 */
export function hasParts(questions) {
  if (hasNamedParts(questions)) return true;
  const kinds = new Map();
  for (const q of questions) kinds.set(q.type, (kinds.get(q.type) ?? 0) + 1);
  return kinds.size > 1 && [...kinds.values()].some((n) => n > 1);
}

/**
 * Put questions in the order in which they are given.
 *
 * @template T
 * @param {T[]} items                       what to order
 * @param {object} options
 * @param {(item: T) => { type: string, section?: string|null }} [options.question]  the question of an item
 * @param {Array<{ type: string, section?: string|null }>} [options.outline]  every question the quiz may
 *        give, in the teacher's order: it sets the order of the parts. Default: the items themselves.
 * @param {boolean} [options.byParts]       keep the questions of a part together
 * @param {boolean} [options.shuffleWithin] shuffle (inside each part when `byParts`, otherwise everything)
 * @returns {Array<{ item: T, part: { key: string, title: string|null } }>}
 */
export function arrangeQuestions(items, { question = (item) => item, outline = null, byParts = false, shuffleWithin = false } = {}) {
  const plan = planParts(outline ?? items.map(question));
  const partOf = new Map(plan.parts.map((p) => [p.key, { key: p.key, title: p.title }]));
  const tagged = items.map((item) => {
    const key = plan.keyOf(question(item));
    return { item, part: partOf.get(key) ?? { key, title: TYPE_LABELS[question(item).type] ?? null } };
  });
  if (!byParts) return shuffleWithin ? shuffle(tagged) : tagged;
  const groups = new Map(plan.parts.map((p) => [p.key, []]));
  for (const entry of tagged) {
    if (!groups.has(entry.part.key)) groups.set(entry.part.key, []);
    groups.get(entry.part.key).push(entry);
  }
  return [...groups.values()].flatMap((group) => (shuffleWithin ? shuffle(group) : group));
}

/**
 * The parts of a list of questions as it stands, for showing it: each part is a run of
 * neighbouring questions. A list that does not go part by part — a part would come up twice —
 * has no parts. Neither has a list that is one single part, or one where every part would be a
 * single question that the teacher did not name a part: that is a list, not a paper in parts.
 *
 * @param {Array<{ type: string, part?: { key: string, title: string|null }|null, points?: number }>} list  in the order given
 * @returns {{ parts: Array<{ title: string|null, first: number, count: number, points: number }>, partOf: Array<number|null> }}
 *   `partOf[i]` is the index of the part of question i (null when there are no parts)
 */
export function partsInOrder(list) {
  const none = { parts: [], partOf: list.map(() => null) };
  const runs = [];
  const seen = new Set();
  let lastKey = null;
  let named = false;
  for (let i = 0; i < list.length; i += 1) {
    const q = list[i];
    const key = q.part?.key ?? `k:${q.type}`;
    if (key !== lastKey) {
      if (seen.has(key)) return none;
      seen.add(key);
      runs.push({ title: q.part ? q.part.title ?? null : TYPE_LABELS[q.type] ?? null, first: i, count: 0, points: 0 });
      lastKey = key;
      if (key.startsWith('n:')) named = true;
    }
    const run = runs[runs.length - 1];
    run.count += 1;
    run.points += q.points ?? 0;
  }
  if (runs.length < 2 || (!named && runs.every((run) => run.count === 1))) return none;
  const partOf = [];
  runs.forEach((run, index) => {
    run.points = Math.round((run.points + Number.EPSILON) * 100) / 100;
    for (let i = 0; i < run.count; i += 1) partOf.push(index);
  });
  return { parts: runs, partOf };
}
