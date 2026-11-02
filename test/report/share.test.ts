import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { renderJson } from '../../src/report/json.js';
import { hmacLabel, shareReport } from '../../src/report/share.js';
import type { Report } from '../../src/report/types.js';
import { CANARY, CANARY_FILE_ID, CANARY_HOME, canaryDeps, canaryTree } from '../helpers/canary.js';
import { defaults } from '../helpers/report-defaults.js';

let canaryReport: Report;
let noRepoReport: Report;
const SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const o = { home: CANARY_HOME, salt: SALT };
const claude = (r: Report) => r.sessions.find((x) => x.agent === 'claude-code')!;

beforeAll(async () => {
  const dirs = await canaryTree();
  canaryReport = await buildReport({ ...defaults, ...dirs, gh: true, compare: { by: 'model', splitAt: null, outcome: 'any' } }, canaryDeps());
  noRepoReport = await buildReport({ ...defaults, ...dirs }, { git: async () => null, gitRoot: async () => null });
});

describe('shareReport', () => {
  it('the canary corpus reaches the unredacted report (the test can fail)', () => {
    const raw = JSON.stringify(canaryReport);
    for (const m of [CANARY_FILE_ID, 'feat/CANARY-BRANCH-7', '/home/canary-user/acme-repo', 'CANARY_PRTITLE_9f3', '/etc/CANARY_ABS', 'CANARY_AGENTTYPE_9f3', 'CANARY_ENTRYPOINT_9f3', 'mcp:CANARY-MCP-9f3', 'tool_result:CANARY_TOOL_9f3', 'mcp:CANARY-CODEXMCP-9f3']) {
      expect(raw).toContain(m);
    }
    expect(canaryReport.prs[0]?.state).toBe('merged');
  });

  it('keeps aggregates and repo-relative paths only', () => {
    const s = shareReport(canaryReport, o);
    const txt = JSON.stringify(s);
    expect(txt).not.toMatch(CANARY);
    expect(txt).not.toMatch(/\/etc\/|\/home\//);
    expect(txt).toContain('src/cart.ts');
    expect(txt).toContain('<outside-repo>');
    expect(txt).toMatch(/branch-[0-9a-f]{6}/);
    expect(txt).toMatch(/s-[0-9a-f]{8}/);
    expect(s.redacted).toBe(true);
  });

  it('keeps numbers, models, built-in tool names, repo basenames, PR numbers and states', () => {
    const s = shareReport(canaryReport, o);
    expect(s.totals.usd).toBe(canaryReport.totals.usd);
    expect(s.totals.readCounts.total).toBe(canaryReport.totals.readCounts.total);
    expect(s.totals.byModel.map((m) => m.model)).toEqual(canaryReport.totals.byModel.map((m) => m.model));
    const sources = s.totals.estimated.composition.map((c) => c.source);
    const builtIn = (x: string) => x === 'tool_result:Read' || x === 'tool_result:Bash' || x === 'tool_result:Edit';
    expect(sources.filter(builtIn)).toEqual(canaryReport.totals.estimated.composition.map((c) => c.source).filter(builtIn));
    expect(sources.some((x) => x.startsWith('tool_result:Read') || x.startsWith('tool_result:Bash'))).toBe(true);
    expect(s.prs[0]).toMatchObject({ repo: 'acme-repo', number: 7, state: 'merged', title: '', url: '' });
    expect(s.branches.every((b) => b.repo === 'acme-repo')).toBe(true);
  });

  it('hashes branch names and session ids stably', () => {
    const a = shareReport(canaryReport, o);
    const b = shareReport(canaryReport, o);
    expect(a).toEqual(b);
    const sid = claude(a).sessionId;
    expect(a.prs[0]!.sessionIds).toContain(sid);
    expect(a.totals.topSessions.map((t) => t.sessionId)).toContain(sid);
    const branch = a.branches.find((x) => x.branch.startsWith('branch-'))!.branch;
    expect(claude(a).branchSpans.some((r) => r.branch === branch)).toBe(true);
  });

  it('replaces MCP server names with a keyed label', () => {
    const s = shareReport(canaryReport, o);
    const mcp = s.totals.estimated.composition.map((c) => c.source).filter((x) => x.startsWith('mcp:'));
    // One Claude Code and one Codex MCP server.
    expect(mcp).toHaveLength(2);
    for (const m of mcp) expect(m).toMatch(/^mcp:server-[0-9a-f]{6}$/);
    expect(new Set(mcp).size).toBe(2);
    expect(claude(s).estimated.composition.map((c) => c.source).filter((x) => x.startsWith('mcp:'))).toHaveLength(1);
    expect(JSON.stringify(s)).not.toMatch(/CANARY-(CODEX)?MCP/);
  });

  it('keeps built-in tool names and labels every other tool name', () => {
    const extra = [
      { source: 'tool_result:Read', introduced: 1, processed: 1 },
      { source: 'tool_result:apply_patch', introduced: 1, processed: 1 },
      { source: 'tool_result:CANARY_TOOL_9f3', introduced: 1, processed: 1 },
      { source: 'tool_result:mcp__CANARY-MCP-9f3__x', introduced: 1, processed: 1 },
      { source: 'instructions', introduced: 1, processed: 1 },
    ];
    const r: Report = { ...canaryReport, totals: { ...canaryReport.totals, estimated: { ...canaryReport.totals.estimated, composition: extra } } };
    const got = shareReport(r, o).totals.estimated.composition.map((c) => c.source);
    expect(got[0]).toBe('tool_result:Read');
    expect(got[1]).toBe('tool_result:apply_patch');
    expect(got[2]).toMatch(/^tool_result:tool-[0-9a-f]{6}$/);
    expect(got[3]).toMatch(/^tool_result:tool-[0-9a-f]{6}$/);
    expect(got[4]).toBe('instructions');
    expect(JSON.stringify(got)).not.toMatch(CANARY);
  });

  it('labels are HMAC-SHA256 keyed by the salt, not plain sha256', () => {
    const a = shareReport(canaryReport, o);
    const b = shareReport(canaryReport, { ...o, salt: 'ff'.repeat(32) });
    const branchA = a.branches.find((x) => x.branch.startsWith('branch-'))!.branch;
    const branchB = b.branches.find((x) => x.branch.startsWith('branch-'))!.branch;
    expect(branchA).not.toBe(branchB);
    expect(claude(a).sessionId).not.toBe(claude(b).sessionId);
    const plain = (x: string) => createHash('sha256').update(x).digest('hex');
    expect(branchA).not.toBe(`branch-${plain('feat/CANARY-BRANCH-7').slice(0, 6)}`);
    expect(claude(a).sessionId).not.toBe(`s-${plain(claude(canaryReport).sessionId).slice(0, 8)}`);
    expect(hmacLabel(SALT, 'branch', 'feat/CANARY-BRANCH-7', 6)).toBe(branchA.slice('branch-'.length));
  });

  it('keys the name-derived fingerprint hashes with the salt; the model and unobserved parts stay', async () => {
    const dirs = await canaryTree();
    const raw = await buildReport({ ...defaults, ...dirs, gh: true, compare: { by: 'mcp', splitAt: null, outcome: 'any' } }, canaryDeps());
    const a = shareReport(raw, o);
    const b = shareReport(raw, { ...o, salt: 'ff'.repeat(32) });
    const rawFp = claude(raw).fingerprint;
    const fp = claude(a).fingerprint;
    expect(rawFp.mcp).toMatch(/^[0-9a-f]{12}$/);
    for (const k of ['instructions', 'skills', 'hooks', 'mcp', 'systemPrompt', 'fingerprint'] as const) {
      if (rawFp[k] === '-') expect(fp[k]).toBe('-');
      else {
        expect(fp[k], k).toMatch(/^[0-9a-f]{12}$/);
        expect(fp[k], k).not.toBe(rawFp[k]);
        expect(claude(b).fingerprint[k], k).not.toBe(fp[k]);
      }
    }
    expect(fp.model).toBe(rawFp.model);
    // The same plain hash gets the same label, so compare groups still line up with the sessions.
    expect(a.compare!.map((c) => c.group)).toContain(fp.mcp);
    expect(a.compare!.map((c) => c.group)).not.toContain(rawFp.mcp);
    expect(shareReport(raw, o)).toEqual(a);
  });

  it('compare groups by model or date are not relabelled', () => {
    const s = shareReport(canaryReport, o);
    expect(s.compare!.map((c) => c.group)).toEqual(canaryReport.compare!.map((c) => c.group));
  });

  it('is pure', () => {
    const before = JSON.stringify(canaryReport);
    shareReport(canaryReport, o);
    expect(JSON.stringify(canaryReport)).toBe(before);
  });

  it('without a repo, paths under the session cwd are dropped and the branch rows get a keyed repo label (F6)', () => {
    const s = shareReport(noRepoReport, o);
    const txt = JSON.stringify(s);
    expect(JSON.stringify(noRepoReport)).toMatch(CANARY);
    expect(txt).not.toMatch(CANARY);
    expect(txt).not.toContain('src/cart.ts');
    for (const sess of s.sessions) for (const r of sess.reads) expect(r.path).toBe('<outside-repo>');
    for (const f of s.totals.estimated.topUnreferencedFiles) expect(f.path).toBe('<outside-repo>');
    expect(noRepoReport.branches.length).toBeGreaterThan(0);
    for (const b of s.branches) {
      expect(['noRepo', 'worktreeGone']).toContain(b.outcome);
      expect(b.repo).toMatch(/^r-[0-9a-f]{6}$/);
    }
    expect(s.branches[0]!.repo).toBe(`r-${hmacLabel(SALT, 'repo', noRepoReport.branches[0]!.repo, 6)}`);
  });

  it('scrubs repo owners, hosts and home paths from warnings', async () => {
    const dirs = await canaryTree();
    const r = await buildReport({ ...defaults, ...dirs, gh: true }, canaryDeps({ prs: [], note: 'gh pr list failed for canary-user/acme-repo; cost stays at branch level' }));
    const extra = { ...r, warnings: [...r.warnings, 'origin host git.canary-user.example is not github.com and gh is not logged in to it; PRs are not looked up there', `${CANARY_HOME}/x and /Users/canary-user/y`] };
    expect(JSON.stringify(extra.warnings)).toMatch(CANARY);
    const s = shareReport(extra, o);
    expect(JSON.stringify(s.warnings)).not.toMatch(CANARY);
    expect(s.warnings.join('\n')).toMatch(/gh pr list failed/);
  });

  it('maps a repo at the home directory to ~ and redacts the searched dirs and options', () => {
    const r: Report = {
      ...canaryReport,
      searched: [`${CANARY_HOME}/.claude/projects`, '/srv/canary-user/codex'],
      options: { ...canaryReport.options, claudeDir: `${CANARY_HOME}/.claude/projects`, projects: [`${CANARY_HOME}/acme-repo`], pricesPath: `${CANARY_HOME}/p.json`, sessionPrefix: 'CANARY_' },
      branches: canaryReport.branches.map((b) => ({ ...b, repo: CANARY_HOME })),
    };
    const s = shareReport(r, o);
    expect(JSON.stringify(s)).not.toMatch(CANARY);
    expect(s.branches[0]!.repo).toBe('~');
    expect(s.searched).toEqual(['custom', 'custom']);
  });

  it('shows the log dirs as default or custom, never as a path (F8)', () => {
    const def = `${CANARY_HOME}/.claude/projects`;
    const r: Report = {
      ...canaryReport,
      searched: [def, `${CANARY_HOME}/clients/CANARY_CLIENT/.codex/sessions`],
      options: { ...canaryReport.options, claudeDir: def, codexDir: `${CANARY_HOME}/clients/CANARY_CLIENT/.codex/sessions` },
    };
    const s = shareReport(r, { ...o, defaultDirs: [def, `${CANARY_HOME}/.codex/sessions`] });
    expect(s.options.claudeDir).toBe('default');
    expect(s.options.codexDir).toBe('custom');
    expect(s.searched).toEqual(['default', 'custom']);
    expect(JSON.stringify(s)).not.toMatch(CANARY);
  });

  it('keeps version, entrypoint and originator only from fixed lists; anything else is "other" (F7)', () => {
    const with_ = (version: string, entrypoint: string): Report => ({ ...canaryReport, sessions: canaryReport.sessions.map((x) => ({ ...x, version, entrypoint })) });
    expect(claude(shareReport(with_('2.1.316', 'sdk-py'), o))).toMatchObject({ version: '2.1.316', entrypoint: 'sdk-py' });
    expect(claude(shareReport(with_('2.1.316-QZVERSIONTAIL', 'qzentrypoint'), o))).toMatchObject({ version: 'other', entrypoint: 'other' });
    expect(claude(shareReport(with_('0.162.0-QZCLIVER', 'codex_cli_rs'), o))).toMatchObject({ version: 'other', entrypoint: 'codex_cli_rs' });
    expect(claude(shareReport(with_('2.1', 'qzoriginator'), o))).toMatchObject({ version: 'other', entrypoint: 'other' });
  });

  it('keeps only built-in subagent types, a plausible version and entrypoint', () => {
    const r: Report = {
      ...canaryReport,
      sessions: canaryReport.sessions.map((x) => ({ ...x, version: '2.1.316', entrypoint: 'cli', subagents: [...x.subagents, { threadId: 'a1', agentType: 'Explore', usd: 0 }] })),
    };
    const s = claude(shareReport(r, o));
    expect(s.version).toBe('2.1.316');
    expect(s.entrypoint).toBe('cli');
    expect(s.subagents.map((a) => a.agentType)).toEqual(['custom', 'Explore']);
    expect(claude(shareReport(canaryReport, o)).entrypoint).toBe('other');
  });

  it('the JSON renderer of a shared report has no canary', () => {
    expect(renderJson(shareReport(canaryReport, o))).not.toMatch(CANARY);
  });
});
