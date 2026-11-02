// Review 7-8, rulings 9 and 10: the perf runner works on Windows, and leftover git scratch dirs can be removed.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from '../helpers/synth.js';

describe('scripts/perf.mjs', () => {
  it('resolves its own path with fileURLToPath and runs npx through a shell on Windows', async () => {
    const src = await readFile('scripts/perf.mjs', 'utf8');
    expect(src).toContain('fileURLToPath(import.meta.url)');
    expect(src).not.toContain('new URL(import.meta.url).pathname');
    expect(src).toMatch(/shell: process\.platform === 'win32'/);
  });
});

describe('scripts/clean-git-scratch.mjs', () => {
  it('removes read-receipts-git-* dirs and nothing else', async () => {
    const t = await tmpDir('rr-clean-');
    await mkdir(path.join(t, 'read-receipts-git-abc', 'no-hooks'), { recursive: true });
    await mkdir(path.join(t, 'read-receipts-git-def'));
    await mkdir(path.join(t, 'keep-me'));
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ['scripts/clean-git-scratch.mjs', '--dir', t], (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
    expect(fs.readdirSync(t)).toEqual(['keep-me']);
    expect(out).toMatch(/removed 2/);
  });
});
