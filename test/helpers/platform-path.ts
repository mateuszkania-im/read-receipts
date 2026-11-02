// Platform-aware absolute paths for tests. Fixtures are written as POSIX paths ("/repo/src/a.ts"); on
// win32 only drive-letter paths are local absolute paths (security review F4), so abs() gives "C:\repo\src\a.ts"
// there, the way Windows agents log a cwd. norm() is what the code stores after normalizePath.

import { normalizePath } from '../../src/io/paths.js';

export const isWin = (): boolean => process.platform === 'win32';

/** "/repo/a" as a local absolute path on this platform: unchanged on POSIX, "C:\repo\a" on win32. */
export function abs(posix: string): string {
  if (!isWin()) return posix;
  return `C:${posix.replace(/\//g, '\\')}`;
}

/** abs(posix) after normalizePath: unchanged on POSIX, "c:/repo/a" on win32. */
export function norm(posix: string): string {
  return normalizePath(abs(posix));
}
