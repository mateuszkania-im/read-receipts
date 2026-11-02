// Security review F1: session-side files are opened only when they are regular files under a size cap.

import { execFileSync } from 'node:child_process';
import { cp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeSession } from '../../src/analyze-session.js';
import { readSmallRegularFile, META_MAX_BYTES } from '../../src/io/safe-read.js';
import { discoverSessions } from '../../src/io/discover.js';
import { loadPriceTable, type PriceTable } from '../../src/prices/table.js';
import { tmpDir } from '../helpers/synth.js';

const FIX = path.resolve('test/fixtures/claude/compaction-subagent');
const SESSION = '7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5';
const META = path.join(SESSION, 'subagents', 'agent-71c7d308f94630cb0.meta.json');
let prices: PriceTable;

beforeAll(async () => {
  prices = await loadPriceTable(null);
});

/** A copy of the subagent fixture whose meta.json is replaced by `make`. */
async function withMeta(make: (file: string) => Promise<void>) {
  const root = await tmpDir('rr-f1-');
  const project = path.join(root, 'proj');
  await cp(FIX, project, { recursive: true });
  const meta = path.join(project, META);
  await rm(meta);
  await make(meta);
  const [src] = await discoverSessions({ claudeDir: root, codexDir: null, sinceMs: null, agent: 'claude', includeSubagents: true });
  return src!;
}

const analyse = (src: Awaited<ReturnType<typeof withMeta>>) =>
  analyzeSession(src, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: async () => null });

describe('subagent meta.json (F1)', () => {
  it('a FIFO is skipped, not opened: the run finishes and the thread is analysed standalone', async () => {
    const src = await withMeta(async (f) => {
      execFileSync('mkfifo', [f]);
    });
    const s = await analyse(src);
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0]!.agentType).toBeNull();
  }, 5000);
  it('a symlink to /dev/zero is skipped', async () => {
    const src = await withMeta((f) => symlink('/dev/zero', f));
    const s = await analyse(src);
    expect(s.subagents[0]!.agentType).toBeNull();
  }, 5000);
  it('a meta file over the size cap is skipped', async () => {
    const src = await withMeta((f) => writeFile(f, JSON.stringify({ agentType: 'general-purpose', pad: 'x'.repeat(META_MAX_BYTES) })));
    const s = await analyse(src);
    expect(s.subagents[0]!.agentType).toBeNull();
  });
  it('a regular meta file under the cap is read', async () => {
    const src = await withMeta((f) => writeFile(f, JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_80OAjFJ8cDrAD1ItD70ibn9G', spawnDepth: 1 })));
    const s = await analyse(src);
    expect(s.subagents[0]!.agentType).toBe('general-purpose');
  });
});

describe('readSmallRegularFile', () => {
  it('returns null for a directory, a FIFO, a symlink and a missing file; the text for a small regular file', async () => {
    const dir = await tmpDir('rr-f1-');
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const file = path.join(dir, 'ok.json');
    await writeFile(file, '{"a":1}');
    const link = path.join(dir, 'link.json');
    await symlink(file, link);
    expect(await readSmallRegularFile(dir, 100)).toBeNull();
    expect(await readSmallRegularFile(fifo, 100)).toBeNull();
    expect(await readSmallRegularFile(link, 100)).toBeNull();
    expect(await readSmallRegularFile(path.join(dir, 'none'), 100)).toBeNull();
    expect(await readSmallRegularFile(file, 100)).toBe('{"a":1}');
    expect(await readSmallRegularFile(file, 3)).toBeNull();
  }, 5000);
});

describe('log files (F1)', () => {
  it('streamJsonl yields nothing from a FIFO or a symlink, without blocking', async () => {
    const { streamJsonl, newStats } = await import('../../src/io/jsonl.js');
    const dir = await tmpDir('rr-f1-');
    const fifo = path.join(dir, 'x.jsonl');
    execFileSync('mkfifo', [fifo]);
    const link = path.join(dir, 'zero.jsonl');
    await symlink('/dev/zero', link);
    for (const f of [fifo, link]) {
      const got: unknown[] = [];
      for await (const v of streamJsonl(f, { maxLineBytes: 1 << 20 }, newStats())) got.push(v);
      expect(got, f).toEqual([]);
    }
  }, 5000);
});
