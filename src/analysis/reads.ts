// Spec 6.3 and 6.4: reads, unreferenced reads, re-reads and the compaction re-read proxy, in one pass
// over one thread. Log text is only tested with Set lookups and literal searches; no RegExp is built from it.

import path from 'node:path';
import type { LedgerEvent, ReadInfo, Usage } from '../model.js';
import { cachePrices, lookupPrice, type PriceTable } from '../prices/table.js';
import { extractAnchors, extractTestTitles, isIdentifier, isTestPath, relativeImports, testSubjectStem } from './anchors.js';
import { detectBashReadSpec } from '../parse/bash-read.js';

/**
 * Spec 6.3. A read is "referenced" when an agent-authored event after it (a tool call input or assistant
 * text, in the same thread, or for a subagent's read the parent's result of that subagent and anything
 * after it) edits the file, names its full repo-relative or absolute path (a shorter path suffix or the
 * basename counts only while no other file seen in the session shares it), or uses one of its
 * identifier-shaped anchors as a whole word. Otherwise it is "unreferenced". Unreferenced includes
 * reads the agent used to rule something out without naming them again, so it does not mean the read
 * was useless; referenced includes files named only to dismiss them. A Bash read of the same file is
 * not a reference to the earlier read. A read of a test file (by its cwd-relative path) also counts as
 * referenced when a later event quotes one of its multi-word `it`/`test`/`describe` titles (reason
 * `symbol`), or edits a module it imports or the same-named source file (reason `edit-subject`).
 */
export type ReadReason = 'edit' | 'path' | 'symbol' | 'edit-subject' | null;

export interface ReadRecord {
  threadId: string;
  seq: number;
  path: string;
  tokens: number;
  referenced: boolean;
  reason: ReadReason;
  reread: null | { kind: 'unchanged' | 'changed'; afterCompaction: boolean };
  carriedUSD: number | null;
  /** The read's line range is a guess (a Bash read), so re-read hashes were not compared by range. */
  approximateRange: boolean;
}

export interface PendingRead {
  record: ReadRecord;
  needles: { path: string; basename: string | null; anchors: string[]; subject?: TestSubject | null };
}

/** For a read of a test file: the modules it imports (paths without extension) and the name it is about. */
export interface TestSubject {
  modules: string[];
  stem: string | null;
}

export interface CompactionRereads {
  /** Σ over compactions of the distinct paths read before it. */
  readBefore: number;
  /** Σ over compactions of the paths whose first read after it was an unchanged re-read. */
  rereadUnchangedAfter: number;
  /** Σ over compactions of the paths the harness re-attached after it that the agent still read again. */
  reattachedThenReread: number;
}

export interface ReadsResult {
  reads: ReadRecord[];
  pending: PendingRead[];
  compactionRereads: CompactionRereads;
}

/** t(x) = ceil(chars / 4), spec section 6. */
export function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

const IDENT_TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;
const PATH_SPLIT = /[^A-Za-z0-9_.\-/\\@+~]+/;
const WORD_CHAR = /[A-Za-z0-9_]/;

interface OpenRead {
  pending: PendingRead;
  identAnchors: string[];
  phraseAnchors: string[];
  /** The full path needles (cwd-relative and absolute), compared against whole path tokens of the event text. */
  fullPaths: string[];
  /** Shorter `/`-suffixes of the path; each counts only while no other file of the session shares it. */
  suffixes: string[];
  subject: TestSubject | null;
}

interface LastRead {
  startLine: number;
  numLines: number;
  exact: boolean;
  hash: string;
  editedSince: boolean;
  compaction: number;
}

interface SegmentRead {
  record: ReadRecord;
  /** Index in the segment's request list of the first request after the read. */
  firstRequest: number;
}

/** Cache write and read prices (USD per million) of one request, or null when it cannot be priced. */
type ReqPrice = { write: number; read: number } | null;

function isAbs(p: string): boolean {
  return p.startsWith('/') || /^[a-z]:\//i.test(p);
}

/** One file, two spellings: equal, or a relative path that is the tail of an absolute one. */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const aAbs = isAbs(a);
  if (aAbs === isAbs(b)) return false;
  const [abs, rel] = aAbs ? [a, b] : [b, a];
  return abs.endsWith(`/${rel}`);
}

/** Identifier tokens of a text, for whole-word anchor matching. */
function identTokens(text: string): Set<string> {
  return new Set(text.match(IDENT_TOKEN) ?? []);
}

/** Every path-like token of a text, as written (`./` and trailing dots dropped, `\\` as `/`), lowercased when `fold`. */
function pathTokens(text: string, fold: boolean): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(PATH_SPLIT)) {
    let t = raw.replace(/\\/g, '/').replace(/\.+$/, '').replace(/^(?:\.\/)+/, '');
    if (fold) t = t.toLowerCase();
    if (t !== '') out.add(t);
  }
  return out;
}

/** The proper `/`-suffixes of a relative path: `src/util/a.ts` gives `util/a.ts` and `a.ts`. */
function suffixesOf(rel: string): string[] {
  const out: string[] = [];
  for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
    const sfx = rel.slice(i + 1);
    if (sfx !== '') out.push(sfx);
  }
  return out;
}

/** `needle` occurs in `text` with no word character right before or after it. */
function containsWholeWord(text: string, needle: string): boolean {
  if (needle === '') return false;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = i > 0 ? text[i - 1]! : '';
    const after = text[i + needle.length] ?? '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

/** Facts about one agent-authored event, computed once and tested against every open read. */
class EventText {
  private idents: Set<string> | null = null;
  private paths: Set<string> | null = null;
  /** `fold`: Windows paths are case-insensitive, so tokens and needles are both lowercased. */
  constructor(
    readonly text: string,
    private readonly fold: boolean,
  ) {}
  hasIdent(a: string): boolean {
    this.idents ??= identTokens(this.text);
    return this.idents.has(a);
  }
  hasPath(p: string): boolean {
    this.paths ??= pathTokens(this.text, this.fold);
    return this.paths.has(this.fold ? p.toLowerCase() : p);
  }
}

function basenameNeedle(p: string): string | null {
  const b = path.posix.basename(p);
  return b.length >= 6 && b.includes('.') ? b : null;
}

function toOpen(pending: PendingRead): OpenRead {
  const anchors = pending.needles.anchors;
  return {
    pending,
    identAnchors: anchors.filter(isIdentifier),
    phraseAnchors: anchors.filter((a) => !isIdentifier(a)),
    fullPaths: [...new Set([pending.needles.path, pending.record.path])],
    suffixes: pathSuffixNeedles(pending.needles.path),
    subject: pending.needles.subject ?? null,
  };
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|rs)$/;

/** The needles of a test-file read (spec 6.3 rule 5); null for any other file. */
function testSubject(p: string, rel: string, content: string): TestSubject | null {
  if (!isTestPath(rel)) return null;
  const dir = path.posix.dirname(p.replace(/\\/g, '/'));
  const modules = relativeImports(content).map((spec) => path.posix.join(dir, spec).replace(CODE_EXT, ''));
  return { modules, stem: testSubjectStem(p) };
}

/** An edit of a module the test imports, or of a non-test file with the test's subject name. */
function editsSubject(subject: TestSubject, editPath: string): boolean {
  const e = editPath.replace(/\\/g, '/');
  const key = e.replace(CODE_EXT, '');
  if (subject.modules.some((m) => samePath(m, key) || samePath(`${m}/index`, key))) return true;
  if (subject.stem === null || isTestPath(e)) return false;
  return path.posix.basename(key) === subject.stem && CODE_EXT.test(e);
}

/** Suffixes of a read path that may stand for it: any multi-segment suffix, the basename only under the 6-char rule. */
function pathSuffixNeedles(p: string): string[] {
  const base = basenameNeedle(p);
  return suffixesOf(p.replace(/^\/+/, '')).filter((sfx) => sfx.includes('/') || sfx === base);
}

function priceOf(prices: PriceTable, model: string, usage: Usage | null): ReqPrice {
  if (usage === null) return null;
  const p = lookupPrice(prices, model);
  if (p === null) return null;
  const c = cachePrices(usage, p);
  if (c === null) return null;
  const only1h = usage.cacheWrite1h > 0 && usage.cacheWrite5m === 0;
  return { write: only1h ? c.write1h : c.write5m, read: c.read };
}

export class ReadsPass {
  private readonly reads: ReadRecord[] = [];
  private open: OpenRead[] = [];
  /** Subagent reads waiting for the parent's result of the Agent call that spawned them. */
  private readonly waiting = new Map<string, PendingRead[]>();
  private readonly lastRead = new Map<string, LastRead>();
  private readonly totalLines = new Map<string, number>();
  private cwd: string | null = null;
  /** Every `/`-suffix of the files read or edited in this thread, to the distinct paths that end with it. */
  private readonly suffixOwners = new Map<string, Set<string>>();

  private compactions = 0;
  private readonly readPaths = new Set<string>();
  private readonly seenSinceCompaction = new Set<string>();
  private readonly reattachedSinceCompaction = new Set<string>();
  private readonly countedReattached = new Set<string>();
  private readonly proxy: CompactionRereads = { readBefore: 0, rereadUnchangedAfter: 0, reattachedThenReread: 0 };

  private segRequests: ReqPrice[] = [];
  private segReads: SegmentRead[] = [];

  /** Windows paths are case-insensitive: path needles, tokens and suffix owners are compared lowercased. */
  private readonly fold: boolean;

  constructor(
    private readonly threadId: string,
    private readonly prices: PriceTable,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.fold = platform === 'win32';
  }

  /** Feed the events of this thread in `seq` order. */
  onEvent(e: LedgerEvent): void {
    switch (e.kind) {
      case 'request':
        if (e.cwd !== null) this.cwd = e.cwd;
        this.segRequests.push(priceOf(this.prices, e.model, e.usage));
        return;
      case 'compaction':
        this.endSegment();
        this.compactions++;
        this.proxy.readBefore += this.readPaths.size;
        this.seenSinceCompaction.clear();
        this.reattachedSinceCompaction.clear();
        this.countedReattached.clear();
        return;
      case 'injection':
        if (e.source === 'reattached_file' && this.compactions > 0) this.reattachedSinceCompaction.add(e.name);
        return;
      case 'tool_call': {
        if (e.toolClass === 'edit' || e.toolClass === 'write') {
          this.onEdit(e.paths);
          for (const p of e.paths) this.own(p);
        }
        // A Bash read of a file is a re-read, not a reference to the earlier read of that file.
        const bashRead = e.toolClass === 'bash' || e.toolClass === 'read' ? detectBashReadSpec(e.command ?? e.text) : null;
        const skip = bashRead !== null ? this.resolve(bashRead.path) : null;
        this.reference(new EventText(e.text, this.fold), e.toolClass === 'edit' || e.toolClass === 'write' ? e.paths : [], undefined, skip);
        return;
      }
      case 'assistant_text':
        this.reference(new EventText(e.text, this.fold), []);
        return;
      case 'tool_result': {
        const adopted = this.waiting.get(e.callId);
        if (adopted) {
          // The subagent's final answer counts for its own reads, and so does everything after it.
          this.waiting.delete(e.callId);
          const opened = adopted.map(toOpen);
          this.open.push(...opened);
          this.reference(new EventText(e.text, this.fold), [], opened);
        }
        if (e.read !== null && !e.isError) this.onRead(e.seq, e.read, e.chars, e.text);
        return;
      }
      default:
        return;
    }
  }

  /** Registers a subagent's unresolved reads; they are matched from the parent's result for `callId` onwards. */
  adoptChildPending(callId: string, pending: PendingRead[]): void {
    const list = this.waiting.get(callId) ?? [];
    list.push(...pending);
    this.waiting.set(callId, list);
    for (const p of pending) {
      this.reads.push(p.record);
      this.own(p.record.path);
    }
  }

  /** Registers a file of this thread under each of its path suffixes. */
  private own(p: string): void {
    const rel = this.relative(p).replace(/^\/+/, '');
    for (const sfx of [rel, ...suffixesOf(rel)].map((x) => (this.fold ? x.toLowerCase() : x))) {
      let set = this.suffixOwners.get(sfx);
      if (!set) {
        set = new Set();
        this.suffixOwners.set(sfx, set);
      }
      if (!set.has(p) && ![...set].some((q) => samePath(q, p))) set.add(p);
    }
  }

  private uniqueSuffix(sfx: string): boolean {
    return (this.suffixOwners.get(this.fold ? sfx.toLowerCase() : sfx)?.size ?? 0) <= 1;
  }

  /** A command path made absolute against the last request cwd, when it is relative and the cwd is known. */
  private resolve(p: string): string {
    const n = p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (isAbs(n) || this.cwd === null) return n;
    return `${this.cwd.endsWith('/') ? this.cwd.slice(0, -1) : this.cwd}/${n}`;
  }

  finish(): ReadsResult {
    this.endSegment();
    const pending = this.open.map((o) => o.pending);
    for (const list of this.waiting.values()) pending.push(...list);
    return { reads: this.reads, pending, compactionRereads: { ...this.proxy } };
  }

  private relative(p: string): string {
    const cwd = this.cwd;
    if (cwd !== null && isAbs(p)) {
      const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
      const starts = this.fold ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
      if (starts) return p.slice(prefix.length);
    }
    return p;
  }

  private onRead(seq: number, info: ReadInfo, chars: number, content: string): void {
    const p = info.path;
    let startLine = info.startLine;
    let exact = info.approximate !== true;
    const known = info.totalLines ?? this.knownLength(p);
    if (info.totalLines !== null) this.totalLines.set(p, info.totalLines);
    if (info.fromEnd !== undefined && known !== null) {
      startLine = Math.max(1, known - info.fromEnd + 1);
      exact = true;
    }

    const prev = this.findLast(p);
    let reread: ReadRecord['reread'] = null;
    if (prev) {
      const sameRange = exact && prev.last.exact && prev.last.startLine === startLine && prev.last.numLines === info.numLines;
      const changed = prev.last.editedSince || (sameRange && prev.last.hash !== info.contentHash);
      reread = { kind: changed ? 'changed' : 'unchanged', afterCompaction: this.compactions > prev.last.compaction };
    }

    if (this.compactions > 0) {
      const firstSince = ![...this.seenSinceCompaction].some((s) => samePath(s, p));
      if (firstSince && prev && prev.last.compaction < this.compactions && reread?.kind === 'unchanged') this.proxy.rereadUnchangedAfter++;
      this.seenSinceCompaction.add(p);
      for (const r of this.reattachedSinceCompaction) {
        if (samePath(r, p) && !this.countedReattached.has(r)) {
          this.countedReattached.add(r);
          this.proxy.reattachedThenReread++;
        }
      }
    }

    const record: ReadRecord = {
      threadId: this.threadId,
      seq,
      path: p,
      tokens: estTokens(chars),
      referenced: false,
      reason: null,
      reread,
      carriedUSD: 0,
      approximateRange: !exact,
    };
    this.reads.push(record);
    this.segReads.push({ record, firstRequest: this.segRequests.length });
    if (prev) this.lastRead.delete(prev.key);
    this.lastRead.set(p, { startLine, numLines: info.numLines, exact, hash: info.contentHash, editedSince: false, compaction: this.compactions });
    if (![...this.readPaths].some((s) => samePath(s, p))) this.readPaths.add(p);
    this.own(p);

    const rel = this.relative(p);
    const subject = testSubject(p, rel, content);
    const anchors = subject === null ? extractAnchors(content) : [...extractAnchors(content), ...extractTestTitles(content)];
    this.open.push(toOpen({ record, needles: { path: rel, basename: basenameNeedle(rel), anchors, subject } }));
  }

  private knownLength(p: string): number | null {
    for (const [k, v] of this.totalLines) if (samePath(k, p)) return v;
    return null;
  }

  private findLast(p: string): { key: string; last: LastRead } | null {
    const direct = this.lastRead.get(p);
    if (direct) return { key: p, last: direct };
    for (const [k, v] of this.lastRead) if (samePath(k, p)) return { key: k, last: v };
    return null;
  }

  private onEdit(paths: string[]): void {
    for (const ep of paths) for (const [k, v] of this.lastRead) if (samePath(k, ep)) v.editedSince = true;
  }

  /** Tests one agent-authored event against the open reads (or only `only`); referenced reads leave the open list. */
  private reference(ev: EventText, editPaths: string[], only?: OpenRead[], notPathOf: string | null = null): void {
    const candidates = only ?? this.open;
    let hit = false;
    for (const o of candidates) {
      const skipPath = notPathOf !== null && samePath(o.pending.record.path, notPathOf);
      const reason = this.match(o, ev, editPaths, skipPath);
      if (reason === null) continue;
      o.pending.record.referenced = true;
      o.pending.record.reason = reason;
      hit = true;
    }
    if (hit) this.open = this.open.filter((o) => !o.pending.record.referenced);
  }

  private match(o: OpenRead, ev: EventText, editPaths: string[], skipPath: boolean): ReadReason {
    const rec = o.pending.record;
    if (editPaths.some((p) => samePath(p, rec.path) || samePath(p, o.pending.needles.path))) return 'edit';
    if (!skipPath) {
      if (o.fullPaths.some((p) => p !== '' && ev.hasPath(p))) return 'path';
      if (o.suffixes.some((sfx) => ev.hasPath(sfx) && this.uniqueSuffix(sfx))) return 'path';
    }
    if (o.identAnchors.some((a) => ev.hasIdent(a))) return 'symbol';
    if (o.phraseAnchors.some((a) => containsWholeWord(ev.text, a))) return 'symbol';
    const subject = o.subject;
    if (subject !== null && editPaths.some((p) => editsSubject(subject, p))) return 'edit-subject';
    return null;
  }

  /** Settles carried cost (spec 6.3) for the reads of the segment that just ended. */
  private endSegment(): void {
    const m = this.segRequests.length;
    for (const { record, firstRequest } of this.segReads) {
      if (firstRequest >= m) {
        record.carriedUSD = 0;
        continue;
      }
      const p = this.segRequests[firstRequest] ?? null;
      record.carriedUSD = p === null ? null : (record.tokens * (p.write + (m - 1 - firstRequest) * p.read)) / 1e6;
    }
    this.segRequests = [];
    this.segReads = [];
  }
}
