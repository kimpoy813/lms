// The comparison of a typed answer with the answer key (src/lib/answerMatch.js).
//
// Two lists carry the rule: what must be marked right although it is not typed like the key,
// and what must stay wrong although it looks like the key. A change to the comparison that
// moves a pair from one list to the other changes students' scores: do it on purpose.
import { describe, expect, it } from 'vitest';
import { answersMatch, isSentence, normalizeAnswer } from '../../src/lib/answerMatch.js';

const SAME = [
  // capital letters, spacing, sentence punctuation
  ['cpu', 'CPU'], ['  Central   Processing Unit. ', 'Central Processing Unit'], ['Manila!', 'Manila'], ['ＣＰＵ', 'CPU'],
  // dots of an abbreviation, apostrophes, quotes
  ['C.P.U.', 'CPU'], ['USA', 'U.S.A.'], ['Dr Jose Rizal', 'Dr. Jose Rizal'], ['Boyles law', 'Boyle’s Law'], ['"hello world"', 'hello world'],
  // accents
  ['Nino', 'Niño'], ['Las Pinas', 'Las Piñas'], ['cafe', 'café'],
  // "the", "a", "an" in front, and what students write around an answer
  ['the CPU', 'CPU'], ['a mouse', 'mouse'], ['An operating system', 'operating system'], ['Hobbit', 'The Hobbit'],
  ['algorithm', 'An algorithm'], ['the algorithm', 'an algorithm'],
  ['It is the CPU.', 'CPU'], ['The answer is CPU', 'CPU'], ["It's called a compiler", 'compiler'], ['Answer: RAM', 'RAM'],
  // words written together, apart, or with a hyphen
  ['harddisk', 'hard disk'], ['hard-disk', 'Hard Disk'], ['mother board', 'Motherboard'], ['wifi', 'Wi-Fi'], ['wi fi', 'Wi-Fi'], ['email', 'e-mail'],
  ['covid 19', 'COVID-19'], ['input output', 'input/output'], ['tcpip', 'TCP/IP'], ['Monday-Friday', 'Monday - Friday'], ['a - b', 'a-b'], ['a+b', 'a + b'],
  // "and" and "&", commas between words
  ['R and D', 'R&D'], ['research & development', 'Research and Development'], ['Rizal Jose', 'Rizal, Jose'],
  // numbers: grouping, zeros, words, units
  ['1000', '1,000'], ['2.5', '2.50'], ['5', '5.0'], ['0.5', '.5'], ['007', '7'], ['+5', '5'],
  ['eight', '8'], ['8', 'eight'], ['8 bits', 'eight bits'], ['twenty-one', '21'], ['one hundred and five', '105'], ['two thousand twenty six', '2026'],
  ['5kg', '5 kg'], ['5.0 kg', '5 kg'], ['50 percent', '50%'], ['50 %', '50%'], ['fifty percent', '50%'], ['₱1,500.00', '₱1500'], ['vitamin b 12', 'Vitamin B12'],
  // letters given as an answer
  ['b.', 'B'], ['A B', 'A, B'],
  // a key that gives a name with its abbreviation, or with a note
  ['Central Processing Unit', 'Central Processing Unit (CPU)'], ['CPU', 'Central Processing Unit (CPU)'], ['cpu (central processing unit)', 'Central Processing Unit (CPU)'],
  ['Central Processing Unit CPU', 'Central Processing Unit (CPU)'], ['Central Processing Unit', 'CPU (Central Processing Unit)'], ['HTML', 'HyperText Markup Language (HTML)'],
  ['DNA', 'Deoxyribonucleic acid (DNA)'], ['CO2', 'Carbon dioxide (CO2)'], ['PH', 'Philippines (PH)'], ['Mercury', 'Mercury (planet)'], ['input devices', 'input device(s)'],
  // an answer made of signs is taken as typed
  [';', ';'], ['&&', '&&'], ['==', '=='],
];

const DIFFERENT = [
  // nothing typed
  ['', 'CPU'], ['   ', 'CPU'], ['.', 'CPU'],
  // another answer, however close: spelling is never guessed
  ['ROM', 'RAM'], ['mitosis', 'meiosis'], ['Cebu', 'Manila'], ['positive', 'A positive'], ['minor', 'A minor'], ['An', 'An An'], ['the', 'The The'], ['the the', 'the'],
  // signs that carry the meaning
  ['C', 'C++'], ['C++', 'C'], ['C#', 'C'], ['=', '=='], ['and', '&'], ['xy', 'x-y'], ['x-y', 'xy'], ['x - y', 'xy'], ['x1', 'x-1'], ['ab', 'a/b'], ['[2, 3)', '(2, 3]'],
  // two answers where one was asked, and letters that are not a word
  ['A, B', 'B'], ['A B', 'B'], ['a or b', 'B'], ['A, B', 'AB'], ['A B', 'AB'], ['a', 'an'],
  // numbers that are not the same number
  ['23', '2, 3'], ['2,3', '23'], ['10', '1 0'], ['21', '2-1'], ['5-3', '53'], ['1', '1/2'], ['.5 kg', '5 kg'], ['two three', '5'],
  ['192.168.1.10', '192.168.1.1'], ['v1.10', 'v1.1'], ['1111111111111111111112', '1111111111111111111111'],
  // a part of the answer, or the note that came with it
  ['TCP', 'TCP/IP'], ['planet', 'Mercury (planet)'], ['NCR', 'Manila (NCR)'], ['OS', 'Windows (OS)'], ['hero', 'Jose Rizal (hero)'], ['star', 'Sun (star)'], ['kernel', 'Linux (kernel)'],
];

describe('comparing a typed answer with the answer key', () => {
  it.each(SAME)('%j is right for %j', (given, accepted) => {
    expect(answersMatch(given, [accepted])).toBe(true);
  });

  it.each(DIFFERENT)('%j is wrong for %j', (given, accepted) => {
    expect(answersMatch(given, [accepted])).toBe(false);
  });

  it('accepts everything the plain comparison accepted before', () => {
    // What was right when answers were compared only without capitals, spacing and a full stop is still right.
    for (const [given, accepted] of [...SAME, ...DIFFERENT]) {
      if (normalizeAnswer(given) !== '' && normalizeAnswer(given) === normalizeAnswer(accepted)) expect(answersMatch(given, [accepted]), `${given} / ${accepted}`).toBe(true);
    }
    for (const text of ['Na', 'x-y', 'C++', '(2, 3]', '192.168.1.1', 'Wi-Fi', 'Niño', 'U.S.A.', '1,000']) expect(answersMatch(` ${text.toUpperCase()}. `, [text]), text).toBe(true);
  });

  it('is right when any of the accepted answers matches', () => {
    expect(answersMatch('city of manila', ['Manila', 'City of Manila'])).toBe(true);
    expect(answersMatch('Quezon City', ['Manila', 'City of Manila'])).toBe(false);
    expect(answersMatch('Manila', [])).toBe(false);
    expect(answersMatch('Manila', undefined)).toBe(false);
    expect(answersMatch(8, ['eight'])).toBe(true);
    expect(answersMatch(null, ['eight'])).toBe(false);
  });

  it('compares as written when the question asks for it', () => {
    const exact = { exact: true };
    expect(answersMatch('Na', ['Na'], exact)).toBe(true);
    expect(answersMatch(' Na. ', ['Na'], exact)).toBe(true);
    for (const given of ['NA', 'na', 'the Na', 'N a', 'N.a']) expect(answersMatch(given, ['Na'], exact), given).toBe(false);
    expect(answersMatch('Nino', ['Niño'], exact)).toBe(false);
    expect(answersMatch('8', ['eight'], exact)).toBe(false);
    expect(answersMatch('', ['Na'], exact)).toBe(false);
  });

  it('takes several accepted answers given at once, where a list is allowed', () => {
    const key = ['keyboard', 'mouse', 'scanner', 'microphone'];
    const list = { list: true };
    for (const given of ['keyboard, mouse', 'Keyboard and Mouse', 'a keyboard; a mouse; a scanner', 'mouse & scanner', 'keyboard\nmouse', 'keyboard, mouse, and scanner']) {
      expect(answersMatch(given, key, list), given).toBe(true);
    }
    // One item that is not accepted makes the whole answer wrong.
    expect(answersMatch('keyboard, monitor', key, list)).toBe(false);
    expect(answersMatch('keyboard mouse', key, list)).toBe(false);
    // Without the option, a list is not an answer.
    expect(answersMatch('keyboard, mouse', key)).toBe(false);
    // An accepted answer that has a comma or "and" in it is still found whole.
    expect(answersMatch('Research and Development', ['research and development'], list)).toBe(true);
    expect(answersMatch('Rizal, Jose', ['Rizal, Jose'], list)).toBe(true);
    // Never with an exact comparison.
    expect(answersMatch('keyboard, mouse', key, { list: true, exact: true })).toBe(false);
  });

  it('stays quick on a very long answer', () => {
    const long = `${'word '.repeat(4000)}end`;
    const started = Date.now();
    expect(answersMatch(long, ['CPU', 'Central Processing Unit (CPU)'], { list: true })).toBe(false);
    expect(answersMatch(`${'1,'.repeat(3000)}1`, ['CPU'], { list: true })).toBe(false);
    expect(answersMatch('a'.repeat(20_000), ['a'.repeat(20_000)])).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('tells a sentence from a phrase', () => {
    expect(isSentence('Central Processing Unit')).toBe(false);
    expect(isSentence('one two three four five six')).toBe(false);
    expect(isSentence('Because ice is less dense than liquid water')).toBe(true);
  });
});
