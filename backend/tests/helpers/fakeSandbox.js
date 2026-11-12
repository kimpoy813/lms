// A stand-in for Vercel's Sandbox SDK (@vercel/sandbox): a pretend account that holds prepared
// images by name and hands out machines made from them. Nothing is started; what a machine
// "answers" is decided by the test. Used by tests/unit/judge-sandbox.test.js and
// tests/api/code-runner.test.js.
import { REPORT_PREFIX, RUNNER_VERSION } from '../../src/services/judge/vmRunner.mjs';
import { IMAGE_TAG } from '../../src/services/judge/vercelSandbox.js';

/** An error as Vercel's API client throws it. */
export const apiError = (status, code = 'error', message = 'refused') => Object.assign(new Error(message), { response: { status }, json: { error: { code, message } } });

/** The report of a runner for which every test printed twice its input. */
export const okReport = (job) => ({
  version: RUNNER_VERSION, image: IMAGE_TAG, isolation: { user: true, limits: 'cgroup', note: null }, toolchain: true,
  compile: { ok: true, output: '', timedOut: false, ms: 40 },
  runs: (job.tests ?? []).map((input) => ({ status: 'ok', exitCode: 0, signal: null, processLimit: false, stdout: `${Number(input) * 2}\n`, stderr: '', ms: 12, peakKb: 3000 })),
  ms: 100,
});

/**
 * @param {string} name the name of the prepared image the judge under test looks for
 * @param {{ report?: (job: object) => object, image?: 'ready'|'preparing'|'missing', forkError?: Error|null, output?: string|null, installation?: 'done'|'running'|'failed' }} [options]
 *   Everything in `state` can be changed while the test runs.
 */
export function fakeSandboxAccount(name, { report = okReport, image = 'ready', forkError = null, output = null, installation = 'done' } = {}) {
  const NAME = name;
  const calls = [];
  const bases = new Map();
  const machines = [];
  const state = { report, forkError, output, installation, reportFile: null, stopGate: null };

  class Machine {
    constructor(name, isBase, status = 'running') {
      Object.assign(this, { name, isBase, status, files: {}, createdAt: new Date() });
    }
    async writeFiles(files) {
      calls.push(['writeFiles', this.name, files.map((f) => f.path)]);
      for (const f of files) this.files[f.path] = String(f.content);
    }
    async runCommand(params) {
      calls.push(['runCommand', this.name, [params.cmd, ...(params.args ?? [])].join(' ').slice(0, 60), { sudo: params.sudo ?? false, detached: params.detached ?? false, timeoutMs: params.timeoutMs }]);
      if (params.detached) return { cmdId: 'cmd_1' };
      if (this.isBase) {
        // "How far is the installation?"
        const text = { done: `${IMAGE_TAG}\n---\n\n---\nsync`, running: '\n---\n\n---\nSetting up gcc', failed: '\n---\nexit 100\n---\nE: Unable to locate package default-jdk-headless' }[state.installation];
        return { exitCode: 0, stdout: async () => text, stderr: async () => '' };
      }
      const job = JSON.parse(this.files['/tmp/judge-job/job.json']);
      this.job = job;
      const text = state.output ?? `${REPORT_PREFIX}${JSON.stringify(state.report(job))}\n`;
      return { exitCode: 0, stdout: async () => text, stderr: async () => 'runner stderr' };
    }
    async readFileToBuffer({ path }) {
      calls.push(['readFile', this.name, path]);
      return state.reportFile ? Buffer.from(state.reportFile) : null;
    }
    async stop() {
      calls.push(['stop', this.name]);
      await state.stopGate;
      this.status = 'stopped';
      return { status: 'stopped', snapshot: this.isBase ? { sizeBytes: 1_103_000_000 } : undefined };
    }
    async delete(options) {
      calls.push(['delete', this.name, options ?? null]);
      bases.delete(this.name);
    }
  }
  if (image === 'ready') bases.set(NAME, new Machine(NAME, true, 'stopped'));
  if (image === 'preparing') bases.set(NAME, new Machine(NAME, true, 'running'));

  const Sandbox = {
    async get({ name }) {
      calls.push(['get', name]);
      if (!bases.has(name)) throw apiError(404, 'not_found', 'Sandbox not found');
      return bases.get(name);
    },
    async create(params) {
      calls.push(['create', params]);
      if (bases.has(params.name)) throw apiError(409, 'conflict', 'already exists');
      const base = new Machine(params.name, true);
      bases.set(params.name, base);
      return base;
    },
    async fork(params) {
      calls.push(['fork', params]);
      if (state.forkError) throw state.forkError;
      const source = bases.get(params.sourceSandbox);
      if (!source) throw apiError(404, 'not_found', 'Sandbox not found');
      const machine = new Machine(`job-${machines.length + 1}`, false);
      machines.push(machine);
      return machine;
    },
    async list(params) {
      calls.push(['list', params]);
      return { sandboxes: [...bases.values()].map((b) => ({ name: b.name, status: b.status })) };
    },
  };
  const Snapshot = { list: async () => ({ snapshots: [{ id: 'snap_1', status: 'created', sizeBytes: 1_103_000_000 }, { id: 'snap_0', status: 'deleted', sizeBytes: 5 }] }) };
  return { Sandbox, Snapshot, calls, bases, machines, state, Machine, names: () => calls.map((c) => c[0]) };
}
