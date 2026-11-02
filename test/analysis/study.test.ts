import { beforeAll, describe, expect, it } from 'vitest';
import { STUDY, likelyUnused, studySentence, type StudyNumbers } from '../../src/analysis/study.js';
import { buildReport } from '../../src/pipeline.js';
import { renderHtml } from '../../src/report/html.js';
import { renderTerminal } from '../../src/report/terminal.js';
import type { Report } from '../../src/report/types.js';
import { fixtureTree } from '../helpers/fixture-tree.js';
import { defaults } from '../helpers/report-defaults.js';

const study: StudyNumbers = {
  precision: 0.5,
  ci: [0.3, 0.7],
  unused: 40,
  calledUnreferenced: 80,
  unclear: 10,
  sample: 'held-out, seed 20261103',
  missRate: { rate: 0.04, ci: [0.01, 0.1], unused: 4, scored: 100, sample: 'held-out' },
  date: '2026-11-03',
};

describe('likelyUnused', () => {
  it('the configured numbers are the blind result for heuristic v1 on the first sample (public repos only), labelled conservative', () => {
    expect(STUDY).toEqual({
      precision: 11 / 44,
      ci: [expect.closeTo(0.1457, 4), expect.closeTo(0.3944, 4)],
      unused: 11,
      calledUnreferenced: 44,
      unclear: 27,
      sample: 'blind labels, heuristic v1 before test-file rules 4 and 5, so conservative for the current heuristic',
      missRate: { rate: 3 / 81, ci: [expect.closeTo(0.0127, 4), expect.closeTo(0.1033, 4)], unused: 3, scored: 81, sample: 'held-out sample, blind' },
      date: '2026-11-02',
    });
    expect(likelyUnused(44)).toMatchObject({ count: 11, low: 6, high: 18 });
  });
  it('rounds the low end down and the high end up, so one read is never "0 to 0"', () => {
    expect(likelyUnused(1)).toMatchObject({ count: 0, low: 0, high: 1 });
    expect(likelyUnused(3, study)).toMatchObject({ count: 2, low: 0, high: 3 });
  });
  it('is null when no study numbers are configured', () => {
    expect(likelyUnused(10, null)).toBeNull();
  });
  it('is unreferenced × precision, with the interval from the precision CI', () => {
    expect(likelyUnused(40, study)).toEqual({ estimated: true, count: 20, low: 12, high: 28, precision: 0.5, ci: [0.3, 0.7], sample: 'held-out, seed 20261103' });
  });
  it('is null without unreferenced reads to scale', () => {
    expect(likelyUnused(0, study)).toBeNull();
  });
});

describe('studySentence', () => {
  it('states the precision with its real denominator, the referenced miss rate, and why recall is not published', () => {
    expect(studySentence(study)).toBe(
      'Precision of "unreferenced" against blind labels: 50.0% (95% CI 30.0% to 70.0%): 40 of 80 reads called unreferenced were unused, 10 more unclear (held-out, seed 20261103). ' +
        'Unreferenced is an upper bound on unused reads. Miss rate of "referenced": 4.0% (95% CI 1.0% to 10.0%): 4 of 100 reads called referenced were unused (held-out). ' +
        'Recall is not published: the labelled sample was stratified by the heuristic\'s call, so recall cannot be estimated without reweighting.',
    );
    expect(STUDY && studySentence()).toContain('11 of 44 reads called unreferenced were unused');
    expect(studySentence(null)).toBe('Precision of the unreferenced heuristic: not measured yet (validation study pending).');
  });
});

describe('the likely-unused line in reports', () => {
  let r: Report;
  beforeAll(async () => {
    const { claudeDir, codexDir } = await fixtureTree();
    r = await buildReport({ ...defaults, claudeDir, codexDir });
  });
  const withoutStudy = (x: Report): Report => ({ ...x, totals: { ...x.totals, estimated: { ...x.totals.estimated, likelyUnused: null } } });
  const withStudy = (x: Report): Report => ({
    ...x,
    totals: { ...x.totals, estimated: { ...x.totals.estimated, likelyUnused: likelyUnused(x.totals.readCounts.unreferenced, study) } },
  });

  it('is in the default report, from the configured numbers', () => {
    expect(r.totals.estimated.likelyUnused).toMatchObject({ estimated: true, sample: STUDY!.sample });
    const term = renderTerminal(r, { color: false, width: 100 });
    expect(term).toMatch(/likely unused ≈ .*scaled from the precision CI.*estimate/);
    expect(term).not.toMatch(/95% range/);
    expect(term).not.toMatch(/not measured yet/);
    expect(renderHtml(r)).not.toMatch(/not measured yet/);
  });
  it('is left out entirely when no study numbers are configured', () => {
    const x = withoutStudy(r);
    expect(renderTerminal(x, { color: false, width: 100 })).not.toMatch(/likely unused/i);
    expect(renderHtml(x)).not.toMatch(/likely unused/i);
  });
  it('is shown as a labelled estimate when they are', () => {
    const x = withStudy(r);
    expect(x.totals.readCounts.unreferenced).toBeGreaterThan(0);
    const term = renderTerminal(x, { color: false, width: 100 });
    expect(term).toMatch(/likely unused ≈ \d+ reads? \(\d+ to \d+, scaled from the precision CI\)/);
    expect(term).toMatch(/estimate: unreferenced × precision 50.0% \(95% CI 30.0% to 70.0%, held-out, seed 20261103\)/);
    const html = renderHtml(x);
    expect(html).toMatch(/Likely unused.*scaled from the precision CI.*estimate/s);
    expect(html).not.toMatch(/95% range/);
  });
});
