import { describe, expect, it } from 'vitest';
import { compare, percentile } from '../../src/aggregate/compare.js';
import type { PrRow } from '../../src/attribution/attribute.js';
import { fakeSession } from '../helpers/fake-session.js';

const sessionsWith = (o: { instructions: string[] }) =>
  o.instructions.map((h, i) =>
    fakeSession({
      sessionId: `s${i}`,
      startedAt: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      cost: { usd: i + 1 } as never,
      fingerprint: { instructions: h, skills: '-', hooks: '-', mcp: '-', systemPrompt: '-', model: 'm', fingerprint: `f${h}` },
      readTotals: { reads: 10, readTokens: 1000, unreferenced: 2, unreferencedTokens: 250, unreferencedCarriedUSD: 0, rereads: 1, rereadsUnchanged: 1, rereadUnchangedTokens: 10, rereadsAfterCompaction: 0 },
    }),
  );
const prRow = (number: number, state: PrRow['state'], sessionIds: string[], sessionUsd?: number[]): PrRow => ({
  repo: '/r',
  number,
  state,
  usd: 1,
  attempts: sessionIds.length,
  attemptsNoEdit: 0,
  title: '',
  url: '',
  sessionIds,
  sessionUsd: sessionUsd ?? sessionIds.map((id) => Number(id.slice(1)) + 1),
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2], 0.5)).toBe(1);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('compare', () => {
  it('groups by instructions hash and hides medians below 5 sessions', () => {
    const rows = compare(sessionsWith({ instructions: ['aaa', 'aaa', 'aaa', 'aaa', 'aaa', 'bbb'] }), [], { by: 'instructions', splitAt: null, outcome: 'any' });
    expect(rows.find((r) => r.group === 'bbb')).toMatchObject({ sessions: 1, tooFew: true, medianUsd: null, p90Usd: null });
    const a = rows.find((r) => r.group === 'aaa')!;
    expect(a).toMatchObject({ sessions: 5, tooFew: false, medianUsd: 3, p90Usd: 5 });
    expect(a.unreferencedTokenShare).toBeCloseTo(0.25);
    expect(a.rereadRate).toBeCloseTo(0.1);
  });
  it('--split-at groups into before and on-or-after, with labels that differ in their first word', () => {
    const rows = compare(sessionsWith({ instructions: ['a', 'a', 'a', 'b', 'b', 'b'] }), [], { by: null, splitAt: '2026-10-13T00:00:00Z', outcome: 'any' });
    expect(rows.map((r) => [r.group, r.sessions])).toEqual([
      ['before 2026-10-13', 3],
      ['on or after 2026-10-13', 3],
    ]);
  });
  it('--split-at at a time of day keeps the time in the labels', () => {
    const rows = compare(sessionsWith({ instructions: ['a', 'a', 'a', 'b', 'b', 'b'] }), [], { by: null, splitAt: '2026-10-13T14:30:00.000Z', outcome: 'any' });
    expect(rows.map((r) => r.group)).toEqual(['before 2026-10-13 14:30Z', 'on or after 2026-10-13 14:30Z']);
  });
  it('--outcome merged keeps only sessions attributed to merged PRs', () => {
    const s = sessionsWith({ instructions: ['a', 'a', 'a', 'a', 'a', 'a'] });
    const prs = [prRow(1, 'merged', ['s0', 's1']), prRow(2, 'closedUnmerged', ['s2']), prRow(3, 'merged', ['s3'])];
    const rows = compare(s, prs, { by: 'instructions', splitAt: null, outcome: 'merged' });
    expect(rows).toEqual([expect.objectContaining({ group: 'a', sessions: 3, tooFew: true })]);
  });
  it('median cost per merged PR sums the group sessions of each merged PR', () => {
    const s = sessionsWith({ instructions: ['a', 'a', 'a', 'a', 'a'] }); // usd 1..5
    const prs = [prRow(1, 'merged', ['s0', 's1']), prRow(2, 'merged', ['s2']), prRow(3, 'merged', ['s3', 's4'])];
    const [row] = compare(s, prs, { by: 'instructions', splitAt: null, outcome: 'any' });
    expect(row!.medianUsdPerMergedPr).toBe(3); // 3, 3, 9
  });
  it('median cost per merged PR uses the cost attributed to the PR, not whole sessions (review 7-8, ruling 5)', () => {
    const s = sessionsWith({ instructions: ['a', 'a', 'a', 'a', 'a'] }); // whole-session usd 1..5
    const prs = [prRow(1, 'merged', ['s0', 's1'], [0.5, 0.5]), prRow(2, 'merged', ['s2'], [0.25]), prRow(3, 'merged', ['s3', 's4'], [1, 1])];
    const [row] = compare(s, prs, { by: 'instructions', splitAt: null, outcome: 'any' });
    expect(row!.medianUsdPerMergedPr).toBe(1); // 1, 0.25, 2
  });
});
