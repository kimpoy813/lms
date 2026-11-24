import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { categoryId as getCategoryId, classroom, clearSetting, prepare, prisma, setSetting } from '../helpers/index.js';
import { setAiTransport } from '../../src/services/ai.js';

beforeAll(async () => {
  await prepare();
  await setSetting('ai.dailyRequestLimit', 30);
});

afterAll(async () => {
  setAiTransport(null);
  await clearSetting('ai.dailyRequestLimit');
});

async function makeAssignment(teacher, cls, { categoryId } = {}) {
  const rubric = await teacher.post('/api/rubrics', {
    title: 'Short response rubric',
    criteria: [
      { title: 'Accuracy', description: 'Correctly explain the main idea.', maxPoints: 8 },
      { title: 'Evidence', description: 'Support the explanation with a relevant example.', maxPoints: 4 },
    ],
  });
  expect(rubric.status).toBe(201);
  const assignment = await teacher.post(`/api/classes/${cls.id}/assignments`, {
    title: 'Explain the water cycle',
    instructionsHtml: '<p>Explain how water moves through the environment.</p>',
    status: 'PUBLISHED',
    rubricId: rubric.body.data.id,
    ...(categoryId ? { categoryId } : {}),
  });
  expect(assignment.status).toBe(201);
  return { assignment: assignment.body.data, rubric: rubric.body.data };
}

function scoringTransport({ onRequest } = {}) {
  return async ({ task, messages }) => {
    onRequest?.({ task, messages });
    const content = {
      scores: task.input.rubric.criteria.map((criterion, index) => ({
        criterionId: criterion.id,
        points: index === 0 ? 6 : 3,
        comment: `Evidence for ${criterion.title}.`,
      })),
      feedback: 'The answer explains the cycle and gives an example.',
    };
    return { content: JSON.stringify(content), model: 'test-rubric-model', promptTokens: 90, completionTokens: 45 };
  };
}

async function waitForGrading(submissionId, status) {
  let row;
  await vi.waitFor(async () => {
    row = await prisma.assignmentSubmission.findUnique({ where: { id: submissionId } });
    expect(row?.aiGradingStatus).toBe(status);
  }, { timeout: 5000, interval: 20 });
  return row;
}

describe('automatic AI rubric suggestions', () => {
  it('generates a private draft without grading or returning the submission', async () => {
    const requests = [];
    setAiTransport(scoringTransport({ onRequest: (request) => requests.push(request) }));
    const { teacher, cls, students } = await classroom(1);
    const { assignment, rubric } = await makeAssignment(teacher, cls, { categoryId: await getCategoryId(cls.id) });

    const submitted = await students[0].put(`/api/assignments/${assignment.id}/submission`, {
      textContent: '<p>Water evaporates, forms clouds by condensation, and falls as rain. The rain feeds a nearby river.</p>',
      submit: true,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.submission).not.toHaveProperty('aiGrading');

    const row = await waitForGrading(submitted.body.data.submission.id, 'COMPLETED');
    expect(row.aiRubricSuggestions.rubricId).toBeTruthy();
    expect(row.aiRubricSuggestions).toMatchObject({
      scores: {
        [rubric.criteria[0].id]: { points: 6, comment: 'Evidence for Accuracy.' },
        [rubric.criteria[1].id]: { points: 3, comment: 'Evidence for Evidence.' },
      },
    });
    expect(row.aiGradingModel).toBe('test-rubric-model');
    expect(row).toMatchObject({ status: 'SUBMITTED', rawScore: null, finalScore: null, rubricScores: null, returnedAt: null });
    expect(requests).toHaveLength(1);
    expect(requests[0].task.kind).toBe('rubric-grading');
    expect(requests[0].task.input.studentResponse).toContain('forms clouds');

    const teacherView = await teacher.get(`/api/assignments/${assignment.id}/submissions/${students[0].user.id}`);
    expect(teacherView.body.data.submission.aiGrading).toMatchObject({ status: 'COMPLETED', suggestions: row.aiRubricSuggestions });
    const studentView = await students[0].get(`/api/assignments/${assignment.id}`);
    expect(studentView.body.data.submission).not.toHaveProperty('aiGrading');
    expect(studentView.body.data.submission).toMatchObject({ status: 'SUBMITTED', rawScore: null, finalScore: null, rubricScores: null });
    expect(await prisma.aIGenerationUsage.count({ where: { userId: teacher.user.id, requestType: 'RUBRIC_GRADING' } })).toBe(1);

    // The teacher explicitly saves the suggested scores. Saving leaves the grade private.
    const saved = await teacher.put(`/api/assignments/${assignment.id}/submissions/${students[0].user.id}/grade`, {
      rubricScores: row.aiRubricSuggestions.scores,
      feedback: '<p>Reviewed: good explanation.</p>',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ status: 'GRADED', rawScore: 9, finalScore: 9 });
    const gradeItem = await prisma.gradeItem.findUnique({ where: { assignmentId: assignment.id } });
    const gradeEntry = () => prisma.gradeEntry.findUnique({
      where: { gradeItemId_studentId: { gradeItemId: gradeItem.id, studentId: students[0].user.id } },
    });
    expect(await gradeEntry()).toMatchObject({ score: 9, status: 'GRADED' });
    expect((await students[0].get(`/api/assignments/${assignment.id}`)).body.data.submission).toMatchObject({ status: 'SUBMITTED', rawScore: null, finalScore: null });

    // Only the teacher's separate return action releases the grade.
    expect((await teacher.post(`/api/assignments/${assignment.id}/return`, { studentIds: [students[0].user.id] })).body.data).toEqual({ returned: 1 });
    expect((await students[0].get(`/api/assignments/${assignment.id}`)).body.data.submission).toMatchObject({ status: 'RETURNED', rawScore: 9, finalScore: 9 });

    // A reopened resubmission gets its own suggestion and does not retain the old official grade.
    await teacher.post(`/api/assignments/${assignment.id}/submissions/${students[0].user.id}/reopen`, { until: new Date(Date.now() + 60_000).toISOString() });
    const resubmitted = await students[0].put(`/api/assignments/${assignment.id}/submission`, { textContent: 'A revised answer with more evidence.', submit: true });
    expect(resubmitted.status).toBe(200);
    const revised = await waitForGrading(resubmitted.body.data.submission.id, 'COMPLETED');
    expect(revised).toMatchObject({ attemptNumber: 2, status: 'SUBMITTED', rawScore: null, finalScore: null, rubricScores: null });
    expect(await gradeEntry()).toMatchObject({ score: null, status: 'UNGRADED' });
    expect(requests).toHaveLength(2);
  });

  it('records AI failures privately and lets a teacher retry', async () => {
    let calls = 0;
    setAiTransport(async ({ task }) => {
      calls += 1;
      const result = calls === 1
        ? { scores: [], feedback: '' }
        : {
            scores: task.input.rubric.criteria.map((criterion) => ({ criterionId: criterion.id, points: 1, comment: 'Some evidence.' })),
            feedback: 'Review the details.',
          };
      return { content: JSON.stringify(result), model: 'retry-model', promptTokens: 70, completionTokens: 30 };
    });
    const { teacher, cls, students } = await classroom(1);
    const { assignment } = await makeAssignment(teacher, cls);
    const submitted = await students[0].put(`/api/assignments/${assignment.id}/submission`, { textContent: 'A typed response with a relevant example.', submit: true });
    const failed = await waitForGrading(submitted.body.data.submission.id, 'FAILED');
    expect(failed.aiGradingError).toMatch(/every rubric criterion/i);
    expect(failed.rawScore).toBeNull();

    const privateView = await teacher.get(`/api/assignments/${assignment.id}/submissions/${students[0].user.id}`);
    expect(privateView.body.data.submission.aiGrading).toMatchObject({ status: 'FAILED', error: failed.aiGradingError });
    const studentView = await students[0].get(`/api/assignments/${assignment.id}`);
    expect(JSON.stringify(studentView.body.data)).not.toContain('aiGrading');
    expect(JSON.stringify(studentView.body.data)).not.toContain('Some evidence.');

    const retry = await teacher.post(`/api/assignments/${assignment.id}/submissions/${students[0].user.id}/ai-grading/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.data.aiGrading.status).toBe('PENDING');
    const completed = await waitForGrading(submitted.body.data.submission.id, 'COMPLETED');
    expect(completed.aiRubricSuggestions.feedback).toBe('Review the details.');
    expect(calls).toBe(2);
    expect(completed.rawScore).toBeNull();
  });

  it('does not call AI for an assignment without a rubric', async () => {
    let calls = 0;
    setAiTransport(async () => {
      calls += 1;
      throw new Error('AI must not be called');
    });
    const { teacher, cls, students } = await classroom(1);
    const assignment = await teacher.post(`/api/classes/${cls.id}/assignments`, {
      title: 'Untyped rubric check', instructionsHtml: 'Answer the question.', status: 'PUBLISHED',
    });
    const submitted = await students[0].put(`/api/assignments/${assignment.body.data.id}/submission`, { textContent: 'My response.', submit: true });
    expect(submitted.status).toBe(200);
    expect(await prisma.assignmentSubmission.findUnique({ where: { id: submitted.body.data.submission.id }, select: { aiGradingStatus: true } })).toEqual({ aiGradingStatus: null });
    expect(calls).toBe(0);
  });
});
