import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostAccumulator } from '../../src/analysis/cost.js';
import { newStats } from '../../src/io/jsonl.js';
import type { RequestEvent, Usage } from '../../src/model.js';
import { parseClaudeThread } from '../../src/parse/claude.js';
import { loadPriceTable, type PriceTable } from '../../src/prices/table.js';

const FIX = path.resolve('test/fixtures/claude');
const SESSION = '7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5';
const AGENT = '71c7d308f94630cb0';
const MAX = 1 << 26;

async function feed(acc: CostAccumulator, file: string, threadId: string, parent: string | null): Promise<void> {
  const { events } = parseClaudeThread(file, { threadId, parentThreadId: parent, spawnedByCallId: null, maxLineBytes: MAX }, newStats());
  for await (const e of events) {
    if (e.kind === 'request') acc.add(e);
    else if (e.kind === 'harness_cost') acc.addHarnessCost(e.totalCostUSD);
  }
}

async function costOf(rel: string, opts: { withSubagents?: boolean } = {}) {
  const prices = await loadPriceTable(null);
  const acc = new CostAccumulator(prices);
  await feed(acc, path.join(FIX, rel), 'main', null);
  if (opts.withSubagents) {
    await feed(acc, path.join(FIX, 'compaction-subagent', SESSION, 'subagents', `agent-${AGENT}.jsonl`), AGENT, 'main');
  }
  return acc.result();
}

const PRICES: PriceTable = new Map([
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4, source: 'https://x', retrieved: '2026-11-02' }],
]);

let n = 0;
function req(model: string, usage: Usage | null): RequestEvent {
  n++;
  return { kind: 'request', threadId: 'main', seq: n, ts: '', requestId: `r${n}`, model, usage, cwd: null, gitBranch: null };
}
const U = (o: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o });

describe('CostAccumulator on fixtures', () => {
  it('matches Claude Code cost-state within 1% on the basic fixture', async () => {
    const s = await costOf('basic-2.1.316.jsonl');
    expect(s.requestsUnpriced).toBe(0);
    expect(s.harnessUSD).not.toBeNull();
    expect(Math.abs(s.usd - s.harnessUSD!) / s.harnessUSD!).toBeLessThan(0.01);
    expect(s.priceMismatch).toBe(false);
    expect(s.unloggedUSD).toBe(0);
  });
  it('reports the compaction call as unlogged cost', async () => {
    const s = await costOf(`compaction-subagent/${SESSION}.jsonl`, { withSubagents: true });
    expect(s.requestsUnpriced).toBe(0);
    expect(s.unloggedUSD!).toBeGreaterThan(0);
    expect(s.priceMismatch).toBe(false);
  });
});

describe('CostAccumulator', () => {
  it('lists unpriced models and counts missing usage', () => {
    const acc = new CostAccumulator(PRICES);
    acc.add(req('claude-sonnet-5-5', U({ input: 1e6 })));
    acc.add(req('claude-future-9', U({ input: 1e6 })));
    acc.add(req('claude-future-9', U({ input: 1 })));
    acc.add(req('claude-sonnet-5-5', null));
    const s = acc.result();
    expect(s.usd).toBeCloseTo(2);
    expect(s.requests).toBe(4);
    expect(s.requestsUnpriced).toBe(2);
    expect(s.requestsMissingUsage).toBe(1);
    expect(s.unpricedModels).toEqual(['claude-future-9']);
    expect(s.byModel.get('claude-future-9')!.usage.input).toBe(1e6 + 1);
    expect(s.byModel.get('claude-sonnet-5-5')!.usd).toBeCloseTo(2);
    expect(s.harnessUSD).toBeNull();
    expect(s.unloggedUSD).toBeNull();
  });
  it('cacheHitShare = cacheRead / all prompt tokens', () => {
    const acc = new CostAccumulator(PRICES);
    acc.add(req('claude-sonnet-5-5', U({ input: 10, cacheRead: 60, cacheWrite5m: 20, cacheWrite1h: 10, output: 999 })));
    acc.add(req('claude-sonnet-5-5', U({ input: 0, cacheRead: 100 })));
    expect(acc.result().cacheHitShare).toBeCloseTo(160 / 200);
    expect(new CostAccumulator(PRICES).result().cacheHitShare).toBeNull();
  });
  it('harnessUSD sums the last value of each Claude Code process (a drop starts a new one)', () => {
    const acc = new CostAccumulator(PRICES);
    for (const v of [0.1, 0.3, 0.05, 0.2]) acc.addHarnessCost(v);
    expect(acc.result().harnessUSD).toBeCloseTo(0.5);
  });
  it('unlogged cost is null when a request is unpriced or has no usage', () => {
    const acc = new CostAccumulator(PRICES);
    acc.add(req('claude-future-9', U({ input: 1 })));
    acc.addHarnessCost(1);
    expect(acc.result().unloggedUSD).toBeNull();
  });
  it('a small negative gap shows as 0, a large one flags a price mismatch', () => {
    const near = new CostAccumulator(PRICES);
    near.add(req('claude-sonnet-5-5', U({ input: 1e6 }))); // $2
    near.addHarnessCost(1.99);
    expect(near.result()).toMatchObject({ unloggedUSD: 0, priceMismatch: false });
    const far = new CostAccumulator(PRICES);
    far.add(req('claude-sonnet-5-5', U({ input: 1e6 })));
    far.addHarnessCost(1.5);
    const s = far.result();
    expect(s.priceMismatch).toBe(true);
    expect(s.unloggedUSD).toBeCloseTo(-0.5);
  });
});

describe('CostAccumulator: modifiers and approximate writes (review fixes 4-6)', () => {
  const T2: PriceTable = new Map([
    ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, source: 'https://x', retrieved: 'd', fast: { input: 8, output: 40 }, usGeoMultiplier: 1.1 }],
    ['claude-sonnet-4-5', { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, source: 'https://x', retrieved: 'd' }],
    ['gpt-5.5', { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 5, cacheWrite1h: 5, source: 'https://x', retrieved: 'd', writesApproximate: true }],
  ]);
  const u = (o: Partial<Usage> = {}): Usage => ({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 0, ...o });
  it('prices fast mode with the fast rates, cache multipliers on top', () => {
    const acc = new CostAccumulator(T2);
    acc.add(req('claude-opus-5-5', u({ speed: 'fast' })));
    expect(acc.result().usd).toBeCloseTo(8 + 40 + 0.4 + 10);
  });
  it('applies the US inference_geo multiplier where the model has one', () => {
    const acc = new CostAccumulator(T2);
    acc.add(req('claude-opus-5-5', u({ inferenceGeo: 'us' })));
    acc.add(req('claude-opus-5-5', u({ inferenceGeo: 'global' })));
    expect(acc.result().usd).toBeCloseTo((4 + 20 + 0.2 + 5) * 2.1);
  });
  it('a modifier the table cannot price is an unpriced modifier, never unlogged harness cost', () => {
    const acc = new CostAccumulator(T2);
    acc.add(req('claude-sonnet-4-5', u({ speed: 'fast' })));
    acc.add(req('claude-opus-5-5', u({ inferenceGeo: 'eu' })));
    acc.add(req('claude-opus-5-5', u()));
    acc.addHarnessCost(1000);
    const r = acc.result();
    expect(r.requestsUnpricedModifier).toBe(2);
    expect(r.unpricedModifiers).toEqual(['claude-opus-5-5 inference_geo=eu', 'claude-sonnet-4-5 speed=fast']);
    expect(r.usd).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(r.unloggedUSD).toBeNull();
  });
  it('counts requests whose cache writes are priced from an approximate rate', () => {
    const acc = new CostAccumulator(T2);
    acc.add(req('gpt-5.5', u()));
    acc.add(req('gpt-5.5', u({ cacheWrite5m: 0 })));
    expect(acc.result().requestsApproxWritePrice).toBe(1);
  });
});
