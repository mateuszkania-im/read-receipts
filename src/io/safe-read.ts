// Security review F1: a file named by the session layout (a subagent's meta.json and the like) may be a
// FIFO, a device or a symlink to one. It is read only when it is a regular file under a size cap: lstat
// first (no symlinks), then open without following links and without blocking, and check the open
// handle again, so a swap between the two steps is caught too.

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/** Cap for a subagent's `.meta.json`: a few hundred bytes in practice. */
export const META_MAX_BYTES = 1024 * 1024;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

/** The text of `file` when it is a regular file of at most `maxBytes`, else null. Never throws. */
export async function readSmallRegularFile(file: string, maxBytes: number): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const fh = await open(file, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    try {
      const again = await fh.stat();
      if (!again.isFile() || again.size > maxBytes || again.ino !== st.ino) return null;
      const buf = Buffer.alloc(Number(again.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * The chunks of a session log, or nothing when it is not a regular file (a FIFO or device swapped in
 * after discovery, or a symlink). Opened without following links and without blocking.
 */
export async function* regularFileChunks(file: string): AsyncGenerator<Buffer> {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    return;
  }
  try {
    if (!(await fh.stat()).isFile()) return;
    for await (const chunk of fh.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) yield chunk;
  } finally {
    await fh.close();
  }
}
