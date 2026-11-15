// A short answer that is a sentence is checked by its key words (src/lib/keyWords.js).
// These are the examples the rules were made from: what must be right, half right and wrong.
import { describe, expect, it } from 'vitest';
import { checkShortAnswer, keyWords, keyWordsNeeded, stem, wordsOf } from '../../src/lib/keyWords.js';

const words = (accepted, question, chosen) => keyWords(accepted, question, chosen)?.map((key) => key.word) ?? null;
/** The verdict in short: "1 KEY_WORDS", "0.5 KEY_WORDS", "1 KEY_WORDS? NOT" (a doubt, and why), "0 NONE"… */
const verdict = (given, accepted, options) => {
  const check = checkShortAnswer(given, [accepted].flat(), options);
  return `${check.share} ${check.how}${check.doubt ? `? ${check.doubt.why}` : ''}`;
};

describe('the forms of a word', () => {
  it('brings the forms of one word together', () => {
    const families = [
      ['solve', 'solves', 'solved', 'solving', 'solution'],
      ['process', 'processes', 'processed', 'processing'],
      ['compute', 'computer', 'computers', 'computing', 'computation'],
      ['store', 'stores', 'stored', 'storing', 'storage'],
      ['instruction', 'instructions'], ['memory', 'memories'], ['permanent', 'permanently'],
      ['lose', 'loses', 'losing', 'lost', 'loss'], ['keep', 'keeps', 'kept'], ['write', 'writes', 'wrote', 'written', 'writing'],
      ['mouse', 'mice'], ['virus', 'viruses'], ['bus', 'buses'], ['analysis', 'analyses', 'analyze', 'analyse'],
      ['fast', 'faster', 'fastest'], ['large', 'larger', 'largest'], ['dense', 'denser', 'density'],
      ['program', 'programs', 'programme', 'programmes'],
    ];
    for (const family of families) expect(new Set(family.map(stem)).size, family.join(' ')).toBe(1);
  });

  it('keeps different words apart', () => {
    const pairs = [['process', 'processor'], ['print', 'printer'], ['program', 'programmer'], ['input', 'output'], ['hardware', 'software'], ['bit', 'byte'], ['volatile', 'nonvolatile'], ['ram', 'rom']];
    for (const [a, b] of pairs) expect(stem(a), `${a} / ${b}`).not.toBe(stem(b));
  });

  it('follows the Porter stemmer', () => {
    // From the paper that defines it.
    const vocabulary = {
      caresses: 'caress', ponies: 'poni', cats: 'cat', agreed: 'agre', plastered: 'plaster', motoring: 'motor', sing: 'sing', conflated: 'conflat', sized: 'size', hopping: 'hop',
      falling: 'fall', filing: 'file', happy: 'happi', sky: 'sky', relational: 'relat', conditional: 'condit', digitizer: 'digit', operator: 'oper', hopefulness: 'hope',
      formalize: 'formal', electrical: 'electr', goodness: 'good', revival: 'reviv', adjustable: 'adjust', replacement: 'replac', adoption: 'adopt', effective: 'effect', rate: 'rate',
      cease: 'ceas', controll: 'control', roll: 'roll',
    };
    for (const [word, expected] of Object.entries(vocabulary)) expect(stem(word), word).toBe(expected);
  });
});

describe('the words of a sentence', () => {
  const kinds = (text) => wordsOf(text).map((token) => `${token.word}:${token.kind}`).join(' ');

  it('tells words that carry meaning from small words, numbers and "not"', () => {
    expect(kinds('It is a step-by-step procedure.')).toBe('it:stop is:stop a:stop step:word by:stop step:word procedure:word');
    expect(kinds("RAM doesn't keep 1,000 files")).toBe('ram:word doesnt:not keep:word 1000:number files:word');
    expect(kinds('twenty-one bits, 2.50 volts, 50 percent')).toBe('21:number bits:word 2.5:number volts:word 50%:number');
    expect(kinds('one of the U.S.A. states')).toBe('one:stop of:stop the:stop usa:word states:word');
    expect(kinds('<p>What is C++ &amp; C#?</p>')).toBe('what:stop is:stop c++:word c#:word');
    expect(kinds('Ang wika ay isang sistema ng komunikasyon')).toBe('ang:stop wika:word ay:stop isang:stop sistema:word ng:stop komunikasyon:word');
  });

  it('reads "non-volatile" as one word, and "not as" as a comparison', () => {
    expect(kinds('non-volatile, non volatile, nonvolatile')).toBe('nonvolatile:word nonvolatile:word nonvolatile:word');
    expect(kinds('not as fast, not only cheap, not here')).toBe('not:stop as:stop fast:word not:stop only:stop cheap:word not:not here:stop');
    expect(kinds('no power, never, cannot, hindi')).toBe('no:not power:word never:not cannot:not hindi:not');
  });
});

describe('the key words of an accepted answer', () => {
  it('are the words that carry meaning, as the teacher wrote them', () => {
    expect(words('A step-by-step procedure for solving a problem')).toEqual(['step', 'procedure', 'solving', 'problem']);
    expect(words('The CPU executes instructions and it also processes all the Data')).toEqual(['CPU', 'executes', 'instructions', 'processes', 'Data']);
    expect(words('A byte is a unit of data that is made of eight bits')).toEqual(['byte', 'unit', 'data', 'made', 'eight', 'bits']);
  });

  it('leave out what the question already gives', () => {
    expect(words('An algorithm is a step-by-step procedure for solving a problem', '<p>What is an <strong>algorithm</strong>?</p>')).toEqual(['step', 'procedure', 'solving', 'problem']);
    expect(words('The contents of RAM are lost when the computer is turned off', 'What happens to the contents of RAM when the computer is turned off?')).toEqual(['lost']);
    // An accepted answer that only repeats the question is taken as it stands.
    expect(words('The computer is turned off and the contents of RAM', 'What happens to the contents of RAM when the computer is turned off?')).toEqual(['computer', 'turned', 'contents', 'RAM']);
  });

  it('are only looked for in a sentence', () => {
    expect(words('Central Processing Unit')).toBeNull();
    expect(words('Basic Input Output System')).toBeNull();
    expect(words('American Standard Code for Information Interchange')).toBeNull();
    expect(words('It stores data')).toBeNull();
    // More than six words, or four and more that state something.
    expect(words('It stores data permanently')).toEqual(['stores', 'data', 'permanently']);
    expect(words('It is an input device', 'What is a keyboard?')).toEqual(['input', 'device']);
    // Small words alone are no key words.
    expect(words('it is what it is to be')).toBeNull();
  });

  it('take a word in capitals for a name', () => {
    expect(words('The IT department looks after the computers of the school')).toEqual(['IT', 'department', 'looks', 'computers', 'school']);
    expect(words('An AND gate gives 1 only when both inputs are 1')).toEqual(['AND', 'gate', 'gives', '1', 'inputs']);
    // …unless everything is in capitals.
    expect(wordsOf('IT IS NOT LOST').map((token) => token.kind)).toEqual(['stop', 'stop', 'not', 'word']);
  });
});

describe('checking a sentence by its key words', () => {
  const algorithm = 'A step-by-step procedure for solving a problem';
  const about = { question: 'What is an algorithm?' };

  it('two thirds of the key words or more is right, a third or more is half right', () => {
    expect(verdict('a step by step procedure to solve a problem', algorithm, about)).toBe('1 KEY_WORDS');
    expect(verdict('It is a procedure that solves problems step by step.', algorithm, about)).toBe('1 KEY_WORDS');
    expect(verdict('a procedure to solve problems', algorithm, about)).toBe('1 KEY_WORDS'); // 3 of 4
    expect(verdict('a procedure for a problem', algorithm, about)).toBe('0.5 KEY_WORDS'); // 2 of 4
    expect(verdict('a procedure', algorithm, about)).toBe('0 KEY_WORDS'); // 1 of 4
    expect(verdict('a kind of software', algorithm, about)).toBe('0 KEY_WORDS');
    expect(checkShortAnswer('a procedure for a problem', [algorithm], about)).toEqual({ share: 0.5, how: 'KEY_WORDS', doubt: null, accepted: algorithm, found: ['procedure', 'problem'], missing: ['step', 'solving'] });
  });

  it('takes two key words at least for half the points: one word in common is not half an answer', () => {
    // How many of so many key words: [right from, half right from].
    const needed = (all) => [keyWordsNeeded(all).right, keyWordsNeeded(all).half];
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map(needed)).toEqual([[1, null], [2, 1], [2, null], [3, 2], [4, 2], [4, 2], [5, 3], [6, 3], [6, 3], [8, 4]]);
    // Of three key words: two is right, one is nothing.
    const disk = 'It stores data permanently';
    const does = { question: 'What does a hard disk do?' };
    expect(words(disk, does.question)).toEqual(['stores', 'data', 'permanently']);
    expect(verdict('to store data', disk, does)).toBe('1 KEY_WORDS');
    expect(verdict('for permanent storage of data and programs', disk, does)).toBe('1 KEY_WORDS');
    expect(verdict('it processes data', disk, does)).toBe('0 KEY_WORDS');
    // Of two: one is half.
    const keyboard = 'It is an input device';
    expect(words(keyboard, 'What is a keyboard?')).toEqual(['input', 'device']);
    expect(verdict('a device used for input', keyboard, { question: 'What is a keyboard?' })).toBe('1 KEY_WORDS');
    expect(verdict('a device', keyboard, { question: 'What is a keyboard?' })).toBe('0.5 KEY_WORDS');
    // Of one: that one.
    expect(verdict('They are lost', 'The contents of RAM are lost when the computer is turned off', { question: 'What happens to the contents of RAM when the computer is turned off?' })).toBe('1 KEY_WORDS');
    // Of eight: three is half. The first half of a long accepted answer is not nothing.
    const system = 'It manages the hardware and software resources of the computer and provides services to programs';
    expect(checkShortAnswer('manages hardware and software', [system], { question: 'What does an operating system do?' })).toMatchObject({ share: 0.5, found: ['manages', 'hardware', 'software'] });
    expect(verdict('manages resources', system, { question: 'What does an operating system do?' })).toBe('0 KEY_WORDS');
  });

  it('counts the same answer as before, and the same words in any order', () => {
    expect(verdict('A STEP-BY-STEP PROCEDURE FOR SOLVING A PROBLEM.', algorithm, about)).toBe('1 SAME');
    expect(verdict('the step-by-step procedures for solving the problem', algorithm, about)).toBe('1 WORDS');
    expect(verdict('for solving a problem: a procedure, step by step', algorithm, about)).toBe('1 KEY_WORDS');
  });

  it('finds a key word in another form, with a slip, and written together or apart', () => {
    const disk = 'A hard disk stores programs and files permanently, even when the computer is off';
    const q = { question: 'What does it do?' };
    expect(words(disk, q.question)).toEqual(['hard', 'disk', 'stores', 'programs', 'files', 'permanently', 'computer']);
    expect(checkShortAnswer('the harddisk is a permanent storage of program and file in a computer', [disk], q).missing).toEqual([]);
    expect(checkShortAnswer('hard disc storing progams and flies permanantly on computers', [disk], q).missing).toEqual(['disk', 'files']);
    const board = 'The motherboard is the main circuit board that connects all the parts';
    expect(checkShortAnswer('the mother board, main circut board connecting all the parts', [board], q).missing).toEqual([]);
    // A slip is one letter in a long word. A short word, or another word, is not a slip.
    expect(checkShortAnswer('ROM is the memory that keeps data and files and things', ['RAM is the memory that keeps data and files and things'], q).missing).toEqual(['RAM']);
    expect(checkShortAnswer('it is asynchronous and the signal is sent and received at once', ['It is synchronous and the signal is sent and received at once'], q).missing).toEqual(['synchronous']);
  });

  it('does not count what the question gives', () => {
    const lost = 'The contents of RAM are lost when the computer is turned off';
    const q = { question: 'What happens to the contents of RAM when the computer is turned off?' };
    expect(verdict('They are lost', lost, q)).toBe('1 KEY_WORDS');
    expect(verdict('RAM loses its contents', lost, q)).toBe('1 KEY_WORDS');
    expect(verdict('The contents of RAM stay when the computer is turned off', lost, q)).toBe('0 KEY_WORDS');
  });

  it('needs the numbers of the accepted answer for full marks', () => {
    const byte = 'A byte is a unit of data that is made of eight bits';
    const q = { question: 'What is a byte?' };
    expect(verdict('a unit of data with 8 bits', byte, q)).toBe('1 KEY_WORDS');
    expect(verdict('a unit made of eigth bits of data', byte, q)).toBe('1 KEY_WORDS');
    expect(verdict('a unit of data made of 16 bits', byte, q)).toBe('0.5 KEY_WORDS');
    expect(verdict('a unit of data made of bits', byte, q)).toBe('0.5 KEY_WORDS');
  });

  // The words are there, and the answer may still say the opposite: that is left to the teacher.
  describe('the doubts it sees', () => {
    const lost = 'The contents of RAM are lost when the computer is turned off';
    const q = { question: 'What happens to the contents of RAM when the computer is turned off?' };

    it('one of the two says "not" about a word they share', () => {
      expect(verdict('They are not lost', lost, q)).toBe('1 KEY_WORDS? NOT');
      expect(verdict('RAM never loses them', lost, q)).toBe('1 KEY_WORDS? NOT');
      expect(verdict('Nothing is lost', lost, q)).toBe('1 KEY_WORDS? NOT');
      expect(checkShortAnswer('They are not lost', [lost], q).doubt).toEqual({ why: 'NOT', words: ['lost'], side: 'ANSWER' });
      // The word is given as the one who denies it wrote it.
      expect(checkShortAnswer('It does not hold programs and data', ['It holds the programs and the data that are in use']).doubt).toEqual({ why: 'NOT', words: ['hold'], side: 'ANSWER' });
      expect(checkShortAnswer('ROM loses its contents', ['ROM does not lose its contents when the power is off'], { question: 'What happens to ROM without power?' }).doubt).toEqual({ why: 'NOT', words: ['lose'], side: 'ACCEPTED' });
      expect(verdict('It is not a step by step procedure for solving a problem', algorithm, about)).toBe('1 KEY_WORDS? NOT');
      // The accepted answer says "not", and the answer does not.
      const backup = 'So that the files are not lost when the hard disk fails';
      expect(verdict('so we never lose files if the harddisk fails', backup, { question: 'Why back up?' })).toBe('1 KEY_WORDS');
      expect(checkShortAnswer('files are lost when the hard disk fails', [backup], { question: 'Why back up?' }).doubt).toEqual({ why: 'NOT', words: ['lost'], side: 'ACCEPTED' });
      const rom = 'ROM is memory whose contents cannot be changed by the user';
      expect(verdict('the user can not change its contents', rom, { question: 'What is ROM?' })).toBe('1 KEY_WORDS');
      expect(verdict('its contents can be changed by the user', rom, { question: 'What is ROM?' })).toBe('1 KEY_WORDS? NOT');
      // Also about a word that the question gives.
      const volatile = 'RAM is volatile because it loses its data when the power is turned off';
      expect(verdict('RAM is not volatile, it loses data when power is off', volatile, { question: 'Is RAM volatile? Explain.' })).toBe('1 KEY_WORDS? NOT');
      expect(verdict('Hindi ito nawawala kapag pinatay ang computer', 'Nawawala ang laman ng RAM kapag pinatay ang computer', { question: 'Ano ang nangyayari?' })).toBe('0.5 KEY_WORDS? NOT');
    });

    it('a "not" about something else is no doubt', () => {
      expect(verdict('It is not software, it is a procedure for solving a problem step by step', algorithm, about)).toBe('1 KEY_WORDS');
      expect(verdict("it doesn't have any moving parts, so it is faster", 'An SSD is faster because it has no moving parts inside it', { question: 'Why?' })).toBe('1 KEY_WORDS');
      expect(verdict('No moving parts, so it is faster', 'An SSD is faster because it has no moving parts inside it', { question: 'Why?' })).toBe('1 KEY_WORDS');
      // No doubt about an answer that the key words give nothing to.
      expect(verdict('it is not software', algorithm, about)).toBe('0 KEY_WORDS');
      // "Not as … as" compares, and "without" says when.
      expect(verdict('because ice is not as dense as liquid water', 'Because ice is less dense than liquid water', { question: 'Why?' })).toBe('1 KEY_WORDS');
      expect(verdict('Without power RAM loses everything, since it is volatile', 'RAM is volatile memory and it loses its data when the power is off', { question: 'Explain.' })).toBe('1 KEY_WORDS');
    });

    it('one begins with "yes" and the other with "no"', () => {
      const ram = 'No, RAM is temporary storage because it loses data when the power is off';
      const permanent = { question: 'Is RAM permanent storage? Explain.' };
      expect(checkShortAnswer('Yes, it loses data when the power is off', [ram], permanent)).toMatchObject({ share: 1, doubt: { why: 'REPLY', words: ['Yes', 'No'] } });
      expect(verdict('No, it loses data when the power is off', ram, permanent)).toBe('1 KEY_WORDS');
      expect(verdict('No it loses data when the power is off', ram, permanent)).toBe('1 KEY_WORDS');
      expect(verdict('it is temporary and loses data without power', ram, permanent)).toBe('1 KEY_WORDS');
      const hindi = 'Hindi, dahil nawawala ang laman nito kapag walang kuryente ang computer';
      expect(verdict('Oo, dahil nawawala ang laman nito kapag walang kuryente', hindi, { question: 'Permanente ba ang RAM?' })).toBe('1 KEY_WORDS? REPLY');
      expect(verdict('Hindi, dahil nawawala ang laman nito kapag walang kuryente', hindi, { question: 'Permanente ba ang RAM?' })).toBe('1 KEY_WORDS');
    });

    it('the answer has the opposite of a word of the accepted answer', () => {
      const ice = 'Because ice is less dense than liquid water';
      const float = { question: 'Why does ice float?' };
      expect(checkShortAnswer('ice is more dense than liquid water', [ice], float)).toMatchObject({ share: 1, doubt: { why: 'OPPOSITE', words: ['more dense', 'less dense'] } });
      expect(checkShortAnswer('ice is denser than liquid water', [ice], float).doubt).toEqual({ why: 'OPPOSITE', words: ['denser', 'less dense'] });
      expect(checkShortAnswer('It is denser', ['Ice floats because it is less dense'], float)).toMatchObject({ share: 1, doubt: { why: 'OPPOSITE', words: ['denser', 'less dense'] } });
      // An answer that the key words give nothing to is wrong, and raises no doubt.
      expect(checkShortAnswer('it is denser', [ice], float)).toMatchObject({ share: 0, doubt: null });
      expect(checkShortAnswer('ice has more mass and floats in liquid water, being less heavy', ['Ice has less mass for its size and floats in liquid water'], float).doubt).toEqual({ why: 'OPPOSITE', words: ['more mass', 'less mass'] });
      expect(checkShortAnswer('it has more parts and uses less power', ['It has fewer parts and so it uses less power'], float).doubt).toEqual({ why: 'OPPOSITE', words: ['more parts', 'fewer parts'] });
      // "Lower density" says what "less dense" says, and "higher density" the opposite.
      expect(verdict('ice has a lower density than liquid water', ice, float)).toBe('1 KEY_WORDS');
      expect(verdict('the density of ice is lower than the density of liquid water', ice, float)).toBe('1 KEY_WORDS');
      expect(checkShortAnswer('ice has a higher density than liquid water', [ice], float).doubt).toEqual({ why: 'OPPOSITE', words: ['higher density', 'less dense'] });
      expect(verdict('ice is less dense than water', ice, float)).toBe('1 KEY_WORDS');
      // Said of something else: "water is denser" says what "ice is less dense" says.
      expect(verdict('Liquid water is denser, so the ice stays on top', ice, float)).toBe('1 KEY_WORDS');
      const keyboard = 'A keyboard is an input device because it sends data into the computer';
      const kind = { question: 'What kind of device is a keyboard?' };
      expect(verdict('It is an output device because it sends data into the computer', keyboard, kind)).toBe('1 KEY_WORDS? OPPOSITE');
      expect(verdict('an input device, it sends data to the computer', keyboard, kind)).toBe('1 KEY_WORDS');
      expect(verdict('a record is a column in a table of a database', 'A record is one row of a table in a database', { question: 'What is a record?' })).toBe('1 KEY_WORDS? OPPOSITE');
      expect(verdict('RAM is slower than the hard disk since it is electronic', 'RAM is faster than a hard disk because it is fully electronic', { question: 'Compare RAM and a hard disk.' })).toBe('0.5 KEY_WORDS? OPPOSITE');
      expect(verdict('RAM is slower than the hard disk since it is an electronic memory', 'RAM is faster than a hard disk because it is an electronic memory', { question: 'Compare RAM and a hard disk.' })).toBe('1 KEY_WORDS? OPPOSITE');
      // An accepted answer that has both sides says nothing by either.
      expect(verdict('it gives output after processing the input', 'A computer takes input, processes it and gives output to the user', { question: 'What does a computer do?' })).toBe('1 KEY_WORDS');
      // What something does, turned round.
      const firewall = 'A firewall prevents unauthorized access to a network';
      const does = { question: 'What does a firewall do?' };
      expect(checkShortAnswer('A firewall allows unauthorized access to a network', [firewall], does)).toMatchObject({ share: 1, doubt: { why: 'OPPOSITE', words: ['allows', 'prevents'] } });
      expect(verdict('it stops unauthorized access to the network', firewall, does)).toBe('1 KEY_WORDS');
      expect(verdict('The reaction releases heat to its surroundings', 'The reaction absorbs heat from its surroundings', { question: 'What happens in an endothermic reaction?' })).toBe('1 KEY_WORDS? OPPOSITE');
      expect(verdict('The file is saved when the program is opened', 'The file is saved when the program is closed', { question: 'When is the file saved?' })).toBe('0.5 KEY_WORDS? OPPOSITE');
      // The answer that has the word of the accepted answer too says it its own way.
      expect(verdict('it is easy to read, not difficult like machine code, and close to human language', 'A language that is close to human language and easy to read', { question: 'What is a high-level language?' })).toBe('1 KEY_WORDS');
    });

    it('one says "on" where the other says "off"', () => {
      const when = { question: 'When does RAM lose its contents?' };
      const off = 'When the computer is turned off';
      expect(checkShortAnswer('when the computer is turned on', [off], when)).toMatchObject({ share: 1, doubt: { why: 'OPPOSITE', words: ['on', 'off'] } });
      expect(verdict('if you turn off the computer', off, when)).toBe('1 KEY_WORDS');
      expect(verdict('once the computer is turned off, not while it is turned on', off, when)).toBe('1 KEY_WORDS');
      const rom = 'It keeps its data even when the power is off';
      const why = { question: 'Why is ROM non-volatile?' };
      expect(verdict('It keeps its data even when the power is on', rom, why)).toBe('1 KEY_WORDS? OPPOSITE');
      expect(checkShortAnswer('it keeps its data when the power is off', ['It keeps its data only while the power is on'], why).doubt).toEqual({ why: 'OPPOSITE', words: ['off', 'on'] });
      // "On" a thing is a place, not a state.
      expect(verdict('it keeps the data on its chip even without power', rom, why)).toBe('1 KEY_WORDS');
      expect(verdict('the data stored on the chip is kept when the power is off', rom, why)).toBe('1 KEY_WORDS');
      expect(verdict('the power may be off: the data is still on it', rom, why)).toBe('1 KEY_WORDS');
    });

    it('both compare with "than", and not with the same thing', () => {
      const ice = 'Because ice is less dense than liquid water';
      const float = { question: 'Why does ice float?' };
      expect(verdict('water is less dense than ice', ice, float)).toBe('1 KEY_WORDS? COMPARISON');
      expect(verdict('its density is lower than that of water', ice, float)).toBe('1 KEY_WORDS');
      const ram = 'RAM is faster than a hard disk because it is fully electronic';
      const compare = { question: 'Compare RAM and a hard disk.' };
      expect(verdict('a hard disk is faster than RAM because it is electronic', ram, compare)).toBe('1 KEY_WORDS? COMPARISON');
      expect(verdict('RAM is faster than hard disks: it has only electronic parts', ram, compare)).toBe('1 KEY_WORDS');
    });

    it('"volatile" is the opposite of "non-volatile", and "not volatile" is the same', () => {
      const rom = 'ROM is non-volatile memory that keeps its contents without power';
      const q = { question: 'What is ROM?' };
      expect(checkShortAnswer('ROM is volatile memory that keeps its contents without power', [rom], q).doubt).toEqual({ why: 'OPPOSITE', words: ['volatile', 'non-volatile'] });
      expect(checkShortAnswer('it is not volatile, it keeps its contents without power', [rom], q)).toMatchObject({ share: 1, doubt: null, missing: ['memory'] });
      expect(checkShortAnswer('both are non-volatile memory of the computer', ['Both are not volatile memory of the computer'], { question: 'What do ROM and a hard disk have in common?' })).toMatchObject({ share: 1, doubt: null, missing: [] });
      expect(checkShortAnswer('a virus is a living particle that needs a host cell to reproduce', ['A virus is a non-living particle that needs a host cell to reproduce'], { question: 'What is a virus?' }).doubt).toEqual({ why: 'OPPOSITE', words: ['living', 'non-living'] });
      expect(verdict('a particle that is not living and needs a host to reproduce', 'A virus is a non-living particle that needs a host cell to reproduce', { question: 'What is a virus?' })).toBe('1 KEY_WORDS');
      // "With no power" says what "without power" says, and what "when the power is off" says.
      expect(verdict('a nonvolatile memory, keeps contents with no power', rom, q)).toBe('1 KEY_WORDS');
      expect(verdict('it is volatile: it loses its data when there is no power', 'RAM is volatile memory and it loses its data when the power is off', { question: 'Explain.' })).toBe('1 KEY_WORDS');
    });

    it('two things have changed places', () => {
      const memory = 'RAM is volatile and ROM is non-volatile';
      const q = { question: 'What is the difference between RAM and ROM?' };
      expect(checkShortAnswer('ROM is volatile and RAM is non-volatile', [memory], q)).toMatchObject({ share: 1, doubt: { why: 'PAIRING', words: ['ROM', 'volatile', 'non-volatile'] } });
      expect(checkShortAnswer('RAM is not volatile and ROM is volatile', [memory], q)).toMatchObject({ share: 1, doubt: { why: 'PAIRING', words: ['RAM', 'not volatile', 'volatile'] } });
      // The same, said the other way round or in other words.
      expect(verdict('ROM is non-volatile and RAM is volatile', memory, q)).toBe('1 WORDS');
      expect(verdict('RAM is volatile but ROM is not volatile', memory, q)).toBe('1 KEY_WORDS');
      expect(verdict('RAM is volatile. ROM is non-volatile.', memory, q)).toBe('1 KEY_WORDS');
      const parts = 'Hardware is the physical parts of a computer, while software is the programs that run on it';
      expect(verdict('Software is the physical parts of a computer, while hardware is the programs that run on it', parts, { question: 'Differentiate hardware and software.' })).toBe('1 KEY_WORDS? PAIRING');
      expect(verdict('Software is the programs that run on a computer and hardware is its physical parts', parts, { question: 'Differentiate hardware and software.' })).toBe('1 KEY_WORDS');
      // The items of a list may come in any order.
      const disk = 'A hard disk stores programs and files permanently, even when the computer is off';
      expect(verdict('the harddisk stores files and programs permanently', disk, { question: 'What does it do?' })).toBe('1 KEY_WORDS');
      // Seen only where both parts say what something is or has: who does what is not looked at.
      const devices = 'Input devices send data to the computer and output devices show the results';
      const does = { question: 'What do input and output devices do?' };
      expect(verdict('Input devices show the results, output devices send data to the computer', devices, does)).toBe('1 KEY_WORDS');
      expect(verdict('Output devices show results and input devices send data to the computer', devices, does)).toBe('1 WORDS');
    });

    it('a comparison that is turned round as a whole says the same', () => {
      const ice = 'Because ice is less dense than liquid water';
      const float = { question: 'Why does ice float?' };
      expect(verdict('liquid water is denser than ice', ice, float)).toBe('1 KEY_WORDS');
      expect(verdict('Liquid water is more dense than ice', ice, float)).toBe('1 KEY_WORDS');
      // "Slower" then stands for the key word "faster".
      const ram = 'RAM is faster than a hard disk because it is fully electronic';
      expect(checkShortAnswer('a hard disk is slower than RAM, which is electronic', [ram], { question: 'Compare RAM and a hard disk.' })).toMatchObject({ share: 1, doubt: null, missing: [] });
      const ssd = 'An SSD has fewer moving parts than a hard disk, so it is faster and more reliable';
      expect(verdict('a hard disk has more moving parts than an SSD so the SSD is faster and more reliable', ssd, { question: 'Why choose an SSD?' })).toBe('1 KEY_WORDS');
      expect(verdict('a hard disk has fewer moving parts than an SSD, so it is faster and more reliable', ssd, { question: 'Why choose an SSD?' })).toBe('1 KEY_WORDS? COMPARISON');
      expect(verdict('liquid water has a higher density than ice', ice, float)).toBe('1 KEY_WORDS');
      expect(verdict('liquid water has a lower density than ice', ice, float)).toBe('1 KEY_WORDS? COMPARISON');
      // Compared with nearly the same thing is not compared with the same thing.
      const language = 'A high-level language is closer to human language than a low-level language';
      expect(verdict('a low-level language is closer to human language than a high-level language', language, { question: 'What is a high-level language?' })).toBe('1 KEY_WORDS? COMPARISON');
      expect(verdict('closer to the language of humans than a low-level language is', language, { question: 'What is a high-level language?' })).toBe('1 KEY_WORDS');
    });
  });

  it('takes the accepted answer that the student comes closest to', () => {
    const accepted = ['A set of instructions that tells the computer what to do', 'Software that is written in a programming language to perform a task', 'application'];
    const q = { question: 'What is a program?' };
    expect(checkShortAnswer('instructions that tell a computer what to do', accepted, q)).toMatchObject({ share: 1, accepted: accepted[0], missing: ['set'] });
    expect(checkShortAnswer('software written in a programming language', accepted, q)).toMatchObject({ share: 0.5, accepted: accepted[1], missing: ['perform', 'task'] });
    expect(checkShortAnswer('An application.', accepted, q)).toMatchObject({ share: 1, how: 'SAME' });
    expect(checkShortAnswer('a game', accepted, q)).toMatchObject({ share: 0, how: 'KEY_WORDS' });
  });

  it('works in Filipino as in English', () => {
    const wika = 'Ang wika ay isang sistema ng komunikasyon na ginagamit ng mga tao';
    const q = { question: 'Ano ang wika?' };
    expect(words(wika, q.question)).toEqual(['sistema', 'komunikasyon', 'tao']);
    expect(verdict('sistema ng komunikasyon ng tao', wika, q)).toBe('1 KEY_WORDS');
    expect(verdict('ito ay komunikasyon', wika, q)).toBe('0 KEY_WORDS');
    expect(verdict('hindi ko alam', wika, q)).toBe('0 KEY_WORDS');
  });
});

describe('the teacher says whether key words are looked for', () => {
  const memory = { question: 'What do we call RAM, for what happens to it without power?' };

  it('for a word or a phrase, where the teacher asks for them', () => {
    expect(words('volatile memory')).toBeNull();
    expect(words('volatile memory', '', true)).toEqual(['volatile', 'memory']);
    expect(words('Photosynthesis', '', true)).toEqual(['Photosynthesis']);
    expect(verdict('memory that is volatile', 'volatile memory', memory)).toBe('0 NONE');
    expect(verdict('memory that is volatile', 'volatile memory', { ...memory, keyWords: true })).toBe('1 KEY_WORDS');
    expect(verdict('it is a memory of the volatile kind', 'volatile memory', { ...memory, keyWords: true })).toBe('1 KEY_WORDS');
    expect(verdict('it is the volatile kind', 'volatile memory', { ...memory, keyWords: true })).toBe('0.5 KEY_WORDS');
    // It may say the opposite: left to the teacher, as for a sentence.
    expect(verdict('non-volatile memory', 'volatile memory', { ...memory, keyWords: true })).toBe('0.5 KEY_WORDS? OPPOSITE');
    expect(verdict('it is not a volatile memory', 'volatile memory', { ...memory, keyWords: true })).toBe('1 KEY_WORDS? NOT');
    // One word: the answer has to have it.
    const plants = { question: 'How do plants make their food?', keyWords: true };
    expect(verdict('They use photosynthesis to make it', 'Photosynthesis', plants)).toBe('1 KEY_WORDS');
    expect(verdict('by photosynthesys', 'Photosynthesis', plants)).toBe('1 KEY_WORDS');
    expect(verdict('from the soil', 'Photosynthesis', plants)).toBe('0 KEY_WORDS');
    // A sentence without "is" or "it" is not seen as one, until the teacher says so.
    const sun = 'The earth revolves around the sun';
    expect(verdict('the earth goes around the sun once a year, it revolves', sun, { question: 'Why do we have years?' })).toBe('0 NONE');
    expect(verdict('the earth goes around the sun once a year, it revolves', sun, { question: 'Why do we have years?', keyWords: true })).toBe('1 KEY_WORDS');
  });

  it('for no accepted answer, where the teacher says so', () => {
    const algorithm = 'A step-by-step procedure for solving a problem';
    expect(words(algorithm, '', false)).toBeNull();
    expect(verdict('a procedure to solve problems step by step', algorithm, { keyWords: false })).toBe('0 NONE');
    expect(verdict('the step-by-step procedure for solving a problem', algorithm, { keyWords: false })).toBe('1 WORDS');
    // …and never where the answer has to be exactly as written.
    expect(verdict('a procedure to solve problems step by step', algorithm, { keyWords: true, exact: true })).toBe('0 NONE');
  });
});

describe('checking a word or a phrase', () => {
  const accepted = ['volatile memory', 'Random Access Memory (RAM)'];

  it('is right as before, and with small words added or left out', () => {
    expect(verdict('Volatile Memory.', accepted)).toBe('1 SAME');
    expect(verdict('RAM', accepted)).toBe('1 SAME');
    expect(verdict('volatile memories', accepted)).toBe('1 WORDS');
    expect(verdict('it was the volatile memory', accepted)).toBe('1 WORDS');
    expect(verdict('brain of computer', 'the brain of the computer')).toBe('1 WORDS');
    expect(verdict('analog-to-digital converters', 'analog to digital converter')).toBe('1 WORDS');
  });

  it('is right without the words that the question gives, and with them', () => {
    const memory = { question: 'What type of memory is RAM?' };
    expect(verdict('volatile', accepted, memory)).toBe('1 WORDS');
    expect(verdict('RAM is volatile', accepted, memory)).toBe('1 WORDS');
    expect(verdict('RAM is volatile memory', accepted, memory)).toBe('1 WORDS');
    expect(verdict('volatile memory', 'volatile', memory)).toBe('1 WORDS');
    expect(verdict('the volatile type of memory', 'volatile', memory)).toBe('1 WORDS');
    expect(verdict('non-volatile', accepted, memory)).toBe('0 NONE');
    expect(verdict('ROM is volatile memory', accepted, memory)).toBe('0 NONE');
    expect(verdict('volatile storage', 'volatile', memory)).toBe('0 NONE');
    // Left out or added, not both: that would be another answer.
    const typing = { question: 'What kind of device is a keyboard: input or output?' };
    expect(verdict('input for typing', 'input device for typing', typing)).toBe('1 WORDS');
    expect(verdict('output device for typing', 'input device for typing', typing)).toBe('0 NONE');
    expect(verdict('it processes data', 'The CPU processes data', { question: 'What does the CPU do?' })).toBe('1 WORDS');
    const network = { question: 'What do we call a network that covers a small area?' };
    expect(verdict('local', 'local area network', network)).toBe('1 WORDS');
    expect(verdict('wide area network', 'local area network', network)).toBe('0 NONE');
    // An accepted answer that only repeats the question is taken as it stands.
    const either = { question: 'Is a keyboard an input device or an output device?' };
    expect(verdict('an input device', 'input device', either)).toBe('1 SAME');
    expect(verdict('output device', 'input device', either)).toBe('0 NONE');
    expect(verdict('device', 'input device', either)).toBe('0 NONE');
  });

  it('takes several things in any order', () => {
    const units = 'arithmetic logic unit and control unit';
    expect(verdict('control unit and arithmetic logic unit', units)).toBe('1 WORDS');
    expect(verdict('the control unit, the arithmetic logic unit', units)).toBe('1 WORDS');
    expect(verdict('control unit', units)).toBe('0 NONE');
    expect(verdict('control unit and arithmetic unit', units)).toBe('0 NONE');
    expect(verdict('control unit, arithmetic logic unit and memory', units)).toBe('0 NONE');
  });

  it('is the name of a thing: every other word counts, in its order', () => {
    expect(verdict('OR gate', 'AND gate')).toBe('0 NONE');
    expect(verdict('the and gate', 'AND gate')).toBe('1 SAME');
    expect(verdict('gate', 'NOT gate')).toBe('0 NONE');
    expect(verdict('for loop', 'while loop')).toBe('0 NONE');
    expect(verdict('while loop', 'do while loop')).toBe('0 NONE');
    expect(verdict('digital to analog converter', 'analog to digital converter')).toBe('0 NONE');
    expect(verdict('memory that is volatile', accepted)).toBe('0 NONE');
    expect(verdict('Basic Input System', 'Basic Input Output System')).toBe('0 NONE');
    expect(verdict('has-a relationship', 'is-a relationship')).toBe('0 NONE');
    expect(verdict('support', 'IT support')).toBe('0 NONE');
    expect(verdict('vitamin', 'vitamin A')).toBe('0 NONE');
    expect(verdict('vitamin B', 'vitamin A')).toBe('0 NONE');
  });

  it('is not looked for inside a longer answer, and not given half', () => {
    expect(verdict('volatile memory because it loses data', accepted)).toBe('0 NONE');
    expect(verdict('volatile memory and non-volatile memory', accepted)).toBe('0 NONE');
    expect(verdict('non-volatile memory', accepted)).toBe('0 NONE');
    expect(verdict('not volatile memory', accepted)).toBe('0 NONE');
    expect(verdict('memory', accepted)).toBe('0 NONE');
    expect(verdict('memory access random', accepted)).toBe('0 NONE');
    expect(verdict('more dense than water', 'less dense than water')).toBe('0 NONE');
    expect(verdict('after the program runs', 'before the program runs')).toBe('0 NONE');
  });

  it('keeps numbers and single letters in their order', () => {
    expect(verdict('1101, 10', '1101 10')).toBe('1 SAME');
    expect(verdict('10 1101', '1101 10')).toBe('0 NONE');
    expect(verdict('y x', 'x y')).toBe('0 NONE');
  });

  it('is exact where the question asks for that, and nothing for no answer', () => {
    const sentence = 'A step-by-step procedure for solving a problem right now';
    expect(verdict('a procedure for solving a problem step by step right now', sentence, { exact: true })).toBe('0 NONE');
    expect(verdict(sentence, sentence, { exact: true })).toBe('1 SAME');
    expect(verdict('   ', sentence)).toBe('0 NONE');
    expect(verdict('procedure', [])).toBe('0 NONE');
  });
});
