// Who marks the answers to a question: the system, the teacher, or both.
//
// The server decides (markedBy in backend/src/lib/quizScoring.js). This copy only lets the web
// app say it before anything is saved — on a question that is being written or imported.
// backend/tests/unit/quiz.test.js checks that the two agree.

/** More than a phrase: a whole sentence, which nobody types word for word. */
const isSentence = (text) => String(text).trim().split(/\s+/).length > 6;

/**
 * @param {{ type: string, accepted?: string[], settings?: { reviewMismatch?: boolean } }} q  a question in the API's editor shape
 * @returns {{ by: 'SYSTEM'|'TEACHER'|'BOTH', why: null|'ESSAY'|'FILE'|'NO_KEY'|'CHOSEN'|'SENTENCE' }}
 *   SYSTEM   every answer is marked by the answer key, at once
 *   TEACHER  every answer waits for the teacher: an ESSAY, a FILE, or a short answer with NO_KEY
 *   BOTH     an answer that matches the key is marked at once, one that does not waits for the
 *            teacher: CHOSEN by the teacher, or because the key is a whole SENTENCE
 */
export function markedBy(q) {
  if (q?.type === 'ESSAY') return { by: 'TEACHER', why: 'ESSAY' };
  if (q?.type === 'FILE_UPLOAD') return { by: 'TEACHER', why: 'FILE' };
  if (q?.type !== 'SHORT_ANSWER') return { by: 'SYSTEM', why: null };
  // While it is being typed, the list may hold empty lines.
  const accepted = (q.accepted ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
  if (accepted.length === 0) return { by: 'TEACHER', why: 'NO_KEY' };
  const chosen = q.settings?.reviewMismatch;
  if (chosen === true) return { by: 'BOTH', why: 'CHOSEN' };
  if (chosen !== false && accepted.every(isSentence)) return { by: 'BOTH', why: 'SENTENCE' };
  return { by: 'SYSTEM', why: null };
}
