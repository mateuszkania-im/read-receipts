// The attribution probes of the Task 7-8 review (scratchpad rv78/attr.sh) as tests, with real git
// repositories and worktrees and a stubbed PR list: a removed worktree, a session outside any repo with
// an empty branch, a detached HEAD, and an explicit PR link followed by a span in another repo.

import { execFileSync } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pr } from '../../src/attribution/gh.js';
import { clearGitCache } from '../../src/attribution/git.js';
import { normalizePath } from '../../src/io/paths.js';
import { buildReport } from '../../src/pipeline.js';
import type { Report } from '../../src/report/types.js';
import { defaults } from '../helpers/report-defaults.js';
import { claudeLines, tmpDir, writeClaudeSession } from '../helpers/synth.js';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe' });
const merged12: Pr = { number: 12, headRefName: 'feat/wt', state: 'MERGED', createdAt: '2026-10-29T00:00:00Z', mergedAt: '2026-10-31T00:00:00Z', closedAt: '2026-10-31T00:00:00Z', title: 't', url: 'u' };
const listPrs = async (origin: string) => ({ prs: origin.includes('acme/widget') ? [merged12] : [], note: null });

let W: string;
let claudeDir: string;
const T1 = '2026-10-30T10:00:01.000Z';
const T2 = '2026-10-30T10:30:00.000Z';
const ids = { a: 'aaaaaaaa-0000-4000-8000-000000000001', b: 'bbbbbbbb-0000-4000-8000-000000000002', c: 'cccccccc-0000-4000-8000-000000000003', d: 'dddddddd-0000-4000-8000-000000000004' };

beforeAll(async () => {
  W = await realpath(await tmpDir('rr-probe-'));
  const repo = path.join(W, 'repo');
  const other = path.join(W, 'other');
  await mkdir(repo);
  await mkdir(other);
  await mkdir(path.join(W, 'notarepo'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', path.join(W, 'wt'));
  g(other, 'init', '-q', '-b', 'feat/o');
  g(other, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
  claudeDir = path.join(W, 'claude');
  const wt = path.join(W, 'wt');
  await writeClaudeSession(claudeDir, wt, ids.a, claudeLines(ids.a, [{ ts: T1, cwd: wt, branch: 'feat/wt' }]));
  await writeClaudeSession(claudeDir, path.join(W, 'notarepo'), ids.b, claudeLines(ids.b, [{ ts: T1, cwd: path.join(W, 'notarepo'), branch: '' }]));
  await writeClaudeSession(claudeDir, repo, ids.c, claudeLines(ids.c, [{ ts: T1, cwd: repo, branch: 'HEAD' }]));
  await writeClaudeSession(
    claudeDir,
    repo,
    ids.d,
    claudeLines(ids.d, [{ ts: T1, cwd: repo, branch: 'feat/wt' }, { ts: T2, cwd: other, branch: 'feat/o' }], { prUrl: 'https://github.com/acme/widget/pull/12' }),
  );
});

async function run(): Promise<Report> {
  clearGitCache();
  return buildReport({ ...defaults, claudeDir, codexDir: path.join(W, 'none'), gh: true }, { listPrs });
}
const name = (p: string) => path.basename(p);
const rows = (r: Report) => r.branches.map((b) => [name(b.repo), b.branch, b.outcome]).sort();

describe('attribution probes (review 7-8)', () => {
  it('with the worktree present', async () => {
    const r = await run();
    expect(rows(r)).toEqual(
      [
        ['notarepo', '(no branch)', 'noRepo'],
        ['other', 'feat/o', 'noPr'],
        ['repo', 'HEAD', 'detached'],
        ['repo', 'feat/wt', 'pr'],
      ].sort(),
    );
    expect(r.prs.map((p) => [name(p.repo), p.number, p.state, [...p.sessionIds].sort()])).toEqual([['repo', 12, 'merged', [ids.a, ids.d]]]);
    const otherUsd = r.branches.find((b) => b.branch === 'feat/o')!.usd;
    expect(r.totals.unmergedSpend).toBeCloseTo(otherUsd);
  });

  it('after git worktree remove, the merged PR is still found through the main repo', async () => {
    g(path.join(W, 'repo'), 'worktree', 'remove', '--force', path.join(W, 'wt'));
    const r = await run();
    expect(r.prs.map((p) => [normalizePath(p.repo) === normalizePath(path.join(W, 'repo')), p.number, p.state, [...p.sessionIds].sort()])).toEqual([[true, 12, 'merged', [ids.a, ids.d]]]);
    expect(r.branches.some((b) => b.outcome === 'noPr' && b.branch === 'feat/wt')).toBe(false);
    const otherUsd = r.branches.find((b) => b.branch === 'feat/o')!.usd;
    expect(r.totals.unmergedSpend).toBeCloseTo(otherUsd);
  });
});
