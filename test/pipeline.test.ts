import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, projectFolderMatches } from '../src/pipeline.js';
import { fixtureTree } from './helpers/fixture-tree.js';
import { defaults } from './helpers/report-defaults.js';
import { claudeLines, tmpDir, writeClaudeSession } from './helpers/synth.js';

describe('buildReport', () => {
  it('builds a report over a fixture directory tree', async () => {
    const { claudeDir, codexDir } = await fixtureTree();
    const r = await buildReport({ ...defaults, claudeDir, codexDir });
    expect(r.schemaVersion).toBe(1);
    expect(r.sessions.length).toBe(6);
    expect(r.totals.sessionsByAgent).toEqual({ 'claude-code': 4, codex: 2 });
    expect(r.totals.readCounts.total).toBeGreaterThan(0);
    expect(r.totals.subagents).toBe(1);
    expect(r.totals.requestsUnpriced).toBeGreaterThan(0);
    expect(r.totals.unpricedModels).toContain('gpt-5-codex');
    expect(r.totals.lowerBound).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/unpriced/);
    expect(r.totals.estimated.estimated).toBe(true);
    expect(r.totals.estimated.composition.length).toBeGreaterThan(0);
  });
  it('--project keeps only sessions whose cwd is inside the path, and never opens other project folders', async () => {
    const claudeDir = await tmpDir();
    const a = '/work/public-repo';
    const b = '/work/private-repo';
    await writeClaudeSession(claudeDir, a, 'aaaaaaaa-0000-4000-8000-00000000000a', claudeLines('aaaaaaaa-0000-4000-8000-00000000000a', [{ ts: '2026-10-02T10:00:00.000Z', cwd: a }]));
    await writeClaudeSession(claudeDir, `${a}/sub`, 'aaaaaaaa-0000-4000-8000-00000000000c', claudeLines('aaaaaaaa-0000-4000-8000-00000000000c', [{ ts: '2026-10-02T10:00:00.000Z', cwd: `${a}/sub` }]));
    await writeClaudeSession(claudeDir, `${a}-other`, 'aaaaaaaa-0000-4000-8000-00000000000d', claudeLines('aaaaaaaa-0000-4000-8000-00000000000d', [{ ts: '2026-10-02T10:00:00.000Z', cwd: `${a}-other` }]));
    // A private folder whose file is not even valid: opening it would show up as a bad line.
    const priv = await writeClaudeSession(claudeDir, b, 'aaaaaaaa-0000-4000-8000-00000000000b', '{"not json');
    const r = await buildReport({ ...defaults, claudeDir, projects: [a] });
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(['aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000c']);
    expect(r.totals.files.badLines).toBe(0);
    expect(path.basename(priv)).toContain('0b');
  });
  it('--since and --until drop sessions outside the window', async () => {
    const claudeDir = await tmpDir();
    for (const [id, ts] of [
      ['aaaaaaaa-0000-4000-8000-000000000011', '2026-09-01T10:00:00.000Z'],
      ['aaaaaaaa-0000-4000-8000-000000000012', '2026-10-15T10:00:00.000Z'],
      ['aaaaaaaa-0000-4000-8000-000000000013', '2026-10-30T10:00:00.000Z'],
    ] as const) {
      await writeClaudeSession(claudeDir, '/w/r', id, claudeLines(id, [{ ts, cwd: '/w/r' }]));
    }
    const r = await buildReport({ ...defaults, claudeDir, since: '2026-10-01T00:00:00.000Z', until: '2026-10-20T00:00:00.000Z' });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000012']);
  });
  it('keeps only the top unreferenced reads per session, but every read for session <id>', async () => {
    const claudeDir = await tmpDir();
    const id = 'aaaaaaaa-0000-4000-8000-000000000021';
    const reqs = Array.from({ length: 60 }, (_, i) => ({
      ts: `2026-10-02T10:${String(i).padStart(2, '0')}:00.000Z`,
      cwd: '/w/r',
      read: { file: `/w/r/src/file${i}.txt`, content: `plain words ${'x'.repeat(i * 10)}` },
    }));
    await writeClaudeSession(claudeDir, '/w/r', id, claudeLines(id, reqs));
    const all = await buildReport({ ...defaults, claudeDir });
    expect(all.sessions[0]!.reads).toHaveLength(50);
    expect(all.sessions[0]!.readsOmitted).toBe(10);
    expect(all.sessions[0]!.readCounts.total).toBe(60);
    expect(all.totals.readCounts.total).toBe(60);
    const one = await buildReport({ ...defaults, claudeDir, sessionPrefix: 'aaaaaaaa-0000-4000-8000-0000000000' });
    expect(one.sessions[0]!.reads).toHaveLength(60);
  });
  it('runs compare when asked', async () => {
    const { claudeDir, codexDir } = await fixtureTree();
    const r = await buildReport({ ...defaults, claudeDir, codexDir, compare: { by: 'model', splitAt: null, outcome: 'any' } });
    expect(r.compare!.reduce((n, row) => n + row.sessions, 0)).toBe(6);
  });
});

describe('projectFolderMatches (review 7-8, ruling 8)', () => {
  it('compares Claude project folder names case-insensitively on Windows only', () => {
    expect(projectFolderMatches('C--Work-Repo', 'c:\\work\\repo', 'win32')).toBe(true);
    expect(projectFolderMatches('C--Work-Repo-sub', 'C:\\WORK\\REPO', 'win32')).toBe(true);
    expect(projectFolderMatches('C--Work-Repo2', 'c:\\work\\repo', 'win32')).toBe(false);
    expect(projectFolderMatches('-work-Repo', '/work/repo', 'linux')).toBe(false);
    expect(projectFolderMatches('-work-repo', '/work/repo', 'linux')).toBe(true);
  });
});

describe('unmerged spend without --gh (review 7-8, ruling 4)', () => {
  it('is null in the totals, and the branch-level spend is reported under noPrSpend', async () => {
    const { claudeDir, codexDir } = await fixtureTree();
    const r = await buildReport({ ...defaults, claudeDir, codexDir });
    expect(r.totals.unmergedSpend).toBeNull();
    expect(typeof r.totals.noPrSpend).toBe('number');
  });
});
