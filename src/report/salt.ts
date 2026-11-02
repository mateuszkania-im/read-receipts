// The per-machine salt for `--share` labels. Branch names, session ids and MCP server names become
// HMAC-SHA256 labels keyed by this salt, so they stay stable for one user across reports but cannot be
// recovered by hashing common names. Created on first use with mode 0600; never sent anywhere.

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HEX = /^[0-9a-f]+$/;

/** `$XDG_CONFIG_HOME/read-receipts/salt` when XDG_CONFIG_HOME is absolute, else `~/.config/read-receipts/salt`. */
export function saltPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, 'read-receipts', 'salt');
}

/** A `--share-salt` value: hex, at least 16 bytes. Throws a message naming the flag otherwise. */
export function parseSaltHex(s: string): string {
  const v = s.trim().toLowerCase();
  if (v.length < 32 || v.length % 2 !== 0 || !HEX.test(v)) throw new Error('--share-salt must be hex, at least 32 characters (16 bytes)');
  return v;
}

/**
 * Reads the salt file, creating it (32 random bytes as hex, mode 0600, parent 0700) when it is missing.
 * A salt anyone else could read or plant is no secret (security review F13): when the file is not a
 * regular file, is group- or world-readable, or is not owned by this user, it is replaced by a new salt
 * and `warning` says so. Labels made with the old salt then no longer match.
 */
export async function loadOrCreateSalt(file: string): Promise<{ salt: string; warning: string | null }> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const create = async (): Promise<string> => {
    const fresh = randomBytes(32).toString('hex');
    await writeFile(file, `${fresh}\n`, { mode: 0o600, flag: 'wx' });
    return fresh;
  };
  try {
    return { salt: await create(), warning: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = await lstat(file);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const posix = process.platform !== 'win32';
  const problem = !st.isFile()
    ? 'is not a regular file'
    : posix && (st.mode & 0o077) !== 0
      ? 'is readable by other users'
      : posix && uid !== null && st.uid !== uid
        ? 'is not owned by you'
        : null;
  if (problem !== null) {
    await unlink(file);
    return { salt: await create(), warning: `the share salt file ${file} ${problem}; it was replaced by a new salt, so --share labels differ from earlier reports` };
  }
  const v = (await readFile(file, 'utf8')).trim().toLowerCase();
  if (v.length < 32 || v.length % 2 !== 0 || !HEX.test(v)) throw new Error(`the share salt file ${file} is damaged; delete it to create a new salt`);
  return { salt: v, warning: null };
}
