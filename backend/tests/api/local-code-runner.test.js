// Local development code runner (CODE_RUNNER_PROVIDER=local) tested end-to-end through the API.
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CODE_RUNNER_PROVIDER = 'local';
});

const { actor, classroom, prepare } = await import('../helpers/index.js');

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const hasPython = has('python3');
const hasGcc = has('gcc');
const hasGpp = has('g++');

beforeAll(async () => {
  await prepare();
});

describe('local dev code runner (CODE_RUNNER_PROVIDER=local)', () => {
  it('announces itself cleanly as local in programming & admin status', async () => {
    const admin = await actor('ADMIN');
    const { students } = await classroom(1);

    expect((await students[0].get('/api/programming/status')).body.data).toMatchObject({
      configured: true,
      provider: 'local',
    });
    expect((await admin.get('/api/admin/status')).body.data.codeRunner).toMatchObject({
      configured: true,
      provider: 'local',
    });
  });

  it('runs a real Python, JavaScript, and C/C++ submission in child processes', async () => {
    const allowed = ['JAVASCRIPT'];
    if (hasPython) allowed.push('PYTHON');
    if (hasGcc) allowed.push('C');
    if (hasGpp) allowed.push('CPP');

    const { teacher, cls, students } = await classroom(1);
    const created = await teacher.post('/api/programming/problems', {
      classId: cls.id,
      title: 'Triple input',
      statementHtml: '<p>Read an integer and print 3x.</p>',
      allowedLanguages: allowed,
      timeLimitMs: 1500,
      memoryLimitKb: 131072,
      testCases: [
        { input: '4\n', expectedOutput: '12' },
        { input: '7\n', expectedOutput: '21', isHidden: true },
      ],
    });
    expect(created.status).toBe(201);
    const problemId = created.body.data.id;

    // JavaScript runs with Node.js (always available since tests run on Node)
    const jsRun = await students[0].post(`/api/programming/problems/${problemId}/submit`, {
      language: 'JAVASCRIPT',
      code: "const fs = require('fs'); console.log(Number(fs.readFileSync(0, 'utf8').trim()) * 3);",
    });
    expect(jsRun.status).toBe(201);
    expect(jsRun.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 2, totalCount: 2, scorePercent: 100 });
    expect(jsRun.body.data.results[1]).toEqual({ position: 1, isHidden: true, passed: true, outcome: 'PASSED' });

    if (hasPython) {
      const pyOk = await students[0].post(`/api/programming/problems/${problemId}/submit`, {
        language: 'PYTHON',
        code: 'print(int(input()) * 3)',
      });
      expect(pyOk.status).toBe(201);
      expect(pyOk.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 2, totalCount: 2, scorePercent: 100 });

      const pyErr = await students[0].post(`/api/programming/problems/${problemId}/submit`, {
        language: 'PYTHON',
        code: 'print("unclosed"',
      });
      expect(pyErr.status).toBe(201);
      expect(pyErr.body.data).toMatchObject({ status: 'ERROR', scorePercent: 0 });
    }

    if (hasGcc) {
      const cOk = await students[0].post(`/api/programming/problems/${problemId}/submit`, {
        language: 'C',
        code: '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("%d\\n", n * 3); return 0; }',
      });
      expect(cOk.status).toBe(201);
      expect(cOk.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 2, totalCount: 2, scorePercent: 100 });
    }

    if (hasGpp) {
      const cppOk = await students[0].post(`/api/programming/problems/${problemId}/submit`, {
        language: 'CPP',
        code: '#include <iostream>\nint main() { long long n; if (!(std::cin >> n)) return 1; std::cout << n * 3 << "\\n"; }',
      });
      expect(cppOk.status).toBe(201);
      expect(cppOk.body.data).toMatchObject({ status: 'COMPLETED', passedCount: 2, totalCount: 2, scorePercent: 100 });
    }
  }, 30_000);

  it('auto-grades a programming question inside a quiz when submitted', async () => {
    const { teacher, cls, students } = await classroom(1);
    const prob = (
      await teacher.post('/api/programming/problems', {
        title: 'Square it',
        statementHtml: '<p>Print n*n.</p>',
        allowedLanguages: ['JAVASCRIPT'],
        testCases: [{ input: '5\n', expectedOutput: '25' }],
      })
    ).body.data;

    const quiz = (await teacher.post(`/api/classes/${cls.id}/quizzes`, { title: 'Coding quiz', type: 'QUIZ', resultVisibility: 'IMMEDIATE' })).body.data;
    const questionRes = await teacher.post(`/api/quizzes/${quiz.id}/questions`, {
      question: {
        type: 'PROGRAMMING',
        text: '<p>Write a program that squares an integer.</p>',
        points: 10,
        programmingProblemId: prob.id,
      },
    });
    expect(questionRes.status).toBe(201);
    expect((await teacher.patch(`/api/quizzes/${quiz.id}`, { status: 'PUBLISHED' })).status).toBe(200);

    const started = await students[0].post(`/api/quizzes/${quiz.id}/attempts`, { acceptRules: true });
    expect(started.status).toBe(201);
    const attemptId = started.body.data.attemptId;
    expect((await students[0].put(`/api/attempts/${attemptId}/answers/0`, {
      response: { language: 'JAVASCRIPT', code: "const n = Number(require('fs').readFileSync(0, 'utf8')); console.log(n * n);" },
    })).status).toBe(200);
    const done = await students[0].post(`/api/attempts/${attemptId}/submit`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'SUBMITTED', awaitingGrading: false, totalScore: 10 });
  }, 20_000);

  it('runs the admin multi-language self-test check cleanly', async () => {
    const admin = await actor('ADMIN');
    const check = await admin.post('/api/admin/code-runner/check', {});
    expect(check.status).toBe(200);
    expect(check.body.data.provider).toBe('local');
    expect(check.body.data.ok).toBe(true);
    expect(check.body.data.languages.JAVASCRIPT).toMatchObject({ ok: true, detail: null });
    expect(check.body.data.versions.JAVASCRIPT).toMatch(/^v\d+/);
    if (hasPython) expect(check.body.data.languages.PYTHON.ok).toBe(true);
    if (hasGcc) expect(check.body.data.languages.C.ok).toBe(true);
    if (hasGpp) expect(check.body.data.languages.CPP.ok).toBe(true);
  }, 45_000);
});
