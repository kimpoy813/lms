// Unit tests for the upgraded built-in zero-key AI engine (aiBuiltin.js + aiBuiltinKnowledge.js).
import { describe, expect, it } from 'vitest';
import { keyWordsOf, normalizeQuestion, usesKeyWords } from '../../src/lib/quizScoring.js';
import { analyzeMaterial, builtinCompletion, matchKnowledge } from '../../src/services/aiBuiltin.js';
import { listKnowledgeDomains } from '../../src/services/aiBuiltinKnowledge.js';

const ALL_TYPES = [
  'MULTIPLE_CHOICE',
  'MULTIPLE_RESPONSE',
  'TRUE_FALSE',
  'IDENTIFICATION',
  'SHORT_ANSWER',
  'FILL_BLANKS',
  'MATCHING',
  'ORDERING',
  'ESSAY',
];

async function runTask(kind, input) {
  const out = await builtinCompletion({ task: { kind, input }, json: kind !== 'assistant' });
  return kind === 'assistant' ? out.content : JSON.parse(out.content);
}

describe('built-in zero-key AI engine (smarter extraction & curriculum knowledge)', () => {
  it('matches curriculum domains cleanly without substring false positives', () => {
    expect(listKnowledgeDomains().length).toBeGreaterThanOrEqual(20);
    expect(matchKnowledge('Binary Search and Merge Sort')[0].id).toBe('sorting-searching');
    expect(matchKnowledge('SQL Joins and Normalization')[0].id).toBe('sql-databases');
    expect(matchKnowledge('1987 Philippine Constitution Bill of Rights')[0].id).toBe('philippine-civics');
    expect(matchKnowledge('ADPIE Nursing Process & Hand Hygiene')[0].id).toBe('nursing-health');
    // Substring traps (e.g., "c" or "html" inside unrelated words) should not match erroneously.
    expect(matchKnowledge('Aquaculture Tilapia Pond Hydrology')).toEqual([]);
  });

  it('extracts definitions without leading articles, protects abbreviations, and finds comparisons & cause-effect', () => {
    const sections = [
      {
        title: 'Lesson 1: Relational Basics',
        body: [
          'Welcome to this module about relational design.',
          'A primary key is a column or minimal set of columns that uniquely identifies each row, e.g. student_id.',
          'In relational systems, a foreign key refers to an attribute linking child rows to a parent primary key.',
          'Unlike INNER JOIN, LEFT JOIN preserves unmatched rows from the left table.',
          'Because normalization removes duplicate facts, update anomalies are eliminated cleanly.',
          'Hypertext Transfer Protocol (HTTP) powers stateless web requests (e.g. GET and POST).',
        ].join(' '),
      },
    ];
    const parsed = analyzeMaterial(sections);
    expect(parsed.definitions.some((d) => d.term === 'Primary key')).toBe(true);
    expect(parsed.definitions.some((d) => d.term === 'Foreign key')).toBe(true);
    expect(parsed.definitions.some((d) => d.term === 'HTTP')).toBe(true);
    expect(parsed.definitions.some((d) => /^A\s|^The\s/i.test(d.term))).toBe(false);
    expect(parsed.comparisons.length).toBeGreaterThanOrEqual(1);
    expect(parsed.causes.length).toBeGreaterThanOrEqual(1);
    expect(parsed.facts.some((f) => /Welcome to this module/i.test(f.sentence))).toBe(false);
  });

  it('stratifies multi-lesson exams evenly and orders EASY -> MEDIUM -> HARD', async () => {
    const source = [
      'Lesson 1: Glycolysis\nGlycolysis is the anaerobic pathway converting glucose into pyruvate in the cytoplasm. ATP is the primary cellular energy carrier.',
      'Lesson 2: Citric Acid Cycle\nPyruvate oxidation links glycolysis to the citric acid cycle in the mitochondrial matrix. Unlike glycolysis, the citric acid cycle operates inside mitochondria.',
      'Lesson 3: Electron Transport\nOxygen is the final electron acceptor at the end of oxidative phosphorylation. Because protons flow through ATP synthase, cells synthesize high ATP yields.',
    ].join('\n\n');

    const res = await runTask('questions', {
      topic: 'Cellular Respiration',
      source,
      purpose: 'EXAM',
      count: 6,
      types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER'],
      difficulty: 'MIXED',
    });

    expect(res.questions).toHaveLength(6);
    const topics = new Set(res.questions.map((q) => q.topic));
    expect(topics.size).toBe(3);
    expect(res.questions.map((q) => q.difficulty)).toEqual(['EASY', 'EASY', 'MEDIUM', 'MEDIUM', 'HARD', 'HARD']);
    for (const q of res.questions) {
      expect(normalizeQuestion(q).errors).toEqual([]);
    }
    const shortQ = res.questions.find((q) => q.type === 'SHORT_ANSWER');
    expect(usesKeyWords(shortQ)).toBe(true);
    expect(keyWordsOf(shortQ)[0].keyWords.length).toBeGreaterThanOrEqual(2);
  });

  it('produces valid normalizeQuestion() drafts across all 9 question types for topic-only matched & unseen topics', async () => {
    for (const topic of ['Binary Search and Sorting Algorithms', 'Aquaculture Pond Design']) {
      const res = await runTask('questions', {
        topic,
        count: ALL_TYPES.length,
        types: ALL_TYPES,
        difficulty: 'MIXED',
      });
      expect(res.questions).toHaveLength(ALL_TYPES.length);
      for (const q of res.questions) {
        expect(normalizeQuestion(q).errors).toEqual([]);
        expect(q.text).not.toMatch(/\[Draft/i);
      }
    }
    // Matched domain topic should produce genuine domain content rather than generic fallback.
    const sqlRes = await runTask('questions', {
      topic: 'SQL Joins',
      count: 4,
      types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER', 'ORDERING'],
    });
    expect(JSON.stringify(sqlRes)).toMatch(/JOIN|WHERE|HAVING|GROUP BY/i);
  });

  it('builds rich domain-aware modules with worked examples, comparison tables, and Filipino/Bilingual modes', async () => {
    const enMod = await runTask('module', {
      topic: 'SQL Joins & Normalization',
      subtopics: ['Primary and Foreign Keys', 'INNER vs LEFT JOIN'],
      language: 'ENGLISH',
      contentLength: 'STANDARD',
      includeAssessment: true,
    });
    expect(enMod.lessons.length).toBeGreaterThanOrEqual(4);
    expect(enMod.lessons.some((l) => /<table>/i.test(l.contentHtml))).toBe(true);
    expect(enMod.lessons.some((l) => /<pre><code>/i.test(l.contentHtml))).toBe(true);
    expect(enMod.assessment.length).toBeGreaterThanOrEqual(4);
    for (const q of enMod.assessment) expect(normalizeQuestion(q).errors).toEqual([]);

    const filMod = await runTask('module', {
      topic: 'Recursion in Python',
      language: 'FILIPINO',
      contentLength: 'SHORT',
      includeAssessment: false,
    });
    expect(filMod.lessons[0].title).toMatch(/Panimula/i);
    expect(filMod.lessons[filMod.lessons.length - 1].kind).toBe('SUMMARY');

    const words = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
    for (const l of enMod.lessons) {
      expect(words(l.contentHtml)).toBeGreaterThanOrEqual(250);
      expect(l.contentHtml).toMatch(/<h3>/i);
      expect(l.contentHtml).toMatch(/<blockquote>/i);
    }

    // Unseen custom topic should still produce textbook-length chapters, tables, and self-checks.
    const customMod = await runTask('module', {
      topic: 'Philippine Project Management & Agile Delivery',
      subtopics: ['Stakeholder Alignment', 'Sprint Planning', 'Risk Management'],
      contentLength: 'COMPREHENSIVE',
      includeAssessment: true,
    });
    expect(customMod.lessons.length).toBeGreaterThanOrEqual(6);
    for (const l of customMod.lessons) {
      expect(words(l.contentHtml)).toBeGreaterThanOrEqual(300);
    }
    expect(customMod.lessons.some((l) => /<table>/i.test(l.contentHtml))).toBe(true);
    expect(customMod.lessons.some((l) => /Check Your Understanding/i.test(l.contentHtml))).toBe(true);
  });

  it('adapts lesson rewrites to tables, worked examples, self-checks, expanded textbook chapters, and concise bullet takeaways', async () => {
    const lesson = {
      title: 'Binary Search',
      kind: 'LESSON',
      estimatedMinutes: 25,
      contentHtml: '<p>Binary search is a divide-and-conquer algorithm on sorted arrays. Unlike linear search, binary search halves the interval each step.</p>',
    };
    const asTable = await runTask('lesson-rewrite', { lesson, instruction: 'Turn into a comparison table' });
    expect(asTable.contentHtml).toContain('<table>');

    const withExample = await runTask('lesson-rewrite', { lesson, instruction: 'Add a worked example' });
    expect(withExample.contentHtml).toContain('Worked Example');

    const withQuiz = await runTask('lesson-rewrite', { lesson, instruction: 'Add self-check quiz questions' });
    expect(withQuiz.contentHtml).toContain('Self-Check Questions');

    const bullets = await runTask('lesson-rewrite', { lesson, instruction: 'Summarize concisely in bullets' });
    expect(bullets.contentHtml).toContain('<ul>');

    const expanded = await runTask('lesson-rewrite', { lesson, instruction: 'Expand into a full textbook chapter' });
    expect(expanded.contentHtml).toContain('Introduction & Learning Context');
    expect(expanded.contentHtml).toContain('Worked Example');
    expect(expanded.contentHtml).toContain('Check Your Understanding');
    expect(expanded.contentHtml.length).toBeGreaterThan(lesson.contentHtml.length * 4);
  });

  it('drafts tailored assignments, exact-sum rubrics, and intent-aware writing help', async () => {
    const asg = await runTask('assignment', {
      topic: 'Build a SQL Enrollment Query',
      points: 80,
      withRubric: true,
    });
    expect(asg.instructionsHtml).toContain('test cases');
    expect(asg.rubric.criteria.reduce((s, c) => s + c.maxPoints, 0)).toBe(80);

    const nurseRubric = await runTask('rubric', {
      task: 'Clinical Nursing Care Plan Evaluation',
      points: 60,
      criteriaCount: 5,
    });
    expect(nurseRubric.criteria).toHaveLength(5);
    expect(nurseRubric.criteria.reduce((s, c) => s + c.maxPoints, 0)).toBe(60);
    expect(nurseRubric.criteria.some((c) => /Safety|Assessment|Clinical/i.test(c.title))).toBe(true);

    const guide = await runTask('assistant', { prompt: 'Create a study guide for photosynthesis' });
    expect(guide).toMatch(/Calvin cycle|Chlorophyll|Thylakoid/i);

    const warmup = await runTask('assistant', { prompt: 'Give me a warm-up activity for recursion' });
    expect(warmup).toMatch(/Opening Hook|Base case|Stack/i);
  });

  it('generates multi-language programming problems and test cases for matched and custom topics', async () => {
    const palindrome = await runTask('programming', {
      topic: 'Palindrome checker for strings',
      allowedLanguages: ['PYTHON', 'JAVASCRIPT'],
      difficulty: 'EASY',
      testCount: 5,
    });
    expect(palindrome.title).toMatch(/palindrome/i);
    expect(palindrome.allowedLanguages).toEqual(['PYTHON', 'JAVASCRIPT']);
    expect(palindrome.starterCode.PYTHON).toBeTruthy();
    expect(palindrome.starterCode.JAVASCRIPT).toBeTruthy();
    expect(palindrome.testCases).toHaveLength(5);
    expect(palindrome.testCases.some((t) => !t.isHidden)).toBe(true);
    expect(palindrome.testCases.some((t) => t.isHidden)).toBe(true);

    const custom = await runTask('programming', {
      topic: 'Telemetry Sensor Packet Checksum',
      allowedLanguages: ['C'],
      testCount: 3,
    });
    expect(custom.title).toContain('Telemetry Sensor Packet Checksum');
    expect(custom.starterCode.C).toContain('#include');
    expect(custom.testCases).toHaveLength(3);
  });

  it('generates student study coach summaries, flashcards, ungraded practice, and explanations strictly from lesson text', async () => {
    const lesson = {
      lessonTitle: 'TCP vs UDP Transport',
      contentHtml:
        '<p>TCP is a connection-oriented transport protocol that guarantees ordered delivery using acknowledgments. Unlike TCP, UDP is connectionless and prioritizes low overhead for streaming.</p>',
      objectives: ['Contrast TCP and UDP reliability guarantees'],
    };

    const summary = await runTask('study-coach', { ...lesson, mode: 'summary' });
    expect(summary.takeaways.length).toBeGreaterThanOrEqual(1);
    expect(summary.keyTerms.some((t) => t.term === 'TCP')).toBe(true);

    const flashcards = await runTask('study-coach', { ...lesson, mode: 'flashcards' });
    expect(flashcards.cards.length).toBeGreaterThanOrEqual(2);
    expect(flashcards.cards[0]).toMatchObject({ front: expect.any(String), back: expect.any(String) });

    const practice = await runTask('study-coach', { ...lesson, mode: 'practice' });
    expect(practice.questions.length).toBeGreaterThanOrEqual(2);
    for (const q of practice.questions) expect(normalizeQuestion(q).errors).toEqual([]);

    const explain = await runTask('study-coach', { ...lesson, mode: 'explain', question: 'Why use UDP for streaming?' });
    expect(explain.answer).toMatch(/UDP|connectionless|streaming/i);
  });
});
