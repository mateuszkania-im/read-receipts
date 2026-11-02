// Security review F2 (run-wide git budget, cache by realpath), F4 (no UNC paths), F12 (git children and
// scratch dirs do not outlive the run).

import { mkdir, realpath, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attribute } from '../../src/attribution/attribute.js';
import { defaultExec, killLiveChildren, liveChildren, type ExecFn } from '../../src/attribution/exec.js';
import { GitRun, cleanStaleGitScratch } from '../../src/attribution/git.js';
import { isLocalAbsolutePath } from '../../src/io/paths.js';
import { fakeSession } from '../helpers/fake-session.js';
import { tmpDir } from '../helpers/synth.js';

/** A git that never answers: each call costs its whole timeout on a fake clock, then fails. */
function hangingGit() {
  let now = 0;
  const calls: Array<{ args: string[]; timeout: number }> = [];
  const exec: ExecFn = (_bin, args, opts, cb) => {
    calls.push({ args, timeout: opts.timeout });
    now += opts.timeout;
    cb(Object.assign(new Error('timeout'), { killed: true }), '', '');
  };
  return { exec, calls, now: () => now };
}

describe('GitRun budget (F2)', () => {
  it('spends at most the run budget across all git calls, then skips lookups with a note', async () => {
    const g = hangingGit();
    const run = new GitRun({ budgetMs: 30_000, exec: g.exec, now: g.now, bin: 'git' });
    const dirs = await Promise.all(Array.from({ length: 12 }, () => tmpDir('rr-f2-')));
    for (const d of dirs) expect(await run.info(d)).toBeNull();
    expect(g.now()).toBeLessThanOrEqual(30_000);
    expect(g.calls.length).toBe(6);
    for (const c of g.calls) expect(c.timeout).toBeLessThanOrEqual(5000);
    expect(run.notes().join('\n')).toMatch(/git time budget \(30 s\) ran out: 6 directories were not looked up/);
  });
  it('gives the last call only what is left of the budget', async () => {
    const g = hangingGit();
    const run = new GitRun({ budgetMs: 7_000, exec: g.exec, now: g.now, bin: 'git' });
    await run.info(await tmpDir('rr-f2-'));
    await run.info(await tmpDir('rr-f2-'));
    expect(g.calls.map((c) => c.timeout)).toEqual([5000, 2000]);
  });
  it('looks a directory up once, whatever its spelling (cache by realpath)', async () => {
    const g = hangingGit();
    const run = new GitRun({ budgetMs: 30_000, exec: g.exec, now: g.now, bin: 'git' });
    const d = await tmpDir('rr-f2-');
    await mkdir(path.join(d, 'sub'));
    for (const spelling of [d, `${d}/`, `${d}/.`, `${d}/./././`, `${d}//`, path.join(d, 'sub', '..')]) await run.info(spelling);
    expect(g.calls.filter((c) => c.args.includes('rev-parse'))).toHaveLength(1);
  });
});

describe('local absolute paths only (F4, allow-list)', () => {
  const winRejected = [
    ['\\??\\ prefix', '\\??\\C:\\repo'],
    ['\\\\?\\ prefix', '\\\\?\\C:\\repo'],
    ['\\\\.\\ prefix', '\\\\.\\pipe\\x'],
    ['\\Device\\ prefix', '\\Device\\HarddiskVolume1\\repo'],
    ['\\\\host\\share', '\\\\attacker\\share\\repo'],
    ['//host/share', '//attacker/share'],
    ['//?/ prefix', '//?/c:/repo'],
    ['mixed slashes /\\', '/\\attacker\\share'],
    ['mixed slashes \\/', '\\/attacker/share'],
    ['root-relative \\', '\\repo'],
    ['root-relative /', '/repo'],
    ['drive-relative', 'C:repo'],
    ['relative', 'repo\\sub'],
    ['empty', ''],
  ] as const;
  for (const [name, p] of winRejected) {
    it(`win32 rejects ${name}`, () => expect(isLocalAbsolutePath(p, 'win32')).toBe(false));
  }
  for (const p of ['C:\\Users\\x\\repo', 'c:/users/x/repo', 'D:\\', 'z:/']) {
    it(`win32 accepts ${p}`, () => expect(isLocalAbsolutePath(p, 'win32')).toBe(true));
  }
  const posixRejected = [
    ['//host/share', '//attacker/share'],
    ['///triple', '///etc'],
    ['\\\\host\\share', '\\\\attacker\\share'],
    ['\\\\?\\ prefix', '\\\\?\\C:\\repo'],
    ['relative', 'repo/sub'],
    ['dot-relative', '../../etc'],
    ['drive letter', 'C:/repo'],
    ['empty', ''],
  ] as const;
  for (const [name, p] of posixRejected) {
    it(`posix rejects ${name}`, () => expect(isLocalAbsolutePath(p, 'linux')).toBe(false));
  }
  for (const p of ['/home/x/repo', '/', '/tmp/a b']) {
    it(`posix accepts ${p}`, () => expect(isLocalAbsolutePath(p, 'darwin')).toBe(true));
  }

  it('GitRun never runs git or touches the file system for rejected paths, and counts them in a note', async () => {
    const g = hangingGit();
    const realpath = vi.fn(async (d: string) => d);
    const run = new GitRun({ budgetMs: 30_000, exec: g.exec, now: g.now, bin: 'git', platform: 'win32', realpath });
    for (const [, p] of winRejected) expect(await run.info(p)).toBeNull();
    expect(g.calls).toHaveLength(0);
    expect(realpath).not.toHaveBeenCalled();
    expect(run.notes().join('\n')).toMatch(new RegExp(`${winRejected.length} working directories are not local absolute paths \\(UNC, device or relative\\) and were not opened`));
  });
  it('GitRun checks the realpath result again before any git call', async () => {
    const g = hangingGit();
    const run = new GitRun({ budgetMs: 30_000, exec: g.exec, now: g.now, bin: 'git', platform: 'linux', realpath: async () => '//attacker/share' });
    expect(await run.info('/home/x/link-to-share')).toBeNull();
    expect(g.calls).toHaveLength(0);
    expect(run.notes().join('\n')).toMatch(/1 working directory is not a local absolute path/);
  });
  it('attribution books a UNC cwd as no repo without checking that it exists', async () => {
    const exists = vi.fn(async () => true);
    const git = vi.fn(async () => null);
    const s = fakeSession({ sessionId: 's1', cwd: '//attacker/share/repo', branchSpans: [{ ts: '2026-10-20T10:00:00Z', cwd: '//attacker/share/repo', branch: 'feat/x', usd: 1, requests: 1, subagent: false }] });
    const a = await attribute([s], { gh: false, now: new Date('2026-11-01') }, { git, exists, listPrs: async () => ({ prs: [], note: null }) });
    expect(exists).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
    expect(a.branches[0]).toMatchObject({ outcome: 'noRepo' });
  });
});

describe('git children and scratch dirs (F12)', () => {
  it.skipIf(process.platform === 'win32')('starts children attached and kills the live ones on demand (the exit and signal handlers call this)', async () => {
    const done = new Promise<{ err: unknown; ms: number }>((resolve) => {
      const t0 = Date.now();
      defaultExec('/bin/sleep', ['30'], { cwd: '/', env: process.env, timeout: 60_000, maxBuffer: 1024 }, (err) => resolve({ err, ms: Date.now() - t0 }));
    });
    expect(liveChildren()).toBe(1);
    killLiveChildren();
    const r = await done;
    expect(r.err).toBeTruthy();
    expect(r.ms).toBeLessThan(5000);
    expect(liveChildren()).toBe(0);
  });
  it('removes read-receipts-git-* dirs older than an hour, and keeps newer ones and other names', async () => {
    const tmp = await realpath(await tmpDir('rr-f12-'));
    const old = path.join(tmp, 'read-receipts-git-old1');
    const fresh = path.join(tmp, 'read-receipts-git-new1');
    const other = path.join(tmp, 'something-else');
    for (const d of [old, fresh, other]) await mkdir(path.join(d, 'no-hooks'), { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    for (const d of [old, other]) await utimes(d, twoHoursAgo, twoHoursAgo);
    await cleanStaleGitScratch(tmp);
    await expect(stat(old)).rejects.toThrow();
    expect((await stat(fresh)).isDirectory()).toBe(true);
    expect((await stat(other)).isDirectory()).toBe(true);
  });
});


describe('the report notes (F2, F4)', () => {
  it('a session whose cwd is a UNC path is reported as no repo, with a note', async () => {
    const { buildReport } = await import('../../src/pipeline.js');
    const { claudeLines, writeClaudeSession } = await import('../helpers/synth.js');
    const { defaults } = await import('../helpers/report-defaults.js');
    const claudeDir = path.join(await tmpDir('rr-f4-'), 'claude');
    const sid = '22222222-2222-4333-8444-555555555555';
    const cwd = '//attacker/share/repo';
    await writeClaudeSession(claudeDir, cwd, sid, claudeLines(sid, [{ ts: '2026-10-25T09:00:00.000Z', cwd }]));
    const r = await buildReport({ ...defaults, claudeDir, codexDir: null });
    expect(r.branches.map((b) => b.outcome)).toEqual(['noRepo']);
    expect(r.warnings.join('\n')).toMatch(/1 working directory is not a local absolute path \(UNC, device or relative\) and was not opened/);
  });
});
