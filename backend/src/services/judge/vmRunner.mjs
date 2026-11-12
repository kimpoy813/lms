// edusphere-judge-vm-runner
//
// The program that compiles and runs ONE student's program inside a throw-away virtual machine.
//
// This file has two lives:
//   - imported by the API (services/judge/vercelSandbox.js), it only hands out its own text, which
//     is uploaded into the machine together with the job;
//   - started inside the machine as `sudo node runner.mjs job.json`, it does the work and writes a
//     report. Because it is uploaded on its own, it may import nothing but Node.js built-ins.
//
// The machine itself is the security boundary (no network, nothing of value inside, destroyed
// afterwards). What happens in here is about fair and readable verdicts:
//   - the program runs as a user without any rights, so it cannot read the inputs of the other
//     tests, change the compiled program between tests, or stop this runner;
//   - every compilation and every test gets its own limits on time, memory, processes and output
//     (kernel control groups where the machine offers them, per-process limits otherwise);
//   - the expected outputs never enter the machine: the API compares.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNNER_VERSION = 1;
export const RUNNER_MARKER = 'edusphere-judge-vm-runner';

const SELF = fileURLToPath(import.meta.url);
let ownText = null;
/** The text of this file, to be uploaded into the machine. */
export function runnerSource() {
  ownText ??= fs.readFileSync(SELF, 'utf8');
  if (!ownText.startsWith(`// ${RUNNER_MARKER}`)) throw new Error('the judge runner could not read its own source file');
  return ownText;
}

const MB = 1024 * 1024;
export const STDOUT_LIMIT = 64 * 1024;
export const STDERR_LIMIT = 16 * 1024;
const COMPILE_OUTPUT_LIMIT = 24 * 1024;
const COMPILE_MS = 20_000;
const COMPILE_MEMORY = 1024 * MB;
const RUN_USER = 'judge-run';
/** Written by the image recipe when everything was installed (see services/judge/image.js). */
export const IMAGE_MARKER_FILE = '/etc/edusphere-judge-image';
export const REPORT_PREFIX = 'EDUSPHERE-JUDGE-REPORT ';
const NOT_CONFINED = 'edusphere-judge: the program could not be placed inside its limits';
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const megabytes = (bytes) => Math.max(16, Math.ceil(bytes / MB));

/**
 * How each language is built and started. `memory` is what the language's own runtime needs on top
 * of the program's data, so that a limit of 64 MB means 64 MB for the program in every language.
 */
export const VM_LANGUAGES = {
  PYTHON: {
    file: () => 'main.py', tools: ['python3'], memory: 16 * MB,
    compile: (file) => ['python3', '-m', 'py_compile', file],
    run: ({ build, file }) => ['python3', path.join(build, file)],
  },
  JAVASCRIPT: {
    file: () => 'main.js', tools: ['node'], memory: 96 * MB,
    compile: (file) => ['node', '--check', file],
    run: ({ build, file, memory }) => ['node', `--max-old-space-size=${megabytes(memory)}`, path.join(build, file)],
  },
  C: {
    file: () => 'main.c', tools: ['gcc'], memory: 4 * MB,
    compile: (file) => ['gcc', '-O2', '-pipe', '-std=gnu17', '-o', 'main', file, '-lm'],
    run: ({ build }) => [path.join(build, 'main')],
  },
  CPP: {
    file: () => 'main.cpp', tools: ['g++'], memory: 4 * MB,
    compile: (file) => ['g++', '-O2', '-pipe', '-std=gnu++20', '-o', 'main', file],
    run: ({ build }) => [path.join(build, 'main')],
  },
  JAVA: {
    // javac insists that a public class lives in a file of the same name.
    file: (source) => `${javaNames(source).fileClass}.java`, tools: ['javac', 'java'], memory: 128 * MB,
    compile: (file) => ['javac', '-encoding', 'UTF-8', '-nowarn', '-d', '.', file],
    run: ({ build, source, memory }) => ['java', '-XX:+UseSerialGC', `-Xmx${megabytes(memory)}m`, '-Xss64m', '-cp', build, javaNames(source).mainClass],
  },
};

/** Which file a Java program must be stored in, and which class to start. */
export function javaNames(source) {
  const text = String(source ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? null;
  const publicClass = /\bpublic\s+(?:(?:final|abstract|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? null;
  // The class to start is the one that declares main(): the last type opened before it.
  let owner = null;
  const mainAt = text.search(/\bstatic\s+(?:final\s+)?void\s+main\s*\(/);
  if (mainAt >= 0) {
    const before = text.slice(0, mainAt);
    for (const m of before.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g)) owner = m[1];
  }
  const simple = owner ?? publicClass ?? 'Main';
  return { fileClass: publicClass ?? 'Main', mainClass: pkg ? `${pkg}.${simple}` : simple };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

function which(command) {
  for (const dir of SAFE_PATH.split(':')) {
    const candidate = path.join(dir, command);
    const usable = quiet(() => {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    });
    if (usable) return candidate;
  }
  return null;
}

/** Kill every process of a user. The process folder in /proc belongs to the user it runs as. */
function killUser(uid) {
  let killed = 0;
  for (const entry of quiet(() => fs.readdirSync('/proc')) ?? []) {
    if (!/^\d+$/.test(entry)) continue;
    if (quiet(() => fs.statSync(`/proc/${entry}`).uid) !== uid) continue;
    if (quiet(() => process.kill(Number(entry), 'SIGKILL')) !== undefined) killed += 1;
  }
  return killed;
}

/** Collects what a program prints, up to a limit. */
function collector(limit, onOverflow) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      const room = limit - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = limit;
        overflow = true;
        onOverflow();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    get overflow() {
      return overflow;
    },
  };
}

/** The sandbox around every compilation and test run: user, working folders, control groups. */
function prepareBox({ isolated, useCgroup = true }) {
  const box = { isolated, uid: null, gid: null, cgroup: null, cgroupNote: null, serial: 0 };
  box.work = isolated ? '/judge' : fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  if (isolated) {
    let id = spawnSync('id', ['-u', RUN_USER], { encoding: 'utf8' });
    if (id.status !== 0) {
      const add = spawnSync('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', RUN_USER], { encoding: 'utf8', env: { PATH: SAFE_PATH } });
      id = spawnSync('id', ['-u', RUN_USER], { encoding: 'utf8' });
      if (id.status !== 0) throw new Error(`could not create the user that runs programs: ${(add.stderr || add.error?.message || '').trim().slice(0, 200)}`);
    }
    box.uid = Number(id.stdout.trim());
    box.gid = Number(spawnSync('id', ['-g', RUN_USER], { encoding: 'utf8' }).stdout.trim());
    if (!Number.isInteger(box.uid) || box.uid === 0 || !Number.isInteger(box.gid)) throw new Error('the user that runs programs has no usable id');
    killUser(box.uid);
    fs.rmSync(box.work, { recursive: true, force: true });
    if (useCgroup) setUpCgroup(box);
    else box.cgroupNote = 'not used: the job asked for per-process limits';
  }
  box.build = path.join(box.work, 'build');
  box.scratch = path.join(box.work, 'scratch');
  box.inputs = path.join(box.work, 'in');
  fs.mkdirSync(box.work, { recursive: true, mode: 0o711 });
  for (const dir of [box.build, box.scratch, box.inputs]) fs.mkdirSync(dir, { recursive: true });
  if (isolated) {
    fs.chmodSync(box.work, 0o711);
    fs.chmodSync(box.inputs, 0o700);
    fs.chmodSync(box.scratch, 0o711);
    fs.chownSync(box.build, box.uid, box.gid);
    fs.chmodSync(box.build, 0o700);
  }
  return box;
}

/**
 * Kernel control groups give exact limits on memory and on the number of processes, and say
 * afterwards whether a limit was hit. Whether the machine lets us use them is found out by trying;
 * without them execute() falls back to per-process limits.
 */
function setUpCgroup(box) {
  const root = '/sys/fs/cgroup';
  try {
    const controllers = fs.readFileSync(path.join(root, 'cgroup.controllers'), 'utf8').split(/\s+/);
    if (!controllers.includes('memory') || !controllers.includes('pids')) throw new Error(`controllers offered: ${controllers.join(' ').trim() || 'none'}`);
    const control = path.join(root, 'cgroup.subtree_control');
    const enabled = () => {
      const now = fs.readFileSync(control, 'utf8').split(/\s+/);
      return now.includes('memory') && now.includes('pids');
    };
    if (!enabled()) {
      try {
        fs.writeFileSync(control, '+memory +pids');
      } catch (err) {
        if (err.code !== 'EBUSY') throw err;
        // The machine keeps its own processes in the top group, and the kernel does not hand
        // limits to child groups while that is so. Give those processes a group of their own
        // first, which is what container runtimes do in the same situation.
        const home = path.join(root, 'edusphere-system');
        fs.mkdirSync(home, { recursive: true });
        for (let round = 0; round < 5; round += 1) {
          const pids = fs.readFileSync(path.join(root, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean);
          if (pids.length === 0) break;
          for (const pid of pids) quiet(() => fs.writeFileSync(path.join(home, 'cgroup.procs'), pid));
        }
        fs.writeFileSync(control, '+memory +pids');
      }
    }
    const base = path.join(root, 'edusphere-judge');
    for (const stale of quiet(() => fs.readdirSync(base, { withFileTypes: true })) ?? []) if (stale.isDirectory()) quiet(() => fs.rmdirSync(path.join(base, stale.name)));
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'cgroup.subtree_control'), '+memory +pids');
    const probe = path.join(base, 'probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'memory.max'), String(64 * MB));
    fs.writeFileSync(path.join(probe, 'pids.max'), '16');
    fs.rmdirSync(probe);
    box.cgroup = base;
  } catch (err) {
    box.cgroup = null;
    box.cgroupNote = String(err.message ?? err).slice(0, 200);
  }
}

function killEverything(box, leaf, child) {
  if (leaf) quiet(() => fs.writeFileSync(path.join(leaf, 'cgroup.kill'), '1'));
  if (child?.pid) quiet(() => process.kill(-child.pid, 'SIGKILL'));
  if (box.isolated) killUser(box.uid);
}

/**
 * Run one command as the unprivileged user, inside its own limits.
 * @returns {Promise<{ exitCode, signal, timedOut, outputLimit, memoryLimit, processLimit, stdout, stderr, ms, peakKb, failed }>}
 */
async function execute(box, { argv, cwd, stdinFile = '/dev/null', wallMs, memory, processes = 64, stdoutLimit, stderrLimit, addressSpace = false }) {
  const serial = (box.serial += 1);
  let leaf = null;
  if (box.cgroup) {
    leaf = path.join(box.cgroup, `r${serial}`);
    try {
      fs.mkdirSync(leaf);
      fs.writeFileSync(path.join(leaf, 'memory.max'), String(memory));
      quiet(() => fs.writeFileSync(path.join(leaf, 'memory.swap.max'), '0'));
      fs.writeFileSync(path.join(leaf, 'pids.max'), String(processes));
    } catch (err) {
      return { failed: `could not set the limits for a run: ${String(err.message ?? err).slice(0, 160)}` };
    }
  }

  const limits = ['--core=0', '--nofile=256', `--fsize=${32 * MB}`, `--stack=${64 * MB}`, `--cpu=${Math.ceil(wallMs / 1000) + 2}`];
  if (!leaf) {
    // Without control groups: the classic per-process limits. The user that runs programs has no
    // other processes, so a limit on its process count stops a fork bomb. An address-space limit
    // suits compiled programs and Python; the Java and Node.js runtimes reserve far more than they
    // use and are held by their own options (-Xmx, --max-old-space-size) instead.
    limits.push(`--nproc=${processes}`);
    if (addressSpace) limits.push(`--as=${memory + 64 * MB}`);
  }
  let command;
  if (box.isolated) {
    const drop = ['setpriv', `--reuid=${box.uid}`, `--regid=${box.gid}`, '--clear-groups', '--no-new-privs', 'prlimit', ...limits, '--', ...argv];
    // Still root here: join the limits, and make the program the first thing the kernel ends if
    // the whole machine runs out of memory. Only then give up every right and start it.
    const enter = `[ -z "$1" ] || echo $$ > "$1/cgroup.procs" || { echo "${NOT_CONFINED}" >&2; exit 125; }; echo 1000 > /proc/self/oom_score_adj 2>/dev/null; shift; exec "$@"`;
    command = ['/bin/sh', '-c', enter, 'sh', leaf ?? '', ...drop];
  } else {
    command = which('prlimit') ? ['prlimit', ...limits.filter((l) => !l.startsWith('--nproc')), '--', ...argv] : argv;
  }

  const env = { PATH: SAFE_PATH, HOME: cwd, TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  const stdin = fs.openSync(stdinFile, 'r');
  const started = Date.now();
  let timedOut = false;
  let child;
  try {
    child = spawn(command[0], command.slice(1), { cwd, env, stdio: [stdin, 'pipe', 'pipe'], detached: true });
  } catch (err) {
    fs.closeSync(stdin);
    return { failed: `could not start: ${String(err.message ?? err).slice(0, 160)}` };
  }
  fs.closeSync(stdin);

  const stop = () => killEverything(box, leaf, child);
  const out = collector(stdoutLimit, stop);
  const err = collector(stderrLimit, stop);
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, wallMs);

  const result = await new Promise((resolve) => {
    let exit = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', (error) => finish({ spawnError: String(error.message ?? error) }));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // Whatever the program left running keeps its output open; nothing may outlive the program.
      stop();
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exit);
      }, 2000).unref();
    });
    child.on('close', () => finish(exit ?? { code: null, signal: null }));
  });
  const ms = Date.now() - started;
  clearTimeout(timer);
  stop();

  let peakKb = null;
  let memoryLimit = false;
  let processLimit = false;
  if (leaf) {
    const peak = Number(quiet(() => fs.readFileSync(path.join(leaf, 'memory.peak'), 'utf8')));
    if (Number.isFinite(peak) && peak > 0) peakKb = Math.round(peak / 1024);
    memoryLimit = /^oom_kill\s+[1-9]/m.test(quiet(() => fs.readFileSync(path.join(leaf, 'memory.events'), 'utf8')) ?? '');
    processLimit = /^max\s+[1-9]/m.test(quiet(() => fs.readFileSync(path.join(leaf, 'pids.events'), 'utf8')) ?? '');
    for (let i = 0; i < 40; i += 1) {
      if (quiet(() => fs.rmdirSync(leaf)) !== undefined || !fs.existsSync(leaf)) break;
      quiet(() => fs.writeFileSync(path.join(leaf, 'cgroup.kill'), '1'));
      await sleep(25);
    }
  }

  if (result.spawnError) return { failed: `could not start: ${result.spawnError.slice(0, 160)}` };
  if (result.code === 125 && box.isolated && err.text().includes(NOT_CONFINED)) return { failed: 'could not place the program inside its limits' };
  if (result.signal === 'SIGXCPU') timedOut = true;
  return {
    exitCode: result.code, signal: result.signal, timedOut: timedOut && !out.overflow && !err.overflow, outputLimit: out.overflow || err.overflow,
    memoryLimit: memoryLimit && !timedOut, processLimit, stdout: out.text(), stderr: err.text(), ms, peakKb,
  };
}

/** Compile (or syntax-check) the program as the unprivileged user, then lock the result. */
async function compile(box, language, source, deadlineAt) {
  const lang = VM_LANGUAGES[language];
  const file = lang.file(source);
  fs.writeFileSync(path.join(box.build, file), source);
  if (box.isolated) fs.chownSync(path.join(box.build, file), box.uid, box.gid);
  const wallMs = Math.max(1000, Math.min(COMPILE_MS, deadlineAt - Date.now()));
  const run = await execute(box, { argv: lang.compile(file), cwd: box.build, wallMs, memory: COMPILE_MEMORY, processes: 256, stdoutLimit: COMPILE_OUTPUT_LIMIT, stderrLimit: COMPILE_OUTPUT_LIMIT });
  if (run.failed) return { file, failed: run.failed };
  if (box.isolated) {
    // From here on the program can read and execute what was built, and change nothing.
    spawnSync('chown', ['-R', '0:0', box.build]);
    spawnSync('chmod', ['-R', 'u=rwX,go=rX', box.build]);
  }
  const ok = run.exitCode === 0 && !run.timedOut && !run.outputLimit;
  let output = [run.stderr, run.stdout].filter((s) => s.trim()).join('\n').trim();
  if (run.timedOut) output = `Compilation took longer than ${Math.round(wallMs / 1000)} seconds and was stopped.\n${output}`.trim();
  else if (run.memoryLimit) output = `The compiler ran out of memory.\n${output}`.trim();
  else if (!ok && !output) output = `The compiler stopped with exit code ${run.exitCode ?? run.signal}.`;
  // Compilers name the file with its folder; the student knows it by its name only.
  output = output.split(`${box.build}/`).join('');
  return { file, ok, output: ok ? '' : output, timedOut: run.timedOut, ms: run.ms };
}

async function runTest(box, language, source, file, input, index, { timeLimitMs, memory, deadlineAt }) {
  const lang = VM_LANGUAGES[language];
  const remaining = deadlineAt - Date.now();
  if (remaining < 300) return { status: 'not-run', exitCode: null, stdout: '', stderr: '', ms: 0, peakKb: null };
  const cwd = path.join(box.scratch, `t${index}`);
  fs.mkdirSync(cwd, { recursive: true });
  const stdinFile = path.join(box.inputs, String(index));
  fs.writeFileSync(stdinFile, input ?? '', { mode: 0o600 });
  if (box.isolated) {
    fs.chownSync(cwd, box.uid, box.gid);
    fs.chmodSync(cwd, 0o700);
  }
  const wallMs = Math.min(timeLimitMs, remaining);
  const run = await execute(box, {
    argv: lang.run({ build: box.build, file, source, memory }), cwd, stdinFile, wallMs, memory: memory + lang.memory, processes: 64,
    stdoutLimit: STDOUT_LIMIT, stderrLimit: STDERR_LIMIT, addressSpace: language === 'C' || language === 'CPP' || language === 'PYTHON',
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(stdinFile, { force: true });
  if (run.failed) return { status: 'failed', detail: run.failed, exitCode: null, stdout: '', stderr: '', ms: 0, peakKb: null };
  // Error traces name the program with its folder; the student knows it by its name only.
  run.stderr = run.stderr.split(`${box.build}/`).join('');
  let status = 'ok';
  if (run.outputLimit) status = 'output-limit';
  else if (run.timedOut) status = wallMs < timeLimitMs ? 'not-run' : 'timeout';
  else if (run.memoryLimit) status = 'memory-limit';
  return { status, exitCode: run.exitCode, signal: run.signal, processLimit: run.processLimit, stdout: run.stdout, stderr: run.stderr, ms: run.ms, peakKb: run.peakKb };
}

async function judgeProgram(box, job, deadlineAt) {
  const lang = VM_LANGUAGES[job.language];
  if (!lang) throw new Error(`unknown language ${job.language}`);
  const missing = lang.tools.filter((tool) => !which(tool));
  if (missing.length > 0) return { toolchain: false, missing, compile: null, runs: [] };
  const compiled = await compile(box, job.language, String(job.source ?? ''), deadlineAt);
  if (compiled.failed) throw new Error(compiled.failed);
  const report = { toolchain: true, compile: { ok: compiled.ok, output: compiled.output, timedOut: compiled.timedOut, ms: compiled.ms }, runs: [] };
  if (!compiled.ok) return report;
  const memory = Math.max(16 * MB, Math.min(1024 * MB, Number(job.memoryLimitKb ?? 131072) * 1024));
  const timeLimitMs = Math.max(200, Math.min(30_000, Number(job.timeLimitMs ?? 3000)));
  const tests = Array.isArray(job.tests) ? job.tests : [];
  for (let index = 0; index < tests.length; index += 1) {
    const run = await runTest(box, job.language, String(job.source ?? ''), compiled.file, String(tests[index] ?? ''), index, { timeLimitMs, memory, deadlineAt });
    if (run.status === 'failed') throw new Error(run.detail);
    report.runs.push(run);
  }
  return report;
}

const SAMPLE = {
  PYTHON: 'import sys\nprint(int(sys.stdin.readline()) * 2)\n',
  JAVASCRIPT: "const n = Number(require('fs').readFileSync(0, 'utf8'));\nconsole.log(n * 2);\n",
  C: '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("%d\\n", n * 2); return 0; }\n',
  CPP: '#include <iostream>\nint main() { int n; std::cin >> n; std::cout << n * 2 << "\\n"; }\n',
  JAVA: 'import java.util.Scanner;\npublic class Main { public static void main(String[] args) { Scanner in = new Scanner(System.in); System.out.println(in.nextInt() * 2); } }\n',
};

/** One small program per language: is every language ready on this machine, and how fast? */
async function selfTest(box, deadlineAt) {
  const languages = {};
  for (const language of Object.keys(VM_LANGUAGES)) {
    fs.rmSync(box.build, { recursive: true, force: true });
    fs.mkdirSync(box.build);
    if (box.isolated) {
      fs.chownSync(box.build, box.uid, box.gid);
      fs.chmodSync(box.build, 0o700);
    }
    try {
      const report = await judgeProgram(box, { language, source: SAMPLE[language], tests: ['21\n'], timeLimitMs: 10_000, memoryLimitKb: 131072 }, deadlineAt);
      const run = report.runs[0];
      const ok = report.toolchain && report.compile?.ok === true && run?.status === 'ok' && run.exitCode === 0 && run.stdout.trim() === '42';
      languages[language] = {
        ok, compileMs: report.compile?.ms ?? null, runMs: run?.ms ?? null, peakKb: run?.peakKb ?? null,
        detail: ok ? null : !report.toolchain ? `not installed: ${report.missing.join(', ')}` : report.compile?.ok === false ? report.compile.output.slice(0, 300) : `${run?.status} exit ${run?.exitCode}: ${(run?.stderr || run?.stdout || '').slice(0, 300)}`,
      };
    } catch (err) {
      languages[language] = { ok: false, compileMs: null, runMs: null, peakKb: null, detail: String(err.message ?? err).slice(0, 300) };
    }
  }
  const version = (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8', env: { PATH: SAFE_PATH }, timeout: 15_000 });
    return r.error ? null : `${r.stdout}\n${r.stderr}`.trim().split('\n')[0].slice(0, 80) || null;
  };
  const versions = { PYTHON: version('python3', ['--version']), JAVASCRIPT: version('node', ['--version']), C: version('gcc', ['--version']), CPP: version('g++', ['--version']), JAVA: version('javac', ['-version']) };
  return { selfTest: { languages, versions } };
}

/** Do one job. Exported for tests; in the machine it is reached through main(). */
export async function runJob(job) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(2000, Math.min(600_000, Number(job.deadlineMs ?? 60_000)));
  const isolated = typeof process.getuid === 'function' && process.getuid() === 0;
  // Without root there is no way to take rights away from the program. Tests of this file may ask
  // for that on purpose; a machine that runs students' programs never does.
  if (!isolated && job.unisolated !== true) throw new Error('the runner has to be started as root (sudo), so that it can give up its rights before running a program');
  if (isolated && job.unisolated === true) throw new Error('a job that asks to run without isolation is refused when the runner is root');
  // `limits: 'rlimit'` exists for tests: it takes the path of a machine without control groups.
  const box = prepareBox({ isolated, useCgroup: job.limits !== 'rlimit' });
  try {
    const body = job.selfTest === true ? await selfTest(box, deadlineAt) : await judgeProgram(box, job, deadlineAt);
    const image = quiet(() => fs.readFileSync(IMAGE_MARKER_FILE, 'utf8').trim().slice(0, 100)) || null;
    return { version: RUNNER_VERSION, image, isolation: { user: isolated, limits: box.cgroup ? 'cgroup' : 'rlimit', note: box.cgroupNote }, ...body, ms: Date.now() - startedAt };
  } finally {
    if (isolated) killUser(box.uid);
    quiet(() => fs.rmSync(box.work, { recursive: true, force: true }));
  }
}

/**
 * In the machine: `sudo node vmRunner.mjs <folder>`. The folder holds job.json (and this file);
 * the answer is written to report.json in the same folder.
 */
async function main(jobDir) {
  const jobPath = path.join(jobDir, 'job.json');
  const reportPath = path.join(jobDir, 'report.json');
  let report;
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // The job lists the input of every test, hidden ones included. The folder was written by the
      // machine's ordinary user; from here on only root can change it or read the job, and the
      // report cannot be planted by anybody else.
      fs.chownSync(jobDir, 0, 0);
      fs.chmodSync(jobDir, 0o711);
      fs.chownSync(jobPath, 0, 0);
      fs.chmodSync(jobPath, 0o600);
      fs.rmSync(reportPath, { force: true });
    }
    report = await runJob(JSON.parse(fs.readFileSync(jobPath, 'utf8')));
  } catch (err) {
    report = { version: RUNNER_VERSION, error: String(err?.message ?? err).slice(0, 1000) };
  }
  // Written only now, when nothing of the program is running any more. The same report goes to
  // this runner's own output, which the program never had access to, as one line of plain ASCII
  // (so that no character can be torn apart on its way).
  const text = JSON.stringify(report).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  fs.writeFileSync(reportPath, text, { mode: 0o644 });
  fs.chmodSync(reportPath, 0o644);
  process.stdout.write(`${REPORT_PREFIX}${text}\n`);
}

const startedDirectly = Boolean(process.argv[1]) && quiet(() => pathToFileURL(fs.realpathSync(process.argv[1])).href) === pathToFileURL(quiet(() => fs.realpathSync(SELF)) ?? SELF).href;
if (startedDirectly) {
  const jobDir = process.argv[2];
  if (!jobDir) {
    console.error('usage: node vmRunner.mjs <folder with job.json>');
    process.exit(2);
  }
  main(path.resolve(jobDir)).then(
    () => process.stdout.write('', () => process.exit(0)),
    (err) => {
      console.error(String(err?.stack ?? err));
      process.exit(1);
    },
  );
}
