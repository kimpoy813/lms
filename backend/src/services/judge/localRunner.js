// Local development code runner (CODE_RUNNER_PROVIDER=local).
//
// Runs student code in a separate child Node.js process executing vmRunner.mjs inside a fresh
// temporary folder, strictly for local development when neither Vercel Sandbox nor Piston is set.
// Production and Vercel deployments refuse CODE_RUNNER_PROVIDER=local in config/env.js.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_DEADLINE_MS, JudgeUnavailable, parseReport, toRun } from './vercelSandbox.js';
import { REPORT_PREFIX, RUNNER_VERSION } from './vmRunner.mjs';

const VM_RUNNER_PATH = fileURLToPath(new URL('./vmRunner.mjs', import.meta.url));
const GRACE_MS = 10_000;

async function runRunner(job) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edusphere-local-judge-'));
  const started = Date.now();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const payload = {
    version: RUNNER_VERSION,
    ...job,
    // Root runs isolate with judge-run; ordinary local dev users run in a temp workspace.
    ...(isRoot ? { limits: 'rlimit' } : { unisolated: true, limits: 'rlimit' }),
  };

  try {
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(payload), { mode: 0o600 });
    const deadlineMs = Number(payload.deadlineMs ?? JOB_DEADLINE_MS);

    const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [VM_RUNNER_PATH, jobDir], {
        cwd: jobDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      let totalOut = 0;
      let totalErr = 0;
      let killed = false;
      child.stdout.on('data', (chunk) => {
        if (totalOut < 512 * 1024) {
          out.push(chunk);
          totalOut += chunk.length;
        }
      });
      child.stderr.on('data', (chunk) => {
        if (totalErr < 64 * 1024) {
          err.push(chunk);
          totalErr += chunk.length;
        }
      });
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, deadlineMs + GRACE_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut: killed,
        });
      });
    });

    if (timedOut) {
      throw new JudgeUnavailable('busy', 'The local code checker took too long to finish.');
    }

    let report = parseReport(stdout);
    if (!report) {
      try {
        const raw = fs.readFileSync(path.join(jobDir, 'report.json'), 'utf8');
        report = parseReport(`${REPORT_PREFIX}${raw}`);
      } catch {
        // handled below
      }
    }
    if (!report) {
      throw new JudgeUnavailable(
        'failed',
        'The local code checker did not finish its work.',
        `Runner exited with code ${exitCode} and no report. ${stderr.slice(-300)}`.trim(),
      );
    }
    if (report.error) {
      throw new JudgeUnavailable('failed', 'The local code checker could not do its work.', String(report.error).slice(0, 400));
    }
    if (report.version !== RUNNER_VERSION) {
      throw new JudgeUnavailable('failed', 'The local code checker returned an unexpected version.', `Got ${report.version}, expected ${RUNNER_VERSION}.`);
    }
    return { report, timings: { totalMs: Date.now() - started } };
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on temp directories
    }
  }
}

export async function runBatchLocal({ language, code, inputs, timeLimitMs = 3000, memoryLimitKb = 131072 }) {
  const { report, timings } = await runRunner({
    language,
    source: code,
    tests: inputs,
    timeLimitMs,
    memoryLimitKb,
    deadlineMs: JOB_DEADLINE_MS,
  });
  if (report.toolchain === false) {
    throw new JudgeUnavailable(
      'failed',
      'Cannot run programs in this language on this computer right now.',
      `Not installed on PATH: ${(report.missing ?? []).join(', ')}`,
    );
  }
  if (!report.compile?.ok) {
    return {
      compileError: report.compile?.output || 'The program could not be compiled.',
      runs: [],
      timings,
      limits: report.isolation?.limits ?? 'rlimit',
    };
  }
  return {
    compileError: null,
    runs: (report.runs ?? []).map((run) => toRun(run, { memoryLimitKb })),
    timings,
    limits: report.isolation?.limits ?? 'rlimit',
  };
}

export async function selfTestLocal() {
  const { report, timings } = await runRunner({ selfTest: true, deadlineMs: JOB_DEADLINE_MS });
  const languages = report.selfTest?.languages ?? {};
  const entries = Object.entries(languages);
  const working = entries.filter(([, res]) => res.ok).map(([id]) => id);
  const missing = entries.filter(([, res]) => !res.ok).map(([id]) => id);
  const ok = working.length > 0;
  const detail = missing.length > 0 && ok
    ? `Not available on this computer: ${missing.join(', ')}. All other languages are ready.`
    : undefined;
  return {
    ok,
    detail,
    languages,
    versions: report.selfTest?.versions ?? {},
    isolation: report.isolation,
    timings,
  };
}
