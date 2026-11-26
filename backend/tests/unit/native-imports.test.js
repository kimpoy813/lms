// Vite can transform imports in a way that does not enforce every named ESM export. Vercel's
// runtime uses Node's linker, which does; check the whole backend entry graph with native Node so
// a missing export cannot turn a successful test/build into a function startup failure.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

it('loads the backend application with Node’s native ESM linker', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/app.js')"], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
});
