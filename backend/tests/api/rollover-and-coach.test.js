// Whole-class semester rollover (#5) and opt-in Student Study Coach (#6).
import { beforeAll, describe, expect, it } from 'vitest';
import { actor, classroom, prepare, prisma } from '../helpers/index.js';

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
    await teacher.post(`/api/modules/${mod.id}/lessons`, { title: 'Merge Sort', contentHtml: '<p>Merge sort splits the array in half.</p>', prerequisiteLessonId: l1.id, status: 'PUBLISHED' });

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

    const newQuizzes = (await teacher.get(`/api/classes/${copied.id}/quizzes`)).body.data;
    expect(newQuizzes).toHaveLength(1);
    expect(newQuizzes[0]).toMatchObject({ title: 'Quiz 1: Complexity', status: 'DRAFT', questionCount: 1 });
    expect(newQuizzes[0].module?.id).toBe(newMods[0].id);

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
    expect(preview.body.data.model).toBe('edusphere-builtin-v1');

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
