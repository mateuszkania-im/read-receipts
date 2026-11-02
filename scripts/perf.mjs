#!/usr/bin/env node
/**
 * `npm run perf`: the full local check (spec section 10). Generates a 1 GB synthetic corpus in the temp
 * directory, runs the perf test on it (1 GB under 60 s), then removes the corpus whatever the result.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const size = process.env.PERF_MB ?? '1024';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npx is a .cmd script on Windows, which only runs through a shell; the arguments are fixed strings.
const res = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.perf.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PERF_MB: size },
  shell: process.platform === 'win32',
});
spawnSync(process.execPath, [path.join(root, 'scripts', 'clean-perf-corpus.mjs')], { stdio: 'inherit' });
process.exit(res.status ?? 1);
