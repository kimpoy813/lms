import { beforeAll, describe, expect, it } from 'vitest';
import { classroom, createClass, defaultScale, enroll, prepare, prisma } from '../helpers/index.js';

beforeAll(async () => {
  await prepare();
  await defaultScale();
});

const gb = (cls) => `/api/classes/${cls.id}/gradebook`;

async function setupBookWithTwoPeriods(studentCount = 3) {
  const room = await classroom(studentCount);
  const res = await room.teacher.put(`${gb(room.cls)}/structure`, {
    periods: [
      { name: 'Midterm', weight: 50, categories: [{ name: 'Exam', kind: 'EXAM', weight: 100 }] },
      { name: 'Final', weight: 50, categories: [{ name: 'Exam', kind: 'EXAM', weight: 100 }] },
    ],
  });
  expect(res.status).toBe(200);
  const [midterm, finalPeriod] = res.body.data.structure.periods;
  const midtermExam = (await room.teacher.post(`${gb(room.cls)}/items`, {
    categoryId: midterm.categories[0].id,
    title: 'Midterm Exam',
    maxPoints: 100,
  })).body.data;
  const finalExam = (await room.teacher.post(`${gb(room.cls)}/items`, {
    categoryId: finalPeriod.categories[0].id,
    title: 'Final Exam',
    maxPoints: 100,
  })).body.data;

  const setScore = (studentIndex, itemId, score) =>
    room.teacher.put(`${gb(room.cls)}/entries`, {
      entries: [{ itemId, studentId: room.students[studentIndex].user.id, status: 'GRADED', score }],
    });

  return { ...room, midterm, finalPeriod, midtermExam, finalExam, setScore };
}

describe('teacher-controlled anonymous grade-release ranking', () => {
  it('is disabled by default and blocks student access until enabled and grades are released', async () => {
    const { teacher, cls, students, midterm, midtermExam, setScore } = await setupBookWithTwoPeriods(2);
    await setScore(0, midtermExam.id, 95);
    await setScore(1, midtermExam.id, 88);

    // Off by default even after publishing grades
    await teacher.post(`${gb(cls)}/periods/${midterm.id}/publish`, {});
    const mineOff = (await students[0].get(`${gb(cls)}/mine`)).body.data;
    expect(mineOff.ranking).toBeNull();
    expect((await students[0].get(`${gb(cls)}/ranking`)).status).toBe(403);
    expect((await students[0].post(`${gb(cls)}/ranking-code/regenerate`, {})).status).toBe(403);
    expect((await students[0].put(`${gb(cls)}/ranking-code`, { code: 'PHOENIX42' })).status).toBe(403);

    // Teacher can always preview ranking even while off for students, without exposing codes in named entries
    const teacherPreview = (await teacher.get(`${gb(cls)}/ranking`)).body.data;
    expect(teacherPreview.enabled).toBe(false);
    expect(teacherPreview.namedEntries.every((e) => !('code' in e))).toBe(true);
    expect(teacherPreview.anonymousEntries.every((e) => !('name' in e) && !('studentId' in e) && !('studentNumber' in e))).toBe(true);
  });

  it('enforces release gating, hides peer identities, uses competition ranking, and keeps ties ordered strictly by code', async () => {
    const { teacher, cls, students, midterm, finalPeriod, midtermExam, finalExam, setScore } = await setupBookWithTwoPeriods(4);
    // Give students 0 & 1 exact tied score (92), student 2 higher (97), student 3 ungraded
    await setScore(0, midtermExam.id, 92);
    await setScore(1, midtermExam.id, 92);
    await setScore(2, midtermExam.id, 97);
    await setScore(0, finalExam.id, 80);

    // Teacher turns ranking on BEFORE publishing any period
    const toggleRes = await teacher.patch(`${gb(cls)}/ranking-settings`, { gradeRankingEnabled: true });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.data.gradeRankingEnabled).toBe(true);

    // Student sees their private code ready, but no peer standings until a period is released
    const preRelease = (await students[0].get(`${gb(cls)}/mine`)).body.data.ranking;
    expect(preRelease.enabled).toBe(true);
    expect(preRelease.released).toBe(false);
    expect(preRelease.myCode).toMatch(/^[A-Z0-9]{6,16}$/);
    expect(preRelease.entries).toEqual([]);
    expect((await students[0].get(`${gb(cls)}/ranking?scope=${midterm.id}`)).status).toBe(403);

    // Publish Midterm -> Midterm ranking appears, Final & Overall stay hidden
    await teacher.post(`${gb(cls)}/periods/${midterm.id}/publish`, {});
    const midRank0 = (await students[0].get(`${gb(cls)}/mine`)).body.data.ranking;
    const midRank1 = (await students[1].get(`${gb(cls)}/mine`)).body.data.ranking;
    const midRank2 = (await students[2].get(`${gb(cls)}/mine`)).body.data.ranking;
    const midRank3 = (await students[3].get(`${gb(cls)}/mine`)).body.data.ranking;

    expect(midRank0.released).toBe(true);
    expect(midRank0.activeScope).toBe(midterm.id);
    expect(midRank0.totalStudents).toBe(4);
    expect(midRank0.totalRanked).toBe(3);
    expect(midRank0.unrankedCount).toBe(1);

    // Ranks: student 2 is #1 (97%), students 0 & 1 tie at #2 (92%)
    expect(midRank2.myRank).toBe(1);
    expect(midRank0.myRank).toBe(2);
    expect(midRank1.myRank).toBe(2);
    expect(midRank3.myRank).toBeNull();

    // Ties are ordered strictly by secret code (lexicographically)
    const tiedCodes = midRank0.entries.filter((e) => e.rank === 2).map((e) => e.code);
    expect(tiedCodes).toHaveLength(2);
    expect(tiedCodes).toEqual([...tiedCodes].sort());

    // Strict identity protection: NO peer IDs, names, emails, or student numbers anywhere in the payload
    const rawJson = JSON.stringify(midRank0);
    for (const s of students) {
      expect(rawJson).not.toContain(s.user.id);
      expect(rawJson).not.toContain(s.user.lastName);
      expect(rawJson).not.toContain(s.user.email);
    }
    expect(midRank0.entries.filter((e) => e.isSelf).map((e) => e.code)).toEqual([midRank0.myCode]);
    expect(midRank0.entries.every((e) => !('studentId' in e) && !('name' in e) && !('studentNumber' in e))).toBe(true);

    // Requesting unpublished Final or Overall scope is still forbidden
    expect((await students[0].get(`${gb(cls)}/ranking?scope=${finalPeriod.id}`)).status).toBe(403);
    expect((await students[0].get(`${gb(cls)}/ranking?scope=OVERALL`)).status).toBe(403);

    // Turning off showScores hides peer grades and class stats, while keeping ranks, codes, and student's own grade
    await teacher.patch(`${gb(cls)}/ranking-settings`, { gradeRankingShowScores: false });
    const codesOnly = (await students[0].get(`${gb(cls)}/ranking`)).body.data;
    expect(codesOnly.showScores).toBe(false);
    expect(codesOnly.myPercent).toBe(92);
    expect(codesOnly.stats).toEqual({ topPercent: null, averagePercent: null });
    expect(codesOnly.entries[0]).not.toHaveProperty('percent');
    expect(codesOnly.entries[0]).not.toHaveProperty('label');

    // Unpublishing the period hides rankings again
    await teacher.post(`${gb(cls)}/periods/${midterm.id}/unpublish`, {});
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.ranking.released).toBe(false);
  });

  it('lets teachers toggle ranking directly during publish/finalize and even after grades are locked or finalized', async () => {
    const { teacher, cls, students, midterm, finalPeriod, midtermExam, finalExam, setScore } = await setupBookWithTwoPeriods(2);
    await setScore(0, midtermExam.id, 95);
    await setScore(1, midtermExam.id, 85);
    await setScore(0, finalExam.id, 93);
    await setScore(1, finalExam.id, 89);

    // Publish with gradeRankingEnabled inline
    const pub = await teacher.post(`${gb(cls)}/periods/${midterm.id}/publish`, { gradeRankingEnabled: true, gradeRankingShowScores: true });
    expect(pub.status).toBe(200);
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.ranking.released).toBe(true);

    // Lock period -> teacher can STILL toggle ranking off/on even when locked!
    await teacher.post(`${gb(cls)}/periods/${midterm.id}/lock`, {});
    expect((await teacher.patch(`${gb(cls)}/ranking-settings`, { gradeRankingEnabled: false })).status).toBe(200);
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.ranking).toBeNull();

    // Finalize with ranking enabled inline
    const fin = await teacher.post(`${gb(cls)}/finalize`, { confirmIncomplete: false, gradeRankingEnabled: true });
    expect(fin.status).toBe(200);
    expect(fin.body.data.class.gradeRankingEnabled).toBe(true);

    const mineFinal = (await students[0].get(`${gb(cls)}/mine`)).body.data;
    expect(mineFinal.ranking).toMatchObject({
      released: true,
      activeScope: 'OVERALL',
      myRank: 1,
      totalRanked: 2,
    });
    expect(mineFinal.ranking.scopes.map((s) => s.scope)).toContain(finalPeriod.id);

    // Across classes overview (/api/grades/mine) shows student's own rank summary
    const allGrades = (await students[0].get('/api/grades/mine')).body.data;
    expect(allGrades.find((c) => c.classId === cls.id).ranking).toEqual({
      scopeName: 'Overall grade',
      rank: 1,
      totalRanked: 2,
    });

    // Even after finalization, teacher can turn ranking off and back on without reopening grades
    expect((await teacher.patch(`${gb(cls)}/ranking-settings`, { gradeRankingEnabled: false })).status).toBe(200);
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.ranking).toBeNull();
    expect((await teacher.patch(`${gb(cls)}/ranking-settings`, { gradeRankingEnabled: true })).status).toBe(200);
    expect((await students[0].get(`${gb(cls)}/mine`)).body.data.ranking.myRank).toBe(1);
  });

  it('gives each student distinct unlinkable codes per class, supports regeneration & custom codes, and never logs codes in audit logs', async () => {
    const { teacher, cls: classA, students, midterm, midtermExam, setScore } = await setupBookWithTwoPeriods(2);
    await setScore(0, midtermExam.id, 90);
    await setScore(1, midtermExam.id, 80);
    await teacher.post(`${gb(classA)}/periods/${midterm.id}/publish`, { gradeRankingEnabled: true });

    // Enroll student 0 in a second class (class B) with ranking enabled
    const classB = await createClass(teacher.user, { gradeRankingEnabled: true });
    await enroll(classB, students[0].user);

    const codeA = (await students[0].get(`${gb(classA)}/mine`)).body.data.ranking.myCode;
    const codeB = (await students[0].get(`${gb(classB)}/mine`)).body.data.ranking.myCode;
    expect(codeA).not.toBe(codeB);

    // Regenerate random code
    const regen = await students[0].post(`${gb(classA)}/ranking-code/regenerate`, {});
    expect(regen.status).toBe(200);
    const newCode = regen.body.data.code;
    expect(newCode).not.toBe(codeA);
    expect((await students[0].get(`${gb(classA)}/ranking`)).body.data.myCode).toBe(newCode);

    // Reject self-identifying custom codes (name, email, student number)
    const badName = await students[0].put(`${gb(classA)}/ranking-code`, { code: `${students[0].user.lastName}99` });
    expect(badName.status).toBe(422);
    const badSn = await students[0].put(`${gb(classA)}/ranking-code`, { code: `SN${students[0].user.lastName}` });
    expect(badSn.status).toBe(422);

    // Prevent collisions with another student's code in the same class
    const peerCode = (await students[1].get(`${gb(classA)}/mine`)).body.data.ranking.myCode;
    const collide = await students[0].put(`${gb(classA)}/ranking-code`, { code: peerCode });
    expect(collide.status).toBe(409);
    expect(collide.body.error.code).toBe('CODE_IN_USE');

    // Accept valid anonymous custom code and ensure audit logs do NOT record the secret code
    const custom = await students[0].put(`${gb(classA)}/ranking-code`, { code: 'phoenix-77' });
    expect(custom.status).toBe(200);
    expect(custom.body.data.code).toBe('PHOENIX77');
    expect((await students[0].get(`${gb(classA)}/ranking`)).body.data.myCode).toBe('PHOENIX77');

    const logs = await prisma.auditLog.findMany({ where: { classId: classA.id, action: { startsWith: 'gradebook.ranking_code' } } });
    expect(logs.length).toBe(2);
    expect(JSON.stringify(logs)).not.toContain('PHOENIX77');
    expect(JSON.stringify(logs)).not.toContain(newCode);
  });

  it('exports anonymous coded CSV/PDF/XLSX without student names and preserves toggle on class rollover', async () => {
    const { teacher, cls, students, midterm, midtermExam, setScore } = await setupBookWithTwoPeriods(2);
    await setScore(0, midtermExam.id, 96);
    await setScore(1, midtermExam.id, 84);
    await teacher.post(`${gb(cls)}/periods/${midterm.id}/publish`, { gradeRankingEnabled: true, gradeRankingShowScores: true });

    // Anonymous CSV contains codes and ranks, NEVER student names or student numbers
    const csvRes = await teacher.get(`${gb(cls)}/ranking/export?format=csv&anonymous=true`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain('Rank,Student Code,Grade %,Grade,Remark');
    for (const s of students) {
      expect(csvRes.text).not.toContain(s.user.lastName);
      expect(csvRes.text).not.toContain(s.user.firstName);
    }

    // Named honor roll contains names, NEVER secret codes
    const myCode = (await students[0].get(`${gb(cls)}/mine`)).body.data.ranking.myCode;
    const namedCsv = await teacher.get(`${gb(cls)}/ranking/export?format=csv&anonymous=false`);
    expect(namedCsv.status).toBe(200);
    expect(namedCsv.text).toContain('Rank,Student No.,Name,Grade %,Grade,Remark');
    expect(namedCsv.text).not.toContain(myCode);

    // Anonymous PDF & XLSX exports succeed
    const pdfRes = await teacher.get(`${gb(cls)}/ranking/export?format=pdf&anonymous=true`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    const xlsxRes = await teacher.get(`${gb(cls)}/ranking/export?format=xlsx&anonymous=true`);
    expect(xlsxRes.status).toBe(200);

    // Students cannot export teacher ranking reports
    expect((await students[0].get(`${gb(cls)}/ranking/export?format=csv`)).status).toBe(403);

    // Rollover carries over gradeRankingEnabled & gradeRankingShowScores without copying enrollments or codes
    const ay = await prisma.academicYear.create({
      data: { name: `AY-RANK-${Date.now()}`, startDate: new Date('2028-08-01'), endDate: new Date('2029-05-31') },
    });
    const nextSem = await prisma.semester.create({
      data: { academicYearId: ay.id, name: 'Second Semester', startDate: new Date('2028-11-01'), endDate: new Date('2029-03-31'), isCurrent: false },
    });
    const copied = await teacher.post(`/api/classes/${cls.id}/copy`, { semesterId: nextSem.id });
    expect(copied.status).toBe(201);
    expect(copied.body.data.gradeRankingEnabled).toBe(true);
    expect(copied.body.data.gradeRankingShowScores).toBe(true);
    expect(copied.body.data.studentCount).toBe(0);
  });
});
