import { describe, expect, it, vi } from 'vitest';
import { attribute, type AttributeDeps } from '../../src/attribution/attribute.js';
import type { Pr } from '../../src/attribution/gh.js';
import { fakeSession } from '../helpers/fake-session.js';
import { abs, norm } from '../helpers/platform-path.js';

const now = new Date('2026-11-02T00:00:00Z');
const git: AttributeDeps['git'] = async () => ({ root: norm('/r'), commonRoot: norm('/r'), origin: 'git@github.com:acme/shop.git', defaultBranch: 'main' });
const pr = (o: Partial<Pr> & { number: number; headRefName: string }): Pr => ({
  state: 'OPEN',
  createdAt: '2026-10-02T12:00:00Z',
  mergedAt: null,
  closedAt: null,
  title: `PR ${o.number}`,
  url: `https://github.com/acme/shop/pull/${o.number}`,
  ...o,
});
const span = (ts: string, branch: string | null, usd: number, subagent = false) => ({ ts, cwd: abs('/r'), branch, usd, requests: 1, subagent });
const sessOn = (id: string, branch: string, ts: string, extra: { edits?: number; usd?: number; explicitPrs?: number[] } = {}) =>
  fakeSession({ sessionId: id, branchSpans: [span(ts, branch, extra.usd ?? 1)], edits: extra.edits ?? 1, explicitPrs: (extra.explicitPrs ?? []).map((number) => ({ number, repo: null })) });

describe('attribute', () => {
  it('attributes by branch within the PR window, including closed-unmerged attempts', async () => {
    const listPrs = async () => ({ prs: [pr({ number: 7, headRefName: 'feat/x', state: 'CLOSED', closedAt: '2026-10-05T00:00:00Z' })], note: null });
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-02T10:00:00Z'), sessOn('s2', 'feat/x', '2026-10-03T10:00:00Z', { edits: 0 })], { gh: true, now }, { git, listPrs });
    expect(r.prs[0]).toMatchObject({ number: 7, state: 'closedUnmerged', attempts: 2, attemptsNoEdit: 1, usd: 2 });
    expect(r.unmergedSpend).toBeCloseTo(r.prs[0]!.usd);
    expect(r.branches).toEqual([expect.objectContaining({ branch: 'feat/x', outcome: 'pr', usd: 2, sessions: 2 })]);
  });
  it('requests outside the PR window stay on the branch as noPr', async () => {
    const listPrs = async () => ({ prs: [pr({ number: 7, headRefName: 'feat/x', state: 'MERGED', mergedAt: '2026-10-04T00:00:00Z' })], note: null });
    const r = await attribute([sessOn('s1', 'feat/x', '2026-09-20T10:00:00Z'), sessOn('s2', 'feat/x', '2026-10-03T10:00:00Z', { usd: 3 })], { gh: true, now }, { git, listPrs });
    expect(r.prs).toEqual([expect.objectContaining({ number: 7, state: 'merged', usd: 3, attempts: 1 })]);
    expect(r.unmergedSpend).toBeCloseTo(1);
  });
  it('splits one session that switches branch halfway', async () => {
    const s = fakeSession({ sessionId: 's1', branchSpans: [span('2026-10-02T10:00:00Z', 'feat/a', 1), span('2026-10-02T11:00:00Z', 'feat/b', 2)] });
    const r = await attribute([s], { gh: false, now }, { git });
    expect(r.branches.map((b) => [b.branch, b.usd, b.sessions]).sort()).toEqual([
      ['feat/a', 1, 1],
      ['feat/b', 2, 1],
    ]);
  });
  it('requests on the default branch are default, not unmerged spend', async () => {
    const r = await attribute([sessOn('s1', 'main', '2026-10-02T10:00:00Z', { usd: 5 })], { gh: false, now }, { git });
    expect(r.branches).toEqual([expect.objectContaining({ branch: 'main', outcome: 'default', usd: 5 })]);
    expect(r.unmergedSpend).toBe(0);
  });
  it('explicit remote_session_change PR wins over branch matching', async () => {
    const listPrs = async () => ({
      prs: [pr({ number: 7, headRefName: 'feat/x' }), pr({ number: 9, headRefName: 'feat/other', state: 'MERGED', mergedAt: '2026-10-10T00:00:00Z' })],
      note: null,
    });
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z', { explicitPrs: [9] })], { gh: true, now }, { git, listPrs });
    expect(r.prs.map((p) => [p.number, p.state, p.usd])).toEqual([[9, 'merged', 1]]);
  });
  it('without gh only explicit PRs are known and nothing is spawned', async () => {
    const listPrs = vi.fn(async () => ({ prs: [] as Pr[], note: null }));
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z', { explicitPrs: [9] }), sessOn('s2', 'feat/y', '2026-10-03T10:00:00Z')], { gh: false, now }, { git, listPrs });
    expect(listPrs).not.toHaveBeenCalled();
    expect(r.prs).toEqual([expect.objectContaining({ number: 9, state: 'unknown', title: '', url: '' })]);
    expect(r.branches.find((b) => b.branch === 'feat/y')).toMatchObject({ outcome: 'noPr' });
  });
  it('a missing gh or no auth degrades to branch-only attribution with a note', async () => {
    const listPrs = async () => ({ prs: [] as Pr[], note: 'gh not found on PATH; PRs are not looked up' });
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z')], { gh: true, now }, { git, listPrs });
    expect(r.prs).toEqual([]);
    expect(r.branches[0]).toMatchObject({ outcome: 'noPr' });
    expect(r.warnings.join('\n')).toMatch(/gh not found/);
  });
  it('looks up the PR list once per origin', async () => {
    const listPrs = vi.fn(async () => ({ prs: [] as Pr[], note: null }));
    await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z'), sessOn('s2', 'feat/y', '2026-10-03T10:00:00Z')], { gh: true, now }, { git, listPrs });
    expect(listPrs).toHaveBeenCalledTimes(1);
  });
  it('subagent requests on HEAD inherit the parent branch', async () => {
    const s = fakeSession({
      sessionId: 's1',
      branchSpans: [span('2026-10-02T10:00:00Z', 'feat/a', 1), span('2026-10-02T10:30:00Z', 'HEAD', 2, true), span('2026-10-02T11:00:00Z', 'feat/b', 4), span('2026-10-02T11:30:00Z', null, 8, true)],
    });
    const r = await attribute([s], { gh: false, now }, { git });
    expect(Object.fromEntries(r.branches.map((b) => [b.branch, b.usd]))).toEqual({ 'feat/a': 3, 'feat/b': 12 });
  });
  it('without a repo the session cwd names the bucket, outside unmerged spend', async () => {
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z')], { gh: true, now }, { git: async () => null, exists: async () => true });
    expect(r.branches[0]).toMatchObject({ repo: norm('/r'), branch: 'feat/x', outcome: 'noRepo' });
    expect(r.unmergedSpend).toBe(0);
  });
  it('maps each session to the PRs it touched', async () => {
    const listPrs = async () => ({ prs: [pr({ number: 7, headRefName: 'feat/x', state: 'MERGED', mergedAt: '2026-10-09T00:00:00Z' })], note: null });
    const r = await attribute([sessOn('s1', 'feat/x', '2026-10-03T10:00:00Z')], { gh: true, now }, { git, listPrs });
    expect(r.prs[0]!.sessionIds).toEqual(['s1']);
  });
});

describe('attribute: review round 7-8', () => {
  const listPrs = async (origin: string) => ({
    prs: origin.includes('widget') ? [pr({ number: 12, headRefName: 'feat/wt', state: 'MERGED', createdAt: '2026-10-29T00:00:00Z', mergedAt: '2026-10-31T00:00:00Z', closedAt: '2026-10-31T00:00:00Z' })] : [],
    note: null,
  });
  const repos: Record<string, { root: string; commonRoot: string; origin: string; defaultBranch: string }> = {
    [abs('/w/repo')]: { root: norm('/w/repo'), commonRoot: norm('/w/repo'), origin: 'https://github.com/acme/widget.git', defaultBranch: 'main' },
    [abs('/w/other')]: { root: norm('/w/other'), commonRoot: norm('/w/other'), origin: 'https://github.com/acme/other.git', defaultBranch: 'main' },
  };
  const deps = (gone: string[] = []) => ({
    git: async (d: string) => repos[d] ?? null,
    exists: async (d: string) => !gone.map(abs).includes(d),
    listPrs,
  });
  const sess = (id: string, spans: Array<[string, string | null, number]>, links: Array<{ number: number; repo: string | null }> = []) =>
    fakeSession({ sessionId: id, cwd: abs(spans[0]![0]), branchSpans: spans.map(([cwd, branch, usd], i) => ({ ts: `2026-10-30T1${i}:00:00Z`, cwd: abs(cwd), branch, usd, requests: 1, subagent: false })), explicitPrs: links });

  it('ruling 1: a session outside a repo goes to "no repo", never unmerged; an empty branch is no branch', async () => {
    const r = await attribute([sess('b', [['/w/notarepo', '', 1]])], { gh: true, now }, deps());
    expect(r.branches).toEqual([expect.objectContaining({ outcome: 'noRepo', branch: '(no branch)', usd: 1 })]);
    expect(r.unmergedSpend).toBe(0);
  });
  it('ruling 1: a main thread on a detached HEAD goes to "detached", never unmerged', async () => {
    const r = await attribute([sess('c', [['/w/repo', 'HEAD', 2]]), sess('c2', [['/w/repo', null, 3]])], { gh: true, now }, deps());
    expect(r.branches.map((b) => b.outcome)).toEqual(['detached', 'detached']);
    expect(r.unmergedSpend).toBe(0);
  });
  it('ruling 2: a removed worktree resolves its merged PR by branch name through the main repo', async () => {
    const r = await attribute([sess('a', [['/w/wt', 'feat/wt', 1]]), sess('d', [['/w/repo', 'feat/wt', 1]])], { gh: true, now }, deps(['/w/wt']));
    expect(r.prs).toEqual([expect.objectContaining({ repo: norm('/w/repo'), number: 12, state: 'merged', usd: 2, sessionIds: ['a', 'd'] })]);
    expect(r.unmergedSpend).toBe(0);
  });
  it('ruling 2: an unresolvable removed worktree is "unattributed (worktree gone)", never unmerged, with a warning', async () => {
    const r = await attribute([sess('a', [['/w/wt2', 'feat/lost', 4]])], { gh: true, now }, deps(['/w/wt2']));
    expect(r.branches).toEqual([expect.objectContaining({ outcome: 'worktreeGone', usd: 4 })]);
    expect(r.unmergedSpend).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/1 session.*worktree.*no longer exists/);
  });
  it('ruling 3: an explicit PR link applies only to spans in the repo it names', async () => {
    const r = await attribute([sess('d', [['/w/repo', 'feat/wt', 1], ['/w/other', 'feat/o', 1]], [{ number: 12, repo: 'acme/widget' }])], { gh: true, now }, deps());
    expect(r.prs.map((p) => [p.repo, p.number])).toEqual([[norm('/w/repo'), 12]]);
    expect(r.branches.find((b) => b.branch === 'feat/o')).toMatchObject({ outcome: 'noPr' });
  });
  it('ruling 3: a bare PR number applies only to the session\'s first repo', async () => {
    const r = await attribute([sess('d', [['/w/repo', 'feat/wt', 1], ['/w/other', 'feat/o', 1]], [{ number: 12, repo: null }])], { gh: false, now }, deps());
    expect(r.prs.map((p) => [p.repo, p.number])).toEqual([[norm('/w/repo'), 12]]);
  });
  it('ruling 4: spend on branches without a known PR is reported separately', async () => {
    const r = await attribute([sess('e', [['/w/repo', 'feat/x', 5]])], { gh: false, now }, deps());
    expect(r.noPrSpend).toBe(5);
  });
  it('ruling 5: each PR row carries the cost each session spent on it', async () => {
    const r = await attribute([sess('a', [['/w/repo', 'feat/wt', 2], ['/w/repo', 'main', 7]])], { gh: true, now }, deps());
    expect(r.prs[0]).toMatchObject({ sessionIds: ['a'], sessionUsd: [2] });
  });
});
