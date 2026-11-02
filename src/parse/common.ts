// Small helpers shared by the parsers. Log content is untrusted: only typed lookups, no dynamic keys written.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePath } from '../io/paths.js';

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Obj | null {
  return isObj(v) ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Deepest nesting a log value may have before it is skipped (security review F3). */
export const MAX_JSON_DEPTH = 64;

/** Whether `v` nests arrays or objects deeper than `max` levels. Iterative, so no input can overflow the stack. */
export function depthExceeds(v: unknown, max: number = MAX_JSON_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length > 0) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d >= max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
  return false;
}

/** sha256, hex, first 16 chars. */
export function hash16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Lines that change between sessions without a harness change (spec 6.5). Leading whitespace and `- ` are ignored. */
const VOLATILE_LINE =
  /^(?:Today's date|Current date|The current date|The local time|Current time|Primary working directory|Is a git repository|Platform:|OS Version:|Shell:|Additional working directories|You are powered by|The exact model ID|Assistant knowledge cutoff)/i;
/** Where the gitStatus block ends: a Markdown heading, a tag line, or the end of the prompt. */
const BLOCK_END = /^(?:#{1,6}\s|<\/?[A-Za-z][\w-]*[\s>])/;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Absolute paths (POSIX, `~/`, Windows drive): memory, scratchpad and temp directories, the cwd. */
const ABS_PATH = /(?:~|[A-Za-z]:)?[/\\](?:[^\s`'"()<>[\]{},;]*[/\\])*[^\s`'"()<>[\]{},;.]*/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/** The system prompt with every per-session part replaced or dropped, so one harness hashes the same everywhere. */
export function normalizeSystemPrompt(text: string): string {
  const kept: string[] = [];
  let inGitStatus = false;
  for (const line of text.split('\n')) {
    const bare = line.replace(/^\s*(?:-\s+)?/, '');
    if (inGitStatus) {
      // The block holds blank lines (branch, main branch, status, recent commits): it runs to the next
      // heading or tag line, else to the end of the prompt.
      if (!BLOCK_END.test(line)) continue;
      inGitStatus = false;
    }
    if (bare.startsWith('gitStatus')) {
      inGitStatus = true;
      continue;
    }
    if (VOLATILE_LINE.test(bare)) continue;
    kept.push(line.replace(UUID_ANY, '<id>').replace(ABS_PATH, (m) => (m.length > 1 ? '<path>' : m)).replace(DATE, '<date>').replace(TIME, '<time>'));
  }
  return kept.join('\n');
}

/** Hash of a system prompt without its per-session parts (spec 6.5, {@link normalizeSystemPrompt}). */
export function stableSystemPromptHash(text: string): string {
  return hash16(normalizeSystemPrompt(text));
}

/** A tool path made absolute against the cwd it ran in (when known), then normalised. */
export function resolveAgainst(p: string, cwd: string | null): string {
  const n = normalizePath(p);
  if (n.startsWith('/') || /^[a-z]:\//i.test(n) || cwd === null) return n;
  return normalizePath(path.posix.join(normalizePath(cwd), n));
}
