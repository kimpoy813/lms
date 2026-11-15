// Checking a short answer by the key words of its accepted answer. Everything here is pure.
//
// Nobody types a sentence word for word, so a sentence is not compared letter by letter: the
// system looks for the key words of the accepted answer in what the student wrote.
//
//   accepted   "A step-by-step procedure for solving a problem"
//   key words  step · procedure · solving · problem
//   "it is a procedure that solves problems step by step"   4 of 4   right
//   "a procedure for a problem"                             2 of 4   half the points
//   "a kind of procedure"                                   1 of 4   wrong
//
// Which accepted answers: the teacher says (the setting `keyWords` of the question: for every
// accepted answer, or for none). Left to the system, it is a sentence — more than six words, or
// four and more that state something ("It stores data permanently"; isSentence in
// lib/answerMatch.js). Anything else is a word or a phrase, the name of a thing, and has to be
// given as it is: with "the", "is", "it" and the like added or left out, in the singular or the
// plural, with or without the words that the question gives, and in the same order. "OR gate"
// is not "AND gate", and "digital to analog" is not "analog to digital" (samePhrase).
//
// What a key word is: every word of the accepted answer that carries meaning — not "the", "is",
// "of", "it" — and that the question does not already give ("What is an algorithm?" gives
// "algorithm": repeating it earns nothing). A key word is found whatever its form (solve, solves,
// solving, solved), with a slip of one letter in a long word (procedrue), and written together
// or apart (hard disk, harddisk).
//
// How many: two thirds of the key words or more is right; a third or more is half right, with
// two words at least — one word in common is not half an answer (keyWordsNeeded).
// A number in the accepted answer ("eight bits") has to be there: without it, half right at most.
//
// What this cannot do: understand. "The client sends a request to the server" and "the server
// sends a request to the client" have the same key words, and "erased" is not "lost" unless the
// teacher accepts both. So the teacher can overrule any of it — or keep these answers for
// themselves, with "I look at the answers that match none of these" on the question.
//
// What the system does see is where the words are there and the answer may still say the
// opposite. Such an answer is left to the teacher, with the reason:
//   NOT         one of the two says "not" about a word they share ("the contents are not lost")
//   REPLY       one begins with "yes", the other with "no"
//   OPPOSITE    the answer has the opposite of a word of the accepted answer ("more" for "less",
//               "denser" for "less dense", "allows" for "prevents", "turned on" for "turned off")
//   COMPARISON  both compare with "than", and not with the same thing ("faster than RAM" for
//               "faster than a hard disk")
//   PAIRING     two things have changed places ("ROM is volatile and RAM is non-volatile" for
//               "RAM is volatile and ROM is non-volatile")
// A "not" about something else raises no doubt, and neither does a comparison that is turned
// round as a whole: "water is denser than ice" for "ice is less dense than water".
//
// tests/unit/key-words.test.js holds the examples.
import { DASHES, answersMatch, canonicalNumeral, isSentence, normalizeAnswer, numberWordsToDigits, stripAccents } from './answerMatch.js';

// ── Words that carry no meaning of their own ─────────────────────────────────────────────────
const STOP = new Set(`
a an the and or but if then than so because since as of to in on at by for with without from into onto about over under between through
during after before above below up down out off again further once here there when where why how what which who whom whose
is are was were be been being am do does did done doing has have had having will would shall should can could may might must
it its itself this that these those they them their theirs he she him her his hers we us our ours you your yours i me my mine
also such very just only each every any some all both other another more most much many few less least own same too etc eg ie
called known named use used uses using one like unlike while per via thing things something anything example examples e g
however therefore thus hence although though unless until whether either yet still even ever always often usually sometimes
mainly simply really already almost along among around across against behind beside beyond within toward towards upon
instead rather now soon thats theres whats lets ive youre theyre id yes yeah yep opo nope inside outside
fully completely entirely totally basically generally normally typically commonly actually especially specifically mostly
ang ng mga sa si ni kay ay at na nang o pero para kung dahil kasi ito iyan iyon yung yun ung yan yon siya sila kami tayo ako ikaw ka mo ko
niya nila namin natin isang may mayroon meron din rin lang lamang po ho ba pa naman kapag pag upang habang dito doon diyan nito noon
bilang ayon tungkol mula hanggang tulad gaya mas pinaka kaya pati saka tsaka nasa ano sino saan kailan bakit paano alin tawag
tinatawag ginagamit halimbawa
`.split(/\s+/).filter(Boolean));

// The word a reply begins with: "Yes, because…", "Hindi, dahil…".
const REPLY = { yes: 'yes', yeah: 'yes', yep: 'yes', oo: 'yes', opo: 'yes', no: 'no', nope: 'no', hindi: 'no' };

// Words that turn a statement round. ("Without power" does not: it says when, not whether.)
const NEGATION = new Set('not no never none nothing nobody neither nor cannot hindi wala walang di'.split(' '));
const isNegation = (word) => NEGATION.has(word) || /^(?:do|does|did|is|are|was|were|ca|could|wo|would|should|has|have|had|must|need|ai)nt$/.test(word);
// "Not as dense as", "not only fast": a comparison or an addition, not a denial.
const NOT_A_DENIAL = new Set(['as', 'so', 'only', 'just']);

// Forms that no rule finds: irregular verbs, plurals and comparisons, and two spellings of one word.
const IRREGULAR = new Map(`
lost:lose kept:keep held:hold made:make ran:run sent:send wrote:write written:write built:build gave:give given:give took:take
taken:take went:go gone:go saw:see seen:see found:find began:begin begun:begin became:become came:come chose:choose
chosen:choose shown:show broke:break broken:break brought:bring bought:buy sold:sell taught:teach thought:think
understood:understand meant:mean led:lead fed:feed met:meet paid:pay said:say told:tell spoke:speak spoken:speak drew:draw
drawn:draw grew:grow grown:grow fell:fall fallen:fall rose:rise risen:rise hid:hide hidden:hide won:win wore:wear worn:wear
threw:throw thrown:throw froze:freeze frozen:freeze stole:steal stolen:steal drove:drive driven:drive flew:fly flown:fly
got:get gotten:get knew:know stood:stand sat:sit spent:spend caught:catch felt:feel
mice:mouse children:child men:man women:woman feet:foot teeth:tooth media:medium criteria:criterion phenomena:phenomenon
bacteria:bacterium indices:index matrices:matrix vertices:vertex analyses:analysis axes:axis crises:crisis
hypotheses:hypothesis theses:thesis nuclei:nucleus fungi:fungus stimuli:stimulus leaves:leaf lives:life knives:knife
halves:half shelves:shelf buses:bus
better:good best:good worse:bad worst:bad bigger:big biggest:big larger:large largest:large smaller:small smallest:small
faster:fast fastest:fast slower:slow slowest:slow higher:high highest:high lower:low lowest:low greater:great greatest:great
longer:long longest:long shorter:short shortest:short cheaper:cheap cheapest:cheap easier:easy easiest:easy harder:hard
hardest:hard newer:new newest:new older:old oldest:old stronger:strong strongest:strong weaker:weak weakest:weak
quicker:quick quickest:quick simpler:simple simplest:simple safer:safe safest:safe earlier:early earliest:early
heavier:heavy heaviest:heavy lighter:light lightest:light hotter:hot hottest:hot colder:cold coldest:cold wider:wide
widest:wide deeper:deep deepest:deep denser:dense densest:dense thicker:thick thinner:thin taller:tall tallest:tall
closer:close closest:close nearer:near nearest:near farther:far further:far farthest:far furthest:far fewer:few fewest:few
cleaner:clean smarter:smart brighter:bright darker:dark louder:loud quieter:quiet
programme:program programmes:program catalogue:catalog dialogue:dialog grey:gray analyse:analyze
storage:store loss:lose solution:solve production:produce reduction:reduce introduction:introduce description:describe
transmission:transmit permission:permit division:divide decision:decide conclusion:conclude analysis:analyze
growth:grow movement:move choice:choose density:dense
`.split(/\s+/).filter(Boolean).map((pair) => pair.split(':')));
/** The word a form belongs to: analyses → analysis → analyze. */
function baseForm(word) {
  let w = word;
  for (let i = 0; i < 3 && IRREGULAR.has(w); i += 1) w = IRREGULAR.get(w);
  return w;
}

// ── Word forms: the Porter stemmer (M. F. Porter, 1980) ──────────────────────────────────────
const isConsonant = (w, i) => {
  const ch = w[i];
  if ('aeiou'.includes(ch)) return false;
  return ch === 'y' ? i === 0 || !isConsonant(w, i - 1) : true;
};
/** How many vowel–consonant sequences a stem has. */
function measure(w) {
  let n = 0;
  let i = 0;
  while (i < w.length && isConsonant(w, i)) i += 1;
  while (i < w.length) {
    while (i < w.length && !isConsonant(w, i)) i += 1;
    if (i >= w.length) break;
    n += 1;
    while (i < w.length && isConsonant(w, i)) i += 1;
  }
  return n;
}
const hasVowel = (w) => [...w].some((_, i) => !isConsonant(w, i));
const endsDouble = (w) => w.length >= 2 && w.at(-1) === w.at(-2) && isConsonant(w, w.length - 1);
const endsCvc = (w) => w.length >= 3 && isConsonant(w, w.length - 1) && !isConsonant(w, w.length - 2) && isConsonant(w, w.length - 3) && !'wxy'.includes(w.at(-1));

const STEP2 = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'],
  ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'], ['logi', 'log']];
const STEP3 = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];
/** The longest ending of the list that the word has. */
const ending = (w, list) => list.reduce((best, entry) => {
  const suffix = Array.isArray(entry) ? entry[0] : entry;
  return w.endsWith(suffix) && suffix.length > (best ? (Array.isArray(best) ? best[0] : best).length : 0) ? entry : best;
}, null);

function porter(word) {
  let w = word;
  if (w.length <= 2) return w;
  // 1a: plurals. "virus" and "analysis" are not plurals.
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  // 1b: -ed, -ing
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const cut = w.endsWith('ed') ? 2 : w.endsWith('ing') ? 3 : 0;
    if (cut > 0 && hasVowel(w.slice(0, -cut))) {
      w = w.slice(0, -cut);
      if (/(?:at|bl|iz)$/.test(w)) w += 'e';
      else if (endsDouble(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w) === 1 && endsCvc(w)) w += 'e';
    }
  }
  // 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  // 2 and 3: double endings
  for (const list of [STEP2, STEP3]) {
    const hit = ending(w, list);
    if (hit && measure(w.slice(0, -hit[0].length)) > 0) w = w.slice(0, -hit[0].length) + hit[1];
  }
  // 4: single endings
  const last = ending(w, STEP4);
  if (last) {
    const stem = w.slice(0, -last.length);
    if (measure(stem) > 1 && (last !== 'ion' || /[st]$/.test(stem))) w = stem;
  }
  // 5
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCvc(stem))) w = stem;
  }
  if (measure(w) > 1 && endsDouble(w) && w.endsWith('l')) w = w.slice(0, -1);
  return w;
}

/** What the forms of one word have in common: solve, solves, solving, solved → "solv". */
export function stem(word) {
  const w = baseForm(word);
  return /^[a-z]+$/.test(w) ? porter(w) : w;
}

/** One and the same word in the singular and the plural, and nothing more: devices → device. */
function singular(word) {
  const w = baseForm(word);
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') && !/(?:ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
}

// ── The words of a sentence ──────────────────────────────────────────────────────────────────
// Numbers that are often misspelt: they are read as the number that was meant.
const NUMBER_SLIPS = { eigth: 'eight', fourty: 'forty', ninty: 'ninety', twelv: 'twelve', fiveteen: 'fifteen' };

/**
 * @param {unknown} text
 * @returns {Array<{ word: string, stem: string, kind: 'word'|'number'|'stop'|'not' }>} in the order written
 */
export function wordsOf(text) {
  const original = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39|#x27);/g, ' ');
  // "IT", "AND", "NOT" in capitals are names (the IT department, an AND gate) — unless all of
  // the text is in capitals.
  const names = new Set(/\p{Ll}/u.test(original) ? (original.match(/(?<![\p{L}\p{N}])[A-Z]{2,}(?![\p{L}\p{N}])/gu) ?? []).map((name) => name.toLowerCase()) : []);
  let t = stripAccents(normalizeAnswer(original));
  t = t.replace(DASHES, '-').replace(/['`]/g, '');
  t = t.replace(/(?<=\d),(?=\d{3}(?!\d))/g, ''); // 1,000 → 1000
  t = t.replace(/\b(?:[a-z]\.)+[a-z]\b/g, (abbreviation) => abbreviation.replaceAll('.', '')); // u.s.a → usa
  t = t.replace(/(?<=\d)\s*(?:percent|per cent)\b/g, '%').replace(/(?<=\d)\s+%/g, '%');
  const raw = t.match(/\d+(?:\.\d+)?%?|[\p{L}\p{N}]+[+#]*/gu) ?? [];
  // "Non-volatile", "non volatile" and "nonvolatile" are one word, and not the word "volatile".
  const joined = raw.map((token) => NUMBER_SLIPS[token] ?? token).join(' ').replace(/\bnon (?=[a-z])/g, 'non');
  return numberWordsToDigits(joined, { keepLoneOne: true }).split(' ').filter(Boolean).map((token, i, tokens) => {
    if (/^\d/.test(token)) {
      const number = /^(\d+(?:\.\d+)?)(%?)$/.exec(token);
      const word = number ? `${canonicalNumeral(number[1])}${number[2]}` : token;
      return { word, stem: word, kind: 'number' };
    }
    if (names.has(token) && (isNegation(token) || STOP.has(token))) return { word: token, stem: token, kind: 'word' };
    if (isNegation(token)) return { word: token, stem: token, kind: token === 'not' && NOT_A_DENIAL.has(tokens[i + 1]) ? 'stop' : 'not' };
    if (STOP.has(token)) return { word: token, stem: token, kind: 'stop' };
    return { word: token, stem: stem(token), kind: 'word' };
  });
}

const carriesMeaning = (token) => token.kind === 'word' || token.kind === 'number';

// "Less dense", "lower density", "fewer parts" say less of something; "more dense", "higher density" more.
const LESS = new Set(['less', 'fewer', 'lower', 'lesser', 'smaller']);
const MORE = new Set(['more', 'higher', 'greater', 'bigger', 'larger']);

// "Denser" is "more dense". (Not every word in -er: a computer is not more comput.)
const COMPARATIVE = new Set(`better worse bigger larger smaller faster slower higher lower greater longer shorter cheaper easier harder newer
older stronger weaker quicker simpler safer earlier denser lighter heavier hotter colder warmer cooler thicker thinner wider narrower
deeper brighter darker louder quieter closer farther richer poorer cleaner younger taller`.split(/\s+/));

// Opposites: where the accepted answer has a word of one side and the student's answer has a word
// of the other side instead, the rest of the words cannot tell which of the two is right.
const OPPOSITES = new Map();
for (const line of `
more ~ less fewer
most ~ least
greater ~ less lesser smaller
higher ~ lower
bigger larger ~ smaller little
longer ~ shorter
faster quicker ~ slower
heavy heavier ~ light lighter
hot hotter warm warmer ~ cold colder cool cooler
stronger ~ weaker
better ~ worse
cheap ~ expensive costly
new ~ old
increase ~ decrease reduce
rise ~ fall
before ~ after
first ~ last
above ~ below
top ~ bottom
inside ~ outside
internal ~ external
input ~ output
upload ~ download
send sender ~ receive receiver
read ~ write
encrypt encryption ~ decrypt decryption
encode ~ decode
compress ~ decompress extract
import ~ export
buy buyer ~ sell seller
debit ~ credit
asset ~ liability
primary ~ secondary
permanent permanently ~ temporary temporarily
volatile ~ nonvolatile
synchronous ~ asynchronous
public ~ private
analog analogue ~ digital
serial ~ parallel
static ~ dynamic
ascending ~ descending
maximum ~ minimum
positive ~ negative
true ~ false
same ~ different
include ~ exclude
add ~ subtract remove
multiply ~ divide
major ~ minor
row ~ column
horizontal ~ vertical
clockwise ~ counterclockwise anticlockwise
exothermic ~ endothermic
anode ~ cathode
north ~ south
east ~ west
allow permit enable ~ prevent deny prohibit forbid forbidden disable
accept ~ reject
absorb ~ release emit
gain ~ lose
expand ~ contract shrink
attract ~ repel
open ~ close
start begin boot ~ end stop finish shut
easy simple ~ difficult complex complicated
good ~ bad
valid ~ invalid
legal ~ illegal
direct ~ indirect
dependent ~ independent
connect ~ disconnect
correct ~ incorrect wrong
possible ~ impossible
visible ~ invisible hidden
uppercase upper capital ~ lowercase lower small
online ~ offline
wired ~ wireless
wet ~ dry dried
full ~ empty
thick ~ thin
wide ~ narrow
deep ~ shallow
`.split('\n').filter(Boolean)) {
  const [one, other] = line.split('~').map((side) => side.trim().split(' ').map((word) => (STOP.has(word) ? word : stem(word))));
  for (const [words, against] of [[one, other], [other, one]]) {
    for (const word of words) OPPOSITES.set(word, new Set([...(OPPOSITES.get(word) ?? []), ...against]));
  }
}

const isNonWord = (token) => token.kind === 'word' && /^non[a-z]{3,}$/.test(token.word);
/** The "non-" words of a text: non-volatile, non-living. */
const nonWords = (text) => new Set(wordsOf(text).filter(isNonWord).map((token) => token.stem));

/** "Not volatile", "isn't a living thing" taken as the "non-volatile", "non-living" that the other text has. */
function withNon(words, non) {
  if (non.size === 0) return words;
  const out = [...words];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].kind !== 'not') continue;
    const at = out.findIndex((token, n) => n > i && token.kind !== 'stop');
    const joined = at !== -1 && out[at].kind === 'word' ? stem(`non${out[at].word}`) : null;
    if (joined === null || !non.has(joined)) continue;
    out[at] = { word: `non${out[at].word}`, stem: joined, kind: 'word' };
    out.splice(i, 1);
    i -= 1;
  }
  return out;
}

/**
 * A text read for what could turn it round:
 *   denied  the first word with meaning after each "not", "no", "never"… of a clause ("does not
 *           really lose" → lose; "no moving parts", "doesn't have any moving parts" → moving)
 *   absent  what it says is not there, without a "not": "without power", "the power is off"
 *   on, off what it says is switched on, and off: "the computer is turned on" → computer, turn
 *   reply   the word it begins with, where that is a reply: "yes" or "no"
 *   than    each comparison with "than": "ice is less dense than liquid water" →
 *           { subject: ice, stem: dens, less: true, phrase: 'less dense', after: liquid, water }
 *   degrees "ice is less dense" → { subject: ice, stem: dens, less: true }; "more dense",
 *           "denser" → less: false
 *   parts   the words with meaning of each part of it that says what something is or has:
 *           "RAM is volatile and ROM is non-volatile" → [ram, volatil], [rom, nonvolatil].
 *           Not the items of a list: "it stores programs and files".
 * @param {string} text
 * @param {Set<string>} [non]  the "non-" words of the text it is held against (nonWords)
 * @returns {{ tokens: ReturnType<typeof wordsOf>, stems: Set<string>, denied: Set<string>, absent: Set<string>, on: Set<string>, off: Set<string>, reply: 'yes'|'no'|null, replyWord: string|null,
 *   than: Array<{ subject: Set<string>, stem: string|null, less: boolean, phrase: string, after: Set<string> }>,
 *   degrees: Array<{ subject: Set<string>, stem: string, less: boolean, phrase: string }>, parts: Set<string>[], text: string }}
 */
function reading(text, non = new Set()) {
  const tokens = [];
  const denied = new Set();
  const absent = new Set();
  const on = new Set();
  const off = new Set();
  const than = [];
  const degrees = [];
  const parts = [];
  let reply = null;
  let replyWord = null;
  for (const clause of String(text ?? '').replace(/<[^>]*>/g, ' ').split(/[;:!?\n()]+|[.,](?=\s|$)/)) {
    const words = withNon(wordsOf(clause), non);
    if (words.length === 0) continue;
    if (tokens.length === 0 && REPLY[words[0].word]) [reply, replyWord] = [REPLY[words[0].word], words[0].word];
    parts.push({ words: new Set(), states: false });
    words.forEach((token, i) => {
      const rest = words.slice(i + 1);
      if (token.kind === 'stop' && PART.has(token.word)) parts.push({ words: new Set(), states: false });
      else if (carriesMeaning(token)) parts[parts.length - 1].words.add(token.stem);
      else if (STATES.has(token.word)) parts[parts.length - 1].states = true;
      // "Without power" and "the power is off" say what "no power" says.
      if (token.word === 'without') {
        const next = rest.find((other) => other.kind !== 'stop');
        if (next && next.kind !== 'not') absent.add(next.stem);
      }
      if (['off', 'out'].includes(token.word)) for (const other of words.slice(Math.max(0, i - 3), i)) if (carriesMeaning(other)) absent.add(other.stem);
      // What is switched off and what is on: "the power is off", "turn off the computer" — "the
      // computer is turned on", "while the power is on". Not "stored on the disk".
      if (token.word === 'off' || token.word === 'on') {
        const switched = SWITCHES.has(words[i - 1]?.stem);
        const ends = rest.length === 0 || (rest[0].kind === 'stop' && BEGINS.has(rest[0].word));
        if (token.word === 'off' || switched || (ends && STAYS.has(words[i - 1]?.word))) {
          const what = token.word === 'off' ? off : on;
          for (const other of words.slice(Math.max(0, i - 3), i)) if (carriesMeaning(other)) what.add(other.stem);
          if (switched) for (const other of rest.slice(0, 3)) if (carriesMeaning(other)) what.add(other.stem);
        }
      }
      // What is more or less so: the words before it, back to where that part of the sentence
      // begins ("the ice floats since water is denser" → water).
      const subject = (to = i) => {
        const out = new Set();
        for (let n = to - 1; n >= 0 && !(words[n].kind === 'stop' && BEGINS.has(words[n].word)); n -= 1) if (carriesMeaning(words[n])) out.add(words[n].stem);
        return out;
      };
      if (COMPARATIVE.has(token.word)) degrees.push({ stem: token.stem, less: false, phrase: token.word, subject: subject() });
      // "Less dense", "lower density", "fewer parts" — and "more dense", "higher density".
      if ((LESS.has(token.word) || MORE.has(token.word)) && rest[0]?.kind === 'word') degrees.push({ stem: rest[0].stem, less: LESS.has(token.word), phrase: `${token.word} ${rest[0].word}`, subject: subject() });
      if (token.kind === 'not') {
        // "No, it is…" and "No it is…" are a reply. "No moving parts" and "Hindi ito nawawala"
        // deny what follows.
        if (tokens.length === 0 && i === 0 && token.word === 'no' && rest[0]?.kind === 'stop') return;
        const next = rest.find((other) => other.kind !== 'stop');
        if (next && next.kind !== 'not') denied.add(next.stem);
      } else if (token.word === 'than' && i > 0) {
        // What is compared: "less dense", "faster", "fewer moving parts" — the word before
        // "than", with the "more", "less" or "fewer" that goes with it.
        const said = words.slice(Math.max(0, i - 3), i);
        const head = said[said.length - 1];
        const degree = said.findIndex((other, n) => n < said.length - 1 && (LESS.has(other.word) || MORE.has(other.word)));
        // What it is compared with: "than a hard disk because…" → hard, disk; "than that of water"
        // → water; "than the density of liquid water" → density, liquid, water.
        const from = rest.findIndex((other) => other.kind !== 'stop');
        const length = from === -1 ? 0 : rest.slice(from).findIndex((other) => !carriesMeaning(other) && !['of', 'the', 'a', 'an'].includes(other.word));
        than.push({
          subject: subject(i - 1),
          stem: head.stem,
          less: degree !== -1 && LESS.has(said[degree].word),
          phrase: said.slice(degree === -1 ? said.length - 1 : degree).map((other) => other.word).join(' '),
          after: new Set(from === -1 ? [] : rest.slice(from, length === -1 ? undefined : from + length).filter(carriesMeaning).map((other) => other.stem)),
        });
      }
    });
    tokens.push(...words);
  }
  return { tokens, stems: new Set(tokens.map((token) => token.stem)), denied, absent, on, off, reply, replyWord, than, degrees, parts: parts.filter((part) => part.states && part.words.size > 0).map((part) => part.words), text: String(text ?? '') };
}

/**
 * Two things that have changed places: the accepted answer says x of one and y of the other, in
 * two parts of the sentence ("RAM is volatile and ROM is non-volatile"), and the answer says x
 * of the other and y of the one.
 * @returns {null | [string, string, string]}  the word, what the answer puts it with, and what the accepted answer puts it with (stems)
 */
function changedPlaces(meant, said) {
  // The part of the accepted answer that a word belongs to; -1 for a word that is in several.
  const home = new Map();
  meant.parts.forEach((part, n) => part.forEach((word) => home.set(word, home.has(word) && home.get(word) !== n ? -1 : n)));
  const at = (word) => (home.get(word) ?? -1);
  for (const one of said.parts) {
    for (const other of said.parts) {
      if (one === other) continue;
      for (const x of one) for (const v of one) {
        if (at(x) < 0 || at(v) < 0 || at(x) === at(v)) continue;
        // In the other part of the answer: a word that the accepted answer has next to x, with a word that it has next to v.
        const u = [...other].find((word) => word !== x && at(word) === at(x) && !one.has(word));
        const y = [...other].find((word) => word !== v && at(word) === at(v));
        if (u && y && !other.has(v)) return [x, v, u];
      }
    }
  }
  return null;
}

// Where a sentence goes on to something else, and what makes a part of it a statement.
const PART = new Set('and while but whereas whilst at samantalang habang pero ngunit'.split(' '));
// Where a part of a sentence begins.
const BEGINS = new Set([...PART, ...'because since so as when if that which kaya dahil kasi kapag kung'.split(' ')]);
const STATES = new Set('is are was were has have had ay'.split(' '));
// "Turned on", "switched off": the verbs before an "on" that is no "on the disk".
const SWITCHES = new Set(['turn', 'switch', 'power', 'shut'].map((word) => stem(word)));
// "The power is on", "it stays on": the words before an "on" that ends what is said.
const STAYS = new Set('is are was were be been being still stays stay stayed remains remain remained kept left'.split(' '));

const shares = (one, other) => [...one].some((word) => other.has(word));
const within = (one, other) => one.size > 0 && [...one].every((word) => other.has(word));
/** "Less dense" and "more dense" or "denser"; "faster" and "slower". */
const turnsRound = (one, other) => (one.stem === other.stem ? one.less !== other.less : one.less === other.less && OPPOSITES.get(one.stem)?.has(other.stem) === true);

/** The comparison of the answer that says what this one says, the other way round: "B is slower than A" for "A is faster than B". */
const turnedRound = (mine, said) => said.than.find((theirs) => shares(theirs.after, mine.subject) && turnsRound(theirs, mine));

/**
 * Where the student's answer may say the opposite of the accepted answer although it has its
 * words. The header of this file names the reasons.
 * @returns {null | { why: 'NOT'|'REPLY'|'OPPOSITE'|'COMPARISON'|'PAIRING', words: string[], side?: 'ANSWER'|'ACCEPTED' }}
 *   words  as they were written. NOT: the word that one of them denies (`side`: which one).
 *          REPLY and OPPOSITE: what the answer says, then what the accepted answer says.
 *          PAIRING: a word, what the answer puts it with, and what the accepted answer puts it with.
 */
function conflict(meant, said) {
  const mine = (word) => asWritten(meant.text, word);
  const theirs = (word) => asWritten(said.text, word);
  if (meant.reply && said.reply && meant.reply !== said.reply) return { why: 'REPLY', words: [theirs(said.replyWord), mine(meant.replyWord)] };
  for (const token of meant.tokens) {
    if (!carriesMeaning(token) || !said.stems.has(token.stem) || meant.denied.has(token.stem) === said.denied.has(token.stem)) continue;
    // "No power" where the other says "without power", or "when the power is off".
    if ((meant.denied.has(token.stem) ? said : meant).absent.has(token.stem)) continue;
    // The word as the one who denies it wrote it: "hold" in "it does not hold…", for "it holds…".
    if (!said.denied.has(token.stem)) return { why: 'NOT', words: [mine(token.word)], side: 'ACCEPTED' };
    return { why: 'NOT', words: [theirs(said.tokens.find((their) => their.stem === token.stem)?.word ?? token.word)], side: 'ANSWER' };
  }
  // Comparisons. "B is more dense than A" says what "A is less dense than B" says: there, the
  // opposite word is no doubt.
  const settled = new Set();
  for (const compared of meant.than) {
    if (compared.after.size === 0 || said.than.length === 0) continue;
    // With the same thing: "than water" for "than liquid water" — not "than a high-level
    // language" for "than a low-level language".
    const same = said.than.find((other) => within(other.after, compared.after) || within(compared.after, other.after));
    if (same) {
      if (turnsRound(same, compared)) return { why: 'OPPOSITE', words: [theirs(same.phrase), mine(compared.phrase)] };
      continue;
    }
    const turned = turnedRound(compared, said);
    if (!turned) return { why: 'COMPARISON', words: [] };
    for (const word of [compared.stem, turned.stem]) settled.add(word);
    for (const word of [...LESS, ...MORE]) settled.add(stem(word));
  }
  // "It is denser" where the accepted answer says "ice is less dense" — but not "water is
  // denser", which is said of something else.
  for (const degree of meant.degrees) {
    if (settled.has(degree.stem) || said.degrees.some((other) => other.stem === degree.stem && other.less === degree.less)) continue;
    const other = said.degrees.find((their) => their.stem === degree.stem && their.less !== degree.less && (their.subject.size === 0 || degree.subject.size === 0 || shares(their.subject, degree.subject)));
    if (other) return { why: 'OPPOSITE', words: [theirs(other.phrase), mine(degree.phrase)] };
  }
  for (const token of meant.tokens) {
    const others = OPPOSITES.get(token.stem);
    // An accepted answer that has both ("takes input and gives output") says nothing by either.
    if (!others || settled.has(token.stem) || said.stems.has(token.stem) || [...others].some((other) => meant.stems.has(other))) continue;
    const other = said.tokens.find((their) => others.has(their.stem) && !settled.has(their.stem));
    if (other) return { why: 'OPPOSITE', words: [theirs(other.word), mine(token.word)] };
  }
  // "Turned on" where the accepted answer says "turned off", and the other way round — unless
  // one of them says both.
  for (const [mine, their] of [['off', 'on'], ['on', 'off']]) {
    if ([...meant[mine]].some((word) => said[their].has(word) && !said[mine].has(word) && !meant[their].has(word))) return { why: 'OPPOSITE', words: [their, mine] };
  }
  // "Volatile" where the accepted answer says "non-volatile", and the other way round.
  for (const [one, other] of [[meant, said], [said, meant]]) {
    for (const token of one.tokens.filter(isNonWord)) {
      const without = stem(token.word.slice(3));
      if (other.stems.has(token.stem) || one.stems.has(without) || !other.stems.has(without)) continue;
      const bare = other.tokens.find((their) => their.stem === without).word;
      return { why: 'OPPOSITE', words: one === meant ? [theirs(bare), mine(token.word)] : [theirs(token.word), mine(bare)] };
    }
  }
  const moved = changedPlaces(meant, said);
  if (moved) {
    const word = (reading, stemmed) => asWritten(reading.text, reading.tokens.find((token) => token.stem === stemmed)?.word ?? stemmed);
    return { why: 'PAIRING', words: [word(said, moved[0]), word(said, moved[1]), word(meant, moved[2])] };
  }
  return null;
}

const NUMBER_NAMES = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen',
  15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety' };

/** A word as the teacher wrote it in the accepted answer: "CPU", not "cpu"; "eight", not "8". */
function asWritten(original, word) {
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const find = (pattern) => new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').exec(String(original))?.[0];
  // "nonvolatile" was written "non-volatile", or "not volatile".
  const apart = /^non[a-z]/.test(word) ? (find(`non[-\\s]?${escaped(word.slice(3))}`) ?? find(`not\\s+${escaped(word.slice(3))}`)) : undefined;
  return find(escaped(word)) ?? apart ?? (NUMBER_NAMES[word] && find(escaped(NUMBER_NAMES[word]))) ?? word;
}

/**
 * The key words of an accepted answer, or null when it is not checked by key words: a word or
 * a phrase, unless the teacher asked for key words.
 * @param {string} accepted
 * @param {string} [question]  the text of the question: what it already gives is not a key word
 * @param {boolean} [chosen]   the teacher's choice: true = key words for every accepted answer,
 *                             false = for none; not given = for a sentence
 * @returns {null | Array<{ word: string, plain: string, stem: string, number: boolean, with: string|null }>}
 *   word   as the teacher wrote it          plain  as it is compared
 *   with   the word that follows it in the accepted answer ("hard" with "disk"), if any
 */
export function keyWords(accepted, question = '', chosen = undefined) {
  if (chosen === false || (chosen !== true && !isSentence(accepted))) return null;
  const tokens = wordsOf(accepted);
  const unique = (list) => list.filter((token, i) => list.findIndex((other) => other.stem === token.stem) === i);
  const all = unique(tokens.filter(carriesMeaning));
  if (all.length === 0) return null;
  const given = new Set(wordsOf(question).filter(carriesMeaning).map((token) => token.stem));
  const own = all.filter((token) => !given.has(token.stem));
  // An accepted answer that only repeats the question is taken as it stands.
  return (own.length > 0 ? own : all).map((token) => {
    const next = tokens[tokens.indexOf(token) + 1];
    return { word: asWritten(accepted, token.word), plain: token.word, stem: token.stem, number: token.kind === 'number', with: next && next.kind !== 'number' && token.kind !== 'number' ? next.word : null };
  });
}

/** One slip of the keyboard in a long word: a letter left out, added, changed, or two swapped. */
function oneSlip(a, b) {
  if (Math.abs(a.length - b.length) > 1 || Math.max(a.length, b.length) < 6 || a[0] !== b[0] || /\d/.test(a + b)) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * How many of so many key words an answer needs.
 *   right  two thirds of them, or more
 *   half   a third of them, or more — and two at least, since one word in common is not half
 *          an answer (of two key words, one). Null where that is already right.
 * @returns {{ right: number, half: number|null }}
 */
export function keyWordsNeeded(all) {
  const right = Math.ceil((all * 2) / 3);
  const half = Math.max(Math.ceil(all / 3), Math.min(2, all - 1));
  return { right, half: half >= 1 && half < right ? half : null };
}

/**
 * Look for the key words of one accepted answer in what the student wrote.
 * @returns {null | { share: 0|0.5|1, found: string[], missing: string[], doubt: ReturnType<typeof conflict> }}
 *   null when the accepted answer is not a sentence. `doubt`: the key words give the answer
 *   points, and it may still say the opposite.
 */
function lookFor(accepted, answer, question, chosen) {
  const keys = keyWords(accepted, question, chosen);
  if (!keys) return null;
  // Both are read with the "not volatile" of the one as the "non-volatile" of the other.
  const meant = reading(accepted, nonWords(answer));
  const said = reading(answer, nonWords(accepted));
  const given = said.tokens;
  const words = given.filter(carriesMeaning);
  const stems = new Set(words.map((token) => token.stem));
  const written = new Set(given.map((token) => token.word));
  // Written apart by the student, together in the accepted answer: "mother board" for "motherboard".
  for (let i = 0; i + 1 < given.length; i += 1) stems.add(stem(given[i].word + given[i + 1].word));
  const long = words.filter((token) => token.kind === 'word');
  // "Slower", in a comparison that is turned round as a whole, stands for the key word "faster".
  const turned = new Set(meant.than.filter((mine) => mine.after.size > 0 && !said.than.some((theirs) => within(theirs.after, mine.after) || within(mine.after, theirs.after)) && turnedRound(mine, said)).map((mine) => mine.stem));
  /** How a key word was found: as a word, joined with the next one ("harddisk" for "hard disk"), with a slip — or not. */
  const how = (key) => {
    if (stems.has(key.stem) || turned.has(key.stem)) return 'word';
    // "Non-volatile" for the "not volatile" of the accepted answer.
    const non = stem(`non${key.plain}`);
    if (meant.stems.has(non) && !meant.stems.has(key.stem) && stems.has(non)) return 'word';
    if (key.with !== null && (written.has(key.plain + key.with) || stems.has(stem(key.plain + key.with)))) return 'joined';
    return long.some((token) => oneSlip(token.word, key.plain) || oneSlip(token.stem, key.stem)) ? 'slip' : null;
  };
  const found = [];
  const missing = [];
  let numbers = true; // every number of the accepted answer is there
  let before = null; // the key word before this one, and how it was found
  for (const key of keys) {
    // The second half of a pair that the student wrote as one word is found with the first.
    const via = how(key) ?? (before?.via === 'joined' && before.key.with === key.plain ? 'joined' : null);
    (via ? found : missing).push(key.word);
    if (!via && key.number) numbers = false;
    before = { key, via };
  }
  // "Sixteen bits" is not half wrong about a byte: a number that is not there costs the full marks.
  const needed = keyWordsNeeded(keys.length);
  // Without a number of the accepted answer, an answer that would be right is half right.
  const level = found.length >= needed.right ? (numbers ? 1 : 0.5) : needed.half !== null && found.length >= needed.half ? 0.5 : 0;
  return { share: level, found, missing, doubt: level > 0 ? conflict(meant, said) : null };
}

// Words that say nothing in the name of a thing: "the volatile memory", "it is volatile memory".
// Every other word counts — "and", "or", "not", "for", "to", "more", "less" too.
const GLUE = new Set('a an the of is are was were it its this that these those they called'.split(' '));

// "RAM is…", "A keyboard is…": the question, said again in front of the answer.
const LINK = new Set(['is', 'are', 'was', 'were', 'means', 'ay']);

/**
 * A word or a phrase, given as it is: the words of the accepted answer in their order, with
 * "the", "is", "it" and the like added or left out, and in the singular or the plural.
 * The words of the question need not be said again, and may be: to "What type of memory is
 * RAM?", "volatile" is right for "volatile memory", "volatile memory" for "volatile", and "RAM
 * is volatile" for both. Left out or added, not both: "output device" is not "input device"
 * to a question that names the two. Several things ("control unit and arithmetic logic unit")
 * may come in any order.
 */
function samePhrase(accepted, given, question) {
  const name = (token) => (token.kind === 'word' ? singular(token.word) : token.word);
  // A capital A that stands alone is a letter ("vitamin A"), not the article.
  const letter = /(?<=[\p{L}\p{N}]\s)A(?![\p{L}\p{N}'’])/u;
  const plain = (tokens, text) => tokens.filter((token) => !GLUE.has(token.word) || token.kind === 'word' || (token.word === 'a' && letter.test(String(text)))).map(name);
  const asked = new Set(wordsOf(question).filter(carriesMeaning).map(name));
  /** `short` is `long` without some of the words that the question gives. */
  const without = (long, short) => {
    let at = 0;
    for (const word of long) {
      if (short[at] === word) at += 1;
      else if (!asked.has(word)) return false;
    }
    return at === short.length;
  };
  const same = (key, answer, withQuestion) => {
    const mine = plain(wordsOf(key), key);
    const tokens = wordsOf(answer);
    const whole = plain(tokens, answer);
    if (mine.length === 0 || whole.length === 0) return false;
    if (mine.join(' ') === whole.join(' ')) return true;
    if (!withQuestion) return false;
    // "RAM is volatile": the question, said again in front of the answer.
    const link = tokens.findIndex((token) => LINK.has(token.word));
    const lead = tokens.slice(0, Math.max(link, 0)).filter(carriesMeaning);
    const theirs = lead.length > 0 && link < tokens.length - 1 && lead.every((token) => asked.has(name(token))) ? plain(tokens.slice(link + 1), answer) : whole;
    if (theirs.length === 0) return false;
    if (mine.join(' ') === theirs.join(' ')) return true;
    // An accepted answer that only repeats the question is taken as it stands.
    if (mine.every((word) => asked.has(word))) return false;
    return without(mine, theirs) || without(theirs, mine);
  };
  if (same(accepted, given, true)) return true;
  const items = (text) => String(text ?? '').split(/\s*(?:[,;\n\r&]|(?<![\p{L}\p{N}])and(?![\p{L}\p{N}]))\s*/iu);
  const [mine, theirs] = [items(accepted), items(given)];
  if (mine.length < 2 || mine.length !== theirs.length || [...mine, ...theirs].some((item) => wordsOf(item).length === 0)) return false;
  const left = [...theirs];
  return mine.every((item) => {
    const at = left.findIndex((other) => same(item, other, false));
    if (at !== -1) left.splice(at, 1);
    return at !== -1;
  });
}

/**
 * Check a short answer against its accepted answers.
 *
 * @param {unknown} given       what the student typed
 * @param {string[]} accepted   the accepted answers
 * @param {{ exact?: boolean, question?: string }} [options]
 *   exact     the answer must be given exactly as written: nothing below the first step is tried
 *   question  the text of the question
 * @returns {{ share: 0|0.5|1, how: 'SAME'|'WORDS'|'KEY_WORDS'|'NONE', doubt: null | { why: 'NOT'|'REPLY'|'OPPOSITE'|'COMPARISON'|'PAIRING', words: string[], side?: 'ANSWER'|'ACCEPTED' }, accepted: string|null, found: string[], missing: string[] }}
 *   share   how much of the points the answer earns
 *   how     SAME       it is one of the accepted answers (lib/answerMatch.js)
 *           WORDS      it has the words of an accepted answer, with small words or the words
 *                      of the question added or left out
 *           KEY_WORDS  an accepted answer is a sentence, and this is what its key words gave
 *           NONE       it is not an accepted answer, and no accepted answer is a sentence
 *   doubt   the key words gave it points, and it may still say the opposite (the header of
 *           this file names the reasons): the system cannot tell whether it is right
 *   accepted, found, missing   the accepted answer it was held against, and its key words
 */
export function checkShortAnswer(given, accepted, { exact = false, question = '', keyWords: chosen = undefined } = {}) {
  const none = { share: 0, how: 'NONE', doubt: null, accepted: null, found: [], missing: [] };
  const list = (accepted ?? []).filter((a) => typeof a === 'string' && a.trim() !== '');
  if (answersMatch(given, list, { exact, list: true })) return { ...none, share: 1, how: 'SAME' };
  if (exact || normalizeAnswer(given) === '') return none;
  const same = list.find((a) => samePhrase(a, given, question));
  if (same) return { ...none, share: 1, how: 'WORDS', accepted: same };
  // The accepted answer that the student's answer comes closest to. One that raises no doubt
  // is preferred to one that does.
  const rank = (r) => [r.doubt ? 0 : 1, r.share, r.found.length / (r.found.length + r.missing.length)];
  let best = null;
  for (const a of list) {
    const result = lookFor(a, given, question, chosen);
    if (!result) continue;
    const [mine, theirs] = [rank(result), best ? rank(best) : null];
    const better = !theirs || (result.share > 0 && best.share === 0) || (result.share > 0 === best.share > 0 && (mine[0] - theirs[0] || mine[1] - theirs[1] || mine[2] - theirs[2]) > 0);
    if (better) best = { ...result, accepted: a };
  }
  if (!best) return none;
  return { share: best.share, how: 'KEY_WORDS', doubt: best.doubt, accepted: best.accepted, found: best.found, missing: best.missing };
}
