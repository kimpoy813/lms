// The Vercel Sandbox judge (src/services/judge/vercelSandbox.js) against a stand-in for Vercel's
// SDK: which machines it asks for, what it uploads, how it reads the answer, and what it does when
// the prepared image is missing, busy or broken. No machine is started and no program is run here;
// the runner itself is tested in judge-runner.test.js, and both together against a real account by
// scripts/judge-image.mjs.
import { afterEach, describe, expect, it } from 'vitest';
import { apiError, fakeSandboxAccount, okReport } from '../helpers/fakeSandbox.js';
import { REPORT_PREFIX, RUNNER_MARKER, RUNNER_VERSION } from '../../src/services/judge/vmRunner.mjs';
import {
  BASE_IMAGE, IMAGE_TAG, JOB_DEADLINE_MS, JudgeUnavailable, classifyError, createSandboxJudge, describeError, imageName, imageScript,
  parseReport, sandboxCredentials, setSandboxSdk, toRun,
} from '../../src/services/judge/vercelSandbox.js';

const REGION = 'sin1';
const NAME = imageName(REGION);
const CREDS = { token: 'tok', teamId: 'team_1', projectId: 'prj_1' };
const account = (options) => fakeSandboxAccount(NAME, options);

function judgeFor(fake, options = {}) {
  setSandboxSdk(fake);
  const pending = [];
  const warnings = [];
  const judge = createSandboxJudge({
    region: REGION, credentials: () => CREDS,
    log: { info() {}, warn: (fields, message) => warnings.push([message, fields]) },
    background: (task) => pending.push(Promise.resolve().then(task)),
    ...options,
  });
  return { judge, warnings, settle: async () => { await Promise.allSettled(pending.splice(0)); await Promise.allSettled(pending.splice(0)); } };
}

const program = { language: 'PYTHON', code: 'print(int(input()) * 2)', inputs: ['2', '5'], timeLimitMs: 3000, memoryLimitKb: 131072 };
const unavailable = async (promise) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(JudgeUnavailable);
  return err;
};

afterEach(() => setSandboxSdk(null));

describe('checking a program', () => {
  it('gives every submission a machine of its own, without network, and removes it afterwards', async () => {
    const fake = account();
    // Stopping a machine takes seconds on the real service; here it takes until the test says so.
    let machineStopped;
    fake.state.stopGate = new Promise((resolve) => { machineStopped = resolve; });
    const { judge, settle } = judgeFor(fake);
    const out = await judge.runBatch(program);
    expect(out).toMatchObject({ compileError: null, limits: 'cgroup', runs: [{ stdout: '4\n', exitCode: 0, timedOut: false }, { stdout: '10\n', exitCode: 0, timedOut: false }] });
    expect(out.timings).toEqual(expect.objectContaining({ startMs: expect.any(Number), uploadMs: expect.any(Number), runMs: expect.any(Number), totalMs: expect.any(Number) }));

    const fork = fake.calls.find((c) => c[0] === 'fork')[1];
    expect(fork).toMatchObject({ sourceSandbox: NAME, region: REGION, networkPolicy: 'deny-all', persistent: false, resources: { vcpus: 1 }, ...CREDS });
    expect(fork.timeout).toBeGreaterThanOrEqual(60_000);
    expect(fork.signal).toBeInstanceOf(AbortSignal);
    // One upload and one command as root; the answer is there while the machine is still being stopped.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop']);
    expect(fake.calls[2]).toEqual(['runCommand', 'job-1', 'node /tmp/judge-job/runner.mjs /tmp/judge-job', { sudo: true, detached: false, timeoutMs: JOB_DEADLINE_MS + 10_000 }]);
    machineStopped();
    await settle();
    expect(fake.names().slice(3)).toEqual(['stop', 'delete']);
  });

  it('sends the program, the inputs and the limits, and nothing else', async () => {
    const fake = account();
    const { judge } = judgeFor(fake);
    await judge.runBatch(program);
    const machine = fake.machines[0];
    expect(Object.keys(machine.files).sort()).toEqual(['/tmp/judge-job/job.json', '/tmp/judge-job/runner.mjs']);
    expect(machine.job).toEqual({ version: RUNNER_VERSION, language: 'PYTHON', source: program.code, tests: ['2', '5'], timeLimitMs: 3000, memoryLimitKb: 131072, deadlineMs: JOB_DEADLINE_MS });
    expect(machine.files['/tmp/judge-job/runner.mjs'].startsWith(`// ${RUNNER_MARKER}`)).toBe(true);
  });

  it('returns the compiler’s message when the program does not compile', async () => {
    const fake = account({ report: (job) => ({ ...okReport(job), compile: { ok: false, output: 'main.py: SyntaxError: invalid syntax', timedOut: false, ms: 30 }, runs: [] }) });
    const { judge } = judgeFor(fake);
    expect(await judge.runBatch(program)).toMatchObject({ compileError: 'main.py: SyntaxError: invalid syntax', runs: [] });
  });

  it('reads the report from the file when it did not come through with the output', async () => {
    const fake = account({ output: 'cut off in the middle of EDUSPHERE-JUDGE-REP' });
    fake.state.reportFile = JSON.stringify(okReport({ tests: ['2', '5'] }));
    const { judge } = judgeFor(fake);
    expect((await judge.runBatch(program)).runs.map((r) => r.stdout)).toEqual(['4\n', '10\n']);
    expect(fake.names()).toContain('readFile');
  });

  it('says that the checker failed when there is no report at all, and still removes the machine', async () => {
    const fake = account({ output: 'Killed\n' });
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('failed');
    expect(err.detail).toMatch(/no report.*runner stderr/);
    await settle();
    expect(fake.names().slice(-2)).toEqual(['stop', 'delete']);
  });

  it('passes on a failure the runner reported, and refuses a runner of another version', async () => {
    const broken = judgeFor(account({ report: () => ({ version: RUNNER_VERSION, error: 'could not create the user that runs programs' }) }));
    expect(await unavailable(broken.judge.runBatch(program))).toMatchObject({ kind: 'failed', detail: 'could not create the user that runs programs' });
    const old = judgeFor(account({ report: (job) => ({ ...okReport(job), version: RUNNER_VERSION + 1 }) }));
    expect((await unavailable(old.judge.runBatch(program))).detail).toMatch(/Runner version/);
  });

  it('says so when a language is not installed in the image', async () => {
    const fake = account({ report: (job) => ({ ...okReport(job), toolchain: false, missing: ['javac', 'java'], compile: null, runs: [] }) });
    const { judge } = judgeFor(fake);
    expect((await unavailable(judge.runBatch({ ...program, language: 'JAVA' }))).detail).toBe('Not installed in the image: javac, java');
  });

  it('cannot start anything without an identity, and says which one is missing', async () => {
    const fake = account();
    const { judge } = judgeFor(fake, { credentials: () => null });
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('identity');
    expect(err.detail).toMatch(/OIDC token.*VERCEL_TOKEN/);
    expect(fake.calls).toEqual([]);
  });
});

describe('what the runner reports for one test → what the application works with', () => {
  const base = { exitCode: 0, signal: null, processLimit: false, stdout: 'out\n', stderr: '' };
  const limits = { memoryLimitKb: 65536 };

  it('keeps an ordinary run as it is', () => {
    expect(toRun({ ...base, status: 'ok' }, limits)).toEqual({ stdout: 'out\n', stderr: '', exitCode: 0, timedOut: false });
    expect(toRun({ ...base, status: 'ok', exitCode: 3, stderr: 'oops\n' }, limits)).toEqual({ stdout: 'out\n', stderr: 'oops\n', exitCode: 3, timedOut: false });
  });

  it('marks a run that hit the time limit, and one that was never started', () => {
    expect(toRun({ ...base, status: 'timeout', exitCode: null, signal: 'SIGKILL' }, limits)).toMatchObject({ timedOut: true, exitCode: null });
    const notRun = toRun({ status: 'not-run', exitCode: null, stdout: '', stderr: '' }, limits);
    expect(notRun.timedOut).toBe(true);
    expect(notRun.stderr).toMatch(/Not run: the tests before this one used up the time/);
  });

  it('explains a memory limit, an output limit and a signal in words', () => {
    expect(toRun({ ...base, status: 'memory-limit', exitCode: null, signal: 'SIGKILL', stdout: '' }, limits)).toEqual({ stdout: '', stderr: 'Memory limit exceeded (64 MB).', exitCode: 137, timedOut: false });
    expect(toRun({ ...base, status: 'output-limit', exitCode: null, signal: 'SIGKILL' }, limits)).toMatchObject({ exitCode: 1, timedOut: false, stderr: 'Output limit exceeded: the program printed more than 64 KB.' });
    expect(toRun({ ...base, status: 'ok', exitCode: null, signal: 'SIGSEGV', stderr: 'trace\n' }, limits)).toMatchObject({ exitCode: 139, stderr: 'trace\nSegmentation fault: the program used memory that does not belong to it.' });
    expect(toRun({ ...base, status: 'ok', exitCode: null, signal: 'SIGFPE' }, limits)).toMatchObject({ exitCode: 136, stderr: 'Arithmetic error, for example a division by zero.' });
    expect(toRun({ ...base, status: 'ok', exitCode: null, signal: 'SIGUSR1' }, limits)).toMatchObject({ exitCode: 1, stderr: 'The program was stopped by SIGUSR1.' });
  });

  it('mentions the process limit only when the program failed because of it', () => {
    expect(toRun({ ...base, status: 'ok', processLimit: true }, limits).stderr).toBe('');
    expect(toRun({ ...base, status: 'ok', processLimit: true, exitCode: 1 }, limits).stderr).toMatch(/more processes than it is allowed/);
  });
});

describe('when Vercel says no', () => {
  const tryWith = async (forkError) => {
    const fake = account({ forkError });
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    await settle();
    return { err, fake };
  };

  it('too many machines at once is "busy"', async () => {
    const { err, fake } = await tryWith(apiError(429, 'rate_limited', 'Too many requests'));
    expect(err).toMatchObject({ kind: 'busy', detail: 'HTTP 429 rate_limited: Too many requests' });
    expect(fake.names()).toEqual(['fork']);
  });

  it('a machine that does not come up in time is "busy" as well', async () => {
    const { err } = await tryWith(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(err.kind).toBe('busy');
  });

  it('a used-up plan is told apart from a missing permission', async () => {
    expect((await tryWith(apiError(402, 'payment_required', 'Sandbox creation is paused'))).err.kind).toBe('allowance');
    expect((await tryWith(apiError(403, 'usage_limit_exceeded', 'paused'))).err.kind).toBe('allowance');
    expect((await tryWith(apiError(403, 'forbidden', 'Not authorized'))).err.kind).toBe('identity');
    expect((await tryWith(apiError(401, 'unauthorized', 'bad token'))).err.kind).toBe('identity');
  });

  it('anything else is a failure, with the image left alone when it is in place', async () => {
    const { err, fake } = await tryWith(apiError(500, 'internal', 'boom'));
    expect(err).toMatchObject({ kind: 'failed', detail: 'HTTP 500 internal: boom' });
    // It looked at the image (stopped: nothing to do) and did not start another one.
    expect(fake.names()).toEqual(['fork', 'get']);
  });

  it('describes errors in one line', () => {
    expect(describeError(apiError(404, 'not_found', 'Sandbox   not\nfound'))).toBe('HTTP 404 not_found: Sandbox not found');
    expect(describeError(new Error('fetch failed'))).toBe('fetch failed');
    expect(describeError(new JudgeUnavailable('busy', 'The code checker is busy.', 'HTTP 429'))).toBe('The code checker is busy. — HTTP 429');
    expect(classifyError(new JudgeUnavailable('busy', 'x'))).toMatchObject({ kind: 'busy' });
  });
});

describe('the prepared image', () => {
  it('is named after its recipe and region, and the recipe ends by writing the tag', () => {
    expect(NAME).toBe(`edusphere-judge-${IMAGE_TAG}-sin1`);
    expect(IMAGE_TAG).toMatch(/^[0-9a-f]{10}$/);
    const script = imageScript();
    expect(script).toMatch(/set -euo pipefail/);
    expect(script).toMatch(/apt-get install .*python3 nodejs gcc g\+\+ libc6-dev default-jdk-headless/);
    expect(script.trim().split('\n').slice(-2)).toEqual([`printf '%s\\n' '${IMAGE_TAG}' > /etc/edusphere-judge-image`, 'sync']);
  });

  it('is prepared when it is missing, and the student is told to come back', async () => {
    const fake = account({ image: 'missing' });
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('preparing');
    await settle();
    const created = fake.calls.find((c) => c[0] === 'create')[1];
    expect(created).toMatchObject({ name: NAME, image: BASE_IMAGE, region: REGION, persistent: true, ...CREDS });
    expect(created.networkPolicy).toBeUndefined(); // the installation needs the package mirrors
    expect(fake.calls.filter((c) => c[0] === 'writeFiles')[0][2]).toEqual(['/var/tmp/edusphere-judge-image.sh']);
    expect(fake.calls.find((c) => c[0] === 'runCommand')).toEqual(['runCommand', NAME, 'bash /var/tmp/edusphere-judge-image.sh', { sudo: true, detached: true, timeoutMs: undefined }]);
    expect(fake.bases.get(NAME).files['/var/tmp/edusphere-judge-image.sh']).toBe(imageScript());

    // While that goes on, requests are turned away at once instead of each starting a machine.
    const before = fake.calls.length;
    expect((await unavailable(judge.runBatch(program))).kind).toBe('preparing');
    expect(fake.calls.length).toBe(before);
  });

  it('is finished by whoever notices that the installation is done', async () => {
    const fake = account({ image: 'preparing' });
    const { judge } = judgeFor(fake);
    expect(await judge.advanceImage()).toMatchObject({ state: 'ready', sizeBytes: 1_103_000_000 });
    expect(fake.names()).toEqual(['get', 'runCommand', 'stop']);
    expect(await judge.advanceImage()).toEqual({ state: 'stopped' });
  });

  it('is left alone while the installation is still running', async () => {
    const fake = account({ image: 'preparing', installation: 'running' });
    const { judge } = judgeFor(fake);
    expect(await judge.advanceImage()).toEqual({ state: 'preparing', detail: 'Setting up gcc' });
    expect(fake.names()).toEqual(['get', 'runCommand']);
  });

  it('is removed when the installation failed, and not tried again straight away', async () => {
    const fake = account({ image: 'preparing', installation: 'failed' });
    const { judge, warnings } = judgeFor(fake);
    const step = await judge.advanceImage();
    expect(step.state).toBe('failed');
    expect(step.detail).toMatch(/exit 100.*Unable to locate package/);
    expect(fake.calls.at(-1)).toEqual(['delete', NAME, { deleteOrphanSnapshots: true }]);
    expect(warnings[0][0]).toMatch(/preparing the machine image .* failed/);
    expect(await judge.advanceImage()).toMatchObject({ state: 'waiting' });
    expect(fake.names().filter((n) => n === 'create')).toEqual([]);
  });

  it('is replaced when a machine made from it turns out to be incomplete', async () => {
    const fake = account({ report: (job) => ({ ...okReport(job), image: null }) });
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('preparing');
    expect(err.detail).toMatch(/marked null/);
    await settle();
    // The half-made image went, with its snapshot, and a new one is on its way.
    expect(fake.calls.find((c) => c[0] === 'delete' && c[1] === NAME)).toEqual(['delete', NAME, { deleteOrphanSnapshots: true }]);
    expect(fake.names()).toContain('create');
  });

  it('yields to another process that started preparing it in the same moment', async () => {
    const fake = account({ image: 'missing' });
    const { judge } = judgeFor(fake);
    const create = fake.Sandbox.create;
    fake.Sandbox.create = async () => { throw apiError(409, 'conflict', 'already exists'); };
    expect(await judge.advanceImage()).toEqual({ state: 'preparing', detail: 'started by another process' });
    fake.Sandbox.create = create;
  });

  it('can be waited for: prepared, finished, then proven with a program in every language', async () => {
    const languages = { PYTHON: { ok: true }, JAVA: { ok: true } };
    const fake = account({ image: 'missing', report: (job) => ({ ...okReport(job), ...(job.selfTest ? { selfTest: { languages, versions: { PYTHON: 'Python 3.14.4' } } } : {}) }) });
    const { judge, settle } = judgeFor(fake);
    const progress = [];
    const result = await judge.ensureImage({ pollMs: 1, onProgress: (line) => progress.push(line) });
    await settle();
    expect(result).toMatchObject({ ok: true, state: 'ready', prepared: true, sizeBytes: 1_103_000_000, check: { ok: true, languages, versions: { PYTHON: 'Python 3.14.4' } } });
    expect(progress).toEqual(['preparing: started', 'ready']);
    expect(fake.machines[0].job).toEqual({ version: RUNNER_VERSION, selfTest: true, deadlineMs: JOB_DEADLINE_MS });
    expect(fake.names().filter((n) => n === 'create')).toHaveLength(1);
  });

  it('waiting reports a language that does not work, and an installation that failed', async () => {
    const half = account({ report: (job) => ({ ...okReport(job), selfTest: { languages: { PYTHON: { ok: true }, JAVA: { ok: false, detail: 'not installed: javac, java' } }, versions: {} } }) });
    expect(await judgeFor(half).judge.ensureImage({ pollMs: 1 })).toMatchObject({ ok: false, state: 'incomplete', prepared: false });

    const failing = account({ image: 'preparing', installation: 'failed' });
    expect(await judgeFor(failing).judge.ensureImage({ pollMs: 1 })).toMatchObject({ ok: false, state: 'failed', detail: expect.stringMatching(/exit 100/) });
  });

  it('removes the images of other recipes, and only those', async () => {
    const fake = account();
    const old = `edusphere-judge-0000000000-${REGION}`;
    fake.bases.set(old, new fake.Machine(old, true, 'stopped'));
    fake.bases.set('somebody-elses-sandbox', new fake.Machine('somebody-elses-sandbox', true, 'stopped'));
    const { judge } = judgeFor(fake);
    expect(await judge.removeOtherImages()).toEqual([old]);
    expect(fake.calls.find((c) => c[0] === 'list')[1]).toMatchObject({ namePrefix: 'edusphere-judge-', sortBy: 'name' });
    expect([...fake.bases.keys()].sort()).toEqual([NAME, 'somebody-elses-sandbox'].sort());
    expect(await judge.inventory()).toEqual({ images: [{ name: NAME, status: 'stopped', current: true }, { name: 'somebody-elses-sandbox', status: 'stopped', current: false }], snapshots: 1, snapshotBytes: 1_103_000_000 });
  });
});

describe('who starts the machines', () => {
  const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const context = Symbol.for('@vercel/request-context');
  const saved = { env: process.env.VERCEL_OIDC_TOKEN, context: globalThis[context] };
  afterEach(() => {
    if (saved.env === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = saved.env;
    globalThis[context] = saved.context;
  });

  it('uses the token Vercel hands to the request, before the one a build gets', () => {
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_build', project_id: 'prj_build' });
    expect(sandboxCredentials()).toEqual({ token: process.env.VERCEL_OIDC_TOKEN, teamId: 'team_build', projectId: 'prj_build' });
    const fromRequest = token({ owner_id: 'team_fn', project_id: 'prj_fn' });
    globalThis[context] = { get: () => ({ headers: { 'x-vercel-oidc-token': fromRequest } }) };
    expect(sandboxCredentials()).toEqual({ token: fromRequest, teamId: 'team_fn', projectId: 'prj_fn' });
  });

  it('uses an access token when one is configured in full', () => {
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_build', project_id: 'prj_build' });
    expect(sandboxCredentials({ accessToken: 'vcp_x', teamId: 'team_a', projectId: 'prj_a' })).toEqual({ token: 'vcp_x', teamId: 'team_a', projectId: 'prj_a' });
    expect(sandboxCredentials({ accessToken: 'vcp_x', teamId: 'team_a' }).teamId).toBe('team_build');
  });

  it('has nothing to offer without a readable token', () => {
    delete process.env.VERCEL_OIDC_TOKEN;
    globalThis[context] = undefined;
    expect(sandboxCredentials()).toBeNull();
    process.env.VERCEL_OIDC_TOKEN = 'not-a-token';
    expect(sandboxCredentials()).toBeNull();
    process.env.VERCEL_OIDC_TOKEN = token({ sub: 'no ids in here' });
    expect(sandboxCredentials()).toBeNull();
  });
});

describe('reading the runner’s answer', () => {
  it('takes the last report line and ignores everything around it', () => {
    const text = `noise\n${REPORT_PREFIX}{"version":1,"n":1}\nmore\n${REPORT_PREFIX}{"version":1,"n":2}\n`;
    expect(parseReport(text)).toEqual({ version: 1, n: 2 });
    expect(parseReport('nothing here')).toBeNull();
    expect(parseReport(`${REPORT_PREFIX}{"cut":`)).toBeNull();
    expect(parseReport(undefined)).toBeNull();
  });
});
