// An AI service with an OpenAI-compatible "chat completions" API: one request, and what its
// refusals mean.
//
// Nothing of the application's configuration is read here. The API (services/ai.js) and the check
// that runs with every deployment (scripts/ai-check.mjs) both use it and pass what they know, so
// the check asks exactly the way the application does.

/** Vercel's AI Gateway: many models behind one address, paid from the credit of the Vercel account. */
export const VERCEL_AI_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1';

/** The model asked through the gateway unless AI_MODEL names another one. */
export const DEFAULT_GATEWAY_MODEL = 'google/gemini-2.5-flash';

/**
 * Why the AI service did not answer. `kind` is what the application decides on:
 *   identity      the key or identity token was not accepted
 *   verification  Vercel wants a payment method on the account before its free credit can be used
 *   credit        the credit is used up
 *   budget        a spending limit somebody set has been reached
 *   model         the model does not exist, or is not among those the free credit covers
 *   restricted    the account does not allow this model or provider
 *   busy          too many requests for now; the same request can succeed in a moment
 *   timeout       no answer in time
 *   network       the service could not be reached
 *   failed        anything else
 * `detail` is what the service said, for the administrator and the log — never for a teacher.
 */
export class AiProviderError extends Error {
  constructor(kind, message, { status = null, detail = '', retryAfterSeconds = null, link = null } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
    this.link = link;
  }
}

const oneLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** `retry-after` is a number of seconds or a date. Anything else is no answer. */
function retryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 3600);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), 3600);
}

/**
 * A refusal of the service → what it means. The meanings of 401, 402, 403 and 429 are those
 * Vercel documents for its AI Gateway; other services use the same status codes the same way.
 */
export function readProviderError(status, bodyText, headers) {
  let error = null;
  try {
    const body = JSON.parse(bodyText);
    error = body?.error && typeof body.error === 'object' ? body.error : typeof body?.error === 'string' ? { message: body.error } : body;
  } catch {
    // not JSON: the text itself is the detail
  }
  const type = oneLine(error?.type ?? error?.code ?? '', 80);
  const said = oneLine(error?.message ?? bodyText);
  const detail = `HTTP ${status}${type ? ` ${type}` : ''}${said ? `: ${said}` : ''}`;
  const about = `${type} ${said}`.toLowerCase();
  const options = { status, detail };

  if (status === 401) return new AiProviderError('identity', 'The AI service did not accept the key or identity it was given.', options);
  if (status === 402) {
    return type === 'quota_for_entity_exceeded'
      ? new AiProviderError('budget', 'A spending limit set for the AI service has been reached.', options)
      : new AiProviderError('credit', 'The credit for the AI service is used up.', options);
  }
  if (status === 403) {
    if (about.includes('customer_verification_required') || /payment method|verif/.test(about)) {
      const link = /https:\/\/[^\s"'<>)]+/.exec(`${error?.url ?? ''} ${error?.link ?? ''} ${error?.message ?? ''} ${bodyText}`)?.[0] ?? null;
      return new AiProviderError('verification', 'Vercel wants a payment method on the account before its free credit can be used.', { ...options, link });
    }
    if (/free.?tier/.test(about)) return new AiProviderError('model', 'This model is not among those the free credit covers.', options);
    return new AiProviderError('restricted', 'The account does not allow this request.', options);
  }
  if (status === 404) return new AiProviderError('model', 'The AI service does not know this model.', options);
  if (status === 429) return new AiProviderError('busy', 'The AI service has too many requests right now.', { ...options, retryAfterSeconds: retryAfter(headers?.get?.('retry-after')) });
  if (status === 408 || status === 504) return new AiProviderError('timeout', 'The AI service took too long to answer.', options);
  return new AiProviderError('failed', 'The AI service could not complete the request.', options);
}

/**
 * One chat completion.
 * @param {object} request
 * @param {string} request.baseUrl address of the API, without a trailing slash
 * @param {string} [request.bearer] key or identity token
 * @param {string} request.model
 * @param {{ role: string, content: string }[]} request.messages
 * @param {boolean} [request.json] ask for one JSON object as the answer
 * @param {number} [request.maxTokens]
 * @param {number} [request.timeoutMs] for the whole exchange, the answer's body included
 * @returns {Promise<{ content: string, finishReason: string | null, model: string, promptTokens: number, completionTokens: number }>}
 * @throws {AiProviderError}
 */
export async function chatCompletion({ baseUrl, bearer, model, messages, json = false, maxTokens, temperature = 0.4, timeoutMs = 120_000, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    let raw;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ model, messages, temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(json ? { response_format: { type: 'json_object' } } : {}) }),
      });
      raw = await res.text();
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw new AiProviderError('timeout', 'The AI service took too long to answer.', { detail: `no answer within ${Math.round(timeoutMs / 1000)} s` });
      throw new AiProviderError('network', 'The AI service could not be reached.', { detail: oneLine(err?.cause?.message ?? err?.message) });
    }
    if (!res.ok) throw readProviderError(res.status, raw, res.headers);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AiProviderError('failed', 'The AI service sent an answer that could not be read.', { status: res.status, detail: oneLine(raw, 200) });
    }
    const choice = body?.choices?.[0];
    return {
      content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      finishReason: choice?.finish_reason ?? null,
      model: typeof body?.model === 'string' && body.model ? body.model : model,
      promptTokens: Number(body?.usage?.prompt_tokens) || 0,
      completionTokens: Number(body?.usage?.completion_tokens) || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
