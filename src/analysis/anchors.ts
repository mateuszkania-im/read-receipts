// Spec 6.3: the anchors of a read are identifiers declared in its content (plus Markdown headings and
// JSON/YAML top-level keys), in order of appearance, deduped, at most 30, stoplist removed, and only
// identifier-shaped ones (plain English words never count). Read line numbers are stripped first.
// The patterns are fixed; nothing here builds a RegExp from log text.

import { STOPLIST } from './stoplist.js';

export const MAX_ANCHORS = 30;

const PATTERNS: readonly RegExp[] = [
  /\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module)\s+([A-Za-z_][A-Za-z0-9_]{3,})/g,
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_][A-Za-z0-9_]{3,})/g,
  /^#{1,3}[ \t]+(.{4,60}?)[ \t]*\r?$/gm,
  /^[ \t]{0,2}"?([A-Za-z_][A-Za-z0-9_.-]{3,})"?[ \t]*:/gm,
];

/** Claude's Read display: `<padded line number><tab or →><line>`. */
const NUMBERED = /^\s*\d+(?:\t|\u2192)/;

/** The file text of a Read result: the line-number prefix stripped when the result is shown numbered. */
export function stripLineNumbers(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  if (!NUMBERED.test(firstLine)) return text;
  return text
    .split('\n')
    .map((l) => l.replace(NUMBERED, ''))
    .join('\n');
}

/**
 * An anchor must look like an identifier, never like a plain English word: camelCase or PascalCase with
 * two humps (`tryAcquire`, `RateLimiter`), snake_case, kebab-case, or a token holding a digit or a dot
 * (`http2Agent`, `version.lock`). A Markdown heading of two or more words is kept as a phrase.
 */
export function isAnchorShaped(anchor: string): boolean {
  if (/\s/.test(anchor)) return anchor.trim().split(/\s+/).length >= 2;
  return /[a-z0-9][A-Z]/.test(anchor) || /[A-Za-z0-9][_-][A-Za-z0-9]/.test(anchor) || /\d/.test(anchor) || /[A-Za-z0-9]\.[A-Za-z0-9]/.test(anchor);
}

export function extractAnchors(raw: string): string[] {
  const content = stripLineNumbers(raw);
  const found: Array<{ at: number; anchor: string }> = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      const anchor = m[1];
      if (anchor !== undefined) found.push({ at: (m.index ?? 0) + m[0].indexOf(anchor), anchor });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { anchor } of found) {
    if (seen.has(anchor) || STOPLIST.has(anchor.toLowerCase()) || !isAnchorShaped(anchor)) continue;
    seen.add(anchor);
    out.push(anchor);
    if (out.length === MAX_ANCHORS) break;
  }
  return out;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A plain identifier is matched through the token set; anything else (a heading, `web-app`) by a whole-word search. */
export function isIdentifier(anchor: string): boolean {
  return IDENT.test(anchor);
}

// Test files (spec 6.3, rules 4 and 5). Their use rarely shows as a declared identifier: titles are
// strings and bodies are calls. These two extra needles apply only to paths that look like tests.

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_FILE = /\.(?:test|spec)\.[A-Za-z0-9]+$|^test_[^/]+\.py$|_test\.(?:py|go)$/;

/** A path that looks like a test: a `.test.`/`.spec.` file, `test_*.py`, `*_test.py|go`, or under a test directory. */
export function isTestPath(p: string): boolean {
  const segs = p.replace(/\\/g, '/').split('/');
  const base = segs[segs.length - 1] ?? '';
  return TEST_FILE.test(base) || segs.slice(0, -1).some((s) => TEST_DIRS.has(s));
}

/** The name a test file is about: `cart.test.js`, `test_cart.py`, `cart_test.go` give `cart`; null when none. */
export function testSubjectStem(p: string): string | null {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^(.+?)\.(?:test|spec)\.[A-Za-z0-9]+$/.exec(base) ?? /^test_(.+)\.py$/.exec(base) ?? /^(.+)_test\.(?:py|go)$/.exec(base);
  return m?.[1] ?? null;
}

const TEST_TITLE = /\b(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|fails))?\s*\(\s*(['"`])([^'"`$\\\n]{4,120})\1/g;

/** Multi-word titles of `it`/`test`/`describe` calls, in order, deduped, at most MAX_ANCHORS. */
export function extractTestTitles(raw: string): string[] {
  const out: string[] = [];
  for (const m of stripLineNumbers(raw).matchAll(TEST_TITLE)) {
    const title = m[2]!.trim();
    if (title.split(/\s+/).length < 2 || out.includes(title)) continue;
    out.push(title);
    if (out.length === MAX_ANCHORS) break;
  }
  return out;
}

const IMPORT_SPEC = /(?:\bfrom\s+|\bimport\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

/** Relative module specifiers a file imports (`./x`, `../src/cart.js`), in order, deduped. */
export function relativeImports(raw: string): string[] {
  const out: string[] = [];
  for (const m of stripLineNumbers(raw).matchAll(IMPORT_SPEC)) if (!out.includes(m[2]!)) out.push(m[2]!);
  return out;
}
