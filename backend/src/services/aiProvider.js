// An AI service with an OpenAI-compatible "chat completions" API: one request, and what its
// refusals mean.
//
// Nothing of the application's configuration is read here. The API (services/ai.js) and the check
// that runs with every deployment (scripts/ai-check.mjs) both use it and pass what they know, so
// the check asks exactly the way the application does.

/** Vercel's AI Gateway: many models behind one address, paid from the credit of the Vercel account. */
export const VERCEL_AI_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1';

/**
 * Vercel's list of the models its monthly free credit covers: a part of the catalogue, not all of
 * it (https://vercel.com/docs/ai-gateway/pricing). The catalogue the API returns does not say
 * which, so a model outside it is found out by asking; this is where the administrator is sent.
 */
export const VERCEL_FREE_TIER_MODELS = 'https://vercel.com/ai-gateway/models?freeTier=true';

/**
 * The model asked through the gateway unless AI_MODEL names another one. Chosen from what
 * Vercel's lists said on 2026-11-13 — no model has answered this project yet (Vercel refuses
 * every request until a payment card is on the account), so none of this was seen at work:
 *   - it was on Vercel's list of models the free credit covers (the address above); the small
 *     models of Anthropic, Google and OpenAI were not;
 *   - the gateway's catalogue gave $0.10 per million tokens in and $0.50 out, by which a quiz
 *     drafted from a whole module would cost about a fifth of a cent of the monthly $5 (an
 *     estimate from the price list, not a measured cost);
 *   - the catalogue gave it room for a million tokens of material and answers as JSON;
 *   - the catalogue listed every provider behind it as neither keeping what it is sent nor
 *     training on it (zdr: all, no_training: all).
 * Lists and prices change: `npm run ai:check -- --models` shows the catalogue as it is and tries
 * the likely models, and "Check now" under Administration → Settings says whether this one answers.
 */
export const DEFAULT_GATEWAY_MODEL = 'meta/muse-ember';

const OPENAI_URL = 'https://api.openai.com/v1';
const OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Where a configuration points and which model it asks for.
 *
 * `.env` files made before Vercel's gateway could be chosen carry OpenAI's address and model,
 * written there as defaults and never anyone's choice. With the gateway those two values are
 * passed over, so that changing AI_PROVIDER is all it takes, and a key of the gateway is not
 * sent to OpenAI by a line nobody remembers.
 * @param {{ provider?: string, baseUrl?: string, model?: string }} configured
 */
export function aiTarget({ provider, baseUrl, model }) {
  const givenUrl = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const givenModel = String(model ?? '').trim();
  if (provider !== 'vercel-ai-gateway') return { baseUrl: givenUrl || OPENAI_URL, model: givenModel || OPENAI_MODEL };
  return {
    baseUrl: givenUrl && givenUrl !== OPENAI_URL ? givenUrl : VERCEL_AI_GATEWAY_URL,
    model: givenModel && givenModel !== OPENAI_MODEL ? givenModel : DEFAULT_GATEWAY_MODEL,
  };
}

/**
 * May the identity of the Vercel project be sent to this address? Only to Vercel's AI Gateway,
 * and to this machine itself (which is how the tests stand in for the gateway). The token is a
 * credential of the Vercel project for as long as it lasts: an AI_BASE_URL that points somewhere
 * else must not hand it over.
 */
export function identityMayGoTo(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:' && url.hostname === 'ai-gateway.vercel.sh' && !url.port) return true;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Why the AI service did not answer. `kind` is what the application decides on:
 *   identity      the key or identity token was not accepted
 *   verification  Vercel wants a payment method on the account before its free credit can be used
 *   credit        the credit is used up
 *   budget        a spending limit somebody set has been reached
 *   model         the model does not exist, or is not among those the free credit covers
 *   restricted    the account does not allow this model or provider
 *   size          the request is more than the model takes at once
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
 * Vercel documents for its AI Gateway (https://vercel.com/docs/ai-gateway/faq, "Why did my AI
 * Gateway request fail?"); other services use the same status codes the same way.
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
      // Vercel's own word for it; another service asking for the same is not Vercel.
      const message = about.includes('customer_verification_required')
        ? 'Vercel wants a payment method on the account before its free credit can be used.'
        : 'The AI service wants the account verified, or a payment method added, before it answers.';
      return new AiProviderError('verification', message, { ...options, link });
    }
    if (/free.?tier/.test(about)) {
      return new AiProviderError('model', 'This model is not among those Vercel’s free credit covers. Set AI_MODEL to one that is.', { ...options, link: VERCEL_FREE_TIER_MODELS });
    }
    return new AiProviderError('restricted', 'The account does not allow this request.', options);
  }
  if (status === 404) return new AiProviderError('model', 'The AI service does not know this model.', options);
  // More text than the model reads at once, or than a free allowance lets through in one request.
  // (A complaint about the length of the answer that was asked for is not that: AI_MAX_OUTPUT_TOKENS.)
  const aboutTheAnswer = /max_(completion_|output_)?tokens/.test(about);
  if (status === 413 || (status === 400 && !aboutTheAnswer && /context.{0,12}(length|window|size)|too (large|long)|too many tokens|maximum.{0,24}tokens|reduce the (length|size)/.test(about))) {
    return new AiProviderError('size', 'The request is more than this model takes at once.', options);
  }
  if (status === 429) return new AiProviderError('busy', 'The AI service has too many requests right now.', { ...options, retryAfterSeconds: retryAfter(headers?.get?.('retry-after')) });
  if (status === 408 || status === 504) return new AiProviderError('timeout', 'The AI service took too long to answer.', options);
  return new AiProviderError('failed', 'The AI service could not complete the request.', options);
}

// Parts of a request that some models refuse although most take them: a temperature other than
// their own, `max_tokens` under its older name, an answer promised as JSON. The service says which
// one it minds (HTTP 400); the request is then asked again without it, and once that has worked
// the next requests to the same model leave it out from the start. Nothing the answer depends on
// is lost: the prompts ask for JSON in words too, and the answer is checked either way.
const ADJUSTMENTS = [
  { name: 'temperature', named: /temperature/i, applies: (body) => 'temperature' in body, apply: (body) => { delete body.temperature; } },
  { name: 'max_completion_tokens', named: /max_tokens|max_completion_tokens/i, applies: (body) => 'max_tokens' in body, apply: (body) => { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; } },
  { name: 'response_format', named: /response_format|json_object|json mode/i, applies: (body) => 'response_format' in body, apply: (body) => { delete body.response_format; } },
];
/** What has been learned about a model: `baseUrl model` → names of the adjustments it needs. */
const learned = new Map();
/** Tests start from nothing learned. */
export const forgetAdjustments = () => learned.clear();

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
  const about = `${baseUrl} ${model}`;
  const request = { model, messages, temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(json ? { response_format: { type: 'json_object' } } : {}) };
  for (const adjustment of ADJUSTMENTS) if (learned.get(about)?.has(adjustment.name) && adjustment.applies(request)) adjustment.apply(request);
  const adjusted = [];
  try {
    let res;
    let raw;
    for (;;) {
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          body: JSON.stringify(request),
        });
        raw = await res.text();
      } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw new AiProviderError('timeout', 'The AI service took too long to answer.', { detail: `no answer within ${Math.round(timeoutMs / 1000)} s` });
        throw new AiProviderError('network', 'The AI service could not be reached.', { detail: oneLine(err?.cause?.message ?? err?.message) });
      }
      if (res.ok) break;
      const refusal = readProviderError(res.status, raw, res.headers);
      // Each adjustment is tried once, so this ends after at most three more requests.
      const adjustment = res.status === 400 && refusal.kind === 'failed' ? ADJUSTMENTS.find((a) => a.applies(request) && a.named.test(refusal.detail)) : null;
      if (!adjustment) throw refusal;
      adjustment.apply(request);
      adjusted.push(adjustment.name);
    }
    // It answered: what had to be left out is remembered for this model.
    if (adjusted.length > 0) learned.set(about, new Set([...(learned.get(about) ?? []), ...adjusted]));
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
