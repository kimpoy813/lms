import { beforeAll, describe, expect, it } from 'vitest';
import { actor, categoryId, classroom, createClass, enroll, prepare, prisma } from '../helpers/index.js';

beforeAll(prepare);

const SAMPLE_MC = {
  type: 'MULTIPLE_CHOICE',
  text: '<p>What is 2 + 2?</p>',
  points: 5,
  choices: [
    { text: '3', isCorrect: false },
    { text: '4', isCorrect: true },
    { text: '5', isCorrect: false },
  ],
};

describe('posting content to multiple classes', () => {
  it('creates and posts modules with lessons and uploaded resources across multiple classes', async () => {
    const { teacher, cls: clsA, students: studentsA } = await classroom(1);
    const clsB = await createClass(teacher.user);
    const clsC = await createClass(teacher.user);
    const studentB = await actor('STUDENT');
    const studentC = await actor('STUDENT');
    await enroll(clsB, studentB.user);
    await enroll(clsC, studentC.user);

    // 1. Create a module directly in 3 classes as PUBLISHED.
    const createdMod = await teacher.post(`/api/classes/${clsA.id}/modules`, {
      title: 'Week 1 — Foundations',
      description: 'Core concepts',
      objectives: ['Understand basics'],
      status: 'PUBLISHED',
      targetClassIds: [clsB.id, clsC.id],
    });
    expect(createdMod.status).toBe(201);
    expect(createdMod.body.data.createdCopies).toHaveLength(2);

    const modsB = (await studentB.get(`/api/classes/${clsB.id}/modules`)).body.data;
    const modsC = (await studentC.get(`/api/classes/${clsC.id}/modules`)).body.data;
    expect(modsB.map((m) => m.title)).toContain('Week 1 — Foundations');
    expect(modsC.map((m) => m.title)).toContain('Week 1 — Foundations');
    expect(await prisma.notification.count({ where: { userId: studentB.user.id, type: 'module.published' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: studentC.user.id, type: 'module.published' } })).toBe(1);

    // 2. Upload a file resource in clsA's module and post an existing module (with lessons + files) to clsB.
    const upload = await teacher.upload([{ name: 'slides.txt', content: 'Week 1 slide notes' }]);
    const fileId = upload.body.data[0].id;
    const modA = createdMod.body.data;

    await teacher.post(`/api/modules/${modA.id}/lessons`, {
      title: 'Lesson 1.1',
      contentHtml: '<p>Lesson body</p>',
      status: 'PUBLISHED',
    });
    await teacher.post(`/api/classes/${clsA.id}/resources`, {
      title: 'Week 1 Slides',
      type: 'FILE',
      fileId,
      moduleId: modA.id,
    });

    const clsD = await createClass(teacher.user);
    const studentD = await actor('STUDENT');
    await enroll(clsD, studentD.user);

    const distributed = await teacher.post(`/api/modules/${modA.id}/copy`, {
      targetClassIds: [clsD.id],
      status: 'PUBLISHED',
    });
    expect(distributed.status).toBe(201);
    const modsD = (await studentD.get(`/api/classes/${clsD.id}/modules`)).body.data;
    expect(modsD[0]).toMatchObject({ title: 'Week 1 — Foundations', lessonCount: 1 });
    expect(modsD[0].resources).toHaveLength(1);
    expect((await studentsA[0].get(`/api/files/${fileId}`)).status).toBe(200);
    expect((await studentD.get(`/api/files/${fileId}`)).status).toBe(200);
  });

  it('creates and copies lessons across classes, matching or creating parent modules and preserving attachments', async () => {
    const { teacher, cls: clsA } = await classroom(1);
    const clsB = await createClass(teacher.user);
    const clsC = await createClass(teacher.user);
    const studentB = await actor('STUDENT');
    const studentC = await actor('STUDENT');
    await enroll(clsB, studentB.user);
    await enroll(clsC, studentC.user);

    const modA = (await teacher.post(`/api/classes/${clsA.id}/modules`, { title: 'Unit 2 — Data Structures', status: 'PUBLISHED' })).body.data;
    // clsB already has a module with the same title; clsC does not.
    const existingModB = (await teacher.post(`/api/classes/${clsB.id}/modules`, { title: 'Unit 2 — Data Structures', status: 'PUBLISHED' })).body.data;

    const createdLesson = await teacher.post(`/api/modules/${modA.id}/lessons`, {
      title: 'Arrays and Lists',
      contentHtml: '<p>Contiguous vs linked memory</p>',
      status: 'PUBLISHED',
      targetClassIds: [clsB.id, clsC.id],
    });
    expect(createdLesson.status).toBe(201);
    expect(createdLesson.body.data.createdCopies).toHaveLength(2);

    const listB = (await studentB.get(`/api/classes/${clsB.id}/modules`)).body.data;
    const listC = (await studentC.get(`/api/classes/${clsC.id}/modules`)).body.data;
    expect(listB).toHaveLength(1);
    expect(listB[0].id).toBe(existingModB.id);
    expect(listB[0].lessons.map((l) => l.title)).toEqual(['Arrays and Lists']);
    expect(listC).toHaveLength(1);
    expect(listC[0]).toMatchObject({ title: 'Unit 2 — Data Structures' });
    expect(listC[0].lessons.map((l) => l.title)).toEqual(['Arrays and Lists']);

    // Attach a file to Lesson 1 in clsA, then post that existing lesson to another class clsD.
    const clsD = await createClass(teacher.user);
    const studentD = await actor('STUDENT');
    await enroll(clsD, studentD.user);

    const up = await teacher.upload([{ name: 'notes.txt', content: 'Detailed notes' }]);
    const fileId = up.body.data[0].id;
    await teacher.post(`/api/classes/${clsA.id}/resources`, {
      title: 'Summary PDF',
      type: 'FILE',
      fileId,
      lessonId: createdLesson.body.data.id,
    });

    const copiedLesson = await teacher.post(`/api/lessons/${createdLesson.body.data.id}/copy`, {
      targetClassIds: [clsD.id],
      status: 'PUBLISHED',
    });
    expect(copiedLesson.status).toBe(201);
    const dLessonId = copiedLesson.body.data.createdCopies[0].id;
    const dLessonDetail = (await studentD.get(`/api/lessons/${dLessonId}`)).body.data;
    expect(dLessonDetail.resources).toHaveLength(1);
    expect((await studentD.get(`/api/files/${fileId}`)).status).toBe(200);
  });

  it('uploads and shares resources to multiple classes independently', async () => {
    const { teacher, cls: clsA, students: studentsA } = await classroom(1);
    const clsB = await createClass(teacher.user);
    const studentB = await actor('STUDENT');
    await enroll(clsB, studentB.user);

    const up = await teacher.upload([{ name: 'syllabus.txt', content: 'Course syllabus' }]);
    const fileId = up.body.data[0].id;

    const createdRes = await teacher.post(`/api/classes/${clsA.id}/resources`, {
      title: 'Course Syllabus',
      type: 'FILE',
      fileId,
      targetClassIds: [clsB.id],
    });
    expect(createdRes.status).toBe(201);
    expect(createdRes.body.data.createdCopies).toHaveLength(1);
    const resAId = createdRes.body.data.id;

    expect((await studentsA[0].get(`/api/files/${fileId}`)).status).toBe(200);
    expect((await studentB.get(`/api/files/${fileId}`)).status).toBe(200);

    // Deleting the resource from clsA must leave clsB's resource and file intact.
    expect((await teacher.delete(`/api/resources/${resAId}`)).status).toBe(204);
    expect((await studentsA[0].get(`/api/files/${fileId}`)).status).toBe(404);
    expect((await studentB.get(`/api/files/${fileId}`)).status).toBe(200);

    // Copy an existing resource from clsB to clsC.
    const clsC = await createClass(teacher.user);
    const studentC = await actor('STUDENT');
    await enroll(clsC, studentC.user);
    const resBId = createdRes.body.data.createdCopies[0].id;
    const copiedRes = await teacher.post(`/api/resources/${resBId}/copy`, { targetClassIds: [clsC.id] });
    expect(copiedRes.status).toBe(201);
    expect((await studentC.get(`/api/files/${fileId}`)).status).toBe(200);
  });

  it('creates and copies assignments with cloned file attachments and matched gradebook categories across classes', async () => {
    const { teacher, cls: clsA, students: studentsA } = await classroom(1);
    const clsB = await createClass(teacher.user);
    const studentB = await actor('STUDENT');
    await enroll(clsB, studentB.user);

    const catA = await categoryId(clsA.id, 'ASSIGNMENT');
    const up = await teacher.upload([{ name: 'worksheet.txt', content: 'Fill in the blanks' }]);
    const fileId = up.body.data[0].id;

    const made = await teacher.post(`/api/classes/${clsA.id}/assignments`, {
      title: 'Homework 1',
      instructionsHtml: '<p>Complete the worksheet.</p>',
      points: 50,
      status: 'PUBLISHED',
      categoryId: catA,
      fileIds: [fileId],
      targetClassIds: [clsB.id],
    });
    expect(made.status).toBe(201);
    expect(made.body.data.createdCopies).toHaveLength(1);
    const assignAId = made.body.data.id;
    const assignBId = made.body.data.createdCopies[0].id;

    const detailB = (await studentB.get(`/api/assignments/${assignBId}`)).body.data;
    expect(detailB.attachments).toHaveLength(1);
    const clonedFileId = detailB.attachments[0].id;
    expect(clonedFileId).not.toBe(fileId);
    expect((await studentsA[0].get(`/api/files/${fileId}`)).text).toBe('Fill in the blanks');
    expect((await studentB.get(`/api/files/${clonedFileId}`)).text).toBe('Fill in the blanks');

    // Gradebook column automatically linked in clsB too.
    const bookB = (await teacher.get(`/api/classes/${clsB.id}/gradebook`)).body.data;
    const itemsB = bookB.structure.periods.flatMap((p) => p.categories.flatMap((c) => c.items));
    expect(itemsB.some((i) => i.assignmentId === assignBId && i.maxPoints === 50)).toBe(true);

    // Deleting Homework 1 from clsA must not break clsB's cloned attachment.
    expect((await teacher.delete(`/api/assignments/${assignAId}`)).status).toBe(204);
    expect((await studentB.get(`/api/files/${clonedFileId}`)).status).toBe(200);

    // Post existing Homework 1 from clsB to clsC as PUBLISHED.
    const clsC = await createClass(teacher.user);
    const studentC = await actor('STUDENT');
    await enroll(clsC, studentC.user);
    const posted = await teacher.post(`/api/assignments/${assignBId}/copy`, {
      targetClassIds: [clsC.id],
      status: 'PUBLISHED',
    });
    expect(posted.status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: studentC.user.id, type: 'assignment.published' } })).toBe(1);
    const assignCId = posted.body.data.createdCopies[0].id;
    const detailC = (await studentC.get(`/api/assignments/${assignCId}`)).body.data;
    expect(detailC.attachments).toHaveLength(1);
  });

  it('creates, syncs, publishes, and posts quizzes across multiple classes', async () => {
    const { teacher, cls: clsA, students: studentsA } = await classroom(1);
    const clsB = await createClass(teacher.user);
    const clsC = await createClass(teacher.user);
    const studentB = await actor('STUDENT');
    const studentC = await actor('STUDENT');
    await enroll(clsB, studentB.user);
    await enroll(clsC, studentC.user);

    const quizCatA = await categoryId(clsA.id, 'QUIZ');
    const createdQuiz = await teacher.post(`/api/classes/${clsA.id}/quizzes`, {
      title: 'Midterm Quiz',
      kind: 'QUIZ',
      categoryId: quizCatA,
      targetClassIds: [clsB.id],
    });
    expect(createdQuiz.status).toBe(201);
    expect(createdQuiz.body.data.createdCopies).toHaveLength(1);
    const quizAId = createdQuiz.body.data.id;
    const quizBId = createdQuiz.body.data.createdCopies[0].id;

    // Add a question to Quiz A, then sync & publish to Quiz B.
    await teacher.post(`/api/quizzes/${quizAId}/questions`, { question: SAMPLE_MC });
    await teacher.patch(`/api/quizzes/${quizAId}`, { status: 'PUBLISHED' });
    const synced = await teacher.post(`/api/quizzes/${quizAId}/sync`, {
      targetQuizIds: [quizBId],
      publish: true,
    });
    expect(synced.status).toBe(200);
    expect(synced.body.data.synced).toHaveLength(1);
    expect(synced.body.data.skipped).toHaveLength(0);

    const qBForStudent = (await studentB.get(`/api/quizzes/${quizBId}`)).body.data;
    expect(qBForStudent).toMatchObject({ title: 'Midterm Quiz', questionCount: 1, totalPoints: 5 });
    expect(await prisma.notification.count({ where: { userId: studentB.user.id, type: 'quiz.published' } })).toBe(1);

    // Post completed Quiz A directly to clsC as PUBLISHED.
    const postedC = await teacher.post(`/api/quizzes/${quizAId}/copy`, {
      targetClassIds: [clsC.id],
      status: 'PUBLISHED',
    });
    expect(postedC.status).toBe(201);
    const quizCId = postedC.body.data.createdCopies[0].id;
    expect((await studentC.get(`/api/quizzes/${quizCId}`)).body.data).toMatchObject({ questionCount: 1, totalPoints: 5 });
    expect(await prisma.notification.count({ where: { userId: studentC.user.id, type: 'quiz.published' } })).toBe(1);

    // Once a student in clsB starts an attempt, syncing cannot overwrite Quiz B.
    await studentB.post(`/api/quizzes/${quizBId}/attempts`, { acceptRules: true });
    const resync = await teacher.post(`/api/quizzes/${quizAId}/sync`, {
      targetQuizIds: [quizBId],
      publish: true,
    });
    expect(resync.status).toBe(200);
    expect(resync.body.data.synced).toHaveLength(0);
    expect(resync.body.data.skipped).toHaveLength(1);
    // Primary student A still can see Quiz A cleanly.
    expect((await studentsA[0].get(`/api/quizzes/${quizAId}`)).status).toBe(200);
  });

  it('approves an AI-generated module draft into multiple classes at once', async () => {
    const { teacher, cls: clsA } = await classroom(0);
    const clsB = await createClass(teacher.user);
    const reqRow = await prisma.aIGenerationRequest.create({
      data: {
        teacherId: teacher.user.id,
        classId: clsA.id,
        clientRequestId: `ai-multi-${Date.now()}`,
        requestType: 'MODULE',
        topic: 'Algorithms',
        generationStatus: 'COMPLETED',
        generatedModule: {
          create: {
            modelIdentifier: 'builtin',
            generatedContent: {
              title: 'Algorithm Design',
              overview: 'Sorting and searching',
              objectives: ['Analyze complexity'],
              lessons: [{ title: 'Big-O Notation', kind: 'LESSON', contentHtml: '<p>Growth rates</p>' }],
              activities: [],
              assessment: [],
              references: [],
            },
          },
        },
      },
      include: { generatedModule: true },
    });

    const approved = await teacher.post(`/api/ai/generated/${reqRow.generatedModule.id}/approve`, {
      classId: clsA.id,
      targetClassIds: [clsB.id],
      confirmReviewed: true,
    });
    expect(approved.status).toBe(201);
    expect(approved.body.data.createdCopies).toHaveLength(1);
    const modsB = (await teacher.get(`/api/classes/${clsB.id}/modules`)).body.data;
    expect(modsB.some((m) => m.title === 'Algorithm Design' && m.status === 'DRAFT' && m.lessonCount === 1)).toBe(true);
  });

  it('rejects unauthorized or archived target classes atomically without leaving partial records', async () => {
    const { teacher, cls: clsA } = await classroom(0);
    const archived = await createClass(teacher.user, { status: 'ARCHIVED' });
    const otherTeacher = await actor('TEACHER');
    const strangerClass = await createClass(otherTeacher.user);

    const withStranger = await teacher.post(`/api/classes/${clsA.id}/assignments`, {
      title: 'Should Not Exist',
      targetClassIds: [strangerClass.id],
    });
    expect(withStranger.status).toBe(404);
    expect(await prisma.assignment.count({ where: { classId: clsA.id, title: 'Should Not Exist' } })).toBe(0);

    const withArchived = await teacher.post(`/api/classes/${clsA.id}/modules`, {
      title: 'Archived Target Test',
      targetClassIds: [archived.id],
    });
    expect(withArchived.status).toBe(409);
    expect(await prisma.learningModule.count({ where: { classId: clsA.id, title: 'Archived Target Test' } })).toBe(0);
  });
});
