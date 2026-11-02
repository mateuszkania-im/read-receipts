// A SessionResult with neutral defaults, for attribution and compare tests.

import type { SessionResult } from '../../src/analyze-session.js';

export function fakeSession(over: Partial<SessionResult> & { sessionId: string }): SessionResult {
  const usd = over.cost?.usd ?? (over.branchSpans ?? []).reduce((s, r) => s + (r.usd ?? 0), 0);
  return {
    agent: 'claude-code',
    startedAt: over.branchSpans?.[0]?.ts ?? '2026-10-01T00:00:00.000Z',
    endedAt: over.branchSpans?.at(-1)?.ts ?? '2026-10-01T00:00:00.000Z',
    cwd: '/r',
    entrypoint: 'cli',
    version: '2.1.316',
    branchSpans: [],
    reads: [],
    readTotals: { reads: 0, readTokens: 0, unreferenced: 0, unreferencedTokens: 0, unreferencedCarriedUSD: 0, rereads: 0, rereadsUnchanged: 0, rereadUnchangedTokens: 0, rereadsAfterCompaction: 0 },
    compactions: 0,
    compactionRereads: { readBefore: 0, rereadUnchangedAfter: 0, reattachedThenReread: 0 },
    composition: { sources: new Map(), exactPromptFirst: null, exactPromptTotal: 0, unattributedFirst: null, lateSources: [] },
    fingerprint: { instructions: '-', skills: '-', hooks: '-', mcp: '-', systemPrompt: '-', model: '-', fingerprint: '-' },
    subagents: [],
    edits: 1,
    explicitPrs: [],
    stats: { lines: 0, badLines: 0, skippedRecords: 0, longLines: 0, deepValues: 0 },
    gitRoot: null,
    ...over,
    cost: {
      usd,
      requests: 1,
      requestsMissingUsage: 0,
      requestsUnpriced: 0,
      unpricedModels: [],
      requestsUnpricedModifier: 0,
      unpricedModifiers: [],
      requestsApproxWritePrice: 0,
      byModel: new Map(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      cacheHitShare: null,
      harnessUSD: null,
      unloggedUSD: null,
      priceMismatch: false,
      ...over.cost,
    },
  };
}
