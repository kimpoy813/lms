// Hybrid AI assistant: built-in zero-key engine + Admin UI-configured encrypted API providers.
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, anonymous, classroom, prepare, prisma } from '../helpers/index.js';
import { AI_CONFIG_KEY, invalidateAiConfigCache } from '../../src/services/aiConfig.js';
import { forgetAdjustments } from '../../src/services/aiProvider.js';

const mockApi = {
  asked: [],
  reply: null,
  server: http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      mockApi.asked.push({ url: req.url, authorization: req.headers.authorization ?? null, body });
      const answer = mockApi.reply ? mockApi.reply(body) : { status: 200, body: { model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  }),
};

beforeAll(async () => {
  await prepare();
  mockApi.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => mockApi.server.once('listening', resolve));
});

beforeEach(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: AI_CONFIG_KEY } });
  invalidateAiConfigCache();
  forgetAdjustments();
  mockApi.asked.length = 0;
  mockApi.reply = null;
});

afterAll(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: AI_CONFIG_KEY } });
  invalidateAiConfigCache();
  await new Promise((resolve) => mockApi.server.close(resolve));
});

describe('hybrid AI assistant (built-in zero-key + encrypted DB config)', () => {
  it('enforces admin-only access on /api/admin/ai-config', async () => {
    const { teacher, students } = await classroom(1);
    expect((await anonymous().get('/api/admin/ai-config')).status).toBe(401);
    expect((await teacher.get('/api/admin/ai-config')).status).toBe(403);
    expect((await students[0].put('/api/admin/ai-config', { mode: 'builtin' })).status).toBe(403);
  });

  it('switches to built-in zero-key AI without restart and drafts modules, extractive quizzes, assignments, and rubrics', async () => {
    const admin = await actor('ADMIN');
    const { teacher, cls } = await classroom(0);

    // Starts unconfigured in test env (AI_PROVIDER=none)
    expect((await teacher.get('/api/ai/status')).body.data).toMatchObject({ configured: false, provider: 'none' });
    expect((await teacher.post('/api/ai/questions', { topic: 'Sorting' })).status).toBe(503);

    // Admin enables built-in mode from Settings
    const updated = await admin.put('/api/admin/ai-config', { mode: 'builtin' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      mode: 'builtin',
      effective: { source: 'settings', configured: true, provider: 'builtin', askedWith: 'built-in' },
    });

    // Immediately live for dashboard, admin check, and teachers
    expect((await admin.get('/api/dashboard')).body.data.system.aiConfigured).toBe(true);
    expect((await teacher.get('/api/ai/status')).body.data).toMatchObject({
      configured: true,
      provider: 'builtin',
      model: 'discenda-builtin-v1',
      askedWith: 'built-in',
    });
    expect((await admin.post('/api/admin/ai/check', {})).body.data).toMatchObject({
      ok: true,
      provider: 'builtin',
      askedWith: 'built-in',
      model: 'discenda-builtin-v1',
    });

    // Seed a real multi-lesson module and extract quiz + exam questions directly from it
    const mod = (await teacher.post(`/api/classes/${cls.id}/modules`, { title: 'Cellular Respiration', status: 'DRAFT' })).body.data;
    await teacher.post(`/api/modules/${mod.id}/lessons`, {
      title: 'Glycolysis',
      contentHtml: '<p>Glycolysis is the metabolic pathway that converts glucose into pyruvate in the cytoplasm. ATP is the primary energy carrier in cells.</p><ol><li>Phosphorylation of glucose</li><li>Cleavage into three-carbon sugars</li><li>ATP and NADH production</li></ol>',
    });
    await teacher.post(`/api/modules/${mod.id}/lessons`, {
      title: 'Citric Acid Cycle',
      contentHtml: '<p>Pyruvate oxidation connects glycolysis to the citric acid cycle inside the mitochondrial matrix. Oxygen is required as the final electron acceptor in aerobic respiration.</p>',
    });

    const quizRes = await teacher.post('/api/ai/questions', {
      moduleId: mod.id,
      purpose: 'EXAM',
      count: 6,
      types: ['MULTIPLE_CHOICE', 'TRUE_FALSE', 'IDENTIFICATION', 'FILL_BLANKS', 'MATCHING', 'ORDERING'],
      difficulty: 'MIXED',
    });
    expect(quizRes.status).toBe(200);
    expect(quizRes.body.data.questions.length).toBe(6);
    expect(quizRes.body.data.source).toMatchObject({ moduleId: mod.id, usedLessons: 2 });
    expect(quizRes.body.data.questions.map((q) => q.topic).some((t) => /Glycolysis|Citric Acid Cycle/.test(String(t)))).toBe(true);

    // Module generation + lesson rewrite + approval workflow
    const genRes = await teacher.post('/api/ai/modules/generate', {
      clientRequestId: 'builtin-mod-12345',
      classId: cls.id,
      topic: 'Recursion in Python',
      subtopics: ['Base cases', 'Recursive step', 'Call stack'],
      language: 'ENGLISH',
      contentLength: 'SHORT',
      includeAssessment: true,
    });
    expect(genRes.status).toBe(201);
    const genId = genRes.body.data.generated.id;
    expect(genRes.body.data.generated.content.lessons.length).toBeGreaterThanOrEqual(3);
    expect(genRes.body.data.generated.content.assessment.length).toBeGreaterThanOrEqual(4);
    for (const lesson of genRes.body.data.generated.content.lessons) {
      expect(lesson.visual.steps.length).toBeGreaterThanOrEqual(2);
      expect(lesson.visual.steps.length).toBeLessThanOrEqual(5);
      expect(lesson.selfCheck.options.length).toBeGreaterThanOrEqual(2);
      expect(lesson.selfCheck.correctIndex).toBeGreaterThanOrEqual(0);
      expect(lesson.selfCheck.correctIndex).toBeLessThan(lesson.selfCheck.options.length);
    }

    const rewritten = await teacher.post(`/api/ai/generated/${genId}/lessons/0/rewrite`, { instruction: 'Make it shorter with bullet takeaways' });
    expect(rewritten.status).toBe(200);
    expect(rewritten.body.data.lesson.contentHtml).toContain('<li>');
    expect(rewritten.body.data.lesson.visual.steps.length).toBeGreaterThanOrEqual(2);
    expect(rewritten.body.data.lesson.selfCheck.options.length).toBeGreaterThanOrEqual(2);

    const approved = await teacher.post(`/api/ai/generated/${genId}/approve`, { classId: cls.id, confirmReviewed: true });
    expect(approved.status).toBe(201);
    expect(approved.body.data.status).toBe('DRAFT');

    // Assignment + rubric + writing assistant
    const asg = await teacher.post('/api/ai/assignment', { moduleId: mod.id, points: 50, withRubric: true });
    expect(asg.status).toBe(200);
    expect(asg.body.data.rubric.criteria.reduce((s, c) => s + c.maxPoints, 0)).toBe(50);

    const rubric = await teacher.post('/api/ai/rubric', { task: 'Lab report on cellular respiration', points: 75, criteriaCount: 5 });
    expect(rubric.status).toBe(200);
    expect(rubric.body.data.rubric.criteria).toHaveLength(5);
    expect(rubric.body.data.rubric.criteria.reduce((s, c) => s + c.maxPoints, 0)).toBe(75);

    const help = await teacher.post('/api/ai/assistant', { prompt: 'Summarize in bullets', context: 'Glycolysis breaks down glucose. Pyruvate enters mitochondria.' });
    expect(help.status).toBe(200);
    expect(help.body.data.text).toContain('Glycolysis breaks down glucose');

    // Programming problem + verified test cases generator (#4)
    const progRes = await teacher.post('/api/ai/programming', {
      topic: 'Binary search in a sorted array',
      allowedLanguages: ['PYTHON', 'JAVASCRIPT'],
      difficulty: 'MEDIUM',
      testCount: 5,
    });
    expect(progRes.status).toBe(200);
    expect(progRes.body.data.problem).toMatchObject({
      title: expect.stringMatching(/binary search/i),
      allowedLanguages: ['PYTHON', 'JAVASCRIPT'],
    });
    expect(progRes.body.data.problem.testCases).toHaveLength(5);
    expect(progRes.body.data.problem.testCases.some((t) => !t.isHidden)).toBe(true);
    expect(progRes.body.data.problem.testCases.some((t) => t.isHidden)).toBe(true);
    expect(progRes.body.data.problem.starterCode.PYTHON).toBeTruthy();

    const savedProblem = await teacher.post('/api/programming/problems', {
      ...progRes.body.data.problem,
      classId: cls.id,
    });
    expect(savedProblem.status).toBe(201);
  });

  it('encrypts saved API keys in PostgreSQL, never exposes them to clients or logs, and routes requests to the external endpoint', async () => {
    const admin = await actor('ADMIN');
    const { teacher } = await classroom(0);
    const mockUrl = `http://127.0.0.1:${mockApi.server.address().port}/v1`;
    const secretKey = 'AIzaSy-secret-gemini-test-key-9988';

    // Gemini preset defaults to gemini-3.5-flash-lite
    const cfgBefore = await admin.get('/api/admin/ai-config');
    expect(cfgBefore.body.data.presets.find((p) => p.id === 'gemini').defaultModel).toBe('gemini-3.5-flash-lite');

    // Requires an API key for non-loopback HTTPS URLs
    const missingKey = await admin.put('/api/admin/ai-config', {
      mode: 'openai-compatible',
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.5-flash-lite',
    });
    expect(missingKey.status).toBe(422);
    expect(missingKey.body.error.details.fields.apiKey).toBeTruthy();

    // Save external OpenAI-compatible config targeting our local mock endpoint
    const saved = await admin.put('/api/admin/ai-config', {
      mode: 'openai-compatible',
      preset: 'custom',
      baseUrl: mockUrl,
      model: 'gemini-3.5-flash-lite',
      apiKey: secretKey,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      mode: 'openai-compatible',
      hasApiKey: true,
      apiKeyHint: 'AIza••••9988',
      effective: { source: 'settings', configured: true, provider: 'openai-compatible', model: 'gemini-3.5-flash-lite', askedWith: 'key', baseUrl: mockUrl },
    });
    expect(JSON.stringify(saved.body)).not.toContain(secretKey);

    // Raw DB row stores ciphertext, never plaintext key; audit logs and auth config stay secret-free
    const row = await prisma.systemSetting.findUnique({ where: { key: AI_CONFIG_KEY } });
    expect(row.value.apiKeyCipher).toMatch(/^v1:/);
    expect(JSON.stringify(row.value)).not.toContain(secretKey);
    const auditLogs = await prisma.auditLog.findMany({ where: { action: 'ai.config.update' } });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(auditLogs)).not.toContain(secretKey);
    expect(JSON.stringify((await anonymous().get('/api/auth/config')).body)).not.toContain('providerConfig');

    // Teacher AI request calls the configured external service with the decrypted bearer token
    mockApi.reply = () => ({
      body: {
        model: 'gemini-3.5-flash-lite',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [{ type: 'TRUE_FALSE', text: 'External LLM question.', answer: true, points: 1 }] }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 15 },
      },
    });
    const drafted = await teacher.post('/api/ai/questions', { topic: 'Biology', count: 1, types: ['TRUE_FALSE'] });
    expect(drafted.status).toBe(200);
    expect(drafted.body.data.questions[0].text).toBe('External LLM question.');
    expect(mockApi.asked[0].authorization).toBe(`Bearer ${secretKey}`);

    // Updating model preserves existing encrypted key when apiKey is omitted
    const updatedModel = await admin.put('/api/admin/ai-config', {
      mode: 'openai-compatible',
      preset: 'custom',
      baseUrl: mockUrl,
      model: 'llama-3.3-70b-versatile',
    });
    expect(updatedModel.status).toBe(200);
    expect(updatedModel.body.data.hasApiKey).toBe(true);
    expect(updatedModel.body.data.apiKeyHint).toBe('AIza••••9988');

    // Clearing the key + switching off cleanly disables AI
    const cleared = await admin.put('/api/admin/ai-config', { mode: 'off', clearApiKey: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ mode: 'off', hasApiKey: false, apiKeyHint: null, effective: { configured: false, provider: 'none' } });
    expect((await teacher.post('/api/ai/questions', { topic: 'Biology' })).status).toBe(503);
  });
});
