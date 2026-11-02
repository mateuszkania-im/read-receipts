import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { renderJson } from '../../src/report/json.js';
import type { Report } from '../../src/report/types.js';
import { fixtureTree } from '../helpers/fixture-tree.js';
import { defaults } from '../helpers/report-defaults.js';

let sampleReport: Report;
beforeAll(async () => {
  const { claudeDir, codexDir } = await fixtureTree();
  sampleReport = await buildReport({ ...defaults, claudeDir, codexDir });
});

describe('renderJson', () => {
  it('has schemaVersion 1 and round-trips', () => {
    const j = JSON.parse(renderJson(sampleReport));
    expect(j.schemaVersion).toBe(1);
    expect(JSON.parse(renderJson(j))).toEqual(j);
    expect(j.sessions).toHaveLength(6);
  });
  it('marks estimated numbers with estimated: true', () => {
    const j = JSON.parse(renderJson(sampleReport));
    expect(j.totals.estimated.estimated).toBe(true);
    for (const s of j.sessions) {
      expect(s.estimated.estimated).toBe(true);
      for (const r of s.reads) expect(r.estimated.estimated).toBe(true);
    }
  });
  it('holds no text from the logs', () => {
    expect(renderJson(sampleReport)).not.toMatch(/function fn\d|Check the logo/);
  });
  it('carries the definitions of referenced and unreferenced', () => {
    const j = JSON.parse(renderJson(sampleReport));
    expect(j.definitions.unreferenced).toMatch(/rule something out/);
    expect(j.definitions.unreferenced).toMatch(/does not mean/);
  });
  it('uses readCounts for every read count and keeps `reads` for lists (schema 1 names)', () => {
    const j = JSON.parse(renderJson(sampleReport));
    expect(Object.keys(j.totals.readCounts).sort()).toEqual(['rereads', 'rereadsAfterCompaction', 'rereadsUnchanged', 'total', 'unreferenced']);
    expect(j.totals.readCounts.total).toBeGreaterThan(0);
    for (const k of ['reads', 'unreferencedReads', 'rereads', 'rereadsUnchanged', 'rereadsAfterCompaction']) expect(j.totals, k).not.toHaveProperty(k);
    for (const s of j.sessions) {
      expect(Object.keys(s.readCounts).sort()).toEqual(['rereads', 'rereadsAfterCompaction', 'rereadsUnchanged', 'total', 'unreferenced']);
      expect(Array.isArray(s.reads)).toBe(true);
      expect(s).toHaveProperty('branchSpans');
      expect(s).not.toHaveProperty('requestsByBranch');
    }
    if (j.totals.estimated.likelyUnused !== null) expect(j.totals.estimated.likelyUnused).toHaveProperty('count');
    const numericReads: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        if (k === 'reads' && !Array.isArray(x)) numericReads.push(`${at}.${k}`);
        walk(x, `${at}.${k}`);
      }
    };
    walk(j, '$');
    expect(numericReads).toEqual([]);
  });
  it('every key of the report is documented in docs/json-schema.md', () => {
    const doc = readFileSync('docs/json-schema.md', 'utf8');
    const keys = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, depth));
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        // Maps keyed by data (composition sources, models) are documented as maps, not per key.
        if (!/^[a-z][A-Za-z0-9]*$/.test(k)) continue;
        keys.add(k);
        walk(x, depth + 1);
      }
    };
    walk(JSON.parse(renderJson(sampleReport)), 0);
    const missing = [...keys].filter((k) => !doc.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });
});
