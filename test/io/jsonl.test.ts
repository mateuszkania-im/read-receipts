import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newStats, streamJsonl } from '../../src/io/jsonl.js';

async function tmpFile(content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rr-jsonl-'));
  const f = path.join(dir, 'f.jsonl');
  await writeFile(f, content);
  return f;
}

async function readAll(f: string, maxLineBytes: number, stats = newStats()): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const r of streamJsonl(f, { maxLineBytes }, stats)) out.push(r);
  return out;
}

describe('streamJsonl', () => {
  it('yields parsed objects and counts a truncated last line as bad', async () => {
    const f = await tmpFile('{"a":1}\n{"b":2}\n{"c":');
    const stats = newStats();
    const out = await readAll(f, 1 << 20, stats);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stats).toMatchObject({ lines: 3, badLines: 1 });
  });

  it('skips lines longer than maxLineBytes and counts them', async () => {
    const f = await tmpFile(`{"x":"${'y'.repeat(2000)}"}\n{"ok":true}\n`);
    const stats = newStats();
    const out = await readAll(f, 1000, stats);
    expect(out).toEqual([{ ok: true }]);
    expect(stats.longLines).toBe(1);
    expect(stats.badLines).toBe(0);
  });

  it('skips an over-long line that spans many read chunks', async () => {
    const f = await tmpFile(`{"ok":1}\n{"x":"${'y'.repeat(300_000)}"}\n{"ok":2}`);
    const stats = newStats();
    expect(await readAll(f, 1000, stats)).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(stats).toMatchObject({ lines: 3, longLines: 1, badLines: 0 });
  });

  it('handles CRLF and a UTF-8 BOM', async () => {
    const f = await tmpFile('\uFEFF{"a":1}\r\n{"b":2}\r\n');
    const stats = newStats();
    expect(await readAll(f, 1 << 20, stats)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stats.badLines).toBe(0);
  });

  it('counts non-object JSON values as bad lines', async () => {
    const f = await tmpFile('[1,2]\n42\nnull\n"s"\n{"a":1}\n');
    const stats = newStats();
    expect(await readAll(f, 1 << 20, stats)).toEqual([{ a: 1 }]);
    expect(stats).toMatchObject({ lines: 5, badLines: 4 });
  });

  it('ignores blank lines and keeps multi-byte UTF-8 intact', async () => {
    const f = await tmpFile('\n{"s":"zażółć ✓"}\n\n');
    const stats = newStats();
    expect(await readAll(f, 1 << 20, stats)).toEqual([{ s: 'zażółć ✓' }]);
    expect(stats).toMatchObject({ lines: 1, badLines: 0 });
  });
});
