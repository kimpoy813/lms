// AI provider client (OpenAI-compatible chat completions).
//
// Design rules for every AI feature in EduSphere:
//   • The key stays on the server; the browser never talks to the provider.
//   • Nothing an AI model writes reaches students by itself. Output is stored as a DRAFT that a
//     teacher has to review, can edit, and must approve explicitly.
//   • Without a configured provider the features answer 503 AI_UNAVAILABLE — nothing is faked.
import { env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

async function httpTransport({ messages, json, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs);
  try {
    const res = await fetch(`${env.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ai.apiKey}` },
      body: JSON.stringify({ model: env.ai.model, messages, temperature: 0.4, max_tokens: Math.min(maxTokens ?? env.ai.maxOutputTokens, env.ai.maxOutputTokens), ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`provider responded with HTTP ${res.status} ${detail}`);
    }
    const body = await res.json();
    return {
      content: body.choices?.[0]?.message?.content ?? '', finishReason: body.choices?.[0]?.finish_reason ?? null, model: body.model ?? env.ai.model,
      promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
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
    message: aiConfigured() ? null : 'AI assistance is not set up on this server. An administrator needs to configure an AI provider (AI_PROVIDER, AI_API_KEY).',
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
    logger.warn({ err: err.message }, 'AI request failed');
    throw new AppError(502, 'AI_FAILED', err.name === 'AbortError' ? 'The AI service took too long to answer. Please try again.' : 'The AI service could not complete the request. Please try again.');
  }
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
