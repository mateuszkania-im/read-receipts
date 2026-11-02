import type { FileStats } from '../model.js';
import { regularFileChunks } from './safe-read.js';

export function newStats(): FileStats {
  return { lines: 0, badLines: 0, skippedRecords: 0, longLines: 0, deepValues: 0 };
}

const NL = 0x0a;

/**
 * Streams one JSON object per line. Never throws on content: a line that does not parse to a plain
 * object counts as `badLines` (this covers a truncated last line of a file still being written), a
 * line over `maxLineBytes` counts as `longLines` and is dropped without being buffered whole.
 * Handles CRLF and a leading UTF-8 BOM. Blank lines are ignored and not counted.
 */
export async function* streamJsonl(
  file: string,
  opts: { maxLineBytes: number },
  stats: FileStats,
): AsyncGenerator<unknown> {
  let parts: Buffer[] = [];
  let partBytes = 0;
  let tooLong = false;
  let first = true;

  function* finish(): Generator<unknown> {
    if (tooLong) {
      stats.lines++;
      stats.longLines++;
    } else if (partBytes > 0) {
      let buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, partBytes);
      if (first && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
      if (buf.length > 0 && buf[buf.length - 1] === 0x0d) buf = buf.subarray(0, buf.length - 1);
      const line = buf.toString('utf8');
      if (line.trim() !== '') {
        stats.lines++;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          value = undefined;
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) yield value;
        else stats.badLines++;
      }
    }
    first = false;
    parts = [];
    partBytes = 0;
    tooLong = false;
  }

  // Allow for a trailing CR (and a BOM on the first line) on top of the limit.
  const limit = opts.maxLineBytes + 4;
  for await (const chunk of regularFileChunks(file)) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NL, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!tooLong && end > start) {
        if (partBytes + (end - start) > limit) {
          tooLong = true;
          parts = [];
          partBytes = 0;
        } else {
          parts.push(chunk.subarray(start, end));
          partBytes += end - start;
        }
      }
      if (nl === -1) break;
      // Exact check now that the line is complete (ignoring CR and BOM).
      if (!tooLong && partBytes > opts.maxLineBytes && contentBytes(parts, partBytes, first) > opts.maxLineBytes) {
        tooLong = true;
      }
      yield* finish();
      start = nl + 1;
    }
  }
  if (!tooLong && partBytes > opts.maxLineBytes && contentBytes(parts, partBytes, first) > opts.maxLineBytes) {
    tooLong = true;
  }
  yield* finish();
}

function contentBytes(parts: Buffer[], total: number, first: boolean): number {
  let n = total;
  const head = parts[0];
  if (first && head && head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) n -= 3;
  const tail = parts[parts.length - 1];
  if (tail && tail.length > 0 && tail[tail.length - 1] === 0x0d) n -= 1;
  return n;
}
