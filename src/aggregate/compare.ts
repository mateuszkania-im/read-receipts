// Spec 6.7: compare sessions grouped by a harness component, or before and after a date.

import type { SessionResult } from '../analyze-session.js';
import type { Fingerprint } from '../analysis/fingerprint.js';
import type { PrRow } from '../attribution/attribute.js';

export interface CompareRow {
  group: string;
  sessions: number;
  /** Fewer than MIN_GROUP sessions: medians and p90 are hidden. */
  tooFew: boolean;
  medianUsd: number | null;
  p90Usd: number | null;
  medianUsdPerMergedPr: number | null;
  unreferencedTokenShare: number | null;
  rereadRate: number | null;
  compactionRereadRate: number | null;
  cacheHitShare: number | null;
}

export interface CompareOptions {
  by: keyof Fingerprint | null;
  splitAt: string | null;
  outcome: 'merged' | 'any';
}

export const MIN_GROUP = 5;

/** Nearest-rank percentile: the value at rank ceil(p × n) of the sorted values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** `2026-10-13`, or `2026-10-13 14:30Z` when the split is not at midnight UTC. */
function splitLabel(iso: string): string {
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time === '' || time === '00:00' ? day : `${day} ${time}Z`;
}

function groupOf(s: SessionResult, opts: CompareOptions): string {
  if (opts.splitAt !== null) {
    const at = splitLabel(opts.splitAt);
    return s.startedAt < opts.splitAt ? `before ${at}` : `on or after ${at}`;
  }
  return s.fingerprint[opts.by ?? 'fingerprint'];
}

export function compare(sessions: SessionResult[], prs: PrRow[], opts: CompareOptions): CompareRow[] {
  const merged = prs.filter((p) => p.state === 'merged');
  const inMerged = new Set(merged.flatMap((p) => p.sessionIds));
  const kept = opts.outcome === 'merged' ? sessions.filter((s) => inMerged.has(s.sessionId)) : sessions;

  const groups = new Map<string, SessionResult[]>();
  for (const s of kept) {
    const g = groupOf(s, opts);
    const list = groups.get(g) ?? [];
    list.push(s);
    groups.set(g, list);
  }

  const order = opts.splitAt !== null ? (a: string) => (a.startsWith('before') ? 0 : 1) : () => 0;
  return [...groups]
    .sort(([a, x], [b, y]) => order(a) - order(b) || y.length - x.length || (a < b ? -1 : 1))
    .map(([group, list]) => {
      const tooFew = list.length < MIN_GROUP;
      const usd = list.map((s) => s.cost.usd);
      // Spec 6.6: the cost attributed to each merged PR by this group's sessions, not their whole cost.
      const inGroup = new Set(list.map((s) => s.sessionId));
      const perPr = merged
        .filter((p) => p.sessionIds.some((id) => inGroup.has(id)))
        .map((p) => p.sessionIds.reduce((sum, id, i) => (inGroup.has(id) ? sum + (p.sessionUsd[i] ?? 0) : sum), 0));
      let readTokens = 0;
      let unrefTokens = 0;
      let reads = 0;
      let rereads = 0;
      let before = 0;
      let after = 0;
      let cacheRead = 0;
      let prompt = 0;
      for (const s of list) {
        readTokens += s.readTotals.readTokens;
        unrefTokens += s.readTotals.unreferencedTokens;
        reads += s.readTotals.reads;
        rereads += s.readTotals.rereads;
        before += s.compactionRereads.readBefore;
        after += s.compactionRereads.rereadUnchangedAfter;
        const u = s.cost.usage;
        cacheRead += u.cacheRead;
        prompt += u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
      }
      return {
        group,
        sessions: list.length,
        tooFew,
        medianUsd: tooFew ? null : percentile(usd, 0.5),
        p90Usd: tooFew ? null : percentile(usd, 0.9),
        medianUsdPerMergedPr: tooFew ? null : percentile(perPr, 0.5),
        unreferencedTokenShare: ratio(unrefTokens, readTokens),
        rereadRate: ratio(rereads, reads),
        compactionRereadRate: ratio(after, before),
        cacheHitShare: ratio(cacheRead, prompt),
      };
    });
}
