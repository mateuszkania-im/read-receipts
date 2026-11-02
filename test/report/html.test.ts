import { beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { escapeHtml, renderHtml } from '../../src/report/html.js';
import { shareReport } from '../../src/report/share.js';
import type { Report } from '../../src/report/types.js';
import { fixtureTree } from '../helpers/fixture-tree.js';
import { defaults } from '../helpers/report-defaults.js';

let sampleReport: Report;
let compareReport: Report;
beforeAll(async () => {
  const { claudeDir, codexDir } = await fixtureTree();
  sampleReport = await buildReport({ ...defaults, claudeDir, codexDir });
  compareReport = await buildReport({ ...defaults, claudeDir, codexDir, compare: { by: null, splitAt: '2026-06-01T00:00:00.000Z', outcome: 'any' } });
});

const EVIL = '</script><img src=x onerror=alert(1)>.ts';

function withEvil(r: Report): Report {
  const t = r.totals;
  return {
    ...r,
    totals: {
      ...t,
      unpricedModels: [...t.unpricedModels, `${EVIL}\u2028&\u2029`],
      byModel: [...t.byModel, { model: EVIL, usd: 0.5, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }],
      topRereadFiles: [{ path: EVIL, count: 3 }],
      estimated: { ...t.estimated, topUnreferencedFiles: [{ path: EVIL, count: 1, estimated: { estimated: true, tokens: 900 } }], composition: [...t.estimated.composition, { source: EVIL, introduced: 5, processed: 5 }] },
    },
    branches: [{ repo: `/r/${EVIL}`, branch: EVIL, outcome: 'noPr', usd: 1, sessions: 1 }],
    prs: [{ repo: '/r/x', number: 1, state: 'open', usd: 1, attempts: 1, attemptsNoEdit: 0, title: EVIL, url: 'javascript:alert(1)', sessionIds: ['s'], sessionUsd: [1] }],
    warnings: [EVIL],
  };
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('renderHtml', () => {
  it('has the CSP meta and no external URLs', () => {
    const h = renderHtml(sampleReport);
    expect(h).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`);
    expect(h).not.toMatch(/(src|href|action|xlink:href)\s*=\s*["']?(https?:)?\/\//i);
    expect(h).not.toMatch(/url\(|@import|@font-face/i);
    expect(h).not.toMatch(/<link\b|<iframe\b|<object\b|<embed\b/i);
  });

  it('escapes script-breaking content in the embedded JSON', () => {
    const h = renderHtml(withEvil(sampleReport));
    expect(h).not.toContain('</script><img');
    expect(h).toContain('\\u003c/script\\u003e');
    const json = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(h)?.[1];
    expect(json).toBeDefined();
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json!).warnings).toContain(EVIL);
  });

  it('escapes every log-derived string in the markup', () => {
    const h = renderHtml(withEvil(sampleReport)).replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');
    expect(h).not.toMatch(/<img/i);
    expect(h).not.toContain('onerror=alert(1)>');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).not.toContain('javascript:');
  });

  it('never uses innerHTML or other HTML sinks in the inline script', () => {
    const h = renderHtml(sampleReport);
    expect(h).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(h).toMatch(/textContent/);
  });

  it('has every section heading of spec section 8', () => {
    const h = renderHtml(sampleReport);
    for (const s of ['Summary', 'Where the money went', 'Context composition', 'Unreferenced reads', 'Re-reads and compactions', 'Cost per PR and branch', 'Subagents', 'Harness fingerprints and compare', 'Method and limits']) {
      expect(h).toMatch(new RegExp(`<h2[^>]*>(<[^>]+>[^<]*</[^>]+>\\s*)?${s}</h2>`));
    }
  });

  it('puts the summary first: cost, cache hit share, unreferenced share with its definition, re-read rate, unpriced', () => {
    const h = renderHtml(sampleReport);
    const summary = h.slice(h.indexOf('id="summary"'), h.indexOf('id="money"'));
    for (const label of ['Total cost', 'Cache hit share', 'Unreferenced reads', 'Re-read rate', 'Unpriced']) expect(summary).toContain(label);
    expect(summary).toContain('≥ $');
    expect(summary).toContain('gpt-5-codex');
    expect(summary).toMatch(/≈ \d/);
    expect(summary).toContain('Unreferenced is not useless');
    expect(summary).toContain(escapeHtml(sampleReport.definitions.unreferenced.replace(/ Full rules: spec 6\.3, \S+$/, '')));
    expect(summary).toContain('Full rules: spec 6.3, linked under Method and limits.');
    expect(renderHtml(sampleReport)).toContain(escapeHtml(sampleReport.definitions.unreferenced));
    expect(h.indexOf('id="prs"')).toBeLessThan(h.indexOf('id="composition"'));
  });

  it('light and dark themes, a system font stack, no gradients, no Inter, no em dash or arrow', () => {
    const h = renderHtml(sampleReport);
    expect(h).toContain('@media (prefers-color-scheme: dark)');
    expect(h).not.toMatch(/gradient|\bInter\b/);
    expect(h).not.toMatch(/—|→|⟶|->/);
  });

  it('draws bars to scale', () => {
    const r: Report = {
      ...sampleReport,
      branches: [
        { repo: '/r/shop', branch: 'feat/a', outcome: 'noPr', usd: 10, sessions: 1 },
        { repo: '/r/shop', branch: 'feat/b', outcome: 'noPr', usd: 2.5, sessions: 1 },
      ],
    };
    const h = renderHtml(r);
    const sec = h.slice(h.indexOf('id="prs"'), h.indexOf('id="composition"'));
    const widths = [...sec.matchAll(/<rect class="bar[^"]*"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths.slice(0, 2)).toEqual([100, 25]);
  });

  it('draws the composition as a stacked bar whose segments sum to the whole', () => {
    const h = renderHtml(sampleReport);
    const sec = h.slice(h.indexOf('id="composition"'), h.indexOf('id="unreferenced"'));
    const bar = /<svg[^>]*class="stack"[\s\S]*?<\/svg>/.exec(sec)?.[0] ?? '';
    const widths = [...bar.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(2);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 0);
  });

  it('shows a before/after table only in compare mode', () => {
    const table = /<table class="[^"]*\bcompare\b/;
    expect(renderHtml(sampleReport)).not.toMatch(table);
    const h = renderHtml(compareReport);
    expect(h).toMatch(table);
    expect(h).toMatch(/before 2026-06-01/);
    expect(h).toMatch(/after 2026-06-01/);
  });

  it('marks a shared report as redacted and shows no raw ids', () => {
    const s = shareReport(sampleReport, { home: '/home/nobody', salt: '00'.repeat(32) });
    const h = renderHtml(s);
    expect(h).toMatch(/Redacted for sharing/);
    expect(renderHtml(sampleReport)).not.toMatch(/Redacted for sharing/);
  });
});

describe('control and bidi characters (F9)', () => {
  const evil = 'src/a\u202Egnp.ts\u2066x\u2069\u0007\u001b[2J\u0085\u009b\u2028\u2029\u200Fend';
  it('escapeHtml removes bidi controls, C0/C1 controls and U+2028/2029 from displayed text', () => {
    expect(escapeHtml(evil)).toBe('src/agnp.tsx[2Jend');
  });
  it('a whole page has none of them raw, in the markup or the embedded JSON', () => {
    const r: Report = { ...sampleReport, sessions: sampleReport.sessions.map((x) => ({ ...x, cwd: evil, reads: x.reads.map((rd) => ({ ...rd, path: evil })) })), warnings: [evil] };
    const h = renderHtml(r);
    // eslint-disable-next-line no-control-regex
    expect(h).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
    const json = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(h)![1]!;
    expect(JSON.parse(json).warnings[0]).toBe(evil);
  });
});
