// Comparing a typed answer with the answer key. Everything here is pure.
//
// The aim: an answer that any teacher would call the same as the key is marked right — and
// nothing else is. Every rule below takes away a difference that carries no meaning in a typed
// answer: capital letters, accents, spacing, punctuation, a leading "the", how a number is written.
// A rule that could turn a *different* answer into a right one is left out: "C" is not "C++",
// "x-y" is not "xy", "(2, 3]" is not "[2, 3)", "RAM" is not "ROM" (no guessing at spelling).
// tests/unit/answer-match.test.js lists the pairs that must match and those that must not.
//
// A question can ask for an exact comparison instead (settings.caseSensitive): then only the
// spacing around the answer and a full stop after it are ignored.

/** Canonical form of a typed answer: tells two accepted answers apart, and is the exact comparison. */
export function normalizeAnswer(value, { caseSensitive = false } = {}) {
  let text = String(value ?? '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
  // Trailing sentence punctuation is not part of the answer — unless it is the whole answer (";").
  text = text.replace(/[.!?;,]+$/u, '').trim() || text;
  return caseSensitive ? text : text.toLocaleLowerCase('en');
}

const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);

/** How many letters stand in a row at `from`, reading in direction `step`. */
function lettersAt(text, from, step) {
  let n = 0;
  for (let i = from; isLetter(text[i]); i += step) n += 1;
  return n;
}

// ── Numbers written as words ─────────────────────────────────────────────────
const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
const isNumberWord = (w) => w === 'zero' || w === 'hundred' || Object.hasOwn(ONES, w) || Object.hasOwn(TEENS, w) || Object.hasOwn(TENS, w) || Object.hasOwn(SCALES, w);

/**
 * The longest number that the words spell from `start` on: { value, length } or null.
 * Strict about the grammar, so that "two three" stays two numbers and never becomes 5.
 */
function numberAt(words, start) {
  if (words[start] === 'zero') return { value: 0, length: 1 };
  let total = 0;
  let group = 0;
  let last = 'start'; // start | one | teen | tens | hundred | scale
  let best = null;
  for (let i = start; i < words.length && i < start + 14; i += 1) {
    const w = words[i];
    if (w === 'and') {
      // "one hundred and five": only between a hundred (or thousand) and what follows.
      if ((last !== 'hundred' && last !== 'scale') || !isNumberWord(words[i + 1] ?? '') || Object.hasOwn(SCALES, words[i + 1]) || words[i + 1] === 'hundred') break;
      continue;
    }
    if (Object.hasOwn(ONES, w)) {
      if (!['start', 'tens', 'hundred', 'scale'].includes(last)) break;
      group += ONES[w];
      last = 'one';
    } else if (Object.hasOwn(TEENS, w) || Object.hasOwn(TENS, w)) {
      if (!['start', 'hundred', 'scale'].includes(last)) break;
      group += TEENS[w] ?? TENS[w];
      last = Object.hasOwn(TEENS, w) ? 'teen' : 'tens';
    } else if (w === 'hundred') {
      if (last !== 'one' || group > 9) break;
      group *= 100;
      last = 'hundred';
    } else if (Object.hasOwn(SCALES, w)) {
      if (last === 'start' || last === 'scale' || group === 0) break;
      total += group * SCALES[w];
      group = 0;
      last = 'scale';
    } else break;
    best = { value: total + group, length: i - start + 1 };
  }
  return best;
}

/** "eight bits" → "8 bits", "twenty one" → "21". Words that spell no number are left as they are. */
function numberWordsToDigits(text) {
  const words = text.split(' ');
  if (!words.some(isNumberWord)) return text;
  const out = [];
  for (let i = 0; i < words.length;) {
    const number = isNumberWord(words[i]) ? numberAt(words, i) : null;
    if (number) {
      out.push(String(number.value));
      i += number.length;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }
  return out.join(' ');
}

/** A numeral by its value: 007 → 7, 2.50 → 2.5, +5 → 5. Done on the digits, so no long number loses any. */
function canonicalNumeral(numeral) {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(numeral);
  if (!m) return numeral;
  const whole = m[2].replace(/^0+(?=\d)/, '');
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  const zero = /^0*$/.test(whole) && fraction === '';
  return `${m[1] === '-' && !zero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The forgiving form of an answer: what is left when everything without meaning is taken away.
 * Words are still apart here (see `squeeze`).
 */
function plain(value) {
  const normal = normalizeAnswer(value);
  let t = normal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC'); // ñ → n, é → e
  t = t.replace(DASHES, '-');
  t = t.replace(/(?<=\d),(?=\d{3}(?!\d))/g, ''); // 1,000 → 1000
  t = t.replace(/(?<![\d.])\.(?=\d)/g, '0.'); // .5 → 0.5
  t = t.replace(/(?<=\p{L})\.(?=\p{L})/gu, ''); // U.S.A. → USA
  t = t.replace(/\.(?!\d)/g, ' '); // "Dr. Rizal"; a decimal point stays
  t = t.replace(/['"`]/g, ''); // Boyle's → Boyles
  t = t.replace(/[,;]/g, ' ');
  t = t.replace(/(?<=[\p{L}\p{N}])\s*&\s*(?=[\p{L}\p{N}])/gu, ' and ');
  // A hyphen or a slash that joins words: e-mail, Wi-Fi, COVID-19, input/output, Monday - Friday.
  // Where it may be a sign instead — between single letters or numbers (x-y, a/b, n-1, 1/2) — it
  // is left alone.
  t = t.replace(/(?<=[\p{L}\p{N}])\s*([-/])\s*(?=[\p{L}\p{N}])/gu, '$1');
  t = t.replace(/(?<=[\p{L}\p{N}])[-/](?=[\p{L}\p{N}])/gu, (mark, at, whole) => (lettersAt(whole, at - 1, -1) > 1 || lettersAt(whole, at + 1, 1) > 1 ? ' ' : mark));
  t = numberWordsToDigits(t.replace(/\s+/g, ' ').trim());
  t = t.replace(/(?<=\d)\s*(?:percent|per cent)\b/g, '%');
  // An answer that is one number, alone or with its unit: compared by value (5.0 kg = 5 kg).
  // A text with more numbers in it is an address, a version or a date, and stays as typed.
  const m = /^([^\p{L}\p{N}+-]*)([+-]?\d+(?:\.\d+)?)(\D*)$/u.exec(t);
  if (m) t = `${m[1]}${canonicalNumeral(m[2])}${m[3]}`;
  // An answer made only of signs ("'", "&&") is kept as it was typed.
  return t.trim() || normal;
}

const isSingleLetter = (token) => /^\p{L}$/u.test(token);

/**
 * Words run together ("hard disk" = "harddisk"). Two numbers stay two numbers ("2 3" is not
 * "23"), and two single letters stay two letters ("A B" is not "AB": it may be two answers).
 */
function squeeze(text) {
  const tokens = text.split(' ');
  let out = tokens[0];
  for (let i = 1; i < tokens.length; i += 1) {
    const [before, after] = [tokens[i - 1], tokens[i]];
    const apart = (/\d$/.test(before) && /^\d/.test(after)) || (isSingleLetter(before) && isSingleLetter(after));
    out += apart ? ` ${after}` : after;
  }
  return out;
}

// What students put in front of an answer. Read on the plain form, where "it's" is "its".
const OPENING = /^(?:the answer is|answer is|answer|ans|it is called|its called|it is|its|this is|that is|they are|these are|those are)(?:\s*[:=-])?\s+/;
// In front of a word or a number. Not in front of a single letter: "A B" may be two answers.
const ARTICLE = /^(?:the|an|a)\s+(?=\S{2}|\d)/;
// What is left must be an answer: "The The" does not come down to "the".
const isArticle = (text) => text === 'the' || text === 'an' || text === 'a';

/** The forms under which a typed answer is looked up: as given, and without what was put in front of it. */
function givenForms(value) {
  const forms = new Set();
  const add = (text) => {
    if (!text) return;
    forms.add(squeeze(text));
    const bare = text.replace(ARTICLE, '');
    if (bare && !isArticle(bare)) forms.add(squeeze(bare));
  };
  const text = plain(value);
  add(text);
  add(text.replace(OPENING, ''));
  return forms;
}

const lettersOnly = (text) => plain(text).replace(/[^\p{L}]/gu, '');

/**
 * Is `short` an abbreviation of `long`? It is one short word whose letters are found in `long`
 * in the same order, from the first letter on: CPU in "central processing unit", HTML in
 * "hypertext markup language", KB in "kilobyte" — and not "planet" in "Mercury".
 */
function abbreviates(short, long) {
  const s = lettersOnly(short);
  const l = lettersOnly(long);
  if (/\s/.test(plain(short)) || s.length < 2 || s.length > 10 || s[0] !== l[0]) return false;
  if (l.length < s.length * 2 && !/\s/.test(plain(long))) return false;
  let at = 0;
  for (const ch of s) {
    at = l.indexOf(ch, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * The forms that one accepted answer stands for.
 *   "the mouse", "an algorithm"      → also "mouse", "algorithm"
 *   "Central Processing Unit (CPU)"  → also "Central Processing Unit" and, being its abbreviation, "CPU"
 *   "Mercury (planet)"               → also "Mercury", but not "planet"
 */
function acceptedForms(value) {
  const forms = new Set();
  const add = (text) => {
    const p = plain(text);
    if (!p) return;
    forms.add(squeeze(p));
    // "The" and "an" in front of a key are articles. "A" may be the answer itself ("A positive",
    // "A minor", an "A record"), so there it stays.
    const bare = p.replace(/^(?:the|an)\s+(?=\S{2}|\d)/, '');
    if (bare && !isArticle(bare)) forms.add(squeeze(bare));
  };
  add(value);
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(normalizeAnswer(value));
  if (m && m[2].trim()) {
    const [outer, inner] = [m[1], m[2].trim()];
    add(outer);
    add(`${outer} ${inner}`);
    if (abbreviates(inner, outer) || abbreviates(outer, inner)) {
      add(inner);
      add(`${inner} ${outer}`);
      add(`${inner} (${outer})`);
    }
  }
  return forms;
}

const overlaps = (a, b) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Is the typed answer one of the accepted answers?
 *
 * @param {unknown} given        what the student typed
 * @param {string[]} accepted    the answer key: every wording that is right
 * @param {{ exact?: boolean, list?: boolean }} [options]
 *   exact  compare as typed (capital letters, accents, spacing inside and punctuation matter)
 *   list   also right: several accepted answers given at once ("keyboard, mouse and scanner"),
 *          as long as every one of them is an accepted answer
 */
export function answersMatch(given, accepted, { exact = false, list = false } = {}) {
  const key = (accepted ?? []).filter((a) => typeof a === 'string' || typeof a === 'number');
  if (key.length === 0) return false;
  if (exact) {
    const mine = normalizeAnswer(given, { caseSensitive: true });
    return mine !== '' && key.some((a) => normalizeAnswer(a, { caseSensitive: true }) === mine);
  }
  if (normalizeAnswer(given) === '') return false;
  const forms = new Set();
  for (const a of key) for (const form of acceptedForms(a)) forms.add(form);
  if (overlaps(givenForms(given), forms)) return true;
  if (!list) return false;
  const items = String(given ?? '').split(/\s*(?:[,;\n\r]|\band\b|&)\s*/i).filter((item) => normalizeAnswer(item) !== '');
  return items.length >= 2 && items.length <= 30 && items.every((item) => overlaps(givenForms(item), forms));
}

/** More than a phrase: a whole sentence, which nobody types word for word. */
export const isSentence = (text) => String(text ?? '').trim().split(/\s+/).length > 6;
