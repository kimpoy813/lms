#!/usr/bin/env node
// What the server's checker says about the Python programs the browser is tested against.
//
//   node scripts/python-reference.mjs            write frontend/src/lib/pyRunner/fixtures/reference.json
//   node scripts/python-reference.mjs --check    compare instead, exit 1 on a difference
//
// The programs (fixtures/programs.js) are run by the checker's own runner, the file that is
// uploaded into the machines (backend/src/services/judge/vmRunner.mjs), on this computer and
// without its isolation, and turned into answers by the same code the API uses. Needs `python3`
// on the runner's PATH (/usr/local/bin, /usr/bin, …) to be the Python the server's machines
// have — its version is recorded, and `--check` on another version only says so.
//
// frontend/src/lib/pyRunner/runtime.test.js then runs the same programs in the browser's Python
// (Pyodide, under Node.js) and compares.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip } from '../backend/src/lib/judging.js';
import { toRun } from '../backend/src/services/judge/vercelSandbox.js';
import { runJob } from '../backend/src/services/judge/vmRunner.mjs';
import programs from '../frontend/src/lib/pyRunner/fixtures/programs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'frontend', 'src', 'lib', 'pyRunner', 'fixtures', 'reference.json');
const check = process.argv.includes('--check');
const memoryLimitKb = 131072;

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('Run this as an ordinary user: as root the runner insists on isolating programs, which changes the computer it runs on.');
  process.exit(1);
}
const python = spawnSync('python3', ['--version'], { encoding: 'utf8', env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
const version = /Python (\d+\.\d+\.\d+)/.exec(`${python.stdout}${python.stderr}`)?.[1];
if (!version) {
  console.error('python3 was not found where the runner looks for it (/usr/local/bin, /usr/bin, …).');
  process.exit(1);
}

const answers = {};
for (const program of programs) {
  // What codeRunner.js makes of the runner's report: runBatch().
  const report = await runJob({ language: 'PYTHON', source: program.code, tests: program.inputs, timeLimitMs: 5000, memoryLimitKb, deadlineMs: 60_000, unisolated: true });
  if (!report.toolchain) throw new Error(`the runner found no Python: ${JSON.stringify(report).slice(0, 200)}`);
  answers[program.name] = report.compile.ok
    ? { compileError: null, runs: report.runs.map((run) => toRun(run, { memoryLimitKb })).map((run) => ({ stdout: clip(run.stdout), stderr: clip(run.stderr), exitCode: run.exitCode ?? null, timedOut: run.timedOut === true })) }
    : { compileError: clip(report.compile.output), runs: [] };
}
const reference = { python: version, programs: answers };
const text = `${JSON.stringify(reference, null, 1)}\n`;

if (!check) {
  fs.writeFileSync(file, text);
  console.log(`${programs.length} programs run with Python ${version} → ${path.relative(root, file)}`);
  process.exit(0);
}
const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
if (stored.python.split('.').slice(0, 2).join('.') !== version.split('.').slice(0, 2).join('.')) {
  console.log(`The reference was written with Python ${stored.python}; this computer has ${version}. Nothing compared.`);
  process.exit(0);
}
const different = programs.filter((p) => JSON.stringify(stored.programs[p.name]) !== JSON.stringify(answers[p.name])).map((p) => p.name);
if (different.length > 0) {
  console.error(`The checker now answers differently for: ${different.join(', ')}. Look at why, then run this script without --check.`);
  process.exit(1);
}
console.log(`${programs.length} programs: the checker answers as the reference says (Python ${version}).`);
