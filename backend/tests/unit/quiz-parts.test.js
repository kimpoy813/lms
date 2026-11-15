// The parts of a quiz (src/lib/quizParts.js): which part a question belongs to, the order in
// which questions are given, and the parts a finished order shows.
import { describe, expect, it } from 'vitest';
import { arrangeQuestions, hasNamedParts, hasParts, partTitle, partsInOrder, planParts, sectionType } from '../../src/lib/quizParts.js';

let nextId = 0;
const q = (type, section = null) => ({ id: (nextId += 1), type, section });
const ids = (arranged) => arranged.map((entry) => entry.item.id);
const titles = (arranged) => [...new Set(arranged.map((entry) => entry.part.title))];

// A paper as a teacher builds it: three named parts, questions added out of order, some without a part name.
function paper() {
  const mc = 'Part I. Multiple Choice';
  const tf = 'Part II. True or False';
  return [
    q('MULTIPLE_CHOICE', mc), q('MULTIPLE_CHOICE', mc), q('TRUE_FALSE', tf), q('ESSAY'), q('MULTIPLE_CHOICE', 'PART I:  MULTIPLE CHOICE'),
    q('TRUE_FALSE'), q('ESSAY'), q('MULTIPLE_CHOICE', mc), q('TRUE_FALSE', tf), q('TRUE_FALSE', tf),
  ];
}

describe('the name of a part', () => {
  it('drops the numbering a teacher wrote in front of it', () => {
    expect(partTitle('Part I. Multiple Choice')).toBe('Multiple Choice');
    expect(partTitle('TEST II: TRUE OR FALSE')).toBe('TRUE OR FALSE');
    expect(partTitle('III. Identification')).toBe('Identification');
    expect(partTitle('A. Matching Type')).toBe('Matching Type');
    expect(partTitle('Section B – Enumeration (2 points each)')).toBe('Enumeration (2 points each)');
    expect(partTitle('Essay')).toBe('Essay');
    // Words that only look like numbering stay.
    expect(partTitle('Part of speech')).toBe('Part of speech');
    expect(partTitle('Identification')).toBe('Identification');
    expect(partTitle('Vocabulary')).toBe('Vocabulary');
    // Nothing but a number: no title of its own.
    expect(partTitle('Part III')).toBeNull();
    expect(partTitle('Test I.')).toBeNull();
    expect(partTitle('  ')).toBeNull();
    expect(partTitle(null)).toBeNull();
  });

  it('tells which kind of question a heading speaks of', () => {
    expect(sectionType('Part II. True or False')).toBe('TRUE_FALSE');
    expect(sectionType('Modified True or False')).toBe('MODIFIED_TRUE_FALSE');
    expect(sectionType('Test I – Multiple Choice')).toBe('MULTIPLE_CHOICE');
    expect(sectionType('Enumeration')).toBe('SHORT_ANSWER');
    expect(sectionType('Part IV')).toBeNull();
    expect(sectionType(null)).toBeNull();
  });
});

describe('which part a question belongs to', () => {
  it('goes by the part name, whatever its capitals and punctuation', () => {
    const plan = planParts(paper());
    expect(plan.parts.map((p) => p.title)).toEqual(['Multiple Choice', 'True or False', 'Essay']);
    expect(plan.parts.map((p) => p.label)).toEqual(['Part I. Multiple Choice', 'Part II. True or False', null]);
    expect(plan.keyOf(q('MULTIPLE_CHOICE', 'part i - multiple choice'))).toBe(plan.parts[0].key);
  });

  it('puts a question without a part name with the questions of its kind', () => {
    const plan = planParts(paper());
    // Into the named part that speaks of its kind…
    expect(plan.keyOf(q('TRUE_FALSE'))).toBe(plan.parts[1].key);
    // …and otherwise into a part called after the kind.
    expect(plan.keyOf(q('ESSAY'))).toBe(plan.parts[2].key);
    expect(plan.keyOf(q('MATCHING'))).toBe('k:MATCHING');
  });

  it('names a part that has only a number after the kind of its questions', () => {
    const plan = planParts([q('IDENTIFICATION', 'Part I'), q('IDENTIFICATION', 'Part I'), q('ESSAY', 'Part II'), q('TRUE_FALSE', 'Part II')]);
    expect(plan.parts.map((p) => p.title)).toEqual(['Identification', null]);
  });

  it('knows whether a quiz has part names at all', () => {
    expect(hasNamedParts(paper())).toBe(true);
    expect(hasNamedParts([q('ESSAY'), q('TRUE_FALSE', '   ')])).toBe(false);
    expect(hasNamedParts([])).toBe(false);
  });

  it('knows whether a quiz has parts worth keeping together', () => {
    // Named by the teacher: always.
    expect(hasParts([q('ESSAY', 'Part I'), q('TRUE_FALSE', 'Part II')])).toBe(true);
    // Several kinds, and more than one question of a kind.
    expect(hasParts([q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('MULTIPLE_CHOICE')])).toBe(true);
    // One kind only, or every question of another kind: a list, not a paper in parts.
    expect(hasParts([q('MULTIPLE_CHOICE'), q('MULTIPLE_CHOICE'), q('MULTIPLE_CHOICE')])).toBe(false);
    expect(hasParts([q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('ESSAY')])).toBe(false);
    expect(hasParts([])).toBe(false);
  });
});

describe('the order in which questions are given', () => {
  it('is the teacher’s own order for a quiz without parts that is not shuffled', () => {
    const list = [q('ESSAY'), q('TRUE_FALSE'), q('ESSAY'), q('MULTIPLE_CHOICE')];
    expect(ids(arrangeQuestions(list))).toEqual(list.map((x) => x.id));
  });

  it('keeps the questions of a part together, the parts in the order they first appear', () => {
    const list = paper();
    const arranged = arrangeQuestions(list, { byParts: true });
    const [a, b, c, d, e, f, g, h, i, j] = list.map((x) => x.id);
    expect(ids(arranged)).toEqual([a, b, e, h, c, f, i, j, d, g]);
    expect(titles(arranged)).toEqual(['Multiple Choice', 'True or False', 'Essay']);
  });

  it('shuffles inside each part only, and never the parts', () => {
    const list = paper();
    const plain = ids(arrangeQuestions(list, { byParts: true }));
    const groups = [plain.slice(0, 4), plain.slice(4, 8), plain.slice(8)];
    const seen = new Set();
    for (let round = 0; round < 60; round += 1) {
      const arranged = arrangeQuestions(list, { byParts: true, shuffleWithin: true });
      const order = ids(arranged);
      seen.add(order.join(','));
      expect(titles(arranged)).toEqual(['Multiple Choice', 'True or False', 'Essay']);
      // Every part holds exactly its own questions, in its own place.
      expect([...order.slice(0, 4)].sort()).toEqual([...groups[0]].sort());
      expect([...order.slice(4, 8)].sort()).toEqual([...groups[1]].sort());
      expect([...order.slice(8)].sort()).toEqual([...groups[2]].sort());
    }
    // …and the order inside the parts does change from student to student.
    expect(seen.size).toBeGreaterThan(10);
  });

  it('groups a shuffled quiz without part names by the kind of question', () => {
    const list = [q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('MULTIPLE_CHOICE'), q('ESSAY'), q('TRUE_FALSE'), q('MULTIPLE_CHOICE')];
    for (let round = 0; round < 20; round += 1) {
      const arranged = arrangeQuestions(list, { byParts: true, shuffleWithin: true });
      expect(arranged.map((entry) => entry.item.type)).toEqual(['MULTIPLE_CHOICE', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'TRUE_FALSE', 'ESSAY']);
      expect(titles(arranged)).toEqual(['Multiple choice', 'True or false', 'Essay']);
    }
  });

  it('takes the order of the parts from everything the quiz may give, not from what was drawn', () => {
    // A quiz that draws its questions: the draw may start with any part, the parts still come in the order of the outline.
    const outline = [q('IDENTIFICATION', 'Part I. Identification'), q('ESSAY', 'Part II. Essay'), q('IDENTIFICATION', 'Part I. Identification'), q('ESSAY', 'Part II. Essay')];
    const drawn = [outline[3], outline[2]];
    const arranged = arrangeQuestions(drawn, { outline, byParts: true, shuffleWithin: true });
    expect(ids(arranged)).toEqual([outline[2].id, outline[3].id]);
    // A question that the outline does not know still finds a part of its own, after the others.
    const stray = q('MATCHING');
    expect(titles(arrangeQuestions([stray, ...drawn], { outline, byParts: true }))).toEqual(['Identification', 'Essay', 'Matching']);
  });

  it('works on whatever carries a question', () => {
    const list = [{ question: q('ESSAY'), points: 5 }, { question: q('TRUE_FALSE'), points: 1 }, { question: q('ESSAY'), points: 5 }];
    const arranged = arrangeQuestions(list, { question: (item) => item.question, byParts: true });
    expect(arranged.map((entry) => entry.item.question.type)).toEqual(['ESSAY', 'ESSAY', 'TRUE_FALSE']);
    expect(arrangeQuestions([], { byParts: true, shuffleWithin: true })).toEqual([]);
  });
});

describe('the parts that an order shows', () => {
  const given = (list, options) => arrangeQuestions(list, options).map((entry, i) => ({ type: entry.item.type, part: entry.part, points: i < 4 ? 1 : 2.5 }));

  it('lists each part with where it starts, how many questions it has and what it is worth', () => {
    const { parts, partOf } = partsInOrder(given(paper(), { byParts: true, shuffleWithin: true }));
    expect(parts).toEqual([
      { title: 'Multiple Choice', first: 0, count: 4, points: 4 },
      { title: 'True or False', first: 4, count: 4, points: 10 },
      { title: 'Essay', first: 8, count: 2, points: 5 },
    ]);
    expect(partOf).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
  });

  it('shows the parts of an unshuffled quiz without part names when its kinds come one after the other', () => {
    const list = [q('MULTIPLE_CHOICE'), q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('ESSAY')];
    expect(partsInOrder(given(list)).parts.map((p) => [p.title, p.first, p.count])).toEqual([['Multiple choice', 0, 2], ['True or false', 2, 1], ['Essay', 3, 1]]);
  });

  it('shows no parts where the order does not go part by part', () => {
    // The teacher mixed the kinds on purpose: a part would come up twice.
    const mixed = [q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('MULTIPLE_CHOICE')];
    expect(partsInOrder(given(mixed))).toEqual({ parts: [], partOf: [null, null, null] });
    // One single part is no parts.
    expect(partsInOrder(given([q('ESSAY'), q('ESSAY')])).parts).toEqual([]);
    expect(partsInOrder([])).toEqual({ parts: [], partOf: [] });
    // Neither are three questions of three kinds: every "part" would be one question.
    expect(partsInOrder(given([q('MULTIPLE_CHOICE'), q('TRUE_FALSE'), q('ESSAY')])).parts).toEqual([]);
    // …unless the teacher named them parts.
    expect(partsInOrder(given([q('MULTIPLE_CHOICE', 'Part I'), q('ESSAY', 'Part II')], { byParts: true })).parts.map((p) => [p.title, p.count])).toEqual([['Multiple choice', 1], ['Essay', 1]]);
  });

  it('reads an attempt from before parts were kept by the kinds of its questions', () => {
    // Such a snapshot has no `part`.
    expect(partsInOrder([{ type: 'TRUE_FALSE', points: 1 }, { type: 'ESSAY', points: 5 }, { type: 'ESSAY', points: 5 }]).parts).toEqual([
      { title: 'True or false', first: 0, count: 1, points: 1 },
      { title: 'Essay', first: 1, count: 2, points: 10 },
    ]);
    expect(partsInOrder([{ type: 'ESSAY' }, { type: 'TRUE_FALSE' }, { type: 'ESSAY' }]).parts).toEqual([]);
  });
});
