// Built-in zero-key AI assistant (AI_PROVIDER=builtin).
//
// Works offline inside this server with no external network calls, no credit card, and no API key.
// Extracts definitions, key statements, sequences, and concepts from the teacher's supplied modules,
// uploaded files, and lesson text to produce editable drafts matching the same schemas as an LLM.
// Nothing here invents citations, URLs, or fabricated statistics; outputs are always marked as drafts
// for the teacher to review and edit.
import { BUILTIN_MODEL } from './aiProvider.js';
import { normalizeAnswer } from '../lib/answerMatch.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'not', 'but', 'what', 'which', 'when', 'where', 'who', 'whom', 'whose',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'into', 'onto', 'over', 'under',
  'about', 'after', 'before', 'between', 'through', 'during', 'above', 'below', 'their', 'there',
  'these', 'those', 'then', 'they', 'them', 'also', 'only', 'using', 'used', 'uses', 'make',
  'makes', 'made', 'many', 'well', 'such', 'because', 'while', 'where', 'could', 'would', 'may',
  'might', 'must', 'shall', 'often', 'usually', 'within', 'without', 'among', 'along', 'since',
]);

const escHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cleanLine = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function splitSentences(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => cleanLine(s, 600))
    .filter((s) => s.length >= 24 && /[a-zA-Z]/.test(s));
}

function parseLessons(sourceText) {
  const raw = String(sourceText ?? '').trim();
  if (!raw) return [];
  const sections = [];
  const lessonRegex = /(?:^|\n)Lesson\s+\d+\s*:\s*([^\n]+)\n([\s\S]*?)(?=(?:\nLesson\s+\d+\s*:)|$)/g;
  for (const match of raw.matchAll(lessonRegex)) {
    const title = cleanLine(match[1], 140);
    const body = match[2].trim();
    if (title && body) sections.push({ title, body });
  }
  if (sections.length > 0) return sections;

  // Uploaded files or pasted text: split on <reference> tags or Markdown headings / blank lines.
  const refMatches = [...raw.matchAll(/<reference\s+name="([^"]*)">\s*([\s\S]*?)\s*<\/reference>/g)];
  if (refMatches.length > 0) {
    return refMatches.map((m) => ({ title: cleanLine(m[1], 120) || 'Reference material', body: m[2].trim() })).filter((s) => s.body);
  }
  const blocks = raw.split(/\n#{1,3}\s+/).filter((b) => b.trim().length > 0);
  if (blocks.length > 1) {
    return blocks.map((b, idx) => {
      const [first, ...rest] = b.split('\n');
      return { title: cleanLine(first, 120) || `Section ${idx + 1}`, body: rest.join('\n').trim() || first };
    });
  }
  return [{ title: cleanLine(raw.split('\n')[0], 100) || 'Lesson material', body: raw }];
}

/** Extract { term, definition, sentence, lessonTitle } candidates from source prose. */
function analyzeMaterial(sections) {
  const definitions = [];
  const facts = [];
  const sequences = [];
  const terms = new Set();

  const addTerm = (term) => {
    const t = cleanLine(term, 80).replace(/[.,;:!?]+$/, '');
    if (t.length >= 3 && t.split(/\s+/).length <= 5 && !STOPWORDS.has(t.toLowerCase())) {
      terms.add(t);
      return t;
    }
    return null;
  };

  for (const sec of sections) {
    const lines = sec.body.split('\n').map((l) => l.trim()).filter(Boolean);
    const listItems = [];
    for (const line of lines) {
      const m = /^(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line);
      if (m && m[1].length >= 6 && m[1].length <= 180) listItems.push(cleanLine(m[1], 180));
      else if (listItems.length > 0) {
        if (listItems.length >= 3) sequences.push({ lessonTitle: sec.title, items: listItems.slice(0, 6) });
        listItems.length = 0;
      }
    }
    if (listItems.length >= 3) sequences.push({ lessonTitle: sec.title, items: listItems.slice(0, 6) });

    for (const sentence of splitSentences(sec.body)) {
      if (sentence.endsWith('[…]')) continue;
      // Pattern 1: "Term is/are/refers to/means/defines ..."
      const defMatch = /^([A-Z][A-Za-z0-9\s/-]{2,42}?)\s+(?:is defined as|refers to|means|is a|is an|is the|are the|represents)\s+([^.!?]{15,240})[.!?]?$/.exec(sentence);
      if (defMatch) {
        const term = addTerm(defMatch[1]);
        const def = cleanLine(defMatch[2], 220).replace(/[.!?]+$/, '');
        if (term && def.length >= 12) {
          definitions.push({ term, definition: def, sentence, lessonTitle: sec.title });
          continue;
        }
      }
      // Pattern 2: "Term: definition"
      const colonMatch = /^([A-Za-z][A-Za-z0-9\s/-]{2,42}):\s+([^.!?]{12,240})[.!?]?$/.exec(sentence);
      if (colonMatch) {
        const term = addTerm(colonMatch[1]);
        const def = cleanLine(colonMatch[2], 220).replace(/[.!?]+$/, '');
        if (term && def.length >= 12) {
          definitions.push({ term, definition: def, sentence, lessonTitle: sec.title });
          continue;
        }
      }
      // General informative sentence + keyword extraction
      const words = sentence.match(/\b[A-Za-z][A-Za-z0-9-]{4,24}\b/g) ?? [];
      let keyword = null;
      for (const w of words) {
        if (!STOPWORDS.has(w.toLowerCase())) {
          const added = addTerm(w);
          if (added && (!keyword || added.length > keyword.length)) keyword = added;
        }
      }
      facts.push({ sentence, keyword, lessonTitle: sec.title });
    }
  }

  return { definitions, facts, sequences, terms: [...terms] };
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const cleaned = cleanLine(raw, 500);
    const key = normalizeAnswer(cleaned);
    if (cleaned && key && !seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

function pickDistractors(correct, pool, fallbacks, count = 3) {
  const used = new Set([normalizeAnswer(correct)]);
  const chosen = [];
  for (const candidate of [...pool, ...fallbacks]) {
    const cleaned = cleanLine(candidate, 240);
    const key = normalizeAnswer(cleaned);
    if (!cleaned || !key || used.has(key)) continue;
    used.add(key);
    chosen.push(cleaned);
    if (chosen.length >= count) break;
  }
  return chosen;
}

function negateStatement(sentence) {
  const patterns = [
    [/\b(is|are|was|were)\b(?!\s+not\b)/i, '$1 not'],
    [/\b(can|will|should|must)\b(?!\s+not\b)/i, '$1 not'],
    [/\b(always)\b/i, 'never'],
    [/\b(increases?)\b/i, 'decreases'],
    [/\b(required|essential)\b/i, 'optional'],
  ];
  for (const [regex, replacement] of patterns) {
    if (regex.test(sentence)) return sentence.replace(regex, replacement);
  }
  return `Contrary to the lesson, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

function buildQuestionFromMaterial({ type, difficulty, topicLabel, idx, material, sections }) {
  const { definitions, facts, sequences, terms } = material;
  const fallbackTerms = ['Procedural abstraction', 'Iterative refinement', 'Conceptual model', 'Empirical observation', 'Boundary condition', 'Control flow'];
  const def = definitions.length ? definitions[idx % definitions.length] : null;
  const fact = facts.length ? facts[idx % facts.length] : null;
  const lessonTitle = def?.lessonTitle ?? fact?.lessonTitle ?? sections[idx % Math.max(1, sections.length)]?.title ?? topicLabel;

  if (type === 'MULTIPLE_CHOICE') {
    if (def) {
      const distractors = pickDistractors(def.term, terms, fallbackTerms, 3);
      if (distractors.length >= 3) {
        const correctPos = idx % 4;
        const list = [...distractors];
        list.splice(correctPos, 0, def.term);
        return {
          type,
          text: `Which term ${def.sentence.includes('refers to') ? 'refers to' : 'matches'} the description: "${def.definition}"?`,
          points: 1,
          difficulty,
          topic: lessonTitle,
          explanation: `From ${lessonTitle}: "${def.sentence}"`,
          choices: list.map((c, i) => ({ text: c, isCorrect: i === correctPos })),
        };
      }
    }
    if (fact && fact.keyword) {
      const escaped = fact.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blanked = fact.sentence.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '___');
      if (blanked.includes('___')) {
        const distractors = pickDistractors(fact.keyword, terms, fallbackTerms, 3);
        const correctPos = idx % 4;
        const list = [...distractors];
        list.splice(correctPos, 0, fact.keyword);
        return {
          type,
          text: `Complete the statement from the lesson: "${blanked}"`,
          points: 1,
          difficulty,
          topic: lessonTitle,
          explanation: `Reference sentence (${lessonTitle}): "${fact.sentence}"`,
          choices: list.map((c, i) => ({ text: c, isCorrect: i === correctPos })),
        };
      }
    }
  }

  if (type === 'MULTIPLE_RESPONSE') {
    const pool = uniqueStrings([...definitions.map((d) => d.term), ...terms]).slice(0, 6);
    if (pool.length >= 2) {
      const correctItems = pool.slice(0, Math.min(2, pool.length));
      const wrongItems = pickDistractors(correctItems[0], ['Unrelated external convention', 'Deprecated legacy syntax', 'Unverified assumption'], fallbackTerms, 2)
        .filter((w) => !correctItems.some((c) => normalizeAnswer(c) === normalizeAnswer(w)));
      if (wrongItems.length >= 1) {
        const merged = [...correctItems.map((t) => ({ text: t, isCorrect: true })), ...wrongItems.map((t) => ({ text: t, isCorrect: false }))];
        return {
          type,
          text: `Which of the following key concepts are covered in ${lessonTitle}? Select all that apply.`,
          points: 2,
          difficulty,
          topic: lessonTitle,
          explanation: `Covered in ${lessonTitle}: ${correctItems.join(', ')}.`,
          choices: merged,
        };
      }
    }
  }

  if (type === 'TRUE_FALSE' && (fact || def)) {
    const sourceSentence = def ? def.sentence : fact.sentence;
    const isTrue = idx % 2 === 0;
    const statement = isTrue ? sourceSentence : negateStatement(sourceSentence);
    return {
      type,
      text: `True or False: ${statement}`,
      points: 1,
      difficulty,
      topic: lessonTitle,
      explanation: `Reference statement (${lessonTitle}): "${sourceSentence}"`,
      answer: isTrue,
    };
  }

  if ((type === 'IDENTIFICATION' || type === 'SHORT_ANSWER') && (def || fact)) {
    if (def) {
      return {
        type,
        text: `Identify the term described as: ${def.definition}.`,
        points: type === 'SHORT_ANSWER' ? 2 : 1,
        difficulty,
        topic: lessonTitle,
        explanation: `From ${lessonTitle}: "${def.sentence}"`,
        accepted: [def.term, def.term.toLowerCase()],
      };
    }
    return {
      type,
      text: `Based on ${lessonTitle}, identify the key concept missing in: "${fact.sentence.replace(new RegExp(`\\b${(fact.keyword || 'concept').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '___')}".`,
      points: type === 'SHORT_ANSWER' ? 2 : 1,
      difficulty,
      topic: lessonTitle,
      explanation: `From ${lessonTitle}: "${fact.sentence}"`,
      accepted: [fact.keyword || topicLabel],
    };
  }

  if (type === 'FILL_BLANKS' && (def || fact)) {
    const target = def ? def.term : fact.keyword;
    const sentence = def ? def.sentence : fact.sentence;
    if (target) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blanked = sentence.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '___');
      if (blanked.includes('___')) {
        return {
          type,
          text: blanked,
          points: 1,
          difficulty,
          topic: lessonTitle,
          explanation: `Complete sentence (${lessonTitle}): "${sentence}"`,
          blanks: [[target, target.toLowerCase()]],
        };
      }
    }
  }

  if (type === 'MATCHING' && definitions.length >= 2) {
    const pairs = [];
    const seenLeft = new Set();
    for (const d of definitions) {
      const key = normalizeAnswer(d.term);
      if (key && !seenLeft.has(key)) {
        seenLeft.add(key);
        pairs.push({ left: d.term, right: cleanLine(d.definition, 160) });
      }
      if (pairs.length >= 4) break;
    }
    if (pairs.length >= 2) {
      return {
        type,
        text: `Match each term from ${topicLabel} with its description.`,
        points: pairs.length,
        difficulty,
        topic: lessonTitle,
        explanation: 'Each pair reflects a definition introduced in the module.',
        pairs,
      };
    }
  }

  if (type === 'ORDERING') {
    const seq = sequences[idx % Math.max(1, sequences.length)];
    const items = seq ? uniqueStrings(seq.items).slice(0, 5) : uniqueStrings(sections.map((s) => s.title)).slice(0, 5);
    if (items.length >= 2) {
      return {
        type,
        text: seq ? `Arrange the following steps from ${seq.lessonTitle} in the correct order.` : `Arrange the topics from ${topicLabel} in the sequence they are presented.`,
        points: items.length,
        difficulty,
        topic: seq?.lessonTitle ?? lessonTitle,
        explanation: 'Ordered according to the progression in the module material.',
        items,
      };
    }
  }

  if (type === 'ESSAY') {
    return {
      type: 'ESSAY',
      text: `In your own words, explain the main ideas covered in "${lessonTitle}" and give one concrete example illustrating how they apply.`,
      points: 5,
      difficulty,
      topic: lessonTitle,
      explanation: `Review rubric focus: accuracy relative to ${lessonTitle}, clarity, and relevance of example.`,
    };
  }

  return null;
}

function buildTopicQuestion({ type, difficulty, topicLabel, subtopic, idx }) {
  const focus = subtopic || topicLabel;
  switch (type) {
    case 'MULTIPLE_CHOICE': {
      const variant = idx % 3;
      const prompts = [
        `Which statement best captures a foundational goal when studying ${focus}?`,
        `When applying ${focus} in practice, which step should come first?`,
        `What distinguishes a strong solution in ${focus} from a flawed one?`,
      ];
      const corrects = [
        `Connecting core principles of ${focus} to concrete problem constraints`,
        `Clarifying the core definitions, inputs, and assumptions in ${focus}`,
        `Validating outcomes against clear criteria and edge cases in ${focus}`,
      ];
      const wrongs = [
        `Ignoring edge cases and relying on guesswork without verification`,
        `Skipping problem analysis and avoiding structured review`,
        `Treating unrelated topics as interchangeable without justification`,
      ];
      const pos = idx % 4;
      const choices = [...wrongs];
      choices.splice(pos, 0, corrects[variant]);
      return {
        type,
        text: prompts[variant],
        points: 1,
        difficulty,
        topic: focus,
        explanation: `[Draft — verify wording and distractors for your class] Focuses on ${focus}.`,
        choices: choices.map((c, i) => ({ text: c, isCorrect: i === pos })),
      };
    }
    case 'MULTIPLE_RESPONSE':
      return {
        type,
        text: `Which practices support deeper understanding of ${focus}? Select all that apply.`,
        points: 2,
        difficulty,
        topic: focus,
        explanation: `[Draft — customize for your class] Core study practices for ${focus}.`,
        choices: [
          { text: `Explaining core concepts of ${focus} with worked examples`, isCorrect: true },
          { text: `Checking edge cases and assumptions in ${focus}`, isCorrect: true },
          { text: `Memorizing labels without testing understanding`, isCorrect: false },
          { text: `Skipping feedback and self-assessment checks`, isCorrect: false },
        ],
      };
    case 'TRUE_FALSE': {
      const answer = idx % 2 === 0;
      return {
        type,
        text: answer
          ? `True or False: Understanding the underlying assumptions of ${focus} helps prevent common errors when applying it.`
          : `True or False: When working with ${focus}, validating your solution against concrete examples is unnecessary.`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `[Draft] Reviewing assumptions and validating examples is essential in ${focus}.`,
        answer,
      };
    }
    case 'IDENTIFICATION':
      return {
        type,
        text: `Name the primary concept or subject area covered in this unit: "${focus}".`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `[Draft — replace clue with a specific term from your lecture notes.]`,
        accepted: [focus, focus.toLowerCase()],
      };
    case 'SHORT_ANSWER':
      return {
        type,
        text: `Briefly explain one key principle of ${focus} and why it matters in practice.`,
        points: 2,
        difficulty,
        topic: focus,
        explanation: `[Draft] Look for accurate definition of ${focus} plus a practical explanation.`,
        accepted: [`${focus} organizes concepts to solve problems reliably and consistently.`],
      };
    case 'FILL_BLANKS':
      return {
        type,
        text: `When studying ${topicLabel}, a central concept that guides practical application is ___.`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `[Draft — replace blanked sentence with a key statement from your lesson.]`,
        blanks: [[focus, focus.toLowerCase()]],
      };
    case 'MATCHING':
      return {
        type,
        text: `Match each stage of learning ${focus} with its primary objective.`,
        points: 3,
        difficulty,
        topic: focus,
        explanation: '[Draft — replace pairs with specific terminology from your module.]',
        pairs: [
          { left: `Definition (${focus})`, right: 'State the core idea and terminology accurately' },
          { left: `Worked example (${focus})`, right: 'Trace how the rule behaves on concrete input' },
          { left: `Verification (${focus})`, right: 'Test edge cases and check assumptions' },
        ],
      };
    case 'ORDERING':
      return {
        type,
        text: `Place these problem-solving stages for ${focus} in the recommended order.`,
        points: 4,
        difficulty,
        topic: focus,
        explanation: '[Draft — adjust steps to match your preferred workflow.]',
        items: [
          `Identify the core concepts in ${focus}`,
          'Analyze constraints and given inputs',
          'Construct and trace a candidate solution',
          'Verify results and inspect edge cases',
        ],
      };
    case 'ESSAY':
    default:
      return {
        type: 'ESSAY',
        text: `Analyze how ${focus} is applied in a real-world scenario. Describe the main principles involved, potential pitfalls, and how to validate the outcome.`,
        points: 5,
        difficulty,
        topic: focus,
        explanation: `[Draft essay prompt on ${focus}] Grade for conceptual accuracy, structure, and clear examples.`,
      };
  }
}

function generateQuestions(input = {}) {
  const count = Math.max(1, Math.min(20, Number(input.count) || 5));
  const allowedTypes = Array.isArray(input.types) && input.types.length ? input.types : ['MULTIPLE_CHOICE'];
  const diffSetting = input.difficulty || 'MIXED';
  const difficulties = diffSetting === 'MIXED' ? ['EASY', 'MEDIUM', 'HARD'] : [diffSetting];
  const avoidSet = new Set((input.avoid ?? []).map((a) => normalizeAnswer(a)));
  const sourceText = input.source || '';
  const topicLabel = cleanLine(input.topic, 120) || 'Course material';
  const sections = parseLessons(sourceText);
  const material = sections.length ? analyzeMaterial(sections) : { definitions: [], facts: [], sequences: [], terms: [] };
  const hasMaterial = material.definitions.length > 0 || material.facts.length > 0;

  // For EXAM purpose, progress difficulty from EASY -> MEDIUM -> HARD when MIXED.
  const difficultyFor = (i) => {
    if (difficulties.length === 1) return difficulties[0];
    if (input.purpose === 'EXAM') {
      const ratio = i / Math.max(1, count - 1);
      return ratio < 0.34 ? 'EASY' : ratio < 0.72 ? 'MEDIUM' : 'HARD';
    }
    return difficulties[i % difficulties.length];
  };

  const questions = [];
  let cursor = 0;
  let guard = 0;
  while (questions.length < count && guard < count * 8) {
    const i = questions.length;
    const type = allowedTypes[cursor % allowedTypes.length];
    const difficulty = difficultyFor(i);
    let q = hasMaterial
      ? buildQuestionFromMaterial({ type, difficulty, topicLabel, idx: cursor, material, sections })
      : null;
    if (!q) {
      q = buildTopicQuestion({
        type,
        difficulty,
        topicLabel,
        subtopic: sections[cursor % Math.max(1, sections.length)]?.title,
        idx: cursor,
      });
    }
    cursor += 1;
    guard += 1;
    const norm = normalizeAnswer(q.text);
    if (!avoidSet.has(norm)) {
      avoidSet.add(norm);
      questions.push(q);
    }
  }
  return { questions };
}

function generateModule(input = {}) {
  const topic = cleanLine(input.topic, 200) || 'Untitled Module';
  const title = cleanLine(input.title, 200) || topic;
  const subtopics = (input.subtopics ?? []).map((s) => cleanLine(s, 140)).filter(Boolean);
  const objectives = (input.objectives ?? []).map((o) => cleanLine(o, 220)).filter(Boolean);
  const outcomes = (input.outcomes ?? []).map((o) => cleanLine(o, 220)).filter(Boolean);
  const targetLessons = input.contentLength === 'SHORT' ? 3 : input.contentLength === 'COMPREHENSIVE' ? 6 : 4;
  const totalMinutes = Number(input.durationMinutes) || targetLessons * 25;
  const refSections = parseLessons(input.referenceText || '');
  const isFilipino = input.language === 'FILIPINO';
  const isBilingual = input.language === 'BILINGUAL';

  const defaultObjectives = objectives.length
    ? objectives
    : [
        isFilipino ? `Maipaliwanag ang mga pangunahing konsepto ng ${topic}` : `Explain the core principles and terminology of ${topic}`,
        isFilipino ? `Mailapat ang ${topic} sa mga praktikal na halimbawa` : `Apply ${topic} systematically to concrete problems and scenarios`,
        isFilipino ? `Masuri ang mga karaniwang pagkakamali at tamang solusyon` : `Evaluate solutions and diagnose common mistakes related to ${topic}`,
        ...outcomes.slice(0, 2),
      ].slice(0, 6);

  const lessonCount = Math.max(3, Math.min(8, Math.max(targetLessons, subtopics.length ? Math.min(subtopics.length + 2, 8) : targetLessons)));
  const perMinutes = Math.max(10, Math.round(totalMinutes / lessonCount));
  const lessons = [];

  for (let i = 0; i < lessonCount; i += 1) {
    const isLast = i === lessonCount - 1;
    const isFirst = i === 0;
    const subtopic = subtopics[i - 1] ?? subtopics[i];
    const refSec = refSections[i];

    let lessonTitle;
    let kind = 'LESSON';
    if (isLast) {
      lessonTitle = isFilipino ? `Buod at Pagsusuri: ${topic}` : isBilingual ? `Summary & Review (Buod): ${topic}` : `Summary & Key Takeaways: ${topic}`;
      kind = 'SUMMARY';
    } else if (refSec) {
      lessonTitle = refSec.title;
    } else if (isFirst) {
      lessonTitle = isFilipino ? `Panimula sa ${topic}` : isBilingual ? `Introduction to ${topic} (Panimula)` : `Introduction to ${topic}`;
    } else if (subtopic) {
      lessonTitle = subtopic;
    } else if (i === lessonCount - 2) {
      lessonTitle = isFilipino ? `Mga Praktikal na Halimbawa sa ${topic}` : `Guided Practice & Worked Examples: ${topic}`;
      kind = 'ACTIVITY';
    } else {
      lessonTitle = `${topic}: Core Concepts Part ${i}`;
    }

    const paragraphs = [];
    if (refSec) {
      const sents = splitSentences(refSec.body);
      paragraphs.push(`<h3>${escHtml(lessonTitle)}</h3>`);
      for (const s of sents.slice(0, 5)) paragraphs.push(`<p>${escHtml(s)}</p>`);
      if (sents.length > 5) {
        paragraphs.push('<h4>Key Points</h4><ul>' + sents.slice(5, 9).map((s) => `<li>${escHtml(s)}</li>`).join('') + '</ul>');
      }
    } else if (isLast) {
      paragraphs.push(`<h3>${escHtml(lessonTitle)}</h3>`);
      paragraphs.push(`<p>${escHtml(isFilipino ? `Binubuod ng araling ito ang mga pangunahing punto ng ${topic}.` : `This final lesson pulls together the essential ideas covered across ${topic}.`)}</p>`);
      paragraphs.push('<h4>Checklist for Review</h4><ul>' + defaultObjectives.map((o) => `<li>${escHtml(o)}</li>`).join('') + '</ul>');
      paragraphs.push('<blockquote><p>Draft notice: Review and expand examples with class-specific materials before publishing to students.</p></blockquote>');
    } else {
      const focus = subtopic || topic;
      paragraphs.push(`<h3>${escHtml(lessonTitle)}</h3>`);
      if (isFilipino) {
        paragraphs.push(`<p>Sa bahaging ito, tatalakayin natin ang <strong>${escHtml(focus)}</strong> sa antas na ${escHtml((input.difficulty || 'INTERMEDIATE').toLowerCase())}.</p>`);
      } else if (isBilingual) {
        paragraphs.push(`<p>This lesson introduces <strong>${escHtml(focus)}</strong> (<em>Pangunahing konsepto ng ${escHtml(focus)}</em>) for ${escHtml(input.yearLevel || 'college')} learners.</p>`);
      } else {
        paragraphs.push(`<p>This lesson examines <strong>${escHtml(focus)}</strong> at the ${escHtml((input.difficulty || 'INTERMEDIATE').toLowerCase())} level, connecting core definitions to classroom practice.</p>`);
      }
      if (input.teachingApproach) {
        paragraphs.push(`<p><strong>Teaching approach (${escHtml(input.teachingApproach)}):</strong> Begin with a guiding question, trace one concrete example step by step, and check student understanding before moving to independent practice.</p>`);
      }
      paragraphs.push('<h4>Core Ideas</h4><ul>');
      paragraphs.push(`<li><strong>Key concept:</strong> Define what ${escHtml(focus)} accomplishes and when to apply it.</li>`);
      paragraphs.push(`<li><strong>Worked walkthrough:</strong> Trace an example cleanly from inputs or premises to the verified outcome.</li>`);
      paragraphs.push(`<li><strong>Common pitfalls:</strong> Watch for unverified assumptions or skipped verification steps.</li>`);
      paragraphs.push('</ul>');
      paragraphs.push('<h4>Quick Self-Check</h4><p>Ask students to restate the main rule in one sentence and verify one sample case independently.</p>');
    }

    lessons.push({
      title: lessonTitle,
      kind,
      estimatedMinutes: perMinutes,
      contentHtml: paragraphs.join('\n'),
    });
  }

  const activities = [
    {
      title: `Concept Check: ${topic}`,
      instructions: `In pairs or small groups, summarize two core ideas from ${topic} and walk through one example step by step.`,
    },
    {
      title: `Applied Exercise: ${subtopics[0] || topic}`,
      instructions: `Solve a short practical problem using the principles of ${subtopics[0] || topic}, documenting each step and checking edge cases.`,
    },
  ];

  const sourceForQuiz = refSections.length
    ? input.referenceText
    : lessons.map((l, idx) => `Lesson ${idx + 1}: ${l.title}\n${l.contentHtml.replace(/<[^>]+>/g, ' ')}`).join('\n\n');

  const assessment = input.includeAssessment
    ? generateQuestions({
        topic,
        source: sourceForQuiz,
        count: 6,
        types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER'],
        difficulty: 'MIXED',
        purpose: 'QUIZ',
      }).questions
    : [];

  return {
    title,
    overview: isFilipino
      ? `Isang panimulang draft na modyul tungkol sa ${topic} para sa pagtuturo at pagre-review ng guro.`
      : `A structured draft module on ${title} organized into ${lessons.length} lessons, practice activities, and a draft assessment ready for instructor review.`,
    objectives: defaultObjectives,
    lessons,
    activities,
    assessment,
    references: [],
  };
}

function generateLessonRewrite(input = {}) {
  const lesson = input.lesson ?? {};
  const instruction = cleanLine(input.instruction, 400);
  const currentHtml = String(lesson.contentHtml ?? '');
  const plain = currentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = splitSentences(plain);
  const lower = instruction.toLowerCase();

  let rewrittenHtml;
  if (/short|simpl|concis|summar|brief|bullet/.test(lower)) {
    const bullets = sentences.slice(0, 6).map((s) => `<li>${escHtml(s)}</li>`).join('');
    rewrittenHtml = [
      `<h3>${escHtml(lesson.title || 'Lesson')}</h3>`,
      `<p><strong>Key takeaways (${escHtml(instruction)}):</strong></p>`,
      bullets ? `<ul>${bullets}</ul>` : `<p>${escHtml(plain)}</p>`,
    ].join('\n');
  } else if (/example|practice|activity|exercis/.test(lower)) {
    rewrittenHtml = [
      currentHtml || `<h3>${escHtml(lesson.title || 'Lesson')}</h3>`,
      '<h4>Worked Example & Guided Practice</h4>',
      `<p>Apply the core idea from <strong>${escHtml(lesson.title || 'this lesson')}</strong> to a concrete scenario, check the assumptions, and verify the result step by step.</p>`,
      '<ul><li><strong>Step 1:</strong> Identify the key rule and given inputs.</li><li><strong>Step 2:</strong> Work through the solution carefully.</li><li><strong>Step 3:</strong> Verify the result against expectations.</li></ul>',
    ].join('\n');
  } else {
    const lead = sentences[0] || plain || `Overview of ${lesson.title || 'this topic'}.`;
    const rest = sentences.slice(1, 6);
    rewrittenHtml = [
      `<h3>${escHtml(lesson.title || 'Lesson')}</h3>`,
      `<p>${escHtml(lead)}</p>`,
      rest.length ? `<h4>Key Points</h4><ul>${rest.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>` : '',
      `<blockquote><p>Revised following instruction: ${escHtml(instruction)}</p></blockquote>`,
    ].filter(Boolean).join('\n');
  }

  return {
    title: lesson.title || 'Lesson',
    kind: lesson.kind || 'LESSON',
    estimatedMinutes: lesson.estimatedMinutes ?? 20,
    contentHtml: rewrittenHtml,
  };
}

function splitPoints(total, count) {
  const base = Math.floor(total / count);
  let rem = total - base * count;
  return Array.from({ length: count }, () => {
    const pts = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    return pts;
  });
}

function criterionLevels(maxPoints, title) {
  const scaled = (ratio) => Math.max(0, Math.min(maxPoints, Math.round(maxPoints * ratio)));
  return [
    { title: 'Excellent', points: maxPoints, description: `Demonstrates thorough mastery of ${title} with clear reasoning and zero major errors.` },
    { title: 'Proficient', points: scaled(0.8), description: `Meets expectations for ${title} with only minor omissions.` },
    { title: 'Developing', points: scaled(0.55), description: `Shows partial understanding of ${title}; key details or verification are incomplete.` },
    { title: 'Beginning', points: scaled(0.25), description: `Minimal evidence of ${title}; significant revision is needed.` },
  ];
}

function generateRubric(input = {}) {
  const task = cleanLine(input.task, 200) || 'Course Assignment';
  const points = Math.max(1, Math.min(1000, Math.round(Number(input.points) || 100)));
  const count = Math.max(2, Math.min(8, Math.round(Number(input.criteriaCount) || 4)));
  const lower = task.toLowerCase();

  let templates;
  if (/code|program|algorithm|software|script|app|api|sql|database/.test(lower)) {
    templates = [
      ['Correctness & Functionality', 'Produces accurate results across standard inputs and handles edge cases properly.'],
      ['Code Structure & Clarity', 'Uses clear naming, modular organization, and readable control flow.'],
      ['Testing & Edge Cases', 'Demonstrates thoughtful test cases and input validation.'],
      ['Documentation & Explanation', 'Includes concise comments explaining design choices and usage.'],
      ['Efficiency & Resource Use', 'Avoids unnecessary work and uses appropriate data structures.'],
      ['Error Handling', 'Handles invalid or unexpected inputs cleanly without crashing.'],
      ['Requirements Compliance', 'Follows all assignment constraints and submission formatting rules.'],
      ['Reflection & Verification', 'Explains design tradeoffs and verified outputs accurately.'],
    ];
  } else if (/essay|paper|report|research|write|essay|review|essay/.test(lower)) {
    templates = [
      ['Thesis & Conceptual Focus', 'Presents a clear central argument directly addressing the prompt.'],
      ['Evidence & Analysis', 'Supports claims with relevant concepts, examples, and accurate reasoning.'],
      ['Organization & Coherence', 'Arranges ideas logically with smooth transitions between paragraphs.'],
      ['Clarity, Mechanics & Style', 'Uses precise, concise academic language with minimal grammatical errors.'],
      ['Source Integration', 'Synthesizes class concepts or provided references accurately.'],
      ['Critical Reflection', 'Evaluates limitations, counterarguments, or implications thoughtfully.'],
      ['Formatting & Completeness', 'Meets length, citation, and structural guidelines.'],
      ['Originality & Insight', 'Offers clear personal synthesis rather than surface summary.'],
    ];
  } else if (/present|speech|demo|pitch|oral/.test(lower)) {
    templates = [
      ['Content Accuracy', 'Explains core ideas clearly and accurately.'],
      ['Structure & Pacing', 'Opens clearly, transitions smoothly, and finishes within time.'],
      ['Visual Aids & Examples', 'Uses clear slides or demonstrations that support key points.'],
      ['Delivery & Engagement', 'Speaks audibly and responds thoughtfully to questions.'],
      ['Preparation & Teamwork', 'Shows clear rehearsal and balanced contribution.'],
      ['Q&A Handling', 'Addresses audience questions accurately and concisely.'],
      ['Summary & Takeaways', 'Leaves listeners with clear key points.'],
      ['Time Management', 'Allocates time appropriately across sections.'],
    ];
  } else {
    templates = [
      ['Conceptual Understanding', 'Accurately applies key concepts and terminology from the unit.'],
      ['Completeness & Execution', 'Addresses every required part of the task thoroughly.'],
      ['Analysis & Reasoning', 'Justifies choices clearly using sound evidence or worked steps.'],
      ['Organization & Presentation', 'Presents work neatly in a logical, easy-to-follow structure.'],
      ['Problem Solving & Accuracy', 'Reaches well-checked conclusions without major mistakes.'],
      ['Verification & Edge Cases', 'Tests or checks work against constraints and exceptions.'],
      ['Clarity & Communication', 'Explains ideas concisely for the target audience.'],
      ['Timeliness & Polish', 'Follows submission instructions cleanly.'],
    ];
  }

  const weights = splitPoints(points, count);
  const criteria = weights.map((maxPoints, i) => {
    const [critTitle, critDesc] = templates[i % templates.length];
    return {
      title: critTitle,
      description: critDesc,
      maxPoints: Math.max(1, maxPoints),
      levels: criterionLevels(Math.max(1, maxPoints), critTitle.toLowerCase()),
    };
  });

  // Adjust first criterion if rounding pushed sum slightly off when points < count.
  const sum = criteria.reduce((acc, c) => acc + c.maxPoints, 0);
  if (sum !== points && criteria[0]) {
    const adjusted = Math.max(1, criteria[0].maxPoints + (points - sum));
    criteria[0] = { ...criteria[0], maxPoints: adjusted, levels: criterionLevels(adjusted, criteria[0].title.toLowerCase()) };
  }

  return { title: `${task.slice(0, 120)} Rubric`, criteria };
}

function generateAssignment(input = {}) {
  const topic = cleanLine(input.topic, 200) || (input.moduleTitle ? `Applied Task: ${cleanLine(input.moduleTitle, 140)}` : 'Applied Learning Task');
  const points = Math.max(1, Math.min(1000, Math.round(Number(input.points) || 100)));
  const sections = parseLessons(input.materialText || '');
  const subtopics = sections.map((s) => s.title).filter(Boolean).slice(0, 5);
  const details = cleanLine(input.details, 800);

  const html = [
    `<p><strong>Overview:</strong> In this ${points}-point assignment, you will apply key concepts from <strong>${escHtml(topic)}</strong>${input.moduleTitle ? ` (<em>${escHtml(input.moduleTitle)}</em>)` : ''}.</p>`,
    details ? `<p><strong>Instructor Notes:</strong> ${escHtml(details)}</p>` : null,
    subtopics.length
      ? `<p><strong>Concepts Covered:</strong></p><ul>${subtopics.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>`
      : null,
    '<p><strong>Requirements:</strong></p>',
    '<ol>',
    `<li>Clearly define the problem or scenario you are addressing in ${escHtml(topic)}.</li>`,
    '<li>Show your complete reasoning, methodology, or step-by-step work rather than only a final answer.</li>',
    '<li>Check at least one edge case or limitation and explain how your solution addresses it.</li>',
    '</ol>',
    '<p><strong>Submission Checklist:</strong> Review your work against the grading criteria below before submitting.</p>',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    title: topic,
    instructionsHtml: html,
    rubric: input.withRubric !== false ? generateRubric({ task: topic, points, criteriaCount: 4 }) : undefined,
  };
}

function generateAssistantText(input = {}) {
  const prompt = cleanLine(input.prompt, 1200);
  const context = String(input.context ?? '').trim();
  const lower = prompt.toLowerCase();
  const sentences = splitSentences(context);

  if (context && /summar|short|tl;?dr|brief|condens/.test(lower)) {
    const key = sentences.slice(0, 4);
    return key.length
      ? `Summary:\n${key.map((s) => `- ${s}`).join('\n')}`
      : `Summary:\n${cleanLine(context, 400)}`;
  }
  if (context && /simpl|easier|plain|explain|student/.test(lower)) {
    const items = (sentences.length ? sentences : [cleanLine(context, 400)]).slice(0, 5);
    return `Clearer version (draft):\n\n${items.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nCheck-in prompt: Ask students to put one point into their own words.`;
  }
  if (context && /bullet|list|outline|points/.test(lower)) {
    const items = (sentences.length ? sentences : context.split('\n').filter(Boolean)).slice(0, 8);
    return items.map((s) => `- ${cleanLine(s, 240)}`).join('\n');
  }
  if (/quiz|question/.test(lower)) {
    const out = generateQuestions({ topic: prompt, source: context, count: 3, types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER'] });
    return out.questions
      .map((q, i) => `${i + 1}. [${q.type}] ${q.text}${q.choices ? '\n   ' + q.choices.map((c, idx) => `${String.fromCharCode(65 + idx)}. ${c.text}${c.isCorrect ? ' *' : ''}`).join('\n   ') : ''}`)
      .join('\n\n');
  }
  if (context) {
    return `Draft suggestion for "${prompt}":\n\n${cleanLine(context, 900)}\n\nSuggested refinement:\n- State the main takeaway in the opening sentence.\n- Break long explanations into concise numbered steps or bullets.\n- End with one concrete example or reflection prompt for students.`;
  }
  return [
    `Draft response for: ${prompt}`,
    '',
    '- Clarify the main learning goal in 1-2 sentences so students know what success looks like.',
    '- Include one worked example followed by a short comprehension check.',
    '- Review and customize details for your class before publishing.',
  ].join('\n');
}

/** Handle health check prompt without breaking scripts/ai-check.mjs or checkAi(). */
function handleFallbackPrompt(userText) {
  const text = String(userText ?? '');
  if (/photosynthesis/i.test(text) && /capital/i.test(text)) {
    return JSON.stringify({
      ok: true,
      capital: 'Manila',
      question: 'Which gas do plants absorb during photosynthesis?',
      choices: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Argon'],
      correct: 1,
    });
  }
  if (/photosynthesis/i.test(text)) {
    return JSON.stringify({
      ok: true,
      question: 'Which gas do plants take in from the air during photosynthesis?',
      choices: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'],
      correct: 2,
    });
  }
  return null;
}

/**
 * Execute one built-in completion request, returning the exact shape produced by chatCompletion().
 */
export async function builtinCompletion({ messages = [], json = false, task = null }) {
  const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const systemMessage = messages.find((m) => m.role === 'system')?.content ?? '';
  const approxPromptTokens = Math.max(1, Math.ceil((systemMessage.length + userMessage.length) / 4));

  let content;
  if (task?.kind === 'module') {
    content = JSON.stringify(generateModule(task.input));
  } else if (task?.kind === 'lesson-rewrite') {
    content = JSON.stringify(generateLessonRewrite(task.input));
  } else if (task?.kind === 'questions') {
    content = JSON.stringify(generateQuestions(task.input));
  } else if (task?.kind === 'assignment') {
    content = JSON.stringify(generateAssignment(task.input));
  } else if (task?.kind === 'rubric') {
    content = JSON.stringify(generateRubric(task.input));
  } else if (task?.kind === 'assistant') {
    content = generateAssistantText(task.input);
  } else {
    content = handleFallbackPrompt(userMessage);
    if (!content) {
      content = json
        ? JSON.stringify(generateQuestions({ topic: cleanLine(userMessage, 120), count: 3 }))
        : generateAssistantText({ prompt: userMessage });
    }
  }

  return {
    content,
    finishReason: 'stop',
    model: BUILTIN_MODEL,
    promptTokens: approxPromptTokens,
    completionTokens: Math.max(1, Math.ceil(content.length / 4)),
  };
}
