#!/usr/bin/env node
/** Removes every generated perf corpus (`<os tmpdir>/read-receipts-perf`). */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'read-receipts-perf');
await rm(dir, { recursive: true, force: true });
console.log(`removed ${dir}`);
