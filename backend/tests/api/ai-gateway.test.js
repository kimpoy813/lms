// The teacher's assistant where it is meant to run: inside a Vercel Function, asking Vercel's AI
// Gateway with the project's own identity instead of a key.
//
// That identity is a short-lived token Vercel sends along with every request. It is read for each
// request to the gateway and never kept, and a token issued to another project is not passed on.
//
// Requests go through the function's real entry point (api/index.js). The gateway is a small
// server in this file that answers what a test tells it to: the real request leaves the
// application, with its real headers and body, and comes back through the real reading of the
// answer. Only Vercel's own part, the header with the token, is played by the tests.
import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A pretend AI Gateway.
const gateway = {
  asked: [],
  /** What to answer: (request number, body) => { status?, body?, headers?, hang? } */
  reply: null,
  server: http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const asked = { path: req.url, authorization: req.headers.authorization ?? null, body: JSON.parse(text || '{}'), givenUpAfterMs: null };
      gateway.asked.push(asked);
      const answer = gateway.reply(gateway.asked.length, JSON.parse(text || '{}'));
      if (answer.hang) {
        // Never answers; notes how long the application waited before it hung up.
        const arrived = Date.now();
        res.on('close', () => { asked.givenUpAfterMs = Date.now() - arrived; });
        return;
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  }),
};
gateway.server.listen(0, '127.0.0.1');
await new Promise((resolve) => gateway.server.once('listening', resolve));

// Before any application module loads.
vi.hoisted(() => {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_REGION = 'sin1';
  process.env.VERCEL_PROJECT_ID = 'prj_site';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'edusphere.example';
  process.env.AI_PROVIDER = 'vercel-ai-gateway';
  // Long enough for a second try after a short wait, short enough for the test of a service that never answers.
  process.env.AI_TIMEOUT_MS = '13000';
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.VERCEL_OIDC_TOKEN;
});
process.env.AI_BASE_URL = `http://127.0.0.1:${gateway.server.address().port}/v1/`;

const { PASSWORD, classroom, createUser, prepare, prisma } = await import('../helpers/index.js');
const { env } = await import('../../src/config/env.js');
const { DEFAULT_GATEWAY_MODEL, forgetAdjustments } = await import('../../src/services/aiProvider.js');
const { default: handler } = await import('../../../api/index.js');

const HEADER = 'x-vercel-oidc-token';
/** A token as Vercel issues it, as far as this application reads it: who it is for. */
const tokenFor = (claims) => `header.${Buffer.from(JSON.stringify({ owner_id: 'team_site', project_id: 'prj_site', ...claims })).toString('base64url')}.signature`;

/** The model's answer to "draft questions", as the gateway hands it on. */
const QUESTIONS = { questions: [{ type: 'TRUE_FALSE', text: 'Light splits water in the thylakoid membranes.', answer: true, points: 1 }] };
const completion = (content, extra = {}) => ({ body: { model: 'meta/muse-ember-1109', choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }, ...extra });
const refusal = (status, type, message, headers) => ({ status, body: { error: { type, message } }, headers });

let server;
let teacher;
let admin;
let moduleId;
/** Someone signed in through the function; `token` is what the platform sends along with a request. */
async function signedIn(user) {
  const agent = request.agent(server);
  const login = await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  expect(login.status).toBe(200);
  const csrf = login.body.data.csrfToken;
  const sent = (method, url, token) => {
    const call = agent[method](url).set('x-csrf-token', csrf);
    return token === undefined ? call : call.set(HEADER, token);
  };
  return { user, get: (url, token) => sent('get', url, token), post: (url, body, token) => sent('post', url, token).send(body ?? {}) };
}
const draft = (token) => teacher.post('/api/ai/questions', { moduleId, types: ['TRUE_FALSE'], count: 1 }, token);
const usage = () => prisma.aIGenerationUsage.count({ where: { userId: teacher.user.id } });

beforeAll(async () => {
  await prepare();
  server = handler.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const made = await classroom(0);
  const module = await made.teacher.post(`/api/classes/${made.cls.id}/modules`, { title: 'Photosynthesis', status: 'DRAFT' });
  expect(module.status).toBe(201);
  moduleId = module.body.data.id;
  expect((await made.teacher.post(`/api/modules/${moduleId}/lessons`, { title: 'Light reactions', contentHtml: '<p>In the thylakoid membranes, light splits water.</p>' })).status).toBe(201);
  teacher = await signedIn(made.teacher.user);
  admin = await signedIn(await createUser('ADMIN'));
});
beforeEach(() => {
  gateway.asked.length = 0;
  gateway.reply = () => completion(QUESTIONS);
  forgetAdjustments();
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => gateway.server.close(resolve));
});

describe('the configuration on Vercel', () => {
  it('needs nothing but the choice of the AI Gateway: no key, and a model that is in its catalogue', () => {
    expect(env.platform).toBe('vercel');
    expect(env.ai).toMatchObject({ provider: 'vercel-ai-gateway', configured: true, usesProjectIdentity: true, apiKey: undefined, model: DEFAULT_GATEWAY_MODEL, timeoutMs: 13_000 });
    // A trailing slash in AI_BASE_URL does no harm.
    expect(env.ai.baseUrl).toBe(`http://127.0.0.1:${gateway.server.address().port}/v1`);
  });

  it('tells the administrator how the service is asked, and nothing secret', async () => {
    const status = (await admin.get('/api/admin/status')).body.data.ai;
    expect(status).toMatchObject({ configured: true, provider: 'vercel-ai-gateway', model: DEFAULT_GATEWAY_MODEL, askedWith: 'project identity' });
    expect((await teacher.get('/api/ai/status')).body.data).toMatchObject({ configured: true, model: DEFAULT_GATEWAY_MODEL, message: null });
    expect((await teacher.get('/api/admin/status')).status).toBe(403);
  });
});

describe('the project’s identity', () => {
  it('asks the gateway with the token that came with the teacher’s request', async () => {
    const token = tokenFor({ nonce: 'first' });
    const before = await usage();
    const res = await draft(token);
    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(1);
    expect(res.body.data.source).toMatchObject({ moduleId, usedLessons: 1 });
    expect(gateway.asked).toHaveLength(1);
    expect(gateway.asked[0].path).toBe('/v1/chat/completions');
    expect(gateway.asked[0].authorization).toBe(`Bearer ${token}`);
    expect(gateway.asked[0].body).toMatchObject({ model: DEFAULT_GATEWAY_MODEL, temperature: 0.4, max_tokens: 8000, response_format: { type: 'json_object' } });
    expect(gateway.asked[0].body.messages[1].content).toContain('In the thylakoid membranes, light splits water.');
    // What is recorded is the model that answered, as the gateway names it.
    expect(await usage()).toBe(before + 1);
    expect(await prisma.aIGenerationUsage.findFirst({ where: { userId: teacher.user.id }, orderBy: { createdAt: 'desc' } })).toMatchObject({ modelIdentifier: 'meta/muse-ember-1109', promptTokens: 900, completionTokens: 60 });
  });

  it('is read anew for every request and never kept', async () => {
    await draft(tokenFor({ nonce: 'one' }));
    await draft(tokenFor({ nonce: 'two' }));
    expect(gateway.asked.map((asked) => asked.authorization)).toEqual([`Bearer ${tokenFor({ nonce: 'one' })}`, `Bearer ${tokenFor({ nonce: 'two' })}`]);
    // Without one, nothing is asked with the token of an earlier request.
    gateway.asked.length = 0;
    const without = await draft(undefined);
    expect(without.status).toBe(503);
    expect(gateway.asked).toEqual([]);
  });

  it('says what is wrong when no identity arrives, without asking the gateway', async () => {
    const before = await usage();
    const res = await draft(undefined);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'AI_NEEDS_ATTENTION', message: 'The AI service did not accept the request, and trying again will not help. An administrator can see the reason under Administration → Settings.' });
    expect(JSON.stringify(res.body)).not.toMatch(/OIDC|token/i); // the reason is the administrator's to read
    expect(gateway.asked).toEqual([]);
    expect(await usage()).toBe(before); // nothing is counted against the teacher's daily requests
    const seen = (await admin.get('/api/admin/status')).body.data.ai;
    expect(seen.lastFailure).toMatchObject({ kind: 'identity', message: 'The Vercel project has no identity to ask the AI Gateway with.', link: null });
    expect(seen.lastFailure.detail).toContain('Secure Backend Access with OIDC');
    expect(Date.parse(seen.lastFailureAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('does not pass on a token that was issued to another project, or one whose time is over', async () => {
    for (const token of [tokenFor({ project_id: 'prj_somebody_else' }), tokenFor({ exp: Math.floor(Date.now() / 1000) - 60 }), 'not-a-token']) {
      const res = await draft(token);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_NEEDS_ATTENTION');
    }
    expect(gateway.asked).toEqual([]);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure.kind).toBe('identity');
  });
});

describe('a gateway that refuses', () => {
  const token = tokenFor({ nonce: 'refused' });

  it('wants a payment method: the teacher is sent to the administrator, who sees Vercel’s words and its page', async () => {
    // What Vercel answered for this project on 2026-11-13.
    const said = 'AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.';
    gateway.reply = () => refusal(403, 'customer_verification_required', said);
    const before = await usage();
    const res = await draft(token);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NEEDS_ATTENTION');
    expect(JSON.stringify(res.body)).not.toContain('credit card');
    expect(gateway.asked).toHaveLength(1); // asking again would change nothing
    expect(await usage()).toBe(before);

    const checked = await admin.post('/api/admin/ai/check', {}, token);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({
      ok: false, provider: 'vercel-ai-gateway', model: DEFAULT_GATEWAY_MODEL, askedWith: 'project identity',
      failure: { kind: 'verification', message: 'Vercel wants a payment method on the account before its free credit can be used.', detail: `HTTP 403 customer_verification_required: ${said}`, link: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card' },
    });
    expect((await teacher.post('/api/admin/ai/check', {}, token)).status).toBe(403);
  });

  it('shows the administrator only a link that leads to Vercel', async () => {
    gateway.reply = () => refusal(403, 'customer_verification_required', 'Verify your account at https://vercel.example.attacker.test/pay to continue.');
    const failure = (await admin.post('/api/admin/ai/check', {}, token)).body.data.failure;
    expect(failure).toMatchObject({ kind: 'verification', link: null });
    expect(failure.detail).toContain('attacker.test'); // as text, in what the service said
    for (const elsewhere of ['https://vercel.com.attacker.test/pay', 'https://notvercel.com/pay', 'https://pay.vercel.com.attacker.test/', 'http://vercel.com/pay', 'https://vercel.com@attacker.test/pay', 'https://user:secret@vercel.com/pay', 'https://vercel.com:8443/pay', 'https://VERCEL.COM.attacker.test', 'javascript:alert(1)']) {
      gateway.reply = () => refusal(403, 'customer_verification_required', `Add a payment method: ${elsewhere}`);
      expect([elsewhere, (await admin.post('/api/admin/ai/check', {}, token)).body.data.failure.link]).toEqual([elsewhere, null]);
    }
    // Vercel's own, however it is written.
    gateway.reply = () => refusal(403, 'customer_verification_required', 'Add a payment method: https://VERCEL.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai');
    expect((await admin.post('/api/admin/ai/check', {}, token)).body.data.failure.link).toBe('https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai');
  });

  it('sends the administrator to Vercel’s list when the model is not one the free credit covers', async () => {
    gateway.reply = () => refusal(403, 'forbidden', 'The model meta/muse-ember is not available on the free tier. Purchase AI Gateway Credits to use it.');
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([503, 'AI_NEEDS_ATTENTION']);
    const failure = (await admin.post('/api/admin/ai/check', {}, token)).body.data.failure;
    expect(failure).toMatchObject({ kind: 'model', message: 'This model is not among those Vercel’s free credit covers. Set AI_MODEL to one that is.', link: 'https://vercel.com/ai-gateway/models?freeTier=true' });
  });

  it('tells the other lasting reasons apart for the administrator', async () => {
    const cases = [
      [refusal(401, 'authentication_error', 'Invalid token'), 'identity'],
      [refusal(402, 'insufficient_funds', 'Insufficient funds'), 'credit'],
      [refusal(402, 'quota_for_entity_exceeded', 'Budget reached'), 'budget'],
      [refusal(404, 'model_not_found', 'Model not found'), 'model'],
      [refusal(403, 'forbidden', 'This model is not available on the free tier.'), 'model'],
      [refusal(403, 'forbidden', 'Provider not allowed by the team'), 'restricted'],
    ];
    for (const [answer, kind] of cases) {
      gateway.reply = () => answer;
      const res = await draft(token);
      expect([res.status, res.body.error.code]).toEqual([503, 'AI_NEEDS_ATTENTION']);
      expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure.kind).toBe(kind);
    }
    expect(gateway.asked).toHaveLength(cases.length);
  });

  it('is asked once more after a short wait when it is only busy', async () => {
    gateway.reply = (n) => (n === 1 ? refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '1' }) : completion(QUESTIONS));
    const before = await usage();
    const started = Date.now();
    const res = await draft(token);
    expect(res.status).toBe(200);
    expect(gateway.asked).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(await usage()).toBe(before + 1); // one request of the teacher, however often the service was asked
  });

  it('is not waited for when it says the wait is long, or when it is still busy the second time', async () => {
    gateway.reply = () => refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '30' });
    const long = await draft(token);
    expect(long.status).toBe(503);
    expect(long.body.error).toMatchObject({ code: 'AI_BUSY', message: 'The AI service has too many requests right now. Wait a minute, then try again.', details: { retryAfterSeconds: 30 } });
    expect(gateway.asked).toHaveLength(1);

    gateway.asked.length = 0;
    gateway.reply = () => refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '1' });
    const still = await draft(token);
    expect([still.status, still.body.error.code]).toEqual([503, 'AI_BUSY']);
    expect(gateway.asked).toHaveLength(2);
  });

  it('is not asked a second time when too little of the time would be left for an answer', async () => {
    // Of the thirteen seconds this test allows, eight would remain after the wait: not worth starting.
    gateway.reply = () => refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '5' });
    const started = Date.now();
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([503, 'AI_BUSY']);
    expect(res.body.error.details).toEqual({ retryAfterSeconds: 5 });
    expect(gateway.asked).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(3000); // and it is said at once, not after the wait
    // A wait the service names is passed on as it is…
    gateway.reply = () => refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '9' });
    expect((await draft(token)).body.error.details).toEqual({ retryAfterSeconds: 9 });
    // …and when it names none (here: the second time), the teacher is told a minute.
    gateway.asked.length = 0;
    gateway.reply = (n) => refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', n === 1 ? { 'retry-after': '1' } : {});
    expect((await draft(token)).body.error.details).toEqual({ retryAfterSeconds: 60 });
    expect(gateway.asked).toHaveLength(2);
  });

  /** How long the application waited for the answer to request `n` before it hung up (the gateway notes it a moment later). */
  async function givenUpAfter(n) {
    for (let i = 0; i < 40 && gateway.asked[n].givenUpAfterMs === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    return gateway.asked[n].givenUpAfterMs;
  }

  it('is given up on when it does not answer in time, and that can be tried again', async () => {
    gateway.reply = () => ({ hang: true });
    const res = await draft(token);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'AI_FAILED', message: 'The AI service took too long to answer. Please try again.' });
    expect(gateway.asked).toHaveLength(1);
    const waited = await givenUpAfter(0);
    expect(waited).toBeGreaterThanOrEqual(12_500);
    expect(waited).toBeLessThan(15_000);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure).toMatchObject({ kind: 'timeout', detail: 'no answer within 13 s' });
  });

  it('gives the second try only the time that is left, so that the whole exchange ends when it should', async () => {
    // Busy at first, then silence. After two seconds of waiting, eleven of the thirteen are left.
    gateway.reply = (n) => (n === 1 ? refusal(429, 'rate_limit_exceeded', 'Rate limit exceeded', { 'retry-after': '2' }) : { hang: true });
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([502, 'AI_FAILED']);
    expect(gateway.asked).toHaveLength(2);
    const waited = await givenUpAfter(1);
    expect(waited).toBeGreaterThanOrEqual(10_000);
    expect(waited).toBeLessThan(12_000);
  });

  it('says so when the material is more than the model takes at once', async () => {
    // A free allowance that counts tokens per minute answers like this to one large request.
    gateway.reply = () => ({ status: 413, body: { error: { message: 'Request too large for model `some-model` on tokens per minute (TPM): Limit 6000, Requested 15234, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } } });
    const before = await usage();
    const res = await draft(token);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'AI_TOO_LARGE', message: 'That is more than the AI service set up here takes at once. Ask for fewer items, or draft from a topic or a shorter module.' });
    expect(gateway.asked).toHaveLength(1);
    expect(await usage()).toBe(before);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure).toMatchObject({ kind: 'size', message: 'The request is more than this model takes at once.' });
    gateway.reply = () => ({ status: 400, body: { error: { message: 'This model’s maximum context length is 32768 tokens. However, your messages resulted in 40111 tokens.', type: 'invalid_request_error', code: 'context_length_exceeded' } } });
    expect((await draft(token)).body.error.code).toBe('AI_TOO_LARGE');
  });

  it('answers with something that is not what was asked for', async () => {
    gateway.reply = () => completion('I am sorry, I cannot help with that.');
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([502, 'AI_FAILED']);
    gateway.reply = () => ({ status: 502, body: '<html>Bad Gateway</html>' });
    const down = await draft(token);
    expect([down.status, down.body.error.code]).toEqual([502, 'AI_FAILED']);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure).toMatchObject({ kind: 'failed', detail: 'HTTP 502: <html>Bad Gateway</html>' });
  });
});

describe('the administrator’s check', () => {
  it('asks one small question and shows which model answered, and how quickly', async () => {
    const token = tokenFor({ nonce: 'check' });
    gateway.reply = () => completion({ ok: true, question: 'Which gas do plants take in?', choices: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Helium'], correct: 1 });
    const res = await admin.post('/api/admin/ai/check', {}, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, provider: 'vercel-ai-gateway', model: 'meta/muse-ember-1109', askedWith: 'project identity', ms: expect.any(Number), answer: 'Which gas do plants take in?' });
    expect(gateway.asked).toHaveLength(1);
    expect(gateway.asked[0].authorization).toBe(`Bearer ${token}`);
    expect(gateway.asked[0].body).toMatchObject({ model: DEFAULT_GATEWAY_MODEL, max_tokens: 2000, response_format: { type: 'json_object' } });
    // After a success the earlier failure is old news.
    const seen = (await admin.get('/api/admin/status')).body.data.ai;
    expect(Date.parse(seen.lastSuccessAt)).toBeGreaterThanOrEqual(Date.parse(seen.lastFailureAt));
  });

  it('says so when the model answers, but not with what was asked for', async () => {
    gateway.reply = () => completion({ hello: 'world' });
    const res = await admin.post('/api/admin/ai/check', {}, tokenFor({ nonce: 'check' }));
    expect(res.body.data).toMatchObject({ ok: false, failure: { kind: 'failed', message: 'The AI service answered, but not with what was asked for. Another model may do better.', detail: '{"hello":"world"}' } });
    gateway.reply = () => completion('not JSON');
    const unreadable = await admin.post('/api/admin/ai/check', {}, tokenFor({ nonce: 'check' }));
    expect(unreadable.body.data).toMatchObject({ ok: false, failure: { kind: 'failed', message: 'The AI service returned an answer that could not be read. Please try again.' } });
  });
});

describe('a model that does not take the request the usual way', () => {
  const token = tokenFor({ nonce: 'particular' });
  const invalid = (message, param) => ({ status: 400, body: { error: { message, type: 'invalid_request_error', param, code: 'unsupported_parameter' } } });
  /** A model that minds what `minds` says about a request, and otherwise drafts the questions. */
  const particular = (minds) => (n, body) => minds(body) ?? completion(QUESTIONS);
  const noTemperature = (body) => ('temperature' in body ? invalid('Unsupported value: \'temperature\' does not support 0.4 with this model. Only the default (1) value is supported.', 'temperature') : null);
  const newName = (body) => ('max_tokens' in body ? invalid('Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead.', 'max_tokens') : null);
  const noJsonMode = (body) => ('response_format' in body ? invalid('response_format json_object is not supported by this model', 'response_format') : null);

  it('is asked again without the part it refuses, and the teacher gets the draft', async () => {
    gateway.reply = particular((body) => noTemperature(body) ?? newName(body) ?? noJsonMode(body));
    const before = await usage();
    const res = await draft(token);
    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(1);
    // One refusal for each part, then the request it takes.
    expect(gateway.asked).toHaveLength(4);
    expect(gateway.asked[0].body).toMatchObject({ temperature: 0.4, max_tokens: 8000, response_format: { type: 'json_object' } });
    const last = gateway.asked[3].body;
    expect(Object.keys(last).sort()).toEqual(['max_completion_tokens', 'messages', 'model']);
    expect(last.max_completion_tokens).toBe(8000);
    expect(last.messages).toEqual(gateway.asked[0].body.messages);
    expect(gateway.asked.map((asked) => asked.authorization)).toEqual(Array(4).fill(`Bearer ${token}`));
    expect(await usage()).toBe(before + 1);

    // What was learned is used from the start the next time.
    gateway.asked.length = 0;
    expect((await draft(token)).status).toBe(200);
    expect(gateway.asked).toHaveLength(1);
    expect(Object.keys(gateway.asked[0].body).sort()).toEqual(['max_completion_tokens', 'messages', 'model']);
  });

  it('keeps everything a model does take', async () => {
    gateway.reply = particular(noTemperature);
    expect((await draft(token)).status).toBe(200);
    expect(gateway.asked).toHaveLength(2);
    expect(gateway.asked[1].body).toMatchObject({ max_tokens: 8000, response_format: { type: 'json_object' } });
    expect(gateway.asked[1].body).not.toHaveProperty('temperature');
  });

  it('learns nothing from a request that failed in the end', async () => {
    // It minds the temperature, and then something that leaving a part out does not cure.
    gateway.reply = particular((body) => noTemperature(body) ?? invalid('The messages are not in an order this model accepts.', 'messages'));
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([502, 'AI_FAILED']);
    expect(gateway.asked).toHaveLength(2);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure).toMatchObject({ kind: 'failed', detail: 'HTTP 400 invalid_request_error: The messages are not in an order this model accepts.' });
    // The next request starts in the usual way again.
    gateway.asked.length = 0;
    gateway.reply = () => completion(QUESTIONS);
    expect((await draft(token)).status).toBe(200);
    expect(gateway.asked[0].body).toMatchObject({ temperature: 0.4 });
  });

  it('does not go on asking a model that refuses whatever is left out', async () => {
    gateway.reply = () => invalid('temperature, max_tokens and response_format are all wrong, and so is everything else');
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([502, 'AI_FAILED']);
    expect(gateway.asked).toHaveLength(4); // the request, and one more for each of the three parts
  });

  it('tells the administrator when the answer that is asked for is longer than the model writes', async () => {
    // Not the material: the teacher can do nothing about it, the administrator can (AI_MAX_OUTPUT_TOKENS).
    gateway.reply = (n, body) => invalid(`${'max_tokens' in body ? 'max_tokens' : 'max_completion_tokens'} is too large: 8000. This model supports at most 4096 completion tokens.`, 'max_tokens');
    const res = await draft(token);
    expect([res.status, res.body.error.code]).toEqual([502, 'AI_FAILED']);
    expect((await admin.get('/api/admin/status')).body.data.ai.lastFailure).toMatchObject({ kind: 'failed', detail: 'HTTP 400 invalid_request_error: max_completion_tokens is too large: 8000. This model supports at most 4096 completion tokens.' });
  });
});
