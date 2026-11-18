// Which AI service the configuration describes, and whether there is something to ask it with
// (config/env.js). The configuration is read once when the application starts, so each case
// loads it anew with its own environment.
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GATEWAY_MODEL, BUILTIN_MODEL, VERCEL_AI_GATEWAY_URL } from '../../src/services/aiProvider.js';
import { decryptSecret, encryptSecret, validateAiBaseUrl } from '../../src/services/aiConfig.js';

const KEYS = ['VERCEL', 'VERCEL_ENV', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN', 'NODE_ENV', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS', 'CODE_RUNNER_PROVIDER'];
const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of KEYS) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The AI part of the configuration, as the application would read it in this environment. */
async function aiWith(vars) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  vi.resetModules();
  const { env } = await import('../../src/config/env.js');
  return env.ai;
}
const ON_VERCEL = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: 'prj_site', NODE_ENV: 'test' };

describe('the AI service in the configuration', () => {
  it('is off unless one is chosen, whatever else is set', async () => {
    expect(await aiWith({})).toMatchObject({ provider: 'none', configured: false, usesProjectIdentity: false });
    expect(await aiWith({ AI_API_KEY: 'key', AI_MODEL: 'some-model', AI_BASE_URL: 'https://ai.example/v1' })).toMatchObject({ provider: 'none', configured: false });
    expect(await aiWith({ ...ON_VERCEL })).toMatchObject({ provider: 'none', configured: false, usesProjectIdentity: false });
    expect(await aiWith({ ...ON_VERCEL, AI_PROVIDER: 'none', AI_API_KEY: 'key' })).toMatchObject({ configured: false });
  });

  it('Vercel’s AI Gateway needs no key on Vercel, where the project’s identity is used', async () => {
    const ai = await aiWith({ ...ON_VERCEL, AI_PROVIDER: 'vercel-ai-gateway' });
    expect(ai).toMatchObject({ provider: 'vercel-ai-gateway', configured: true, usesProjectIdentity: true, apiKey: undefined, baseUrl: VERCEL_AI_GATEWAY_URL, model: DEFAULT_GATEWAY_MODEL });
    expect(VERCEL_AI_GATEWAY_URL).toBe('https://ai-gateway.vercel.sh/v1');
    // A preview deployment has an identity too.
    expect(await aiWith({ ...ON_VERCEL, VERCEL_ENV: 'preview', AI_PROVIDER: 'vercel-ai-gateway' })).toMatchObject({ configured: true, usesProjectIdentity: true });
  });

  it('Vercel’s AI Gateway with a key is asked with the key, on Vercel and anywhere else', async () => {
    expect(await aiWith({ ...ON_VERCEL, AI_PROVIDER: 'vercel-ai-gateway', AI_API_KEY: 'vck_key' })).toMatchObject({ configured: true, usesProjectIdentity: false, apiKey: 'vck_key', baseUrl: VERCEL_AI_GATEWAY_URL });
    expect(await aiWith({ AI_PROVIDER: 'vercel-ai-gateway', AI_API_KEY: 'vck_key', AI_MODEL: 'google/some-model' })).toMatchObject({ configured: true, usesProjectIdentity: false, apiKey: 'vck_key', model: 'google/some-model' });
  });

  it('Vercel’s AI Gateway without a key is off anywhere but on Vercel: there is no identity to ask with', async () => {
    expect(await aiWith({ AI_PROVIDER: 'vercel-ai-gateway' })).toMatchObject({ provider: 'vercel-ai-gateway', configured: false });
    expect(await aiWith({ AI_PROVIDER: 'vercel-ai-gateway', AI_API_KEY: '   ' })).toMatchObject({ configured: false, apiKey: undefined });
  });

  it('any other service needs its key, and is never asked with the project’s identity', async () => {
    const free = { AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/', AI_MODEL: 'gemini-flash', AI_API_KEY: 'key' };
    expect(await aiWith(free)).toMatchObject({ provider: 'openai-compatible', configured: true, usesProjectIdentity: false, apiKey: 'key', model: 'gemini-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
    expect(await aiWith({ ...free, AI_API_KEY: '' })).toMatchObject({ configured: false, usesProjectIdentity: false });
    // On Vercel as well: the identity of the project means nothing to another company.
    expect(await aiWith({ ...ON_VERCEL, ...free, AI_API_KEY: '' })).toMatchObject({ configured: false, usesProjectIdentity: false });
    expect(await aiWith({ ...ON_VERCEL, ...free })).toMatchObject({ configured: true, usesProjectIdentity: false });
    // The defaults a deployment made before this choice existed relied on.
    expect(await aiWith({ AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'sk-key' })).toMatchObject({ configured: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
  });

  it('gives the service less time on Vercel than Vercel gives the request', async () => {
    const hosting = JSON.parse(fs.readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
    const cutOffMs = hosting.functions['api/index.js'].maxDuration * 1000;
    const onVercel = await aiWith({ ...ON_VERCEL, AI_PROVIDER: 'vercel-ai-gateway' });
    // Room to say what happened, and for the work around the request (reading the module, saving the drafts).
    expect(onVercel.timeoutMs).toBeLessThanOrEqual(cutOffMs - 15_000);
    expect(onVercel.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect((await aiWith({ AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'key' })).timeoutMs).toBe(120_000);
    expect((await aiWith({ ...ON_VERCEL, AI_PROVIDER: 'vercel-ai-gateway', AI_TIMEOUT_MS: '45000' })).timeoutMs).toBe(45_000);
  });

  it('passes over the OpenAI defaults of an old .env when the gateway is chosen', async () => {
    const ai = await aiWith({ AI_PROVIDER: 'vercel-ai-gateway', AI_API_KEY: 'vck_key', AI_BASE_URL: 'https://api.openai.com/v1', AI_MODEL: 'gpt-4o-mini' });
    expect(ai).toMatchObject({ configured: true, baseUrl: VERCEL_AI_GATEWAY_URL, model: DEFAULT_GATEWAY_MODEL });
  });

  it('supports the built-in zero-key AI mode with no API key required', async () => {
    const ai = await aiWith({ AI_PROVIDER: 'builtin' });
    expect(ai).toMatchObject({ provider: 'builtin', configured: true, usesProjectIdentity: false, baseUrl: null, model: BUILTIN_MODEL });
  });
});

describe('local code runner guardrails and AI config encryption helpers', () => {
  it('allows CODE_RUNNER_PROVIDER=local in test/dev and refuses it on Vercel', async () => {
    for (const key of KEYS) delete process.env[key];
    process.env.NODE_ENV = 'test';
    process.env.CODE_RUNNER_PROVIDER = 'local';
    vi.resetModules();
    const { env: localEnv } = await import('../../src/config/env.js');
    expect(localEnv.codeRunner).toMatchObject({ provider: 'local', configured: true });

    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.NODE_ENV = 'production';
    process.env.CODE_RUNNER_PROVIDER = 'local';
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow(/only for local development/);
  });

  it('encrypts and decrypts saved AI API keys and detects tampering', () => {
    const cipher = encryptSecret('AIza-test-free-key-9876');
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain('AIza-test-free-key-9876');
    expect(decryptSecret(cipher)).toEqual({ ok: true, corrupted: false, value: 'AIza-test-free-key-9876' });
    expect(decryptSecret(`${cipher.slice(0, -4)}AAAA`)).toEqual({ ok: false, corrupted: true, value: null });
  });

  it('validates custom AI base URLs cleanly', () => {
    expect(validateAiBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/', { onVercel: true })).toEqual({
      ok: true,
      url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(validateAiBaseUrl('http://api.example.com/v1', { onVercel: false }).ok).toBe(false);
    expect(validateAiBaseUrl('https://user:pass@api.example.com/v1', { onVercel: false }).ok).toBe(false);
    expect(validateAiBaseUrl('http://127.0.0.1:11434/v1', { onVercel: false })).toEqual({
      ok: true,
      url: 'http://127.0.0.1:11434/v1',
    });
    expect(validateAiBaseUrl('http://127.0.0.1:11434/v1', { onVercel: true }).ok).toBe(false);
  });
});

describe('the identity of the Vercel project', () => {
  /** A token as Vercel issues it, as far as this application reads it. */
  const token = `header.${Buffer.from(JSON.stringify({ owner_id: 'team_site', project_id: 'prj_site' })).toString('base64url')}.signature`;

  /** The assistant's check, in a deployment on Vercel whose configuration is `vars`; `sent` is everything that left. */
  async function checkWith(vars) {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, { ...ON_VERCEL, VERCEL_OIDC_TOKEN: token, AI_PROVIDER: 'vercel-ai-gateway', AI_TIMEOUT_MS: '2000', ...vars });
    const sent = [];
    vi.stubGlobal('fetch', async (url, options) => {
      sent.push({ url: String(url), authorization: options?.headers?.authorization ?? null });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"question":"Which gas do plants take in?","choices":["a","b"],"correct":1}' } }] }), { status: 200 });
    });
    vi.resetModules();
    const { checkAi } = await import('../../src/services/ai.js');
    return { result: await checkAi(), sent };
  }

  it('is sent to Vercel’s AI Gateway', async () => {
    const { result, sent } = await checkWith({});
    expect(result).toMatchObject({ ok: true, askedWith: 'project identity' });
    expect(sent).toEqual([{ url: 'https://ai-gateway.vercel.sh/v1/chat/completions', authorization: `Bearer ${token}` }]);
  });

  it('is not sent anywhere else, whatever AI_BASE_URL says', async () => {
    for (const elsewhere of ['https://ai.example.com/v1', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://ai-gateway.vercel.sh.example.com/v1']) {
      const { result, sent } = await checkWith({ AI_BASE_URL: elsewhere });
      expect(sent).toEqual([]);
      expect(result).toMatchObject({ ok: false, failure: { kind: 'identity', message: 'The identity of the Vercel project is only used with Vercel’s AI Gateway.' } });
      expect(result.failure.detail).toContain('AI_BASE_URL points somewhere else');
    }
  });

  it('stays at home when a key is set: the key is what another service gets', async () => {
    const { result, sent } = await checkWith({ AI_BASE_URL: 'https://ai.example.com/v1', AI_API_KEY: 'key-of-that-service' });
    expect(result).toMatchObject({ ok: true, askedWith: 'key' });
    expect(sent).toEqual([{ url: 'https://ai.example.com/v1/chat/completions', authorization: 'Bearer key-of-that-service' }]);
  });

  it('decrypts legacy CRON_SECRET-encrypted keys even after adding an independent AI_SETTINGS_SECRET', async () => {
    const prevCron = process.env.CRON_SECRET;
    const prevAiSecret = process.env.AI_SETTINGS_SECRET;
    try {
      process.env.CRON_SECRET = 'legacy-cron-secret-value-1234';
      delete process.env.AI_SETTINGS_SECRET;
      vi.resetModules();
      const { encryptSecret: legacyEncrypt } = await import('../../src/services/aiConfig.js');
      const legacyCipher = legacyEncrypt('AIza-legacy-key-777');

      process.env.AI_SETTINGS_SECRET = 'independent-ai-settings-secret-9999';
      vi.resetModules();
      const { decryptSecret: newDecrypt, encryptSecret: newEncrypt } = await import('../../src/services/aiConfig.js');
      expect(newDecrypt(legacyCipher)).toEqual({ ok: true, corrupted: false, value: 'AIza-legacy-key-777' });
      const freshCipher = newEncrypt('AIza-fresh-key-888');
      expect(newDecrypt(freshCipher)).toEqual({ ok: true, corrupted: false, value: 'AIza-fresh-key-888' });
    } finally {
      if (prevCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevCron;
      if (prevAiSecret === undefined) delete process.env.AI_SETTINGS_SECRET;
      else process.env.AI_SETTINGS_SECRET = prevAiSecret;
      vi.resetModules();
    }
  });
});
