// oxlint-disable no-control-regex
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { sanitizeTerminal } from '../../src/report/sanitize.js';
import { renderTerminal } from '../../src/report/terminal.js';
import type { Report } from '../../src/report/types.js';
import { fixtureTree } from '../helpers/fixture-tree.js';
import { defaults } from '../helpers/report-defaults.js';

let sampleReport: Report;
beforeAll(async () => {
  const { claudeDir, codexDir } = await fixtureTree();
  sampleReport = await buildReport({ ...defaults, claudeDir, codexDir, compare: { by: 'model', splitAt: null, outcome: 'any' } });
});

const views = ['summary', 'sessions', 'prs', 'compare'] as const;

describe('renderTerminal', () => {
  it('prints estimated numbers with ≈ and never the word wasted, a dash or an arrow', () => {
    for (const view of views) {
      const out = renderTerminal(sampleReport, { color: false, width: 100, view });
      expect(out.toLowerCase()).not.toContain('wasted');
      expect(out).not.toMatch(/—|–|→|->|=>/);
    }
    expect(renderTerminal(sampleReport, { color: false, width: 100 })).toMatch(/≈/);
  });
  it('says "unreferenced", and explains it is not "wasted"', () => {
    const out = renderTerminal(sampleReport, { color: false, width: 100 });
    expect(out).toMatch(/unreferenced/);
    expect(out).toMatch(/not .*waste|rule something out/i);
  });
  it('shows a lower bound and names the unpriced models', () => {
    const out = renderTerminal(sampleReport, { color: false, width: 100 });
    expect(out).toMatch(/≥ \$/);
    expect(out).toMatch(/unpriced/);
    expect(out).toContain('gpt-5-codex');
  });
  it('the session view shows the reads table of one session', () => {
    const one: Report = { ...sampleReport, sessions: sampleReport.sessions.filter((s) => s.readCounts.total > 0).slice(0, 1) };
    const out = renderTerminal(one, { color: false, width: 100, view: 'session' });
    expect(out).toMatch(/Reads/);
    expect(out).toContain(one.sessions[0]!.sessionId);
  });
  it('strips escapes from log-derived strings everywhere', () => {
    const evil = '\u001b]8;;http://x\u0007click\u001b]8;;\u0007\u001b[2J';
    const r: Report = { ...sampleReport, sessions: sampleReport.sessions.map((s) => ({ ...s, cwd: evil, cost: { ...s.cost, unpricedModels: [evil] } })) };
    for (const view of views) expect(renderTerminal(r, { color: false, width: 100, view })).not.toMatch(/\u001b|\u0007/);
  });
  it('colour only when asked', () => {
    expect(renderTerminal(sampleReport, { color: false, width: 100 })).not.toMatch(/\u001b/);
    expect(renderTerminal(sampleReport, { color: true, width: 100 })).toMatch(/\u001b\[/);
  });
});

describe('sanitizeTerminal', () => {
  it('strips terminal escapes from log-derived strings', () => {
    expect(sanitizeTerminal('src/\u001b[31mevil\u0007.ts')).toBe('src/evil.ts');
  });
  it('strips OSC sequences, C1 controls, newlines and bidi overrides', () => {
    expect(sanitizeTerminal('a\u001b]0;title\u0007b\u009bc\nd‮e')).toBe('abcde');
  });
  it('strips U+2028 and U+2029 too (F9)', () => {
    expect(sanitizeTerminal('a\u2028b\u2029c')).toBe('abc');
  });
});

describe('unmerged spend (review 7-8, ruling 4)', () => {
  it('without --gh the summary says unmerged spend is unknown and shows the branch-level spend under a neutral label', () => {
    expect(sampleReport.options.gh).toBe(false);
    expect(sampleReport.totals.unmergedSpend).toBeNull();
    for (const view of ['summary', 'prs'] as const) {
      const out = renderTerminal(sampleReport, { color: false, width: 100, view });
      expect(out).toContain('unmerged spend: unknown without --gh');
      expect(out).toMatch(/spend on branches with no known PR\s+\$/);
    }
  });
  it('with --gh it prints the figure', () => {
    const r: Report = { ...sampleReport, options: { ...sampleReport.options, gh: true }, totals: { ...sampleReport.totals, unmergedSpend: 1.5 } };
    const out = renderTerminal(r, { color: false, width: 100 });
    expect(out).toMatch(/unmerged spend\s+\$1\.50/);
    expect(out).not.toContain('unknown without --gh');
  });
});

describe('compare table (final review C3)', () => {
  const row = (group: string, sessions = 6) => ({
    group,
    sessions,
    tooFew: false,
    medianUsd: 1.23,
    p90Usd: 4.56,
    medianUsdPerMergedPr: 7.89,
    unreferencedTokenShare: 0.25,
    rereadRate: 0.05,
    compactionRereadRate: 0.1,
    cacheHitShare: 0.9,
  });
  const withRows = (groups: string[]): Report => ({ ...sampleReport, compare: groups.map((g) => row(g)) });

  it('shows 12-hex fingerprints whole at width 100 (piped output)', () => {
    const out = renderTerminal(withRows(['a1b2c3d4e5f6', '0f9e8d7c6b5a']), { color: false, width: 100, view: 'compare' });
    expect(out).toContain('a1b2c3d4e5f6');
    expect(out).toContain('0f9e8d7c6b5a');
    expect(out).not.toContain('...');
  });
  it('gives --split-at groups distinct, whole labels', () => {
    const out = renderTerminal(withRows(['before 2026-10-25', 'on or after 2026-10-25']), { color: false, width: 100, view: 'compare' });
    expect(out).toContain('before 2026-10-25');
    expect(out).toContain('on or after 2026-10-25');
  });
  it('never cuts a group key below 20 characters; a key too long for the line is shortened in the middle', () => {
    const long = `instructions-${'x'.repeat(150)}-tail1234`;
    const out = renderTerminal(withRows([long, 'short']), { color: false, width: 60, view: 'compare' });
    expect(out).toContain('instructions-');
    expect(out).toContain('-tail1234');
    expect(out).toMatch(/instructions-x+…x+-tail1234/);
    for (const line of out.split('\nNotes')[0]!.split('\n')) expect(line.length, line).toBeLessThanOrEqual(100);
    const shown = /(instructions-x+…x+-tail1234)/.exec(out)![1]!;
    expect(shown.length).toBeGreaterThanOrEqual(20);
  });
});

describe('plurals and alignment (final review C11)', () => {
  const one = (): Report => {
    const s = sampleReport.sessions.find((x) => x.readCounts.total > 0)!;
    return {
      ...sampleReport,
      sessions: [{ ...s, cost: { ...s.cost, requests: 1 }, readCounts: { ...s.readCounts, total: 1, unreferenced: 1, rereads: 1, rereadsUnchanged: 1 } }],
      totals: { ...sampleReport.totals, sessions: 1, requests: 1, readCounts: { total: 1, unreferenced: 1, rereads: 1, rereadsUnchanged: 1, rereadsAfterCompaction: 1 }, harnessUSD: 0.04, unloggedUSD: 0.01 },
    };
  };
  it('says "1 session", "1 request", "1 read", "1 re-read"', () => {
    const r = one();
    for (const view of ['summary', 'sessions', 'session'] as const) {
      const out = renderTerminal(r, { color: false, width: 100, view });
      expect(out, view).not.toMatch(/\b1 (sessions|requests|reads|re-reads)\b/);
    }
    const sum = renderTerminal(r, { color: false, width: 100 });
    expect(sum).toMatch(/\b1 session\b/);
    expect(sum).toMatch(/\b1 re-read\b/);
  });
  it('aligns every value of the cost block in one column', () => {
    const out = renderTerminal(one(), { color: false, width: 100 });
    const block = out.split('\n\n').find((b) => b.startsWith('Cost'))!;
    const labels = ['total', "Claude Code's own total", 'unlogged harness calls', 'spend on branches with no known PR'];
    const cols = labels.map((l) => {
      const line = block.split('\n').find((x) => x.trimStart().startsWith(l))!;
      expect(line, l).toBeDefined();
      const end = line.indexOf(l) + l.length;
      return end + line.slice(end).search(/\S/);
    });
    expect(new Set(cols).size, block).toBe(1);
  });
});

describe('the unreferenced definition shown to users (final review C6)', () => {
  it('lists every rule, test titles, the module under test and path suffixes included, with a link to spec 6.3', () => {
    const out = renderTerminal(sampleReport, { color: false, width: 100 });
    const footer = out.slice(out.indexOf('How to read this'));
    for (const rule of [/edit of the file/, /full path/, /path suffix|end of its path/, /basename/, /identifier declared in it/, /test title/, /module under test/, /spec 6\.3/]) {
      expect(footer).toMatch(rule);
    }
    expect(footer).toContain('docs/superpowers/specs/2026-11-01-agent-ledger-design.md#63-reads-and-unreferenced-reads');
    expect(sampleReport.definitions.unreferenced).toMatch(/test title/);
    expect(sampleReport.definitions.unreferenced).toMatch(/module under test/);
  });
});
