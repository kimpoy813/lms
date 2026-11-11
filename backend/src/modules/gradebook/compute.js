// Pure grade computation. No database access here, so every rule is unit-testable and the same
// code produces the teacher's gradebook, the student's breakdown and the finalised record.
//
// Rules (also shown to students as the "how this was computed" explanation):
//   1. Inside a category, grade = points earned ÷ points possible over the items that count.
//        GRADED   → counts.
//        MISSING  → counts as zero when the class treats missing work as zero, otherwise left out.
//        EXEMPT   → never counts (neither earned nor possible).
//        UNGRADED → does not count yet.
//   2. A period grade is the weighted average of its category grades. Categories with nothing
//      that counts yet are left out and the remaining weights are scaled up proportionally.
//   3. The overall grade is the weighted average of the period grades, in the same way.
//   4. Optional transmutation: shown grade = base + raw × (100 − base) ÷ 100.
//   5. The result is rounded, then looked up in the class's grading scale.
//   6. A teacher override (with a recorded reason) replaces the computed value for its scope.
import { round } from '../../lib/http.js';

export const OVERALL_SCOPE = 'OVERALL';

/** Highest band whose minimum is ≤ percent. */
export function scaleLabel(scaleEntries, percent) {
  if (percent === null || percent === undefined || !scaleEntries?.length) return null;
  const sorted = [...scaleEntries].sort((a, b) => b.minPercent - a.minPercent);
  const band = sorted.find((e) => percent >= e.minPercent) ?? sorted[sorted.length - 1];
  return { label: band.label, remark: band.remark ?? null, isPassing: band.isPassing };
}

export function transmute(percent, base) {
  if (percent === null || percent === undefined) return null;
  if (!base || base <= 0) return percent;
  return base + (percent * (100 - base)) / 100;
}

/** Attendance category grade: late arrivals earn partial credit, excused sessions are left out. */
export function attendancePercent(attendance, lateCredit = 0.5) {
  if (!attendance) return null;
  const { present = 0, late = 0, absent = 0 } = attendance;
  const counted = present + late + absent;
  if (counted === 0) return null;
  return ((present + late * lateCredit) / counted) * 100;
}

function weightedAverage(parts) {
  const counted = parts.filter((p) => p.percent !== null && p.weight > 0);
  const totalWeight = counted.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return { percent: null, countedWeight: 0 };
  return { percent: counted.reduce((s, p) => s + p.percent * p.weight, 0) / totalWeight, countedWeight: totalWeight };
}

function finish(raw, settings, override) {
  const decimals = settings.gradeRounding ?? 2;
  const computed = raw === null ? null : round(transmute(raw, settings.transmutationBase), decimals);
  const finalPercent = override ? round(override.overridePercent, decimals) : computed;
  const scale = scaleLabel(settings.scaleEntries, finalPercent);
  return {
    rawPercent: raw === null ? null : round(raw, 2),
    computedPercent: computed,
    percent: finalPercent,
    label: scale?.label ?? null,
    remark: scale?.remark ?? null,
    isPassing: scale ? scale.isPassing : null,
    isOverridden: Boolean(override),
    override: override ? { id: override.id, overridePercent: override.overridePercent, reason: override.reason, createdAt: override.createdAt } : null,
  };
}

/**
 * @param {object} input
 * @param {Array<{ id: string, name: string, weight: number, categories: Array<{ id: string, name: string, kind: string, weight: number,
 *          items: Array<{ id: string, title: string, maxPoints: number }> }> }>} input.periods
 * @param {Map<string, { score: number|null, status: string, isLate?: boolean }>|Record<string, object>} input.entries  by grade item id
 * @param {{ treatMissingAsZero: boolean, transmutationBase: number, gradeRounding: number, attendanceLateCredit: number,
 *           scaleEntries: Array<object>, attendanceCounts: boolean }} input.settings
 * @param {{ present: number, late: number, absent: number, excused: number }|null} [input.attendance]
 * @param {Array<{ id: string, scope: string, overridePercent: number, reason: string }>} [input.overrides] active overrides of this student
 */
export function computeStudentGrades({ periods, entries, settings, attendance = null, overrides = [] }) {
  const entryOf = (itemId) => (entries instanceof Map ? entries.get(itemId) : entries?.[itemId]) ?? null;
  const overrideFor = (scope) => overrides.find((o) => o.scope === scope) ?? null;

  const periodResults = periods.map((period) => {
    const categories = period.categories.map((category) => {
      if (category.kind === 'ATTENDANCE') {
        const percent = settings.attendanceCounts ? attendancePercent(attendance, settings.attendanceLateCredit) : null;
        return {
          id: category.id, name: category.name, kind: category.kind, weight: category.weight,
          percent: percent === null ? null : round(percent, 2), earned: null, possible: null, items: [], fromAttendance: true,
          attendance: settings.attendanceCounts ? attendance : null,
        };
      }
      let earned = 0;
      let possible = 0;
      const items = category.items.map((item) => {
        const entry = entryOf(item.id);
        const status = entry?.status ?? 'UNGRADED';
        let counted = false;
        let score = null;
        if (status === 'GRADED' && entry.score !== null && entry.score !== undefined) {
          counted = true;
          score = entry.score;
        } else if (status === 'MISSING' && settings.treatMissingAsZero) {
          counted = true;
          score = 0;
        }
        if (counted) {
          earned += score;
          possible += item.maxPoints;
        }
        return { id: item.id, title: item.title, maxPoints: item.maxPoints, score: status === 'GRADED' ? entry.score : null, status, isLate: Boolean(entry?.isLate), counted };
      });
      const percent = possible > 0 ? (earned / possible) * 100 : null;
      return {
        id: category.id, name: category.name, kind: category.kind, weight: category.weight,
        percent: percent === null ? null : round(percent, 2), earned: round(earned, 2), possible: round(possible, 2), items,
      };
    });
    const { percent: raw, countedWeight } = weightedAverage(categories);
    const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
    return {
      id: period.id,
      name: period.name,
      weight: period.weight,
      categories,
      countedWeight,
      isComplete: raw !== null && countedWeight === totalWeight,
      ...finish(raw, settings, overrideFor(period.id)),
    };
  });

  // The overall grade is built from the period grades students actually receive, i.e. after
  // overrides, but before transmutation (which is applied once, to the result).
  const base = settings.transmutationBase;
  const untransmute = (p) => (base > 0 ? ((p - base) * 100) / (100 - base) : p);
  const overallParts = periodResults.map((p) => ({
    weight: p.weight,
    percent: p.isOverridden ? untransmute(p.percent) : p.rawPercent === null ? null : weightedAverage(p.categories).percent,
  }));
  const { percent: overallRaw, countedWeight } = weightedAverage(overallParts);
  const totalPeriodWeight = periods.reduce((s, p) => s + p.weight, 0);
  const overall = {
    countedWeight,
    isComplete: overallRaw !== null && countedWeight === totalPeriodWeight && periodResults.every((p) => p.isComplete || p.isOverridden),
    ...finish(overallRaw, settings, overrideFor(OVERALL_SCOPE)),
  };
  return { periods: periodResults, overall };
}

/** Human-readable account of how a student's grade was produced. */
export function explainGrades(result, settings) {
  const lines = [];
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  for (const period of result.periods) {
    const counted = period.categories.filter((c) => c.percent !== null && c.weight > 0);
    if (counted.length === 0) {
      lines.push(`${period.name}: nothing has been graded yet.`);
      continue;
    }
    const terms = counted.map((c) => `${c.name} ${pct(c.percent)} × ${c.weight}%`).join(' + ');
    const scaled = period.countedWeight !== period.categories.reduce((s, c) => s + c.weight, 0);
    lines.push(
      `${period.name}: (${terms}) ÷ ${period.countedWeight}% = ${pct(period.rawPercent)}` +
        (scaled ? ' — categories without graded work are left out and the remaining weights are scaled up.' : '.'),
    );
    if (settings.transmutationBase > 0) lines.push(`${period.name} transmuted (base ${settings.transmutationBase}): ${settings.transmutationBase} + ${pct(period.rawPercent)} × ${100 - settings.transmutationBase}% = ${pct(period.computedPercent)}.`);
    if (period.isOverridden) lines.push(`${period.name} was set to ${pct(period.percent)} by your teacher (computed value: ${pct(period.computedPercent)}). Reason: ${period.override.reason}`);
  }
  const countedPeriods = result.periods.filter((p) => p.rawPercent !== null || p.isOverridden);
  if (result.periods.length > 1 && countedPeriods.length > 0) {
    lines.push(`Overall: ${countedPeriods.map((p) => `${p.name} × ${p.weight}%`).join(' + ')} ÷ ${result.overall.countedWeight}% = ${pct(result.overall.computedPercent)}.`);
  }
  if (result.overall.isOverridden) lines.push(`The overall grade was set to ${pct(result.overall.percent)} by your teacher (computed value: ${pct(result.overall.computedPercent)}). Reason: ${result.overall.override.reason}`);
  lines.push(
    settings.treatMissingAsZero
      ? 'Missing work counts as zero. Exempt and not-yet-graded work is not counted.'
      : 'Missing, exempt and not-yet-graded work is not counted.',
  );
  if (result.overall.label) lines.push(`Grading scale: ${pct(result.overall.percent)} corresponds to ${result.overall.label}${result.overall.remark ? ` (${result.overall.remark})` : ''}.`);
  return lines;
}

/** Validate a gradebook structure: period weights and each period's category weights must total 100. */
export function validateStructure(periods) {
  const errors = [];
  const close = (a, b) => Math.abs(a - b) < 0.005;
  if (periods.length === 0) errors.push('Add at least one grading period.');
  const periodTotal = periods.reduce((s, p) => s + p.weight, 0);
  if (periods.length > 0 && !close(periodTotal, 100)) errors.push(`Grading period weights must total 100% (currently ${round(periodTotal, 2)}%).`);
  const names = new Set();
  for (const p of periods) {
    const key = p.name.trim().toLowerCase();
    if (names.has(key)) errors.push(`Two grading periods are named "${p.name}".`);
    names.add(key);
    if (p.categories.length === 0) errors.push(`"${p.name}" needs at least one category.`);
    const total = p.categories.reduce((s, c) => s + c.weight, 0);
    if (p.categories.length > 0 && !close(total, 100)) errors.push(`Category weights in "${p.name}" must total 100% (currently ${round(total, 2)}%).`);
    const catNames = new Set();
    for (const c of p.categories) {
      const ck = c.name.trim().toLowerCase();
      if (catNames.has(ck)) errors.push(`"${p.name}" has two categories named "${c.name}".`);
      catNames.add(ck);
    }
  }
  return errors;
}
