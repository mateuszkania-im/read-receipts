import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateTotals } from '../../study/aggregate.mjs';
import { REPOS, readLabels, readPredictions, referencedReliability, renderAggregate, renderReadmeBlock, renderStudyScores, replaceBlock, score, staleBlocks, validateLabel, wilson, type Label } from '../../study/score.mjs';

const lab = (sessionHash: string, readOrdinal: number, label: Label['label']): Label => ({ sessionHash, readOrdinal, repo: 'why-diff', path: 'src/a.ts', label, reason: 'r' });

describe('wilson', () => {
  it('matches a known value', () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
  });
  it('stays inside [0, 1] at the edges and is [0, 1] without data', () => {
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(10, 10)[1]).toBeCloseTo(1, 10);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe('score', () => {
  it('positive class is unreferenced/unused; unclear is excluded', () => {
    const s = score(
      [lab('a', 1, 'unused'), lab('a', 2, 'used'), lab('a', 3, 'unclear'), lab('b', 1, 'unused')],
      new Map([['a:1', true], ['a:2', true], ['a:3', true], ['b:1', false]]),
    );
    expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 0, unclear: 1, precision: 0.5, recall: 0.5 });
    expect(s.precisionCI[0]).toBeLessThan(0.5);
    expect(s.precisionCI[1]).toBeGreaterThan(0.5);
  });
  it('counts true negatives and labels without a prediction', () => {
    const s = score([lab('a', 1, 'used'), lab('z', 9, 'unused')], new Map([['a:1', false]]));
    expect(s).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 1, unmatched: 1 });
    expect(Number.isNaN(s.precision)).toBe(true);
  });
});

describe('label schema', () => {
  it('accepts a well-formed label', () => {
    expect(validateLabel({ sessionHash: '0123456789ab', readOrdinal: 3, repo: 'why-diff', path: 'src/a.ts', label: 'used', reason: 'edited later' })).toEqual([]);
  });
  it('rejects extra fields, absolute paths, bad hashes, labels and long reasons', () => {
    const errs = validateLabel({ sessionHash: 'XYZ', readOrdinal: 0, repo: 'private-thing', path: '/abs/a.ts', label: 'maybe', reason: 'x'.repeat(201), content: 'leak' });
    expect(errs.join('\n')).toMatch(/field/);
    expect(errs.join('\n')).toMatch(/sessionHash/);
    expect(errs.join('\n')).toMatch(/readOrdinal/);
    expect(errs.join('\n')).toMatch(/repo/);
    expect(errs.join('\n')).toMatch(/path/);
    expect(errs.join('\n')).toMatch(/label/);
    expect(errs.join('\n')).toMatch(/reason/);
  });

  // study/labels.jsonl is written by the labeller (Task 10 Step 4.2); once it exists it must hold to the schema.
  const labelsFile = path.resolve('study/labels.jsonl');
  // Expected to fail until the labeller has written study/labels.jsonl (Task 10 Step 4.2).
  it('labels.jsonl has the allowed fields only, repo-relative paths, short reasons', async () => {
    expect(existsSync(labelsFile), 'PENDING Task 10 Step 4.2: study/labels.jsonl does not exist yet; the labeller writes it').toBe(true);
    const labels = await readLabels(labelsFile);
    for (const l of labels) expect(validateLabel(l)).toEqual([]);
    expect(labels.length).toBe(149);
  });
  it('the study names exactly the four public repos, and no label comes from another repo', async () => {
    expect([...REPOS].sort()).toEqual(['agent-ledger', 'doc-router', 'recipe-units-agent', 'why-diff']);
    for (const f of ['study/labels.jsonl', 'study/labels-heldout.jsonl']) {
      for (const l of await readLabels(path.resolve(f))) expect(REPOS, `${f} ${l.sessionHash}`).toContain(l.repo);
    }
  });
});

describe('labels-heldout.jsonl', () => {
  it('holds to the label schema and has the 89 held-out reads from public repos', async () => {
    const labels = await readLabels(path.resolve('study/labels-heldout.jsonl'));
    for (const l of labels) expect(validateLabel(l)).toEqual([]);
    expect(labels.length).toBe(89);
    expect(new Set(labels.map((l) => `${l.sessionHash}:${l.readOrdinal}`)).size).toBe(89);
  });
});

describe('aggregateTotals', () => {
  it('keeps totals only, never sessions, paths or ids', () => {
    const report = {
      toolVersion: '0.1.0',
      generatedAt: '2026-11-02T00:00:00.000Z',
      totals: {
        sessions: 3, requests: 40, usd: 1.5, lowerBound: false, rereadRate: 0.1, compactionRereadRate: null, compactions: 0, readCounts: { total: 10, unreferenced: 3, rereads: 1, rereadsUnchanged: 1, rereadsAfterCompaction: 0 }, unreferencedReadRate: 0.3,
        estimated: { unreferencedTokenShare: 0.25, composition: [{ source: 'tool_result:Read', introduced: 10, processed: 30 }, { source: 'system_prompt', introduced: 30, processed: 90 }], topUnreferencedFiles: [{ path: 'why-diff/src/a.ts', count: 1 }] },
        topSessions: [{ sessionId: 's-1' }],
      },
      sessions: [{ entrypoint: 'sdk-py' }, { entrypoint: 'sdk-py' }, { entrypoint: null }],
    };
    const a = aggregateTotals(report);
    expect(a).toMatchObject({ sessions: 3, requests: 40, usd: 1.5, unreferencedTokenShare: 0.25, rereadRate: 0.1, compactionRereadRate: null, toolVersion: '0.1.0' });
    expect(a.entrypoints).toEqual({ 'sdk-py': 2, unknown: 1 });
    expect(a.compositionShares['system_prompt']).toBeCloseTo(0.75);
    expect(JSON.stringify(a)).not.toMatch(/src\/a\.ts|s-1/);
  });
  it('keeps the cost record, cache share, re-reads and subagents, and no likely-unused estimate', () => {
    const a = aggregateTotals({
      toolVersion: '0.1.0', generatedAt: 'x',
      totals: {
        sessions: 2, requests: 5, usd: 2, lowerBound: false, cacheHitShare: 0.7, harnessUSD: 2.1, unloggedUSD: 0.1,
        readCounts: { total: 10, unreferenced: 3, rereads: 2, rereadsUnchanged: 1, rereadsAfterCompaction: 0 }, unreferencedReadRate: 0.3,
        rereadRate: 0.2, compactions: 1, compactionRereadRate: 0.5, subagents: 1, subagentCostShare: 0.25,
        estimated: { unreferencedTokenShare: 0.4, unreferencedCarriedUSD: 0.05, likelyUnused: { estimated: true, count: 1, low: 0, high: 2, precision: 0.24, ci: [0.1, 0.4], sample: 's' }, composition: [] },
      },
      sessions: [{ entrypoint: 'cli', cost: { harnessUSD: 1 } }, { entrypoint: 'cli', cost: { harnessUSD: null } }],
    });
    expect(a).toMatchObject({ cacheHitShare: 0.7, harnessUSD: 2.1, unloggedUSD: 0.1, sessionsWithHarnessCost: 1, reads: 10, unreferencedReads: 3, rereads: 2, rereadsUnchanged: 1, subagents: 1, subagentCostShare: 0.25, unreferencedCarriedUSD: 0.05 });
    expect(a).not.toHaveProperty('likelyUnused');
  });
});

describe('readPredictions', () => {
  it('reads flat entries and picks a version from {v1, v2} entries', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-pred-'));
    const flat = path.join(dir, 'flat.json');
    const both = path.join(dir, 'both.json');
    await writeFile(flat, JSON.stringify({ predictions: { 'a:1': { unreferenced: true }, 'a:2': { unreferenced: false } } }));
    await writeFile(both, JSON.stringify({ predictions: { 'a:1': { v1: { unreferenced: true }, v2: { unreferenced: false } } } }));
    expect([...(await readPredictions(flat))]).toEqual([['a:1', true], ['a:2', false]]);
    expect((await readPredictions(both, 'v1')).get('a:1')).toBe(true);
    expect((await readPredictions(both, 'v2')).get('a:1')).toBe(false);
    await expect(readPredictions(both)).rejects.toThrow(/version/);
  });
});

describe('referencedReliability', () => {
  it('scores only reads the metric calls referenced: used share of used + unused, unclear counted', () => {
    const r = referencedReliability(
      [lab('a', 1, 'used'), lab('a', 2, 'used'), lab('a', 3, 'unused'), lab('a', 4, 'unclear'), lab('b', 1, 'unused')],
      new Map([['a:1', false], ['a:2', false], ['a:3', false], ['a:4', false], ['b:1', true]]),
    );
    expect(r).toMatchObject({ referenced: 4, used: 2, unused: 1, unclear: 1, unmatched: 0 });
    expect(r.share).toBeCloseTo(2 / 3);
    expect(r.ci).toEqual(wilson(2, 3));
    expect(r.missRate).toBeCloseTo(1 / 3);
    expect(r.missCI).toEqual(wilson(1, 3));
  });
});

describe('replaceBlock', () => {
  it('replaces the text between two markers and keeps the markers', () => {
    const t = 'a\n<!-- X:START -->\nold\n<!-- X:END -->\nb\n';
    expect(replaceBlock(t, 'X', 'new')).toBe('a\n<!-- X:START -->\nnew\n<!-- X:END -->\nb\n');
  });
  it('throws when a marker is missing', () => {
    expect(() => replaceBlock('no markers', 'X', 'new')).toThrow(/X:START/);
  });
});

const results = {
  first: { labels: 150, ...score([lab('a', 1, 'unused'), lab('a', 2, 'used'), lab('a', 3, 'unclear')], new Map([['a:1', true], ['a:2', true], ['a:3', false]])) },
  dev: { labels: 150, ...score([lab('a', 1, 'unused'), lab('a', 2, 'used')], new Map([['a:1', true], ['a:2', false]])) },
  heldout: { labels: 90, ...referencedReliability([lab('h', 1, 'used'), lab('h', 2, 'unused'), lab('h', 3, 'unclear')], new Map([['h:1', false], ['h:2', false], ['h:3', false]])) },
};
const agg = {
  runAt: '2026-11-02T00:00:00.000Z', toolVersion: '0.1.0', sessions: 347, requests: 923, usd: 42.4153, usdLowerBound: false, harnessUSD: 43.1556, unloggedUSD: 0.7403,
  sessionsWithHarnessCost: 347, cacheHitShare: 0.7447, reads: 258, unreferencedReads: 68, unreferencedReadRate: 0.2636, unreferencedTokenShare: 0.2673,
  rereads: 15, rereadsUnchanged: 14, rereadRate: 0.0581, compactions: 0, compactionRereadRate: null, subagents: 0, subagentCostShare: 0,
  compositionShares: { system_prompt: 0.11 }, entrypoints: { 'sdk-py': 264, 'sdk-cli': 83 },
};

describe('renderReadmeBlock', () => {
  const md = renderReadmeBlock(results, agg);
  it('carries the labeller sentence, the v1 precision with its CI and the held-out miss rate', () => {
    expect(md).toContain('labelled by an LLM reviewer with a written rubric, blind to the heuristic');
    expect(md).toContain('50.0%'); // v1 precision 1/2
    expect(md).toMatch(/held-out/i);
    expect(md).toContain('1 of 2');
    expect(md).toMatch(/miss rate.*50\.0% \(1 of 2 were unused, 95% CI/i);
  });
  it('publishes no recall and says why', () => {
    expect(md).not.toMatch(/recall \d|recall:/i);
    expect(md).toMatch(/Recall is not published/);
    expect(md).toMatch(/cannot be estimated without reweighting/);
    expect(md).toMatch(/stratified/);
  });
  it('marks the v2 number as development, not validation', () => {
    expect(md).toMatch(/development set/i);
  });
  it('states the corpus and the measured aggregates, with labelled counts instead of an estimate', () => {
    expect(md).toContain('347');
    expect(md).toContain('$42.42');
    expect(md).toContain('$43.16');
    expect(md).toContain('74.5%');
    expect(md).toContain('26.4%');
    expect(md).toMatch(/in 4 allowlisted public repos/);
    expect(md).toMatch(/cache hit share/i);
    expect(md).not.toMatch(/likely unused|95% range/i);
    // dev (v2) on the first sample: 1 unreferenced read labelled unused, none used, none unclear.
    expect(md).toMatch(/\| Labelled reads the heuristic calls unreferenced \| 1: 1 unused, 0 used, 0 unclear \|/);
    expect(md).toMatch(/one developer/i);
    expect(md).toMatch(/headless/i);
  });
  it('has no em dashes, arrows or absolute paths', () => {
    expect(md).not.toMatch(/—|→|\/Users\/|[A-Za-z]:\\/);
  });
  it('leaves the aggregate out when there is none', () => {
    expect(renderReadmeBlock(results, null)).not.toContain('$42.42');
  });
});

describe('renderStudyScores', () => {
  const md = renderStudyScores(results);
  it('prints the v1 confusion matrix with Wilson intervals, and no recall', () => {
    expect(md).toMatch(/\| *metric unreferenced *\| *1 *\| *1 *\|/);
    expect(md).toMatch(/\| *metric referenced *\| *0 *\| *0 *\|/);
    expect(md).toMatch(/Precision.*50\.0%.*95% CI/);
    expect(md).not.toMatch(/- Recall/);
  });
  it('marks the development figure and gives the held-out counts and miss rate', () => {
    expect(md).toMatch(/development set, not a validation/i);
    expect(md).toMatch(/used 1, unused 1, unclear 1/);
    expect(md).toMatch(/Miss rate.*50\.0% \(1 of 2, 95% CI/);
    expect(md).not.toMatch(/—|→/);
  });
});

describe('renderAggregate', () => {
  it('lists the corpus numbers without paths, and the labelled counts instead of an estimate', () => {
    const md = renderAggregate(agg, results);
    expect(md).toContain('| Sessions | 347 |');
    expect(md).toMatch(/sdk-py 264/);
    expect(md).toMatch(/Cache hit share/);
    expect(md).not.toMatch(/likely unused|95% range/i);
    expect(md).toMatch(/Labelled reads the heuristic calls unreferenced \(first sample, v2\) \| 1: 1 unused, 0 used, 0 unclear/);
    expect(md).not.toMatch(/—|→|\/Users\//);
  });
});

describe('staleBlocks (the --check mode CI runs)', () => {
  const fresh = (name: string, body: string) => `x\n<!-- ${name}:START -->\n${body}\n<!-- ${name}:END -->\n`;
  it('is empty when every generated block matches the committed results', () => {
    const readme = fresh('STUDY', renderReadmeBlock(results, agg));
    const study = fresh('SCORES', renderStudyScores(results)) + fresh('AGGREGATE', renderAggregate(agg, results));
    expect(staleBlocks({ readme, study }, results, agg)).toEqual([]);
  });
  it('names each block that differs', () => {
    const readme = fresh('STUDY', 'old numbers');
    const study = fresh('SCORES', renderStudyScores(results)) + fresh('AGGREGATE', 'old');
    expect(staleBlocks({ readme, study }, results, agg)).toEqual(['README.md STUDY', 'docs/STUDY.md AGGREGATE']);
  });
});

describe('the committed study results', () => {
  it('match the README and STUDY blocks', async () => {
    const { readFile } = await import('node:fs/promises');
    const res = JSON.parse(await readFile(path.resolve('study/results.json'), 'utf8'));
    const ag = JSON.parse(await readFile(path.resolve('study/aggregate.json'), 'utf8'));
    const readme = await readFile(path.resolve('README.md'), 'utf8');
    const study = await readFile(path.resolve('docs/STUDY.md'), 'utf8');
    expect(staleBlocks({ readme, study }, res, ag)).toEqual([]);
  });
  it('agree with the label files on the counts that need no predictions', async () => {
    const { readFile } = await import('node:fs/promises');
    const res = JSON.parse(await readFile(path.resolve('study/results.json'), 'utf8'));
    const first = await readLabels(path.resolve('study/labels.jsonl'));
    const held = await readLabels(path.resolve('study/labels-heldout.jsonl'));
    expect(res.first.labels).toBe(first.length);
    expect(res.first.unclear).toBe(first.filter((l) => l.label === 'unclear').length);
    expect(res.first.tp + res.first.fn).toBe(first.filter((l) => l.label === 'unused').length);
    expect(res.heldout.labels).toBe(held.length);
    expect([res.heldout.used, res.heldout.unused, res.heldout.unclear]).toEqual(['used', 'unused', 'unclear'].map((k) => held.filter((l) => l.label === k).length));
  });
});
