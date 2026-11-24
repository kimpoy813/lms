// Whole-class semester rollover (#5) and opt-in Student Study Coach (#6).
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, classroom, createClass, enroll, prepare, prisma } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
});

describe('whole-class semester rollover (POST /api/classes/:classId/copy)', () => {
  it('clones syllabus, grade setup, draft modules/lessons, assignments, and quizzes into a new semester without copying students or grades', async () => {
    const { teacher, cls, students } = await classroom(1);
    const otherTeacher = await actor('TEACHER');

    // Create a second semester & section to roll over into
    const ay = await prisma.academicYear.create({
      data: {
        name: `2027-2028-${Date.now()}`,
        startDate: new Date('2027-08-01'),
        endDate: new Date('2028-05-31'),
      },
    });
    const nextSem = await prisma.semester.create({
      data: { academicYearId: ay.id, name: 'Second Semester', startDate: new Date('2027-11-01'), endDate: new Date('2028-03-31'), isCurrent: false },
    });

    // Populate source class: syllabus, custom grade period, module + 2 lessons (with prerequisite), assignment, quiz
    await teacher.patch(`/api/classes/${cls.id}`, {
      syllabusHtml: '<p>Updated CS101 Syllabus</p>',
      learningOutcomes: ['Analyze time complexity', 'Write recursive solutions'],
      aiStudyCoachEnabled: true,
    });

    const mod = (await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Unit 1: Algorithms', status: 'PUBLISHED' })).body.data;
    const l1 = (await teacher.post(`/api/modules/${mod.id}/lessons`, { title: 'Sorting Basics', contentHtml: '<p>Bubble sort compares adjacent items.</p>', status: 'PUBLISHED' })).body.data;
    const l2 = (await teacher.post(`/api/modules/${mod.id}/lessons`, { title: 'Merge Sort', contentHtml: '<p>Merge sort splits the array in half.</p>', prerequisiteLessonId: l1.id, status: 'PUBLISHED' })).body.data;

    const rubric = (await teacher.post('/api/rubrics', {
      title: 'Lab Rubric',
      criteria: [{ title: 'Correctness', maxPoints: 50, levels: [{ title: 'Great', points: 50 }, { title: 'Ok', points: 25 }] }],
    })).body.data;

    const periods = (await teacher.get(`/api/classes/${cls.id}/gradebook`)).body.data.structure.periods;
    const assignCategoryId = periods[0].categories.find((c) => c.kind === 'ASSIGNMENT').id;
    const quizCategoryId = periods[0].categories.find((c) => c.kind === 'QUIZ').id;

    await teacher.post(`/api/classes/${cls.id}/assignments`, {
      title: 'Lab 1: Sorting',
      instructionsHtml: '<p>Implement bubble sort.</p>',
      points: 50,
      rubricId: rubric.id,
      moduleId: mod.id,
      lessonId: l1.id,
      categoryId: assignCategoryId,
      status: 'PUBLISHED',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const bank = (await teacher.post('/api/question-banks', { title: 'Algo Bank' })).body.data;
    const q1 = (await teacher.post(`/api/question-banks/${bank.id}/questions`, { type: 'TRUE_FALSE', text: 'Merge sort is O(n log n).', answer: true, points: 5 })).body.data;
    const quiz = (await teacher.post(`/api/classes/${cls.id}/quizzes`, {
      title: 'Quiz 1: Complexity',
      kind: 'QUIZ',
      moduleId: mod.id,
      lessonId: l2.id,
      categoryId: quizCategoryId,
    })).body.data;
    await teacher.put(`/api/quizzes/${quiz.id}/questions`, { items: [{ questionId: q1.id, points: 5 }] });

    // Unauthorized users cannot copy
    expect((await students[0].post(`/api/classes/${cls.id}/copy`, { semesterId: nextSem.id })).status).toBe(403);
    expect((await otherTeacher.post(`/api/classes/${cls.id}/copy`, { semesterId: nextSem.id })).status).toBe(404);

    // Perform rollover
    const copyRes = await teacher.post(`/api/classes/${cls.id}/copy`, {
      semesterId: nextSem.id,
      room: 'Lab 305',
      color: 'teal',
    });
    expect(copyRes.status).toBe(201);
    const copied = copyRes.body.data;
    expect(copied.id).not.toBe(cls.id);
    expect(copied.semester.id).toBe(nextSem.id);
    expect(copied.room).toBe('Lab 305');
    expect(copied.color).toBe('teal');
    expect(copied.studentCount).toBe(0);
    expect(copied.aiStudyCoachEnabled).toBe(true);
    expect(copied.summary).toMatchObject({ modules: 1, assignments: 1, quizzes: 1 });

    // Verify detail, syllabus, modules (DRAFT), assignments (DRAFT without due dates), quizzes (DRAFT)
    const detail = (await teacher.get(`/api/classes/${copied.id}`)).body.data;
    expect(detail.syllabusHtml).toContain('Updated CS101 Syllabus');
    expect(detail.learningOutcomes).toEqual(['Analyze time complexity', 'Write recursive solutions']);

    const newMods = (await teacher.get(`/api/classes/${copied.id}/modules`)).body.data;
    expect(newMods).toHaveLength(1);
    expect(newMods[0].status).toBe('DRAFT');
    expect(newMods[0].lessons).toHaveLength(2);
    expect(newMods[0].lessons[1].prerequisiteLessonId).toBe(newMods[0].lessons[0].id);

    const newAssigns = (await teacher.get(`/api/classes/${copied.id}/assignments`)).body.data;
    expect(newAssigns).toHaveLength(1);
    expect(newAssigns[0]).toMatchObject({ title: 'Lab 1: Sorting', status: 'DRAFT', dueAt: null });
    expect(newAssigns[0].module?.id).toBe(newMods[0].id);
    expect(newAssigns[0].lesson).toMatchObject({ id: newMods[0].lessons[0].id, title: 'Sorting Basics', moduleId: newMods[0].id });

    const newQuizzes = (await teacher.get(`/api/classes/${copied.id}/quizzes`)).body.data;
    expect(newQuizzes).toHaveLength(1);
    expect(newQuizzes[0]).toMatchObject({ title: 'Quiz 1: Complexity', status: 'DRAFT', questionCount: 1 });
    expect(newQuizzes[0].module?.id).toBe(newMods[0].id);
    expect(newQuizzes[0].lesson).toMatchObject({ id: newMods[0].lessons[1].id, title: 'Merge Sort', moduleId: newMods[0].id });

    const copiedBook = (await teacher.get(`/api/classes/${copied.id}/gradebook`)).body.data;
    expect(copiedBook.structure.valid).toBe(true);
    expect(copiedBook.structure.periods.map((p) => p.name)).toEqual(periods.map((p) => p.name));

    // Copying again into the same semester + section conflicts cleanly
    const dupRes = await teacher.post(`/api/classes/${cls.id}/copy`, { semesterId: nextSem.id });
    expect(dupRes.status).toBe(409);
  });
});

describe('opt-in per-class AI Study Coach (POST /api/lessons/:lessonId/study-coach)', () => {
  it('enforces per-class opt-in and strict published-lesson scoping for students', async () => {
    const { teacher, cls, students } = await classroom(1);
    const outsider = await actor('STUDENT');

    const mod = (await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Networking', status: 'PUBLISHED' })).body.data;
    const pubLesson = (await teacher.post(`/api/modules/${mod.id}/lessons`, {
      title: 'HTTP Methods',
      contentHtml: '<p>HTTP is a stateless request-response protocol. GET retrieves resources safely, whereas POST submits new data to the server.</p>',
      objectives: ['Distinguish GET and POST'],
      status: 'PUBLISHED',
    })).body.data;
    const draftLesson = (await teacher.post(`/api/modules/${mod.id}/lessons`, {
      title: 'Unpublished Draft Lesson',
      contentHtml: '<p>Secret draft exam answers.</p>',
      status: 'DRAFT',
    })).body.data;

    // Off by default for students
    const initialLesson = (await students[0].get(`/api/lessons/${pubLesson.id}`)).body.data;
    expect(initialLesson.aiStudyCoachEnabled).toBe(false);
    const refused = await students[0].post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'summary' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('STUDY_COACH_DISABLED');

    // Teacher preview always works even while off for students
    const preview = await teacher.post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'summary' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.model).toBe('discenda-builtin-v1');

    // Teacher enables AI Study Coach for the class
    expect((await teacher.patch(`/api/classes/${cls.id}`, { aiStudyCoachEnabled: true })).status).toBe(200);
    expect((await students[0].get(`/api/lessons/${pubLesson.id}`)).body.data.aiStudyCoachEnabled).toBe(true);

    // Enrolled student can now generate summary, flashcards, practice check, and explanations from published lesson
    const sumRes = await students[0].post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'summary' });
    expect(sumRes.status).toBe(200);
    expect(sumRes.body.data.keyTerms.some((k) => k.term === 'HTTP')).toBe(true);

    const cardRes = await students[0].post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'flashcards' });
    expect(cardRes.status).toBe(200);
    expect(cardRes.body.data.cards.length).toBeGreaterThanOrEqual(1);

    const pracRes = await students[0].post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'practice' });
    expect(pracRes.status).toBe(200);
    expect(pracRes.body.data.questions.length).toBeGreaterThanOrEqual(1);

    const expRes = await students[0].post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'explain', question: 'What does POST do?' });
    expect(expRes.status).toBe(200);
    expect(expRes.body.data.answer).toMatch(/POST|HTTP/i);

    // Students NEVER access draft lessons or other classes' lessons
    expect((await students[0].post(`/api/lessons/${draftLesson.id}/study-coach`, { mode: 'summary' })).status).toBe(404);
    expect((await outsider.post(`/api/lessons/${pubLesson.id}/study-coach`, { mode: 'summary' })).status).toBe(404);
  });
});

describe('copy setup between existing classes (POST /api/classes/:classId/copy-setup)', () => {
  it('copies category weights, grading policy, syllabus, and learning outcomes to multiple existing classes', async () => {
    const { teacher, cls: source, students } = await classroom(1);
    const targetA = await createClass(teacher.user);
    const targetB = await createClass(teacher.user);
    const otherTeacher = await actor('TEACHER');
    const foreignClass = await createClass(otherTeacher.user);

    // Configure source weights, policy, syllabus, and learning outcomes.
    expect((await teacher.put(`/api/classes/${source.id}/gradebook/structure`, {
      periods: [
        {
          name: 'Midterm',
          weight: 40,
          categories: [
            { name: 'Quizzes', kind: 'QUIZ', weight: 30 },
            { name: 'Projects', kind: 'PROJECT', weight: 70 },
          ],
        },
        {
          name: 'Finals',
          weight: 60,
          categories: [
            { name: 'Quizzes', kind: 'QUIZ', weight: 25 },
            { name: 'Final Exam', kind: 'EXAM', weight: 75 },
          ],
        },
      ],
    })).status).toBe(200);
    expect((await teacher.patch(`/api/classes/${source.id}/gradebook/settings`, {
      transmutationBase: 50,
      gradeRounding: 1,
      treatMissingAsZero: true,
    })).status).toBe(200);
    expect((await teacher.patch(`/api/classes/${source.id}`, {
      syllabusHtml: '<h2>Course Overview</h2><p>Algorithms and data structures.</p>',
      learningOutcomes: ['Design O(n log n) algorithms', 'Prove loop invariants'],
    })).status).toBe(200);

    // Authorization guards.
    expect((await students[0].post(`/api/classes/${source.id}/copy-setup`, { targetClassIds: [targetA.id] })).status).toBe(403);
    expect((await otherTeacher.post(`/api/classes/${source.id}/copy-setup`, { targetClassIds: [foreignClass.id] })).status).toBe(404);
    expect((await teacher.post(`/api/classes/${source.id}/copy-setup`, { targetClassIds: [foreignClass.id] })).status).toBe(404);

    // Copy weights, policy, syllabus, and outcomes to two active classes at once.
    const res = await teacher.post(`/api/classes/${source.id}/copy-setup`, {
      targetClassIds: [targetA.id, targetB.id],
      gradeWeights: true,
      gradePolicy: true,
      syllabus: true,
      learningOutcomes: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.targets).toHaveLength(2);

    for (const target of [targetA, targetB]) {
      const clsDetail = (await teacher.get(`/api/classes/${target.id}`)).body.data;
      expect(clsDetail.syllabusHtml).toContain('Algorithms and data structures.');
      expect(clsDetail.learningOutcomes).toEqual(['Design O(n log n) algorithms', 'Prove loop invariants']);

      const gb = (await teacher.get(`/api/classes/${target.id}/gradebook`)).body.data;
      expect(gb.structure.valid).toBe(true);
      expect(gb.structure.periods.map((p) => ({ name: p.name, weight: p.weight }))).toEqual([
        { name: 'Midterm', weight: 40 },
        { name: 'Finals', weight: 60 },
      ]);
      expect(gb.structure.periods[0].categories.map((c) => ({ name: c.name, weight: c.weight }))).toEqual([
        { name: 'Quizzes', weight: 30 },
        { name: 'Projects', weight: 70 },
      ]);
      expect(gb.class).toMatchObject({ transmutationBase: 50, gradeRounding: 1, treatMissingAsZero: true });
    }
  });

  it('preserves matching graded items when updating weights and rejects atomically when an in-use category has no match', async () => {
    const { teacher, cls: source } = await classroom(1);
    const targetOk = await createClass(teacher.user);
    const targetStudent = await actor('STUDENT');
    await enroll(targetOk, targetStudent.user);
    const targetConflict = await createClass(teacher.user);

    // Set custom weights on source (Midterm -> Quizzes 50% / Projects 50%, Finals -> Exam 100%).
    await teacher.put(`/api/classes/${source.id}/gradebook/structure`, {
      periods: [
        {
          name: 'Midterm',
          weight: 40,
          categories: [
            { name: 'Quizzes', kind: 'QUIZ', weight: 50 },
            { name: 'Projects', kind: 'PROJECT', weight: 50 },
          ],
        },
        {
          name: 'Finals',
          weight: 60,
          categories: [{ name: 'Exam', kind: 'EXAM', weight: 100 }],
        },
      ],
    });
    await teacher.patch(`/api/classes/${source.id}`, {
      syllabusHtml: '<p>Shared syllabus</p>',
      learningOutcomes: ['Outcome A'],
    });

    // targetOk already has a graded manual item inside "Quizzes" in Midterm.
    const okGb = (await teacher.get(`/api/classes/${targetOk.id}/gradebook`)).body.data;
    const midtermQuizCat = okGb.structure.periods.find((p) => p.name === 'Midterm').categories.find((c) => c.kind === 'QUIZ');
    const createdItem = await teacher.post(`/api/classes/${targetOk.id}/gradebook/items`, {
      title: 'Existing Quiz 1',
      maxPoints: 20,
      categoryId: midtermQuizCat.id,
    });
    expect(createdItem.status).toBe(201);
    expect((await teacher.put(`/api/classes/${targetOk.id}/gradebook/entries`, {
      entries: [{ studentId: targetStudent.user.id, itemId: createdItem.body.data.id, status: 'GRADED', score: 18 }],
    })).status).toBe(200);

    // Copy weights + syllabus + outcomes into targetOk: existing item and score remap cleanly.
    const okCopy = await teacher.post(`/api/classes/${source.id}/copy-setup`, {
      targetClassIds: [targetOk.id],
      gradeWeights: true,
      syllabus: true,
      learningOutcomes: true,
    });
    expect(okCopy.status).toBe(200);
    expect(okCopy.body.data.targets[0].remappedItems).toBe(1);

    const updatedOkGb = (await teacher.get(`/api/classes/${targetOk.id}/gradebook`)).body.data;
    const newMidtermQuizCat = updatedOkGb.structure.periods[0].categories.find((c) => c.name === 'Quizzes');
    expect(newMidtermQuizCat.weight).toBe(50);
    expect(newMidtermQuizCat.items.map((i) => i.title)).toContain('Existing Quiz 1');
    expect(updatedOkGb.students[0].entries[createdItem.body.data.id].score).toBe(18);
    expect(updatedOkGb.students[0].overall.percent).toBe(90);

    // targetConflict has a graded item inside a custom "Fieldwork" category missing from source.
    await teacher.put(`/api/classes/${targetConflict.id}/gradebook/structure`, {
      periods: [{ name: 'Midterm', weight: 100, categories: [{ name: 'Fieldwork', kind: 'CUSTOM', weight: 100 }] }],
    });
    const conflictGb = (await teacher.get(`/api/classes/${targetConflict.id}/gradebook`)).body.data;
    await teacher.post(`/api/classes/${targetConflict.id}/gradebook/items`, {
      title: 'Site Visit',
      maxPoints: 50,
      categoryId: conflictGb.structure.periods[0].categories[0].id,
    });

    const failRes = await teacher.post(`/api/classes/${source.id}/copy-setup`, {
      targetClassIds: [targetConflict.id],
      gradeWeights: true,
      syllabus: true,
      learningOutcomes: true,
    });
    expect(failRes.status).toBe(409);
    expect(failRes.body.error.code).toBe('GRADEBOOK_IN_USE');
    expect(failRes.body.error.message).toContain('Fieldwork');

    // Transaction rolled back cleanly — syllabus wasn't partially written to targetConflict either.
    expect((await teacher.get(`/api/classes/${targetConflict.id}`)).body.data.syllabusHtml).toBe('');
  });

  it('allows copying from an archived class into active classes while rejecting archived or locked targets for weight updates', async () => {
    const teacher = await actor('TEACHER');
    const archivedSource = await createClass(teacher.user);
    const activeTarget = await createClass(teacher.user);

    await teacher.patch(`/api/classes/${archivedSource.id}`, {
      syllabusHtml: '<p>Archived Term Syllabus</p>',
      learningOutcomes: ['Legacy Outcome'],
    });
    await teacher.post(`/api/classes/${archivedSource.id}/archive`);

    // Copying FROM archivedSource INTO activeTarget succeeds.
    const fromArchived = await teacher.post(`/api/classes/${archivedSource.id}/copy-setup`, {
      targetClassIds: [activeTarget.id],
      gradeWeights: false,
      syllabus: true,
      learningOutcomes: true,
    });
    expect(fromArchived.status).toBe(200);
    expect((await teacher.get(`/api/classes/${activeTarget.id}`)).body.data.syllabusHtml).toContain('Archived Term Syllabus');

    // Copying INTO archivedSource fails with CLASS_ARCHIVED.
    const intoArchived = await teacher.post(`/api/classes/${activeTarget.id}/copy-setup`, {
      targetClassIds: [archivedSource.id],
      syllabus: true,
      learningOutcomes: true,
    });
    expect(intoArchived.status).toBe(409);
    expect(intoArchived.body.error.code).toBe('CLASS_ARCHIVED');

    // Locking a grading period on activeTarget blocks weight updates, while still allowing syllabus-only copies.
    const gb = (await teacher.get(`/api/classes/${activeTarget.id}/gradebook`)).body.data;
    await teacher.post(`/api/classes/${activeTarget.id}/gradebook/periods/${gb.structure.periods[0].id}/lock`);

    const lockedWeights = await teacher.post(`/api/classes/${activeTarget.id}/copy-setup`, {
      targetClassIds: [activeTarget.id], // filtered out -> field error
      gradeWeights: true,
    });
    expect(lockedWeights.status).toBe(422);

    const activeSource = await createClass(teacher.user);
    await teacher.patch(`/api/classes/${activeSource.id}`, {
      syllabusHtml: '<p>Updated Mid-Term Syllabus</p>',
      learningOutcomes: ['New Outcome'],
    });

    const lockedWeightRes = await teacher.post(`/api/classes/${activeSource.id}/copy-setup`, {
      targetClassIds: [activeTarget.id],
      gradeWeights: true,
      syllabus: false,
      learningOutcomes: false,
    });
    expect(lockedWeightRes.status).toBe(409);
    expect(lockedWeightRes.body.error.code).toBe('PERIOD_LOCKED');

    const lockedSyllabusOnly = await teacher.post(`/api/classes/${activeSource.id}/copy-setup`, {
      targetClassIds: [activeTarget.id],
      gradeWeights: false,
      syllabus: true,
      learningOutcomes: true,
    });
    expect(lockedSyllabusOnly.status).toBe(200);
    expect((await teacher.get(`/api/classes/${activeTarget.id}`)).body.data.syllabusHtml).toContain('Updated Mid-Term Syllabus');
  });
});

