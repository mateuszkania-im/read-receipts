// Review 7-8, ruling 6: no form of "waste" in any user-facing output or in the JSON.

import { beforeAll, describe, expect, it } from 'vitest';
import { DEFINITIONS, buildReport } from '../src/pipeline.js';
import { renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { shareReport } from '../src/report/share.js';
import { renderTerminal } from '../src/report/terminal.js';
import type { Report } from '../src/report/types.js';
import { fixtureTree } from './helpers/fixture-tree.js';
import { defaults } from './helpers/report-defaults.js';

let r: Report;
beforeAll(async () => {
  const { claudeDir, codexDir } = await fixtureTree();
  r = await buildReport({ ...defaults, claudeDir, codexDir, compare: { by: 'model', splitAt: null, outcome: 'any' } });
});

describe('wording', () => {
  it('no output contains /wast/i', () => {
    const outputs = [
      JSON.stringify(DEFINITIONS),
      renderJson(r),
      renderHtml(r),
      renderJson(shareReport(r, { home: '/home/nobody', salt: '00'.repeat(32) })),
      renderHtml(shareReport(r, { home: '/home/nobody', salt: '00'.repeat(32) })),
      ...(['summary', 'sessions', 'session', 'prs', 'compare'] as const).map((view) => renderTerminal(r, { color: false, width: 100, view })),
    ];
    const hits = outputs.flatMap((o) => o.match(/wast/gi) ?? []);
    expect(hits).toHaveLength(0);
  });
});
