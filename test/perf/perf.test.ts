// Throughput of the streaming pipeline on a generated corpus (spec section 10). The default run uses
// 64 MB (CI); `npm run perf` sets PERF_MB=1024 and also checks the 60 s budget. The corpus is written
// to the temp directory, never the repository, and removed afterwards.

import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { defaults } from '../helpers/report-defaults.js';
// @ts-expect-error: plain .mjs script without types
import { generate } from '../../scripts/gen-perf-corpus.mjs';

const MB = Number(process.env.PERF_MB ?? '64');
const dir = path.join(os.tmpdir(), 'read-receipts-perf', `test-${MB}-${process.pid}`);
let corpus: { claudeDir: string; bytes: number; sessions: number };

beforeAll(async () => {
  corpus = await generate(MB, dir);
}, 600_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

export async function timeBuildReport(claudeDir: string): Promise<{ ms: number; sessions: number }> {
  const t0 = performance.now();
  const r = await buildReport({ ...defaults, claudeDir, codexDir: null });
  return { ms: performance.now() - t0, sessions: r.sessions.length };
}

describe(`perf (${MB} MB)`, () => {
  it(`parses a generated ${MB} MB corpus at more than 17 MB/s${MB >= 1024 ? ' and in under 60 s' : ''}`, async () => {
    const { ms, sessions } = await timeBuildReport(corpus.claudeDir);
    const mbps = corpus.bytes / 1024 / 1024 / (ms / 1000);
    console.log(`perf: ${(corpus.bytes / 1024 / 1024).toFixed(0)} MB, ${sessions} sessions, ${(ms / 1000).toFixed(2)} s, ${mbps.toFixed(1)} MB/s, rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
    expect(sessions).toBe(corpus.sessions);
    expect(mbps).toBeGreaterThan(17);
    if (MB >= 1024) expect(ms).toBeLessThan(60_000);
  }, 600_000);
});
