// Administration → Settings: institution-wide options, and the state of optional services.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, CircleDashed, Code2, ExternalLink, Mail, PlayCircle, RotateCcw, Save, ServerCog, SlidersHorizontal, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Modal, ModalActions, PageHeader, QueryState, Select, Switch } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatBytes, setTimeZone } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';

/** Settings that only make sense on a server that can send e-mail. */
const NEEDS_EMAIL = new Set(['registration.requireEmailVerification', 'email.notificationsEnabled']);

const GROUP_HELP = {
  Institution: 'Shown on sign-in pages, reports and exports.',
  Accounts: 'Who may create an account without an administrator.',
  Security: 'Protection against password guessing.',
  Attendance: 'Limits for QR and location-verified check-in.',
  'At-risk indicators': 'When a student is flagged for a teacher’s attention. Flags are hints, never a grade.',
  Programming: 'How a program is run when a student tries it out. What counts is always checked on the server.',
};

export default function AdminSettings() {
  const { refresh } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get('/admin/settings') });
  const status = useQuery({ queryKey: ['admin', 'status'], queryFn: () => api.get('/admin/status') });
  const aiConfig = useQuery({ queryKey: ['admin', 'ai-config'], queryFn: () => api.get('/admin/ai-config') });
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiCheckNonce, setAiCheckNonce] = useState(0);
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  useEffect(() => { if (query.data) setDraft({}); }, [query.data]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const d of query.data?.definitions ?? []) { if (!map.has(d.group)) map.set(d.group, []); map.get(d.group).push(d); }
    return [...map.entries()];
  }, [query.data]);
  const changed = Object.keys(draft).length;
  const save = useAction(() => api.patch('/admin/settings', { values: draft }), {
    invalidate: [['admin', 'settings'], ['dashboard']], success: 'Settings saved.',
    onSuccess: async (saved) => { setErrors({}); if (saved?.values?.['institution.timezone']) setTimeZone(saved.values['institution.timezone']); await refresh(); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <>
      <PageHeader title="Settings" description="Options that apply to the whole school."
        actions={<><Button variant="secondary" icon={RotateCcw} disabled={changed === 0} onClick={() => { setDraft({}); setErrors({}); }}>Discard changes</Button><Button icon={Save} loading={save.isPending} disabled={changed === 0} onClick={() => save.mutate()}>Save{changed > 0 ? ` ${changed} change${changed === 1 ? '' : 's'}` : ''}</Button></>} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <QueryState query={query}>
          {({ values }) => (
            <div className="min-w-0 space-y-5">
              {Object.keys(errors).length > 0 && <Alert tone="bad" title="Nothing was saved">Correct the highlighted values, then save again.</Alert>}
              {groups.map(([group, definitions]) => (
                <Card key={group}>
                  <CardHeader title={group} description={GROUP_HELP[group]} />
                  <div className="space-y-4">
                    {definitions.map((d) => {
                      const value = d.key in draft ? draft[d.key] : values[d.key];
                      const set = (next) => setDraft((s) => { const copy = { ...s }; if (next === values[d.key]) delete copy[d.key]; else copy[d.key] = next; return copy; });
                      if (d.type === 'boolean') {
                        // Still possible to switch off; switching on is refused by the server as well.
                        const noEmail = NEEDS_EMAIL.has(d.key) && status.data?.mailAvailable === false;
                        return <Switch key={d.key} checked={Boolean(value)} onChange={set} label={d.label} disabled={noEmail && !value} error={errors[d.key]}
                          description={noEmail ? 'Not available: this server cannot send e-mail yet. See “Server” on this page.' : d.help} />;
                      }
                      return (
                        <Field key={d.key} label={d.label} hint={d.help} error={errors[d.key]} className="max-w-md">
                          {d.type === 'number'
                            ? <Input type="number" inputMode="numeric" value={value ?? ''} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} className="w-36" />
                            : <Input value={value ?? ''} onChange={(e) => set(e.target.value)} maxLength={200} />}
                        </Field>
                      );
                    })}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </QueryState>

        <div className="space-y-5 xl:sticky xl:top-24 xl:self-start">
          <Card>
            <CardHeader icon={ServerCog} title="Server" description="Runtime services and environment defaults." />
            <QueryState query={status} loader={<p className="text-sm text-faint">Loading…</p>}>
              {(s) => (
                <ul className="space-y-3 text-sm">
                  <Service icon={Mail} name="E-mail (SMTP)" on={s.mailConfigured} onText="Verification, password-reset and notification e-mails are sent." offText={s.mailAvailable === false ? 'Not configured. Nothing is e-mailed: when someone forgets a password, open the account under Users and choose “Reset password”.' : 'Not configured. Messages are kept in the development mailbox instead of being sent.'} />
                  <Service icon={Bot} name="AI assistant for teachers" on={s.ai.configured}
                    onText={`${AI_PROVIDERS[s.ai.provider] ?? s.ai.provider}${s.ai.model ? `, model ${s.ai.model}` : ''}${s.ai.askedWith === 'project identity' ? '. Asked with the identity of this site’s Vercel project; no key is stored.' : s.ai.askedWith === 'built-in' ? '. Runs free on this server with no API key.' : '.'}`}
                    offText="Not set up. Enable the built-in free assistant or connect a free Gemini / Groq key using Configure below.">
                    <AiCheck key={aiCheckNonce} last={s.ai} configured={s.ai.configured} onConfigure={() => setAiModalOpen(true)} />
                  </Service>
                  <Service icon={Code2} name="Code runner" on={s.codeRunner.configured} onText={RUNNER_TEXT[s.codeRunner.provider]?.(s.codeRunner) ?? `Provider: ${s.codeRunner.provider}`} offText="Not configured. Programs are not checked: programming answers in quizzes are saved for teachers to mark by hand, and practice problems cannot be submitted. Python can still be tried in the browser while that is switched on under “Programming”.">
                    {s.codeRunner.configured && <CodeRunnerCheck provider={s.codeRunner.provider} />}
                  </Service>
                  <li className="border-t border-line pt-3 text-[13px] text-soft">
                    <p>Environment: <span className="font-medium text-ink">{s.environment}</span></p>
                    <p>Largest upload: <span className="font-medium text-ink">{formatBytes(s.maxUploadBytes)}</span></p>
                    {s.reducePhotosOverBytes > 0 && <p>Photos over <span className="font-medium text-ink">{formatBytes(s.reducePhotosOverBytes)}</span> are made smaller on the sender’s device before they are sent</p>}
                    {s.storage && (
                      <p>
                        Uploaded files: <span className="font-medium text-ink">{s.storage.driver === 'database' ? 'kept in the database' : 'kept on the server’s disk'}</span>
                        {s.storage.usedBytes !== null && <> — {formatBytes(s.storage.usedBytes)}{s.storage.quotaBytes ? ` of ${formatBytes(s.storage.quotaBytes)}` : ''} used</>}
                      </p>
                    )}
                    {s.realtime === false && <p>Live updates: <span className="font-medium text-ink">screens refresh on a timer</span> (this host cannot push changes)</p>}
                    <p>Demo accounts: {s.demoAccountsEnabled ? <Badge tone="warn">Enabled</Badge> : <Badge tone="ok">Disabled</Badge>}</p>
                    {s.demoAccountsEnabled && <p className="mt-1 text-faint">Demo sign-in is refused automatically when the server runs in production mode.</p>}
                  </li>
                </ul>
              )}
            </QueryState>
          </Card>
        </div>
      </div>
      <AiConfigModal
        open={aiModalOpen}
        config={aiConfig.data}
        onClose={() => setAiModalOpen(false)}
        onSaved={() => {
          setAiCheckNonce((n) => n + 1);
          queryClient.invalidateQueries({ queryKey: ['admin', 'status'] });
          queryClient.invalidateQueries({ queryKey: ['admin', 'ai-config'] });
          queryClient.invalidateQueries({ queryKey: ['ai', 'status'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        }}
      />
    </>
  );
}

function Service({ icon: Icon, name, on, onText, offText, children }) {
  return (
    <li className="flex gap-3">
      <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${on ? 'bg-ok-soft text-ok' : 'bg-raised text-faint'}`}><Icon className="size-[18px]" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium text-ink">{name}{on ? <CheckCircle2 className="size-4 text-ok" aria-label="configured" /> : <CircleDashed className="size-4 text-faint" aria-label="not configured" />}</p>
        <p className="text-[13px] text-soft">{on ? onText : offText}</p>
        {children}
      </div>
    </li>
  );
}

const AI_PROVIDERS = {
  builtin: 'Built-in free assistant',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'openai-compatible': 'External OpenAI-compatible API',
};

/** Only a page of Vercel's own is ever made a link (the server checks the same); anything else stays text. */
function vercelPage(link) {
  try {
    const url = new URL(String(link ?? ''));
    return url.protocol === 'https:' && url.hostname === 'vercel.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

/** What an AI service said when it refused, with the page to fix it on where Vercel names one. */
function AiFailure({ failure }) {
  const link = vercelPage(failure.link);
  return (
    <div className="mt-2 rounded-xl border border-line p-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-medium text-bad"><XCircle className="size-4 shrink-0" aria-hidden="true" />{failure.message}</p>
      {failure.detail && <p className="mt-1 break-words text-xs text-faint">{failure.detail}</p>}
      {link && <p className="mt-1.5"><a className="font-medium text-brand underline-offset-2 hover:underline" href={link} target="_blank" rel="noreferrer">Open the page on vercel.com</a></p>}
    </div>
  );
}

/** "Is it working?" — asks the AI service one small question and shows what came back. */
function AiCheck({ last, configured, onConfigure }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setResult(await api.post('/admin/ai/check', {}));
    } catch (err) {
      setResult(null);
      setFailure(err.message);
    } finally {
      setBusy(false);
    }
  };
  // Before a check: what teachers ran into last, if that is the latest news.
  const earlier = !result && !failure && last.lastFailure && (!last.lastSuccessAt || last.lastFailureAt > last.lastSuccessAt) ? last.lastFailure : null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon={SlidersHorizontal} onClick={onConfigure}>Configure</Button>
        {configured && <Button size="sm" variant="secondary" icon={PlayCircle} loading={busy} onClick={run}>{busy ? 'Asking…' : 'Check now'}</Button>}
      </div>
      {configured && !result && !failure && !earlier && <p className="mt-1 text-xs text-faint">Asks the AI service one small question. Takes a few seconds.</p>}
      <div aria-live="polite">
        {failure && <p className="mt-2 text-[13px] text-bad">{failure}</p>}
        {earlier && <><p className="mt-2 text-xs text-faint">The last request of a teacher failed:</p><AiFailure failure={earlier} /></>}
        {result?.ok && (
          <div className="mt-2 rounded-xl border border-line p-3 text-[13px]">
            <p className="flex items-center gap-1.5 font-medium text-ok"><CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />The AI service answers.{result.ms ? <span className="ml-auto whitespace-nowrap font-normal text-faint">{(result.ms / 1000).toFixed(1)} s</span> : null}</p>
            <p className="mt-1 text-xs text-faint">Model {result.model}. Its answer began: “{result.answer}”</p>
          </div>
        )}
        {result && !result.ok && <AiFailure failure={result.failure} />}
      </div>
    </div>
  );
}

function AiConfigModal({ open, config, onClose, onSaved }) {
  const [mode, setMode] = useState('builtin');
  const [preset, setPreset] = useState('gemini');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [fieldErrs, setFieldErrs] = useState({});
  const [saveErr, setSaveErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const presets = useMemo(() => config?.presets ?? [], [config]);

  useEffect(() => {
    if (!open || !config) return;
    setMode(config.mode || 'env');
    setPreset(config.preset || 'gemini');
    setBaseUrl(config.baseUrl || '');
    setModel(config.model || '');
    setApiKey('');
    setClearApiKey(false);
    setFieldErrs({});
    setSaveErr(null);
  }, [open, config]);

  const currentPreset = presets.find((p) => p.id === preset);

  const choosePreset = (nextPreset) => {
    setPreset(nextPreset);
    const p = presets.find((item) => item.id === nextPreset);
    if (p) {
      setBaseUrl(p.baseUrl);
      setModel(p.defaultModel);
    }
    setFieldErrs({});
  };

  const submit = async (andTest) => {
    setBusy(true);
    setTesting(andTest);
    setFieldErrs({});
    setSaveErr(null);
    try {
      await api.put('/admin/ai-config', {
        mode,
        ...(mode === 'openai-compatible' ? { preset, baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) } : { clearApiKey }),
      });
      if (andTest) {
        const res = await api.post('/admin/ai/check', {});
        onSaved();
        if (!res.ok) {
          setSaveErr(res.failure?.message || 'Saved settings, but the test check failed.');
          return;
        }
      } else {
        onSaved();
      }
      onClose();
    } catch (err) {
      if (err.fields) setFieldErrs(err.fields);
      else setSaveErr(err.message);
    } finally {
      setBusy(false);
      setTesting(false);
    }
  };

  const envLabel = config?.env?.provider && config.env.provider !== 'none'
    ? `${AI_PROVIDERS[config.env.provider] ?? config.env.provider}${config.env.model ? ` (${config.env.model})` : ''}`
    : 'Not configured in environment';

  return (
    <Modal open={open} onClose={onClose} title="Configure AI assistant" description="Choose the zero-key built-in assistant or connect a free external AI API. Keys stay encrypted on the server and never reach browsers." size="md">
      {!config ? (
        <p className="text-sm text-faint">Loading configuration…</p>
      ) : (
        <div className="space-y-4">
          {saveErr && <Alert tone="bad">{saveErr}</Alert>}
          {config.keyCorrupted && mode === 'openai-compatible' && (
            <Alert tone="warn">The saved API key could not be decrypted with this server’s secret. Enter a new key below to replace it.</Alert>
          )}
          <Field label="AI provider mode">
            <Select value={mode} onChange={(e) => { setMode(e.target.value); setFieldErrs({}); setSaveErr(null); }}>
              <option value="builtin">Built-in free assistant (no API key required)</option>
              <option value="openai-compatible">Free or custom external AI API (Gemini, Groq, OpenRouter, OpenAI)</option>
              <option value="env">Use server environment variable ({envLabel})</option>
              <option value="off">Disabled</option>
            </Select>
          </Field>

          {mode === 'builtin' && (
            <Alert tone="info" title="Runs completely on this server ($0)">
              Drafts modules, extracts quiz and exam questions directly from teachers’ module lessons and uploaded files, and creates editable assignments and rubrics without sending data to any external AI service.
            </Alert>
          )}

          {mode === 'openai-compatible' && (
            <div className="space-y-3 rounded-xl border border-line p-4">
              <Field label="Provider preset" hint={currentPreset?.notes}>
                <Select value={preset} onChange={(e) => choosePreset(e.target.value)}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </Select>
              </Field>
              {currentPreset?.signupUrl && (
                <p className="text-xs text-soft">
                  Need a free key?{' '}
                  <a className="inline-flex items-center gap-1 font-medium text-brand underline-offset-2 hover:underline" href={currentPreset.signupUrl} target="_blank" rel="noreferrer">
                    Create one here <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </p>
              )}
              <Field label="API base URL" error={fieldErrs.baseUrl}>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://generativelanguage.googleapis.com/v1beta/openai" />
              </Field>
              <Field label="Model" error={fieldErrs.model}>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-2.5-flash" />
              </Field>
              <Field
                label="API key"
                error={fieldErrs.apiKey}
                hint={config.hasApiKey && !clearApiKey ? `Saved on server (${config.apiKeyHint}). Leave blank to keep existing key.` : 'Stored encrypted in PostgreSQL; never exposed in browsers or audit logs.'}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); if (e.target.value) setClearApiKey(false); }}
                  placeholder={config.hasApiKey && !clearApiKey ? '••••••••••••••••' : 'Paste API key…'}
                />
              </Field>
              {config.hasApiKey && (
                <div className="flex items-center justify-between text-xs text-soft">
                  <span>{clearApiKey ? 'Stored key will be removed when you save.' : `Stored key: ${config.apiKeyHint}`}</span>
                  <button type="button" className="font-medium text-brand hover:underline" onClick={() => setClearApiKey((c) => !c)}>
                    {clearApiKey ? 'Keep stored key' : 'Clear stored key'}
                  </button>
                </div>
              )}
            </div>
          )}

          <ModalActions>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            {mode !== 'off' && (
              <Button variant="secondary" icon={PlayCircle} loading={busy && testing} disabled={busy && !testing} onClick={() => submit(true)}>
                Save & test
              </Button>
            )}
            <Button icon={Save} loading={busy && !testing} disabled={busy && testing} onClick={() => submit(false)}>
              Save settings
            </Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

const RUNNER_TEXT = {
  local: () => 'Programs run in a separate local process on this development computer (local development only).',
  'vercel-sandbox': (runner) => `Every program runs in a machine of its own on this site’s Vercel account${runner.region ? ` (region ${runner.region})` : ''}, without network access, and the machine is thrown away afterwards.`,
  piston: () => 'Programs are sent to the Piston server this site was given.',
};

const LANGUAGE_NAMES = { PYTHON: 'Python', JAVASCRIPT: 'JavaScript', C: 'C', CPP: 'C++', JAVA: 'Java' };

/** "Is it working?" — runs a tiny program in every language and shows what came back. */
function CodeRunnerCheck({ provider }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setResult(await api.post('/admin/code-runner/check', {}));
    } catch (err) {
      setResult(null);
      setFailure(err.message);
    } finally {
      setBusy(false);
    }
  };
  const languages = Object.entries(result?.languages ?? {});
  return (
    <div className="mt-2">
      <Button size="sm" variant="secondary" icon={PlayCircle} loading={busy} onClick={run}>{busy ? 'Checking…' : 'Check now'}</Button>
      {provider === 'vercel-sandbox' && !result && !failure && <p className="mt-1 text-xs text-faint">Starts one machine and runs a small program in each language. Takes a few seconds.</p>}
      <div aria-live="polite">
        {failure && <p className="mt-2 text-[13px] text-bad">{failure}</p>}
        {result && (
          <div className="mt-2 rounded-xl border border-line p-3 text-[13px]">
            <p className={`flex items-center gap-1.5 font-medium ${result.ok ? 'text-ok' : 'text-bad'}`}>
              {result.ok ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <XCircle className="size-4" aria-hidden="true" />}
              {result.ok ? 'Programs are being checked.' : 'Programs cannot be checked right now.'}
              {result.timings?.totalMs ? <span className="ml-auto whitespace-nowrap font-normal text-faint">{(result.timings.totalMs / 1000).toFixed(1)} s</span> : null}
            </p>
            {languages.length > 0 && (
              <ul className="mt-2 space-y-1">
                {languages.map(([id, l]) => (
                  <li key={id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className={l.ok ? 'text-ok' : 'text-bad'} aria-hidden="true">{l.ok ? '✓' : '✗'}</span>
                    <span className="font-medium text-ink">{LANGUAGE_NAMES[id] ?? id}</span>
                    <span className="sr-only">{l.ok ? 'works' : 'does not work'}</span>
                    {result.versions?.[id] && <span className="text-faint">{result.versions[id]}</span>}
                    {!l.ok && l.detail && <span className="w-full break-words text-bad">{l.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
            {result.detail && <p className="mt-2 break-words text-soft">{result.detail}</p>}
            {result.identity && <p className="mt-2 text-faint">Machines are started with: {result.identity}.</p>}
            {result.limits === 'rlimit' && <p className="mt-2 text-faint">Memory limits are approximate on this machine (kernel control groups are not available).</p>}
          </div>
        )}
      </div>
    </div>
  );
}
