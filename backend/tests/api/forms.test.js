// What the web app's forms send.
//
// The other test files call the API the way a careful programmer would: a field that does not
// apply is left out. The dialogs of the web app do not leave fields out — a date nobody filled in
// travels as `null`. For a long time the API stored that as 1 January 1970: a module created with
// "Available until" empty was closed to students, and an assignment or a quiz could not be
// created without dates at all. These tests send what the dialogs send (the bodies below are
// copied from frontend/src/pages/classes/*Dialog.jsx, Modules.jsx, Gradebook.jsx and
// announcements/Feed.jsx) with only the required fields filled in.
import { beforeAll, describe, expect, it } from 'vitest';
import { categoryId, classroom, defaultScale, minutesFromNow, prepare } from '../helpers/index.js';
import { zDateTime, zOptionalDateTime } from '../../src/lib/http.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const iso = (minutes) => minutesFromNow(minutes).toISOString();

const moduleForm = (title, extra = {}) => ({ title, description: null, objectives: [], status: 'PUBLISHED', publishAt: null, availableUntil: null, prerequisiteModuleId: null, ...extra });
const assignmentForm = (title, extra = {}) => ({
  title, instructionsHtml: '', points: 100, status: 'PUBLISHED', publishAt: null, availableFrom: null, dueAt: null, closeAt: null,
  allowLate: true, latePenaltyType: 'NONE', latePenaltyValue: 0, latePenaltyMax: 100, allowText: true, allowFiles: true, maxFiles: 5, allowResubmission: true,
  rubricId: null, moduleId: null, categoryId: null, fileIds: [], ...extra,
});
const quizForm = (title, extra = {}) => ({
  title, instructionsHtml: '', kind: 'QUIZ', availableFrom: null, availableUntil: null, timeLimitMinutes: null, maxAttempts: 1, attemptScoring: 'HIGHEST',
  passingPercent: null, shuffleQuestions: false, shuffleChoices: false, resultVisibility: 'MANUAL', answerVisibility: 'SCORE_ONLY', moduleId: null, categoryId: null, ...extra,
});
const TRUE_FALSE = { type: 'TRUE_FALSE', text: '<p>The sun is a star.</p>', points: 1, answer: true };

describe('a date left empty in a form', () => {
  it('is no date: a module without "Available until" stays open to students', async () => {
    const { teacher, cls, students } = await classroom(1);
    const created = await teacher.post(`/api/classes/${cls.id}/modules`, moduleForm('Week 1'));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ title: 'Week 1', availableUntil: null });

    const seen = await students[0].get(`/api/classes/${cls.id}/modules`);
    expect(seen.body.data.map((m) => m.title)).toEqual(['Week 1']);

    // Editing sends the same shape. A closing date can be set, and cleared again with null.
    const closing = iso(60);
    const closed = await teacher.patch(`/api/modules/${created.body.data.id}`, moduleForm('Week 1', { availableUntil: closing }));
    expect(new Date(closed.body.data.availableUntil).toISOString()).toBe(closing);
    const reopened = await teacher.patch(`/api/modules/${created.body.data.id}`, moduleForm('Week 1'));
    expect(reopened.body.data.availableUntil).toBeNull();
  });

  it('is no date: an assignment without dates is created, open and never late', async () => {
    const { teacher, cls, students } = await classroom(1);
    const created = await teacher.post(`/api/classes/${cls.id}/assignments`, assignmentForm('Essay'));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ availableFrom: null, dueAt: null, closeAt: null });

    const handedIn = await students[0].put(`/api/assignments/${created.body.data.id}/submission`, { textContent: '<p>My essay.</p>', submit: true });
    expect(handedIn.status).toBe(200);
    expect(handedIn.body.data.submission).toMatchObject({ status: 'SUBMITTED', isLate: false });

    // Only a due date: the opening and closing dates stay empty and do not contradict it.
    const due = iso(60 * 24);
    const withDue = await teacher.patch(`/api/assignments/${created.body.data.id}`, assignmentForm('Essay', { dueAt: due }));
    expect(withDue.status).toBe(200);
    expect(withDue.body.data).toMatchObject({ availableFrom: null, closeAt: null });
    expect(new Date(withDue.body.data.dueAt).toISOString()).toBe(due);
    // …and the due date can be taken away again.
    const cleared = await teacher.patch(`/api/assignments/${created.body.data.id}`, assignmentForm('Essay'));
    expect(cleared.body.data.dueAt).toBeNull();
  });

  it('is no date: a quiz without opening and closing times is created and can be taken', async () => {
    const { teacher, cls, students } = await classroom(1);
    const created = await teacher.post(`/api/classes/${cls.id}/quizzes`, quizForm('Quiz 1'));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ availableFrom: null, availableUntil: null, timeLimitMinutes: null });
    const id = created.body.data.id;
    expect((await teacher.post(`/api/quizzes/${id}/questions`, { question: TRUE_FALSE })).status).toBe(201);

    // The settings dialog of an existing quiz adds the publication fields.
    const published = await teacher.patch(`/api/quizzes/${id}`, quizForm('Quiz 1', { status: 'PUBLISHED', publishAt: null }));
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'PUBLISHED', availableFrom: null, availableUntil: null });

    const attempt = await students[0].post(`/api/quizzes/${id}/attempts`, { acceptRules: true });
    expect([200, 201]).toContain(attempt.status);
  });

  it('is no date: a gradebook column and a linked assignment carry none', async () => {
    const { teacher, cls } = await classroom(1);
    const category = await categoryId(cls.id);
    const column = await teacher.post(`/api/classes/${cls.id}/gradebook/items`, { categoryId: category, title: 'Recitation 1', maxPoints: 100, dueAt: null });
    expect(column.status).toBe(201);
    expect(column.body.data.dueAt ?? null).toBeNull();

    const graded = await teacher.post(`/api/classes/${cls.id}/assignments`, assignmentForm('Counts toward the grade', { categoryId: category }));
    expect(graded.status).toBe(201);
    const gradebook = await teacher.get(`/api/classes/${cls.id}/gradebook`);
    const dates = JSON.stringify(gradebook.body.data).match(/"dueAt":"[^"]*"/g) ?? [];
    expect(dates).toEqual([]);
  });

  it('an announcement posted at once carries no publishing date', async () => {
    const { teacher, cls, students } = await classroom(1);
    const posted = await teacher.post('/api/announcements', {
      title: 'Welcome', contentHtml: '<p>Bring a notebook.</p>', priority: 'NORMAL', isPinned: false, allowComments: false, status: 'PUBLISHED', publishAt: null, fileIds: [],
      audience: 'CLASS', recipientIds: [], classId: cls.id,
    });
    expect(posted.status).toBe(201);
    expect(posted.body.data.publishAt ?? null).toBeNull();
    const feed = await students[0].get(`/api/announcements?classId=${cls.id}`);
    expect(feed.body.data.map((a) => a.title)).toContain('Welcome');
  });

  it('nothing in the answers mentions 1970', async () => {
    const { teacher, cls } = await classroom(1);
    const answers = [
      await teacher.post(`/api/classes/${cls.id}/modules`, moduleForm('M')),
      await teacher.post(`/api/classes/${cls.id}/assignments`, assignmentForm('A')),
      await teacher.post(`/api/classes/${cls.id}/quizzes`, quizForm('Q')),
    ];
    for (const res of answers) {
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain('1970-01-01');
    }
  });
});

describe('what counts as a date', () => {
  it('accepts ISO dates and times, with or without a time zone', () => {
    expect(zDateTime.parse('2026-11-12T10:00:00.000Z').toISOString()).toBe('2026-11-12T10:00:00.000Z');
    expect(zDateTime.parse('2026-11-12T10:00:00+08:00').toISOString()).toBe('2026-11-12T02:00:00.000Z');
    expect(zDateTime.parse(' 2026-11-12 ').toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(zDateTime.parse(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps "none" apart from "not sent"', () => {
    expect(zOptionalDateTime.parse(null)).toBeNull();
    expect(zOptionalDateTime.parse(undefined)).toBeUndefined();
  });

  it('refuses what is not a date instead of turning it into 1970', () => {
    for (const value of [0, false, true, 1794445482956, '', 'tomorrow', '5', '2026-13-45', {}, []]) {
      expect(zOptionalDateTime.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    // Where a date is required, "none" is not an answer either.
    expect(zDateTime.safeParse(null).success).toBe(false);
  });

  it('says which field is wrong', async () => {
    const { teacher, cls, students } = await classroom(1);
    const bad = await teacher.post(`/api/classes/${cls.id}/assignments`, assignmentForm('Essay', { dueAt: 'next Friday' }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields).toHaveProperty('dueAt');

    // Reopening an assignment for one student needs a real date.
    const created = await teacher.post(`/api/classes/${cls.id}/assignments`, assignmentForm('Essay'));
    const reopen = await teacher.post(`/api/assignments/${created.body.data.id}/submissions/${students[0].user.id}/reopen`, { until: null });
    expect(reopen.status).toBe(422);
    expect(reopen.body.error.details.fields).toHaveProperty('until');
  });
});
