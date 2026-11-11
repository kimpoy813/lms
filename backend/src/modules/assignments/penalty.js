// Late-submission penalty (pure).
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ dueAt: Date|null, submittedAt: Date, type: 'NONE'|'PERCENT_PER_DAY'|'PERCENT_FLAT', value: number, max: number }} input
 * @returns {{ isLate: boolean, daysLate: number, penaltyPercent: number }}
 */
export function latePenalty({ dueAt, submittedAt, type, value, max }) {
  if (!dueAt || submittedAt <= dueAt) return { isLate: false, daysLate: 0, penaltyPercent: 0 };
  // Any part of a day counts as a full day.
  const daysLate = Math.ceil((submittedAt.getTime() - dueAt.getTime()) / DAY_MS);
  let penalty = 0;
  if (type === 'PERCENT_FLAT') penalty = value;
  else if (type === 'PERCENT_PER_DAY') penalty = value * daysLate;
  const cap = Number.isFinite(max) ? max : 100;
  return { isLate: true, daysLate, penaltyPercent: Math.max(0, Math.min(penalty, cap, 100)) };
}

/** Score after the penalty, rounded to two decimals. */
export function applyPenalty(rawScore, penaltyPercent) {
  if (rawScore === null || rawScore === undefined) return null;
  return Math.round((rawScore * (1 - penaltyPercent / 100) + Number.EPSILON) * 100) / 100;
}
