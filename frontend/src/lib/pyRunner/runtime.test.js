// @vitest-environment node
//
// The browser's Python against the server's checker.
//
// The same Python programs are run here by the code the web app runs them with (worker.js and
// harness.py, on Pyodide under Node.js) and were run by the checker's own runner with the Python
// the server's machines have; what the checker said is in fixtures/reference.json
// (scripts/python-reference.mjs writes it). The two have to agree — or the web app has to know
// that it must ask the server.
import fs from 'node:fs';
import { loadPyodide } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import programs from './fixtures/programs.js';
import { mayBeTheBrowser, toRun } from './judge.js';
import { STDERR_LIMIT, STDOUT_LIMIT, createRuntime } from './worker.js';

const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));
const harness = fs.readFileSync(new URL('./harness.py', import.meta.url), 'utf8');

let runtime;
const events = [];
beforeAll(async () => {
  const pyodide = await loadPyodide();
  runtime = createRuntime(pyodide, harness, { onOverflow: () => events.push(['overflow']), onWrite: (stream, bytes) => events.push([stream, bytes.length]) });
}, 120_000);

/** One program the way the worker runs it: check, then every input. */
function runHere(code, inputs) {
  const checked = runtime.check(code);
  if (checked.compileError || checked.serverOnly) return { ...checked, runs: [] };
  const runs = [];
  for (let index = 0; index < inputs.length; index += 1) runs.push(runtime.run(index, inputs[index]));
  return { compileError: null, serverOnly: null, runs };
}

describe('the reference', () => {
  it('was written by a Python of the kind the browser has', () => {
    expect(reference.python).toMatch(/^3\.14\./);
    expect(Object.keys(reference.programs).sort()).toEqual(programs.map((p) => p.name).sort());
  });
});

describe.each(['syntax', 'exit', 'programs'])('programs of the group "%s"', (group) => {
  it.each(programs.filter((p) => p.group === group && !p.server).map((p) => [p.name, p]))('%s: the browser answers as the checker does', (name, program) => {
    const expected = reference.programs[name];
    const here = runHere(program.code, program.inputs);
    expect(here.serverOnly).toBeNull();
    // The checker trims what the compiler wrote.
    expect(here.compileError?.trim() ?? null).toBe(expected.compileError);
    expect(here.runs.map((raw) => toRun(raw))).toEqual(expected.runs);
    expect(here.runs.every((raw) => raw.serverOnly === null && raw.doubt === false)).toBe(true);
  });
});

describe('programs the browser leaves to the server', () => {
  it.each(programs.filter((p) => p.server).map((p) => [p.name, p]))('%s', (name, program) => {
    const checked = runtime.check(program.code);
    expect(checked.compileError).toBeNull();
    expect(checked.serverOnly).toContain(program.server);
  });

  it.each([
    ['threads', 'import threading\nprint(1)\n', 'threading'],
    ['processes', 'import subprocess\n', 'subprocess'],
    ['a socket', 'from socket import socket\n', 'socket'],
    ['an add-on package', 'import numpy as np\n', 'numpy'],
    ['a relative import', 'from . import helper\n', "'.'"],
    ['the size of a number on the machine', 'import sys\nprint(sys.maxsize)\n', 'sys.maxsize'],
    ['the same under another name', 'import sys as system\nprint(system.getsizeof(1))\n', 'sys.getsizeof'],
    ['… or imported by name', 'from sys import maxsize\n', 'sys.maxsize'],
    ['everything of os at once', 'from os import *\n', 'os.*'],
    ['the recursion limit', 'import sys\nsys.setrecursionlimit(10**6)\n', 'sys.setrecursionlimit'],
    ['a command of the system', 'import os\nos.system("clear")\n', 'os.system'],
    ['the folder it runs in', 'import os\nprint(os.getcwd())\n', 'os.getcwd'],
    ['a file', 'f = open("data.txt")\n', 'opens a file'],
    ['a file through io', 'import io\nio.open("data.txt")\n', 'io.open'],
    ['the debugger', 'breakpoint()\n', 'breakpoint'],
    ['an import by name', 'm = __import__("math")\n', '__import__'],
  ])('a program that uses %s', (what, code, reason) => {
    expect(runtime.check(code).serverOnly).toContain(reason);
  });

  it('does not mistake the program’s own names for the machine’s', () => {
    const code = 'class Car:\n    def __init__(self):\n        self.platform = "x"\n        self.system = 1\n        self.path = []\nc = Car()\nprint(c.platform, c.system, c.path)\nimport os\nprint(os.path.join("a", "b"), os.sep)\n';
    expect(runtime.check(code)).toEqual({ compileError: null, serverOnly: null });
    expect(runtime.run(0, '').stdout).toBe('x 1 []\na/b /\n');
  });

  it('notices an import that only happens while the program runs', () => {
    const here = runHere('print("before")\nexec("import socket")\nprint("after")\n', ['']);
    expect(here.serverOnly).toBeNull();
    expect(here.runs[0].serverOnly).toContain('socket');
  });

  it('lets the library import what it needs for itself', () => {
    // strptime imports a module of its own the first time it is used, from inside the program.
    const here = runHere('import datetime\nprint(datetime.datetime.strptime("2024-05-06", "%Y-%m-%d").year)\n', ['']);
    expect(here.runs[0]).toMatchObject({ stdout: '2024\n', exitCode: 0, serverOnly: null });
  });
});

describe('what a 32-bit and a 64-bit Python print differently', () => {
  it.each(programs.filter((p) => p.group === 'platform' && !p.server).map((p) => [p.name, p]))('%s: the same, or recognised as the browser’s doing', (name, program) => {
    const expected = reference.programs[name];
    const here = runHere(program.code, program.inputs);
    expect(here.compileError).toBeNull();
    here.runs.map((raw) => toRun(raw)).forEach((run, i) => {
      expect(run.exitCode).toBe(expected.runs[i].exitCode);
      if (run.stdout !== expected.runs[i].stdout) expect(mayBeTheBrowser(run.stdout, expected.runs[i].stdout)).toBe(true);
    });
  });
});

describe('one run after another', () => {
  it('starts each run as a new process would', () => {
    const code = [
      'import builtins, sys, random, warnings, decimal',
      'print(getattr(builtins, "leak", "clean"), "x" in globals(), getattr(random, "leak", "clean"))',
      'print(sys.getrecursionlimit(), decimal.getcontext().prec, len(warnings.filters) > 0)',
      'try:',
      '    builtins.open("left.txt").close()',
      '    print("a file was left")',
      'except FileNotFoundError:',
      '    print("empty folder")',
      'builtins.leak = 1; x = 2; random.leak = 1; decimal.getcontext().prec = 5',
      'builtins.open("left.txt", "w").close()',
      'warnings.simplefilter("ignore"); builtins.len = lambda _: 99',
      'sys.stdout.write("done\\n")',
    ].join('\n');
    expect(runtime.check(code)).toEqual({ compileError: null, serverOnly: null });
    const first = runtime.run(0, '');
    const second = runtime.run(1, '');
    expect(first.stdout).toBe('clean False clean\n1000 28 True\nempty folder\ndone\n');
    expect(second.stdout).toBe(first.stdout);
    expect(second.exitCode).toBe(0);
  });

  it('gives the next program its own lines in error messages', () => {
    // Both files have the same name inside the interpreter.
    runHere('x = 1\ny = 2\nraise ValueError("first")\n', ['']);
    const second = runHere('print("a")\nimport warnings\nwarnings.warn("careful")\n', ['']);
    expect(second.runs[0].stderr).toBe('main.py:3: UserWarning: careful\n  warnings.warn("careful")\n');
  });

  it('opens standard input and output again when a program closed them', () => {
    // What `open(0).read()` does on the way out: the file object closes descriptor 0 with itself.
    const closes = runHere('import builtins\nprint(builtins.open(0).read().strip())\n', ['first\n']);
    expect(closes.runs[0].stdout).toBe('first\n');
    expect(runHere('print(input())\n', ['still here\n']).runs[0]).toMatchObject({ stdout: 'still here\n', exitCode: 0 });
  });
});

describe('a program that prints too much', () => {
  it('is stopped at the limit, and the page is told at once', () => {
    events.length = 0;
    const here = runHere('i = 0\nwhile True:\n    print("spam and eggs", i)\n    i += 1\n', ['']);
    const [raw] = here.runs;
    expect(raw.outputLimit).toBe(true);
    expect(new TextEncoder().encode(raw.stdout).length).toBe(STDOUT_LIMIT);
    expect(raw.stderr).toBe(''); // the interruption itself is not the program's output
    expect(events.filter(([kind]) => kind === 'overflow')).toHaveLength(1);
    expect(events.filter(([kind]) => kind === 'out').reduce((sum, [, size]) => sum + size, 0)).toBeGreaterThanOrEqual(STDOUT_LIMIT);
    expect(toRun(raw)).toMatchObject({ exitCode: 1, timedOut: false, stderr: 'Output limit exceeded: the program printed more than 64 KB.' });
  });

  it('counts what goes to standard error as well', () => {
    const [raw] = runHere('import sys\nprint("kept")\nsys.stdout.flush()\nwhile True:\n    sys.stderr.write("e" * 1000 + "\\n")\n', ['']).runs;
    expect(raw.outputLimit).toBe(true);
    expect(raw.stdout).toBe('kept\n');
    expect(new TextEncoder().encode(raw.stderr).length).toBe(STDERR_LIMIT);
  });

  it('is not disturbed by the program before it', () => {
    expect(runHere('print("fine")\n', ['']).runs[0]).toMatchObject({ stdout: 'fine\n', stderr: '', exitCode: 0, outputLimit: false });
  });
});

describe('failures that may be the browser’s', () => {
  it.each([
    ['memory', 'raise MemoryError()\n', 'MemoryError'],
    ['a number too large for a 32-bit build', 'import math\nmath.exp(1000)\n', 'OverflowError'],
    ['the system underneath', 'import builtins\nbuiltins.open("/nowhere")\n', 'FileNotFoundError'],
    ['a module that is not there', 'import importlib_does_not_exist_here\n', null],
  ])('%s is marked as doubtful', (what, code, exception) => {
    const here = runHere(code, ['']);
    if (exception === null) return expect(here.serverOnly ?? here.runs[0]?.serverOnly).toBeTruthy();
    expect(here.runs[0]).toMatchObject({ exception, doubt: true, exitCode: 1 });
    return undefined;
  });

  it('ordinary mistakes are not', () => {
    for (const code of ['1 / 0\n', 'int("x")\n', '[][1]\n', 'raise NotImplementedError\n', 'def f(n):\n    return f(n + 1)\nf(0)\n']) {
      expect(runHere(code, ['']).runs[0]).toMatchObject({ doubt: false, exitCode: 1 });
    }
  });
});
