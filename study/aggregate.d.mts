export interface AggregateTotals {
  runAt: string;
  toolVersion: string;
  sessions: number;
  requests: number;
  usd: number;
  usdLowerBound: boolean;
  harnessUSD: number | null;
  unloggedUSD: number | null;
  sessionsWithHarnessCost: number;
  cacheHitShare: number | null;
  reads: number | null;
  unreferencedReads: number | null;
  unreferencedReadRate: number | null;
  unreferencedTokenShare: number | null;
  unreferencedCarriedUSD: number | null;
  rereads: number | null;
  rereadsUnchanged: number | null;
  rereadRate: number | null;
  compactions: number;
  compactionRereadRate: number | null;
  subagents: number;
  subagentCostShare: number;
  compositionShares: Record<string, number>;
  entrypoints: Record<string, number>;
}
export function aggregateTotals(report: unknown): AggregateTotals;
