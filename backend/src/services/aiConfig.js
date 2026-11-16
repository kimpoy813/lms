// Runtime AI provider configuration persisted in PostgreSQL (SystemSetting 'ai.providerConfig').
//
// Keeps API keys server-side and encrypted with AES-256-GCM using a key derived from server
// environment secrets (AI_SETTINGS_SECRET -> CRON_SECRET -> DATABASE_URL), so database dumps never
// reveal raw keys and browsers never receive them. Falls back cleanly to environment defaults
// (`AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) when mode is 'env' or unset.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { fieldErrors } from '../lib/errors.js';
import { AI_PRESETS, BUILTIN_MODEL, aiTarget } from './aiProvider.js';

export const AI_CONFIG_KEY = 'ai.providerConfig';
const CACHE_TTL_MS = 10_000;

let cache = { at: 0, stored: undefined };

export function invalidateAiConfigCache() {
  cache = { at: 0, stored: undefined };
}

function encryptionKey() {
  const material = env.ai.settingsSecret ?? env.cronSecret ?? env.databaseUrl;
  return createHmac('sha256', String(material)).update('edusphere:ai-config:v1').digest();
}

export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(serialized) {
  if (!serialized || typeof serialized !== 'string') return { ok: false, corrupted: false, value: null };
  const parts = serialized.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, corrupted: true, value: null };
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
    return { ok: true, corrupted: false, value: plain };
  } catch {
    return { ok: false, corrupted: true, value: null };
  }
}

export function secretHint(secret) {
  const s = String(secret ?? '').trim();
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function isLoopbackUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function validateAiBaseUrl(rawUrl, { onVercel = env.platform === 'vercel' } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { ok: false, error: 'Enter a valid URL starting with https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not include credentials in the API URL.' };
  }
  if (url.protocol === 'https:') {
    return { ok: true, url: url.href.replace(/\/+$/, '') };
  }
  if (url.protocol === 'http:' && !onVercel && isLoopbackUrl(url.href)) {
    return { ok: true, url: url.href.replace(/\/+$/, '') };
  }
  return { ok: false, error: onVercel ? 'Use an https:// URL for external AI services.' : 'Use https:// (or http://localhost for local models).' };
}

async function readStoredRow() {
  if (cache.stored !== undefined && Date.now() - cache.at < CACHE_TTL_MS) return cache.stored;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: AI_CONFIG_KEY }, select: { value: true } });
    const value = row?.value && typeof row.value === 'object' ? row.value : null;
    cache = { at: Date.now(), stored: value };
    return value;
  } catch {
    // Allow isolated tests without a live DB connection to inspect env defaults cleanly.
    return null;
  }
}

function resolveEnvConfig() {
  if (env.ai.provider === 'builtin') {
    return {
      source: 'env',
      mode: 'env',
      preset: null,
      provider: 'builtin',
      configured: true,
      baseUrl: null,
      model: BUILTIN_MODEL,
      apiKey: null,
      usesProjectIdentity: false,
      askedWith: 'built-in',
      timeoutMs: env.ai.timeoutMs,
      maxOutputTokens: env.ai.maxOutputTokens,
      inputCostPer1k: env.ai.inputCostPer1k,
      outputCostPer1k: env.ai.outputCostPer1k,
      hasApiKey: false,
      apiKeyHint: null,
      keyCorrupted: false,
    };
  }
  const configured = env.ai.configured;
  return {
    source: 'env',
    mode: 'env',
    preset: null,
    provider: env.ai.provider,
    configured,
    baseUrl: configured ? env.ai.baseUrl : null,
    model: configured ? env.ai.model : null,
    apiKey: env.ai.apiKey ?? null,
    usesProjectIdentity: env.ai.usesProjectIdentity,
    askedWith: configured ? (env.ai.usesProjectIdentity ? 'project identity' : 'key') : null,
    timeoutMs: env.ai.timeoutMs,
    maxOutputTokens: env.ai.maxOutputTokens,
    inputCostPer1k: env.ai.inputCostPer1k,
    outputCostPer1k: env.ai.outputCostPer1k,
    hasApiKey: Boolean(env.ai.apiKey),
    apiKeyHint: env.ai.apiKey ? secretHint(env.ai.apiKey) : null,
    keyCorrupted: false,
  };
}

/** Resolve the effective AI configuration across DB SystemSetting and env defaults. */
export async function getEffectiveAiConfig() {
  const stored = await readStoredRow();
  if (!stored || stored.mode === 'env' || !stored.mode) {
    return resolveEnvConfig();
  }
  if (stored.mode === 'off') {
    return {
      source: 'settings',
      mode: 'off',
      preset: null,
      provider: 'none',
      configured: false,
      baseUrl: null,
      model: null,
      apiKey: null,
      usesProjectIdentity: false,
      askedWith: null,
      timeoutMs: env.ai.timeoutMs,
      maxOutputTokens: env.ai.maxOutputTokens,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      hasApiKey: Boolean(stored.apiKeyCipher),
      apiKeyHint: stored.apiKeyHint ?? null,
      keyCorrupted: false,
    };
  }
  if (stored.mode === 'builtin') {
    return {
      source: 'settings',
      mode: 'builtin',
      preset: null,
      provider: 'builtin',
      configured: true,
      baseUrl: null,
      model: BUILTIN_MODEL,
      apiKey: null,
      usesProjectIdentity: false,
      askedWith: 'built-in',
      timeoutMs: env.ai.timeoutMs,
      maxOutputTokens: env.ai.maxOutputTokens,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      hasApiKey: Boolean(stored.apiKeyCipher),
      apiKeyHint: stored.apiKeyHint ?? null,
      keyCorrupted: false,
    };
  }
  if (stored.mode === 'openai-compatible') {
    const presetObj = stored.preset && AI_PRESETS[stored.preset] ? AI_PRESETS[stored.preset] : null;
    const target = aiTarget({
      provider: 'openai-compatible',
      baseUrl: stored.baseUrl || presetObj?.baseUrl,
      model: stored.model || presetObj?.defaultModel,
    });
    const decrypted = stored.apiKeyCipher ? decryptSecret(stored.apiKeyCipher) : { ok: false, corrupted: false, value: null };
    const localNoKey = isLoopbackUrl(target.baseUrl);
    const configured = Boolean(decrypted.ok && decrypted.value) || localNoKey;
    return {
      source: 'settings',
      mode: 'openai-compatible',
      preset: stored.preset ?? 'custom',
      provider: 'openai-compatible',
      configured,
      baseUrl: target.baseUrl,
      model: target.model,
      apiKey: decrypted.ok ? decrypted.value : null,
      usesProjectIdentity: false,
      askedWith: configured ? (decrypted.ok && decrypted.value ? 'key' : 'local') : null,
      timeoutMs: env.ai.timeoutMs,
      maxOutputTokens: env.ai.maxOutputTokens,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      hasApiKey: Boolean(stored.apiKeyCipher),
      apiKeyHint: stored.apiKeyHint ?? null,
      keyCorrupted: Boolean(stored.apiKeyCipher) && decrypted.corrupted,
    };
  }
  return resolveEnvConfig();
}

/** Safe, secret-free view for Administration -> Settings. */
export async function getAdminAiConfigView() {
  const stored = (await readStoredRow()) ?? {};
  const effective = await getEffectiveAiConfig();
  const envView = resolveEnvConfig();
  const decrypted = stored.apiKeyCipher ? decryptSecret(stored.apiKeyCipher) : { ok: false, corrupted: false };
  return {
    mode: stored.mode ?? 'env',
    preset: stored.preset ?? 'gemini',
    baseUrl: stored.baseUrl ?? AI_PRESETS.gemini.baseUrl,
    model: stored.model ?? AI_PRESETS.gemini.defaultModel,
    hasApiKey: Boolean(stored.apiKeyCipher),
    apiKeyHint: stored.apiKeyHint ?? null,
    keyCorrupted: Boolean(stored.apiKeyCipher) && decrypted.corrupted,
    effective: {
      source: effective.source,
      configured: effective.configured,
      provider: effective.provider,
      model: effective.model,
      askedWith: effective.askedWith,
      baseUrl: effective.baseUrl,
    },
    env: {
      provider: envView.provider,
      configured: envView.configured,
      model: envView.model,
      askedWith: envView.askedWith,
    },
    presets: Object.values(AI_PRESETS),
  };
}

export const updateAiConfigSchema = z.object({
  mode: z.enum(['env', 'builtin', 'openai-compatible', 'off']),
  preset: z.enum(['gemini', 'groq', 'openrouter', 'custom']).nullable().optional(),
  baseUrl: z.string().trim().max(400).nullable().optional(),
  model: z.string().trim().max(160).nullable().optional(),
  apiKey: z.string().trim().max(500).optional(),
  clearApiKey: z.boolean().optional(),
});

export async function updateAiConfig(input, userId) {
  const existing = (await readStoredRow()) ?? {};
  let nextCipher = existing.apiKeyCipher ?? null;
  let nextHint = existing.apiKeyHint ?? null;

  if (input.clearApiKey) {
    nextCipher = null;
    nextHint = null;
  }
  if (input.apiKey) {
    nextCipher = encryptSecret(input.apiKey);
    nextHint = secretHint(input.apiKey);
  }

  let nextPreset = input.preset ?? existing.preset ?? 'gemini';
  let nextBaseUrl = input.baseUrl ?? existing.baseUrl ?? AI_PRESETS[nextPreset]?.baseUrl ?? AI_PRESETS.gemini.baseUrl;
  let nextModel = input.model ?? existing.model ?? AI_PRESETS[nextPreset]?.defaultModel ?? AI_PRESETS.gemini.defaultModel;

  if (input.mode === 'openai-compatible') {
    const presetObj = AI_PRESETS[nextPreset] ?? AI_PRESETS.custom;
    nextBaseUrl = String(input.baseUrl || presetObj.baseUrl).trim();
    nextModel = String(input.model || presetObj.defaultModel).trim();

    const checkedUrl = validateAiBaseUrl(nextBaseUrl);
    if (!checkedUrl.ok) throw fieldErrors({ baseUrl: checkedUrl.error });
    nextBaseUrl = checkedUrl.url;

    if (!nextModel) throw fieldErrors({ model: 'Enter a model name.' });

    const decrypted = nextCipher ? decryptSecret(nextCipher) : { ok: false };
    if (!decrypted.ok && !isLoopbackUrl(nextBaseUrl)) {
      throw fieldErrors({
        apiKey: decrypted.corrupted
          ? 'The stored API key could not be decrypted. Enter a new key to continue.'
          : 'Enter an API key for this service.',
      });
    }
  } else {
    nextPreset = input.preset ?? existing.preset ?? 'gemini';
  }

  const nextValue = {
    mode: input.mode,
    preset: nextPreset,
    baseUrl: nextBaseUrl,
    model: nextModel,
    apiKeyCipher: nextCipher,
    apiKeyHint: nextHint,
  };

  await prisma.systemSetting.upsert({
    where: { key: AI_CONFIG_KEY },
    create: { key: AI_CONFIG_KEY, value: nextValue, updatedById: userId ?? null },
    update: { value: nextValue, updatedById: userId ?? null },
  });
  cache = { at: Date.now(), stored: nextValue };
  return getAdminAiConfigView();
}
