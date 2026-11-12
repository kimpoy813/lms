// Which installed dependencies call require() on an ES module?
//
// Node.js 22.12 and later can do that. Vercel's Node.js runtime refuses it (ERR_REQUIRE_ESM) unless
// the project sets NODE_OPTIONS=--experimental-require-module, and a function whose dependencies
// need it does not start there. Nothing notices before that: the build succeeds, and the tests
// pass on any ordinary Node.js. The build step uses this to stop with an explanation instead
// (scripts/vercel-build.mjs).
//
// Only packages are looked at, not the project's own code, which is ES modules throughout.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The folder of the installed package `name`, as code in `fromDir` would find it. */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

/** true when Node.js treats `file` as an ES module: .mjs, or .js under a package of type "module". */
function isEsModule(file) {
  if (file.endsWith('.mjs')) return true;
  if (!file.endsWith('.js')) return false;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg) return pkg.type === 'module';
    if (dir === path.dirname(dir)) return false;
  }
}

function* scriptsOf(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* scriptsOf(file);
    else if (/\.c?js$/.test(entry.name)) yield file;
  }
}

/**
 * @param {string} startDir folder of the package whose installed dependencies are examined
 * @returns {{ package: string, file: string, requires: string }[]} one entry per package and
 *          required name; `file` is the first file found doing it, relative to that package
 */
export function findRequiredEsModules(startDir) {
  // Everything the package installs for running (not its development tools), found as Node.js would.
  const start = readJson(path.join(startDir, 'package.json')) ?? {};
  const packages = new Map();
  const queue = Object.keys({ ...start.dependencies, ...start.optionalDependencies }).map((name) => [name, startDir]);
  while (queue.length > 0) {
    const [name, fromDir] = queue.pop();
    const dir = packageDir(name, fromDir);
    if (!dir || packages.has(dir)) continue;
    const pkg = readJson(path.join(dir, 'package.json')) ?? {};
    packages.set(dir, pkg);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) queue.push([dependency, dir]);
  }

  const findings = [];
  for (const [dir, pkg] of packages) {
    // Only a dependency of type "module" can turn a require() into this problem.
    const suspects = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter((name) => {
      const dependency = packageDir(name, dir);
      return dependency && packages.get(dependency)?.type === 'module';
    });
    if (suspects.length === 0) continue;
    const seen = new Set();
    for (const file of scriptsOf(dir)) {
      if (isEsModule(file)) continue; // an ES module imports; it cannot call require()
      const source = fs.readFileSync(file, 'utf8');
      for (const [, , specifier] of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
        if (seen.has(specifier) || !suspects.some((name) => specifier === name || specifier.startsWith(`${name}/`))) continue;
        let target;
        try {
          target = createRequire(file).resolve(specifier);
        } catch {
          continue; // not installed, or not offered to require(): no ES module gets loaded
        }
        if (!isEsModule(target)) continue;
        seen.add(specifier);
        findings.push({ package: pkg.name ?? path.basename(dir), file: path.relative(dir, file), requires: specifier });
      }
    }
  }
  return findings.sort((a, b) => a.package.localeCompare(b.package) || a.requires.localeCompare(b.requires));
}

/** Whether NODE_OPTIONS switches require() of ES modules on (the spelling Vercel documents, or Node's newer one). */
export function allowsRequireOfEsModules(nodeOptions = process.env.NODE_OPTIONS ?? '') {
  return /(^|\s)--(experimental-)?require-module(\s|$)/.test(nodeOptions);
}
