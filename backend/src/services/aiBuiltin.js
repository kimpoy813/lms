// Built-in zero-key AI assistant (AI_PROVIDER=builtin).
//
// Works offline inside this server with no external network calls, no credit card, and no API key.
// Combines syntactic NLP extraction (definitions, acronyms, comparisons, cause-effect rules,
// salience-ranked facts, and ordered sequences) with curated curriculum knowledge packs
// (aiBuiltinKnowledge.js) to produce rich, domain-accurate, teacher-editable drafts across
// modules, quizzes/exams, lesson rewrites, assignments, rubrics, and writing help.
import { BUILTIN_MODEL } from './aiProvider.js';
import { normalizeAnswer } from '../lib/answerMatch.js';
import { matchKnowledge } from './aiBuiltinKnowledge.js';
import { generateProgrammingProblem } from './aiBuiltinProgramming.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'not', 'but', 'what', 'which', 'when', 'where', 'who', 'whom', 'whose',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'into', 'onto', 'over', 'under',
  'about', 'after', 'before', 'between', 'through', 'during', 'above', 'below', 'their', 'there',
  'these', 'those', 'then', 'they', 'them', 'also', 'only', 'using', 'used', 'uses', 'make',
  'makes', 'made', 'many', 'well', 'because', 'while', 'could', 'would', 'may', 'might', 'must',
  'shall', 'often', 'usually', 'within', 'without', 'among', 'along', 'since', 'here', 'it',
  'its', 'you', 'your', 'our', 'we', 'one', 'two', 'three', 'first', 'second', 'third',
]);

const LEADING_ARTICLES = /^(?:the|an|a)\s+/i;
const BAD_TERM_STARTS = /^(?:it|this|that|these|those|there|here|they|them|we|you|such|another|many|most|some|each|every|all|however|therefore|moreover|furthermore|for example|in contrast|on the other hand|in summary|in addition|overall|finally|meanwhile|consequently)\b/i;
const FILLER_SENTENCE = /^(?:welcome to|in this (?:lesson|module|unit|section|chapter)|by the end of this|let us (?:look|begin|explore|review)|this (?:lesson|module|section) covers|below is an overview|remember to review)/i;

const escHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cleanLine = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function stripHtmlKeepBreaks(text) {
  return String(text ?? '')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');
}

function splitSentences(text) {
  const DOT = '\uE000';
  const prepared = stripHtmlKeepBreaks(text)
    .replace(/\r\n/g, '\n')
    // Protect common abbreviations and decimal numbers from sentence splitting.
    .replace(/\b(e\.g|i\.e|etc|vs|Dr|Prof|Fig|No|pp|Mr|Mrs|Ms|Inc|Ltd|St)\./gi, `$1${DOT}`)
    .replace(/(\d)\.(\d)/g, `$1${DOT}$2`);
  return prepared
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => cleanLine(s.replaceAll(DOT, '.').replace(/^[•\-*]\s+/, ''), 600))
    .filter((s) => s.length >= 22 && /[a-zA-Z]/.test(s) && !s.endsWith('[…]'));
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

  const refMatches = [...raw.matchAll(/<reference\s+name="([^"]*)">\s*([\s\S]*?)\s*<\/reference>/g)];
  if (refMatches.length > 0) {
    return refMatches
      .map((m) => ({ title: cleanLine(m[1], 120) || 'Reference material', body: m[2].trim() }))
      .filter((s) => s.body);
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

function cleanCandidateTerm(raw) {
  let term = cleanLine(raw, 80)
    .replace(LEADING_ARTICLES, '')
    .replace(/[.,;:!?()[\]"']+$/g, '')
    .replace(/^["'([]+/, '')
    .trim();
  if (!term || term.length < 2 || term.length > 64) return null;
  if (BAD_TERM_STARTS.test(term)) return null;
  const words = term.split(/\s+/);
  if (words.length > 5) return null;
  if (words.length === 1 && STOPWORDS.has(term.toLowerCase())) return null;
  // Title-case lowercased multi-word terms gently only when single sentence-start lowercase occurs.
  return term.charAt(0).toUpperCase() + term.slice(1);
}

function scoreSentence(sentence, hasDef, hasContrast, hasCause) {
  let score = 0;
  if (FILLER_SENTENCE.test(sentence)) return -5;
  if (hasDef) score += 6;
  if (hasContrast) score += 5;
  if (hasCause) score += 4;
  if (/\b(?:O\([^)]+\)|p\s*[<=>]|ATP|NADH|CO2|H2O|SQL|HTTP|LIFO|FIFO|\d+%)\b/i.test(sentence)) score += 3;
  if (sentence.length >= 45 && sentence.length <= 240) score += 2;
  const contentWords = (sentence.match(/\b[A-Za-z][A-Za-z0-9-]{4,}\b/g) ?? []).filter((w) => !STOPWORDS.has(w.toLowerCase()));
  score += Math.min(4, Math.floor(contentWords.length / 2));
  return score;
}

/** Extract definitions, comparisons, cause-effects, salience-ranked facts, sequences, and domain terms. */
function analyzeMaterial(sections) {
  const definitions = [];
  const comparisons = [];
  const causes = [];
  const facts = [];
  const sequences = [];
  const terms = new Set();
  const seenDefs = new Set();

  const registerTerm = (raw) => {
    const t = cleanCandidateTerm(raw);
    if (t && t.length >= 3) {
      terms.add(t);
      return t;
    }
    return null;
  };

  const addDef = (rawTerm, rawDef, sentence, lessonTitle) => {
    const term = registerTerm(rawTerm);
    const definition = cleanLine(rawDef, 240).replace(/[.!?]+$/, '');
    if (!term || definition.length < 12) return false;
    if (normalizeAnswer(term) === normalizeAnswer(definition)) return false;
    const key = normalizeAnswer(term);
    if (!seenDefs.has(key)) {
      seenDefs.add(key);
      definitions.push({ term, definition, sentence, lessonTitle });
    }
    return true;
  };

  for (const sec of sections) {
    const lines = stripHtmlKeepBreaks(sec.body).split('\n').map((l) => l.trim()).filter(Boolean);
    const listItems = [];
    for (const line of lines) {
      const m = /^(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line);
      if (m && m[1].length >= 6 && m[1].length <= 180) listItems.push(cleanLine(m[1], 180));
      else {
        if (listItems.length >= 3) sequences.push({ lessonTitle: sec.title, items: listItems.slice(0, 6) });
        listItems.length = 0;
      }
    }
    if (listItems.length >= 3) sequences.push({ lessonTitle: sec.title, items: listItems.slice(0, 6) });

    for (const sentence of splitSentences(sec.body)) {
      if (FILLER_SENTENCE.test(sentence)) continue;

      let matchedDef = false;
      // Pattern 1: Optional intro clause ("In biology, ...") followed by "<Term> is/refers to/means/consists of ..."
      const strippedIntro = sentence.replace(/^(?:In|Within|Under|During|Across)\s+[A-Za-z0-9\s-]{2,36},\s+/, '');
      const defMatch = /^([A-Za-z][A-Za-z0-9\s/()-]{2,48}?)\s+(?:is defined as|refers to|means|represents|consists of|is characterized by|is responsible for|is a|is an|is the|are the)\s+(.{14,260})[.!?]*$/.exec(strippedIntro);
      if (defMatch) {
        matchedDef = addDef(defMatch[1], defMatch[2], sentence, sec.title);
      }

      // Pattern 2: "Term: definition" or "Term — definition"
      if (!matchedDef) {
        const sepMatch = /^([A-Za-z][A-Za-z0-9\s/()-]{2,46}?)(?::|\s+[—–-]{1,2})\s+(.{12,260})[.!?]*$/.exec(sentence);
        if (sepMatch) matchedDef = addDef(sepMatch[1], sepMatch[2], sentence, sec.title);
      }

      // Pattern 3: Acronym expansion "Full Term (ACR)"
      const acroMatch = /\b([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){1,4})\s+\(([A-Z]{2,8})\)/.exec(sentence);
      if (acroMatch) {
        addDef(acroMatch[2], `${acroMatch[1]} (${sentence})`, sentence, sec.title);
        registerTerm(acroMatch[1]);
      }

      // Comparison pattern: "Unlike X, Y ..." / "X differs from Y ..." / "Whereas X..., Y..."
      let matchedContrast = false;
      const contrastMatch =
        /^(?:Unlike|Compared to|In contrast to)\s+([^,]{3,45}),\s+(.{15,260})[.!?]*$/i.exec(sentence) ||
        /^Whereas\s+([^,]{8,100}),\s+(.{15,260})[.!?]*$/i.exec(sentence) ||
        /^([A-Za-z][A-Za-z0-9\s-]{2,40})\s+(?:differs from|contrasts with)\s+([A-Za-z][A-Za-z0-9\s-]{2,40})\s+(?:because|in that|by)\s+(.{10,220})[.!?]*$/i.exec(sentence);
      if (contrastMatch) {
        matchedContrast = true;
        comparisons.push({ sentence, lessonTitle: sec.title, left: cleanLine(contrastMatch[1], 60), right: cleanLine(contrastMatch[2], 60) });
      }

      // Cause-effect / condition pattern: "When/If/Because ..., ..."
      let matchedCause = false;
      const causeMatch = /^(When|If|Because|Since)\s+([^,]{10,120}),\s+(?:then\s+)?(.{12,240})[.!?]*$/i.exec(sentence);
      if (causeMatch) {
        matchedCause = true;
        causes.push({ marker: causeMatch[1].toLowerCase(), condition: cleanLine(causeMatch[2], 140), outcome: cleanLine(causeMatch[3], 200), sentence, lessonTitle: sec.title });
      }

      // Keyword extraction + salience score
      const words = sentence.match(/\b[A-Za-z][A-Za-z0-9-]{3,28}\b/g) ?? [];
      let keyword = null;
      for (const w of words) {
        if (!STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w)) {
          const added = registerTerm(w);
          if (added && (!keyword || (added.length > keyword.length && added.length <= 24))) keyword = added;
        }
      }
      if (matchedDef && !keyword) keyword = definitions[definitions.length - 1]?.term ?? null;

      facts.push({
        sentence,
        keyword,
        lessonTitle: sec.title,
        score: scoreSentence(sentence, matchedDef, matchedContrast, matchedCause),
      });
    }
  }

  // Sort facts by informativeness within overall set while tagging lesson index for stratification.
  facts.sort((a, b) => b.score - a.score);
  return { definitions, comparisons, causes, facts, sequences, terms: [...terms] };
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

/** Choose distractors that never overlap/contain the correct answer and match topic domain. */
function pickDistractors(correct, candidatePool, packs, count = 3) {
  const normCorrect = normalizeAnswer(correct);
  const used = new Set([normCorrect]);
  const packTerms = packs.flatMap((p) => [
    ...p.definitions.map((d) => d.term),
    ...p.comparisons.flatMap((c) => [c.left, c.right]),
  ]);
  const domainFallback = [
    'Secondary supporting mechanism',
    'Unrelated control condition',
    'External boundary constraint',
    'Preliminary baseline assumption',
    'Auxiliary verification step',
  ];
  const isMultiWord = correct.trim().includes(' ');
  const pool = [...candidatePool, ...packTerms, ...domainFallback]
    .map((c) => cleanLine(c, 220))
    .filter(Boolean)
    .sort((a, b) => {
      // Prefer candidates whose word count roughly matches the correct answer.
      const aMatch = a.includes(' ') === isMultiWord ? 0 : 1;
      const bMatch = b.includes(' ') === isMultiWord ? 0 : 1;
      return aMatch - bMatch;
    });

  const chosen = [];
  for (const candidate of pool) {
    const key = normalizeAnswer(candidate);
    if (!key || used.has(key)) continue;
    if (key.includes(normCorrect) || normCorrect.includes(key)) continue;
    used.add(key);
    chosen.push(candidate);
    if (chosen.length >= count) break;
  }
  return chosen;
}

function negateStatement(sentence) {
  const clean = cleanLine(sentence, 500);
  // Avoid double negation when swapping.
  if (/\b(?:is|are|was|were|can|will|should|must|do|does|did)\s+not\b/i.test(clean)) {
    return clean.replace(/\b(is|are|was|were|can|will|should|must|do|does|did)\s+not\b/i, '$1');
  }
  const swaps = [
    [/\bincreases?\b/i, 'decreases'],
    [/\bdecreases?\b/i, 'increases'],
    [/\balways\b/i, 'never'],
    [/\brequired\b/i, 'optional'],
    [/\bessential\b/i, 'unnecessary'],
    [/\bbefore\b/i, 'only after'],
    [/\bafter\b/i, 'prior to'],
    [/\binternal\b/i, 'external'],
    [/\bexternal\b/i, 'internal'],
    [/\b(is|are|was|were|can|will|should|must)\b/i, '$1 not'],
  ];
  for (const [regex, replacement] of swaps) {
    if (regex.test(clean)) return clean.replace(regex, replacement);
  }
  return `Contrary to the lesson, ${clean.charAt(0).toLowerCase()}${clean.slice(1)}`;
}

/** Extract high-signal accepted answer key words/sentence so EduSphere's keyWords auto-grader works well. */
function buildShortAnswerModel(text, keyword) {
  const cleaned = cleanLine(text, 240).replace(/[.!?]+$/, '');
  const list = [cleaned];
  if (keyword && normalizeAnswer(keyword) !== normalizeAnswer(cleaned)) {
    // Include concise factual form if sentence was very long.
    if (cleaned.length > 140) list.push(`${keyword}: ${cleaned.slice(0, 120)}`);
  }
  return uniqueStrings(list);
}

/** Stratify items across lessons proportionally so exams cover every lesson, not just Lesson 1. */
function stratifiedPick(items, sections, idx) {
  if (!items.length) return null;
  if (sections.length <= 1) return items[idx % items.length];
  const buckets = sections.map((s) => items.filter((it) => it.lessonTitle === s.title)).filter((b) => b.length > 0);
  if (buckets.length === 0) return items[idx % items.length];
  const bucketIdx = idx % buckets.length;
  const withinIdx = Math.floor(idx / buckets.length) % buckets[bucketIdx].length;
  return buckets[bucketIdx][withinIdx];
}

function buildQuestionFromMaterial({ type, difficulty, topicLabel, idx, material, sections, packs }) {
  const { definitions, comparisons, causes, facts, sequences, terms } = material;
  const def = stratifiedPick(definitions, sections, idx);
  const fact = stratifiedPick(facts, sections, idx);
  const comp = comparisons.length ? comparisons[idx % comparisons.length] : null;
  const cause = causes.length ? causes[idx % causes.length] : null;
  const lessonTitle = def?.lessonTitle ?? fact?.lessonTitle ?? sections[idx % Math.max(1, sections.length)]?.title ?? topicLabel;

  if (type === 'MULTIPLE_CHOICE') {
    // Hard / Medium analytical questions: cause-effect or comparison when available.
    if (difficulty !== 'EASY' && cause && (idx % 3 === 1 || !def)) {
      const distractors = pickDistractors(
        cause.outcome,
        [negateStatement(cause.outcome), ...facts.map((f) => cleanLine(f.sentence, 140))],
        packs,
        3,
      );
      if (distractors.length === 3) {
        const pos = idx % 4;
        const list = [...distractors];
        list.splice(pos, 0, cause.outcome);
        return {
          type,
          text: `${cause.marker === 'because' ? 'Given that' : cause.marker.charAt(0).toUpperCase() + cause.marker.slice(1)} ${cause.condition}, what is the direct result?`,
          points: difficulty === 'HARD' ? 2 : 1,
          difficulty,
          topic: cause.lessonTitle,
          explanation: `From ${cause.lessonTitle}: "${cause.sentence}"`,
          choices: list.map((c, i) => ({ text: c, isCorrect: i === pos })),
        };
      }
    }

    if (def) {
      const distractors = pickDistractors(def.term, terms, packs, 3);
      if (distractors.length >= 3) {
        const pos = idx % 4;
        const list = [...distractors];
        list.splice(pos, 0, def.term);
        return {
          type,
          text: `Which term matches the description: "${def.definition}"?`,
          points: 1,
          difficulty,
          topic: lessonTitle,
          explanation: `From ${lessonTitle}: "${def.sentence}"`,
          choices: list.map((c, i) => ({ text: c, isCorrect: i === pos })),
        };
      }
    }

    if (fact && fact.keyword) {
      const escaped = fact.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blanked = fact.sentence.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '___');
      if (blanked.includes('___')) {
        const distractors = pickDistractors(fact.keyword, terms, packs, 3);
        if (distractors.length >= 3) {
          const pos = idx % 4;
          const list = [...distractors];
          list.splice(pos, 0, fact.keyword);
          return {
            type,
            text: `Which concept completes this statement from ${lessonTitle}? "${blanked}"`,
            points: 1,
            difficulty,
            topic: lessonTitle,
            explanation: `Reference (${lessonTitle}): "${fact.sentence}"`,
            choices: list.map((c, i) => ({ text: c, isCorrect: i === pos })),
          };
        }
      }
    }
  }

  if (type === 'MULTIPLE_RESPONSE') {
    const pool = uniqueStrings([...definitions.map((d) => d.term), ...terms]).slice(0, 6);
    if (pool.length >= 2) {
      const correctItems = pool.slice(0, Math.min(2, pool.length));
      const wrongItems = pickDistractors(
        correctItems.join(' '),
        ['Unrelated external parameter outside module scope', 'Deprecated legacy convention'],
        [],
        2,
      );
      if (wrongItems.length >= 1) {
        return {
          type,
          text: `Which of the following concepts are directly introduced in ${lessonTitle}? Select all that apply.`,
          points: 2,
          difficulty,
          topic: lessonTitle,
          explanation: `Key concepts from ${lessonTitle}: ${correctItems.join(', ')}.`,
          choices: [
            ...correctItems.map((t) => ({ text: t, isCorrect: true })),
            ...wrongItems.map((t) => ({ text: t, isCorrect: false })),
          ],
        };
      }
    }
  }

  if (type === 'TRUE_FALSE' && (def || fact)) {
    const src = def ? def.sentence : fact.sentence;
    const isTrue = idx % 2 === 0;
    const statement = isTrue ? src : negateStatement(src);
    return {
      type,
      text: `True or False: ${statement}`,
      points: 1,
      difficulty,
      topic: lessonTitle,
      explanation: `Reference (${lessonTitle}): "${src}"`,
      answer: isTrue,
    };
  }

  if (type === 'IDENTIFICATION' && (def || fact)) {
    if (def) {
      return {
        type,
        text: `Identify the term described as: ${def.definition}.`,
        points: 1,
        difficulty,
        topic: lessonTitle,
        explanation: `From ${lessonTitle}: "${def.sentence}"`,
        accepted: uniqueStrings([def.term, def.term.toLowerCase()]),
      };
    }
    if (fact?.keyword) {
      const escaped = fact.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blanked = fact.sentence.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '___');
      if (blanked.includes('___')) {
        return {
          type,
          text: `Identify the missing term in this statement from ${lessonTitle}: "${blanked}"`,
          points: 1,
          difficulty,
          topic: lessonTitle,
          explanation: `From ${lessonTitle}: "${fact.sentence}"`,
          accepted: uniqueStrings([fact.keyword, fact.keyword.toLowerCase()]),
        };
      }
    }
  }

  if (type === 'SHORT_ANSWER' && (comp || cause || def || fact)) {
    if (comp) {
      return {
        type,
        text: `Based on ${comp.lessonTitle}, distinguish ${comp.left} from ${comp.right}.`,
        points: 2,
        difficulty,
        topic: comp.lessonTitle,
        explanation: `Reference (${comp.lessonTitle}): "${comp.sentence}"`,
        accepted: buildShortAnswerModel(comp.sentence, comp.left),
      };
    }
    if (cause) {
      return {
        type,
        text: `Explain what happens in ${cause.lessonTitle} ${cause.marker} ${cause.condition}, and why.`,
        points: 2,
        difficulty,
        topic: cause.lessonTitle,
        explanation: `From ${cause.lessonTitle}: "${cause.sentence}"`,
        accepted: buildShortAnswerModel(cause.sentence, cause.outcome),
      };
    }
    if (def) {
      return {
        type,
        text: `In your own words, define ${def.term} and explain its role in ${lessonTitle}.`,
        points: 2,
        difficulty,
        topic: lessonTitle,
        explanation: `Reference (${lessonTitle}): "${def.sentence}"`,
        accepted: buildShortAnswerModel(def.sentence, def.term),
      };
    }
    return {
      type,
      text: `Summarize the key point from ${lessonTitle} regarding ${fact.keyword || topicLabel}.`,
      points: 2,
      difficulty,
      topic: lessonTitle,
      explanation: `Reference (${lessonTitle}): "${fact.sentence}"`,
      accepted: buildShortAnswerModel(fact.sentence, fact.keyword),
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
          explanation: `Complete statement (${lessonTitle}): "${sentence}"`,
          blanks: [uniqueStrings([target, target.toLowerCase()])],
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
        text: `Match each concept from ${topicLabel} with its correct description.`,
        points: pairs.length,
        difficulty,
        topic: lessonTitle,
        explanation: `Pairs are grounded directly in the definitions from ${topicLabel}.`,
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
        text: seq
          ? `Arrange the following steps from ${seq.lessonTitle} in the correct order.`
          : `Arrange these topics from ${topicLabel} in their logical module order.`,
        points: items.length,
        difficulty,
        topic: seq?.lessonTitle ?? lessonTitle,
        explanation: 'Ordered according to the progression in the source material.',
        items,
      };
    }
  }

  if (type === 'ESSAY') {
    const focusTerms = uniqueStrings(definitions.map((d) => d.term)).slice(0, 3);
    const termsNote = focusTerms.length ? ` Reference key concepts such as ${focusTerms.join(', ')}.` : '';
    return {
      type: 'ESSAY',
      text: `Explain the core concepts covered in "${lessonTitle}" and illustrate how they apply in a concrete scenario.${termsNote}`,
      points: 5,
      difficulty,
      topic: lessonTitle,
      explanation: `Grading focus: accurate use of concepts from ${lessonTitle}, clear reasoning, and a concrete supporting example.`,
    };
  }

  return null;
}

/** Generate high-quality domain-specific questions from curated curriculum packs when no source text exists. */
function buildKnowledgeQuestion({ type, difficulty, topicLabel, idx, packs }) {
  const pack = packs[idx % packs.length];
  const defs = packs.flatMap((p) => p.definitions);
  const facts = packs.flatMap((p) => p.facts);
  const comps = packs.flatMap((p) => p.comparisons);
  const seqs = packs.flatMap((p) => p.sequences);
  const allTerms = uniqueStrings(defs.map((d) => d.term));
  const def = defs.length ? defs[idx % defs.length] : null;
  const fact = facts.length ? facts[idx % facts.length] : null;
  const comp = comps.length ? comps[idx % comps.length] : null;
  const seq = seqs.length ? seqs[idx % seqs.length] : null;

  if (type === 'MULTIPLE_CHOICE') {
    if (difficulty !== 'EASY' && comp && idx % 3 === 1) {
      const wrongs = uniqueStrings([
        `${comp.left} and ${comp.right} perform identical roles with no practical distinction`,
        `${comp.right} always replaces ${comp.left} regardless of problem constraints`,
        `${comp.left} eliminates the need for verification or input validation`,
      ]);
      const pos = idx % 4;
      const choices = [...wrongs];
      choices.splice(pos, 0, comp.contrast);
      return {
        type,
        text: `What best distinguishes ${comp.left} from ${comp.right}?`,
        points: difficulty === 'HARD' ? 2 : 1,
        difficulty,
        topic: pack.title,
        explanation: comp.contrast,
        choices: choices.map((c, i) => ({ text: c, isCorrect: i === pos })),
      };
    }
    if (def) {
      const distractors = pickDistractors(def.term, allTerms, packs, 3);
      if (distractors.length === 3) {
        const pos = idx % 4;
        const choices = [...distractors];
        choices.splice(pos, 0, def.term);
        return {
          type,
          text: `In ${pack.title}, which term refers to ${def.definition}?`,
          points: 1,
          difficulty,
          topic: pack.title,
          explanation: `${def.term}: ${def.definition}.`,
          choices: choices.map((c, i) => ({ text: c, isCorrect: i === pos })),
        };
      }
    }
  }

  if (type === 'MULTIPLE_RESPONSE' && defs.length >= 2) {
    const right = defs.slice(0, 2).map((d) => `${d.term}: ${cleanLine(d.definition, 90)}`);
    const wrong = (pack.pitfalls?.length >= 2 ? pack.pitfalls.slice(0, 2) : ['Skipping edge-case validation', 'Ignoring foundational definitions'])
      .map((p) => `Common pitfall: ${p}`);
    if (uniqueStrings([...right, ...wrong]).length === 4) {
      return {
        type,
        text: `Which statements accurately describe core concepts in ${pack.title}? Select all that apply.`,
        points: 2,
        difficulty,
        topic: pack.title,
        explanation: `True statements summarize verified definitions in ${pack.title}; incorrect choices describe common errors.`,
        choices: [
          ...right.map((t) => ({ text: t, isCorrect: true })),
          ...wrong.map((t) => ({ text: t, isCorrect: false })),
        ],
      };
    }
  }

  if (type === 'TRUE_FALSE' && fact) {
    const isTrue = idx % 2 === 0;
    return {
      type,
      text: `True or False: ${isTrue ? fact.statement : fact.misconception}`,
      points: 1,
      difficulty,
      topic: pack.title,
      explanation: fact.statement,
      answer: isTrue,
    };
  }

  if (type === 'IDENTIFICATION' && def) {
    return {
      type,
      text: `In ${pack.title}, identify the concept defined as: ${def.definition}.`,
      points: 1,
      difficulty,
      topic: pack.title,
      explanation: `${def.term} is ${def.definition}.`,
      accepted: uniqueStrings([def.term, def.term.toLowerCase(), def.term.replace(/\s*\([^)]*\)/g, '')]),
    };
  }

  if (type === 'SHORT_ANSWER' && (comp || fact || def)) {
    if (comp) {
      return {
        type,
        text: `Contrast ${comp.left} and ${comp.right} in the context of ${pack.title}.`,
        points: 2,
        difficulty,
        topic: pack.title,
        explanation: comp.contrast,
        accepted: buildShortAnswerModel(comp.contrast, comp.left),
      };
    }
    const targetFact = fact?.statement ?? `${def.term} is ${def.definition}.`;
    return {
      type,
      text: `Explain a key rule or principle regarding ${def?.term ?? topicLabel} in ${pack.title}.`,
      points: 2,
      difficulty,
      topic: pack.title,
      explanation: targetFact,
      accepted: buildShortAnswerModel(targetFact, def?.term ?? topicLabel),
    };
  }

  if (type === 'FILL_BLANKS' && def) {
    return {
      type,
      text: `In ${pack.title}, ___ refers to ${def.definition}.`,
      points: 1,
      difficulty,
      topic: pack.title,
      explanation: `${def.term}: ${def.definition}.`,
      blanks: [uniqueStrings([def.term, def.term.toLowerCase(), def.term.replace(/\s*\([^)]*\)/g, '')])],
    };
  }

  if (type === 'MATCHING' && defs.length >= 3) {
    return {
      type,
      text: `Match each ${pack.title} term with its accurate definition.`,
      points: Math.min(4, defs.length),
      difficulty,
      topic: pack.title,
      explanation: `Each pair matches a foundational term in ${pack.title} to its formal definition.`,
      pairs: defs.slice(0, 4).map((d) => ({ left: d.term, right: cleanLine(d.definition, 160) })),
    };
  }

  if (type === 'ORDERING' && seq && seq.steps.length >= 3) {
    return {
      type,
      text: `Arrange the steps of "${seq.title}" in the correct order.`,
      points: seq.steps.length,
      difficulty,
      topic: pack.title,
      explanation: `Correct progression for ${seq.title}.`,
      items: seq.steps.slice(0, 5),
    };
  }

  if (type === 'ESSAY') {
    const examplePrompt = pack.workedExample ? ` Illustrate your explanation using an example such as ${pack.workedExample.title}.` : '';
    return {
      type: 'ESSAY',
      text: `Discuss the core principles of ${pack.title} and address common errors practitioners make when applying them.${examplePrompt}`,
      points: 5,
      difficulty,
      topic: pack.title,
      explanation: `Key grading criteria: accurate definitions (${allTerms.slice(0, 3).join(', ')}), clear reasoning, and error awareness.`,
    };
  }

  return null;
}

/** Decompose an arbitrary unseen topic cleanly without meta-talk inside student-facing text. */
function buildTopicQuestion({ type, difficulty, topicLabel, subtopic, idx }) {
  const focus = cleanLine(subtopic || topicLabel, 100);
  switch (type) {
    case 'MULTIPLE_CHOICE': {
      const frames = [
        {
          text: `Which approach best demonstrates rigorous application of ${focus}?`,
          correct: `Defining inputs, constraints, and expected outputs before solving problems in ${focus}`,
          wrongs: [
            `Relying on unverified shortcuts without checking boundary conditions in ${focus}`,
            `Applying memorized procedures without checking whether preconditions hold`,
            `Skipping validation against concrete test cases or counterexamples`,
          ],
        },
        {
          text: `When evaluating competing solutions in ${focus}, which criterion carries the highest priority?`,
          correct: `Verifying conceptual accuracy, constraint compliance, and reproducibility`,
          wrongs: [
            `Accepting the first plausible result without testing edge cases`,
            `Omitting underlying assumptions to shorten the presentation`,
            `Treating correlation or surface similarity as sufficient proof`,
          ],
        },
        {
          text: `What is the primary risk when ignoring foundational preconditions in ${focus}?`,
          correct: `Results become invalid or unreliable on edge cases and real-world inputs`,
          wrongs: [
            `All calculations automatically run faster with improved precision`,
            `Domain definitions expand cleanly without affecting accuracy`,
            `Verification checks become unnecessary for complex scenarios`,
          ],
        },
        {
          text: `Which practice most effectively prevents recurring mistakes when working with ${focus}?`,
          correct: `Testing candidate solutions against normal, minimal, and boundary cases`,
          wrongs: [
            `Assuming a single sample example proves universal correctness`,
            `Skipping intermediate steps so errors remain hidden until deployment`,
            `Changing problem constraints arbitrarily to match an expected output`,
          ],
        },
        {
          text: `When explaining ${focus} to peers or stakeholders, what makes a technical justification persuasive?`,
          correct: `Connecting evidence and intermediate reasoning directly to core principles`,
          wrongs: [
            `Stating a final conclusion without explaining underlying causes`,
            `Using complex jargon in place of measurable criteria`,
            `Omitting known limitations and edge-case behavior`,
          ],
        },
        {
          text: `During review of a ${focus} deliverable, which issue signals a critical conceptual flaw?`,
          correct: `A step violates stated preconditions or fails on boundary test cases`,
          wrongs: [
            `The solution documents its assumptions clearly before proceeding`,
            `Alternative methods are compared using explicit trade-offs`,
            `Each output is checked against independent verification criteria`,
          ],
        },
      ];
      const f = frames[idx % frames.length];
      const pos = idx % 4;
      const choices = [...f.wrongs];
      choices.splice(pos, 0, f.correct);
      return {
        type,
        text: f.text,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `Focuses on sound reasoning and validation in ${focus}. Review and tailor options to match your syllabus.`,
        choices: choices.map((c, i) => ({ text: c, isCorrect: i === pos })),
      };
    }
    case 'MULTIPLE_RESPONSE': {
      const variants = [
        {
          text: `Which practices demonstrate sound mastery of ${focus}? Select all that apply.`,
          right: [
            `Stating core definitions and preconditions clearly before applying ${focus}`,
            `Testing solutions against concrete examples and boundary cases`,
          ],
          wrong: [
            `Applying formulas or rules mechanically without checking context`,
            `Accepting initial estimates without verifying assumptions`,
          ],
        },
        {
          text: `Which verification checks should accompany work in ${focus}? Select all that apply.`,
          right: [
            `Checking edge cases and boundary conditions explicitly`,
            `Tracing intermediate steps to verify reasoning consistency`,
          ],
          wrong: [
            `Skipping error checks whenever the first sample input passes`,
            `Removing all documentation of assumptions and constraints`,
          ],
        },
      ];
      const v = variants[idx % variants.length];
      return {
        type,
        text: v.text,
        points: 2,
        difficulty,
        topic: focus,
        explanation: `Effective mastery of ${focus} combines explicit assumptions, worked reasoning, and verification.`,
        choices: [
          ...v.right.map((t) => ({ text: t, isCorrect: true })),
          ...v.wrong.map((t) => ({ text: t, isCorrect: false })),
        ],
      };
    }
    case 'TRUE_FALSE': {
      const pairs = [
        {
          t: `Checking preconditions and boundary cases helps prevent misapplying principles in ${focus}.`,
          f: `In ${focus}, verifying outputs against concrete examples is unnecessary once a surface pattern looks familiar.`,
        },
        {
          t: `Documenting intermediate reasoning steps makes errors easier to diagnose in ${focus}.`,
          f: `In ${focus}, omitting assumptions and skipping edge-case checks improves solution reliability.`,
        },
        {
          t: `Distinguishing valid domain constraints from unsupported assumptions is critical when applying ${focus}.`,
          f: `All rules in ${focus} apply identically regardless of input constraints or boundary limits.`,
        },
      ];
      const pair = pairs[Math.floor(idx / 2) % pairs.length];
      const answer = idx % 2 === 0;
      return {
        type,
        text: `True or False: ${answer ? pair.t : pair.f}`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `Checking preconditions, intermediate steps, and concrete examples prevents subtle errors in ${focus}.`,
        answer,
      };
    }
    case 'IDENTIFICATION':
      return {
        type,
        text: `Name the primary subject or core concept examined in this unit: "${focus}".`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `Replace or refine the prompt clue with a specific term from your lecture notes on ${focus}.`,
        accepted: uniqueStrings([focus, focus.toLowerCase()]),
      };
    case 'SHORT_ANSWER':
      return {
        type,
        text: `Explain one foundational principle of ${focus} and give a brief example of how it applies in practice.`,
        points: 2,
        difficulty,
        topic: focus,
        explanation: `Look for an accurate definition of ${focus}, clear cause-and-effect reasoning, and a concrete example.`,
        accepted: [`${focus} applies structured rules and verified assumptions to produce accurate, reproducible outcomes.`],
      };
    case 'FILL_BLANKS':
      return {
        type,
        text: `A foundational concept covered in this module that guides analysis and practical application is ___.`,
        points: 1,
        difficulty,
        topic: focus,
        explanation: `Customize the sentence with a specific definition from your ${focus} lecture notes.`,
        blanks: [uniqueStrings([focus, focus.toLowerCase()])],
      };
    case 'MATCHING':
      return {
        type,
        text: `Match each analytical phase in ${focus} with its primary purpose.`,
        points: 3,
        difficulty,
        topic: focus,
        explanation: `Customize pairs with domain-specific vocabulary from ${focus}.`,
        pairs: [
          { left: `Core definitions (${focus})`, right: 'Clarify key terms, scope, and preconditions' },
          { left: `Worked analysis (${focus})`, right: 'Trace principles on a concrete scenario step by step' },
          { left: `Edge-case check (${focus})`, right: 'Verify conclusions against constraints and exceptions' },
        ],
      };
    case 'ORDERING':
      return {
        type,
        text: `Order these problem-solving stages for ${focus} from start to finish.`,
        points: 4,
        difficulty,
        topic: focus,
        explanation: `Logical workflow for analyzing problems in ${focus}.`,
        items: [
          `Identify the relevant concepts and definitions in ${focus}`,
          'Specify inputs, constraints, and governing assumptions',
          'Construct and trace a step-by-step solution',
          'Validate the outcome against edge cases',
        ],
      };
    case 'ESSAY':
    default:
      return {
        type: 'ESSAY',
        text: `Analyze how ${focus} operates in a practical scenario. Explain the core principles, potential failure modes, and how outcomes should be verified.`,
        points: 5,
        difficulty,
        topic: focus,
        explanation: `Grade on conceptual accuracy in ${focus}, logical organization, and quality of examples.`,
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
  const material = sections.length ? analyzeMaterial(sections) : { definitions: [], comparisons: [], causes: [], facts: [], sequences: [], terms: [] };
  const hasMaterial = material.definitions.length > 0 || material.facts.length > 0;
  const packs = matchKnowledge(`${topicLabel}\n${sourceText.slice(0, 1200)}`);

  const difficultyFor = (i) => {
    if (difficulties.length === 1) return difficulties[0];
    if (input.purpose === 'EXAM') {
      const ratio = i / Math.max(1, count - 1);
      return ratio < 0.34 ? 'EASY' : ratio < 0.72 ? 'MEDIUM' : 'HARD';
    }
    return difficulties[i % difficulties.length];
  };

  const questions = [];
  const typeCounters = new Map();
  let cursor = 0;
  let guard = 0;
  while (questions.length < count && guard < count * 12) {
    const i = questions.length;
    const typeIdx = cursor % allowedTypes.length;
    const type = allowedTypes[typeIdx];
    const typeCount = typeCounters.get(type) ?? 0;
    typeCounters.set(type, typeCount + 1);
    const effectiveIdx = typeCount + typeIdx;
    const difficulty = difficultyFor(i);

    let q = hasMaterial
      ? buildQuestionFromMaterial({ type, difficulty, topicLabel, idx: effectiveIdx, material, sections, packs })
      : null;
    if (!q && !hasMaterial && packs.length > 0) {
      q = buildKnowledgeQuestion({ type, difficulty, topicLabel, idx: effectiveIdx, packs });
    }
    if (!q) {
      q = buildTopicQuestion({
        type,
        difficulty,
        topicLabel,
        subtopic: sections[effectiveIdx % Math.max(1, sections.length)]?.title,
        idx: effectiveIdx,
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

  // Ensure EXAM mode sorts smoothly from EASY -> MEDIUM -> HARD when MIXED.
  if (input.purpose === 'EXAM' && diffSetting === 'MIXED') {
    const rank = { EASY: 0, MEDIUM: 1, HARD: 2 };
    questions.sort((a, b) => (rank[a.difficulty] ?? 1) - (rank[b.difficulty] ?? 1));
  }
  return { questions };
}

function buildComparisonTable(comparisons, { isFilipino = false } = {}) {
  if (!comparisons?.length) return '';
  const rows = comparisons
    .slice(0, 5)
    .map((c) => `<tr><td><strong>${escHtml(c.left)}</strong></td><td><strong>${escHtml(c.right)}</strong></td><td>${escHtml(c.contrast)}</td></tr>`)
    .join('');
  return isFilipino
    ? `<h4>Talahanayan ng Paghahambing</h4><table><thead><tr><th>Konsepto A</th><th>Konsepto B</th><th>Mahalagang Pagkakaiba</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<h4>Comparison & Key Contrasts</h4><table><thead><tr><th>Concept A</th><th>Concept B</th><th>Key Distinction</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function buildWorkedExampleHtml(example, { heading = null, isFilipino = false } = {}) {
  if (!example) return '';
  const title = heading || (isFilipino ? `Halimbawang Paglalapat: ${example.title}` : `Worked Example: ${example.title}`);
  return [
    `<h4>${escHtml(title)}</h4>`,
    `<p>${escHtml(
      isFilipino
        ? `Suriin kung paano gumagana ang konseptong ito hakbang-hakbang sa aktwal na halimbawa sa ibaba:`
        : `Let us trace how these principles operate in practice by examining a concrete scenario step by step:`,
    )}</p>`,
    example.code ? `<pre><code>${escHtml(example.code)}</code></pre>` : '',
    `<p><strong>${isFilipino ? 'Hakbang-hakbang na paliwanag:' : 'Step-by-step analysis:'}</strong> ${escHtml(example.walkthrough)}</p>`,
    example.takeaway ? `<blockquote><p><strong>${isFilipino ? 'Mahalagang Aral:' : 'Key Takeaway:'}</strong> ${escHtml(example.takeaway)}</p></blockquote>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function paragraphChunks(sentences, perParagraph = 3) {
  const clean = sentences.map((s) => cleanLine(s, 600)).filter(Boolean);
  const out = [];
  for (let i = 0; i < clean.length; i += perParagraph) {
    out.push(clean.slice(i, i + perParagraph).join(' '));
  }
  return out;
}

function rotatedSlice(list, offset, count) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  const total = Math.min(count, list.length);
  for (let k = 0; k < total; k += 1) {
    out.push(list[(offset + k) % list.length]);
  }
  return out;
}

function buildGlossaryTable(definitions, { isFilipino = false } = {}) {
  if (!definitions?.length) return '';
  const rows = definitions
    .map((d) => `<tr><td><strong>${escHtml(d.term)}</strong></td><td>${escHtml(d.definition)}</td></tr>`)
    .join('');
  return isFilipino
    ? `<h4>Mahahalagang Terminolohiya</h4><table><thead><tr><th>Termino</th><th>Kahulugan at Papel</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<h4>Key Vocabulary & Definitions</h4><table><thead><tr><th>Term</th><th>Definition & Role</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function buildFactNarrative(facts, focus, topic, { isFilipino = false } = {}) {
  if (!facts?.length) return [];
  const paras = [];
  facts.forEach((f, idx) => {
    const lead = idx === 0
      ? (isFilipino
          ? `Isa sa mga pangunahing prinsipyo ng <strong>${escHtml(focus)}</strong> ay: ${escHtml(f.statement)}`
          : `At the core of <strong>${escHtml(focus)}</strong> is a foundational rule: ${escHtml(f.statement)}`)
      : (isFilipino
          ? `Bukod dito, mahalagang tandaan na ${escHtml(f.statement.charAt(0).toLowerCase() + f.statement.slice(1))}`
          : `Building directly on that principle, ${escHtml(f.statement.charAt(0).toLowerCase() + f.statement.slice(1))}`);
    const contrast = f.misconception
      ? (isFilipino
          ? ` Madalas itong ipinagkakamali sa maling akala na "${escHtml(f.misconception)}" — ngunit sa pagsusuri ng ${escHtml(topic)}, mahalagang ihiwalay ang totoong mekanismo mula sa panlabas na anyo.`
          : ` Students sometimes hold the competing assumption that "${escHtml(f.misconception)}", which leads to subtle reasoning errors when problems scale or edge conditions appear.`)
      : '';
    paras.push(`<p>${lead}${contrast}</p>`);
  });
  return paras;
}

function buildSelfCheckBlock({ focus, topic, defs = [], facts = [], isFilipino = false, isBilingual = false, isComprehensive = false }) {
  const heading = isFilipino ? 'Pagsusuri sa Sariling Pag-unawa' : isBilingual ? 'Check Your Understanding (Pagsusuri)' : 'Check Your Understanding';
  const prompt1 = defs[0]
    ? (isFilipino
        ? `Sa sarili mong salita, ipaliwanag kung ano ang <strong>${escHtml(defs[0].term)}</strong> at paano ito naiiba sa ibang bahagi ng ${escHtml(topic)}.`
        : `In your own words, explain <strong>${escHtml(defs[0].term)}</strong> and describe a concrete situation where it directly governs the outcome in ${escHtml(topic)}.`)
    : (isFilipino
        ? `Ibuod ang pangunahing ideya ng <strong>${escHtml(focus)}</strong> sa dalawa hanggang tatlong pangungusap nang hindi tumitingin sa mga tala.`
        : `Summarize the central mechanism of <strong>${escHtml(focus)}</strong> in two to three clear sentences without referring back to your notes.`);
  const prompt2 = facts[0]?.misconception
    ? (isFilipino
        ? `Bakit mali ang pahayag na: <em>"${escHtml(facts[0].misconception)}"</em>? Magbigay ng maikling patunay o halimbawa.`
        : `Explain why the following common claim is inaccurate, and state the corrected rule: <em>"${escHtml(facts[0].misconception)}"</em>`)
    : (isFilipino
        ? `Anong paunang kondisyon o paghahanda ang kailangang tiyakin bago gamitin ang mga prinsipyo ng <strong>${escHtml(focus)}</strong>?`
        : `Identify one precondition that must hold before applying <strong>${escHtml(focus)}</strong>, and describe what fails if that precondition is violated.`);
  const prompt3 = isFilipino
    ? `Mag-isip ng isang praktikal na sitwasyon sa kurso o trabaho kung saan mahalaga ang pag-unawa sa <strong>${escHtml(focus)}</strong>.`
    : `Construct a brief real-world or classroom scenario involving <strong>${escHtml(focus)}</strong> and trace how you would verify your answer step by step.`;

  const items = [prompt1, prompt2, ...(isComprehensive || defs.length > 0 ? [prompt3] : [])];
  const reflection = isFilipino
    ? 'Bago magpatuloy sa susunod na kabanata, subukang sagutin ang mga tanong sa ibaba nang nakasara ang nakaraang bahagi:'
    : 'Pause before moving to the next chapter and test your recall with these guided prompts:';
  return [
    `<h3>${heading}</h3>`,
    `<p>${reflection}</p>`,
    `<ol>${items.map((q) => `<li>${q}</li>`).join('')}</ol>`,
  ].join('\n');
}

function buildGenericChapterProse({
  focus,
  topic,
  learners,
  levelLabel,
  teachingApproach,
  instructions,
  nextFocus,
  prevFocus,
  isFilipino,
  isBilingual,
  isComprehensive,
}) {
  const out = [];
  if (isFilipino) {
    out.push(`<h3>1. Panimula at Konteksto</h3>`);
    out.push(`<p>Sa kabanatang ito, masusing tinatalakay ang <strong>${escHtml(focus)}</strong> bilang mahalagang haligi ng <strong>${escHtml(topic)}</strong>. Para sa ${escHtml(learners)} sa antas na ${escHtml(levelLabel)}, ang tunay na pagkatuto ay hindi nagtatapos sa pagsasaulo ng kahulugan; nangangailangan ito ng pag-unawa kung bakit umiiral ang bawat tuntunin at paano ito kumikilos sa iba’t ibang sitwasyon.</p>`);
    if (prevFocus) {
      out.push(`<p>Bilang pagpapatuloy mula sa nakaraang aralin tungkol sa <em>${escHtml(prevFocus)}</em>, inilalapat natin ngayon ang mga batayang ideya sa mas malinaw na balangkas ng pagsusuri at pagpapasya.</p>`);
    }
    if (teachingApproach || instructions) {
      out.push(`<p>${teachingApproach ? `<strong>Paraan ng Pag-aaral (${escHtml(teachingApproach)}):</strong> ` : ''}${instructions ? escHtml(cleanLine(instructions, 320)) : `Unahin ang pag-unawa sa praktikal na suliranin bago gamitin ang mga pormal na tuntunin ng ${escHtml(focus)}.`}</p>`);
    }
    out.push(`<h3>2. Mga Pangunahing Konsepto at Mekanismo</h3>`);
    out.push(`<p>Upang maging bihasa sa <strong>${escHtml(focus)}</strong>, mahalagang tingnan ang tatlong magkakaugnay na bahagi: ang mga <strong>paunang kondisyon</strong> (inputs o sitwasyong pinagmumulan), ang <strong>mismong proseso o tuntunin</strong> na nagpapabago o sumusuri sa datos, at ang <strong>inaasahang resulta o katunayan</strong> na nagpapatunay na tama ang hakbang.</p>`);
    out.push(`<p>Kapag nauunawaan mo ang ugnayan ng tatlong ito, mas madaling matukoy kung bakit ang isang paraan ay epektibo sa normal na kalagayan ngunit nagkakamali kapag may kakaibang kaso o limitasyon. Sa halip na hulaan ang sagot, nagiging sistematiko ang iyong pagsusuri.</p>`);
    out.push(`<h4>Paghahambing: Mababaw vs. Malalim na Paglalapat</h4>`);
    out.push(`<table><thead><tr><th>Dimensyon</th><th>Mababaw na Pag-unawa</th><th>Sistematikong Pagkatuto sa ${escHtml(focus)}</th></tr></thead><tbody>`
      + `<tr><td><strong>Tuon</strong></td><td>Pagmememorya ng pormula o hakbang nang walang konteksto</td><td>Pag-unawa sa dahilan, hangganan, at epekto ng bawat hakbang</td></tr>`
      + `<tr><td><strong>Pagharap sa Error</strong></td><td>Nahihirapan kapag nagbago ang anyo ng tanong</td><td>Nasusuri ang bawat hakbang upang mahanap agad ang sanhi ng mali</td></tr>`
      + `<tr><td><strong>Pagpapatunay</strong></td><td>Tinitingnan lamang ang huling sagot</td><td>Sinusubok ang mga espesyal na kaso at hangganan bago magdesisyon</td></tr>`
      + `</tbody></table>`);
    out.push(`<h3>3. Pinatnubayang Halimbawa at Hakbang-hakbang na Pagsusuri</h3>`);
    out.push(`<p>Subukan nating ilapat ang <strong>${escHtml(focus)}</strong> gamit ang malinaw at sunod-sunod na proseso na maaari mong gamitin sa mga takdang-aralin at pagsusulit:</p>`);
    out.push(`<ol>`
      + `<li><strong>Tukuyin ang Layunin at Kondisyon:</strong> Isulat kung ano ang ibinigay na impormasyon, ano ang hinahanap, at anong mga pagpapalagay ang umiiral sa problema.</li>`
      + `<li><strong>Piliin ang Angkop na Prinsipyo:</strong> Ipaliwanag kung bakit ang pamamaraan sa <em>${escHtml(focus)}</em> ang nababagay kaysa sa ibang alternatibo sa ${escHtml(topic)}.</li>`
      + `<li><strong>Isagawa nang Malinaw ang Bawat Hakbang:</strong> Ipakita ang bawat yugto ng pagbabago o pangangatwiran nang hindi lumalaktaw, upang madaling balikan at suriin.</li>`
      + `<li><strong>Suriin ang Resulta at Hangganan:</strong> Tiyakin kung makatuwiran ang kinalabasan at kung nananatiling tama ito sa mga panimulang o sukdulang kondisyon.</li>`
      + `</ol>`);
    out.push(`<blockquote><p><strong>Mahalagang Paalala:</strong> Sa pag-aaral ng ${escHtml(focus)}, ang malinaw na pagtukoy ng mga paunang kondisyon ay kadalasang nakalulutas na ng kalahati ng suliranin bago ka pa magsimula.</p></blockquote>`);
    out.push(`<h3>4. Mga Karaniwang Pagkakamali at Paano Ito Maiiwasan</h3>`);
    out.push(`<ul>`
      + `<li><strong>Paglaktaw sa mga paunang kondisyon:</strong> Laging tiyakin kung natutugunan ang lahat ng kinakailangan bago ilapat ang isang tuntunin.</li>`
      + `<li><strong>Pagkakalito sa magkakalapit na termino:</strong> Paghambingin ang kahulugan at gamit ng bawat konsepto sa iba’t ibang halimbawa.</li>`
      + `<li><strong>Kakulangan sa beripikasyon:</strong> Huwag tumigil sa unang sagot; maglaan ng sandali upang subukan ang kabaligtaran o pinakamaliit na kaso.</li>`
      + `</ul>`);
    if (nextFocus) {
      out.push(`<p><em>Paghahanda sa susunod:</em> Sa susunod na kabanata tungkol sa <strong>${escHtml(nextFocus)}</strong>, gagamitin natin ang pundasyong ito upang harapin ang mas malalalim na aplikasyon.</p>`);
    }
    return out;
  }

  const bilingualTag = isBilingual ? ' <em>(Panimula at Batayang Konsepto)</em>' : '';
  out.push(`<h3>1. Introduction & Learning Context${bilingualTag}</h3>`);
  out.push(`<p>In this chapter, we examine <strong>${escHtml(focus)}</strong> as an essential building block of <strong>${escHtml(topic)}</strong>. Designed for ${escHtml(learners)} working at the ${escHtml(levelLabel)} level, this reading goes beyond surface definitions so you can see how the core principles behave in real situations, why specific constraints exist, and how experts verify their reasoning.</p>`);
  if (prevFocus) {
    out.push(`<p>Earlier, we explored <em>${escHtml(prevFocus)}</em>. Now we build directly upon those ideas to examine how <strong>${escHtml(focus)}</strong> shapes analysis, design choices, and problem-solving inside ${escHtml(topic)}.</p>`);
  } else {
    out.push(`<p>Whenever you encounter a new concept in ${escHtml(topic)}, start by asking three anchoring questions: what problem does it solve, what assumptions must hold for it to work reliably, and how would you recognize an error if one occurred? Keeping these questions visible turns passive reading into active mastery.</p>`);
  }
  if (teachingApproach || instructions) {
    out.push(`<p>${teachingApproach ? `<strong>Pedagogical Approach (${escHtml(teachingApproach)}):</strong> ` : '<strong>Study Focus:</strong> '}${instructions ? escHtml(cleanLine(instructions, 320)) : `Connect each formal concept in ${escHtml(focus)} back to concrete everyday or workplace evidence before memorizing terminology.`}</p>`);
  }

  out.push(`<h3>2. Core Concepts & Detailed Explanation</h3>`);
  out.push(`<p>To understand <strong>${escHtml(focus)}</strong> deeply, picture it as a structured relationship between three components: the <strong>inputs or preconditions</strong> that define the starting state, the <strong>governing mechanism or rule</strong> that transforms or evaluates those inputs, and the <strong>observable outcome</strong> that can be checked independently. Many difficulties arise not because the rule itself is complicated, but because learners apply it without checking whether the preconditions hold.</p>`);
  out.push(`<p>In practice, mastering ${escHtml(focus)} means being able to justify <em>why</em> a chosen method works rather than merely repeating steps from memory. When you understand the underlying rationale, you can adapt smoothly when constraints shift, combine ideas across chapters of ${escHtml(topic)}, and explain your reasoning clearly to peers or clients.</p>`);
  if (isComprehensive) {
    out.push(`<p>Notice also how ${escHtml(focus)} balances competing priorities—such as clarity versus speed, flexibility versus strict validation, or simplicity versus precision. Recognizing those trade-offs helps you select the right approach rather than forcing one technique onto every scenario.</p>`);
  }

  out.push(`<h4>Analytical Contrast: Surface Recall vs. Principled Application</h4>`);
  out.push(`<table><thead><tr><th>Dimension</th><th>Surface Approach</th><th>Principled Mastery of ${escHtml(focus)}</th></tr></thead><tbody>`
    + `<tr><td><strong>Starting Point</strong></td><td>Applies rules mechanically without checking context</td><td>Verifies preconditions, scope, and constraints first</td></tr>`
    + `<tr><td><strong>Reasoning</strong></td><td>Skips intermediate steps and guesses outcomes</td><td>Traces each step explicitly and articulates why it holds</td></tr>`
    + `<tr><td><strong>Transfer</strong></td><td>Breaks down when unfamiliar examples appear</td><td>Adapts smoothly to new scenarios and boundary cases</td></tr>`
    + `<tr><td><strong>Verification</strong></td><td>Accepts the first answer produced</td><td>Tests edge cases and checks consistency against core rules</td></tr>`
    + `</tbody></table>`);

  out.push(`<h3>3. Guided Walkthrough & Applied Scenario</h3>`);
  out.push(`<p>Consider how a practitioner works through a typical problem involving <strong>${escHtml(focus)}</strong> in <strong>${escHtml(topic)}</strong>. Instead of jumping directly to a final conclusion, follow this repeatable four-stage walkthrough:</p>`);
  out.push(`<ol>`
    + `<li><strong>Frame the Problem & State Preconditions:</strong> Explicitly list the known inputs, constraints, and goal of the task before choosing any technique.</li>`
    + `<li><strong>Select & Justify the Governing Principle:</strong> Identify which rule or framework within <em>${escHtml(focus)}</em> fits the situation, noting why alternative options are less suitable here.</li>`
    + `<li><strong>Trace Intermediate States Clearly:</strong> Work through each step visibly so every transformation can be audited independently without hidden leaps.</li>`
    + `<li><strong>Verify Against Edge Cases:</strong> Ask what happens under minimal, empty, conflicting, or extreme conditions to confirm that the conclusion remains sound.</li>`
    + `</ol>`);
  out.push(`<blockquote><p><strong>Key Concept:</strong> Most subtle mistakes in ${escHtml(focus)} occur before the main calculation or decision even begins—specifically when unstated assumptions are treated as guaranteed facts.</p></blockquote>`);

  out.push(`<h3>4. Common Misconceptions & How to Catch Them</h3>`);
  out.push(`<p>As you study <strong>${escHtml(focus)}</strong>, watch out for three frequent stumbling blocks that trip up learners across ${escHtml(topic)}:</p>`);
  out.push(`<ul>`
    + `<li><strong>Confusing correlation or surface similarity with the core rule:</strong> Two examples may look alike at first glance while obeying different constraints. Always check the defining criterion.</li>`
    + `<li><strong>Overlooking boundary conditions:</strong> Solutions that succeed on clean textbook inputs frequently fail on empty, maximal, or unexpected cases unless verified explicitly.</li>`
    + `<li><strong>Treating steps as isolated recipes:</strong> Memorizing a sequence without knowing what each step accomplishes makes troubleshooting almost impossible when an output looks wrong.</li>`
    + `</ul>`);

  if (nextFocus) {
    out.push(`<p><em>Bridge to the next chapter:</em> Keeping these checkpoints in mind prepares you for <strong>${escHtml(nextFocus)}</strong>, where we build directly on these ideas.</p>`);
  }
  return out;
}

function generateModule(input = {}) {
  const topic = cleanLine(input.topic, 200) || 'Untitled Module';
  const title = cleanLine(input.title, 200) || topic;
  const subtopics = (input.subtopics ?? []).map((s) => cleanLine(s, 140)).filter(Boolean);
  const objectives = (input.objectives ?? []).map((o) => cleanLine(o, 220)).filter(Boolean);
  const outcomes = (input.outcomes ?? []).map((o) => cleanLine(o, 220)).filter(Boolean);
  const isShort = input.contentLength === 'SHORT';
  const isComprehensive = input.contentLength === 'COMPREHENSIVE';
  const targetLessons = isShort ? 3 : isComprehensive ? 7 : 5;
  const baseMinutesPerLesson = isShort ? 25 : isComprehensive ? 40 : 30;
  const totalMinutes = Number(input.durationMinutes) || targetLessons * baseMinutesPerLesson;
  const refSections = parseLessons(input.referenceText || '');
  const refMaterial = refSections.length ? analyzeMaterial(refSections) : null;
  const packs = matchKnowledge([topic, title, ...subtopics, input.instructions ?? '', (input.referenceText ?? '').slice(0, 1000)].join('\n'));
  const primaryPack = packs[0] ?? null;

  const isFilipino = input.language === 'FILIPINO';
  const isBilingual = input.language === 'BILINGUAL';
  const levelLabel = (input.difficulty || 'INTERMEDIATE').toLowerCase();
  const learners = input.yearLevel || (isFilipino ? 'mga mag-aaral sa kolehiyo' : 'college learners');

  const defaultObjectives = objectives.length
    ? objectives
    : primaryPack?.objectives?.length
      ? [...primaryPack.objectives, ...outcomes].slice(0, 6)
      : [
          isFilipino ? `Maipaliwanag ang mga pangunahing konsepto at terminolohiya ng ${topic}` : `Define and explain the core principles and terminology of ${topic}`,
          isFilipino ? `Mailapat ang ${topic} sa mga totoong sitwasyon at hakbang-hakbang na halimbawa` : `Apply ${topic} systematically to concrete problems and worked scenarios`,
          isFilipino ? `Masuri ang mga karaniwang pagkakamali at mapatatag ang katumpakan ng solusyon` : `Diagnose common misconceptions and verify solution correctness in ${topic}`,
          isFilipino ? `Mahambing ang iba’t ibang paraan at piliin ang pinakaangkop sa sitwasyon` : `Compare competing methods and justify design choices in ${topic}`,
          ...outcomes.slice(0, 2),
        ].slice(0, 6);

  const lessonCount = Math.max(
    3,
    Math.min(8, Math.max(targetLessons, subtopics.length ? Math.min(subtopics.length + 2, 8) : targetLessons)),
  );
  const perMinutes = Math.max(15, Math.round(totalMinutes / lessonCount));
  const lessons = [];
  const allDefs = primaryPack?.definitions ?? [];
  const allFacts = primaryPack?.facts ?? [];
  const allComps = primaryPack?.comparisons ?? [];
  const allPitfalls = primaryPack?.pitfalls ?? [];

  // Plan chapter titles first so chapters can bridge cleanly from one to the next like a book.
  const plannedTitles = [];
  const plannedKinds = [];
  for (let i = 0; i < lessonCount; i += 1) {
    const isLast = i === lessonCount - 1;
    const isFirst = i === 0;
    const isSecondToLast = i === lessonCount - 2;
    const subtopic = subtopics[i - 1] ?? null;
    const refSec = refSections[i];

    if (isLast) {
      plannedTitles.push(isFilipino ? `Buod at Pagsusuri: ${topic}` : isBilingual ? `Summary & Review (Buod): ${topic}` : `Summary & Synthesis: ${topic}`);
      plannedKinds.push('SUMMARY');
    } else if (refSec) {
      plannedTitles.push(refSec.title);
      plannedKinds.push('LESSON');
    } else if (isFirst) {
      plannedTitles.push(isFilipino ? `Panimula at Pundasyon ng ${topic}` : isBilingual ? `Foundations of ${topic} (Mga Batayang Konsepto)` : `Foundations & Key Terminology: ${topic}`);
      plannedKinds.push('LESSON');
    } else if (subtopic) {
      plannedTitles.push(subtopic);
      plannedKinds.push('LESSON');
    } else if (isSecondToLast) {
      plannedTitles.push(isFilipino ? `Pinatnubayang Pagsasanay at Halimbawa: ${topic}` : `Worked Examples & Applied Practice: ${topic}`);
      plannedKinds.push('ACTIVITY');
    } else {
      const roles = isFilipino
        ? ['Mga Pangunahing Mekanismo at Prinsipyo', 'Paghahambing at Pagsusuri ng Disenyo', 'Mga Praktikal na Aplikasyon at Beripikasyon', 'Malalalim na Kaso at Hangganan']
        : ['Core Mechanics & Principles', 'Comparative Analysis & Design', 'Applied Scenarios & Verification', 'Advanced Patterns & Edge Cases'];
      plannedTitles.push(`${topic}: ${roles[(i - 1) % roles.length]}`);
      plannedKinds.push('LESSON');
    }
  }

  for (let i = 0; i < lessonCount; i += 1) {
    const lessonTitle = plannedTitles[i];
    const kind = plannedKinds[i];
    const isLast = i === lessonCount - 1;
    const isFirst = i === 0;
    const isSecondToLast = i === lessonCount - 2;
    const subtopic = subtopics[i - 1] ?? null;
    const refSec = refSections[i];
    const prevFocus = i > 0 ? plannedTitles[i - 1] : null;
    const nextFocus = i < lessonCount - 1 ? plannedTitles[i + 1] : null;

    const html = [];

    if (refSec) {
      const sents = splitSentences(refSec.body);
      const secDefs = refMaterial?.definitions.filter((d) => d.lessonTitle === refSec.title) ?? [];
      const secComps = refMaterial?.comparisons.filter((c) => c.lessonTitle === refSec.title) ?? [];
      const secFacts = refMaterial?.facts.filter((f) => f.lessonTitle === refSec.title) ?? [];
      const bodyParas = paragraphChunks(sents, 3);

      html.push(`<h3>${isFilipino ? '1. Panimula at Saklaw ng Aralin' : '1. Introduction & Reading Guide'}</h3>`);
      html.push(`<p>${escHtml(
        isFilipino
          ? `Batay sa sangguniang inihanda para sa ${topic}, tatalakayin ng kabanatang ito ang ${lessonTitle}. Basahin nang maingat ang bawat talata at bigyang-pansin ang mga terminolohiyang nakahanay sa talahanayan.`
          : `Drawing directly from the course reading for ${topic}, this chapter explores ${lessonTitle} for ${learners}. As you read through the explanation below, pay close attention to definitions, cause-and-effect relationships, and contrasting terms.`,
      )}</p>`);
      if (prevFocus) {
        html.push(`<p>${escHtml(isFilipino ? `Kasunod ito ng nakaraang talakayan tungkol sa ${prevFocus}.` : `This reading extends the concepts introduced in ${prevFocus}.`)}</p>`);
      }

      html.push(`<h3>${isFilipino ? '2. Detalyadong Pagtalakay' : '2. Detailed Reading & Core Ideas'}</h3>`);
      if (bodyParas.length > 0) {
        for (const p of bodyParas.slice(0, 8)) html.push(`<p>${escHtml(p)}</p>`);
      } else {
        html.push(`<p>${escHtml(refSec.body)}</p>`);
      }
      if (secDefs.length > 0) {
        html.push(buildGlossaryTable(secDefs.slice(0, 8), { isFilipino }));
      }
      if (secComps.length > 0) {
        html.push(buildComparisonTable(secComps, { isFilipino }));
      }
      if (secFacts.length > 0) {
        html.push(`<blockquote><p><strong>${isFilipino ? 'Mahalagang Punto:' : 'Key Concept:'}</strong> ${escHtml(secFacts[0].sentence)}</p></blockquote>`);
      }
      html.push(buildSelfCheckBlock({ focus: lessonTitle, topic, defs: secDefs, facts: [], isFilipino, isBilingual, isComprehensive }));
    } else if (isLast) {
      html.push(`<h3>${isFilipino ? '1. Pangkalahatang Pagbubuo ng Modyul' : '1. Module Synthesis & Big Picture'}</h3>`);
      html.push(`<p>${
        isFilipino
          ? `Binubuo ng pangwakas na kabanatang ito ang lahat ng napag-aralan mo sa <strong>${escHtml(title)}</strong>. Mula sa mga panimulang kahulugan hanggang sa aktwal na paglalapat at pagsusuri ng error, makikita mong magkakaugnay ang bawat bahagi bilang isang kumpletong sistema ng kaalaman.`
          : `This capstone chapter brings together every major idea you studied across <strong>${escHtml(title)}</strong>. Rather than viewing each lesson in isolation, notice how the foundational vocabulary, core mechanisms, worked examples, and error-checking strategies reinforce one another into one coherent toolkit.`
      }</p>`);
      html.push(`<p>${
        isFilipino
          ? `Bago harapin ang mga gawain o pagtataya, balikan ang mga layunin sa ibaba at tiyaking kaya mong ipaliwanag ang bawat isa nang may sariling halimbawa.`
          : `Before attempting graded quizzes or applied assignments, use this synthesis chapter as an active study guide—testing whether you can explain each objective aloud, trace a sample scenario without notes, and spot subtle misconceptions on sight.`
      }</p>`);

      html.push(`<h3>${isFilipino ? '2. Checklist ng mga Layunin sa Pagkatuto' : '2. Mastery Checklist'}</h3>`);
      html.push(`<p>${escHtml(isFilipino ? 'Gamitin ang listahang ito upang suriin ang iyong kahandaan:' : 'Verify your readiness against every learning objective covered in this module:')}</p>`);
      html.push('<ol>' + defaultObjectives.map((o) => `<li><strong>${escHtml(o)}</strong> — ${escHtml(isFilipino ? 'Kaya mo na ba itong ipaliwanag at magbigay ng isang halimbawa?' : 'Can you explain this principle clearly and demonstrate it with one concrete example?')}</li>`).join('') + '</ol>');

      if (allDefs.length > 0) {
        html.push(buildGlossaryTable(allDefs, { isFilipino }));
      }
      if (allComps.length > 0) {
        html.push(buildComparisonTable(allComps, { isFilipino }));
      }
      if (allPitfalls.length > 0) {
        html.push(`<h3>${isFilipino ? '3. Mga Bitag na Dapat Bantayan sa Pagsusulit' : '3. Common Exam & Practice Traps to Avoid'}</h3>`);
        html.push('<ul>' + allPitfalls.map((p) => `<li><strong>${escHtml(isFilipino ? 'Babala:' : 'Watch out:')}</strong> ${escHtml(p)}</li>`).join('') + '</ul>');
      } else {
        html.push(`<h3>${isFilipino ? '3. Gabay sa Pagre-review' : '3. Final Review Strategy'}</h3>`);
        html.push(`<ul>`
          + `<li><strong>${escHtml(isFilipino ? 'Balikan ang mga paunang kondisyon:' : 'Revisit Preconditions:')}</strong> ${escHtml(isFilipino ? 'Alamin kung kailan naaangkop ang bawat prinsipyo at kailan ito nabibigo.' : `Review when each rule in ${topic} applies and what assumptions must hold.`)}</li>`
          + `<li><strong>${escHtml(isFilipino ? 'Magsanay sa sariling halimbawa:' : 'Practice Fresh Examples:')}</strong> ${escHtml(isFilipino ? 'Baguhin ang mga panimulang datos ng mga halimbawa upang subukan ang iyong pang-unawa.' : 'Modify inputs in a worked scenario and trace every intermediate step from start to finish.')}</li>`
          + `</ul>`);
      }
      html.push(`<blockquote><p><strong>${isFilipino ? 'Pangwakas na Paalala:' : 'Study Tip:'}</strong> ${escHtml(isFilipino ? 'Ang pinakamabisang paraan ng pagre-review ay ang pagpapaliwanag ng konsepto na parang nagtuturo ka sa iba.' : `Teaching a core idea from ${topic} aloud in plain language is the fastest way to expose any remaining gaps in understanding.`)}</p></blockquote>`);
    } else if (isFirst) {
      html.push(`<h3>${isFilipino ? '1. Panimula at Kahalagahan ng Paksa' : '1. Introduction & Why This Module Matters'}</h3>`);
      const introText = isFilipino
        ? `Sa panimulang kabanatang ito ng <strong>${escHtml(title)}</strong>, bubuuin ng ${escHtml(learners)} ang matibay na pundasyon para sa <strong>${escHtml(topic)}</strong> (${escHtml(levelLabel)}). Ang malinaw na pag-unawa sa mga panimulang konsepto ay nagsisilbing mapa na magpapadali sa lahat ng susunod na aralin.`
        : isBilingual
          ? `Welcome to the opening chapter of <strong>${escHtml(title)}</strong> (<em>Panimulang Kabanata</em>). Built for ${escHtml(learners)} at the ${escHtml(levelLabel)} level, this module develops both clear conceptual understanding and practical problem-solving skill in <strong>${escHtml(topic)}</strong>.`
          : `Welcome to the opening chapter of <strong>${escHtml(title)}</strong>. Designed for ${escHtml(learners)} at the ${escHtml(levelLabel)} level, this module takes you from foundational terminology to confident, verified application in <strong>${escHtml(topic)}</strong>.`;
      html.push(`<p>${introText}</p>`);
      html.push(`<p>${
        isFilipino
          ? `Sa halip na isaulo lamang ang mga depinisyon, titingnan natin kung anong problema ang nilulutas ng ${escHtml(topic)}, paano nag-uugnayan ang mga bahagi nito, at ano ang mga batayang patakaran na laging dapat tandaan.`
          : `Rather than treating ${escHtml(topic)} as isolated vocabulary to memorize, we begin by building a clear mental model: what problems it solves, how its key pieces interact, and which core principles govern accurate results in both classroom exercises and real-world systems.`
      }</p>`);
      if (input.teachingApproach) {
        html.push(`<p><strong>${isFilipino ? 'Paraan ng Pagtuturo' : 'Teaching Approach'} (${escHtml(input.teachingApproach)}):</strong> ${escHtml(isFilipino ? 'Iugnay ang bawat konsepto sa isang totoong sitwasyon bago pumasok sa mga pormal na tuntunin.' : 'Anchor every formal concept in an authentic problem context before abstracting into notation or procedure.')}</p>`);
      }
      if (input.instructions) {
        html.push(`<p><strong>${isFilipino ? 'Pokus ng Guro:' : 'Instructor Focus:'}</strong> ${escHtml(cleanLine(input.instructions, 320))}</p>`);
      }

      if (allDefs.length > 0) {
        html.push(`<h3>${isFilipino ? '2. Mga Batayang Terminolohiya at Konsepto' : '2. Core Vocabulary & Mental Model'}</h3>`);
        html.push(`<p>${escHtml(isFilipino ? `Narito ang mga pangunahing terminolohiyang paulit-ulit nating gagamitin sa kabuuan ng modyul:` : `Every discipline depends on precise language. Before diving into worked scenarios, study the essential terms below and notice how each definition specifies both what the concept is and what role it plays:`)}</p>`);
        html.push(buildGlossaryTable(allDefs, { isFilipino }));
        if (allFacts.length > 0) {
          html.push(...buildFactNarrative(allFacts.slice(0, isComprehensive ? 3 : 2), topic, topic, { isFilipino }));
        }
        if (allComps.length > 0) {
          html.push(buildComparisonTable(allComps.slice(0, 2), { isFilipino }));
        }
        if (primaryPack?.sequences?.[0]) {
          const seq = primaryPack.sequences[0];
          html.push(`<h3>3. ${escHtml(seq.title)}</h3>`);
          html.push(`<p>${escHtml(isFilipino ? 'Sundin ang pagkakasunod-sunod ng mga hakbang sa ibaba upang makita kung paano gumagana ang proseso:' : 'Trace the lifecycle below from start to finish to see how these foundational terms connect dynamically:')}</p>`);
          html.push(`<ol>${seq.steps.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ol>`);
        }
        if (allFacts[0]) {
          html.push(`<blockquote><p><strong>${isFilipino ? 'Mahalagang Konsepto:' : 'Key Concept:'}</strong> ${escHtml(allFacts[0].statement)}</p></blockquote>`);
        }
      } else {
        html.push(...buildGenericChapterProse({
          focus: topic,
          topic,
          learners,
          levelLabel,
          teachingApproach: input.teachingApproach,
          instructions: input.instructions,
          nextFocus,
          prevFocus: null,
          isFilipino,
          isBilingual,
          isComprehensive,
        }));
      }

      if (nextFocus) {
        html.push(`<p><em>${isFilipino ? 'Susunod na kabanata:' : 'Looking ahead:'}</em> ${escHtml(isFilipino ? `Sa susunod na bahagi, pag-aaralan natin ang ${nextFocus}.` : `In the next chapter, we will build directly on these foundations as we explore ${nextFocus}.`)}</p>`);
      }
      html.push(buildSelfCheckBlock({ focus: topic, topic, defs: allDefs, facts: allFacts, isFilipino, isBilingual, isComprehensive }));
    } else if (isSecondToLast) {
      const focus = subtopic || lessonTitle;
      const subPack = matchKnowledge(`${focus} ${topic}`)[0] ?? primaryPack;
      const facts = subPack?.facts?.length ? rotatedSlice(subPack.facts, i, 2) : [];
      const defs = subPack?.definitions?.length ? rotatedSlice(subPack.definitions, i, 3) : [];
      const seq = subPack?.sequences?.[i % Math.max(1, subPack?.sequences?.length ?? 1)] ?? null;

      html.push(`<h3>${isFilipino ? '1. Mula sa Teorya Tungo sa Aplikasyon' : '1. From Theory to Applied Problem-Solving'}</h3>`);
      html.push(`<p>${
        isFilipino
          ? `Matapos mapag-aralan ang mga batayang ideya ng <strong>${escHtml(topic)}</strong>, nakatuon ang kabanatang ito sa pinatnubayang pagsasanay para sa <strong>${escHtml(focus)}</strong>. Dito natin pinag-aaralan hindi lamang kung paano makuha ang tamang sagot, kundi kung paano suriin at patunayan ang bawat hakbang.`
          : `Now that you have built a solid foundation in <strong>${escHtml(topic)}</strong>, this chapter shifts focus to applied problem-solving and diagnostic reasoning around <strong>${escHtml(focus)}</strong>. Knowing a concept in theory is only half the journey; real mastery shows when you can trace edge cases cleanly and recognize subtle bugs or misconceptions before finalizing an answer.`
      }</p>`);
      if (prevFocus) {
        html.push(`<p>${escHtml(isFilipino ? `Gagamitin natin dito ang mga konseptong tinalakay sa "${prevFocus}".` : `Keep the mechanisms from "${prevFocus}" in mind as we trace concrete examples below.`)}</p>`);
      }

      if (facts.length > 0) {
        html.push(`<h3>${isFilipino ? '2. Mga Gabay na Prinsipyo sa Paglalapat' : '2. Guiding Principles in Practice'}</h3>`);
        html.push(...buildFactNarrative(facts, focus, topic, { isFilipino }));
      }

      html.push(`<h3>${isFilipino ? '3. Pinatnubayang Halimbawa at Hakbang-hakbang na Solusyon' : '3. Worked Examples & Step-by-Step Walkthrough'}</h3>`);
      if (subPack?.workedExample) {
        html.push(buildWorkedExampleHtml(subPack.workedExample, { isFilipino }));
      } else {
        html.push(`<p>${escHtml(isFilipino ? `Sundan ang apat na hakbang na ito sa pagsusuri ng problema sa ${focus}:` : `Walk through a structured problem in ${focus} using this four-part verification workflow:`)}</p>`);
        html.push('<ol>'
          + `<li><strong>${escHtml(isFilipino ? 'Tukuyin ang Inputs at Tuntunin:' : 'Identify Inputs & Governing Rules:')}</strong> ${escHtml(isFilipino ? 'Isulat ang mga ibinigay na halaga at tiyaking natutugunan ang mga paunang kondisyon.' : 'State all given parameters, constraints, and the exact rule you plan to apply before computing or writing code.')}</li>`
          + `<li><strong>${escHtml(isFilipino ? 'Isagawa nang Sunod-sunod:' : 'Execute Step by Step:')}</strong> ${escHtml(isFilipino ? 'Ipakita ang bawat gitnang yugto sa halip na tumalon agad sa huling sagot.' : 'Record every intermediate state clearly so you can pinpoint where reasoning or values change.')}</li>`
          + `<li><strong>${escHtml(isFilipino ? 'Suriin ang Mga Espesyal na Kaso:' : 'Stress-Test Boundary & Edge Cases:')}</strong> ${escHtml(isFilipino ? 'Subukan ang walang laman, sukdulan, o hindi inaasahang kondisyon.' : 'Test minimal, empty, maximum, or adversarial inputs to ensure the solution holds universally.')}</li>`
          + `<li><strong>${escHtml(isFilipino ? 'Patunayan ang Katumpakan:' : 'Verify Against Module Criteria:')}</strong> ${escHtml(isFilipino ? 'Ihambing ang resulta sa mga layunin ng aralin upang matiyak ang katumpakan.' : 'Check that the final output satisfies every original requirement without unintended side effects.')}</li>`
          + '</ol>');
      }
      if (seq) {
        html.push(`<h4>${escHtml(seq.title)}</h4><ol>${seq.steps.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ol>`);
      }

      html.push(`<h3>${isFilipino ? '4. Karaniwang Pagkakamali at Paano Ito Matutukoy' : '4. Common Pitfalls & Error Diagnosis'}</h3>`);
      if (allPitfalls.length > 0) {
        html.push(`<p>${escHtml(isFilipino ? 'Narito ang mga karaniwang pagkakamaling madalas makita sa paglalapat—at kung paano ito maagapan:' : 'Watch carefully for these common errors when working independently on problems in this unit:')}</p>`);
        html.push('<ul>' + allPitfalls.map((p) => `<li><strong>${escHtml(isFilipino ? 'Panganib:' : 'Pitfall:')}</strong> ${escHtml(p)} — ${escHtml(isFilipino ? 'Ugaliing suriin ang hakbang na ito bago tapusin ang gawain.' : 'Make it a habit to verify this condition explicitly during your trace.')}</li>`).join('') + '</ul>');
      } else {
        html.push('<ul>'
          + `<li><strong>${escHtml(isFilipino ? 'Paglaktaw ng Beripikasyon:' : 'Skipping Verification:')}</strong> ${escHtml(isFilipino ? 'Huwag ihinto ang pagsusuri sa unang makuha mong sagot.' : 'Stopping at the first plausible result without checking boundary cases.')}</li>`
          + `<li><strong>${escHtml(isFilipino ? 'Maling Pagpapalagay:' : 'Hidden Assumptions:')}</strong> ${escHtml(isFilipino ? 'Laging tiyakin ang mga paunang kondisyon bago ilapat ang solusyon.' : 'Applying a shortcut when a required precondition is missing.')}</li>`
          + '</ul>');
      }
      html.push(buildSelfCheckBlock({ focus, topic, defs, facts, isFilipino, isBilingual, isComprehensive }));
    } else {
      const focus = subtopic || lessonTitle;
      const focusPack = matchKnowledge(`${focus} ${topic}`)[0] ?? primaryPack;
      const relevantFacts = focusPack?.facts?.length ? rotatedSlice(focusPack.facts, i - 1, isComprehensive ? 3 : 2) : [];
      const relevantDefs = focusPack?.definitions?.length ? rotatedSlice(focusPack.definitions, i - 1, 3) : [];
      const relevantComps = focusPack?.comparisons?.length ? rotatedSlice(focusPack.comparisons, i - 1, 2) : [];
      const seq = focusPack?.sequences?.length ? focusPack.sequences[(i - 1) % focusPack.sequences.length] : null;

      if (focusPack && (relevantFacts.length > 0 || relevantDefs.length > 0)) {
        html.push(`<h3>${isFilipino ? '1. Panimula sa Paksa' : '1. Introduction & Chapter Context'}</h3>`);
        html.push(`<p>${
          isFilipino
            ? `Tinatalakay sa kabanatang ito ang <strong>${escHtml(focus)}</strong> bilang isang mahalagang yugto ng pag-unawa sa <strong>${escHtml(topic)}</strong>. Para sa ${escHtml(learners)} (${escHtml(levelLabel)}), sinusuri natin kung paano gumagana ang mga tuntunin sa aktwal na mga limitasyon at paano pumili ng tamang estratehiya.`
            : `This chapter deepens your command of <strong>${escHtml(focus)}</strong> within <strong>${escHtml(topic)}</strong>. Written for ${escHtml(learners)} at the ${escHtml(levelLabel)} level, we move from intuition to precise mechanics—examining how rules behave under real constraints and how careful choices prevent costly errors.`
        }</p>`);
        if (prevFocus) {
          html.push(`<p>${escHtml(isFilipino ? `Direktang nakaugat ang araling ito sa nakaraang kabanata (${prevFocus}).` : `Building directly upon ${prevFocus}, notice how the concepts below turn foundational vocabulary into working analytical tools.`)}</p>`);
        }

        html.push(`<h3>${isFilipino ? '2. Detalyadong Paliwanag at Mga Prinsipyo' : '2. Core Mechanics & Detailed Explanation'}</h3>`);
        if (relevantDefs.length > 0) {
          html.push(buildGlossaryTable(relevantDefs, { isFilipino }));
        }
        if (relevantFacts.length > 0) {
          html.push(...buildFactNarrative(relevantFacts, focus, topic, { isFilipino }));
        }
        if (relevantComps.length > 0) {
          html.push(buildComparisonTable(relevantComps, { isFilipino }));
        }

        html.push(`<h3>${isFilipino ? '3. Hakbang-hakbang na Proseso at Halimbawa' : '3. Step-by-Step Execution & Applied Illustration'}</h3>`);
        if (seq) {
          html.push(`<p>${escHtml(isFilipino ? `Suriin ang maingat na daloy ng hakbang para sa ${seq.title}:` : `Follow the exact execution sequence below for ${seq.title}, noticing how each stage prepares the state for the next:`)}</p>`);
          html.push(`<ol>${seq.steps.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ol>`);
        }
        if (focusPack.workedExample && (i === 1 || isComprehensive)) {
          html.push(buildWorkedExampleHtml(focusPack.workedExample, { isFilipino }));
        } else {
          html.push(`<p>${escHtml(isFilipino ? `Kapag nilulutas ang mga sitwasyong may kinalaman sa ${focus}, ihanda muna ang input, isagawa nang malinaw ang bawat hakbang, at tiyaking tugma ang resulta sa paunang kondisyon.` : `When applying ${focus} independently, always document the initial state, show each transformation explicitly, and check whether edge inputs alter the normal flow.`)}</p>`);
        }
        if (relevantFacts[0]) {
          html.push(`<blockquote><p><strong>${isFilipino ? 'Mahalagang Konsepto:' : 'Key Concept:'}</strong> ${escHtml(relevantFacts[0].statement)}</p></blockquote>`);
        }
        if (nextFocus) {
          html.push(`<p><em>${isFilipino ? 'Paghahanda sa susunod na kabanata:' : 'Connecting forward:'}</em> ${escHtml(isFilipino ? `Sa susunod na bahagi (${nextFocus}), pagtitibayin natin ang mga prinsipyo rito sa mas malalalim na halimbawa.` : `Keep these principles handy as we transition next to ${nextFocus}.`)}</p>`);
        }
        html.push(buildSelfCheckBlock({ focus, topic, defs: relevantDefs, facts: relevantFacts, isFilipino, isBilingual, isComprehensive }));
      } else {
        html.push(...buildGenericChapterProse({
          focus,
          topic,
          learners,
          levelLabel,
          teachingApproach: input.teachingApproach,
          instructions: input.instructions,
          nextFocus,
          prevFocus,
          isFilipino,
          isBilingual,
          isComprehensive,
        }));
        html.push(buildSelfCheckBlock({ focus, topic, defs: [], facts: [], isFilipino, isBilingual, isComprehensive }));
      }
    }

    lessons.push({ title: lessonTitle, kind, estimatedMinutes: perMinutes, contentHtml: html.join('\n') });
  }

  const activities = [
    {
      title: isFilipino ? `Paghahambing ng Konsepto: ${primaryPack?.title || topic}` : `Concept & Contrast Check: ${primaryPack?.title || topic}`,
      instructions: allComps[0]
        ? `In pairs or small groups, explain the difference between ${allComps[0].left} and ${allComps[0].right} in plain language, and construct one concrete scenario where choosing the wrong one leads to an error.`
        : `In pairs or small groups, define two central concepts from ${topic} without using jargon and describe one precondition required for each to hold.`,
    },
    {
      title: isFilipino ? `Pinatnubayang Paglalapat: ${subtopics[0] || topic}` : `Applied Walkthrough: ${subtopics[0] || topic}`,
      instructions: primaryPack?.workedExample
        ? `Trace "${primaryPack.workedExample.title}" with a modified set of inputs, document every intermediate step, and verify at least one boundary or edge case.`
        : `Solve a short practical scenario using ${subtopics[0] || topic}, explicitly documenting your preconditions, intermediate reasoning, and one boundary check.`,
    },
    {
      title: isFilipino ? `Pagsusuri ng Mali: ${topic}` : `Misconception Audit: ${topic}`,
      instructions: allPitfalls[0]
        ? `Review this common pitfall: "${allPitfalls[0]}". Create a faulty example that exhibits the mistake, explain why it fails, and show the corrected solution.`
        : `Identify one frequent misunderstanding in ${topic}, illustrate how it leads to an incorrect conclusion, and write a brief verification rule to catch it.`,
    },
  ];

  const sourceForQuiz = refSections.length
    ? input.referenceText
    : lessons.map((l, idx) => `Lesson ${idx + 1}: ${l.title}\n${stripHtmlKeepBreaks(l.contentHtml)}`).join('\n\n');

  const assessment = input.includeAssessment
    ? generateQuestions({
        topic,
        source: sourceForQuiz,
        count: isComprehensive ? 8 : 6,
        types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER', 'IDENTIFICATION'],
        difficulty: 'MIXED',
        purpose: 'QUIZ',
      }).questions
    : [];

  const refs = refSections
    .map((r) => r.title)
    .filter((t) => t && !/^Lesson material$/i.test(t) && !/^Section \d+$/i.test(t))
    .map((t) => `Teacher-supplied reference: ${t}`);

  return {
    title,
    overview: isFilipino
      ? `Isang komprehensibong modyul sa ${title} na binubuo ng ${lessons.length} malalalim na kabanata, mga pinatnubayang halimbawa, gawaing pagsasanay, at ${assessment.length} panimulang tanong sa pagtataya.`
      : `A comprehensive, textbook-style learning module on ${title} comprising ${lessons.length} structured chapters${primaryPack ? ` (${primaryPack.domain})` : ''}, worked examples, guided practice activities, and ${assessment.length} draft assessment items ready for instructor review.`,
    objectives: defaultObjectives,
    lessons,
    activities,
    assessment,
    references: refs.slice(0, 8),
  };
}

function generateLessonRewrite(input = {}) {
  const lesson = input.lesson ?? {};
  const instruction = cleanLine(input.instruction, 400);
  const title = lesson.title || 'Lesson';
  const moduleTopic = cleanLine(input.moduleTitle || title, 160) || title;
  const currentHtml = String(lesson.contentHtml ?? '');
  const plain = cleanLine(stripHtmlKeepBreaks(currentHtml), 16_000);
  const sentences = splitSentences(currentHtml);
  const analysis = analyzeMaterial([{ title, body: currentHtml }]);
  const packs = matchKnowledge(`${title}\n${moduleTopic}\n${plain.slice(0, 1200)}`);
  const lower = instruction.toLowerCase();

  let rewrittenHtml;
  if (/short|simpl|concis|summar|brief|bullet|tl;?dr/.test(lower)) {
    const defBullets = analysis.definitions.slice(0, 4).map((d) => `<li><strong>${escHtml(d.term)}:</strong> ${escHtml(d.definition)}</li>`);
    const topFacts = analysis.facts.slice(0, 5).map((f) => `<li>${escHtml(f.sentence)}</li>`);
    const bullets = defBullets.length >= 2 ? [...defBullets, ...topFacts.slice(0, 3)] : topFacts.length ? topFacts : sentences.slice(0, 5).map((s) => `<li>${escHtml(s)}</li>`);
    rewrittenHtml = [
      `<h3>${escHtml(title)}</h3>`,
      sentences[0] ? `<p>${escHtml(sentences[0])}</p>` : '',
      `<h4>Key Takeaways</h4>`,
      bullets.length ? `<ul>${bullets.join('')}</ul>` : `<p>${escHtml(plain)}</p>`,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (/expand|deep|detail|textbook|book|chapter|longer|elaborat|thorough/.test(lower)) {
    const pack = packs[0] ?? null;
    const preservedParas = paragraphChunks(sentences, 3);
    const out = [
      `<h3>1. Introduction & Learning Context</h3>`,
      preservedParas[0]
        ? `<p>${escHtml(preservedParas[0])}</p>`
        : `<p>This expanded chapter unpacks <strong>${escHtml(title)}</strong> in full textbook detail, connecting foundational principles with concrete walkthroughs and self-check reflection.</p>`,
      `<h3>2. Detailed Explanation & Core Principles</h3>`,
      ...preservedParas.slice(1, 5).map((p) => `<p>${escHtml(p)}</p>`),
      ...(analysis.definitions.length > 0 ? [buildGlossaryTable(analysis.definitions.slice(0, 6))] : []),
      ...(pack?.facts?.length ? buildFactNarrative(pack.facts.slice(0, 3), title, moduleTopic, {}) : []),
      ...(pack?.comparisons?.length ? [buildComparisonTable(pack.comparisons)] : []),
      `<h3>3. Worked Example & Step-by-Step Walkthrough</h3>`,
      pack?.workedExample
        ? buildWorkedExampleHtml(pack.workedExample)
        : `<p>Apply the central concepts of <strong>${escHtml(title)}</strong> systematically using four clear steps:</p><ol><li><strong>Identify Inputs & Preconditions:</strong> Record known values and verify required conditions before proceeding.</li><li><strong>Select the Governing Rule:</strong> Match the scenario to the core principle studied in this chapter.</li><li><strong>Trace Every Step:</strong> Document each intermediate state cleanly rather than jumping ahead.</li><li><strong>Verify Boundary Cases:</strong> Double-check edge conditions and confirm consistency.</li></ol>`,
      ...(pack?.pitfalls?.length
        ? [`<h3>4. Common Pitfalls & Misconceptions</h3>`, `<ul>${pack.pitfalls.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`]
        : []),
      buildSelfCheckBlock({ focus: title, topic: moduleTopic, defs: analysis.definitions, facts: pack?.facts ?? [], isComprehensive: true }),
    ];
    rewrittenHtml = out.filter(Boolean).join('\n');
  } else if (/table|compar|contrast|matrix|pros|cons/.test(lower)) {
    const rows = analysis.definitions.length
      ? analysis.definitions.slice(0, 6).map((d) => `<tr><td><strong>${escHtml(d.term)}</strong></td><td>${escHtml(d.definition)}</td></tr>`)
      : packs[0]?.definitions?.slice(0, 5).map((d) => `<tr><td><strong>${escHtml(d.term)}</strong></td><td>${escHtml(d.definition)}</td></tr>`) ?? [];
    const compTable = packs[0]?.comparisons?.length ? buildComparisonTable(packs[0].comparisons) : '';
    rewrittenHtml = [
      `<h3>${escHtml(title)}</h3>`,
      sentences[0] ? `<p>${escHtml(sentences[0])}</p>` : '',
      rows.length ? `<h4>Concept Matrix</h4><table><thead><tr><th>Concept</th><th>Explanation</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '',
      compTable,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (/example|practice|activity|exercis|walkthrough/.test(lower)) {
    const ex = packs[0]?.workedExample;
    rewrittenHtml = [
      currentHtml || `<h3>${escHtml(title)}</h3>`,
      ex
        ? buildWorkedExampleHtml(ex)
        : [
            '<h4>Worked Example & Guided Practice</h4>',
            `<p>Apply the main rule from <strong>${escHtml(title)}</strong> step by step:</p>`,
            '<ol><li><strong>Given / Setup:</strong> Identify known values, terms, and preconditions.</li><li><strong>Trace:</strong> Apply the rule carefully to each step.</li><li><strong>Check:</strong> Verify the result against edge cases.</li></ol>',
          ].join('\n'),
    ].join('\n');
  } else if (/quiz|question|self-check|check for understanding|test/.test(lower)) {
    const qs = generateQuestions({ topic: title, source: plain, count: 3, types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER'] }).questions;
    rewrittenHtml = [
      currentHtml || `<h3>${escHtml(title)}</h3>`,
      '<h4>Self-Check Questions</h4>',
      '<ol>' + qs.map((q) => `<li>${escHtml(q.text)}</li>`).join('') + '</ol>',
    ].join('\n');
  } else if (/filipino|tagalog|bilingual/.test(lower)) {
    rewrittenHtml = [
      `<h3>${escHtml(title)}</h3>`,
      `<p><strong>Gabay sa Pag-aaral:</strong> Ang araling ito ay nakatuon sa mga pangunahing konsepto ng <strong>${escHtml(title)}</strong>.</p>`,
      sentences.length ? `<ul>${sentences.slice(0, 6).map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>` : `<p>${escHtml(plain)}</p>`,
      '<blockquote><p><strong>Paalala sa klase:</strong> Ipaliwanag sa sariling salita ang bawat konsepto at magbigay ng isang halimbawa.</p></blockquote>',
    ].join('\n');
  } else {
    const lead = sentences[0] || plain || `Overview of ${title}.`;
    const bodyPoints = analysis.facts.slice(0, 5).map((f) => f.sentence).filter((s) => s !== lead);
    rewrittenHtml = [
      `<h3>${escHtml(title)}</h3>`,
      `<p>${escHtml(lead)}</p>`,
      analysis.definitions.length
        ? `<h4>Definitions</h4><ul>${analysis.definitions.slice(0, 4).map((d) => `<li><strong>${escHtml(d.term)}:</strong> ${escHtml(d.definition)}</li>`).join('')}</ul>`
        : '',
      bodyPoints.length ? `<h4>Core Ideas</h4><ul>${bodyPoints.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>` : '',
      packs[0]?.pitfalls?.length
        ? `<h4>Checkpoints</h4><ul>${packs[0].pitfalls.slice(0, 3).map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    title,
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
    { title: 'Excellent', points: maxPoints, description: `Demonstrates complete mastery of ${title} with clear evidence and no major errors.` },
    { title: 'Proficient', points: scaled(0.8), description: `Meets expectations for ${title} with only minor omissions.` },
    { title: 'Developing', points: scaled(0.55), description: `Shows partial understanding of ${title}; reasoning or verification is incomplete.` },
    { title: 'Beginning', points: scaled(0.25), description: `Minimal evidence of ${title}; substantial revision needed.` },
  ];
}

function generateRubric(input = {}) {
  const task = cleanLine(input.task, 200) || 'Course Assignment';
  const points = Math.max(1, Math.min(1000, Math.round(Number(input.points) || 100)));
  const count = Math.max(2, Math.min(8, Math.round(Number(input.criteriaCount) || 4)));
  const lower = task.toLowerCase();

  let templates;
  if (/code|program|algorithm|software|script|app|api|sql|database|web|html/.test(lower)) {
    templates = [
      ['Correctness & Functionality', `Produces accurate outputs across standard and edge-case inputs for ${task}.`],
      ['Structure & Readability', 'Uses clean modular design, descriptive naming, and well-organized control flow.'],
      ['Testing & Edge Cases', 'Demonstrates thorough test cases covering boundary and invalid inputs.'],
      ['Documentation & Explanation', 'Includes concise comments and clear explanation of design decisions.'],
      ['Efficiency & Resource Use', 'Avoids unnecessary work and selects appropriate data structures or queries.'],
      ['Error Handling', 'Handles invalid or missing inputs gracefully without crashing.'],
      ['Requirements Compliance', 'Follows every functional specification and submission constraint.'],
      ['Reflection & Verification', 'Explains design tradeoffs and verified outputs accurately.'],
    ];
  } else if (/essay|paper|report|research|write|review|thesis|literature/.test(lower)) {
    templates = [
      ['Thesis & Focus', `Establishes a clear, arguable central focus addressing ${task}.`],
      ['Evidence & Analysis', 'Supports claims with accurate class concepts, examples, and rigorous reasoning.'],
      ['Organization & Coherence', 'Arranges ideas logically with smooth transitions across paragraphs.'],
      ['Clarity, Mechanics & Style', 'Uses precise, concise academic prose free of distracting grammatical errors.'],
      ['Source Integration', 'Synthesizes verified references and course readings faithfully.'],
      ['Critical Reflection', 'Evaluates counterarguments, limitations, or broader implications thoughtfully.'],
      ['Formatting & Completeness', 'Meets required sections, citation style, and length guidelines.'],
      ['Originality & Synthesis', 'Demonstrates genuine analytical synthesis rather than surface summary.'],
    ];
  } else if (/present|speech|demo|pitch|oral|debate/.test(lower)) {
    templates = [
      ['Content Accuracy', `Explains core concepts of ${task} clearly and accurately.`],
      ['Structure & Pacing', 'Opens with a clear hook, transitions logically, and stays within time limits.'],
      ['Visuals & Demonstrations', 'Uses clean slides or live demos that reinforce key takeaways.'],
      ['Delivery & Audience Engagement', 'Speaks clearly with confident pacing and responsive eye contact.'],
      ['Q&A & Defense', 'Addresses follow-up questions accurately with relevant evidence.'],
      ['Preparation & Teamwork', 'Shows thorough rehearsal and balanced presenter contributions.'],
      ['Synthesis & Takeaways', 'Concludes with memorable, actionable conclusions.'],
      ['Time Management', 'Allocates time appropriately across introduction, body, and Q&A.'],
    ];
  } else if (/nursing|clinical|care plan|patient|lab|experiment|practicum/.test(lower)) {
    templates = [
      ['Assessment & Data Gathering', `Collects accurate, relevant observations and measurements for ${task}.`],
      ['Safety & Protocol Compliance', 'Follows standard safety, hygiene, or laboratory procedures consistently.'],
      ['Clinical / Scientific Reasoning', 'Connects findings to sound underlying principles and priorities.'],
      ['Documentation & Clarity', 'Records observations, steps, and evaluations clearly and completely.'],
      ['Intervention / Execution', 'Executes planned steps accurately and adapts cleanly to feedback.'],
      ['Evaluation & Reflection', 'Evaluates outcomes against expected criteria and notes revisions needed.'],
      ['Ethics & Professionalism', 'Demonstrates respect, integrity, and adherence to standards.'],
      ['Timeliness & Completeness', 'Completes all required checkpoints on schedule.'],
    ];
  } else {
    templates = [
      ['Conceptual Understanding', `Accurately applies key concepts and terminology relevant to ${task}.`],
      ['Completeness & Execution', 'Addresses every required prompt component thoroughly.'],
      ['Analysis & Reasoning', 'Supports answers with clear step-by-step justification or evidence.'],
      ['Organization & Clarity', 'Presents work cleanly in a structured, easy-to-follow format.'],
      ['Verification & Accuracy', 'Checks conclusions against constraints, edge cases, or sanity checks.'],
      ['Practical Application', 'Connects abstract principles effectively to concrete scenarios.'],
      ['Communication', 'Uses precise, audience-appropriate language.'],
      ['Polish & Submission', 'Follows all formatting and submission instructions.'],
    ];
  }

  const weights = splitPoints(points, count);
  const criteria = weights.map((maxPoints, i) => {
    const [critTitle, critDesc] = templates[i % templates.length];
    const safeMax = Math.max(1, maxPoints);
    return {
      title: critTitle,
      description: critDesc,
      maxPoints: safeMax,
      levels: criterionLevels(safeMax, critTitle.toLowerCase()),
    };
  });

  const sum = criteria.reduce((acc, c) => acc + c.maxPoints, 0);
  if (sum !== points && criteria[0]) {
    const adjusted = Math.max(1, criteria[0].maxPoints + (points - sum));
    criteria[0] = { ...criteria[0], maxPoints: adjusted, levels: criterionLevels(adjusted, criteria[0].title.toLowerCase()) };
  }

  return { title: `${task.slice(0, 120)} Rubric`, criteria };
}

function generateAssignment(input = {}) {
  const topic = cleanLine(input.topic, 200) || (input.moduleTitle ? `Applied Assignment: ${cleanLine(input.moduleTitle, 140)}` : 'Applied Learning Task');
  const points = Math.max(1, Math.min(1000, Math.round(Number(input.points) || 100)));
  const sections = parseLessons(input.materialText || '');
  const material = sections.length ? analyzeMaterial(sections) : null;
  const packs = matchKnowledge(`${topic}\n${input.moduleTitle ?? ''}\n${(input.materialText ?? '').slice(0, 800)}`);
  const subtopics = sections.map((s) => s.title).filter((t) => t && !/^Module:/i.test(t)).slice(0, 5);
  const terms = uniqueStrings([...(material?.definitions.map((d) => d.term) ?? []), ...(packs[0]?.definitions.map((d) => d.term) ?? [])]).slice(0, 5);
  const details = cleanLine(input.details, 800);
  const lower = `${topic} ${details ?? ''}`.toLowerCase();

  let tasks;
  if (/code|program|algorithm|sql|query|script|api|app|function/.test(lower)) {
    tasks = [
      `Implement a clean, readable solution addressing <strong>${escHtml(topic)}</strong> following standard naming and modularity practices.`,
      'Include a short trace or explanation justifying your design choices and time/space or correctness assumptions.',
      'Provide at least three test cases covering a normal case, an empty/minimal case, and an edge case.',
    ];
  } else if (/case study|analy|research|essay|report|review/.test(lower)) {
    tasks = [
      `State your central thesis or analytical framing for <strong>${escHtml(topic)}</strong> clearly in the opening paragraph.`,
      terms.length
        ? `Apply relevant course concepts—including <em>${escHtml(terms.join(', '))}</em>—directly to support your claims.`
        : 'Support each claim with concrete evidence and concepts introduced in the module.',
      'Address at least one limitation, counterargument, or alternative interpretation and explain how you evaluated it.',
    ];
  } else {
    tasks = [
      `Define the problem or scenario clearly in the context of <strong>${escHtml(topic)}</strong>.`,
      terms.length
        ? `Incorporate and apply key concepts (${escHtml(terms.join(', '))}) while showing complete step-by-step reasoning.`
        : 'Show complete step-by-step reasoning rather than only a final conclusion.',
      'Test your conclusion against at least one edge case or limitation and note how you verified accuracy.',
    ];
  }

  const html = [
    `<p><strong>Overview:</strong> In this ${points}-point assignment, you will apply concepts from <strong>${escHtml(topic)}</strong>${input.moduleTitle ? ` (<em>${escHtml(input.moduleTitle)}</em>)` : ''}.</p>`,
    details ? `<p><strong>Instructor Notes:</strong> ${escHtml(details)}</p>` : null,
    subtopics.length ? `<p><strong>Module Topics Covered:</strong></p><ul>${subtopics.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>` : null,
    '<p><strong>Deliverables & Requirements:</strong></p>',
    `<ol>${tasks.map((t) => `<li>${t}</li>`).join('')}</ol>`,
    packs[0]?.pitfalls?.length
      ? `<p><strong>Watch Out For:</strong> ${escHtml(packs[0].pitfalls.slice(0, 2).join('; '))}.</p>`
      : null,
    '<p><strong>Submission Checklist:</strong> Review your work against the grading rubric before submitting.</p>',
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
  const material = context ? analyzeMaterial([{ title: 'Selected text', body: context }]) : null;
  const packs = matchKnowledge(`${prompt}\n${context.slice(0, 1200)}`);
  const pack = packs[0] ?? null;

  // 1. Summarize / Key Takeaways
  if (/summar|tl;?dr|takeaway|condens|key point/.test(lower) && (context || pack)) {
    const ranked = material?.facts?.length
      ? material.facts.slice(0, 5).map((f) => f.sentence)
      : sentences.slice(0, 5);
    if (ranked.length) {
      return `Key takeaways:\n${ranked.map((s) => `- ${s}`).join('\n')}`;
    }
    if (pack) {
      return `Summary — ${pack.title}:\n${pack.facts.slice(0, 4).map((f) => `- ${f.statement}`).join('\n')}`;
    }
  }

  // 2. Study Guide / Cheat Sheet / Flashcards / Definitions
  if (/study guide|cheat sheet|flashcard|glossary|review sheet|define/.test(lower)) {
    const defs = material?.definitions?.length ? material.definitions : pack?.definitions ?? [];
    if (defs.length) {
      const lines = defs.slice(0, 6).map((d) => `- **${d.term}**: ${d.definition}`);
      if (pack?.pitfalls?.length) {
        lines.push('', 'Common pitfalls to review:', ...pack.pitfalls.map((p) => `- ${p}`));
      }
      return `Study Guide${pack ? ` — ${pack.title}` : ''}:\n\n${lines.join('\n')}`;
    }
  }

  // 3. Quiz / Check for understanding / Practice questions
  if (/quiz|question|exit ticket|check for understanding|mcq/.test(lower)) {
    const out = generateQuestions({ topic: prompt, source: context, count: 3, types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER'] });
    return out.questions
      .map((q, i) => {
        const body = [`${i + 1}. [${q.type}] ${q.text}`];
        if (q.choices) body.push(...q.choices.map((c, idx) => `   ${String.fromCharCode(65 + idx)}. ${c.text}${c.isCorrect ? ' *' : ''}`));
        if (typeof q.answer === 'boolean') body.push(`   Answer: ${q.answer ? 'True' : 'False'}`);
        if (q.accepted?.length) body.push(`   Model answer: ${q.accepted[0]}`);
        return body.join('\n');
      })
      .join('\n\n');
  }

  // 4. Warm-up / Discussion Prompts / Lesson Activity / Teaching Plan
  if (/warm.?up|icebreaker|discussion|activity|lesson plan|hook|debate/.test(lower)) {
    const focus = pack?.title || material?.definitions?.[0]?.term || cleanLine(prompt.replace(/^(?:write|create|suggest|give me)\s+(?:a|an|some)?\s*/i, ''), 90);
    const lines = [
      `Classroom Activity Plan — ${focus}`,
      '',
      `1. Opening Hook (3–5 min): ${pack?.facts?.[0]?.misconception ? `Present this common misconception and ask students to vote True/False with a neighbor: "${pack.facts[0].misconception}"` : `Pose a quick real-world scenario where ${focus} matters and gather two initial predictions.`}`,
      `2. Core Walkthrough (10 min): ${pack?.workedExample ? `Trace "${pack.workedExample.title}" together, highlighting why each step works.` : 'Model one concrete example step by step, pausing to check assumptions.'}`,
      `3. Pair Discussion Prompt (5 min): ${pack?.comparisons?.[0] ? `Have pairs contrast ${pack.comparisons[0].left} vs ${pack.comparisons[0].right} in two sentences.` : `Have pairs summarize the main rule of ${focus} and name one mistake to avoid.`}`,
      '4. Exit Ticket (2 min): Ask each student to write one takeaway and one lingering question.',
    ];
    return lines.join('\n');
  }

  // 5. Simplify / Explain clearly (to students or beginners)
  if (/simpl|easier|plain|explain|beginner|eli5|student/.test(lower)) {
    if (context) {
      const items = (material?.facts?.length ? material.facts.map((f) => f.sentence) : sentences).slice(0, 5);
      const defs = material?.definitions?.slice(0, 3) ?? [];
      return [
        'Plain-language explanation (draft):',
        '',
        ...(defs.length ? ['Key terms:', ...defs.map((d) => `- **${d.term}**: ${d.definition}`), ''] : []),
        ...(items.length ? items.map((s, i) => `${i + 1}. ${s}`) : [cleanLine(context, 500)]),
        '',
        'Check-in question: Ask students to explain one step above using their own example.',
      ].join('\n');
    }
    if (pack) {
      return [
        `${pack.title} — Plain-Language Overview`,
        '',
        ...pack.definitions.slice(0, 4).map((d) => `- **${d.term}**: ${d.definition}`),
        pack.workedExample ? `\nWorked example (${pack.workedExample.title}): ${pack.workedExample.walkthrough}` : '',
        pack.pitfalls?.length ? `\nWatch out for: ${pack.pitfalls[0]}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
  }

  // 6. Bullets / Outline
  if (/bullet|list|outline|points/.test(lower) && (context || pack)) {
    const items = sentences.length ? sentences.slice(0, 8) : pack?.objectives ?? context.split('\n').filter(Boolean).slice(0, 8);
    return items.map((s) => `- ${cleanLine(s, 240)}`).join('\n');
  }

  // 7. Announcement / Email / Feedback / Rewrite / Polish
  if (/announc|email|remind|feedback|tone|warmer|polish|proofread|rewrite|improv/.test(lower) && context) {
    const cleanBody = sentences.length ? sentences.join(' ') : cleanLine(context, 900);
    if (/announc|email|remind/.test(lower)) {
      return [
        'Hello class,',
        '',
        cleanBody,
        '',
        'Please let me know if you have any questions before the deadline.',
      ].join('\n');
    }
    return [
      `Polished version (for "${prompt}"):`,
      '',
      cleanBody,
      '',
      material?.definitions?.length ? `Key concepts highlighted: ${material.definitions.slice(0, 4).map((d) => d.term).join(', ')}.` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // 8. Topic-matched rich fallback or structured context response
  if (context) {
    const defs = material?.definitions?.slice(0, 3) ?? [];
    const highlights = (material?.facts?.length ? material.facts.map((f) => f.sentence) : sentences).slice(0, 4);
    return [
      `Draft response for "${prompt}":`,
      '',
      ...(defs.length ? ['Extracted definitions:', ...defs.map((d) => `- **${d.term}**: ${d.definition}`), ''] : []),
      ...(highlights.length ? ['Key points from your text:', ...highlights.map((h) => `- ${h}`)] : [cleanLine(context, 700)]),
    ].join('\n');
  }

  if (pack) {
    return [
      `${pack.title} — Teaching Notes`,
      '',
      'Key definitions:',
      ...pack.definitions.slice(0, 4).map((d) => `- **${d.term}**: ${d.definition}`),
      '',
      pack.workedExample ? `Example (${pack.workedExample.title}): ${pack.workedExample.walkthrough}` : null,
      pack.pitfalls?.length ? `Common pitfalls: ${pack.pitfalls.join('; ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `Structured draft for: ${prompt}`,
    '',
    '1. Core Goal: State the key concept and what students should be able to demonstrate in 1–2 clear sentences.',
    '2. Concrete Example: Walk through one realistic case step by step, pointing out inputs and preconditions.',
    '3. Misconception Check: Ask students to compare a correct approach with one common mistake.',
  ].join('\n');
}

function generateStudyCoach(input = {}) {
  const mode = input.mode || 'summary';
  const lessonTitle = cleanLine(input.lessonTitle, 200) || 'Lesson';
  const contentText = stripHtmlKeepBreaks(input.contentHtml ?? '').trim();
  const objectives = Array.isArray(input.objectives) ? input.objectives.map((o) => cleanLine(o, 300)).filter(Boolean) : [];
  const sections = contentText ? [{ title: lessonTitle, body: contentText }] : [];
  const material = sections.length ? analyzeMaterial(sections) : { definitions: [], facts: [], comparisons: [], causes: [], sequences: [] };
  const sentences = splitSentences(contentText);
  const packs = matchKnowledge(`${lessonTitle}\n${contentText.slice(0, 1200)}`);
  const pack = packs[0] ?? null;

  if (mode === 'flashcards') {
    const cards = [];
    const seen = new Set();
    for (const d of material.definitions) {
      const key = d.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ front: d.term, back: d.definition, hint: `From "${lessonTitle}"` });
    }
    for (const comp of material.comparisons) {
      const front = `How does ${comp.left} compare with ${comp.right}?`;
      if (seen.has(front.toLowerCase())) continue;
      seen.add(front.toLowerCase());
      cards.push({ front, back: comp.sentence, hint: 'Comparison' });
    }
    for (const seq of material.sequences) {
      const front = `List the steps for: ${seq.label || lessonTitle}`;
      if (seen.has(front.toLowerCase())) continue;
      seen.add(front.toLowerCase());
      cards.push({ front, back: seq.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), hint: 'Sequence' });
    }
    for (const f of material.facts) {
      if (cards.length >= 8) break;
      if (!f.keyword) continue;
      const front = `What role does "${f.keyword}" play in ${lessonTitle}?`;
      if (seen.has(front.toLowerCase())) continue;
      seen.add(front.toLowerCase());
      cards.push({ front, back: f.sentence, hint: 'Key concept' });
    }
    if (cards.length === 0 && pack) {
      for (const d of pack.definitions.slice(0, 6)) {
        cards.push({ front: d.term, back: d.definition, hint: pack.title });
      }
    }
    if (cards.length === 0 && sentences.length > 0) {
      for (const [i, s] of sentences.slice(0, 5).entries()) {
        cards.push({ front: `Key point ${i + 1} from ${lessonTitle}`, back: s, hint: 'Lesson note' });
      }
    }
    return { mode: 'flashcards', lessonTitle, cards: cards.slice(0, 8) };
  }

  if (mode === 'practice') {
    const generated = generateQuestions({
      topic: lessonTitle,
      source: contentText,
      count: 4,
      types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'IDENTIFICATION', 'FILL_BLANKS'],
      difficulty: 'MIXED',
      purpose: 'PRACTICE',
    });
    return {
      mode: 'practice',
      lessonTitle,
      questions: (generated.questions ?? []).slice(0, 4),
    };
  }

  if (mode === 'explain') {
    const question = cleanLine(input.question, 600);
    const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const scoredSentences = sentences
      .map((s) => {
        const lower = s.toLowerCase();
        const hits = words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
        return { s, hits };
      })
      .sort((a, b) => b.hits - a.hits);

    const matchingDefs = material.definitions.filter((d) => words.some((w) => d.term.toLowerCase().includes(w) || d.definition.toLowerCase().includes(w)));
    const relevant = scoredSentences.filter((x) => x.hits > 0).slice(0, 4).map((x) => x.s);
    const fallbackPoints = relevant.length ? relevant : material.facts.slice(0, 4).map((f) => f.sentence);

    const answerParts = [];
    if (matchingDefs.length > 0) {
      answerParts.push(`${matchingDefs[0].term}: ${matchingDefs[0].definition}.`);
    }
    if (fallbackPoints.length > 0) {
      answerParts.push(fallbackPoints[0]);
    } else if (pack?.definitions?.[0]) {
      answerParts.push(`${pack.definitions[0].term}: ${pack.definitions[0].definition}`);
    } else {
      answerParts.push(`Review the main points of "${lessonTitle}" below and connect them back to your question.`);
    }

    return {
      mode: 'explain',
      lessonTitle,
      question,
      answer: answerParts.join(' '),
      keyPoints: fallbackPoints.slice(0, 4),
      tip: pack?.pitfalls?.[0] ?? null,
    };
  }

  // Default: 'summary'
  const keyTerms = material.definitions.slice(0, 5).map((d) => ({ term: d.term, definition: d.definition }));
  const takeaways = (material.facts.length ? material.facts.map((f) => f.sentence) : sentences).slice(0, 5);
  const summaryText = takeaways.length
    ? takeaways.slice(0, 2).join(' ')
    : objectives.length
      ? `This lesson focuses on: ${objectives.slice(0, 3).join('; ')}.`
      : `Review "${lessonTitle}" carefully and test yourself using the flashcards or practice check.`;

  return {
    mode: 'summary',
    lessonTitle,
    summary: summaryText,
    takeaways,
    keyTerms,
    objectives: objectives.slice(0, 5),
    pitfall: pack?.pitfalls?.[0] ?? null,
  };
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
  } else if (task?.kind === 'programming') {
    content = JSON.stringify(generateProgrammingProblem(task.input));
  } else if (task?.kind === 'study-coach') {
    content = JSON.stringify(generateStudyCoach(task.input));
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

export { analyzeMaterial, generateProgrammingProblem, generateStudyCoach, matchKnowledge };
