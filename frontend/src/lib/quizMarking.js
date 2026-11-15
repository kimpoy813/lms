// Who marks the answers to a question: the system, the teacher, or both.
//
// The server decides (markedBy in backend/src/lib/quizScoring.js). This copy only lets the web
// app say it before anything is saved — on a question that is being written or imported.
// backend/tests/unit/quiz.test.js checks that the two agree.

// The words that make a few words a statement, and not the name of a thing.
const STATEMENT = /(?<![\p{L}\p{N}])(?:is|are|was|were|has|have|had|does|did|can|cannot|it|they|he|she|we|you|because|since|when|ay|dahil|kasi|kapag|ito|siya|sila)(?![\p{L}\p{N}])/iu;
// Small words that a title keeps in small letters: "The Lord of the Rings".
const IN_A_TITLE = new Set('a an the of and or for in on to at by with from ng sa at mga'.split(' '));

/**
 * More than a word or a phrase: a sentence, which is checked by its key words. More than six
 * words — or four and more that state something ("It stores data permanently"). A title, with
 * a capital letter on every word ("As You Like It"), is a name however it reads.
 */
export const isSentence = (text) => {
  const t = String(text ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) return true;
  if (words.length < 4) return false;
  // Text that is all in capitals says nothing by its capitals.
  if (!/\p{Ll}/u.test(t)) return STATEMENT.test(t);
  const named = words.filter((word) => /\p{L}/u.test(word) && !IN_A_TITLE.has(word.toLowerCase()));
  if (named.length >= 2 && named.every((word) => /^\P{L}*\p{Lu}/u.test(word))) return false;
  // "IT" and "AND" in capitals are names ("IT support staff", "AND gate"), not "it" and "and".
  return STATEMENT.test(t.replace(/(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu, ' '));
};

/**
 * @param {{ type: string, accepted?: string[], settings?: { reviewMismatch?: boolean, caseSensitive?: boolean, keyWords?: boolean } }} q  a question in the API's editor shape
 * @returns {{ by: 'SYSTEM'|'TEACHER'|'BOTH', why: null|'KEY_WORDS'|'ESSAY'|'FILE'|'NO_KEY'|'CHOSEN' }}
 *   SYSTEM   every answer is marked by the answer key, at once. KEY_WORDS: an accepted answer is
 *            a sentence, which is checked by its key words; an answer that has the words and
 *            may still say the opposite is then the one thing that waits for the teacher
 *   TEACHER  every answer waits for the teacher: an ESSAY, a FILE, or a short answer with NO_KEY
 *   BOTH     an answer that is right by the key is marked at once, any other waits for the
 *            teacher, who has CHOSEN that
 */
export function markedBy(q) {
  if (q?.type === 'ESSAY') return { by: 'TEACHER', why: 'ESSAY' };
  if (q?.type === 'FILE_UPLOAD') return { by: 'TEACHER', why: 'FILE' };
  if (q?.type !== 'SHORT_ANSWER') return { by: 'SYSTEM', why: null };
  // While it is being typed, the list may hold empty lines.
  const accepted = (q.accepted ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
  if (accepted.length === 0) return { by: 'TEACHER', why: 'NO_KEY' };
  if (q.settings?.reviewMismatch === true) return { by: 'BOTH', why: 'CHOSEN' };
  return { by: 'SYSTEM', why: usesKeyWords(q) ? 'KEY_WORDS' : null };
}

/**
 * Is a short answer checked by key words? The teacher says (settings.keyWords); left to the
 * system, it is where an accepted answer is a sentence. Never where the answer has to be
 * exactly as written.
 */
export function usesKeyWords(q) {
  if (q?.type !== 'SHORT_ANSWER' || q.settings?.caseSensitive === true) return false;
  const accepted = (q.accepted ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
  if (typeof q.settings?.keyWords === 'boolean') return q.settings.keyWords && accepted.length > 0;
  return accepted.some(isSentence);
}

/**
 * Why the system left a sentence to the teacher although its key words were there, in words.
 * `doubt` comes from the server (backend/src/lib/keyWords.js): { why, words, side }.
 * @returns {string | null}
 */
export function doubtText(doubt) {
  if (!doubt) return null;
  const [one, other] = doubt.words ?? [];
  if (doubt.why === 'NOT') return doubt.side === 'ACCEPTED' ? `The accepted answer says “not” about “${one}”, and this answer does not.` : `It says “not” about “${one}”, and the accepted answer does not.`;
  if (doubt.why === 'REPLY') return `It begins with “${one}” where the accepted answer begins with “${other}”.`;
  if (doubt.why === 'OPPOSITE') return `It says “${one}” where the accepted answer says “${other}”.`;
  if (doubt.why === 'COMPARISON') return 'It compares with “than”, but not with what the accepted answer compares with.';
  if (doubt.why === 'PAIRING') return `It puts “${one}” with “${other}”, and the accepted answer puts it with “${doubt.words[2]}”.`;
  return 'It may say the opposite of the accepted answer.';
}

