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
