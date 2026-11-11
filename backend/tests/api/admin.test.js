import { beforeAll, describe, expect, it } from 'vitest';
import { actor, anonymous, clearSetting, createUser, loginAs, prepare, prisma, uid } from '../helpers/index.js';

beforeAll(prepare);

describe('administrator-only areas', () => {
  it('are closed to teachers, students and visitors', async () => {
    const teacher = await actor('TEACHER');
    const student = await actor('STUDENT');
    const paths = ['/api/admin/users', '/api/admin/settings', '/api/admin/audit-logs', '/api/admin/permissions', '/api/admin/status', '/api/admin/students'];
    for (const path of paths) {
      expect((await teacher.get(path)).status, path).toBe(403);
      expect((await student.get(path)).status, path).toBe(403);
      expect((await anonymous().get(path)).status, path).toBe(401);
    }
    expect((await teacher.post('/api/admin/users', { role: 'ADMIN', firstName: 'x', lastName: 'y', email: 'x@y.co' })).status).toBe(403);
    expect((await student.post('/api/catalog/departments', { code: 'X', name: 'X' })).status).toBe(403);
    expect((await teacher.patch('/api/admin/settings', { values: { 'institution.name': 'Mine now' } })).status).toBe(403);
  });
});

describe('institution structure', () => {
  it('supports the full department → program → section → course life-cycle', async () => {
    const admin = await actor('ADMIN');
    const code = uid('D').toUpperCase();
    const dept = await admin.post('/api/catalog/departments', { code, name: `College of ${code}` });
    expect(dept.status).toBe(201);
    const dupe = await admin.post('/api/catalog/departments', { code: code.toLowerCase(), name: 'Other' });
    expect(dupe.status).toBe(422);
    expect(dupe.body.error.details.fields.code).toBeTruthy();

    const program = await admin.post('/api/catalog/programs', { code: uid('BS').toUpperCase(), name: 'BS Information Technology', departmentId: dept.body.data.id, durationYears: 4 });
    expect(program.status).toBe(201);
    const section = await admin.post('/api/catalog/sections', { name: uid('BSIT-2A'), programId: program.body.data.id, yearLevel: 2 });
    expect(section.status).toBe(201);
    const course = await admin.post('/api/catalog/courses', { code: uid('IT').toUpperCase(), title: 'Data Structures', units: 3, departmentId: dept.body.data.id });
    expect(course.status).toBe(201);

    const renamed = await admin.patch(`/api/catalog/courses/${course.body.data.id}`, { title: 'Data Structures and Algorithms' });
    expect(renamed.body.data.title).toBe('Data Structures and Algorithms');

    // A department that still has programs cannot be deleted.
    const blocked = await admin.delete(`/api/catalog/departments/${dept.body.data.id}`);
    expect(blocked.status).toBe(409);
    expect((await admin.delete(`/api/catalog/sections/${section.body.data.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/catalog/programs/${program.body.data.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/catalog/courses/${course.body.data.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/catalog/departments/${dept.body.data.id}`)).status).toBe(204);
  });

  it('validates academic years and keeps a single current semester', async () => {
    const admin = await actor('ADMIN');
    const bad = await admin.post('/api/catalog/academic-years', { name: uid('AY'), startDate: '2027-06-01', endDate: '2027-01-01' });
    expect(bad.status).toBe(422);
    const year = await admin.post('/api/catalog/academic-years', { name: uid('AY'), startDate: '2026-06-01', endDate: '2027-05-31' });
    expect(year.status).toBe(201);
    const outside = await admin.post('/api/catalog/semesters', { academicYearId: year.body.data.id, name: 'Summer', startDate: '2028-01-01', endDate: '2028-02-01' });
    expect(outside.status).toBe(422);
    const s1 = await admin.post('/api/catalog/semesters', { academicYearId: year.body.data.id, name: 'First Semester', startDate: '2026-08-01', endDate: '2026-12-20', isCurrent: true });
    const s2 = await admin.post('/api/catalog/semesters', { academicYearId: year.body.data.id, name: 'Second Semester', startDate: '2027-01-10', endDate: '2027-05-20', isCurrent: true });
    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);
    expect(await prisma.semester.count({ where: { isCurrent: true } })).toBe(1);
    expect((await prisma.semester.findUnique({ where: { id: s2.body.data.id } })).isCurrent).toBe(true);
  });

  it('lets teachers and students read the lists they need for forms', async () => {
    const teacher = await actor('TEACHER');
    expect((await teacher.get('/api/catalog/courses')).status).toBe(200);
    expect((await teacher.get('/api/catalog/semesters')).status).toBe(200);
  });
});

describe('grading scales', () => {
  const entries = [
    { minPercent: 96, label: '1.00', remark: 'Excellent', isPassing: true },
    { minPercent: 75, label: '3.00', remark: 'Passed', isPassing: true },
    { minPercent: 0, label: '5.00', remark: 'Failed', isPassing: false },
  ];

  it('are configurable per institution', async () => {
    const admin = await actor('ADMIN');
    const res = await admin.post('/api/catalog/grading-scales', { name: uid('Scale'), entries });
    expect(res.status).toBe(201);
    expect(res.body.data.entries.map((e) => e.label)).toEqual(['1.00', '3.00', '5.00']);
    const noFloor = await admin.post('/api/catalog/grading-scales', { name: uid('Scale'), entries: entries.slice(0, 2) });
    expect(noFloor.status).toBe(422);
    const duplicateBand = await admin.post('/api/catalog/grading-scales', { name: uid('Scale'), entries: [...entries, { minPercent: 75, label: '2.75', isPassing: true }] });
    expect(duplicateBand.status).toBe(422);
  });
});

describe('user management', () => {
  it('creates an account with a one-time temporary password that must be changed', async () => {
    const admin = await actor('ADMIN');
    const email = `${uid('prof')}@test.edu`;
    const res = await admin.post('/api/admin/users', { role: 'TEACHER', firstName: 'Jose', lastName: 'Rizal', email, employeeNumber: uid('EMP') });
    expect(res.status).toBe(201);
    const temp = res.body.data.temporaryPassword;
    expect(temp).toBeTruthy();
    expect(JSON.stringify(res.body.data.user)).not.toContain('passwordHash');
    const login = await anonymous().post('/api/auth/login').send({ email, password: temp });
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
    const dupe = await admin.post('/api/admin/users', { role: 'TEACHER', firstName: 'J', lastName: 'R', email });
    expect(dupe.status).toBe(422);
  });

  it('blocks everything except the password change until a temporary password is replaced', async () => {
    const admin = await actor('ADMIN');
    const email = `${uid('temp')}@test.edu`;
    const made = await admin.post('/api/admin/users', { role: 'STUDENT', firstName: 'Tina', lastName: 'Temp', email, studentNumber: uid('SN') });
    const session = await loginAs({ email }, made.body.data.temporaryPassword);
    const blocked = await session.get('/api/classes');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await session.post('/api/auth/change-password', { currentPassword: made.body.data.temporaryPassword, newPassword: 'My-Own-Secret-77' });
    expect(changed.status).toBe(200);
    expect((await session.get('/api/classes')).status).toBe(200);
  });

  it('imports many accounts and reports each row', async () => {
    const admin = await actor('ADMIN');
    const good = `${uid('imp')}@test.edu`;
    const res = await admin.post('/api/admin/users/import', {
      rows: [
        { role: 'STUDENT', firstName: 'Liza', lastName: 'Reyes', email: good, studentNumber: uid('SN') },
        { role: 'STUDENT', firstName: 'No', lastName: 'Number', email: `${uid('imp')}@test.edu` },
        { role: 'STUDENT', firstName: 'Bad', lastName: 'Mail', email: 'nope', studentNumber: uid('SN') },
        { role: 'STUDENT', firstName: 'Dupe', lastName: 'Mail', email: good, studentNumber: uid('SN') },
        { role: 'TEACHER', firstName: 'Unknown', lastName: 'Dept', email: `${uid('imp')}@test.edu`, departmentCode: 'NOPE-NOPE' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 1, failed: 4 });
    expect(res.body.data.results.map((r) => r.ok)).toEqual([true, false, false, false, false]);
    expect(res.body.data.results[0].temporaryPassword).toBeTruthy();
  });

  it('cannot create administrators through import', async () => {
    const admin = await actor('ADMIN');
    const res = await admin.post('/api/admin/users/import', { rows: [{ role: 'ADMIN', firstName: 'A', lastName: 'B', email: `${uid('x')}@test.edu` }] });
    expect(res.status).toBe(422);
  });

  it('suspends with a reason, reactivates, and records both in the audit log', async () => {
    const admin = await actor('ADMIN');
    const user = await createUser('STUDENT');
    const noReason = await admin.post(`/api/admin/users/${user.id}/suspend`, {});
    expect(noReason.status).toBe(422);
    expect((await admin.post(`/api/admin/users/${user.id}/suspend`, { reason: 'Unsettled disciplinary case' })).status).toBe(200);
    const blocked = await anonymous().post('/api/auth/login').send({ email: user.email, password: 'Correct-Horse-42' });
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await admin.post(`/api/admin/users/${user.id}/reactivate`)).status).toBe(200);
    expect((await anonymous().post('/api/auth/login').send({ email: user.email, password: 'Correct-Horse-42' })).status).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: user.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.suspend', 'user.reactivate']));
  });

  it('protects administrators from locking themselves out', async () => {
    const admin = await actor('ADMIN');
    const self = await admin.post(`/api/admin/users/${admin.user.id}/suspend`, { reason: 'Testing the guard rails' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_ACTION');
    expect((await admin.post(`/api/admin/users/${admin.user.id}/deactivate`)).status).toBe(403);
    expect((await admin.patch(`/api/admin/users/${admin.user.id}`, { role: 'STUDENT' })).body.data?.role ?? 'ADMIN').toBe('ADMIN');
  });

  it('approves pending teacher registrations', async () => {
    const admin = await actor('ADMIN');
    const pending = await createUser('TEACHER', { status: 'PENDING' });
    expect((await admin.post(`/api/admin/users/${pending.id}/approve`)).status).toBe(200);
    expect((await anonymous().post('/api/auth/login').send({ email: pending.email, password: 'Correct-Horse-42' })).status).toBe(200);
  });

  it('issues a password reset that invalidates the old password and sessions', async () => {
    const admin = await actor('ADMIN');
    const user = await createUser('TEACHER');
    const session = await loginAs(user);
    const res = await admin.post(`/api/admin/users/${user.id}/reset-password`);
    expect(res.status).toBe(200);
    expect(res.body.data.temporaryPassword).toBeTruthy();
    expect((await session.get('/api/auth/session')).status).toBe(401);
    expect((await anonymous().post('/api/auth/login').send({ email: user.email, password: 'Correct-Horse-42' })).status).toBe(401);
    expect((await anonymous().post('/api/auth/login').send({ email: user.email, password: res.body.data.temporaryPassword })).status).toBe(200);
  });

  it('searches and filters the user list', async () => {
    const admin = await actor('ADMIN');
    const needle = uid('Zyxw');
    await createUser('STUDENT', { lastName: needle });
    await createUser('TEACHER', { lastName: needle });
    const all = await admin.get(`/api/admin/users?search=${needle}`);
    expect(all.body.meta.total).toBe(2);
    const teachers = await admin.get(`/api/admin/users?search=${needle}&role=TEACHER`);
    expect(teachers.body.data).toHaveLength(1);
    expect(teachers.body.data[0].role).toBe('TEACHER');
  });
});

describe('system settings', () => {
  it('validates values and applies them', async () => {
    const admin = await actor('ADMIN');
    try {
      const bad = await admin.patch('/api/admin/settings', { values: { 'institution.timezone': 'Mars/Olympus', 'attendance.maxAccuracyMeters': -5, 'not.a.setting': 1 } });
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.body.error.details.fields).sort()).toEqual(['attendance.maxAccuracyMeters', 'institution.timezone', 'not.a.setting']);

      const res = await admin.patch('/api/admin/settings', { values: { 'institution.name': 'Pampanga State University', 'attendance.defaultRadiusMeters': 75 } });
      expect(res.status).toBe(200);
      expect((await anonymous().get('/api/auth/config')).body.data.institutionName).toBe('Pampanga State University');
      expect(await prisma.auditLog.count({ where: { action: 'settings.update', actorId: admin.user.id } })).toBe(1);

      // The radius limits must stay consistent with each other.
      const inconsistent = await admin.patch('/api/admin/settings', { values: { 'attendance.minRadiusMeters': 500 } });
      expect(inconsistent.status).toBe(422);
    } finally {
      await clearSetting('institution.name');
      await clearSetting('attendance.defaultRadiusMeters');
    }
  });
});

describe('audit log', () => {
  it('can be filtered and exported, and cannot be modified through the API', async () => {
    const admin = await actor('ADMIN');
    const user = await createUser('STUDENT');
    await admin.post(`/api/admin/users/${user.id}/suspend`, { reason: 'Audit trail test reason' });
    const res = await admin.get(`/api/admin/audit-logs?action=user.suspend&actorId=${admin.user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ action: 'user.suspend', entityId: user.id });
    const csv = await admin.get('/api/admin/audit-logs/export?action=user.suspend');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('user.suspend');
    expect((await admin.delete(`/api/admin/audit-logs/${res.body.data[0].id}`)).status).toBe(404);
  });
});
