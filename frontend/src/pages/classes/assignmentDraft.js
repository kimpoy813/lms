const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turn plain activity instructions into safe HTML for the assignment editor. */
export function activityInstructionsHtml(text) {
  return String(text ?? '')
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const RUBRIC_BLOCK_TAGS = new Set(['br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'span', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
const normalizeText = (text) => String(text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function rubricNodeText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const text = Array.from(node.childNodes, rubricNodeText).join('');
  return RUBRIC_BLOCK_TAGS.has(tag) ? ` ${text} ` : text;
}

function pointValue(text, { allowBare = false } = {}) {
  const value = normalizeText(text);
  const explicit = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(?:points?|pts?)\b/gi)].at(-1);
  if (explicit) return Number(explicit[1]);
  const parenthetical = /\(\s*(\d+(?:\.\d+)?)\s*\)\s*$/.exec(value);
  if (parenthetical) return Number(parenthetical[1]);
  if (allowBare) {
    const separated = /[·•|:–—-]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (separated) return Number(separated[1]);
  }
  return null;
}

function stripPointSuffix(text, { allowBare = false } = {}) {
  let value = normalizeText(text);
  value = value
    .replace(/\s*\(\s*(?:max(?:imum)?\s*)?\d+(?:\.\d+)?\s*(?:points?|pts?)?\s*\)\s*$/i, '')
    .replace(/\s*(?:max(?:imum)?\s*)?\d+(?:\.\d+)?\s*(?:points?|pts?)\s*$/i, '');
  if (allowBare) value = value.replace(/\s*[·•|:–—-]\s*\d+(?:\.\d+)?\s*$/, '');
  return normalizeText(value.replace(/[\s·•|:–—-]+$/, ''));
}

function scorePrefix(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:points?|pts?)?\s*[-:–—]\s*(.+)$/i.exec(normalizeText(text));
  return match ? { points: Number(match[1]), title: normalizeText(match[2]) } : null;
}

function headerLevel(text, index) {
  const prefix = scorePrefix(text);
  if (prefix) return prefix;
  const points = pointValue(text, { allowBare: true });
  const title = stripPointSuffix(text, { allowBare: true }) || normalizeText(text) || `Level ${index + 1}`;
  return { title, points };
}

function levelFromCell(cell, header, index) {
  const text = normalizeText(rubricNodeText(cell));
  if (!text) return null;
  const firstChild = Array.from(cell.children).find((child) => normalizeText(rubricNodeText(child)));
  const labelText = firstChild ? normalizeText(rubricNodeText(firstChild)) : text;
  const prefix = scorePrefix(labelText);
  const labelPoints = pointValue(labelText, { allowBare: true });
  const cellPoints = pointValue(text, { allowBare: true });
  const title = header?.title || prefix?.title || stripPointSuffix(labelText, { allowBare: true }) || `Level ${index + 1}`;
  const description = header?.title
    ? text
    : firstChild
      ? normalizeText(text.replace(labelText, ''))
      : prefix
        ? normalizeText(text.replace(prefix.title, '').replace(/^\s*[-:–—]\s*/, ''))
        : '';
  return {
    title: normalizeText(title).slice(0, 60),
    points: labelPoints ?? prefix?.points ?? cellPoints ?? header?.points ?? null,
    description: description.slice(0, 500),
  };
}

function looksLikeCriterionHeader(row) {
  const cells = Array.from(row?.cells ?? []);
  if (cells.length < 2) return false;
  const first = normalizeText(rubricNodeText(cells[0]));
  return /^(?:(?:rubric|assessment|grading)\s+)?(?:criteria|criterion|category|dimension|skill)(?:\b|\s*\/)/i.test(first);
}

function rubricLabelBefore(table) {
  const caption = normalizeText(rubricNodeText(table.querySelector('caption')));
  if (/\b(?:rubric|criteria|scoring)\b/i.test(caption)) return caption;
  let node = table;
  while (node?.parentElement) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      const text = normalizeText(rubricNodeText(sibling));
      if (/^H[1-6]$/.test(sibling.tagName)) return /\brubric\b/i.test(text) ? text : '';
      if (/\brubric\b/i.test(text)) return text;
      if (sibling.tagName === 'TABLE') break;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

function normalizeRubric(raw, fallbackTitle = 'Activity') {
  if (!raw || !Array.isArray(raw.criteria) || raw.criteria.length === 0 || raw.criteria.length > 30) return null;
  const criteria = raw.criteria.map((criterion) => {
    const maxPoints = Number(criterion.maxPoints);
    const levels = Array.isArray(criterion.levels) ? criterion.levels : [];
    if (!Number.isFinite(maxPoints) || maxPoints <= 0 || maxPoints > 1000 || levels.length > 8) return null;
    const normalizedLevels = levels.map((level) => {
      const points = Number(level.points);
      const title = normalizeText(level.title).slice(0, 60);
      if (!title || !Number.isFinite(points) || points < 0 || points > maxPoints) return null;
      return {
        title,
        points,
        description: normalizeText(level.description).slice(0, 500),
      };
    });
    if (normalizedLevels.some((level) => !level) || !normalizeText(criterion.title)) return null;
    return {
      title: normalizeText(criterion.title).slice(0, 120),
      description: normalizeText(criterion.description).slice(0, 1000),
      maxPoints,
      levels: normalizedLevels,
    };
  });
  if (criteria.some((criterion) => !criterion)) return null;
  const totalPoints = criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0);
  if (totalPoints <= 0 || totalPoints > 10_000) return null;
  const fallback = normalizeText(fallbackTitle) || 'Activity';
  const title = normalizeText(raw.title) || `${fallback} rubric`;
  return {
    title: title.slice(0, 200),
    description: normalizeText(raw.description).slice(0, 1000),
    criteria,
  };
}

function parseRubricTable(table, fallbackTitle) {
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  if (rows.length === 0) return null;
  const label = rubricLabelBefore(table);
  const explicitHeader = table.tHead?.rows?.[0] ?? null;
  const headerRow = explicitHeader || (looksLikeCriterionHeader(rows[0]) ? rows[0] : null);
  const headerCells = headerRow ? Array.from(headerRow.cells) : [];
  const headerTexts = headerCells.map((cell) => normalizeText(rubricNodeText(cell)));
  const pointsColumn = headerTexts.findIndex((text, index) => index > 0 && /^(?:(?:max(?:imum)?|total|available)\s+)?(?:points?|pts?|score)$/i.test(text));
  const descriptionColumn = headerTexts.findIndex((text, index) => index > 0 && /^(?:(?:criterion|performance|level)\s+)?(?:description|details|notes|descriptor)$/i.test(text));
  const levelColumns = headerCells.map((_, index) => index).filter((index) => index > 0 && index !== pointsColumn && index !== descriptionColumn);
  const dataRows = rows.filter((row) => row !== headerRow);
  const copiedRubricShape = !headerRow && dataRows.some((row) => {
    const cells = Array.from(row.cells);
    if (cells.length < 3 || pointValue(rubricNodeText(cells[0])) === null) return false;
    return cells.slice(1).some((cell) => {
      const first = Array.from(cell.children).find((child) => normalizeText(rubricNodeText(child)));
      return pointValue(rubricNodeText(first ?? cell), { allowBare: true }) !== null;
    });
  });
  if (!label && !headerRow && !copiedRubricShape) return null;

  const criteria = [];
  for (const row of dataRows) {
    const cells = Array.from(row.cells);
    if (cells.length < 2) continue;
    const criterionText = normalizeText(rubricNodeText(cells[0]));
    if (!criterionText || /^(?:total|rubric total)\b/i.test(criterionText)) continue;
    const criterionTitle = stripPointSuffix(criterionText) || criterionText;
    let maxPoints = pointValue(criterionText);
    let description = '';
    if (pointsColumn > 0 && cells[pointsColumn]) {
      const pointsText = normalizeText(rubricNodeText(cells[pointsColumn]));
      maxPoints = /^\d+(?:\.\d+)?$/.test(pointsText) ? Number(pointsText) : pointValue(pointsText) ?? maxPoints;
    }
    if (descriptionColumn > 0 && cells[descriptionColumn]) description = normalizeText(rubricNodeText(cells[descriptionColumn]));

    const columns = headerRow
      ? levelColumns.filter((index) => index < cells.length)
      : cells.map((_, index) => index).filter((index) => index > 0);
    const levels = [];
    let missingLevelPoints = false;
    for (const [levelIndex, columnIndex] of columns.entries()) {
      const header = headerRow ? headerLevel(headerTexts[columnIndex], levelIndex) : null;
      const level = levelFromCell(cells[columnIndex], header, levelIndex);
      if (!level) continue;
      if (level.points === null) missingLevelPoints = true;
      levels.push(level);
    }
    if (levels.length > 0 && missingLevelPoints) return null;
    if (maxPoints === null && levels.length > 0) maxPoints = Math.max(...levels.map((level) => level.points));
    if (maxPoints === null || !Number.isFinite(maxPoints) || maxPoints <= 0) return null;
    criteria.push({ title: criterionTitle, description, maxPoints, levels });
  }

  const heading = normalizeText(label);
  const title = heading && !/^rubric$/i.test(heading)
    ? (heading.toLowerCase().includes('rubric') ? heading : `${heading} rubric`)
    : `${normalizeText(fallbackTitle) || 'Activity'} rubric`;
  return normalizeRubric({ title, criteria }, fallbackTitle);
}

/**
 * Read a point-scored rubric table copied or authored inside lesson rich text. A table must be
 * explicitly labelled as a rubric, use a Criterion/Points header, or match the app's rubric-table
 * layout (criterion points in column one, level name and score in each following cell).
 */
export function extractRubricFromHtml(html, fallbackTitle = 'Activity') {
  if (typeof DOMParser === 'undefined' || typeof html !== 'string' || !html.trim()) return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(parsed.body.querySelectorAll('table'));
  for (const table of tables) {
    const rubric = parseRubricTable(table, fallbackTitle);
    if (rubric) return rubric;
  }
  return null;
}

const CRITERIA = [
  {
    title: 'Understanding and accuracy',
    description: 'Shows accurate understanding of the concepts and facts needed for the activity.',
    levels: [
      'Accurate, detailed work shows a strong grasp of the concepts.',
      'Mostly accurate work shows a sound grasp, with only minor gaps.',
      'Some correct understanding is shown, but important gaps or errors remain.',
      'Work is incomplete or substantially inaccurate.',
    ],
  },
  {
    title: 'Application and reasoning',
    description: 'Applies relevant ideas or methods and makes the reasoning clear.',
    levels: [
      'Applies the ideas effectively and explains choices with strong reasoning.',
      'Applies the ideas correctly with generally clear reasoning.',
      'Application or reasoning is inconsistent or only partly explained.',
      'Little relevant application or reasoning is demonstrated.',
    ],
  },
  {
    title: 'Completeness and evidence',
    description: 'Addresses the activity requirements and supports the work with relevant evidence or examples.',
    levels: [
      'All requirements are addressed with relevant, well-chosen evidence or examples.',
      'Most requirements are addressed with appropriate support.',
      'Several requirements or supporting details are missing.',
      'Most requirements are missing and little support is provided.',
    ],
  },
  {
    title: 'Clarity and organization',
    description: 'Presents the work clearly, coherently, and in the requested format.',
    levels: [
      'Exceptionally clear, coherent, and well organized.',
      'Clear and organized, with only minor issues.',
      'Meaning is understandable, but organization or clarity is uneven.',
      'Difficult to follow or not presented in a usable format.',
    ],
  },
];

/** A reusable, editable starter rubric that works even when the server has no AI provider. */
export function starterActivityRubric(activityTitle, points) {
  const total = Number(points);
  if (!Number.isSafeInteger(total) || total < CRITERIA.length || total > 1000) {
    throw new RangeError(`A rubric needs between ${CRITERIA.length} and 1,000 whole points.`);
  }

  const title = String(activityTitle ?? '').trim() || 'Activity';
  const base = Math.floor(total / CRITERIA.length);
  const remainder = total % CRITERIA.length;
  const levels = ['Excellent', 'Proficient', 'Developing', 'Beginning'];
  const percentages = [1, 0.8, 0.6, 0.4];

  return {
    title: `${title.slice(0, 180)} — Starter rubric`,
    description: 'Editable starter rubric. Review and adjust the criteria and performance descriptions before using it.',
    criteria: CRITERIA.map((criterion, index) => {
      const maxPoints = base + (index < remainder ? 1 : 0);
      return {
        title: criterion.title,
        description: criterion.description,
        maxPoints,
        levels: levels.map((level, levelIndex) => ({
          title: level,
          points: Math.round(maxPoints * percentages[levelIndex] * 100) / 100,
          description: criterion.levels[levelIndex],
        })),
      };
    }),
  };
}
