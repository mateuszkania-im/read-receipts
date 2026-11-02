import path from 'node:path';

/**
 * One spelling per file: backslashes to `/`, `.` and `..` resolved, no trailing `/`.
 * darwin: `/private/tmp/` and `/private/var/` map to `/tmp/` and `/var/`.
 * win32: lowercased (matching is case-insensitive on Windows only), a UNC `//server/share` prefix is
 * kept, and MSYS/git-bash `/c/...` becomes `c:/...`.
 */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.replace(/\\/g, '/');
  if (s === '') return s;
  const unc = platform === 'win32' && /^\/\/[^/]/.test(s);
  if (platform === 'win32') {
    const msys = /^\/([A-Za-z])(\/|$)/.exec(s);
    if (msys) s = `${msys[1]}:/${s.slice(3)}`;
  }
  s = path.posix.normalize(s);
  if (unc && !s.startsWith('//')) s = `/${s}`;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s.startsWith('./')) s = s.slice(2);
  if (platform === 'darwin') {
    if (s === '/private/tmp' || s.startsWith('/private/tmp/') || s === '/private/var' || s.startsWith('/private/var/')) {
      s = s.slice('/private'.length);
    }
  }
  if (platform === 'win32') s = s.toLowerCase();
  return s;
}

/**
 * Security review F4, as an allow-list: the only working directories read-receipts opens (stat, realpath,
 * git) are local absolute paths. On Windows that is a drive letter and a slash (`C:\\` or `C:/`); UNC
 * (`\\\\host\\share`, `//host`), device and namespace prefixes (`\\\\?\\`, `\\\\.\\`, `\\??\\`, `\\Device\\`),
 * mixed slashes, root- or drive-relative and relative paths are refused, because opening a UNC path
 * connects to a network host. Elsewhere it is a path that starts with exactly one `/`.
 * A drive letter mapped to a network share is not detected (a documented limit).
 */
export function isLocalAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return p.startsWith('/') && !p.startsWith('//');
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

/**
 * Makes an already-normalised path repo-relative when it lies under `repoRoot`.
 * A relative input is returned unchanged with `inRepo: true` (tool inputs are relative to the session cwd).
 */
export function toRepoRelative(p: string, repoRoot: string | null): { path: string; inRepo: boolean } {
  if (!isAbsoluteLike(p)) return { path: p, inRepo: true };
  if (repoRoot === null || repoRoot === '') return { path: p, inRepo: false };
  if (p === repoRoot) return { path: '.', inRepo: true };
  const prefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  if (p.startsWith(prefix)) return { path: p.slice(prefix.length), inRepo: true };
  return { path: p, inRepo: false };
}
