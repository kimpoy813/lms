// The Vercel Sandbox judge (src/services/judge/vercelSandbox.js) against a stand-in for Vercel's
// SDK: which machines it asks for, what it uploads, how it reads the answer, and what it does when
// the prepared image is missing, busy or broken. No machine is started and no program is run here;
// the runner itself is tested in judge-runner.test.js, and both together against a real account by
// scripts/judge-image.mjs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiError, fakeSandboxAccount, okReport } from '../helpers/fakeSandbox.js';
import { REPORT_PREFIX, RUNNER_MARKER, RUNNER_VERSION } from '../../src/services/judge/vmRunner.mjs';
import {
  BASE_IMAGE, IMAGE_TAG, JOB_DEADLINE_MS, JudgeUnavailable, classifyError, createSandboxJudge, describeError, imageName, imageScript,
  parseReport, resolveIdentity, sandboxCredentials, setSandboxSdk, toRun,
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
    region: REGION, identity: () => ({ credentials: CREDS }),
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
    // Marked, so that a machine that was never removed can be found on the account later.
    expect(fork.tags).toEqual({ edusphere: 'judge-run' });
    expect(fork.timeout).toBeGreaterThanOrEqual(60_000);
    expect(fork.signal).toBeInstanceOf(AbortSignal);
    // One upload and one command as root; the answer is there while the machine is still being stopped.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop']);
    expect(fake.calls[2]).toEqual(['runCommand', 'job-1', 'node /tmp/judge-job/runner.mjs /tmp/judge-job', { sudo: true, detached: false, timeoutMs: JOB_DEADLINE_MS + 10_000 }]);
    machineStopped();
    await settle();
    expect(fake.names().slice(3)).toEqual(['stop', 'delete']);
    // Nobody waits for ever for a machine to stop: both steps give up after a few seconds.
    expect(fake.machines[0].stopOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fake.calls.at(-1)[2].signal).toBeInstanceOf(AbortSignal);
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
    const { judge } = judgeFor(fake, { identity: () => ({ credentials: null, problem: null }) });
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('identity');
    expect(err.detail).toMatch(/No identity token.*VERCEL_TOKEN/);
    // A token that was there and is not used is the better explanation.
    const other = judgeFor(fake, { identity: () => ({ credentials: null, problem: 'An identity token for another Vercel project was found; nothing is started with it.' }) });
    expect(await unavailable(other.judge.runBatch(program))).toMatchObject({ kind: 'identity', detail: 'An identity token for another Vercel project was found; nothing is started with it.' });
    expect(fake.calls).toEqual([]);
  });

  it('removes the machine before answering where nothing can be finished after the answer', async () => {
    const fake = account();
    let machineStopped;
    fake.state.stopGate = new Promise((resolve) => { machineStopped = resolve; });
    const inBackground = [];
    const { judge } = judgeFor(fake, { removeBeforeAnswering: () => true, background: (task, label) => inBackground.push(label) });
    let answered = false;
    const answer = judge.runBatch(program).then((out) => {
      answered = true;
      return out;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The program has been checked, but the answer waits for the machine to be gone.
    expect(fake.names()).toEqual(['fork', 'writeFiles', 'runCommand', 'stop']);
    expect(answered).toBe(false);
    machineStopped();
    expect((await answer).runs.map((run) => run.stdout)).toEqual(['4\n', '10\n']);
    expect(fake.names().slice(3)).toEqual(['stop', 'delete']);
    expect(inBackground).toEqual([]);
  });

  it('still answers when the machine cannot be removed, and says so in the log', async () => {
    const fake = account();
    fake.state.stopError = apiError(500, 'internal', 'could not stop');
    const { judge, warnings } = judgeFor(fake, { removeBeforeAnswering: () => true });
    expect((await judge.runBatch(program)).runs).toHaveLength(2);
    expect(warnings).toEqual([['a machine of the code runner could not be removed; it ends itself within minutes', { detail: 'HTTP 500 internal: could not stop' }]]);
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

  it('anything else is a failure, and the image is left alone', async () => {
    for (const refusal of [apiError(500, 'internal', 'boom'), apiError(400, 'bad_request', 'Invalid request: `region` is not available'), new Error('fetch failed')]) {
      const { err, fake } = await tryWith(refusal);
      expect(err.kind).toBe('failed');
      expect(fake.names()).toEqual(['fork']);
      expect(fake.bases.has(NAME)).toBe(true);
    }
    expect((await tryWith(apiError(500, 'internal', 'boom'))).err.detail).toBe('HTTP 500 internal: boom');
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
    // Kept until it is deleted: Vercel's default removes a snapshot that was not used for 30 days, and a break between terms is longer.
    expect(created).toMatchObject({ snapshotExpiration: 0, keepLastSnapshots: { count: 1 } });
    expect(created.tags).toEqual({ edusphere: 'judge-image' });
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

  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000);
  /** A machine made from an image whose installation never finished does not carry the tag. */
  const incomplete = (job) => ({ ...okReport(job), image: null });

  it('is stopped as it is when the installation failed, as the record of that attempt', async () => {
    const fake = account({ image: 'preparing', installation: 'failed' });
    const { judge, warnings } = judgeFor(fake);
    const step = await judge.advanceImage();
    expect(step.state).toBe('failed');
    expect(step.detail).toMatch(/exit 100.*Unable to locate package/);
    expect(fake.names()).toEqual(['get', 'runCommand', 'stop']);
    expect(warnings[0][0]).toMatch(/preparing the machine image .* failed/);
    // Nobody prepares another one straight away: not a look at it, and not a request that finds it unusable.
    expect(await judge.advanceImage()).toEqual({ state: 'stopped' });
    const again = await judge.advanceImage({ replaceStopped: true });
    expect(again.state).toBe('failed');
    expect(again.detail).toMatch(/prepared 1 minutes ago cannot be used\. It is replaced by the next deployment, or by itself after \d{4}-/);
    expect(fake.names().filter((n) => n === 'create' || n === 'delete')).toEqual([]);
  });

  it('is not replaced by a request while it is young, however often it is found incomplete', async () => {
    const fake = account({ report: incomplete });
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err).toMatchObject({ kind: 'failed', image: true });
    expect(err.detail).toMatch(/cannot be used.*marked null, expected/);
    await settle();
    expect(fake.names().filter((n) => n === 'create' || (n === 'delete'))).toEqual(['delete']); // the job's own machine only
    expect(fake.calls.find((c) => c[0] === 'delete')[1]).toBe('job-1');
    // For a moment the same answer is given without starting a machine or asking Vercel.
    const before = fake.calls.length;
    expect(await unavailable(judge.runBatch(program))).toBe(err);
    expect(fake.calls.length).toBe(before);
  });

  it('is replaced by a request once it is six hours old', async () => {
    const fake = account({ report: incomplete });
    fake.bases.get(NAME).createdAt = hoursAgo(7);
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('preparing');
    await settle();
    // The half-made image went, with its snapshot, and a new one is on its way.
    expect(fake.calls.find((c) => c[0] === 'delete' && c[1] === NAME)).toEqual(['delete', NAME, { deleteOrphanSnapshots: true }]);
    expect(fake.names().filter((n) => n === 'create')).toHaveLength(1);
    expect(fake.bases.get(NAME).status).toBe('running');
  });

  it('is prepared again when Vercel removed its snapshot after a month without use', async () => {
    const fake = account({ forkError: apiError(404, 'snapshot_not_found', 'The snapshot of this sandbox has expired') });
    fake.bases.get(NAME).createdAt = hoursAgo(24 * 45);
    const { judge, settle } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('preparing');
    expect(err.detail).toBe('HTTP 404 snapshot_not_found: The snapshot of this sandbox has expired');
    await settle();
    expect(fake.names()).toEqual(['fork', 'get', 'delete', 'create', 'writeFiles', 'runCommand']);
  });

  it('tells the next try to go ahead when it became ready in the meantime', async () => {
    // Somebody else is preparing it; by the time this request looks, the installation is done.
    const fake = account({ image: 'preparing', forkError: apiError(404, 'not_found', 'no snapshot yet') });
    const { judge } = judgeFor(fake);
    const err = await unavailable(judge.runBatch(program));
    expect(err.kind).toBe('busy');
    expect(fake.names()).toEqual(['fork', 'get', 'runCommand', 'stop']);
    // No waiting period after that: the image is usable now.
    fake.state.forkError = null;
    expect((await judge.runBatch(program)).runs).toHaveLength(2);
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

  const selfTestReport = (job, machine) => ({ ...okReport(job), image: machine.madeFrom.installation === 'failed' || machine.madeFrom.broken ? null : IMAGE_TAG, selfTest: { languages: { PYTHON: { ok: true } }, versions: {} } });

  it('waiting reports a language that does not work', async () => {
    const half = account({ report: (job) => ({ ...okReport(job), selfTest: { languages: { PYTHON: { ok: true }, JAVA: { ok: false, detail: 'not installed: javac, java' } }, versions: {} } }) });
    expect(await judgeFor(half).judge.ensureImage({ pollMs: 1 })).toMatchObject({ ok: false, state: 'incomplete', prepared: false });
  });

  it('a deployment replaces an unusable image at once, however young, and proves the new one', async () => {
    const fake = account({ report: selfTestReport });
    fake.bases.get(NAME).broken = true; // stopped half-way an hour ago, say
    const { judge, settle } = judgeFor(fake);
    const progress = [];
    const result = await judge.ensureImage({ pollMs: 1, onProgress: (line) => progress.push(line) });
    await settle();
    expect(result).toMatchObject({ ok: true, state: 'ready', prepared: true });
    expect(progress).toEqual(['stopped', 'the image cannot be used; preparing it again', 'ready']);
    expect(fake.names().filter((n) => n === 'create')).toHaveLength(1);
    expect(fake.calls.find((c) => c[0] === 'delete' && c[1] === NAME)).toEqual(['delete', NAME, { deleteOrphanSnapshots: true }]);
  });

  it('a deployment tries a failed installation once more, and gives up when that fails as well', async () => {
    const fake = account({ image: 'missing', report: selfTestReport });
    fake.state.installations = ['failed', 'failed', 'done'];
    const { judge } = judgeFor(fake);
    const progress = [];
    const result = await judge.ensureImage({ pollMs: 1, onProgress: (line) => progress.push(line) });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('failed');
    expect(result.detail).toMatch(/still not usable after preparing it again.*exit 100/);
    // Two attempts, not three: the third installation would have worked, but was never started.
    expect(fake.names().filter((n) => n === 'create')).toHaveLength(2);
    expect(progress.filter((line) => line.startsWith('failed'))).toHaveLength(2);
  });

  it('a deployment does not prepare another image when the check fails for a reason outside it', async () => {
    const fake = account({ forkError: apiError(402, 'payment_required', 'Sandbox creation is paused') });
    const { judge } = judgeFor(fake);
    const result = await judge.ensureImage({ pollMs: 1 });
    expect(result).toMatchObject({ ok: false, state: 'failed', prepared: false });
    expect(result.detail).toMatch(/allowance.*HTTP 402/);
    expect(fake.names()).toEqual(['get', 'fork']);
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
    const kept = { images: [{ name: NAME, status: 'stopped', current: true }, { name: 'somebody-elses-sandbox', status: 'stopped', current: false }], snapshots: 1, snapshotBytes: 1_103_000_000 };
    // The snapshot of the image in use is kept until the image is deleted …
    expect(await judge.inventory()).toEqual({ ...kept, imageKeptUntil: null });
    // … and one that Vercel would remove for not being used is reported with its date.
    fake.state.snapshotExpiresAt = Date.UTC(2026, 11, 12, 8);
    expect(await judge.inventory()).toEqual({ ...kept, imageKeptUntil: '2026-12-12T08:00:00.000Z' });
    // Without the image, or when its snapshot is not among those listed, nothing is claimed.
    fake.bases.get(NAME).currentSnapshotId = 'snap_unknown';
    expect((await judge.inventory()).imageKeptUntil).toBeUndefined();
    fake.bases.delete(NAME);
    expect(await judge.inventory()).toEqual({ images: [kept.images[1]], snapshots: 1, snapshotBytes: 1_103_000_000, imageKeptUntil: undefined });
  });

  it('is prepared the ordinary way on an account that may not keep a snapshot for good', async () => {
    const fake = account({ image: 'missing' });
    fake.state.createError = (params) => ('snapshotExpiration' in params || 'keepLastSnapshots' in params ? apiError(400, 'bad_request', 'snapshotExpiration is not available on this plan') : null);
    const { judge, warnings } = judgeFor(fake);
    expect(await judge.advanceImage()).toEqual({ state: 'preparing', detail: 'started' });
    const [first, second] = fake.calls.filter((c) => c[0] === 'create').map((c) => c[1]);
    expect(first).toMatchObject({ name: NAME, snapshotExpiration: 0 });
    expect(second).toMatchObject({ name: NAME, image: BASE_IMAGE, persistent: true, ...CREDS });
    expect(second).not.toHaveProperty('snapshotExpiration');
    expect(second).not.toHaveProperty('keepLastSnapshots');
    expect(warnings[0][0]).toMatch(/cannot be kept for good/);
    expect(warnings[0][1].detail).toBe('HTTP 400 bad_request: snapshotExpiration is not available on this plan');
    expect(fake.bases.has(NAME)).toBe(true);

    // Reasons that have nothing to do with how the image is kept are not tried twice.
    const paused = account({ image: 'missing' });
    paused.state.createError = () => apiError(402, 'payment_required', 'Sandbox creation is paused');
    const other = judgeFor(paused);
    await expect(other.judge.advanceImage()).rejects.toMatchObject({ response: { status: 402 } });
    expect(paused.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });

  it('finds the machines of single programs that were never removed, and deletes those that have ended', async () => {
    const fake = account();
    // Nothing that should happen after the answer happens: the function was frozen each time.
    const { judge } = judgeFor(fake, { background: () => {} });
    await judge.runBatch(program);
    await judge.runBatch(program);
    await judge.runBatch(program);
    const [first, second, third] = fake.machines;
    expect(fake.machines.map((machine) => machine.status)).toEqual(['running', 'running', 'running']);
    // Two of them have ended by themselves since; the third is still in its last minutes.
    first.status = 'stopped';
    second.status = 'failed';
    expect(await judge.removeLeftoverMachines()).toEqual({ removed: 2, running: 1 });
    expect(fake.calls.filter((c) => c[0] === 'list').pop()[1]).toMatchObject({ tags: { edusphere: 'judge-run' }, ...CREDS });
    expect([first.deleted, second.deleted, third.deleted]).toEqual([true, true, false]);
    // The image carries another mark and stays — and would stay with the wrong mark too.
    expect([...fake.bases.keys()]).toEqual([NAME]);
    fake.bases.get(NAME).tags = { edusphere: 'judge-run' };
    expect(await judge.removeLeftoverMachines()).toEqual({ removed: 0, running: 1 });
    expect([...fake.bases.keys()]).toEqual([NAME]);
    // Not more than asked for in one go.
    third.status = 'stopped';
    expect(await judge.removeLeftoverMachines({ limit: 0 })).toEqual({ removed: 0, running: 0 });
    expect(third.deleted).toBe(false);
  });
});

describe('who starts the machines', () => {
  const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const context = Symbol.for('@vercel/request-context');
  const saved = { token: process.env.VERCEL_OIDC_TOKEN, project: process.env.VERCEL_PROJECT_ID, context: globalThis[context] };
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(() => {
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
    globalThis[context] = undefined;
  });
  afterEach(() => {
    restore('VERCEL_OIDC_TOKEN', saved.token);
    restore('VERCEL_PROJECT_ID', saved.project);
    globalThis[context] = saved.context;
  });
  const WITH_REQUEST = 'the project’s identity, handed to this request by Vercel';

  it('uses the token that came with the request, before the one a build gets', () => {
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_build', project_id: 'prj_build' });
    expect(sandboxCredentials()).toEqual({ token: process.env.VERCEL_OIDC_TOKEN, teamId: 'team_build', projectId: 'prj_build' });
    expect(resolveIdentity()).toMatchObject({ source: 'the project’s identity, from the environment', problem: null });

    // What the function's entry point noted when the request arrived …
    const noted = token({ owner_id: 'team_fn', project_id: 'prj_fn', nonce: 'noted' });
    expect(resolveIdentity({ requestToken: noted })).toEqual({ credentials: { token: noted, teamId: 'team_fn', projectId: 'prj_fn' }, source: WITH_REQUEST, problem: null });

    // … and what the platform answers when asked at this moment, which is what Vercel's SDK would use in any case.
    const asked = token({ owner_id: 'team_fn', project_id: 'prj_fn', nonce: 'asked' });
    globalThis[context] = { get: () => ({ headers: { 'x-vercel-oidc-token': asked } }) };
    expect(resolveIdentity()).toEqual({ credentials: { token: asked, teamId: 'team_fn', projectId: 'prj_fn' }, source: WITH_REQUEST, problem: null });
    expect(resolveIdentity({ requestToken: noted }).credentials.token).toBe(asked);
    expect(resolveIdentity({ requestToken: null }).credentials.token).toBe(asked);

    // A platform that cannot be asked is no platform.
    globalThis[context] = { get: () => { throw new Error('not in a request'); } };
    expect(resolveIdentity({ requestToken: noted }).credentials.token).toBe(noted);
  });

  it('uses an access token when one is configured in full', () => {
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_build', project_id: 'prj_build' });
    const full = { accessToken: 'vcp_x', teamId: 'team_a', projectId: 'prj_a' };
    expect(sandboxCredentials(full)).toEqual({ token: 'vcp_x', teamId: 'team_a', projectId: 'prj_a' });
    // Whatever came with a request plays no part then.
    expect(resolveIdentity({ ...full, requestToken: token({ owner_id: 'team_fn', project_id: 'prj_fn' }) })).toEqual({ credentials: { token: 'vcp_x', teamId: 'team_a', projectId: 'prj_a' }, source: 'access token', problem: null });
    expect(sandboxCredentials({ accessToken: 'vcp_x', teamId: 'team_a' }).teamId).toBe('team_build');
  });

  it('only uses a token for the project Vercel names as the deployment’s own', () => {
    process.env.VERCEL_PROJECT_ID = 'prj_site';
    const own = token({ owner_id: 'team_site', project_id: 'prj_site' });
    const foreign = token({ owner_id: 'team_somebody', project_id: 'prj_somebody' });
    const refused = { credentials: null, source: 'none', problem: 'An identity token for another Vercel project was found; nothing is started with it.' };
    expect(resolveIdentity({ requestToken: own })).toMatchObject({ credentials: { token: own, teamId: 'team_site', projectId: 'prj_site' }, source: WITH_REQUEST });

    // A token of another project: machines would be started on, and answers taken from, somebody else's account.
    expect(resolveIdentity({ requestToken: foreign })).toEqual(refused);
    process.env.VERCEL_OIDC_TOKEN = foreign;
    expect(resolveIdentity()).toEqual(refused);

    // One that came with the request is not passed over for a good one from elsewhere: Vercel's SDK
    // would find it in the same place and use it, whatever it was given.
    process.env.VERCEL_OIDC_TOKEN = own;
    expect(resolveIdentity({ requestToken: foreign })).toEqual(refused);
    globalThis[context] = { get: () => ({ headers: { 'x-vercel-oidc-token': foreign } }) };
    expect(resolveIdentity({ requestToken: own })).toEqual(refused);
    expect(resolveIdentity()).toEqual(refused);
    globalThis[context] = undefined;
    expect(resolveIdentity().credentials.token).toBe(own);

    // Where the project is not named there is nothing to compare with.
    delete process.env.VERCEL_PROJECT_ID;
    expect(resolveIdentity({ requestToken: foreign }).credentials).toMatchObject({ teamId: 'team_somebody', projectId: 'prj_somebody' });
  });

  it('has nothing to offer without a readable token', () => {
    expect(resolveIdentity()).toEqual({ credentials: null, source: 'none', problem: null });
    expect(sandboxCredentials()).toBeNull();
    process.env.VERCEL_OIDC_TOKEN = 'not-a-token';
    expect(resolveIdentity()).toEqual({ credentials: null, source: 'none', problem: 'An identity token was found, but it does not name a team and a project.' });
    process.env.VERCEL_OIDC_TOKEN = token({ sub: 'no ids in here' });
    expect(sandboxCredentials()).toBeNull();
    expect(resolveIdentity({ requestToken: 'a.b' }).credentials).toBeNull();
    expect(resolveIdentity({ requestToken: 42 }).credentials).toBeNull();
  });

  it('leaves aside a token whose time is over, such as one a build left behind', () => {
    const seconds = (fromNow) => Math.floor(Date.now() / 1000) + fromNow;
    const stale = token({ owner_id: 'team_site', project_id: 'prj_site', exp: seconds(-60) });
    const fresh = token({ owner_id: 'team_site', project_id: 'prj_site', exp: seconds(3600) });
    process.env.VERCEL_OIDC_TOKEN = stale;
    expect(resolveIdentity()).toEqual({ credentials: null, source: 'none', problem: 'An identity token was found, but it has expired.' });
    expect(resolveIdentity({ requestToken: fresh })).toMatchObject({ credentials: { token: fresh }, source: WITH_REQUEST, problem: null });
    // The request's own token counts, also when it is of no use.
    process.env.VERCEL_OIDC_TOKEN = fresh;
    expect(resolveIdentity({ requestToken: stale })).toEqual({ credentials: null, source: 'none', problem: 'An identity token was found, but it has expired.' });
    expect(resolveIdentity().credentials.token).toBe(fresh);
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
