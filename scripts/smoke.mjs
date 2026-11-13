#!/usr/bin/env node
// A quick check of a running EduSphere site in production mode: is the web app served, does the
// API answer and reach the database, are the doors that must be closed really closed.
//
//   npm run smoke -- https://your-site.example
//
// Without credentials it only reads public pages. With an administrator account it also signs
// in, stores a small file, reads it back, deletes it and signs out:
//
//   SMOKE_EMAIL=admin@school.edu SMOKE_PASSWORD=… npm run smoke -- https://your-site.example
//
// If the account still has its temporary password, set SMOKE_NEW_PASSWORD and the check changes
// it the way the first sign-in would. Everything it creates it removes again, except the entries
// its own actions leave in the audit log.
//
// On Vercel, with the site's CRON_SECRET in the environment, it also asks the function how it
// started, and — when the API could not start — why:
//
//   CRON_SECRET=… npm run smoke -- https://your-site.example
import { operatorToken } from '../backend/src/lib/tokens.js';
import { STARTUP_REPORT_PARAM, startupReportToken } from '../backend/src/lib/vercel.js';

const base = (process.argv[2] ?? 'http://localhost:3900').replace(/\/+$/, '');
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
const newPassword = process.env.SMOKE_NEW_PASSWORD;

let failures = 0;
/** `detail` explains a failure; `note` is worth reading even when the check passes. */
function check(label, ok, detail = '', note = '') {
  if (!ok) failures += 1;
  const extra = ok ? note : [note, detail].filter(Boolean).join('; ');
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
}

let cookie = '';
let csrf = '';
async function call(method, path, { body, form, headers = {}, raw = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}),
      ...(method !== 'GET' ? { origin: base } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  for (const set of res.headers.getSetCookie?.() ?? []) {
    const [pair] = set.split(';');
    if (/^(__Host-)?es_sid=/.test(pair)) cookie = pair.endsWith('=') ? '' : pair;
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, text, json };
}

console.log(`Checking ${base}\n`);

// ── Pages come from the CDN, with the security headers from vercel.json ──────────────────────
const home = await call('GET', '/');
check('the home page is served', home.status === 200 && home.text.includes('<div id="root">'), `status ${home.status}`);
check('pages carry a Content-Security-Policy', (home.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
check('pages cannot be framed by other sites', home.headers.get('x-frame-options') === 'SAMEORIGIN');
const deep = await call('GET', '/classes/some-class/attendance');
check('a link deep into the app gets the app, not a 404', deep.status === 200 && deep.text.includes('<div id="root">'), `status ${deep.status}`);
const script = /src="(\/assets\/[^"]+\.js)"/.exec(home.text)?.[1];
if (script) {
  const asset = await call('GET', script);
  check('scripts are served and may be cached for a long time', asset.status === 200 && (asset.headers.get('cache-control') ?? '').includes('immutable'), `status ${asset.status}, cache-control "${asset.headers.get('cache-control') ?? ''}"`);
} else {
  check('the page references its script', false);
}
check('a missing script is a 404, not the app page', (await call('GET', '/assets/not-there.js')).status === 404);
const worker = await call('GET', '/sw.js');
check('the service worker is served as a script', worker.status === 200 && (worker.headers.get('content-type') ?? '').includes('javascript'));

// ── The API is one function behind /api, /healthz and /readyz ────────────────────────────────
const health = await call('GET', '/healthz');
check('the API answers', health.json?.status === 'ok', `status ${health.status}${health.json?.error?.code ? ` ${health.json.error.code}` : ''}`);
if (process.env.CRON_SECRET) {
  const report = (await call('GET', `/healthz?${STARTUP_REPORT_PARAM}=${startupReportToken(process.env.CRON_SECRET)}`)).json?.data;
  if (report && typeof report.started === 'boolean') {
    const how = `loaded with ${report.loadedWith} on Node.js ${report.node}${report.region ? ` in ${report.region}` : ''}; the function is given the URL ${report.url?.startsWith('/api?') ? 'the rewrite points to' : 'the browser asked for'}`;
    check('the function leaves request bodies to the application', report.platformHelpers === false, 'Vercel added its request helpers: set NODEJS_HELPERS=0 in the project and deploy again', how);
    // What Vercel tells the function with each request (reported by deployments that note it).
    if (report.request) {
      check('the function may finish work after its response', report.request.waitUntil === true, 'Vercel gave the function no way to stay awake: e-mail copies and background jobs may be cut short, and the code runner removes its machine before it answers');
      const identity = report.request.identityInContext || report.request.identityHeader;
      console.log(`       (the project's identity ${identity ? 'comes' : 'does not come'} with each request${identity ? '' : ': programs cannot be checked in Vercel Sandbox machines'}${identity && !report.projectKnown ? '; Vercel does not name the project, so the identity cannot be compared with it' : ''})`);
    }
    if (!report.started) console.log(`\n       The API could not start:\n${[report.reason?.message, ...(report.reason?.stack ?? []).slice(1, 6)].join('\n').replace(/^/gm, '         ')}\n`);
  } else {
    console.log('       (no start-up report: the site is not a function, or CRON_SECRET is not the one it was deployed with)');
  }
} else if (health.json?.error?.code === 'STARTUP_FAILED') {
  console.log('       (the reason is in the function log; with CRON_SECRET set, this check prints it)');
}
if (process.env.CRON_SECRET) {
  // Starts one machine when the site checks programs with Vercel Sandbox.
  const checkPath = `/api/internal/code-runner-check?token=${operatorToken(process.env.CRON_SECRET, 'code runner check')}`;
  const runner = (await call('GET', checkPath)).json?.data;
  if (!runner) console.log('       (no answer about the code runner: CRON_SECRET is not the one the site was deployed with)');
  else if (runner.provider === 'none') console.log('       (no code runner is set up: programs are not run, teachers mark them by hand)');
  else {
    const languages = Object.entries(runner.languages ?? {});
    const broken = languages.filter(([, l]) => !l.ok).map(([id, l]) => `${id}: ${l.detail}`);
    check(`programs are checked (${runner.provider})`, runner.ok === true, runner.detail ?? broken.join('; '), runner.ok ? `${languages.length} language${languages.length === 1 ? '' : 's'} in ${((runner.timings?.totalMs ?? 0) / 1000).toFixed(1)} s${runner.identity ? `, started with ${runner.identity}` : ''}${runner.limits === 'rlimit' ? ', memory limits approximate' : ''}` : '');
    console.log(`       (to repeat this check in a browser: ${base}${checkPath})`);
  }
}
const ready = await call('GET', '/readyz');
check('the API reaches the database and finds its tables', ready.json?.status === 'ready', `status ${ready.status}: ${ready.text.slice(0, 120)}`, ready.json?.status === 'ready' ? `round trip ${ready.json.databaseMs} ms` : '');
const config = await call('GET', '/api/auth/config');
check('public configuration is readable', config.status === 200 && typeof config.json?.data === 'object', `status ${config.status}`);
check('API answers are never cached', (config.headers.get('cache-control') ?? '').includes('no-store'));
check('demo accounts are off', Array.isArray(config.json?.data?.demoAccounts) && config.json.data.demoAccounts.length === 0);
const nobody = await call('GET', '/api/auth/session?optional=1');
check('a visitor is not signed in', nobody.status === 200 && nobody.json?.data === null, `status ${nobody.status}`);
check('private data needs a session', (await call('GET', '/api/classes')).status === 401);
const missing = await call('GET', '/api/no/such/route');
check('an unknown API path is a JSON 404', missing.status === 404 && Boolean(missing.json?.error), `status ${missing.status}`);
check('the development mailbox does not exist', (await call('GET', '/api/dev/mailbox')).status === 404);
const cron = await call('GET', '/api/internal/cron');
check('the scheduled call is closed to strangers or harmless', cron.status === 401 || (cron.status === 200 && Array.isArray(cron.json?.data?.ran)), `status ${cron.status}`);
const forged = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.org', password: 'x' }, headers: { origin: 'https://evil.example' } });
check('requests from another site are refused', forged.status === 403, `status ${forged.status}`);
// Answered 401 only if the JSON body reached the application whole: a body that was lost or
// already read on the way is answered 422 or worse.
const stranger = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.org', password: 'not-the-password' } });
check('a posted form arrives intact (a wrong password is told so)', stranger.status === 401 && stranger.json?.error?.code === 'INVALID_CREDENTIALS', `status ${stranger.status} ${stranger.json?.error?.code ?? ''}`);

// ── Signed in ────────────────────────────────────────────────────────────────────────────────
if (!email || !password) {
  console.log('\n(no SMOKE_EMAIL / SMOKE_PASSWORD: the signed-in checks were skipped)');
} else {
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  check('sign-in works', login.status === 200 && login.json?.data?.user?.email === email.toLowerCase(), `status ${login.status} ${login.json?.error?.code ?? ''}`);
  if (login.status === 200) {
    csrf = login.json.data.csrfToken;
    const runtime = login.json.data.runtime ?? {};
    console.log(`       server says: push ${runtime.realtime ? 'on' : 'off'}, largest upload ${Math.round((runtime.maxUploadBytes ?? 0) / 1024 / 1024)} MB`);

    if (login.json.data.user.mustChangePassword) {
      const blocked = await call('GET', '/api/classes');
      check('a temporary password must be changed before anything else', blocked.status === 403 && blocked.json?.error?.code === 'PASSWORD_CHANGE_REQUIRED', `status ${blocked.status}`);
      if (newPassword) {
        const changed = await call('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword } });
        check('the temporary password can be replaced', changed.status === 200, `status ${changed.status} ${JSON.stringify(changed.json?.error ?? '').slice(0, 160)}`);
      } else {
        console.log('       (set SMOKE_NEW_PASSWORD to go on past the password change)');
      }
    }

    const session = await call('GET', '/api/auth/session');
    if (session.json?.data && !session.json.data.user.mustChangePassword) {
      csrf = session.json.data.csrfToken;
      // A file: stored, read back whole and in part, removed.
      const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300_000, 'edusphere ')]);
      const form = new FormData();
      form.append('files', new Blob([bytes], { type: 'application/pdf' }), 'smoke-check.pdf');
      const upload = await call('POST', '/api/files', { form });
      check('a file can be uploaded', upload.status === 201, `status ${upload.status} ${upload.json?.error?.message ?? upload.text.slice(0, 80)}`);
      const id = upload.json?.data?.[0]?.id;
      if (id) {
        const download = await call('GET', `/api/files/${id}`, { raw: true });
        const back = Buffer.from(await download.arrayBuffer());
        check('it comes back byte for byte', download.status === 200 && back.equals(bytes), `${back.length} of ${bytes.length} bytes`);
        const part = await call('GET', `/api/files/${id}`, { raw: true, headers: { range: 'bytes=100-199' } });
        const slice = Buffer.from(await part.arrayBuffer());
        check('a part of it can be requested', part.status === 206 && slice.equals(bytes.subarray(100, 200)));
        check('it can be deleted', (await call('DELETE', `/api/files/${id}`)).status === 204);
      }
      const big = new FormData();
      big.append('files', new Blob([Buffer.alloc(6 * 1024 * 1024, 1)], { type: 'application/pdf' }), 'too-large.pdf');
      const refused = await call('POST', '/api/files', { form: big });
      check('a file over the limit is refused', refused.status === 413, `status ${refused.status}`);

      const status = await call('GET', '/api/admin/status');
      if (status.status === 200) {
        const s = status.json.data;
        check('the administrator sees how the site is hosted', typeof s.storage?.driver === 'string', '', `${s.platform}, ${s.environment}, files kept in the ${s.storage?.driver}`);
      }
      const audit = await call('GET', '/api/admin/audit-logs/export', { raw: true });
      check('an export can be downloaded', audit.status === 200 && (audit.headers.get('content-type') ?? '').includes('csv'), `status ${audit.status}`);
    }

    const out = await call('POST', '/api/auth/logout');
    check('sign-out works', out.status === 204 || out.status === 200, `status ${out.status}`);
    check('the session is gone afterwards', (await call('GET', '/api/classes')).status === 401);
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
