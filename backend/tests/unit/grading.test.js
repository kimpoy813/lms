import { describe, expect, it } from 'vitest';
import { attendancePercent, computeStudentGrades, explainGrades, scaleLabel, transmute, validateStructure } from '../../src/modules/gradebook/compute.js';
import { applyPenalty, latePenalty } from '../../src/modules/assignments/penalty.js';

const scale = [
  { minPercent: 97, label: '1.00', remark: 'Excellent', isPassing: true },
  { minPercent: 94, label: '1.25', remark: 'Very Good', isPassing: true },
  { minPercent: 91, label: '1.50', remark: 'Very Good', isPassing: true },
  { minPercent: 88, label: '1.75', remark: 'Good', isPassing: true },
  { minPercent: 85, label: '2.00', remark: 'Good', isPassing: true },
  { minPercent: 82, label: '2.25', remark: 'Satisfactory', isPassing: true },
  { minPercent: 79, label: '2.50', remark: 'Satisfactory', isPassing: true },
  { minPercent: 76, label: '2.75', remark: 'Fair', isPassing: true },
  { minPercent: 75, label: '3.00', remark: 'Passed', isPassing: true },
  { minPercent: 0, label: '5.00', remark: 'Failed', isPassing: false },
];

const settings = (over = {}) => ({ treatMissingAsZero: true, transmutationBase: 0, gradeRounding: 2, attendanceLateCredit: 0.5, scaleEntries: scale, attendanceCounts: true, ...over });

const period = (id, weight, categories) => ({ id, name: id, weight, categories });
const cat = (id, weight, items, kind = 'CUSTOM') => ({ id, name: id, kind, weight, items: items.map(([itemId, maxPoints]) => ({ id: itemId, title: itemId, maxPoints })) });
const graded = (score, extra = {}) => ({ score, status: 'GRADED', ...extra });

describe('grading scale', () => {
  it('maps a percentage to its band', () => {
    expect(scaleLabel(scale, 100).label).toBe('1.00');
    expect(scaleLabel(scale, 97).label).toBe('1.00');
    expect(scaleLabel(scale, 96.99).label).toBe('1.25');
    expect(scaleLabel(scale, 75)).toMatchObject({ label: '3.00', isPassing: true });
    expect(scaleLabel(scale, 74.99)).toMatchObject({ label: '5.00', isPassing: false });
    expect(scaleLabel(scale, 0).label).toBe('5.00');
    expect(scaleLabel(scale, null)).toBeNull();
    expect(scaleLabel([], 90)).toBeNull();
  });

  it('works with a different institution\'s scale (letters, other cut-offs)', () => {
    const letters = [
      { minPercent: 90, label: 'A', isPassing: true }, { minPercent: 80, label: 'B', isPassing: true },
      { minPercent: 70, label: 'C', isPassing: true }, { minPercent: 60, label: 'D', isPassing: true }, { minPercent: 0, label: 'F', isPassing: false },
    ];
    expect(scaleLabel(letters, 60).label).toBe('D');
    expect(scaleLabel(letters, 59.9)).toMatchObject({ label: 'F', isPassing: false });
  });

  it('transmutes with a base', () => {
    expect(transmute(0, 50)).toBe(50);
    expect(transmute(50, 50)).toBe(75);
    expect(transmute(100, 50)).toBe(100);
    expect(transmute(80, 0)).toBe(80);
    expect(transmute(null, 50)).toBeNull();
  });
});

describe('weighted grade computation', () => {
  const periods = [
    period('Midterm', 50, [cat('Quizzes', 40, [['q1', 20], ['q2', 30]]), cat('Exam', 60, [['mt', 100]])]),
    period('Final', 50, [cat('Quizzes', 40, [['q3', 50]]), cat('Exam', 60, [['fx', 100]])]),
  ];

  it('computes category, period and overall grades', () => {
    const entries = { q1: graded(18), q2: graded(24), mt: graded(80), q3: graded(45), fx: graded(90) };
    const r = computeStudentGrades({ periods, entries, settings: settings() });
    // Quizzes: (18 + 24) / 50 = 84 %; Midterm = 84 × .4 + 80 × .6 = 81.6
    expect(r.periods[0].categories[0]).toMatchObject({ percent: 84, earned: 42, possible: 50 });
    expect(r.periods[0]).toMatchObject({ percent: 81.6, label: '2.50', isComplete: true });
    // Final = 90 × .4 + 90 × .6 = 90
    expect(r.periods[1].percent).toBe(90);
    // Overall = (81.6 + 90) / 2 = 85.8
    expect(r.overall).toMatchObject({ percent: 85.8, label: '2.00', isPassing: true, isComplete: true });
  });

  it('weights by points inside a category, not by item', () => {
    const r = computeStudentGrades({ periods, entries: { q1: graded(20), q2: graded(0) }, settings: settings() });
    expect(r.periods[0].categories[0].percent).toBe(40); // 20 / 50, not the mean of 100 % and 0 %
  });

  it('keeps missing, exempt, ungraded and late work distinct', () => {
    const entries = {
      q1: { score: null, status: 'MISSING' },
      q2: graded(30, { isLate: true }),
      mt: { score: null, status: 'EXEMPT' },
    };
    const zero = computeStudentGrades({ periods, entries, settings: settings() });
    // Missing counts as 0 of 20: (0 + 30) / 50 = 60 %.  The exempt exam is left out entirely.
    expect(zero.periods[0].categories[0].percent).toBe(60);
    expect(zero.periods[0].categories[1].percent).toBeNull();
    expect(zero.periods[0]).toMatchObject({ percent: 60, isComplete: false, countedWeight: 40 });
    const items = zero.periods[0].categories[0].items;
    expect(items[0]).toMatchObject({ status: 'MISSING', counted: true, score: null });
    expect(items[1]).toMatchObject({ status: 'GRADED', isLate: true, score: 30 });
    expect(zero.periods[0].categories[1].items[0]).toMatchObject({ status: 'EXEMPT', counted: false });

    // With "missing does not count", only the graded quiz remains: 30 / 30.
    const lenient = computeStudentGrades({ periods, entries, settings: settings({ treatMissingAsZero: false }) });
    expect(lenient.periods[0].categories[0].percent).toBe(100);
    // Nothing graded in the Final period: it is left out of the overall grade.
    expect(lenient.periods[1].percent).toBeNull();
    expect(lenient.overall).toMatchObject({ percent: 100, isComplete: false, countedWeight: 50 });
  });

  it('returns nulls, not zeros, when nothing is graded', () => {
    const r = computeStudentGrades({ periods, entries: {}, settings: settings() });
    expect(r.overall).toMatchObject({ percent: null, label: null, isPassing: null });
    expect(r.periods.every((p) => p.percent === null)).toBe(true);
  });

  it('applies transmutation and rounding before the scale', () => {
    const entries = { q1: graded(10), q2: graded(15), mt: graded(50), q3: graded(25), fx: graded(50) };
    const raw = computeStudentGrades({ periods, entries, settings: settings() });
    expect(raw.overall).toMatchObject({ percent: 50, label: '5.00', isPassing: false });
    const transmuted = computeStudentGrades({ periods, entries, settings: settings({ transmutationBase: 50 }) });
    expect(transmuted.overall).toMatchObject({ rawPercent: 50, percent: 75, label: '3.00', isPassing: true });

    const edge = { q1: graded(20), q2: graded(30), mt: graded(74.5), q3: graded(50), fx: graded(74.5) };
    // Quizzes 100 × .4 + 74.5 × .6 = 84.7 → rounds to 85 with whole-number rounding.
    expect(computeStudentGrades({ periods, entries: edge, settings: settings({ gradeRounding: 2 }) }).overall).toMatchObject({ percent: 84.7, label: '2.25' });
    expect(computeStudentGrades({ periods, entries: edge, settings: settings({ gradeRounding: 0 }) }).overall).toMatchObject({ percent: 85, label: '2.00' });
  });

  it('lets an override replace a period or the overall grade and still reports the computed value', () => {
    const entries = { q1: graded(18), q2: graded(24), mt: graded(80), q3: graded(45), fx: graded(90) };
    const periodOverride = computeStudentGrades({ periods, entries, settings: settings(), overrides: [{ id: 'o1', scope: 'Midterm', overridePercent: 90, reason: 'Removal exam' }] });
    expect(periodOverride.periods[0]).toMatchObject({ percent: 90, computedPercent: 81.6, isOverridden: true });
    expect(periodOverride.overall.percent).toBe(90); // (90 + 90) / 2
    const overall = computeStudentGrades({ periods, entries, settings: settings(), overrides: [{ id: 'o2', scope: 'OVERALL', overridePercent: 75, reason: 'Committee decision' }] });
    expect(overall.overall).toMatchObject({ percent: 75, computedPercent: 85.8, isOverridden: true, label: '3.00' });
    expect(explainGrades(overall, settings()).join('\n')).toContain('Committee decision');
  });

  it('computes an attendance category from attendance records', () => {
    const withAttendance = [period('Term', 100, [cat('Exam', 80, [['x', 100]]), cat('Attendance', 20, [], 'ATTENDANCE')])];
    const attendance = { present: 8, late: 2, absent: 0, excused: 3 };
    expect(attendancePercent(attendance, 0.5)).toBe(90);
    expect(attendancePercent({ present: 0, late: 0, absent: 0, excused: 4 })).toBeNull();
    const r = computeStudentGrades({ periods: withAttendance, entries: { x: graded(70) }, settings: settings(), attendance });
    expect(r.periods[0].categories[1]).toMatchObject({ percent: 90, fromAttendance: true });
    expect(r.overall.percent).toBe(74); // 70 × .8 + 90 × .2
    // When the institution does not allow attendance in grades the category is ignored.
    const off = computeStudentGrades({ periods: withAttendance, entries: { x: graded(70) }, settings: settings({ attendanceCounts: false }), attendance });
    expect(off.overall.percent).toBe(70);
  });

  it('explains the computation in words', () => {
    const entries = { q1: graded(18), q2: graded(24), mt: graded(80) };
    const text = explainGrades(computeStudentGrades({ periods, entries, settings: settings() }), settings()).join('\n');
    expect(text).toContain('Midterm: (Quizzes 84% × 40% + Exam 80% × 60%) ÷ 100% = 81.6%.');
    expect(text).toContain('Final: nothing has been graded yet.');
    expect(text).toContain('Missing work counts as zero');
    expect(text).toContain('corresponds to 2.50');
  });
});

describe('gradebook structure validation', () => {
  it('requires weights to total 100 %', () => {
    const ok = [{ name: 'Midterm', weight: 40, categories: [{ name: 'A', weight: 33.33 }, { name: 'B', weight: 33.33 }, { name: 'C', weight: 33.34 }] }, { name: 'Final', weight: 60, categories: [{ name: 'A', weight: 100 }] }];
    expect(validateStructure(ok)).toEqual([]);
    const bad = [{ name: 'Midterm', weight: 40, categories: [{ name: 'A', weight: 50 }, { name: 'a', weight: 40 }] }, { name: 'midterm', weight: 50, categories: [] }];
    const errors = validateStructure(bad).join('\n');
    expect(errors).toContain('Grading period weights must total 100% (currently 90%)');
    expect(errors).toContain('Category weights in "Midterm" must total 100% (currently 90%)');
    expect(errors).toContain('two categories named "a"');
    expect(errors).toContain('Two grading periods are named "midterm"');
    expect(errors).toContain('needs at least one category');
    expect(validateStructure([])).toEqual(['Add at least one grading period.']);
  });
});

describe('late penalty', () => {
  const due = new Date('2026-11-10T15:59:00Z');
  const at = (iso) => new Date(iso);

  it('is zero for on-time work and when there is no due date', () => {
    expect(latePenalty({ dueAt: due, submittedAt: due, type: 'PERCENT_PER_DAY', value: 10, max: 50 })).toEqual({ isLate: false, daysLate: 0, penaltyPercent: 0 });
    expect(latePenalty({ dueAt: null, submittedAt: at('2030-01-01T00:00:00Z'), type: 'PERCENT_FLAT', value: 10, max: 100 }).isLate).toBe(false);
  });

  it('charges per started day up to the cap', () => {
    const p = (iso) => latePenalty({ dueAt: due, submittedAt: at(iso), type: 'PERCENT_PER_DAY', value: 10, max: 30 });
    expect(p('2026-11-10T16:00:00Z')).toEqual({ isLate: true, daysLate: 1, penaltyPercent: 10 });
    expect(p('2026-11-11T15:59:00Z').penaltyPercent).toBe(10);
    expect(p('2026-11-11T16:00:00Z')).toMatchObject({ daysLate: 2, penaltyPercent: 20 });
    expect(p('2026-11-20T00:00:00Z').penaltyPercent).toBe(30);
  });

  it('supports a flat penalty and no penalty', () => {
    expect(latePenalty({ dueAt: due, submittedAt: at('2026-11-15T00:00:00Z'), type: 'PERCENT_FLAT', value: 15, max: 100 }).penaltyPercent).toBe(15);
    expect(latePenalty({ dueAt: due, submittedAt: at('2026-11-15T00:00:00Z'), type: 'NONE', value: 15, max: 100 })).toMatchObject({ isLate: true, penaltyPercent: 0 });
  });

  it('applies the penalty to the score', () => {
    expect(applyPenalty(90, 20)).toBe(72);
    expect(applyPenalty(85, 0)).toBe(85);
    expect(applyPenalty(33.335, 10)).toBe(30);
    expect(applyPenalty(50, 100)).toBe(0);
    expect(applyPenalty(null, 10)).toBeNull();
  });
});
