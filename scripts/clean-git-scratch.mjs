#!/usr/bin/env node
// Removes leftover `read-receipts-git-*` scratch dirs from the temp directory. Since the 7-8 review
// round each git call removes its own dir; older versions kept one per process until it exited, and
// vitest workers never fire 'exit', so they piled up.
//
//   node scripts/clean-git-scratch.mjs [--dir <temp dir>]

import { readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const i = process.argv.indexOf('--dir');
const dir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : os.tmpdir();
let removed = 0;
for (const e of readdirSync(dir, { withFileTypes: true })) {
  if (e.isDirectory() && e.name.startsWith('read-receipts-git-')) {
    rmSync(path.join(dir, e.name), { recursive: true, force: true });
    removed++;
  }
}
process.stdout.write(`removed ${removed} read-receipts-git-* ${removed === 1 ? 'dir' : 'dirs'} from ${dir}\n`);
