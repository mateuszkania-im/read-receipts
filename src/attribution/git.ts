// Read-only git plumbing for attribution (spec 6.6 and 9.2). git runs in directories named by untrusted
// logs, so nothing a repository (or a global config the agent could have written) sets may run a
// program: no hooks, no fsmonitor, no pager, no external diff or textconv, no system or global config,
// no prompt, and every call has a timeout. The pattern follows why-diff's hardened invocation.

import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLocalAbsolutePath, normalizePath } from '../io/paths.js';
import { defaultExec, noCwdSearch, resolveBinary, spawnCwd, type ExecFn } from './exec.js';

export { resolveBinary };

export interface GitInfo {
  /** Top level of the working tree that holds the directory (a linked worktree's own root). */
  root: string;
  /** The main repository's root, through `--git-common-dir`, so every worktree of one repo is one repo. */
  commonRoot: string;
  origin: string | null;
  /** From `refs/remotes/origin/HEAD`; null when the remote HEAD is not known locally. */
  defaultBranch: string | null;
}

export const GIT_TIMEOUT_MS = 5000;
/** Total time all git calls of one run may take (security review F2). */
export const GIT_RUN_BUDGET_MS = 30_000;
const SCRATCH_PREFIX = 'read-receipts-git-';

/** A private, empty hooks directory and an empty global config file for one git call. */
export interface GitScratch {
  hooks: string;
  emptyConfig: string;
}

/** Creates the scratch dir for one git call and removes it afterwards, whatever happens. */
export async function withGitScratch<T>(fn: (s: GitScratch) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  try {
    const hooks = path.join(dir, 'no-hooks');
    await mkdir(hooks, { mode: 0o700 });
    const emptyConfig = path.join(dir, 'empty-gitconfig');
    await writeFile(emptyConfig, '', { mode: 0o600 });
    return await fn({ hooks, emptyConfig });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Command-line config wins over every config file. */
function safeConfig(scratch: GitScratch): string[] {
  return [
    `core.hooksPath=${scratch.hooks}`,
    'core.fsmonitor=false',
    'core.untrackedCache=false',
    'core.pager=cat',
    'core.quotePath=false',
    'diff.external=',
    'log.showSignature=false',
    'credential.helper=',
    'protocol.allow=never',
  ].flatMap((c) => ['-c', c]);
}

const DIFF_COMMANDS: ReadonlySet<string> = new Set(['diff', 'log', 'show']);

/** Every inherited `GIT_*` variable is dropped (GIT_DIR, GIT_CONFIG_*, GIT_EXTERNAL_DIFF, GIT_SSH...). */
function hardenedEnv(scratch: GitScratch): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.toUpperCase().startsWith('GIT_')) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: scratch.emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'read-receipts-none',
    LC_ALL: 'C',
  };
}

/** The argument list and environment of every git process read-receipts starts. */
export function hardenedGitInvocation(args: string[], dir: string | undefined, scratch: GitScratch): { args: string[]; env: Record<string, string> } {
  const out = [...args];
  const sub = out[0];
  if (sub !== undefined && DIFF_COMMANDS.has(sub)) out.splice(1, 0, '--no-ext-diff', '--no-textconv');
  const at = dir !== undefined ? ['-C', dir] : [];
  return { args: ['--no-pager', ...safeConfig(scratch), ...at, ...out], env: noCwdSearch(hardenedEnv(scratch)) as Record<string, string> };
}

/**
 * Runs one hardened git command in `dir` (an argument array, never a shell). Returns stdout, or null on
 * any failure: not a repo, a repo git refuses (`safe.directory` is never overridden), a timeout, no git.
 */
export async function runGit(dir: string, args: string[], opts: { bin?: string; timeoutMs?: number; exec?: ExecFn } = {}): Promise<string | null> {
  // Spawned from the temp directory with the repo passed by -C, and the binary taken from PATH without
  // `.`, relative entries or the repo itself, so a planted git.exe in the repo is never run.
  const bin = opts.bin ?? resolveBinary('git', process.env, [dir]);
  if (bin === null) return null;
  return withGitScratch(
    (scratch) =>
      new Promise<string | null>((resolve) => {
        const inv = hardenedGitInvocation(args, dir, scratch);
        (opts.exec ?? defaultExec)(bin, inv.args, { cwd: spawnCwd(), env: inv.env, timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) =>
          resolve(err ? null : stdout),
        );
      }),
  );
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Whether `top` is `dir` or one of its ancestors, after resolving symlinks. */
async function containsDir(top: string, dir: string): Promise<boolean> {
  const [t, d] = await Promise.all([real(top), real(dir)]);
  if (t === null || d === null) return false;
  const rel = path.relative(t, d);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The nearest directory at or above `dir` that holds a `.git` entry. */
async function gitHolder(dir: string): Promise<string | null> {
  let d = await real(dir);
  while (d !== null) {
    try {
      await stat(path.join(d, '.git'));
      return normalizePath(d);
    } catch {
      const up = path.dirname(d);
      d = up === d ? null : up;
    }
  }
  return null;
}

type Git = (dir: string, args: string[]) => Promise<string | null>;

async function lookup(dir: string, git: Git): Promise<GitInfo | null> {
  if (!path.isAbsolute(dir) || !(await isDirectory(dir))) return null;
  const out = await git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (out === null) return null;
  const [top, common] = out.split('\n').map((l) => l.trim());
  if (!top || !common) return null;
  const commonDir = path.resolve(dir, common);
  // A repo's own config can set core.worktree to any directory (/etc). The work tree must contain `dir`;
  // otherwise it is ignored and the directory that holds .git is the root.
  const root = (await containsDir(top, dir)) ? normalizePath(top) : await gitHolder(dir);
  if (root === null) return null;
  const commonRoot = path.basename(commonDir) === '.git' ? normalizePath(path.dirname(commonDir)) : root;
  const origin = (await git(dir, ['remote', 'get-url', 'origin']))?.trim() || null;
  const head = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim() || null;
  const defaultBranch = head !== null && head.startsWith('origin/') ? head.slice('origin/'.length) : head;
  return { root, commonRoot, origin, defaultBranch };
}

export interface GitRunOptions {
  /** Total time for all git calls of the run. */
  budgetMs?: number;
  exec?: ExecFn;
  /** A fixed git binary (tests); by default resolved from PATH per directory. */
  bin?: string;
  now?: () => number;
  /** For tests: the platform whose path rules apply, and a realpath stand-in. */
  platform?: NodeJS.Platform;
  realpath?: (p: string) => Promise<string>;
}

/**
 * The git lookups of one run (security review F2 and F4). Every call gets at most what is left of a
 * run-wide time budget, and lookups are cached by the realpath of the directory, so a log that names one
 * slow repository under many spellings pays for it once. Once the budget is spent, no more git runs and
 * the remaining directories count as outside a repo, with a note. Only local absolute paths are opened
 * ({@link isLocalAbsolutePath}), checked before and after realpath: on Windows a UNC path is a network connection.
 */
export class GitRun {
  private readonly budgetMs: number;
  private spentMs = 0;
  private readonly byInput = new Map<string, Promise<GitInfo | null>>();
  private readonly byReal = new Map<string, Promise<GitInfo | null>>();
  private readonly skipped = new Set<string>();
  private readonly remote = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: GitRunOptions = {}) {
    this.budgetMs = opts.budgetMs ?? GIT_RUN_BUDGET_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Repository facts for a directory, cached for the run. */
  info(dir: string): Promise<GitInfo | null> {
    let p = this.byInput.get(dir);
    if (!p) {
      p = this.resolve(dir);
      this.byInput.set(dir, p);
    }
    return p;
  }

  /** Refuses (and counts) a directory that is not a local absolute path, before any access; true when refused. */
  refuseNonLocal(dir: string): boolean {
    if (isLocalAbsolutePath(dir, this.opts.platform)) return false;
    this.remote.add(dir);
    return true;
  }

  /** The notes for the report: the budget ran out, non-local paths refused. */
  notes(): string[] {
    const out: string[] = [];
    if (this.skipped.size > 0) {
      const n = this.skipped.size;
      out.push(
        `git time budget (${Math.round(this.budgetMs / 1000)} s) ran out: ${n} ${n === 1 ? 'directory was' : 'directories were'} not looked up, so branch attribution was skipped for them and their spend shows as no repo.`,
      );
    }
    if (this.remote.size > 0) {
      const n = this.remote.size;
      out.push(
        `${n} working ${n === 1 ? 'directory is not a local absolute path' : 'directories are not local absolute paths'} (UNC, device or relative) and ${n === 1 ? 'was' : 'were'} not opened; their spend shows as no repo.`,
      );
    }
    return out;
  }

  private async resolve(dir: string): Promise<GitInfo | null> {
    if (this.refuseNonLocal(dir)) return null;
    let real: string;
    try {
      real = await (this.opts.realpath ?? realpath)(dir);
    } catch {
      return null;
    }
    // A symlink can lead to a UNC path: the resolved path must pass the same check before git or fs use it.
    if (this.refuseNonLocal(real)) return null;
    let p = this.byReal.get(real);
    if (!p) {
      p = lookup(real, (d, args) => this.git(d, args));
      this.byReal.set(real, p);
    }
    return p;
  }

  private async git(dir: string, args: string[]): Promise<string | null> {
    const left = this.budgetMs - this.spentMs;
    if (left <= 0) {
      this.skipped.add(dir);
      return null;
    }
    const t0 = this.now();
    try {
      return await runGit(dir, args, { timeoutMs: Math.min(GIT_TIMEOUT_MS, left), ...(this.opts.exec ? { exec: this.opts.exec } : {}), ...(this.opts.bin ? { bin: this.opts.bin } : {}) });
    } finally {
      this.spentMs += Math.max(0, this.now() - t0);
    }
  }
}

let current = new GitRun();

/** Starts a new run: a fresh budget and cache, and stale scratch dirs of killed runs removed. */
export async function startGitRun(opts: GitRunOptions = {}): Promise<GitRun> {
  current = new GitRun(opts);
  await cleanStaleGitScratch(os.tmpdir());
  return current;
}

/** The run in progress. */
export function currentGitRun(): GitRun {
  return current;
}

/** Repository facts for a directory, through the current run's budget and cache. */
export function gitInfo(dir: string): Promise<GitInfo | null> {
  return current.info(dir);
}

/** For tests: a fresh run with the default budget. */
export function clearGitCache(): void {
  current = new GitRun();
}

/**
 * Removes `read-receipts-git-*` scratch dirs older than an hour in `dir`: what a run killed in the
 * middle of a git call leaves behind (security review F12). Only dirs owned by this user; errors ignored.
 */
export async function cleanStaleGitScratch(dir: string, maxAgeMs = 3_600_000): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid) || Date.now() - st.mtimeMs < maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}
