// The JSON that the import of questions reads, as a teacher is shown it: an example for each
// kind of question, and the request that makes a chat assistant write questions in that form.
//
// The reading itself happens on the server (backend/src/lib/questionJson.js), and
// backend/tests/unit/question-json.test.js checks that every example here is read as written.
// docs/QUESTION-IMPORT.md describes the whole format.

/**
 * The kinds of question a teacher can ask a chat assistant for. `rule` is what the assistant is
 * told about that kind; `example` is what it is shown.
 */
export const FORMAT_TYPES = [
  {
    value: 'multiple_choice', label: 'Multiple choice',
    example: { type: 'multiple_choice', question: 'Which part of a computer carries out the instructions of a program?', choices: ['RAM', 'CPU', 'Hard disk', 'Monitor'], answer: 'CPU', points: 1, difficulty: 'easy', explanation: 'The CPU (central processing unit) executes instructions.' },
    rule: 'multiple_choice: four choices, exactly one of them correct. "answer" is the full text of the correct choice, copied exactly. Do not put letters such as "A." in front of the choices.',
  },
  {
    value: 'multiple_response', label: 'Multiple response',
    example: { type: 'multiple_response', question: 'Which of these are input devices?', choices: ['Keyboard', 'Monitor', 'Mouse', 'Printer'], answer: ['Keyboard', 'Mouse'], points: 2, difficulty: 'medium', explanation: 'A keyboard and a mouse send data into the computer.' },
    rule: 'multiple_response: four or five choices, two or more of them correct. "answer" is a list with the full text of every correct choice.',
  },
  {
    value: 'true_false', label: 'True or false',
    example: { type: 'true_false', question: 'One byte is made of 8 bits.', answer: true, points: 1, difficulty: 'easy', explanation: 'A byte is a group of eight bits.' },
    rule: 'true_false: "question" is a statement, not a question. "answer" is true or false, without quotes.',
  },
  {
    value: 'identification', label: 'Identification',
    example: { type: 'identification', question: 'What do the letters CPU stand for?', answer: ['Central Processing Unit', 'central processor'], points: 1, difficulty: 'easy' },
    rule: 'identification: the answer is one word or a short phrase. "answer" lists every wording that should be accepted.',
  },
  {
    value: 'fill_blanks', label: 'Fill in the blanks',
    example: { type: 'fill_blanks', question: 'A byte has ___ bits, and half a byte is called a ___.', answer: [['8', 'eight'], ['nibble']], points: 2, difficulty: 'medium' },
    rule: 'fill_blanks: write each blank as three underscores: ___ . "answer" has one list for each blank, in the order of the blanks, with the wordings that should be accepted.',
  },
  {
    value: 'matching', label: 'Matching type',
    example: { type: 'matching', question: 'Match each device with what it is used for.', pairs: [{ left: 'Keyboard', right: 'Input' }, { left: 'Monitor', right: 'Output' }, { left: 'Hard disk', right: 'Storage' }], points: 3, difficulty: 'medium' },
    rule: 'matching: three to eight pairs. Every "left" is different.',
  },
  {
    value: 'ordering', label: 'Ordering',
    example: { type: 'ordering', question: 'Arrange these units from the smallest to the largest.', items: ['bit', 'byte', 'kilobyte', 'megabyte'], points: 2, difficulty: 'medium' },
    rule: 'ordering: three to eight "items", written in their correct order. Students are shown them shuffled.',
  },
  {
    value: 'essay', label: 'Essay',
    example: { type: 'essay', question: 'Explain the difference between memory (RAM) and storage.', points: 10, difficulty: 'hard', explanation: 'A good answer says that RAM is fast and loses its contents without power, and that storage keeps them.' },
    rule: 'essay: no "answer". Put what a good answer contains in "explanation": the teacher marks it.',
  },
];

export const ALL_TYPES = FORMAT_TYPES.map((t) => t.value);
/** What most quizzes are made of. */
export const DEFAULT_TYPES = ['multiple_choice', 'true_false', 'identification'];
export const DIFFICULTY_CHOICES = [
  { value: '', label: 'A mix' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

/** One question on one line: short enough to read, and still JSON. */
const oneLine = (value) => JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']');

/**
 * An example of the format with one question of each of these kinds.
 * @param {string[]} [types] values of FORMAT_TYPES; every kind when left out
 */
export function exampleJson(types = ALL_TYPES) {
  const chosen = FORMAT_TYPES.filter((t) => types.includes(t.value));
  return `{\n  "questions": [\n${chosen.map((t) => `    ${oneLine(t.example)}`).join(',\n')}\n  ]\n}`;
}

/** The line of the request that introduces the form. It also tells a request from an answer. */
const FORM_LINE = 'Answer with JSON only: no sentence before it and none after it. Use exactly this form, with one object for each question:';

/**
 * True for the request itself. Pasted into the import in place of the assistant's answer — an
 * easy slip, the request being what was copied last — it would be read as the example questions
 * it contains.
 */
export const isOwnRequest = (text) => /^\s*Write \d+ quiz questions? for my students\./.test(String(text ?? '')) && String(text).includes(FORM_LINE);

/** How many questions a request asks for: a whole number from 1 to 100. */
export const questionCount = (value) => Math.min(100, Math.max(1, Math.round(Number(value)) || 10));

/**
 * The request to paste into a chat assistant, so that it answers with questions in the form
 * the import reads.
 *
 * @param {object} [options]
 * @param {number|string} [options.count=10] how many questions
 * @param {string[]} [options.types] kinds of question (values of FORMAT_TYPES)
 * @param {string} [options.topic] what they are about, and anything else the teacher wants
 * @param {''|'easy'|'medium'|'hard'} [options.difficulty] '' for a mix
 * @param {boolean} [options.material=true] the teacher pastes the lesson after the request
 */
export function buildPrompt({ count = 10, types = DEFAULT_TYPES, topic = '', difficulty = '', material = true } = {}) {
  const picked = FORMAT_TYPES.filter((t) => types.includes(t.value));
  const kinds = picked.length > 0 ? picked : FORMAT_TYPES.filter((t) => DEFAULT_TYPES.includes(t.value));
  const n = questionCount(count);
  const about = String(topic ?? '').replace(/\s+/g, ' ').trim();
  const lines = [
    `Write ${n} quiz ${n === 1 ? 'question' : 'questions'} for my students.`,
    ...(about ? [`Topic and instructions: ${about}`] : []),
    ...(material ? ['Use only the material at the end of this message. Do not ask about anything that is not in it.'] : []),
    kinds.length === 1 ? `Every question is of the kind ${kinds[0].value}.` : `Kinds of question to use, each about equally often: ${kinds.map((t) => t.value).join(', ')}.`,
    ['easy', 'medium', 'hard'].includes(difficulty) ? `Make every question ${difficulty}.` : 'Mix easy, medium and hard questions.',
    '',
    FORM_LINE,
    '',
    exampleJson(kinds.map((t) => t.value)),
    '',
    'Rules:',
    ...kinds.map((t) => `- ${t.rule}`),
    '- "points" is a number. "difficulty" is easy, medium or hard. "explanation" says in one sentence why the answer is right.',
    '- Write plain text: no Markdown and no HTML. Only program code goes between two lines of three backticks, inside the "question" text.',
    '- Each question can be answered without having seen the other questions.',
    '- Do not number the questions.',
  ];
  if (material) lines.push('', 'Material:', '[paste your lesson, notes or reading here]');
  return lines.join('\n');
}
