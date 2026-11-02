#!/usr/bin/env node
// Builds docs/sample-report.html from the fictional demo corpus (scripts/gen-demo-corpus.mjs). Git and
// gh are stubbed with the corpus's invented repositories and PRs, so the sample needs no repo on disk
// and no network. Run with tsx: node --import tsx scripts/sample-report.mjs [--out docs/sample-report.html]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_PRS, DEMO_REPOS, DEMO_SPLIT, generateDemoCorpus } from './gen-demo-corpus.mjs';
import { buildReport } from '../src/pipeline.ts';
import { renderHtml } from '../src/report/html.ts';

const i = process.argv.indexOf('--out');
const out = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'docs/sample-report.html');
const corpus = '/tmp/read-receipts-demo';
const dirs = generateDemoCorpus(corpus);

const repoOf = (dir) => Object.values(DEMO_REPOS).find((r) => dir === r.root || dir.startsWith(`${r.root}/`)) ?? null;
const report = await buildReport(
  {
    ...dirs,
    since: '2026-10-01T00:00:00.000Z',
    until: null,
    projects: [],
    agent: 'all',
    includeSubagents: true,
    pricesPath: null,
    gh: true,
    maxLineMb: 256,
    compare: { by: null, splitAt: DEMO_SPLIT, outcome: 'any' },
    sessionPrefix: null,
    now: '2026-11-01T09:00:00.000Z',
  },
  {
    git: async (dir) => {
      const r = repoOf(dir);
      return r === null ? null : { root: r.root, commonRoot: r.root, origin: r.origin, defaultBranch: 'main' };
    },
    gitRoot: async (dir) => repoOf(dir)?.root ?? null,
    listPrs: async (origin) => ({ prs: DEMO_PRS[origin] ?? [], note: null }),
  },
);
// tsx runs the sources, which carry the dev version; the sample shows the version being released.
report.toolVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
writeFileSync(out, renderHtml(report));
process.stdout.write(`${report.sessions.length} sessions, $${report.totals.usd.toFixed(2)}; wrote ${out}\n`);
