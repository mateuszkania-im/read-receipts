// Spec section 5, Claude rule 7: a Bash command counts as a read when its only simple command is
// cat, head, tail, nl, less or `sed -n` on exactly one path. Pipes, lists, redirects, substitutions
// and globs are never reads. A trailing `2>/dev/null` or `2>&1` is allowed.

const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'sed']);
const SHELL_META = /[|;&<>`\n\r]|\$\(/;
const GLOB = /[*?[\]{}]/;
/** Options that take a value in the next word. */
const VALUE_OPTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['head', new Set(['-n', '-c'])],
  ['tail', new Set(['-n', '-c'])],
  ['nl', new Set(['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'])],
  ['sed', new Set(['-e', '-f', '-l'])],
  ['cat', new Set()],
  ['less', new Set()],
]);

/** Splits a command into words, honouring single and double quotes. Returns null on unbalanced quotes. */
function words(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

/** A trailing stderr redirect does not change what the command shows the agent. */
const STDERR_TAIL = /\s+2>(?:\/dev\/null|&1)\s*$/;

/** Which lines of the file a Bash read showed (controller ruling: simple ranges only). */
export type BashRange =
  | { kind: 'all' }
  | { kind: 'lines'; start: number }
  | { kind: 'head'; n: number }
  | { kind: 'tail'; n: number }
  | { kind: 'unknown' };

const SED_RANGE = /^(\d+)(?:,(?:\d+|\$))?p$/;
const COUNT = /^\d+$/;

function headTailRange(prog: 'head' | 'tail', opts: Array<[string, string | null]>): BashRange {
  let range: BashRange = prog === 'head' ? { kind: 'head', n: 10 } : { kind: 'tail', n: 10 };
  for (const [flag, value] of opts) {
    let count: string | null = null;
    if (flag === '-n' && value !== null) count = value;
    else if (flag.startsWith('--lines=')) count = flag.slice('--lines='.length);
    else if (/^-n\+?\d+$/.test(flag)) count = flag.slice(2);
    else if (/^-\d+$/.test(flag)) count = flag.slice(1);
    else return { kind: 'unknown' };
    if (prog === 'tail' && count.startsWith('+') && COUNT.test(count.slice(1))) range = { kind: 'lines', start: Number(count.slice(1)) };
    else if (COUNT.test(count)) range = prog === 'head' ? { kind: 'head', n: Number(count) } : { kind: 'tail', n: Number(count) };
    else return { kind: 'unknown' };
  }
  return range;
}

export function detectBashReadSpec(command: string): { path: string; range: BashRange } | null {
  const cmd = command.trim().replace(STDERR_TAIL, '');
  if (SHELL_META.test(cmd)) return null;
  const w = words(cmd);
  if (!w || w.length < 2) return null;
  const prog = w[0]!.slice(w[0]!.lastIndexOf('/') + 1);
  if (!READERS.has(prog)) return null;
  const valueOpts = VALUE_OPTS.get(prog) ?? new Set<string>();
  const args: string[] = [];
  const opts: Array<[string, string | null]> = [];
  let sedQuiet = false;
  let sedScript: string | null = null;
  let sedScriptGiven = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith('-') && a.length > 1) {
      if (prog === 'sed' && (a === '-n' || a === '--quiet' || a === '--silent')) sedQuiet = true;
      if (prog === 'sed' && (a === '-e' || a === '-f')) {
        sedScriptGiven = true;
        if (a === '-e') sedScript = w[i + 1] ?? null;
      }
      const takesValue = valueOpts.has(a);
      opts.push([a, takesValue ? (w[i + 1] ?? null) : null]);
      if (takesValue) i++;
      continue;
    }
    args.push(a);
  }
  if (prog === 'sed') {
    if (!sedQuiet || opts.some(([flag]) => isSedInPlace(flag))) return null;
    if (!sedScriptGiven) sedScript = args.shift() ?? null;
  }
  if (args.length !== 1) return null;
  const p = args[0]!;
  if (p === '' || GLOB.test(p) || p.includes('$') || p.includes('~')) return null;

  let range: BashRange = { kind: 'all' };
  if (prog === 'head' || prog === 'tail') range = headTailRange(prog, opts);
  else if (prog === 'sed') {
    const m = sedScript !== null ? SED_RANGE.exec(sedScript) : null;
    range = m ? { kind: 'lines', start: Number(m[1]) } : { kind: 'unknown' };
  }
  return { path: p, range };
}

function isSedInPlace(flag: string): boolean {
  return flag.startsWith('--in-place') || /^-[A-Za-z]*i/.test(flag);
}

/**
 * `sed -i` (GNU or BSD, with or without `-n`) on one or more plain paths: an edit of those files.
 * Returns the paths, or null when the command is not a simple in-place sed.
 */
export function detectBashEdit(command: string): string[] | null {
  const cmd = command.trim().replace(STDERR_TAIL, '');
  if (SHELL_META.test(cmd)) return null;
  const w = words(cmd);
  if (!w || w.length < 3) return null;
  if (w[0]!.slice(w[0]!.lastIndexOf('/') + 1) !== 'sed') return null;
  let inPlace = false;
  let scriptGiven = false;
  const args: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith('-') && a.length > 1) {
      if (isSedInPlace(a)) {
        inPlace = true;
        if (a === '-i' && w[i + 1] === '') i++; // BSD: `-i ''` (empty backup suffix)
      } else if (a === '-e' || a === '-f') {
        scriptGiven = true;
        i++;
      } else if (a === '-l') i++;
      continue;
    }
    args.push(a);
  }
  if (!inPlace) return null;
  if (!scriptGiven) args.shift();
  if (args.length === 0) return null;
  if (args.some((p) => p === '' || GLOB.test(p) || p.includes('$') || p.includes('~'))) return null;
  return args;
}

export function detectBashRead(command: string): string | null {
  return detectBashReadSpec(command)?.path ?? null;
}

function countLines(s: string): number {
  if (s === '') return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

/**
 * The `ReadInfo` line fields for a Bash read that printed `stdout`. A `tail` is approximate until the
 * analysis learns the file length from another read (`fromEnd` lets it place the range then).
 */
export function bashReadLines(
  range: BashRange,
  stdout: string,
): { startLine: number; numLines: number; totalLines: number | null; approximate?: true; fromEnd?: number } {
  const n = countLines(stdout);
  switch (range.kind) {
    case 'all':
      return { startLine: 1, numLines: n, totalLines: n };
    case 'lines':
      return { startLine: range.start, numLines: n, totalLines: null };
    case 'head':
      return { startLine: 1, numLines: n, totalLines: n < range.n ? n : null };
    case 'tail':
      if (n < range.n) return { startLine: 1, numLines: n, totalLines: n };
      return { startLine: 1, numLines: n, totalLines: null, approximate: true, fromEnd: range.n };
    case 'unknown':
      return { startLine: 1, numLines: n, totalLines: null, approximate: true };
  }
}
