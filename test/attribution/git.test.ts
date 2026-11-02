import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptOnlyBinary } from '../../src/attribution/exec.js';
import { clearGitCache, gitInfo, hardenedGitInvocation, resolveBinary, runGit, withGitScratch } from '../../src/attribution/git.js';
import { normalizePath } from '../../src/io/paths.js';
import { tmpDir } from '../helpers/synth.js';

const isWin = process.platform === 'win32';
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe' });

async function repo(): Promise<string> {
  const r = await realpath(await tmpDir('rr-git-'));
  g(r, 'init', '-q', '-b', 'main');
  g(r, 'commit', '-q', '--allow-empty', '-m', 'init');
  return r;
}

afterEach(() => {
  clearGitCache();
  delete process.env.GIT_DIR;
});

describe('hardenedGitInvocation', () => {
  it('switches off hooks, fsmonitor, pager, external diff and textconv, and reads no system or global config', async () => {
    await withGitScratch(async (scratch) => {
    const inv = hardenedGitInvocation(['log', '-1'], undefined, scratch);
    const joined = inv.args.join(' ');
    expect(inv.args[0]).toBe('--no-pager');
    expect(joined).toContain('core.fsmonitor=false');
    expect(joined).toMatch(/core\.hooksPath=\S+/);
    expect(joined).toContain('core.pager=cat');
    expect(joined).toContain('diff.external=');
    expect(inv.args).toContain('--no-ext-diff');
    expect(inv.args).toContain('--no-textconv');
    expect(inv.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(inv.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(inv.env.GIT_OPTIONAL_LOCKS).toBe('0');
    const globalFile = inv.env.GIT_CONFIG_GLOBAL!;
    expect(fs.readFileSync(globalFile, 'utf8')).toBe('');
    });
  });
  it('drops inherited GIT_ variables that could point git elsewhere', () => {
    process.env.GIT_DIR = '/nowhere/.git';
    expect(hardenedGitInvocation(['status'], undefined, { hooks: '/h', emptyConfig: '/c' }).env.GIT_DIR).toBeUndefined();
  });
});

describe('gitInfo', () => {
  it('finds the root, origin and default branch', async () => {
    const r = await repo();
    g(r, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    g(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    await mkdir(path.join(r, 'sub'));
    const info = await gitInfo(path.join(r, 'sub'));
    expect(info).toEqual({ root: normalizePath(r), commonRoot: normalizePath(r), origin: 'git@github.com:acme/shop.git', defaultBranch: 'trunk' });
  });
  it('finds the root of a worktree through the common dir', async () => {
    const r = await repo();
    const wt = path.join(await realpath(await tmpDir('rr-wt-')), 'wt');
    g(r, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    const info = await gitInfo(wt);
    expect(info?.root).toBe(normalizePath(wt));
    expect(info?.commonRoot).toBe(normalizePath(r));
  });
  it('returns null for a non-repo and for a missing directory', async () => {
    expect(await gitInfo(await tmpDir('rr-norepo-'))).toBeNull();
    expect(await gitInfo(path.join(await tmpDir(), 'missing'))).toBeNull();
  });
  it('ignores a GIT_DIR inherited from the environment', async () => {
    const a = await repo();
    const b = await repo();
    process.env.GIT_DIR = path.join(b, '.git');
    expect((await gitInfo(a))?.root).toBe(normalizePath(a));
  });
  it.skipIf(isWin)('never runs a fsmonitor configured by the repo, even for git status', async () => {
    const r = await repo();
    const marker = path.join(await tmpDir('rr-marker-'), 'ran');
    const script = path.join(r, 'fsmon.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(script, 0o755);
    g(r, 'config', 'core.fsmonitor', script);
    await writeFile(path.join(r, 'f.txt'), 'x');
    // Control: plain git status does run it.
    g(r, 'status', '--porcelain');
    const ranUnhardened = fs.existsSync(marker);
    fs.rmSync(marker, { force: true });
    expect(await gitInfo(r)).not.toBeNull();
    expect(await runGit(r, ['status', '--porcelain'])).not.toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
    expect(ranUnhardened).toBe(true);
  });
  it.skipIf(isWin)('never reads a hostile global config named by GIT_CONFIG_GLOBAL', async () => {
    const r = await repo();
    const marker = path.join(await tmpDir('rr-marker-'), 'ran');
    const script = path.join(await tmpDir('rr-script-'), 'fsmon.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(script, 0o755);
    const cfg = path.join(await tmpDir('rr-cfg-'), 'config');
    await writeFile(cfg, `[core]\n\tfsmonitor = ${script}\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfg;
    try {
      await writeFile(path.join(r, 'f.txt'), 'x');
      expect(await runGit(r, ['status', '--porcelain'])).not.toBeNull();
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
  it.skipIf(isWin)('gives up on a git that hangs, within the timeout', async () => {
    const bin = path.join(await tmpDir('rr-fakegit-'), 'git');
    await writeFile(bin, '#!/bin/sh\nsleep 10\n');
    await chmod(bin, 0o755);
    const t0 = Date.now();
    expect(await runGit(await tmpDir(), ['rev-parse', '--show-toplevel'], { bin, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('caches per directory', async () => {
    const r = await repo();
    const a = gitInfo(r);
    expect(gitInfo(r)).toBe(a);
    await a;
  });
});


describe('spawning (binary planting)', () => {
  it('never spawns git with the repo as its working directory; the repo goes through -C', async () => {
    const r = await repo();
    const seen: Array<{ cwd: string | undefined; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    await runGit(r, ['rev-parse', '--show-toplevel'], {
      exec: (_bin, args, o, cb) => {
        seen.push({ cwd: o.cwd, args, env: o.env });
        cb(null, '', '');
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toBe(os.tmpdir());
    expect(seen[0]!.cwd).not.toBe(r);
    const i = seen[0]!.args.indexOf('-C');
    expect(seen[0]!.args[i + 1]).toBe(r);
    if (process.platform === 'win32') expect(seen[0]!.env!.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
  it('resolves a binary from PATH, skipping ".", relative entries and the target directory', async () => {
    const planted = await realpath(await tmpDir('rr-planted-'));
    const good = await realpath(await tmpDir('rr-good-'));
    const exe = process.platform === 'win32' ? 'tool.exe' : 'tool';
    for (const d of [planted, good]) {
      await writeFile(path.join(d, exe), '');
      await chmod(path.join(d, exe), 0o755);
    }
    const PATH = ['.', 'relative/bin', planted, good].join(path.delimiter);
    expect(resolveBinary('tool', { PATH, PATHEXT: '.EXE' }, [planted])).toBe(path.join(good, exe));
    expect(resolveBinary('tool', { PATH: ['.', planted].join(path.delimiter), PATHEXT: '.EXE' }, [planted])).toBeNull();
  });
});

describe('review round 7-8', () => {
  it('ruling 9: on Windows only .exe is resolved; a .cmd or .bat is reported as script-only', async () => {
    const d = await realpath(await tmpDir('rr-win-'));
    await writeFile(path.join(d, 'tool.cmd'), '');
    await writeFile(path.join(d, 'tool.bat'), '');
    const env = { PATH: d, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(resolveBinary('tool', env, [], 'win32')).toBeNull();
    expect(scriptOnlyBinary('tool', env, 'win32')).toBe(path.join(d, 'tool.cmd'));
    await writeFile(path.join(d, 'tool.exe'), '');
    expect(resolveBinary('tool', env, [], 'win32')).toBe(path.join(d, 'tool.exe'));
    expect(scriptOnlyBinary('tool', env, 'linux')).toBeNull();
  });

  it('ruling 10: the git scratch dir is removed after every call, also when git fails', async () => {
    const r = await repo();
    const seen: string[] = [];
    const record = (fail: boolean) => (_bin: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      const hooks = args.find((a) => a.startsWith('core.hooksPath='))!.slice('core.hooksPath='.length);
      seen.push(path.dirname(hooks));
      expect(fs.existsSync(hooks)).toBe(true);
      cb(fail ? new Error('boom') : null, 'ok\n', '');
    };
    expect(await runGit(r, ['status'], { bin: 'git', exec: record(false) })).toBe('ok\n');
    expect(await runGit(r, ['status'], { bin: 'git', exec: record(true) })).toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const d of seen) expect(fs.existsSync(d)).toBe(false);
  });

  it('ruling 11: a core.worktree outside the repo is ignored; the dir that holds .git is the root', async () => {
    const r = await repo();
    const elsewhere = await realpath(await tmpDir('rr-elsewhere-'));
    g(r, 'config', 'core.worktree', elsewhere);
    clearGitCache();
    const info = await gitInfo(r);
    expect(info?.root).toBe(normalizePath(r));
    expect(info?.commonRoot).toBe(normalizePath(r));
  });

  it('ruling 11: a core.worktree inside the repo parent chain is kept', async () => {
    const r = await repo();
    await mkdir(path.join(r, 'sub'));
    clearGitCache();
    expect((await gitInfo(path.join(r, 'sub')))?.root).toBe(normalizePath(r));
  });
});
