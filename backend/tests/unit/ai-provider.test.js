// The AI service's API, and what its refusals mean (services/aiProvider.js). The meanings are
// what the application decides on: whether to wait, to try again, or to send for an administrator.
import { describe, expect, it } from 'vitest';
import { AiProviderError, DEFAULT_GATEWAY_MODEL, VERCEL_AI_GATEWAY_URL, VERCEL_FREE_TIER_MODELS, aiTarget, chatCompletion, forgetAdjustments, identityMayGoTo, readProviderError } from '../../src/services/aiProvider.js';

const headers = (values = {}) => new Headers(values);
const answer = (status, body, head = {}) => ({ ok: status >= 200 && status < 300, status, headers: headers(head), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const kindOf = (status, body, head) => readProviderError(status, typeof body === 'string' ? body : JSON.stringify(body), headers(head));

describe('what a refusal of the AI service means', () => {
  it('tells the reasons apart that Vercel documents for its AI Gateway', () => {
    // What the gateway answered for this project on 2026-11-13, for every model, the free ones included.
    const card = kindOf(403, { error: { message: 'AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.', type: 'customer_verification_required' } });
    expect(card).toBeInstanceOf(AiProviderError);
    expect(card).toMatchObject({ kind: 'verification', status: 403, link: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card' });
    expect(card.detail).toMatch(/^HTTP 403 customer_verification_required: AI Gateway requires a valid credit card/);

    expect(kindOf(401, { error: { message: 'Invalid API key', type: 'authentication_error' } })).toMatchObject({ kind: 'identity', status: 401 });
    expect(kindOf(402, { error: { message: 'Insufficient funds', type: 'insufficient_funds' } }).kind).toBe('credit');
    expect(kindOf(402, { error: { message: 'Budget reached', type: 'quota_for_entity_exceeded' } }).kind).toBe('budget');
    // A model the monthly free credit does not cover: the administrator is sent to Vercel's list of those it does.
    expect(kindOf(403, { error: { message: 'This model is not available on the free tier. Purchase credits to use it.', type: 'forbidden' } })).toMatchObject({ kind: 'model', message: 'This model is not among those Vercel’s free credit covers. Set AI_MODEL to one that is.', link: VERCEL_FREE_TIER_MODELS });
    expect(VERCEL_FREE_TIER_MODELS).toBe('https://vercel.com/ai-gateway/models?freeTier=true');
    expect(kindOf(404, { error: { message: 'Model not found', type: 'model_not_found' } }).link).toBeNull();
    // Another service that wants the account verified is not called Vercel.
    expect(kindOf(403, { error: { message: 'Please verify your account at https://console.example/verify first.' } })).toMatchObject({ kind: 'verification', message: 'The AI service wants the account verified, or a payment method added, before it answers.', link: 'https://console.example/verify' });
    expect(kindOf(403, { error: { message: 'Provider not allowed by the team', type: 'forbidden' } })).toMatchObject({ kind: 'restricted', link: null });
    expect(kindOf(404, { error: { message: 'Model not found', type: 'model_not_found' } }).kind).toBe('model');
    // More than the model takes at once; a complaint about the length of the answer asked for is something else.
    expect(kindOf(413, { error: { message: 'Request too large for model on tokens per minute (TPM): Limit 6000, Requested 15234', type: 'tokens', code: 'rate_limit_exceeded' } }).kind).toBe('size');
    expect(kindOf(400, { error: { message: 'This model\'s maximum context length is 32768 tokens.', code: 'context_length_exceeded' } }).kind).toBe('size');
    expect(kindOf(400, { error: { message: 'Input is too long for requested model.' } }).kind).toBe('size');
    expect(kindOf(400, { error: { message: 'max_tokens is too large: 8000. This model supports at most 4096 completion tokens.' } }).kind).toBe('failed');
    expect(kindOf(400, { error: { message: 'Invalid value for messages' } }).kind).toBe('failed');
    expect(kindOf(408, 'slow').kind).toBe('timeout');
    expect(kindOf(504, 'slow').kind).toBe('timeout');
    expect(kindOf(500, { error: { message: 'boom' } }).kind).toBe('failed');
    expect(kindOf(503, '<html>Service Unavailable</html>')).toMatchObject({ kind: 'failed', detail: 'HTTP 503: <html>Service Unavailable</html>' });
  });

  it('says how long to wait when the service says so, and nothing when it does not', () => {
    expect(kindOf(429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' } }, { 'retry-after': '7' })).toMatchObject({ kind: 'busy', retryAfterSeconds: 7 });
    expect(kindOf(429, 'slow down', { 'retry-after': '1.2' }).retryAfterSeconds).toBe(2);
    expect(kindOf(429, 'slow down', { 'retry-after': '86400' }).retryAfterSeconds).toBe(3600); // never a day
    expect(kindOf(429, 'slow down', { 'retry-after': new Date(Date.now() + 30_000).toUTCString() }).retryAfterSeconds).toBeGreaterThan(25);
    expect(kindOf(429, 'slow down', { 'retry-after': 'soon' }).retryAfterSeconds).toBeNull();
    expect(kindOf(429, 'slow down').retryAfterSeconds).toBeNull();
    expect(readProviderError(429, 'slow down', undefined).retryAfterSeconds).toBeNull();
  });

  it('reads the shapes other services use for an error, and keeps the detail short', () => {
    expect(kindOf(401, { error: 'bad key' }).detail).toBe('HTTP 401: bad key');
    expect(kindOf(400, { message: 'no such thing', code: 'invalid_request' }).detail).toBe('HTTP 400 invalid_request: no such thing');
    expect(kindOf(500, `${'x'.repeat(5000)}`).detail.length).toBeLessThan(320);
    expect(kindOf(500, 'two\nlines\tand  spaces').detail).toBe('HTTP 500: two lines and spaces');
    expect(kindOf(500, '').detail).toBe('HTTP 500');
  });
});

describe('one request to the AI service', () => {
  const asked = [];
  const fetchWith = (reply) => async (url, options) => {
    asked.push({ url, ...options, body: JSON.parse(options.body) });
    return typeof reply === 'function' ? reply() : reply;
  };
  const request = { baseUrl: VERCEL_AI_GATEWAY_URL, bearer: 'token-1', model: DEFAULT_GATEWAY_MODEL, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] };

  it('asks the way OpenAI-compatible services expect, and reads the answer', async () => {
    asked.length = 0;
    const out = await chatCompletion({ ...request, json: true, maxTokens: 900, fetchImpl: fetchWith(answer(200, { model: 'google/some-model-001', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })) });
    expect(out).toEqual({ content: '{"ok":true}', finishReason: 'stop', model: 'google/some-model-001', promptTokens: 12, completionTokens: 5 });
    expect(asked[0].url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
    expect(asked[0].method).toBe('POST');
    expect(asked[0].headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer token-1' });
    expect(asked[0].body).toEqual({ model: DEFAULT_GATEWAY_MODEL, messages: request.messages, temperature: 0.4, max_tokens: 900, response_format: { type: 'json_object' } });

    // Free text: no response format; no key: no header; an answer without the extras still reads.
    const plain = await chatCompletion({ ...request, bearer: '', fetchImpl: fetchWith(answer(200, { choices: [{ message: { content: 'Hello' } }] })) });
    expect(plain).toEqual({ content: 'Hello', finishReason: null, model: DEFAULT_GATEWAY_MODEL, promptTokens: 0, completionTokens: 0 });
    expect(asked[1].headers).toEqual({ 'content-type': 'application/json' });
    expect(asked[1].body).toEqual({ model: DEFAULT_GATEWAY_MODEL, messages: request.messages, temperature: 0.4 });
    // Nothing usable in it: an empty answer, which the caller reports.
    expect((await chatCompletion({ ...request, fetchImpl: fetchWith(answer(200, { choices: [] })) })).content).toBe('');
    expect((await chatCompletion({ ...request, fetchImpl: fetchWith(answer(200, { choices: [{ message: { content: [{ type: 'text', text: 'parts' }] } }] })) })).content).toBe('');
  });

  it('turns every way of failing into a reason', async () => {
    const failing = (reply) => chatCompletion({ ...request, timeoutMs: 40, fetchImpl: fetchWith(reply) }).then(() => null, (err) => err);
    expect(await failing(answer(403, { error: { message: 'Add a payment method', type: 'customer_verification_required' } }))).toMatchObject({ name: 'AiProviderError', kind: 'verification' });
    expect(await failing(answer(200, 'not json at all'))).toMatchObject({ kind: 'failed', detail: 'not json at all' });
    expect(await failing(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh') }); })).toMatchObject({ kind: 'network', detail: 'getaddrinfo ENOTFOUND ai-gateway.vercel.sh' });
    expect(await failing(() => { throw new TypeError('fetch failed'); })).toMatchObject({ kind: 'network', detail: 'fetch failed' });
    // No answer in time: the request is given up, and that is said.
    const never = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const slow = await chatCompletion({ ...request, timeoutMs: 30, fetchImpl: never }).then(() => null, (err) => err);
    expect(slow).toMatchObject({ kind: 'timeout', detail: 'no answer within 0 s' });
    // The body counts too: headers in time and then silence is still too slow.
    const stalls = async (url, options) => ({ ok: true, status: 200, headers: headers(), text: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    expect(await chatCompletion({ ...request, timeoutMs: 30, fetchImpl: stalls }).then(() => null, (err) => err)).toMatchObject({ kind: 'timeout' });
  });

  it('asks again without a part of the request only when the service says the request is wrong', async () => {
    forgetAdjustments();
    // Busy, forbidden or unknown: the words of the refusal may name a parameter, the request is not at fault.
    for (const [status, kind] of [[429, 'busy'], [403, 'restricted'], [401, 'identity'], [404, 'model'], [500, 'failed']]) {
      asked.length = 0;
      const err = await chatCompletion({ ...request, json: true, maxTokens: 900, fetchImpl: fetchWith(answer(status, { error: { message: 'Not now. (temperature, max_tokens and response_format were all read.)' } })) }).then(() => null, (e) => e);
      expect([status, err.kind, asked.length]).toEqual([status, kind, 1]);
    }
    // A request that is wrong in a part the model does not take: asked again without that part, once.
    asked.length = 0;
    const replies = [answer(400, { error: { message: 'Unsupported value: temperature', param: 'temperature' } }), answer(200, { choices: [{ message: { content: 'ok' } }] })];
    const out = await chatCompletion({ ...request, fetchImpl: fetchWith(() => replies.shift()) });
    expect(out.content).toBe('ok');
    expect(asked.map((a) => 'temperature' in a.body)).toEqual([true, false]);
    // …and remembered for that model at that address only.
    asked.length = 0;
    await chatCompletion({ ...request, fetchImpl: fetchWith(answer(200, { choices: [{ message: { content: 'ok' } }] })) });
    await chatCompletion({ ...request, model: 'another/model', fetchImpl: fetchWith(answer(200, { choices: [{ message: { content: 'ok' } }] })) });
    await chatCompletion({ ...request, baseUrl: 'https://elsewhere.example/v1', fetchImpl: fetchWith(answer(200, { choices: [{ message: { content: 'ok' } }] })) });
    expect(asked.map((a) => 'temperature' in a.body)).toEqual([false, true, true]);
    forgetAdjustments();
  });
});

describe('where a configuration points', () => {
  it('uses what was set, and the defaults of the provider for the rest', () => {
    expect(aiTarget({ provider: 'vercel-ai-gateway' })).toEqual({ baseUrl: VERCEL_AI_GATEWAY_URL, model: DEFAULT_GATEWAY_MODEL });
    expect(aiTarget({ provider: 'vercel-ai-gateway', model: 'mistral/ministral-14b' })).toEqual({ baseUrl: VERCEL_AI_GATEWAY_URL, model: 'mistral/ministral-14b' });
    expect(aiTarget({ provider: 'openai-compatible' })).toEqual({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(aiTarget({ provider: 'openai-compatible', baseUrl: ' https://api.groq.com/openai/v1// ', model: ' some-model ' })).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', model: 'some-model' });
    // The gateway names its models maker/model; the default is one of them.
    expect(DEFAULT_GATEWAY_MODEL).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });

  it('passes over the OpenAI defaults that old .env files carry when the gateway is chosen', () => {
    // Written into every .env by the earlier example file. A key of the gateway must not go to OpenAI because of them.
    expect(aiTarget({ provider: 'vercel-ai-gateway', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })).toEqual({ baseUrl: VERCEL_AI_GATEWAY_URL, model: DEFAULT_GATEWAY_MODEL });
    expect(aiTarget({ provider: 'vercel-ai-gateway', baseUrl: 'https://api.openai.com/v1/', model: 'openai/gpt-4o-mini' })).toEqual({ baseUrl: VERCEL_AI_GATEWAY_URL, model: 'openai/gpt-4o-mini' });
    // With OpenAI itself they are what they always were.
    expect(aiTarget({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })).toEqual({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
  });
});

describe('where the identity of the Vercel project may be sent', () => {
  it('goes to Vercel’s AI Gateway and nowhere else on the internet', () => {
    expect(identityMayGoTo(VERCEL_AI_GATEWAY_URL)).toBe(true);
    expect(identityMayGoTo('https://ai-gateway.vercel.sh/v1/')).toBe(true);
    for (const elsewhere of [
      'https://api.openai.com/v1', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://ai-gateway.vercel.sh.example.com/v1', 'https://example.com/ai-gateway.vercel.sh/v1',
      'http://ai-gateway.vercel.sh/v1', 'https://ai-gateway.vercel.sh:8443/v1', 'https://ai-gateway.vercel.sh@example.com/v1', 'https://user:pass@ai-gateway.vercel.sh/v1', 'https://vercel.sh/v1', 'https://10.0.0.5/v1', 'http://127.0.0.1.example.com/v1', 'not an address', '',
    ]) expect([elsewhere, identityMayGoTo(elsewhere)]).toEqual([elsewhere, false]);
  });

  it('may stay on this machine, where the tests stand in for the gateway', () => {
    expect(identityMayGoTo('http://127.0.0.1:4010/v1')).toBe(true);
    expect(identityMayGoTo('http://localhost:4010/v1')).toBe(true);
    expect(identityMayGoTo('http://[::1]:4010/v1')).toBe(true);
  });
});
