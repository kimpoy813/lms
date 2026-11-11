// Starting gradebook structure for a new class. It is only a starting point: the teacher can
// rename, re-weight, add or remove periods and categories before any grade is recorded.
// The category split mirrors a common college syllabus; nothing here is assumed to be an
// institutional rule.
export const DEFAULT_PERIODS = [
  {
    name: 'Final Grade',
    weight: 100,
    categories: [
      { name: 'Quizzes', kind: 'QUIZ', weight: 20 },
      { name: 'Assignments', kind: 'ASSIGNMENT', weight: 20 },
      { name: 'Activities', kind: 'ACTIVITY', weight: 15 },
      { name: 'Midterm Examination', kind: 'EXAM', weight: 20 },
      { name: 'Final Examination', kind: 'EXAM', weight: 25 },
    ],
  },
];

export async function createDefaultGradeSetup(tx, classId, periods = DEFAULT_PERIODS) {
  for (const [pIndex, period] of periods.entries()) {
    await tx.gradingPeriod.create({
      data: {
        classId,
        name: period.name,
        weight: period.weight,
        position: pIndex,
        categories: {
          create: period.categories.map((c, cIndex) => ({ name: c.name, kind: c.kind, weight: c.weight, position: cIndex })),
        },
      },
    });
  }
}
