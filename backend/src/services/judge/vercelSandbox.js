// Vercel Sandbox as the judge: every submission gets a virtual machine of its own.
//
//   one request to check a program
//     → a fresh machine is forked from a prepared one (compilers installed, about a second),
//       with no network access at all
//     → the job (program, inputs, limits) and the runner (vmRunner.mjs) are uploaded
//     → the runner compiles and runs the program as a user without rights and reports
//     → the machine is stopped and thrown away.
//
// The prepared machine ("image") is a sandbox that was set up once and then stopped; Vercel keeps
// its disk as a snapshot. It is found by its name, which contains a fingerprint of the recipe, so
// nothing about it has to be stored anywhere. When it is missing (first use, or the snapshot
// expired after a month without use) it is prepared again, which takes a few minutes; in the
// meantime programs are not checked and the caller is told so.
//
// This file does not read the application's configuration: the API (services/codeRunner.js) and
// the build step (scripts/judge-image.mjs) both use it and pass what they know.
import { createHash } from 'node:crypto';
import { IMAGE_MARKER_FILE, REPORT_PREFIX, RUNNER_VERSION, runnerSource } from './vmRunner.mjs';

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The Vercel image the prepared machine starts from, and what is added to it. */
export const BASE_IMAGE = 'vercel/sandbox/ubuntu';
export const IMAGE_PACKAGES = ['python3', 'nodejs', 'gcc', 'g++', 'libc6-dev', 'default-jdk-headless'];
const IMAGE_LOG = '/var/log/edusphere-judge-image.log';
const IMAGE_FAILED_FILE = `${IMAGE_MARKER_FILE}.failed`;
const IMAGE_SCRIPT_PATH = '/var/tmp/edusphere-judge-image.sh';

const recipe = (tag) => `#!/bin/bash
# Prepares a machine for checking students' programs in Python, JavaScript, C, C++ and Java.
# The last step writes the tag that marks the machine as complete.
exec > ${IMAGE_LOG} 2>&1
set -euo pipefail
trap 'code=$?; [ "$code" -eq 0 ] || echo "exit $code" > ${IMAGE_FAILED_FILE}' EXIT
export DEBIAN_FRONTEND=noninteractive
retry() { for attempt in 1 2 3; do "$@" && return 0; sleep 5; done; return 1; }
retry apt-get update -qq
retry apt-get install -y -qq --no-install-recommends ${IMAGE_PACKAGES.join(' ')}
id judge-run >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin judge-run
python3 --version; node --version; gcc --version | head -1; g++ --version | head -1; javac -version; java -version 2>&1 | head -1
command -v setpriv prlimit
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*
printf '%s\\n' '${tag}' > ${IMAGE_MARKER_FILE}
sync
`;

/** Changes whenever the recipe changes, so a new recipe gets a new machine. */
export const IMAGE_TAG = createHash('sha256').update(`${BASE_IMAGE}\n${recipe('')}`).digest('hex').slice(0, 10);
export const imageScript = () => recipe(IMAGE_TAG);
export const imageName = (region) => `edusphere-judge-${IMAGE_TAG}-${region}`;
export const IMAGE_NAME_PREFIX = 'edusphere-judge-';

const JOB_DIR = '/tmp/judge-job';
/**
 * Compiling and running everything, inside the machine. Together with starting the machine and
 * uploading the job this has to stay below the time a request may take (120 s on Vercel, see
 * vercel.json): 25 s + 20 s + 50 s + 10 s.
 */
export const JOB_DEADLINE_MS = 50_000;
const START_TIMEOUT_MS = 25_000;
const UPLOAD_TIMEOUT_MS = 20_000;
const COMMAND_GRACE_MS = 10_000;
/** A machine that was not stopped for whatever reason ends itself after this long. */
const MACHINE_LIFETIME_MS = 3 * 60_000;
const PREPARE_LIFETIME_MS = 10 * 60_000;
/** After a preparation failed, wait this long before the same process tries again. */
const PREPARE_RETRY_MS = 15 * 60_000;

/**
 * Why a program could not be checked.
 * kind: 'busy' (try again in a moment), 'preparing' (try again in a few minutes), 'allowance'
 * (the plan's monthly quota is used up), 'identity' (not allowed to use the account),
 * 'failed' (anything else).
 */
export class JudgeUnavailable extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'JudgeUnavailable';
    this.kind = kind;
    this.detail = detail ?? null;
  }
}

/** What Vercel's API said, in one line, for logs and for the administrator. */
export function describeError(err) {
  if (err instanceof JudgeUnavailable) return [err.message, err.detail].filter(Boolean).join(' — ');
  const status = err?.response?.status ? `HTTP ${err.response.status} ` : '';
  const code = err?.json?.error?.code ? `${err.json.error.code}: ` : '';
  return `${status}${code}${err?.json?.error?.message ?? err?.message ?? String(err)}`.replace(/\s+/g, ' ').trim().slice(0, 400);
}

const httpStatus = (err) => err?.response?.status ?? null;
const apiCode = (err) => String(err?.json?.error?.code ?? '');

/** Turn a failure of Vercel's API into a reason the rest of the application understands. */
export function classifyError(err, what = 'The code checker') {
  if (err instanceof JudgeUnavailable) return err;
  const status = httpStatus(err);
  const code = apiCode(err);
  const detail = describeError(err);
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new JudgeUnavailable('busy', `${what} took too long to answer.`, detail);
  if (status === 429) return new JudgeUnavailable('busy', `${what} is busy.`, detail);
  if (status === 402 || /payment|quota|usage|paused|exceeded/i.test(code)) return new JudgeUnavailable('allowance', 'The allowance for running programs is used up for now.', detail);
  if (status === 401 || status === 403) return new JudgeUnavailable('identity', 'This site is not allowed to start machines on its Vercel account.', detail);
  return new JudgeUnavailable('failed', `${what} could not do its work.`, detail);
}

function decodeClaims(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Who starts the machines.
 *   - On Vercel the project's own short-lived identity token: Vercel hands it to a function with
 *     every request and to a build as VERCEL_OIDC_TOKEN. Nothing has to be configured or stored.
 *   - Anywhere else an access token with the team and project it belongs to.
 * Read again for every job: the token changes about every hour.
 */
export function sandboxCredentials({ accessToken, teamId, projectId } = {}) {
  if (accessToken && teamId && projectId) return { token: accessToken, teamId, projectId };
  const fromRequest = globalThis[REQUEST_CONTEXT]?.get?.()?.headers?.['x-vercel-oidc-token'];
  const token = (typeof fromRequest === 'string' && fromRequest) || process.env.VERCEL_OIDC_TOKEN || null;
  const claims = token ? decodeClaims(token) : null;
  if (!claims?.owner_id || !claims?.project_id) return null;
  return { token, teamId: claims.owner_id, projectId: claims.project_id };
}

let sdkOverride = null;
/** Tests replace Vercel's SDK with a fake. Pass null to restore it. */
export function setSandboxSdk(fake) {
  sdkOverride = fake;
}
// Loaded on first use: nothing of the SDK is touched by an installation that does not use it.
const loadSdk = async () => sdkOverride ?? import('@vercel/sandbox');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseReport(output) {
  const lines = String(output ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(REPORT_PREFIX)) continue;
    try {
      const report = JSON.parse(lines[i].slice(REPORT_PREFIX.length));
      if (report && typeof report === 'object') return report;
    } catch {
      return null;
    }
  }
  return null;
}

const SIGNALS = {
  SIGSEGV: [139, 'Segmentation fault: the program used memory that does not belong to it.'],
  SIGFPE: [136, 'Arithmetic error, for example a division by zero.'],
  SIGABRT: [134, 'The program aborted.'],
  SIGBUS: [135, 'Bus error: the program used memory in a way that is not allowed.'],
  SIGILL: [132, 'Illegal instruction.'],
  SIGXFSZ: [153, 'The program wrote a file that is too large.'],
  SIGKILL: [137, 'The program was stopped.'],
};

const note = (text, addition) => (text && text.trim() ? `${text.replace(/\n+$/, '')}\n${addition}` : addition);

/** One test as the runner reported it → what the application works with. */
export function toRun(run, { memoryLimitKb }) {
  const out = { stdout: run.stdout ?? '', stderr: run.stderr ?? '', exitCode: run.exitCode ?? null, timedOut: false };
  if (run.status === 'timeout') return { ...out, timedOut: true };
  if (run.status === 'not-run') return { ...out, timedOut: true, stderr: note(out.stderr, 'Not run: the tests before this one used up the time the checker has for one program.') };
  if (run.status === 'output-limit') return { ...out, exitCode: 1, stderr: note(out.stderr, 'Output limit exceeded: the program printed more than 64 KB.') };
  if (run.status === 'memory-limit') return { ...out, exitCode: 137, stderr: note(out.stderr, `Memory limit exceeded (${Math.round(memoryLimitKb / 1024)} MB).`) };
  if (run.signal) {
    const [code, text] = SIGNALS[run.signal] ?? [1, `The program was stopped by ${run.signal}.`];
    return { ...out, exitCode: code, stderr: note(out.stderr, text) };
  }
  if (run.processLimit && out.exitCode !== 0) return { ...out, stderr: note(out.stderr, 'The program tried to start more processes than it is allowed to.') };
  return out;
}

/**
 * @param {object} options
 * @param {string} options.region          Vercel region code of the machines, e.g. "sin1"
 * @param {() => ({ token, teamId, projectId } | null)} [options.credentials]
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {(task: () => Promise<unknown>, label: string) => unknown} [options.background] runs work that may outlive the request
 */
export function createSandboxJudge({ region, credentials = () => sandboxCredentials(), log = { info() {}, warn() {} }, background = (task) => task().catch(() => {}) }) {
  if (!region) throw new Error('createSandboxJudge needs the region the machines run in');
  const name = imageName(region);
  let notBefore = 0; // image preparation is not tried again before this time (this process only)
  let notReadyUntil = 0; // jobs are turned away until this time, because the image is being prepared
  let advancing = null;

  const identity = () => {
    const creds = credentials();
    if (!creds) throw new JudgeUnavailable('identity', 'This site has no Vercel identity to start machines with.', 'No OIDC token reached this process, and VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are not all set.');
    return creds;
  };

  async function findBase(Sandbox, creds) {
    try {
      return await Sandbox.get({ name, ...creds });
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
  }

  async function startBase(Sandbox, creds) {
    const base = await Sandbox.create({ name, image: BASE_IMAGE, region, resources: { vcpus: 2 }, timeout: PREPARE_LIFETIME_MS, persistent: true, tags: { edusphere: 'judge-image' }, ...creds });
    await base.writeFiles([{ path: IMAGE_SCRIPT_PATH, content: imageScript() }]);
    await base.runCommand({ cmd: 'bash', args: [IMAGE_SCRIPT_PATH], sudo: true, detached: true });
    log.info({ image: name }, 'preparing the machine image for running programs');
    return base;
  }

  async function removeBase(base) {
    await base.delete({ deleteOrphanSnapshots: true });
  }

  /**
   * Look at the image and take the next step, if there is one to take.
   * @param {{ replaceStopped?: boolean }} [options] replaceStopped: the stopped image turned out to be incomplete
   * @returns {Promise<{ state: 'ready'|'stopped'|'preparing'|'finalizing'|'waiting'|'failed', detail?: string, sizeBytes?: number }>}
   *   'stopped' means "prepared, as far as can be told from outside": only a job shows whether it is complete.
   */
  async function advanceImage({ replaceStopped = false } = {}) {
    const creds = identity();
    const { Sandbox } = await loadSdk();
    let base = await findBase(Sandbox, creds);
    const status = base?.status ?? null;

    if (base && (status === 'failed' || status === 'aborted' || (status === 'stopped' && replaceStopped))) {
      if (Date.now() < notBefore) return { state: 'waiting', detail: 'The last preparation failed; the next one is not tried yet.' };
      await removeBase(base);
      base = null;
    }
    if (!base) {
      if (Date.now() < notBefore) return { state: 'waiting', detail: 'The last preparation failed; the next one is not tried yet.' };
      try {
        await startBase(Sandbox, creds);
      } catch (err) {
        // Somebody else (another request, a build) created it in the same moment.
        if (httpStatus(err) === 409) return { state: 'preparing', detail: 'started by another process' };
        throw err;
      }
      return { state: 'preparing', detail: 'started' };
    }
    if (status === 'stopping' || status === 'snapshotting') return { state: 'finalizing' };
    if (status === 'stopped') return { state: 'stopped' };

    // pending or running: how far is the installation?
    let progress;
    try {
      const check = await base.runCommand({ cmd: 'bash', args: ['-c', `cat ${IMAGE_MARKER_FILE} 2>/dev/null; echo; echo ---; cat ${IMAGE_FAILED_FILE} 2>/dev/null; echo; echo ---; tail -c 500 ${IMAGE_LOG} 2>/dev/null; true`], timeoutMs: 20_000 });
      progress = await check.stdout();
    } catch (err) {
      return { state: 'preparing', detail: `could not ask the machine yet (${describeError(err).slice(0, 120)})` };
    }
    const [tag = '', failed = '', tail = ''] = progress.split('\n---\n').map((part) => part.trim());
    if (tag === IMAGE_TAG) {
      const stopped = await base.stop();
      log.info({ image: name, sizeBytes: stopped?.snapshot?.sizeBytes }, 'the machine image for running programs is ready');
      return { state: 'ready', sizeBytes: stopped?.snapshot?.sizeBytes };
    }
    if (failed) {
      notBefore = Date.now() + PREPARE_RETRY_MS;
      await removeBase(base).catch(() => {});
      const detail = `The installation ended with ${failed}: ${tail.split('\n').slice(-4).join(' | ')}`.slice(0, 500);
      log.warn({ image: name, detail }, 'preparing the machine image for running programs failed');
      return { state: 'failed', detail };
    }
    return { state: 'preparing', detail: tail.split('\n').pop()?.slice(0, 160) || 'installing' };
  }

  /** At most one look at the image at a time in this process; failures are logged, not thrown. */
  function advanceInBackground(options) {
    advancing ??= Promise.resolve()
      .then(() => advanceImage(options))
      .catch((err) => {
        log.warn({ image: name, detail: describeError(err) }, 'could not look after the machine image for running programs');
      })
      .finally(() => {
        advancing = null;
      });
    background(() => advancing, 'looking after the judge machine image');
  }

  const preparing = (detail) => new JudgeUnavailable('preparing', 'The machine that runs programs is being prepared. This takes a few minutes.', detail);

  /** Start a machine for one job, run the runner in it, and return its report. */
  async function runRunner(job) {
    if (Date.now() < notReadyUntil) throw preparing('The image was not ready a moment ago.');
    const creds = identity();
    const { Sandbox } = await loadSdk();
    const started = Date.now();
    let machine;
    try {
      machine = await Sandbox.fork({ sourceSandbox: name, region, resources: { vcpus: 1 }, timeout: MACHINE_LIFETIME_MS, persistent: false, networkPolicy: 'deny-all', signal: AbortSignal.timeout(START_TIMEOUT_MS), ...creds });
    } catch (err) {
      const unavailable = classifyError(err, 'The machine for the program');
      if (unavailable.kind !== 'failed') throw unavailable;
      // No machine could be made from the image. Is the image missing, or still being set up?
      // Then have it prepared and say so; anything else is a failure and is reported as one.
      const base = await findBase(Sandbox, creds).catch(() => undefined);
      if (base === undefined || base?.status === 'stopped') throw unavailable;
      notReadyUntil = Date.now() + 20_000;
      advanceInBackground();
      throw preparing(unavailable.detail);
    }
    const startMs = Date.now() - started;
    try {
      const upload = Date.now();
      await machine.writeFiles(
        [
          { path: `${JOB_DIR}/job.json`, content: JSON.stringify(job) },
          { path: `${JOB_DIR}/runner.mjs`, content: runnerSource() },
        ],
        { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) },
      );
      const uploadMs = Date.now() - upload;
      const run = Date.now();
      const command = await machine.runCommand({ cmd: 'node', args: [`${JOB_DIR}/runner.mjs`, JOB_DIR], sudo: true, timeoutMs: (job.deadlineMs ?? JOB_DEADLINE_MS) + COMMAND_GRACE_MS });
      const output = await command.stdout();
      let report = parseReport(output);
      if (!report) {
        // The report did not come through with the output (too large, or cut): fetch the file.
        const file = await machine.readFileToBuffer({ path: `${JOB_DIR}/report.json` }).catch(() => null);
        report = file ? parseReport(`${REPORT_PREFIX}${file.toString('utf8')}`) : null;
      }
      if (!report) throw new JudgeUnavailable('failed', 'The code checker did not finish its work.', `The runner ended with exit code ${command.exitCode} and no report. ${String(await command.stderr().catch(() => '')).slice(-300)}`);
      if (report.error) throw new JudgeUnavailable('failed', 'The code checker could not do its work.', String(report.error).slice(0, 400));
      if (report.version !== RUNNER_VERSION) throw new JudgeUnavailable('failed', 'The code checker could not do its work.', `Runner version ${report.version}, expected ${RUNNER_VERSION}.`);
      if (report.image !== IMAGE_TAG) {
        // The machine came up, but not from a complete image: its preparation is still running,
        // or it stopped half-way. Have it finished or replaced.
        notReadyUntil = Date.now() + 20_000;
        advanceInBackground({ replaceStopped: true });
        throw preparing(`The image is marked ${JSON.stringify(report.image)}, expected ${IMAGE_TAG}.`);
      }
      return { report, timings: { startMs, uploadMs, runMs: Date.now() - run, totalMs: Date.now() - started } };
    } catch (err) {
      throw classifyError(err);
    } finally {
      // The answer does not wait for the machine to be gone. Stopping ends it; deleting removes
      // its entry from the project's list of sandboxes.
      background(async () => {
        await machine.stop();
        await machine.delete().catch(() => {});
      }, 'removing a judge machine');
    }
  }

  /**
   * Check one program against inputs.
   * `limits: 'rlimit'` makes the runner leave control groups aside; scripts/judge-image.mjs uses it
   * to prove that the other way of limiting a program works on the same machine.
   * @returns {Promise<{ compileError: string | null, runs: { stdout, stderr, exitCode, timedOut }[], timings: object, limits: string }>}
   */
  async function runBatch({ language, code, inputs, timeLimitMs, memoryLimitKb, limits }) {
    const job = { version: RUNNER_VERSION, language, source: code, tests: inputs, timeLimitMs, memoryLimitKb, deadlineMs: JOB_DEADLINE_MS, ...(limits === 'rlimit' ? { limits } : {}) };
    const { report, timings } = await runRunner(job);
    if (report.toolchain === false) throw new JudgeUnavailable('failed', 'The code checker cannot run programs in this language right now.', `Not installed in the image: ${(report.missing ?? []).join(', ')}`);
    if (!report.compile?.ok) return { compileError: report.compile?.output || 'The program could not be compiled.', runs: [], timings, limits: report.isolation?.limits };
    return { compileError: null, runs: (report.runs ?? []).map((run) => toRun(run, { memoryLimitKb })), timings, limits: report.isolation?.limits };
  }

  /** One small program per language, in one machine: is everything in working order? */
  async function selfTest() {
    const { report, timings } = await runRunner({ version: RUNNER_VERSION, selfTest: true, deadlineMs: JOB_DEADLINE_MS });
    const languages = report.selfTest?.languages ?? {};
    return { ok: Object.keys(languages).length > 0 && Object.values(languages).every((l) => l.ok), languages, versions: report.selfTest?.versions ?? {}, isolation: report.isolation, timings };
  }

  /**
   * Make sure the image exists and works, waiting for it. For the build step and for tests of a
   * real account; a request never waits for this.
   * @returns {Promise<{ ok: boolean, state: string, detail?: string, check?: object, sizeBytes?: number, prepared: boolean }>}
   */
  async function ensureImage({ deadlineMs = 12 * 60_000, pollMs = 5000, onProgress = () => {} } = {}) {
    const deadline = Date.now() + deadlineMs;
    let prepared = false;
    let sizeBytes;
    let replaced = 0;
    let last = '';
    let replaceStopped = false;
    while (Date.now() < deadline) {
      const step = await advanceImage({ replaceStopped });
      replaceStopped = false;
      const line = `${step.state}${step.detail ? `: ${step.detail}` : ''}`;
      if (line !== last) onProgress(line);
      last = line;
      if (step.state === 'failed' || step.state === 'waiting') return { ok: false, state: step.state, detail: step.detail, prepared };
      if (step.state === 'preparing' || step.state === 'finalizing') {
        prepared = true;
        await sleep(pollMs);
        continue;
      }
      if (step.sizeBytes) sizeBytes = step.sizeBytes;
      // 'ready' or 'stopped': the proof is a job.
      notReadyUntil = 0;
      try {
        const check = await selfTest();
        return { ok: check.ok, state: check.ok ? 'ready' : 'incomplete', detail: check.ok ? undefined : 'Not every language passed its check.', check, sizeBytes, prepared };
      } catch (err) {
        const unavailable = classifyError(err);
        if (unavailable.kind !== 'preparing') return { ok: false, state: 'failed', detail: describeError(unavailable), prepared };
        // Stopped, but not from a complete installation. Replace it, once.
        await advancing;
        if (replaced >= 1) return { ok: false, state: 'failed', detail: `The image is still incomplete after preparing it again. ${unavailable.detail ?? ''}`, prepared };
        replaced += 1;
        replaceStopped = true;
        onProgress('the stopped image is incomplete; preparing it again');
      }
    }
    return { ok: false, state: 'timeout', detail: 'Preparing the image took longer than allowed. It goes on by itself; the first programs are checked once it is done.', prepared };
  }

  /** Remove images of other recipes and regions' leftovers that belong to this application. */
  async function removeOtherImages({ keep = [name] } = {}) {
    const creds = identity();
    const { Sandbox } = await loadSdk();
    const removed = [];
    const listed = await Sandbox.list({ namePrefix: IMAGE_NAME_PREFIX, sortBy: 'name', ...creds });
    for (const entry of listed.sandboxes ?? []) {
      if (keep.includes(entry.name) || !entry.name.startsWith(IMAGE_NAME_PREFIX)) continue;
      const stale = await Sandbox.get({ name: entry.name, ...creds }).catch(() => null);
      if (!stale) continue;
      await stale.delete({ deleteOrphanSnapshots: true });
      removed.push(entry.name);
    }
    return removed;
  }

  /** What this application keeps on the account: its images, and all snapshots of the project. */
  async function inventory() {
    const creds = identity();
    const { Sandbox, Snapshot } = await loadSdk();
    const listed = await Sandbox.list({ namePrefix: IMAGE_NAME_PREFIX, sortBy: 'name', ...creds });
    const snapshots = await Snapshot.list({ ...creds });
    const stored = (snapshots.snapshots ?? []).filter((snapshot) => snapshot.status === 'created');
    return {
      images: (listed.sandboxes ?? []).map((entry) => ({ name: entry.name, status: entry.status, current: entry.name === name })),
      snapshots: stored.length,
      snapshotBytes: stored.reduce((sum, snapshot) => sum + (snapshot.sizeBytes ?? 0), 0),
    };
  }

  return { name, region, runBatch, selfTest, advanceImage, ensureImage, removeOtherImages, inventory };
}
