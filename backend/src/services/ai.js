// The AI service behind the teacher's assistant (OpenAI-compatible chat completions): either any
// service with a key, or Vercel's AI Gateway asked with the identity of the Vercel project.
//
// Design rules for every AI feature in EduSphere:
//   • The key stays on the server; the browser never talks to the provider.
//   • Nothing an AI model writes reaches students by itself. Output is stored as a DRAFT that a
//     teacher has to review, can edit, and must approve explicitly.
//   • Without a configured provider the features answer 503 AI_UNAVAILABLE — nothing is faked.
import { env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { platformIdentityToken } from '../lib/vercel.js';
import { resolveIdentity } from '../lib/vercelIdentity.js';
import { AiProviderError, chatCompletion, identityMayGoTo } from './aiProvider.js';

/**
 * What the service is asked with: the key of the configuration, or for Vercel's AI Gateway the
 * identity of the Vercel project, which Vercel hands to every request (and replaces every hour,
 * so it is read each time and never kept).
 */
function bearer() {
  if (env.ai.apiKey) return env.ai.apiKey;
  if (!env.ai.usesProjectIdentity) return '';
  // The identity is for Vercel's gateway alone; an address that leads elsewhere does not get it.
  if (!identityMayGoTo(env.ai.baseUrl)) {
    throw new AiProviderError('identity', 'The identity of the Vercel project is only used with Vercel’s AI Gateway.', { detail: 'AI_BASE_URL points somewhere else. Remove it to ask Vercel’s AI Gateway, or set AI_API_KEY to a key of the service it names.' });
  }
  const identity = resolveIdentity({ requestToken: platformIdentityToken() });
  if (!identity.credentials) {
    throw new AiProviderError('identity', 'The Vercel project has no identity to ask the AI Gateway with.', { detail: identity.problem ?? 'no identity token came with this request (Vercel: Project Settings → Security → Secure Backend Access with OIDC)' });
  }
  return identity.credentials.token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A second try is only worth starting with this much of the time left. */
const WORTH_ASKING_AGAIN_MS = 10_000;

async function httpTransport({ messages, json, maxTokens }) {
  // AI_TIMEOUT_MS is the time for the whole exchange, a second try included: on Vercel the
  // request itself is cut off soon after, and the teacher should get this application's answer.
  const deadline = Date.now() + env.ai.timeoutMs;
  const request = { baseUrl: env.ai.baseUrl, model: env.ai.model, messages, json, maxTokens: Math.min(maxTokens ?? env.ai.maxOutputTokens, env.ai.maxOutputTokens) };
  try {
    return await chatCompletion({ ...request, bearer: bearer(), timeoutMs: env.ai.timeoutMs });
  } catch (err) {
    // Free allowances count requests per minute. A short wait is often all it takes; a long one
    // is the teacher's to decide.
    if (!(err instanceof AiProviderError) || err.kind !== 'busy') throw err;
    const waitMs = (err.retryAfterSeconds ?? 3) * 1000;
    if (waitMs > 8000 || deadline - Date.now() - waitMs < WORTH_ASKING_AGAIN_MS) throw err;
    await sleep(waitMs);
    return chatCompletion({ ...request, bearer: bearer(), timeoutMs: deadline - Date.now() });
  }
}

/**
 * A link is shown to the administrator only when it leads to Vercel's own site, which is who
 * names one. What a service writes in an error is not trusted any further than that.
 */
export function vercelPage(link) {
  try {
    const url = new URL(String(link ?? ''));
    return url.protocol === 'https:' && url.hostname === 'vercel.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

// What this instance of the API saw last, for the administrator (each instance has its own view).
const health = { lastSuccessAt: null, lastFailureAt: null, lastFailure: null };
export const aiHealth = () => ({ ...health });

/** A refusal of the service → what the teacher is told. What the service said goes to the log and to the administrator. */
function providerProblem(err) {
  const known = err instanceof AiProviderError;
  health.lastFailureAt = new Date().toISOString();
  health.lastFailure = known ? { kind: err.kind, message: err.message, detail: err.detail || null, link: vercelPage(err.link) } : { kind: 'failed', message: 'The AI service could not complete the request.', detail: String(err?.message ?? err).slice(0, 300), link: null };
  logger.warn({ kind: health.lastFailure.kind, detail: health.lastFailure.detail }, 'AI request failed');
  const kind = health.lastFailure.kind;
  if (kind === 'busy') return new AppError(503, 'AI_BUSY', 'The AI service has too many requests right now. Wait a minute, then try again.', { retryAfterSeconds: known ? err.retryAfterSeconds ?? 60 : 60 });
  if (kind === 'timeout' || err?.name === 'AbortError') return new AppError(502, 'AI_FAILED', 'The AI service took too long to answer. Please try again.');
  if (kind === 'size') return new AppError(422, 'AI_TOO_LARGE', 'That is more than the AI service set up here takes at once. Ask for fewer items, or draft from a topic or a shorter module.');
  // The account or the configuration: trying again does not help, an administrator has to look.
  if (['identity', 'verification', 'credit', 'budget', 'model', 'restricted'].includes(kind)) {
    return new AppError(503, 'AI_NEEDS_ATTENTION', 'The AI service did not accept the request, and trying again will not help. An administrator can see the reason under Administration → Settings.');
  }
  return new AppError(502, 'AI_FAILED', 'The AI service could not complete the request. Please try again.');
}

let transport = null;
/** Tests replace the provider with a fake. Pass null to restore the default. */
export function setAiTransport(fn) {
  transport = fn;
}

export const aiConfigured = () => Boolean(transport) || env.ai.configured;

export function aiStatus() {
  return {
    configured: aiConfigured(),
    model: aiConfigured() ? (transport ? 'test-model' : env.ai.model) : null,
    message: aiConfigured() ? null : 'AI assistance is not set up on this server. An administrator needs to choose an AI service (AI_PROVIDER; see the deployment guide).',
  };
}

const cost = (promptTokens, completionTokens) => Math.round(((promptTokens / 1000) * env.ai.inputCostPer1k + (completionTokens / 1000) * env.ai.outputCostPer1k) * 1e6) / 1e6;

/**
 * One chat completion.
 * @returns {Promise<{ content: string, model: string, promptTokens: number, completionTokens: number, estimatedCost: number }>}
 */
export async function chat({ system, user, json = false, maxTokens }) {
  if (!aiConfigured()) throw unavailable('AI assistance is not set up on this server.', 'AI_UNAVAILABLE');
  let out;
  try {
    out = await (transport ?? httpTransport)({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], json, maxTokens });
  } catch (err) {
    throw providerProblem(err);
  }
  health.lastSuccessAt = new Date().toISOString();
  if (!out.content || !String(out.content).trim()) throw new AppError(502, 'AI_FAILED', 'The AI service returned an empty answer. Please try again.');
  if (out.finishReason === 'length' && json) throw new AppError(502, 'AI_FAILED', 'The answer was cut off because it was too long. Ask for a shorter module or fewer items.');
  return { content: String(out.content), model: out.model ?? 'unknown', promptTokens: out.promptTokens ?? 0, completionTokens: out.completionTokens ?? 0, estimatedCost: cost(out.promptTokens ?? 0, out.completionTokens ?? 0) };
}

/** Chat completion whose answer must be a JSON object. Code fences around the JSON are tolerated. */
export async function chatJson(options) {
  const out = await chat({ ...options, json: true });
  const text = out.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { ...out, data };
  } catch {
    throw new AppError(502, 'AI_FAILED', 'The AI service returned an answer that could not be read. Please try again.');
  }
}

/**
 * Is the AI service in working order? One small request, asked the way a draft is asked for.
 * Never throws: the answer says what happened, for the administrator.
 * @returns {Promise<{ ok: boolean, provider: string, model: string | null, askedWith: string | null, ms?: number, answer?: string, failure?: object }>}
 */
export async function checkAi() {
  const about = { provider: transport ? 'test' : env.ai.provider, model: aiStatus().model, askedWith: transport ? 'test' : env.ai.configured ? (env.ai.usesProjectIdentity ? 'project identity' : 'key') : null };
  if (!aiConfigured()) return { ok: false, ...about, failure: { kind: 'off', message: 'No AI service is set up.', detail: null, link: null } };
  const started = Date.now();
  try {
    const out = await chatJson({
      system: 'You are an instructional designer helping a college teacher. Answer with one JSON object and nothing else.',
      user: 'Answer with this JSON object, filled in: { "ok": true, "question": one short multiple-choice question about photosynthesis, "choices": [four short answers], "correct": the index of the right one }',
      // Room to think: models that reason first count that against the length of the answer.
      maxTokens: 2000,
    });
    const usable = typeof out.data.question === 'string' && Array.isArray(out.data.choices) && out.data.choices.length >= 2;
    return usable
      ? { ok: true, ...about, model: out.model, ms: Date.now() - started, answer: String(out.data.question).slice(0, 200) }
      : { ok: false, ...about, model: out.model, ms: Date.now() - started, failure: { kind: 'failed', message: 'The AI service answered, but not with what was asked for. Another model may do better.', detail: out.content.slice(0, 200), link: null } };
  } catch (err) {
    // chat() has noted what the service said; an answer that could not be read has only its message.
    const noted = health.lastFailureAt && Date.parse(health.lastFailureAt) >= started ? health.lastFailure : null;
    return { ok: false, ...about, ms: Date.now() - started, failure: noted ?? { kind: 'failed', message: err.message, detail: null, link: null } };
  }
}
