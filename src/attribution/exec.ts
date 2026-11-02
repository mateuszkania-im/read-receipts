// Spawning git and gh without binary planting: the child's cwd is always the temp directory (never a
// repository a log named), the binary is resolved from PATH with `.`, relative entries and the target
// directory left out, and on Windows the current directory is never searched for executables.

import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ExecCallback = (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void;
export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
/** `execFile` with a fixed option set; injectable in tests. */
export type ExecFn = (bin: string, args: string[], opts: ExecOptions, cb: ExecCallback) => void;

/** Children started by {@link defaultExec} that have not exited yet. */
const live = new Set<ChildProcess>();
let handlersInstalled = false;

/** Kills every live child with SIGKILL (security review F12). */
export function killLiveChildren(): void {
  for (const c of live) {
    try {
      c.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** For tests: how many children are running. */
export function liveChildren(): number {
  return live.size;
}

/**
 * On exit, and on a signal that would end the process, the live children are killed first, so a git
 * blocked on a FIFO is not left behind reparented to init. The signal is then raised again with the
 * default action, so the exit status stays what it would have been.
 */
function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.once('exit', killLiveChildren);
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGALRM'];
  for (const sig of signals) {
    process.once(sig, () => {
      killLiveChildren();
      process.kill(process.pid, sig);
    });
  }
}

export const defaultExec: ExecFn = (bin, args, opts, cb) => {
  installHandlers();
  // detached: false keeps the child in our process group, so a terminal Ctrl-C reaches it too.
  // execFile passes its options on to spawn, which reads `detached`; the type leaves it out.
  const options = { ...opts, detached: false, killSignal: 'SIGKILL' as const, windowsHide: true, encoding: 'utf8' as const } as ExecFileOptionsWithStringEncoding;
  const child = execFile(bin, args, options, (err, stdout, stderr) => {
    live.delete(child);
    cb(err as Parameters<ExecCallback>[0], String(stdout), String(stderr));
  });
  live.add(child);
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function same(a: string, b: string): boolean {
  const n = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

function searchPath(name: string, env: NodeJS.ProcessEnv, exclude: string[], exts: string[], win: boolean): string | null {
  const pathVar = (win ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '' || dir === '.' || !path.isAbsolute(dir)) continue;
    if (exclude.some((x) => same(x, dir))) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
      if (win) {
        const upper = path.join(dir, name + ext);
        if (isFile(upper)) return upper;
      }
    }
  }
  return null;
}

/**
 * The absolute path of `name` on PATH, skipping empty, `.`, relative entries and `exclude`
 * (the directories a log named). Null when not found. On Windows only `.exe` is accepted: `execFile`
 * without a shell cannot run `.cmd` or `.bat` scripts (Node refuses them), and a shell is never used.
 */
export function resolveBinary(name: string, env: NodeJS.ProcessEnv = process.env, exclude: string[] = [], platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32';
  return searchPath(name, env, exclude, win ? ['.EXE'] : [''], win);
}

/** On Windows, a `.cmd` or `.bat` of `name` on PATH when there is no `.exe` (for a clear "not run" note). */
export function scriptOnlyBinary(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32' || resolveBinary(name, env, [], platform) !== null) return null;
  return searchPath(name, env, [], ['.CMD', '.BAT'], true);
}

/** The env every child gets on top of its own: no executable search in the current directory on Windows. */
export function noCwdSearch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.platform === 'win32' ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env;
}

/** The spawn directory: the temp directory, never a repository. */
export function spawnCwd(): string {
  return os.tmpdir();
}
