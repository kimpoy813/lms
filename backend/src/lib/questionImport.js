// Turns an existing test paper (TXT, DOCX, PDF) into draft questions for the teacher to review.
// Nothing here writes to the database: the result is a preview, and every question carries the
// warnings that explain what the parser was unsure about.
import { unzipSync, strFromU8 } from 'fflate';
import { countBlanks, normalizeAnswer, normalizeQuestion } from './quizScoring.js';
import { escapeHtml } from './sanitize.js';

export const IMPORT_EXTENSIONS = ['txt', 'md', 'docx', 'pdf'];
const MAX_TEXT_CHARS = 400_000;

// ── Text extraction ──────────────────────────────────────────────────────────

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/**
 * Plain text of a .docx, one line per paragraph.
 *  - Word's automatic numbering is not part of the text, so it is re-created: list paragraphs at
 *    the top level become "1." "2." …, nested ones (or a second list) become "A." "B." ….
 *  - A paragraph that is entirely bold, highlighted or underlined is prefixed with "*", which the
 *    parser reads as "this choice is the marked answer".
 */
export function docxToText(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'word/document.xml' });
  } catch {
    throw new Error('This file is not a valid Word document.');
  }
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new Error('This file is not a valid Word document.');
  const xml = strFromU8(xmlBytes);
  const lines = [];
  let questionList = null;
  let questionNumber = 0;
  let choiceIndex = 0;
  for (const match of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = match[0];
    const runs = [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((r) => r[0]);
    let text = '';
    let emphasised = 0;
    let textRuns = 0;
    for (const run of runs) {
      const piece = [...run.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)]
        .map((m) => (m[0].startsWith('<w:t') && !m[0].startsWith('<w:tab') ? decodeXml(m[1] ?? '') : m[0].startsWith('<w:tab') ? ' ' : '\n'))
        .join('');
      if (!piece) continue;
      text += piece;
      if (piece.trim()) {
        textRuns += 1;
        const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
        if (/<w:b(?:\/| )|<w:b>|<w:highlight |<w:u /.test(props) && !/<w:b w:val="(?:0|false)"/.test(props)) emphasised += 1;
      }
    }
    text = text.replace(/[ \t]+/g, ' ').trim();
    if (!text) {
      lines.push('');
      continue;
    }
    const numbering = /<w:numPr>[\s\S]*?<\/w:numPr>/.exec(p)?.[0];
    if (numbering) {
      const level = Number(/<w:ilvl w:val="(\d+)"/.exec(numbering)?.[1] ?? 0);
      const listId = /<w:numId w:val="(\d+)"/.exec(numbering)?.[1] ?? '0';
      if (questionList === null && level === 0) questionList = listId;
      if (level === 0 && listId === questionList) {
        questionNumber += 1;
        choiceIndex = 0;
        text = `${questionNumber}. ${text}`;
      } else if (choiceIndex < 26) {
        text = `${String.fromCharCode(65 + choiceIndex)}. ${text}`;
        choiceIndex += 1;
      }
    }
    const marked = textRuns > 0 && emphasised === textRuns && /^\(?[A-Ha-h][.)]\s/.test(text);
    for (const line of text.split('\n')) lines.push(marked ? `*${line}` : line);
  }
  return lines.join('\n');
}

/**
 * Text of a PDF with its lines rebuilt from the position of each text fragment, which keeps
 * "A. …  B. …" choices and "Answer: …" lines separate far more reliably than the reading order
 * stored in the file. Page-number footers are dropped.
 */
export async function pdfToText(buffer) {
  const { getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    throw new Error('This PDF could not be read. It may be damaged or password-protected.');
  }
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === 'string' && item.str.length > 0)
      .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width ?? 0, height: Math.abs(item.transform[3]) || item.height || 10 }));
    // Top of the page first; fragments on (nearly) the same baseline form one line.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const item of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - item.y) <= Math.max(2, row.height * 0.35)) row.items.push(item);
      else rows.push({ y: item.y, height: item.height, items: [item] });
    }
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let line = '';
      let end = null;
      for (const item of row.items) {
        if (end !== null) {
          const gap = item.x - end;
          // A wide horizontal gap is a column break (e.g. choices laid out side by side).
          if (gap > row.height * 1.5) line += '    ';
          else if (gap > row.height * 0.15 && !line.endsWith(' ') && !item.text.startsWith(' ')) line += ' ';
        }
        line += item.text;
        end = item.x + item.width;
      }
      line = line.replace(/\s+$/, '');
      if (/^\s*(?:page\s+)?\d+\s*(?:of|\/)\s*\d+\s*$/i.test(line) || /^\s*page\s+\d+\s*$/i.test(line)) continue;
      lines.push(line);
    }
    lines.push('');
  }
  const joined = lines.join('\n');
  if (joined.replace(/\s/g, '').length < 20) throw new Error('No text was found in this PDF. Scanned pages (images) cannot be imported — use a text PDF, DOCX or TXT file.');
  return joined;
}

/** @returns {Promise<string>} */
export async function extractImportText(buffer, filename) {
  const extension = String(filename ?? '').toLowerCase().split('.').pop();
  let text;
  if (extension === 'docx') text = docxToText(buffer);
  else if (extension === 'pdf') text = await pdfToText(buffer);
  else if (extension === 'txt' || extension === 'md') text = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
  else if (extension === 'doc') throw new Error('Old .doc files cannot be read. Open the file in Word and save it as .docx, then import that.');
  else throw new Error('Import a TXT, DOCX or PDF file.');
  return text.slice(0, MAX_TEXT_CHARS);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

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
const HEADING = /^(?:(?:part|section|test)\s+(?:[ivxlc]+|\d+|[a-d])\b[\s.:)\-–—]*)(.*)$/i;
const QUESTION = /^(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.)]\s*(.*)$/i;
const CHOICE = /^(\*?)\s*\(?([A-Ha-h])[.)]\s+(.+)$/;
const ANSWER = /^(?:correct\s+answer|answers?|ans|key)\s*[:\-–]\s*(.+)$/i;
const EXPLANATION = /^(?:explanation|rationale|feedback)\s*[:\-–]\s*(.+)$/i;
const KEY_START = /^(?:answer\s*keys?|key\s+to\s+corrections?|answers)\s*:?\s*$/i;
const POINTS = /[([]\s*(\d+(?:\.\d+)?)\s*(?:points?|pts?|marks?)\s*(?:each)?\s*[)\]]/i;
const TF = /^(t|true|tama)$|^(f|false|mali)$/i;
const CORRECT_MARK = /\s*(?:\(correct\)|\[correct\]|✓|✔|<-+\s*correct)\s*$/i;

const sectionType = (text) => SECTION_TYPES.find(([re]) => re.test(text))?.[1] ?? null;
const toHtml = (text) => text.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');

/** "1. B  2. C  3. True" or one answer per line → Map(number → answer text). */
function parseAnswerKey(lines) {
  const key = new Map();
  for (const line of lines) {
    const parts = [...line.matchAll(/(\d{1,3})\s*[.):\-–]\s*/g)];
    if (parts.length === 0) continue;
    parts.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < parts.length ? parts[i + 1].index : line.length;
      const value = line.slice(start, end).trim();
      if (value) key.set(Number(m[1]), value);
    });
  }
  return key;
}

/**
 * @param {string} rawText
 * @returns {{ questions: Array<object>, summary: { found: number, ready: number, needsReview: number, sections: string[] }, notes: string[] }}
 *          each question is in editor shape plus `number`, `warnings` and `errors`.
 */
export function parseQuestions(rawText) {
  const text = String(rawText ?? '').replace(/\r\n?/g, '\n').replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\t/g, ' ');
  const lines = text.split('\n').map((l) => l.replace(/\s+$/g, ''));
  const notes = [];

  // A trailing answer key applies to every question that has no inline answer.
  let keyAt = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (KEY_START.test(lines[i].trim())) {
      keyAt = i;
      break;
    }
  }
  const answerKey = keyAt >= 0 ? parseAnswerKey(lines.slice(keyAt + 1)) : new Map();
  const body = keyAt >= 0 ? lines.slice(0, keyAt) : lines;

  const drafts = [];
  let current = null;
  let section = null;
  let defaultType = null;
  let sectionPoints = null;
  let lastTarget = null; // 'text' | 'choice' | 'explanation'
  const sections = [];

  const finish = () => {
    if (current) drafts.push(current);
    current = null;
    lastTarget = null;
  };

  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) {
      if (current && lastTarget === 'text' && current.choices.length === 0) current.text += '\n';
      continue;
    }
    const heading = HEADING.exec(line);
    const bareType = !heading && line.length <= 60 && !QUESTION.test(line) && !CHOICE.test(line) && !ANSWER.test(line) ? sectionType(line) : null;
    // A bare "Multiple Choice" line is a heading only between questions, never inside one's text.
    if (heading || (bareType && (!current || current.choices.length > 0 || current.answer !== null || /[.?!:]$/.test(current.text.trim())))) {
      finish();
      section = line.replace(/\s+/g, ' ').slice(0, 120);
      sections.push(section);
      defaultType = sectionType(line);
      const pts = POINTS.exec(line);
      sectionPoints = pts ? Number(pts[1]) : null;
      continue;
    }
    const q = QUESTION.exec(line);
    if (q && (q[2].trim() || true)) {
      // "12. " followed by text on the next line is still a question start.
      finish();
      current = { number: Number(q[1]), text: q[2].trim(), choices: [], answer: null, explanation: '', section, defaultType, points: sectionPoints };
      lastTarget = 'text';
      continue;
    }
    if (!current) continue; // title, instructions, name/date lines before the first question
    const answer = ANSWER.exec(line);
    if (answer) {
      current.answer = answer[1].trim();
      lastTarget = 'answer';
      continue;
    }
    const explanation = EXPLANATION.exec(line);
    if (explanation) {
      current.explanation = explanation[1].trim();
      lastTarget = 'explanation';
      continue;
    }
    const choice = CHOICE.exec(line);
    if (choice) {
      // Choices on one line: "A. one   B. two   C. three"
      const inline = choice[3].split(/\s{2,}(?=\(?[B-Hb-h][.)]\s)/);
      const starred = choice[1] === '*';
      const first = inline[0];
      current.choices.push({ letter: choice[2].toUpperCase(), text: first.replace(CORRECT_MARK, '').replace(/\*+$/, '').trim(), marked: starred || CORRECT_MARK.test(first) || /\*+$/.test(first) });
      for (const extra of inline.slice(1)) {
        const m = /^\(?([B-Hb-h])[.)]\s+(.+)$/.exec(extra.trim());
        if (m) current.choices.push({ letter: m[1].toUpperCase(), text: m[2].replace(CORRECT_MARK, '').replace(/\*+$/, '').trim(), marked: CORRECT_MARK.test(m[2]) || /\*+$/.test(m[2]) });
      }
      lastTarget = 'choice';
      continue;
    }
    // Continuation of whatever came last.
    if (lastTarget === 'choice') current.choices[current.choices.length - 1].text += ` ${line}`;
    else if (lastTarget === 'explanation') current.explanation += ` ${line}`;
    else if (lastTarget === 'answer') current.answer += ` ${line}`;
    else current.text += `${current.text && !current.text.endsWith('\n') ? ' ' : ''}${line}`;
  }
  finish();

  const seen = new Map();
  const questions = drafts.map((d) => {
    const warnings = [];
    let questionText = d.text.replace(/\n{2,}/g, '\n').trim();
    let points = d.points ?? 1;
    const pts = POINTS.exec(questionText);
    if (pts) {
      points = Number(pts[1]);
      questionText = questionText.replace(POINTS, '').replace(/\s{2,}/g, ' ').trim();
    }
    const hint = /\((true\s*(?:or|\/)\s*false|t\s*\/\s*f)\)/i.exec(questionText);
    if (hint) questionText = questionText.replace(hint[0], '').trim();
    const answer = (d.answer ?? answerKey.get(d.number) ?? '').trim();
    const fromKey = !d.answer && answerKey.has(d.number);
    const blanks = countBlanks(questionText);
    const marked = d.choices.filter((c) => c.marked);

    let question = { type: null, text: toHtml(questionText), points, difficulty: 'MEDIUM', section: d.section, explanation: d.explanation || '' };

    if (d.choices.length >= 2 && d.defaultType !== 'MATCHING') {
      const letters = answer ? [...new Set(answer.toUpperCase().match(/\b[A-H]\b/g) ?? [])] : [];
      // The key may also quote the text of the correct choice instead of its letter.
      const byText = answer && letters.length === 0 ? d.choices.filter((c) => normalizeAnswer(c.text) === normalizeAnswer(answer)).map((c) => c.letter) : [];
      const correct = new Set(letters.length > 0 ? letters : byText.length > 0 ? byText : marked.map((c) => c.letter));
      const unknown = [...correct].filter((l) => !d.choices.some((c) => c.letter === l));
      if (unknown.length > 0) warnings.push(`The answer "${answer}" does not match any choice.`);
      if (correct.size === 0) warnings.push(answer ? `The answer "${answer}" does not match any choice. Mark the correct choice.` : 'No answer was found. Mark the correct choice.');
      const multiple = correct.size > 1 || d.defaultType === 'MULTIPLE_RESPONSE';
      question = { ...question, type: multiple ? 'MULTIPLE_RESPONSE' : 'MULTIPLE_CHOICE', choices: d.choices.map((c) => ({ text: c.text, isCorrect: correct.has(c.letter) })) };
    } else if (d.defaultType === 'MATCHING' && d.choices.length === 0 && /\s[-–=]{1,2}>?\s/.test(questionText)) {
      const [left, right] = questionText.split(/\s[-–=]{1,2}>?\s/);
      question = { ...question, type: 'MATCHING', pairs: [{ left: left.trim(), right: (right ?? '').trim() }] };
      warnings.push('Matching items are imported one pair per line. Combine the pairs into one question.');
    } else if (TF.test(answer) || ((d.defaultType === 'TRUE_FALSE' || d.defaultType === 'MODIFIED_TRUE_FALSE' || hint) && !answer)) {
      const value = answer ? /^(t|true|tama)$/i.test(answer) : null;
      question = { ...question, type: 'TRUE_FALSE', ...(value === null ? {} : { answer: value }) };
      if (value === null) warnings.push('No answer was found. Choose true or false.');
    } else if (d.defaultType === 'MODIFIED_TRUE_FALSE' && answer) {
      // "False – mitochondria" or just the corrected word.
      const m = /^(?:f|false)\s*[-–:,]\s*(.+)$/i.exec(answer);
      question = { ...question, type: 'MODIFIED_TRUE_FALSE', answer: false, correction: [(m ? m[1] : answer).trim()] };
    } else if (blanks > 0) {
      const parts = answer ? answer.split(blanks > 1 ? /\s*[;,]\s*/ : /\s*;\s*/).map((p) => p.split(/\s*(?:\/|\||\bor\b)\s*/i).map((x) => x.trim()).filter(Boolean)) : [];
      question = { ...question, type: 'FILL_BLANKS', blanks: parts };
      if (!answer) warnings.push('No answer was found for the blank(s).');
      else if (parts.length !== blanks) warnings.push(`The question has ${blanks} blank(s) but ${parts.length} answer(s) were found. Separate the answers with semicolons.`);
    } else if (d.defaultType === 'ESSAY' || (!answer && d.defaultType !== 'IDENTIFICATION' && d.defaultType !== 'SHORT_ANSWER')) {
      question = { ...question, type: 'ESSAY' };
      if (d.defaultType !== 'ESSAY') warnings.push('No choices or answer were found, so this was imported as an essay question.');
      if (answer) question.explanation = [question.explanation, `Model answer: ${answer}`].filter(Boolean).join('\n');
    } else {
      const accepted = answer ? answer.split(/\s*(?:\/|\||;)\s*/).map((x) => x.trim()).filter(Boolean) : [];
      const long = accepted.some((a) => a.split(/\s+/).length > 6);
      question = { ...question, type: d.defaultType === 'SHORT_ANSWER' || long ? 'SHORT_ANSWER' : 'IDENTIFICATION', accepted };
      if (accepted.length === 0) warnings.push('No answer was found. Add the accepted answer.');
    }
    if (fromKey) warnings.push('The answer was taken from the answer key at the end of the document — check that the numbering lines up.');

    const fingerprint = normalizeAnswer(questionText);
    if (seen.has(fingerprint)) warnings.push(`This looks like a duplicate of question ${seen.get(fingerprint)}.`);
    else seen.set(fingerprint, d.number);

    const { errors } = normalizeQuestion(question);
    return { number: d.number, ...question, warnings, errors };
  });

  if (questions.length === 0) notes.push('No numbered questions were found. Questions must start with a number, for example "1." or "1)".');
  if (keyAt >= 0) notes.push(`An answer key with ${answerKey.size} answer(s) was found at the end of the document.`);
  const numbers = questions.map((q) => q.number);
  if (new Set(numbers).size !== numbers.length && sections.length <= 1) notes.push('Some question numbers repeat. If numbering restarts in each part, answers from a trailing answer key may be matched to the wrong question.');

  return {
    questions,
    summary: { found: questions.length, ready: questions.filter((q) => q.errors.length === 0 && q.warnings.length === 0).length, needsReview: questions.filter((q) => q.errors.length > 0 || q.warnings.length > 0).length, sections },
    notes,
  };
}
