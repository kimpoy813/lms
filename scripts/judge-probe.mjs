#!/usr/bin/env node
// TEMPORARY (exploration, removed before this branch is merged).
//
// Runs inside a Vercel preview build of this branch when EDUSPHERE_JUDGE_PROBE=1 and reports, in
// the build log, how Vercel Sandbox behaves for this project: whether the project's own identity
// is accepted, what the machine contains, whether the limits a judge needs can be enforced, and
// how long each step takes. Uses toy programs only. Never fails the build.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const say = (line) => console.log(`PROBE ${String(line).replace(/\s+/g, ' ').trim().slice(0, 1500)}`);
const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const errText = (err) => {
  const status = err?.response?.status ? `HTTP ${err.response.status} ` : '';
  const body = err?.json ? JSON.stringify(err.json) : (err?.text ?? '');
  return `${err?.name ?? 'Error'}: ${status}${err?.message ?? err} ${body}`.replace(/\s+/g, ' ').slice(0, 600);
};

const REGION = process.env.CODE_RUNNER_REGION || 'sin1';
const token = process.env.VERCEL_OIDC_TOKEN;
let creds = null;

function readClaims() {
  if (!token) return say('identity: VERCEL_OIDC_TOKEN is NOT set in this build');
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    creds = { token, teamId: claims.owner_id, projectId: claims.project_id };
    say(`identity: token present; iss=${claims.iss} aud=${claims.aud} owner=${claims.owner} project=${claims.project} environment=${claims.environment} plan=${claims.plan ?? '?'} valid-for=${claims.exp - Math.floor(Date.now() / 1000)}s claims=${Object.keys(claims).join(',')}`);
  } catch (err) {
    say(`identity: token present but unreadable (${err.message})`);
  }
  return null;
}

async function main() {
  readClaims();
  if (!creds) return;
  const require = createRequire(path.join(root, 'backend', 'package.json'));
  const { Sandbox, Snapshot } = await import(pathToFileURL(require.resolve('@vercel/sandbox')).href);

  const sh = async (sb, script, { sudo = false, timeoutMs = 240_000 } = {}) => {
    const t = Date.now();
    try {
      const r = await sb.runCommand({ cmd: 'bash', args: ['-c', script], sudo, timeoutMs });
      const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
      return { code: r.exitCode, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - t };
    } catch (err) {
      return { code: -1, stdout: '', stderr: errText(err), ms: Date.now() - t };
    }
  };
  const show = (label, r, max = 1100) => say(`${label}: exit=${r.code} ${r.ms}ms out=${JSON.stringify(r.stdout.slice(0, max))}${r.stderr ? ` err=${JSON.stringify(r.stderr.slice(-300))}` : ''}`);

  const name = `edusphere-judge-probe-${Date.now().toString(36)}`;
  let base = null;
  let t = Date.now();
  try {
    base = await Sandbox.create({ name, region: REGION, resources: { vcpus: 1 }, timeout: 14 * 60_000, persistent: true, snapshotExpiration: 0, tags: { purpose: 'edusphere-judge-probe' }, ...creds });
    say(`base: created in ${since(t)} name=${base.name} region=${base.region} status=${base.status} persistent=${base.persistent} timeout=${base.timeout}`);
  } catch (err) {
    return say(`base: create failed after ${since(t)}: ${errText(err)}`);
  }

  let snapshotId = null;
  const extras = [];
  try {
    show('machine', await sh(base, 'echo "$(. /etc/os-release; echo $PRETTY_NAME) | kernel $(uname -r) | user $(id -un) uid $(id -u) | cwd $(pwd) | home $HOME | cpus $(nproc) | mem $(free -m | awk \'/Mem/{print $2}\')MB | disk free $(df -h / | awk \'NR==2{print $4}\') of $(df -h / | awk \'NR==2{print $2}\') | tmp on $(df /tmp | awk \'NR==2{print $1}\') | python3 $(python3 --version 2>&1) | node $(node --version 2>&1) | gcc $(command -v gcc || echo none) | javac $(command -v javac || echo none) | env names: $(env | cut -d= -f1 | tr \'\\n\' \' \')"'));
    show('as root', await sh(base, 'echo "uid $(id -u) | home $HOME | node $(command -v node) | python3 $(command -v python3) | PATH $PATH | processes: $(ps -e -o user=,comm= | sort | uniq -c | sort -rn | head -12 | tr \'\\n\' \';\')"', { sudo: true }));
    show('network before any policy', await sh(base, 'curl -sS -m 8 -o /dev/null -w "http=%{http_code}" https://example.com 2>&1 | tail -c 100'));

    t = Date.now();
    show('install compilers', await sh(base, 'export DEBIAN_FRONTEND=noninteractive; (apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc g++ libc6-dev default-jdk-headless) > /tmp/apt.log 2>&1; code=$?; echo "apt exit $code; $(tail -c 200 /tmp/apt.log | tr \'\\n\' \' \'); disk free now $(df -h / | awk \'NR==2{print $4}\')"; exit $code', { sudo: true, timeoutMs: 600_000 }));

    t = Date.now();
    await base.writeFiles([{ path: '/tmp/judge-probe-vm.sh', content: fs.readFileSync(path.join(here, 'judge-probe-vm.sh')) }]);
    say(`upload: one small file written in ${since(t)}`);
    const iso = await sh(base, 'bash /tmp/judge-probe-vm.sh 2>&1', { sudo: true, timeoutMs: 300_000 });
    say(`limits script: exit=${iso.code} ${iso.ms}ms${iso.stderr ? ` err=${iso.stderr.slice(-300)}` : ''}`);
    for (const line of iso.stdout.split('\n')) if (line.trim()) say(line);

    t = Date.now();
    const stopped = await base.stop();
    say(`base: stopped in ${since(t)}; status=${stopped?.status} snapshot=${JSON.stringify(stopped?.snapshot ?? null).slice(0, 400)} cpu-ms=${base.activeCpuUsageMs ?? stopped?.activeCpuUsageMs ?? '?'}`);
    t = Date.now();
    const listed = await Snapshot.list({ name, ...creds });
    say(`snapshots of ${name} (listed in ${since(t)}): ${JSON.stringify((listed.snapshots ?? []).map((s) => ({ id: s.id, status: s.status, MB: Math.round(s.sizeBytes / 1e6), region: s.region, regions: s.regions, expiresAt: s.expiresAt ?? null, method: s.creationMethod })))}`);
    snapshotId = (listed.snapshots ?? []).find((s) => s.status === 'created')?.id ?? null;
  } catch (err) {
    say(`base: unexpected failure: ${errText(err)}`);
  }

  try {
    await trials();
  } catch (err) {
    say(`trials: unexpected failure: ${errText(err)}`);
  }
  await cleanup();

  async function trials() {
    if (Date.now() - started > 13 * 60_000) return say('trials: skipped, the build has already taken 13 minutes');
  // How long does a fresh machine for one submission take, and what does each step cost?
  const trial = async (label, make) => {
    let sb = null;
    const t0 = Date.now();
    try {
      sb = await make();
      const created = since(t0);
      let w = Date.now();
      await sb.writeFiles([{ path: '/tmp/job/Main.java', content: 'import java.util.Scanner;\npublic class Main { public static void main(String[] a){ Scanner s = new Scanner(System.in); System.out.println(s.nextInt()*2); } }\n' }, { path: '/tmp/job/in.txt', content: '21\n' }]);
      const wrote = since(w);
      const noop = await sh(sb, 'true');
      const java = await sh(sb, 'cd /tmp/job && javac Main.java && java -XX:+UseSerialGC -Xmx128m Main < in.txt; echo "| tmp kept from base: $(ls /tmp/apt.log 2>/dev/null | wc -l) | gcc: $(command -v gcc || echo none) | judgeuser: $(id -u judgeuser 2>/dev/null || echo none)"', { sudo: true });
      const net = await sh(sb, 'curl -sS -m 5 -o /dev/null -w "http=%{http_code}" https://example.com 2>&1 | tail -c 90; echo " | dns: $(getent hosts example.com | head -1 || true)"');
      w = Date.now();
      const buf = await sb.readFileToBuffer({ path: '/tmp/job/in.txt' });
      const read = since(w);
      say(`${label}: created in ${created} region=${sb.region} status=${sb.status} | write=${wrote} | noop command=${noop.ms}ms | javac+java=${java.ms}ms exit=${java.code} out=${JSON.stringify(java.stdout.slice(0, 160))}${java.stderr ? ` err=${JSON.stringify(java.stderr.slice(-200))}` : ''} | read=${read} (${buf?.length ?? 'null'} bytes) | network: ${JSON.stringify(net.stdout.slice(0, 200))} ${JSON.stringify(net.stderr.slice(-120))}`);
      w = Date.now();
      await sb.stop();
      say(`${label}: stopped in ${since(w)}; whole trial ${since(t0)}; cpu-ms=${sb.activeCpuUsageMs ?? '?'}`);
    } catch (err) {
      say(`${label}: failed after ${since(t0)}: ${errText(err)}`);
      await sb?.stop().catch(() => {});
    }
    return sb;
  };
  const common = { region: REGION, resources: { vcpus: 1 }, timeout: 3 * 60_000, persistent: false, networkPolicy: 'deny-all', tags: { purpose: 'edusphere-judge-probe' }, ...creds };
  extras.push(await trial('fork #1', () => Sandbox.fork({ sourceSandbox: name, ...common })));
  extras.push(await trial('fork #2', () => Sandbox.fork({ sourceSandbox: name, ...common })));
  if (snapshotId) {
    extras.push(await trial('from snapshot #1', () => Sandbox.create({ source: { type: 'snapshot', snapshotId }, ...common })));
    extras.push(await trial('from snapshot #2', () => Sandbox.create({ source: { type: 'snapshot', snapshotId }, ...common })));
  }
  extras.push(await trial('plain image, no snapshot', () => Sandbox.create({ ...common })));
  }

  // Leave nothing behind.
  async function cleanup() {
  try {
    const all = await Sandbox.list({ namePrefix: 'edusphere-judge-probe', ...creds });
    say(`cleanup: sandboxes listed: ${JSON.stringify((all.sandboxes ?? []).map((s) => ({ name: s.name, status: s.status, persistent: s.persistent, image: s.image ?? s.runtime, vcpus: s.vcpus, memory: s.memory })))}`);
  } catch (err) {
    say(`cleanup: listing sandboxes failed: ${errText(err)}`);
  }
  for (const sb of extras) await sb?.delete({ deleteOrphanSnapshots: true }).catch((err) => say(`cleanup: deleting ${sb?.name} failed: ${errText(err)}`));
  try {
    await base.delete({ deleteOrphanSnapshots: true });
    say(`cleanup: base ${name} deleted with its snapshots`);
  } catch (err) {
    say(`cleanup: deleting base failed: ${errText(err)}`);
  }
  try {
    const left = await Sandbox.list({ namePrefix: 'edusphere-judge-probe', ...creds });
    const snaps = await Snapshot.list({ ...creds });
    say(`cleanup: sandboxes left: ${(left.sandboxes ?? []).length}; snapshots in the project now: ${JSON.stringify((snaps.snapshots ?? []).map((s) => ({ id: s.id, status: s.status, MB: Math.round(s.sizeBytes / 1e6) })))}`);
  } catch (err) {
    say(`cleanup: final listing failed: ${errText(err)}`);
  }
  }
}

const started = Date.now();
say(`start: node=${process.version} build-region=${process.env.VERCEL_REGION ?? '?'} env=${process.env.VERCEL_ENV} sandbox-region=${REGION}`);
try {
  await main();
} catch (err) {
  say(`failed: ${errText(err)}`);
}
say(`end: ${since(started)}`);
process.exit(0);
