#!/usr/bin/env node
// Does the AI assistant for teachers answer?
//
//   node scripts/ai-check.mjs            one small request, asked the way the application asks
//   node scripts/ai-check.mjs --models   Vercel AI Gateway only: also list the models that suit the
//                                        assistant, try the likely ones, and show the credit left
//
// The Vercel build runs the first form when AI_PROVIDER is set (scripts/vercel-build.mjs), so the
// log of a deployment says whether the assistant works; `npm run ai:check` is the same, and
// `npm run ai:check -- --models` the second (AI_CHECK=models does the same in a build). Each
// request costs a fraction of a cent of the account's credit.
//
// Who is asking: AI_API_KEY when it is set; otherwise, for Vercel's AI Gateway, the identity of
// the Vercel project (VERCEL_OIDC_TOKEN: a build has it, `vercel env pull` writes it).
//
// Exit code: 0 when the assistant answered, 1 otherwise. The build treats 1 as a warning.
import { resolveIdentity } from '../backend/src/lib/vercelIdentity.js';
import { AiProviderError, aiTarget, chatCompletion, identityMayGoTo } from '../backend/src/services/aiProvider.js';

const listModels = process.argv.includes('--models') || process.env.AI_CHECK === 'models';
const say = (line = '') => console.log(`  ${line}`);
const env = (name) => process.env[name]?.trim() || '';

const provider = env('AI_PROVIDER') || (listModels ? 'vercel-ai-gateway' : 'none');
const gateway = provider === 'vercel-ai-gateway';
const { baseUrl, model } = aiTarget({ provider, baseUrl: env('AI_BASE_URL'), model: env('AI_MODEL') });

if (provider === 'none') {
  say('AI_PROVIDER is not set: the assistant is switched off, nothing to check.');
  process.exit(0);
}

let bearer = env('AI_API_KEY');
let who = 'the key in AI_API_KEY';
if (!bearer && gateway && !identityMayGoTo(baseUrl)) {
  say('✗ AI_BASE_URL points away from Vercel’s AI Gateway: the identity of the Vercel project is not sent there. Remove AI_BASE_URL, or set AI_API_KEY to a key of that service.');
  process.exit(1);
}
if (!bearer && gateway) {
  const identity = resolveIdentity();
  if (identity.problem) say(`! ${identity.problem}`);
  bearer = identity.credentials?.token ?? '';
  who = identity.source;
}
if (!bearer) {
  say(gateway ? '✗ No identity to ask with. On Vercel the build has one by itself; elsewhere run `vercel env pull` first, or set AI_API_KEY to a key of the AI Gateway.' : '✗ AI_API_KEY is not set.');
  process.exit(1);
}

const SYSTEM = 'You are an instructional designer helping a college teacher. Answer with one JSON object and nothing else.';
const QUESTION = 'Answer with this JSON object, filled in: { "ok": true, "capital": the capital city of the Philippines, "question": one short multiple-choice question about photosynthesis, "choices": [four short answers], "correct": the index of the right one }';

/** One request the way services/ai.js asks for a draft. */
async function ask(modelId, { timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  try {
    const out = await chatCompletion({ baseUrl, bearer, model: modelId, json: true, maxTokens: 2000, timeoutMs, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: QUESTION }] });
    const ms = Date.now() - started;
    let data = null;
    try {
      data = JSON.parse(out.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch {
      // judged below
    }
    const good = Boolean(data) && typeof data === 'object' && /manila/i.test(String(data.capital ?? '')) && Array.isArray(data.choices) && data.choices.length === 4;
    return { ok: good, ms, out, problem: good ? null : `answered, but not with the JSON that was asked for (${out.finishReason ?? 'no finish reason'}): ${out.content.replace(/\s+/g, ' ').slice(0, 160) || '(nothing)'}` };
  } catch (err) {
    if (err instanceof AiProviderError) return { ok: false, ms: Date.now() - started, error: err, problem: `${err.message} [${err.kind}] ${err.detail}` };
    return { ok: false, ms: Date.now() - started, problem: String(err?.message ?? err) };
  }
}

const perMillion = (price) => (price === undefined || price === null ? '?' : `$${(Number(price) * 1e6).toFixed(2)}`);

async function showModels() {
  let catalogue;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(30_000) });
    catalogue = (await res.json()).data ?? [];
  } catch (err) {
    say(`! The list of models could not be read: ${err.message}`);
    return;
  }
  const keys = new Set();
  for (const m of catalogue) for (const k of Object.keys(m)) keys.add(k);
  say(`${catalogue.length} models in the catalogue; what it says about each: ${[...keys].join(', ')}`);

  // What the assistant needs: text in and out, an answer as JSON, room for a whole module, a small price.
  const suits = catalogue.filter((m) => m.type === 'language'
    && (m.supported_parameters ?? []).includes('response_format')
    && Number(m.context_window) >= 32_000 && Number(m.max_tokens) >= 8_000
    && Number(m.pricing?.input ?? 1) <= 0.6e-6 && Number(m.pricing?.output ?? 1) <= 3e-6);
  suits.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  say(`${suits.length} of them suit the assistant (JSON answers, 32k context, 8k output, at most $0.60 in and $3 out per million tokens):`);
  for (const m of suits) {
    const released = m.released ? new Date(m.released * 1000).toISOString().slice(0, 7) : '?';
    say(`· ${m.id} | in ${perMillion(m.pricing?.input)} out ${perMillion(m.pricing?.output)} | ctx ${Math.round(m.context_window / 1000)}k max ${Math.round(m.max_tokens / 1000)}k | ${released} | train:${m.no_training ?? '?'} zdr:${m.zdr ?? '?'} | ${(m.tags ?? []).join(',')}`);
  }

  // Try the newest two of each well-known maker, the free ones, and the configured model.
  const makers = ['google', 'openai', 'anthropic', 'meta', 'mistral', 'deepseek', 'alibaba', 'xai', 'amazon', 'nvidia', 'moonshotai', 'zai', 'minimax'];
  const tryThese = new Set([model]);
  for (const maker of makers) {
    const theirs = suits.filter((m) => m.owned_by === maker || String(m.id).startsWith(`${maker}/`)).sort((a, b) => (b.released ?? 0) - (a.released ?? 0));
    for (const m of theirs.slice(0, 2)) tryThese.add(m.id);
  }
  for (const m of suits) if (Number(m.pricing?.input) === 0 && Number(m.pricing?.output) === 0) tryThese.add(m.id);
  say('');
  say(`Trying ${tryThese.size} of them with ${who}:`);
  for (const id of tryThese) {
    const r = await ask(id, { timeoutMs: 45_000 });
    say(r.ok ? `✓ ${id}: ${r.ms} ms, ${r.out.promptTokens} tokens in, ${r.out.completionTokens} out${r.out.model !== id ? ` (answered as ${r.out.model})` : ''}` : `✗ ${id}: ${r.problem}`);
  }

  try {
    const res = await fetch(`${baseUrl}/credits`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) });
    say('');
    say(`credit: HTTP ${res.status} ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  } catch (err) {
    say(`! The credit could not be read: ${err.message}`);
  }
  say('');
}

say(`${gateway ? "Vercel's AI Gateway" : baseUrl}, model ${model}, asked with ${who}`);
if (listModels && gateway) await showModels();

const result = await ask(model);
if (result.ok) {
  say(`✓ The assistant answers: ${result.out.model}, ${(result.ms / 1000).toFixed(1)} s, ${result.out.promptTokens} tokens in and ${result.out.completionTokens} out.`);
  process.exit(0);
}
say(`✗ ${result.problem}`);
const advice = {
  verification: `Vercel gives its free credit only to accounts with a payment method on file. Add one${result.error?.link ? ` (${result.error.link})` : ' (Vercel dashboard → AI Gateway)'}, or use another AI service: AI_PROVIDER=openai-compatible with AI_BASE_URL, AI_API_KEY and AI_MODEL.`,
  credit: 'This month’s credit is used up. It comes back by itself; the assistant says so to teachers until then.',
  budget: 'A budget set in the Vercel dashboard (AI Gateway → Budgets) has been reached.',
  model: `Choose another model with AI_MODEL. Vercel's free credit covers only some models (https://vercel.com/ai-gateway/models?freeTier=true); \`npm run ai:check -- --models\` lists the ones that suit the assistant and tries the likely ones.`,
  identity: gateway ? 'On Vercel the project’s identity is used; anywhere else AI_API_KEY must hold a key of the AI Gateway.' : 'Check AI_API_KEY.',
  busy: 'Too many requests for the moment. Nothing is wrong with the set-up.',
}[result.error?.kind];
if (advice) say(`  ${advice}`);
process.exit(1);
