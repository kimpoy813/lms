#!/usr/bin/env node
// The machine image that students' programs are checked in (CODE_RUNNER_PROVIDER=vercel-sandbox).
//
//   node scripts/judge-image.mjs          make sure the image exists and check every language
//   node scripts/judge-image.mjs --full   also run the programs a judge has to withstand
//                                         (endless loops, memory and process bombs, attempts to
//                                         read the tests or to reach the network)
//
// The Vercel build runs the first form (scripts/vercel-build.mjs), so that a fresh deployment can
// check programs at once; `npm run judge:check` runs the second. Both start real machines on the
// Vercel account: a handful, each for a few seconds.
//
// Who is asking: on Vercel the build's own identity (VERCEL_OIDC_TOKEN). Elsewhere either that
// token from `vercel env pull`, or VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
//
// Exit code: 0 when everything asked for works, 1 otherwise. The build treats 1 as a warning: the
// site is deployed either way, and the image is prepared again when the first program arrives.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE, IMAGE_TAG, createSandboxJudge, describeError, sandboxCredentials } from '../backend/src/services/judge/vercelSandbox.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full') || process.env.JUDGE_CHECK === 'full';
const say = (line) => console.log(`  ${line}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function regionOfTheSite() {
  if (process.env.CODE_RUNNER_REGION) return process.env.CODE_RUNNER_REGION;
  try {
    const first = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).regions?.[0];
    if (typeof first === 'string' && /^[a-z]{3}\d$/.test(first)) return first;
  } catch {
    // no vercel.json: not a Vercel deployment
  }
  return 'iad1';
}

const access = { accessToken: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID };
const background = [];
const judge = createSandboxJudge({
  region: regionOfTheSite(),
  credentials: () => sandboxCredentials(access),
  log: { info: () => {}, warn: (fields, message) => say(`! ${message}${fields?.detail ? `: ${fields.detail}` : ''}`) },
  // A script has no "after the response": remember the work and finish it before leaving.
  background: (task) => background.push(Promise.resolve().then(task).catch(() => {})),
});

// One program per language that behaves as its input tells it to. Every line is one test.
const PYTHON = `import os, subprocess, sys, time
what = sys.stdin.readline().strip()
if what == "double":
    print(int(sys.stdin.readline()) * 2)
elif what == "loop":
    while True: pass
elif what == "memory":
    block = bytearray(400 * 1024 * 1024)
    for i in range(0, len(block), 4096): block[i] = 1
    print(len(block))
elif what == "processes":
    made = 0
    try:
        while True:
            if os.fork() == 0:
                time.sleep(4); os._exit(0)
            made += 1
    except OSError:
        print("stopped after", "few" if made < 200 else "MANY", "processes")
elif what == "flood":
    while True: print("x" * 1000)
elif what == "snoop":
    found = []
    for target in ["/judge/in", "/judge/in/0", "/judge/in/6", "/tmp/judge-job/job.json", "/etc/shadow", "/root"]:
        try:
            (open(target).read() if os.path.isfile(target) else os.listdir(target)); found.append("READ " + target)
        except Exception: pass
    for target in ["/judge/build/main.py", "/judge/build/x", "/tmp/judge-job/report.json", "/etc/edusphere-judge-image"]:
        try:
            open(target, "w").write("x"); found.append("WROTE " + target)
        except Exception: pass
    try:
        r = subprocess.run(["sudo", "-n", "id", "-u"], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=5)
        if r.returncode == 0: found.append("SUDO " + r.stdout.strip())
    except Exception: pass
    # Each attempt in a process of its own with little time: a blocked network does not answer at all.
    def works(code):
        try:
            return subprocess.run([sys.executable, "-c", code], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1.5).returncode == 0
        except Exception:
            return False
    if works('import socket; socket.create_connection(("1.1.1.1", 443), timeout=1).close()'): found.append("NETWORK")
    if works('import socket; socket.getaddrinfo("example.com", 443)'): found.append("DNS")
    try:
        os.kill(1, 9); found.append("KILLED 1")
    except Exception: pass
    print("uid", os.getuid(), "groups", len(os.getgroups()), "|", "; ".join(found) if found else "nothing reachable")
elif what == "trace":
    raise ValueError("boom")
`;
const C = `#include <stdio.h>
#include <string.h>
int main(void) {
  char what[32]; int n = 0;
  if (scanf("%31s", what) != 1) return 2;
  if (!strcmp(what, "double")) { if (scanf("%d", &n) != 1) return 2; printf("%d\\n", n * 2); return 0; }
  if (!strcmp(what, "segv")) { volatile int *p = 0; *p = 1; }
  if (!strcmp(what, "zero")) { volatile int seven = 7, zero = 0; printf("%d\\n", seven / zero); }
  if (!strcmp(what, "exit3")) return 3;
  return 0;
}
`;
const CPP = `#include <bits/stdc++.h>
using namespace std;
int main() {
  string what; cin >> what;
  if (what == "double") { long long n; cin >> n; cout << n * 2 << "\\n"; }
  if (what == "memory") {
    // Through a volatile pointer, so that the compiler cannot decide the memory is not needed.
    size_t n = 600u * 1024 * 1024; volatile char *block = new char[n]; unsigned long sum = 0;
    for (size_t i = 0; i < n; i += 4096) block[i] = 1;
    for (size_t i = 0; i < n; i += 4096) sum += block[i];
    cout << sum << "\\n";
  }
  if (what == "sort") { vector<int> v(2000000); iota(v.begin(), v.end(), 0); reverse(v.begin(), v.end()); sort(v.begin(), v.end()); cout << v[12345] << "\\n"; }
}
`;
// Deliberately not "public class Main": the runner has to find the class that holds main().
const JAVA = `import java.util.*;
class Helper { static int twice(int n) { return n * 2; } }
class Solution {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in);
    String what = in.next();
    if (what.equals("double")) System.out.println(Helper.twice(in.nextInt()));
    if (what.equals("memory")) { List<long[]> all = new ArrayList<>(); while (true) all.add(new long[1 << 20]); }
    if (what.equals("deep")) System.out.println(depth(0));
    if (what.equals("unicode")) System.out.println("Pilipinas ñ € ✓");
  }
  static int depth(int n) { return n >= 200000 ? n : depth(n + 1); }
}
`;
const JAVASCRIPT = `const [what, arg] = require('fs').readFileSync(0, 'utf8').split('\\n');
if (what === 'double') console.log(Number(arg) * 2);
if (what === 'memory') { const all = []; while (true) all.push(new Array(1e5).fill(Math.random())); }
if (what === 'loop') while (true) {}
`;

/** [language, source, limits, [[input, check(run) → problem or null, label]]] */
const SUITE = [
  ['PYTHON', PYTHON, { timeLimitMs: 5000, memoryLimitKb: 65536 }, [
    ['double\n21\n', (r) => (r.exitCode === 0 && r.stdout.trim() === '42' ? null : 'wrong output'), 'runs'],
    ['loop\n', (r) => (r.timedOut ? null : 'not stopped'), 'endless loop is stopped at the time limit'],
    ['memory\n', (r) => (r.exitCode !== 0 && !r.timedOut && !/^\d+$/.test(r.stdout.trim()) ? null : 'memory was handed out'), '400 MB with a 64 MB limit is refused'],
    ['processes\n', (r) => (/few/.test(r.stdout) ? null : `not held: ${r.stdout.trim() || r.stderr.trim()}`), 'process bomb is held'],
    ['flood\n', (r) => (/Output limit/.test(r.stderr) ? null : 'not cut'), 'endless output is cut'],
    ['snoop\n', (r) => (/nothing reachable/.test(r.stdout) && !/uid 0 /.test(r.stdout) ? null : `REACHED: ${r.stdout.trim()}`), 'tests, job, system files, sudo and network are out of reach'],
    ['trace\n', (r) => (r.exitCode === 1 && /ValueError: boom/.test(r.stderr) && /File "main\.py"/.test(r.stderr) ? null : 'trace not as expected'), 'error trace is readable'],
    ['double\n4\n', (r) => (r.exitCode === 0 && r.stdout.trim() === '8' ? null : 'a later test was disturbed by the earlier ones'), 'the next test is not disturbed'],
  ]],
  ['C', C, { timeLimitMs: 2000, memoryLimitKb: 65536 }, [
    ['double 21', (r) => (r.exitCode === 0 && r.stdout.trim() === '42' ? null : 'wrong output'), 'runs'],
    ['segv', (r) => (r.exitCode === 139 && /Segmentation fault/.test(r.stderr) ? null : `exit ${r.exitCode}`), 'segmentation fault is named'],
    ['zero', (r) => (r.exitCode === 136 ? null : `exit ${r.exitCode}`), 'division by zero is named'],
    ['exit3', (r) => (r.exitCode === 3 ? null : `exit ${r.exitCode}`), 'exit code is passed on'],
  ]],
  ['CPP', CPP, { timeLimitMs: 3000, memoryLimitKb: 131072 }, [
    ['double 21', (r) => (r.exitCode === 0 && r.stdout.trim() === '42' ? null : 'wrong output'), 'runs'],
    ['sort', (r) => (r.exitCode === 0 && r.stdout.trim() === '12345' ? null : 'wrong output'), 'sorts two million numbers in time'],
    ['memory', (r) => (r.exitCode !== 0 && !/^\d+$/.test(r.stdout.trim()) ? null : 'memory was handed out'), '600 MB with a 128 MB limit is refused'],
  ]],
  ['JAVA', JAVA, { timeLimitMs: 4000, memoryLimitKb: 65536 }, [
    ['double 21', (r) => (r.exitCode === 0 && r.stdout.trim() === '42' ? null : `wrong output: ${r.stderr.slice(0, 120)}`), 'runs (class not called Main)'],
    ['memory', (r) => (r.exitCode !== 0 && !r.timedOut ? null : 'not refused'), 'heap beyond the limit is refused'],
    ['deep', (r) => (r.exitCode === 0 && r.stdout.trim() === '200000' ? null : `exit ${r.exitCode}`), 'deep recursion has room'],
    ['unicode', (r) => (r.stdout.trim() === 'Pilipinas ñ € ✓' ? null : `got ${JSON.stringify(r.stdout.trim())}`), 'prints non-English characters'],
  ]],
  ['JAVASCRIPT', JAVASCRIPT, { timeLimitMs: 2000, memoryLimitKb: 65536 }, [
    ['double\n21\n', (r) => (r.exitCode === 0 && r.stdout.trim() === '42' ? null : 'wrong output'), 'runs'],
    ['memory\n', (r) => (r.exitCode !== 0 ? null : 'not refused'), 'heap beyond the limit is refused'],
    ['loop\n', (r) => (r.timedOut ? null : 'not stopped'), 'endless loop is stopped'],
  ]],
];

const LABEL = { PYTHON: 'Python', JAVASCRIPT: 'JavaScript', C: 'C', CPP: 'C++', JAVA: 'Java' };

async function main() {
  if (!sandboxCredentials(access)) {
    say('✗ No Vercel identity: VERCEL_OIDC_TOKEN is not set, and neither are VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.');
    return false;
  }
  say(`image ${judge.name} (recipe ${IMAGE_TAG}, from ${BASE_IMAGE}, region ${judge.region})`);
  const started = Date.now();
  const image = await judge.ensureImage({ onProgress: (line) => say(`· ${line}`) });
  if (!image.check) {
    say(`✗ The image is not ready (${image.state}): ${image.detail ?? 'no reason given'}`);
    return false;
  }
  say(`${image.prepared ? `prepared in ${seconds(Date.now() - started)}` : 'already there'}${image.sizeBytes ? `, ${Math.round(image.sizeBytes / 1e6)} MB as a snapshot` : ''}`);
  const { languages, versions, isolation, timings } = image.check;
  for (const [id, l] of Object.entries(languages)) {
    say(`${l.ok ? '✓' : '✗'} ${LABEL[id] ?? id}: ${l.ok ? `compiled in ${l.compileMs} ms, ran in ${l.runMs} ms${l.peakKb ? `, ${Math.round(l.peakKb / 1024)} MB` : ''}` : l.detail} (${versions[id] ?? 'version unknown'})`);
  }
  say(`limits by ${isolation?.limits === 'cgroup' ? 'kernel control groups' : `per-process limits${isolation?.note ? ` (control groups: ${isolation.note})` : ''}`}; one check took ${seconds(timings.totalMs)} (machine ${seconds(timings.startMs)}, upload ${seconds(timings.uploadMs)}, run ${seconds(timings.runMs)})`);
  let ok = image.ok;

  if (process.env.VERCEL_ENV === 'production') {
    // Images of earlier recipes are of no use to anybody once this one is live.
    const removed = await judge.removeOtherImages().catch((err) => {
      say(`! Could not look for older images: ${describeError(err)}`);
      return [];
    });
    if (removed.length > 0) say(`removed older images: ${removed.join(', ')}`);
  }

  if (full) {
    try {
      const kept = await judge.inventory();
      say(`on the account: ${kept.images.map((image) => `${image.name} (${image.status}${image.current ? ', in use' : ''})`).join(', ') || 'no image'}; ${kept.snapshots} snapshot(s), ${Math.round(kept.snapshotBytes / 1e6)} MB`);
    } catch (err) {
      say(`! Could not list what is kept on the account: ${describeError(err)}`);
    }
    say('');
    say('What a judge has to withstand:');
    for (const [language, source, limits, tests] of SUITE) {
      const t = Date.now();
      let out;
      try {
        out = await judge.runBatch({ language, code: source, inputs: tests.map(([input]) => input), ...limits });
      } catch (err) {
        say(`✗ ${LABEL[language]}: ${describeError(err)}`);
        ok = false;
        continue;
      }
      if (out.compileError) {
        say(`✗ ${LABEL[language]}: did not compile: ${out.compileError.slice(0, 300)}`);
        ok = false;
        continue;
      }
      say(`${LABEL[language]} — ${tests.length} tests in ${seconds(Date.now() - t)} (machine ${seconds(out.timings.startMs)}, upload ${seconds(out.timings.uploadMs)}, run ${seconds(out.timings.runMs)})`);
      tests.forEach(([, check, label], i) => {
        const run = out.runs[i];
        const problem = run ? check(run) : 'no result';
        if (problem) ok = false;
        say(`  ${problem ? '✗' : '✓'} ${label}${problem ? ` — ${problem} [exit ${run?.exitCode}, timed out ${run?.timedOut}, stderr ${JSON.stringify((run?.stderr ?? '').slice(-160))}]` : ''}`);
      });
    }
    // The same limits without kernel control groups, which is how the runner works on a machine
    // that does not offer them.
    try {
      const tests = SUITE[0][3].filter(([, , label]) => /refused|held|stopped|runs/.test(label));
      const out = await judge.runBatch({ language: 'PYTHON', code: PYTHON, inputs: tests.map(([input]) => input), timeLimitMs: 2000, memoryLimitKb: 65536, limits: 'rlimit' });
      const problems = tests.map(([, check, label], i) => (out.runs[i] ? check(out.runs[i]) : 'no result') && label).filter(Boolean);
      if (out.limits !== 'rlimit' || problems.length > 0) ok = false;
      say(`${problems.length === 0 && out.limits === 'rlimit' ? '✓' : '✗'} the limits also hold without control groups${problems.length ? ` — failed: ${problems.join('; ')}` : ''}`);
    } catch (err) {
      say(`✗ limits without control groups: ${describeError(err)}`);
      ok = false;
    }
    // A program that does not compile, and one in a language's own words.
    try {
      const bad = await judge.runBatch({ language: 'JAVA', code: 'public class Main { public static void main(String[] a) { int x = "text"; } }', inputs: [''], timeLimitMs: 2000, memoryLimitKb: 65536 });
      const fine = Boolean(bad.compileError) && /incompatible types/.test(bad.compileError) && !bad.compileError.includes('/judge/');
      if (!fine) ok = false;
      say(`${fine ? '✓' : '✗'} a compile error is reported in the compiler's words${fine ? '' : `: ${JSON.stringify(bad.compileError)}`}`);
    } catch (err) {
      say(`✗ compile error case: ${describeError(err)}`);
      ok = false;
    }
  }
  return ok;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  say(`✗ ${describeError(err)}`);
}
await Promise.allSettled(background);
say(ok ? '✓ Programs can be checked.' : '✗ Programs cannot be checked yet. See above.');
process.exit(ok ? 0 : 1);
