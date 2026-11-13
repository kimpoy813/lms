// The program that runs inside the judge's machine (src/services/judge/vmRunner.mjs).
//
// It is exercised for real: programs are compiled and started on this computer. By default that
// happens without root, in a temporary folder, which covers everything except the taking away of
// rights. The part that needs root (a user without rights, kernel limits) changes the computer it
// runs on (it creates the user "judge-run" and the folder /judge), so it only runs when asked for:
//
//   JUDGE_TEST_ISOLATED=1 npx vitest run tests/unit/judge-runner.test.js      (needs sudo without a password)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REPORT_PREFIX, RUNNER_MARKER, RUNNER_VERSION, STDOUT_LIMIT, VM_LANGUAGES, javaNames, runJob, runnerSource } from '../../src/services/judge/vmRunner.mjs';

const RUNNER = fileURLToPath(new URL('../../src/services/judge/vmRunner.mjs', import.meta.url));
const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// As root the runner isolates by itself and refuses to do otherwise.
const plain = isRoot ? {} : { unisolated: true };
const python = has('python3');
const gcc = has('gcc');

const job = (language, source, tests = [''], extra = {}) => ({ language, source, tests, timeLimitMs: 2000, memoryLimitKb: 65536, deadlineMs: 30_000, ...plain, ...extra });

describe('the runner as a file', () => {
  it('can be uploaded on its own: it imports nothing but Node.js built-ins', () => {
    const source = runnerSource();
    expect(source.startsWith(`// ${RUNNER_MARKER}`)).toBe(true);
    const imported = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(3);
    expect(imported.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it('knows the five languages the application offers', () => {
    expect(Object.keys(VM_LANGUAGES).sort()).toEqual(['C', 'CPP', 'JAVA', 'JAVASCRIPT', 'PYTHON']);
  });

  it('refuses a job that would run a program with the rights of the runner', async () => {
    if (isRoot) await expect(runJob({ ...job('PYTHON', 'print(1)'), unisolated: true })).rejects.toThrow(/refused when the runner is root/);
    else await expect(runJob({ language: 'PYTHON', source: 'print(1)', tests: [''] })).rejects.toThrow(/has to be started as root/);
  });
});

describe('where a Java program is stored and which class is started', () => {
  it('follows the public class, because javac insists on it', () => {
    expect(javaNames('public class Main { public static void main(String[] a) {} }')).toEqual({ fileClass: 'Main', mainClass: 'Main' });
    expect(javaNames('import java.util.*;\npublic final class Solution {\n  public static void main(String[] args) {}\n}')).toEqual({ fileClass: 'Solution', mainClass: 'Solution' });
  });

  it('starts the class that holds main(), whatever the others are called', () => {
    const source = 'class Helper { int twice(int n) { return n * 2; } }\nclass Program {\n  public static void main(String[] args) {}\n}\nclass After {}';
    expect(javaNames(source)).toEqual({ fileClass: 'Main', mainClass: 'Program' });
    expect(javaNames('public class Shapes { }\nclass Runner { static public void main(String... a) {} }').fileClass).toBe('Shapes');
    expect(javaNames('public class Shapes { }\nclass Runner { public static void main(String[] a) {} }').mainClass).toBe('Runner');
  });

  it('honours a package and is not fooled by comments', () => {
    expect(javaNames('package edu.demo;\npublic class App { public static void main(String[] a) {} }').mainClass).toBe('edu.demo.App');
    expect(javaNames('// public class Wrong\n/* class AlsoWrong { public static void main(String[] a) {} } */\nclass Right { public static void main(String[] a) {} }')).toEqual({ fileClass: 'Main', mainClass: 'Right' });
  });

  it('falls back to Main when the program gives no hint', () => {
    expect(javaNames('')).toEqual({ fileClass: 'Main', mainClass: 'Main' });
  });
});

describe.skipIf(!python)('running programs (Python on this computer)', () => {
  it('compiles once and runs every test with its own input', async () => {
    const report = await runJob(job('PYTHON', 'import sys\nprint(int(sys.stdin.readline()) * 2)\n', ['2\n', '21\n', 'x\n']));
    expect(report).toMatchObject({ version: RUNNER_VERSION, toolchain: true, compile: { ok: true } });
    expect(report.runs.map((r) => [r.status, r.exitCode, r.stdout])).toEqual([['ok', 0, '4\n'], ['ok', 0, '42\n'], ['ok', 1, '']]);
    // The error names the program as the student knows it, not the folder it was put in.
    expect(report.runs[2].stderr).toMatch(/File "main\.py", line 2/);
    expect(report.runs[2].stderr).toMatch(/ValueError/);
  });

  it('reports a program that cannot be compiled once, and runs nothing', async () => {
    const report = await runJob(job('PYTHON', 'print("unclosed"\n', ['1', '2']));
    expect(report.compile.ok).toBe(false);
    expect(report.compile.output).toMatch(/SyntaxError/);
    expect(report.compile.output).not.toMatch(/judge-|\/tmp\//);
    expect(report.runs).toEqual([]);
  });

  it('stops a program at its time limit and goes on with the next test', async () => {
    const report = await runJob(job('PYTHON', 'import sys\nif sys.stdin.readline().strip() == "loop":\n    while True: pass\nprint("done")\n', ['loop\n', 'go\n'], { timeLimitMs: 400 }));
    expect(report.runs[0]).toMatchObject({ status: 'timeout' });
    expect(report.runs[0].ms).toBeGreaterThanOrEqual(380);
    expect(report.runs[0].ms).toBeLessThan(2500);
    expect(report.runs[1]).toMatchObject({ status: 'ok', exitCode: 0, stdout: 'done\n' });
  });

  it('cuts endless output and says so', async () => {
    const report = await runJob(job('PYTHON', 'while True: print("x" * 1000)\n'));
    expect(report.runs[0].status).toBe('output-limit');
    expect(report.runs[0].stdout.length).toBe(STDOUT_LIMIT);
  });

  it('does not wait for what a program leaves running', async () => {
    const started = Date.now();
    const report = await runJob(job('PYTHON', 'import os, sys, time\nprint(42); sys.stdout.flush()\nif os.fork() == 0:\n    time.sleep(20)\n'));
    expect(report.runs[0]).toMatchObject({ status: 'ok', exitCode: 0, stdout: '42\n' });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('passes the exit code and what was printed before a failure', async () => {
    const report = await runJob(job('PYTHON', 'import sys\nprint("partial")\nsys.exit(3)\n'));
    expect(report.runs[0]).toMatchObject({ status: 'ok', exitCode: 3, stdout: 'partial\n' });
  });

  it('marks tests as not run when the time for the whole job is used up', async () => {
    const report = await runJob(job('PYTHON', 'import time, sys\ntime.sleep(0.7)\nprint(sys.stdin.readline().strip())\n', ['a', 'b', 'c', 'd', 'e'], { deadlineMs: 2000 }));
    const statuses = report.runs.map((r) => r.status);
    expect(statuses).toHaveLength(5);
    expect(statuses[0]).toBe('ok');
    expect(statuses.at(-1)).toBe('not-run');
    expect(statuses.filter((s) => s === 'ok').length).toBeLessThan(4);
    // Every test after the first that was not run is not run either.
    expect(statuses.slice(statuses.indexOf('not-run')).every((s) => s === 'not-run')).toBe(true);
  });

  it('says which tools are missing instead of failing in a confusing way', async () => {
    if (has('javac')) return;
    const report = await runJob(job('JAVA', 'public class Main { public static void main(String[] a) {} }'));
    expect(report).toMatchObject({ toolchain: false, missing: ['javac', 'java'], runs: [] });
  });

  it('checks every language in one go when asked to', async () => {
    const report = await runJob({ selfTest: true, deadlineMs: 60_000, ...plain });
    expect(report.selfTest.languages.PYTHON).toMatchObject({ ok: true, detail: null });
    expect(report.selfTest.versions.PYTHON).toMatch(/^Python 3/);
    expect(Object.keys(report.selfTest.languages).sort()).toEqual(['C', 'CPP', 'JAVA', 'JAVASCRIPT', 'PYTHON']);
    for (const [language, result] of Object.entries(report.selfTest.languages)) if (!result.ok) expect(result.detail, language).toMatch(/not installed/);
  }, 60_000);
});

describe.skipIf(!gcc)('running programs (C on this computer)', () => {
  it('shows the compiler’s message without the folder the program was put in', async () => {
    const report = await runJob(job('C', 'int main(void) { return undeclared; }\n'));
    expect(report.compile.ok).toBe(false);
    expect(report.compile.output).toMatch(/main\.c:1:\d+: error/);
    expect(report.compile.output).not.toMatch(/\/build\//);
  });

  it('names the signal a program died of', async () => {
    const report = await runJob(job('C', '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 2; if (n == 0) { volatile int *p = 0; *p = 1; } printf("%d\\n", n * 2); return 0; }\n', ['21', '0']));
    expect(report.runs[0]).toMatchObject({ status: 'ok', exitCode: 0, stdout: '42\n' });
    expect(report.runs[1]).toMatchObject({ status: 'ok', exitCode: null, signal: 'SIGSEGV' });
  });
});

// ── With root: rights are taken away, and the kernel enforces the limits ─────────────────────────
const isolated = process.env.JUDGE_TEST_ISOLATED === '1' && python && (isRoot || spawnSync('sudo', ['-n', 'true']).status === 0);
const asRoot = (...command) => (isRoot ? spawnSync(command[0], command.slice(1), { encoding: 'utf8' }) : spawnSync('sudo', ['-n', ...command], { encoding: 'utf8' }));
const jobDirs = [];

/** As in the machine: the job and the runner are put in a folder, and the runner is started as root. */
function inAMachine(theJob) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-job-'));
  jobDirs.push(dir);
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(theJob));
  fs.copyFileSync(RUNNER, path.join(dir, 'runner.mjs'));
  const run = asRoot(process.execPath, path.join(dir, 'runner.mjs'), dir);
  const line = run.stdout.split('\n').find((l) => l.startsWith(REPORT_PREFIX));
  const stat = (file) => asRoot('stat', '-c', '%U %a', path.join(dir, file)).stdout.trim();
  return { report: JSON.parse(line.slice(REPORT_PREFIX.length)), fromFile: JSON.parse(asRoot('cat', path.join(dir, 'report.json')).stdout), dir, stat };
}

afterAll(() => {
  for (const dir of jobDirs) asRoot('rm', '-rf', dir);
});

const SNOOP = `import glob, os, subprocess, sys
found = []
for target in ["/judge/in", "/judge/in/0", "/judge/in/1", "/etc/shadow", "/root"] + glob.glob("/tmp/judge-job-*/job.json"):
    try:
        (open(target).read() if os.path.isfile(target) else os.listdir(target)); found.append("READ " + target)
    except Exception: pass
for target in ["/judge/build/main.py", "/judge/build/planted", "/judge/planted"] + [d + "/report.json" for d in glob.glob("/tmp/judge-job-*")]:
    try:
        open(target, "w").write("x"); found.append("WROTE " + target)
    except Exception: pass
try:
    if subprocess.run(["sudo", "-n", "true"], stdin=subprocess.DEVNULL, capture_output=True, timeout=5).returncode == 0: found.append("SUDO")
except Exception: pass
# Set-user-id programs (sudo, su, mount) cannot give rights back once this flag is set.
locked = [line.split()[1] for line in open("/proc/self/status") if line.startswith("NoNewPrivs")]
print(os.getuid() != 0, len(os.getgroups()), locked, sorted(os.environ), found, sys.stdin.readline().strip())
`;

describe.skipIf(!isolated)('with root: the program has no rights and the kernel holds it', () => {
  for (const limits of ['cgroup', 'rlimit']) {
    const extra = limits === 'rlimit' ? { limits: 'rlimit' } : {};

    it(`keeps the tests, the job and the system out of reach (${limits})`, () => {
      const { report, fromFile, stat } = inAMachine({ language: 'PYTHON', source: SNOOP, tests: ['first\n', 'second\n'], timeLimitMs: 5000, memoryLimitKb: 65536, deadlineMs: 30_000, ...extra });
      expect(report.isolation.user).toBe(true);
      if (limits === 'rlimit') expect(report.isolation.limits).toBe('rlimit');
      expect(report.runs.map((r) => r.stdout.trim())).toEqual([
        "True 0 ['1'] ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'PWD', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'TMPDIR'] [] first",
        "True 0 ['1'] ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'PWD', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'TMPDIR'] [] second",
      ]);
      // The job (it lists every input) is root's alone; the report is readable and identical on both ways out.
      expect(stat('job.json')).toBe('root 600');
      expect(stat('report.json')).toBe('root 644');
      expect(fromFile).toEqual(report);
    });

    it(`refuses memory beyond the limit and holds a process bomb (${limits})`, () => {
      const source = 'import os, sys, time\nwhat = sys.stdin.readline().strip()\nif what == "memory":\n    block = bytearray(400 * 1024 * 1024)\n    for i in range(0, len(block), 4096): block[i] = 1\n    print(len(block))\nelse:\n    made = 0\n    try:\n        while True:\n            if os.fork() == 0:\n                time.sleep(3); os._exit(0)\n            made += 1\n    except OSError:\n        print(made)\n';
      const { report } = inAMachine({ language: 'PYTHON', source, tests: ['memory\n', 'processes\n', 'processes\n'], timeLimitMs: 5000, memoryLimitKb: 65536, deadlineMs: 30_000, ...extra });
      const [memory, bomb, again] = report.runs;
      expect(memory.stdout.trim()).not.toBe(String(400 * 1024 * 1024));
      if (report.isolation.limits === 'cgroup') expect(memory.status).toBe('memory-limit');
      else expect(memory.stderr).toMatch(/MemoryError/);
      expect(Number(bomb.stdout.trim())).toBeLessThan(100);
      // Nothing of the first bomb was left to count against the second.
      expect(Number(again.stdout.trim())).toBeGreaterThan(30);
    });
  }

  it('refuses to run a program without isolation when it could isolate', () => {
    const { report } = inAMachine({ language: 'PYTHON', source: 'print(1)', tests: [''], unisolated: true });
    expect(report.error).toMatch(/refused when the runner is root/);
  });
});
