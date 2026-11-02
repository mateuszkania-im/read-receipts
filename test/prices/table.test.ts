import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPriceTable, lookupPrice, requestCost, type ModelPrice } from '../../src/prices/table.js';

const p: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, source: 's', retrieved: 'd' };
const u = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };

describe('requestCost', () => {
  it('applies the spec formula', () => {
    expect(requestCost(u, p)).toBeCloseTo(28.05);
  });
  it('returns null for missing usage or unknown price', () => {
    expect(requestCost(null, p)).toBeNull();
    expect(requestCost(u, null)).toBeNull();
  });
  it('uses the long-context tier when the whole prompt is over the threshold', () => {
    const tiered: ModelPrice = {
      ...p,
      longContext: { aboveInputTokens: 100_000, input: 6, output: 30, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12 },
    };
    const small = { input: 10_000, output: 0, cacheRead: 90_000, cacheWrite5m: 0, cacheWrite1h: 0 };
    const big = { ...small, cacheWrite5m: 1 };
    expect(requestCost(small, tiered)).toBeCloseTo((10_000 * 3 + 90_000 * 0.3) / 1e6);
    expect(requestCost(big, tiered)).toBeCloseTo((10_000 * 6 + 90_000 * 0.6 + 7.5) / 1e6);
  });
});

describe('lookupPrice', () => {
  const a = { ...p, output: 1 };
  const b = { ...p, output: 2 };
  it('matches by exact id, then longest prefix', () => {
    const t = new Map([
      ['claude-sonnet', a],
      ['claude-sonnet-5-5', b],
    ]);
    expect(lookupPrice(t, 'claude-sonnet-5-5')).toBe(b);
    expect(lookupPrice(t, 'claude-sonnet-5-5-20261101')).toBe(b);
    expect(lookupPrice(t, 'gpt-unknown')).toBeNull();
  });
  it('a prefix must end at a separator, so gpt-5 does not price gpt-5.9', () => {
    const t = new Map([['gpt-5', a]]);
    expect(lookupPrice(t, 'gpt-5.9')).toBeNull();
    expect(lookupPrice(t, 'gpt-50')).toBeNull();
  });
  it('a prefix stops at a version boundary: claude-opus-4 does not price claude-opus-4-9', () => {
    const t = new Map([
      ['claude-opus-4', a],
      ['gpt-5', b],
    ]);
    expect(lookupPrice(t, 'claude-opus-4-9')).toBeNull();
    expect(lookupPrice(t, 'claude-opus-4-9-20261101')).toBeNull();
    expect(lookupPrice(t, 'gpt-5-mini')).toBeNull();
    expect(lookupPrice(t, 'gpt-5-codex')).toBeNull();
    expect(lookupPrice(t, 'claude-opus-4-sonnet')).toBeNull();
  });
  it('a prefix still matches date, context and provider-version suffixes', () => {
    const t = new Map([
      ['claude-opus-4', a],
      ['gpt-5', b],
    ]);
    expect(lookupPrice(t, 'claude-opus-4-20250514')).toBe(a);
    expect(lookupPrice(t, 'claude-opus-4@20250514')).toBe(a);
    expect(lookupPrice(t, 'claude-opus-4[1m]')).toBe(a);
    expect(lookupPrice(t, 'claude-opus-4-20250514-v1:0')).toBe(a);
    expect(lookupPrice(t, 'claude-opus-4-latest')).toBe(a);
    expect(lookupPrice(t, 'gpt-5-2025-08-07')).toBe(b);
  });
  it('the default table leaves unknown siblings unpriced instead of guessing', async () => {
    const t = await loadPriceTable(null);
    for (const m of ['claude-opus-4-9', 'claude-sonnet-4-7', 'gpt-5-codex', 'gpt-5.9', '<synthetic>']) expect(lookupPrice(t, m), m).toBeNull();
    expect(lookupPrice(t, 'claude-opus-4-20250514')).toBe(t.get('claude-opus-4'));
  });
  it("matches Claude Code's context suffix such as [1m]", () => {
    expect(lookupPrice(new Map([['claude-opus-5-5', b]]), 'claude-opus-5-5[1m]')).toBe(b);
  });
});

describe('loadPriceTable', () => {
  it('override file merges over defaults', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-prices-'));
    const f = path.join(dir, 'p.json');
    await writeFile(
      f,
      JSON.stringify({
        'claude-sonnet-5-5': { output: 99 },
        'my-local-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1, cacheWrite1h: 1 },
      }),
    );
    const defaults = await loadPriceTable(null);
    const t = await loadPriceTable(f);
    const s = t.get('claude-sonnet-5-5')!;
    expect(s.output).toBe(99);
    expect(s.input).toBe(defaults.get('claude-sonnet-5-5')!.input);
    expect(s.source).toBe(f);
    expect(t.get('my-local-model')).toMatchObject({ input: 1, output: 2, source: f });
    expect(t.size).toBe(defaults.size + 1);
  });
  it('rejects an override with a non-numeric or negative price', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-prices-'));
    const f = path.join(dir, 'p.json');
    await writeFile(f, JSON.stringify({ 'claude-sonnet-5-5': { output: '9' } }));
    await expect(loadPriceTable(f)).rejects.toThrow(/output/);
    await writeFile(f, JSON.stringify({ 'claude-sonnet-5-5': { input: -1 } }));
    await expect(loadPriceTable(f)).rejects.toThrow(/input/);
  });
  it('a new model in an override needs every price field', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-prices-'));
    const f = path.join(dir, 'p.json');
    await writeFile(f, JSON.stringify({ 'brand-new': { input: 1 } }));
    await expect(loadPriceTable(f)).rejects.toThrow(/brand-new/);
  });
  it('every default entry has a source URL and a retrieved date', async () => {
    const t = await loadPriceTable(null);
    expect(t.size).toBeGreaterThan(0);
    for (const [, q] of t) {
      expect(q.source).toMatch(/^https:\/\//);
      expect(q.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('defaults price every model id in the fixtures that a vendor page lists', async () => {
    const t = await loadPriceTable(null);
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-20250514', 'gpt-6-astra']) {
      expect(lookupPrice(t, m), m).not.toBeNull();
    }
    expect(lookupPrice(t, 'claude-haiku-5-5')!.longContext?.aboveInputTokens).toBe(100_000);
    expect(lookupPrice(t, 'gpt-6-astra')!.longContext?.aboveInputTokens).toBe(272_000);
  });
});

describe('price table notes (review 7-8, ruling 7)', () => {
  it('does not call fast mode or the US data-residency multiplier unpriced', async () => {
    const { readFile } = await import('node:fs/promises');
    const about: string[] = JSON.parse(await readFile('src/prices/defaults.json', 'utf8')).about;
    const notPriced = about.find((l) => l.startsWith('Not priced')) ?? '';
    expect(notPriced).not.toMatch(/fast mode|inference_geo us/);
    expect(about.join('\n')).toMatch(/[Ff]ast mode.*priced/);
  });
});
