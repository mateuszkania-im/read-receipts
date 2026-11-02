// One session, all metric passes, one streaming pass per thread file (plan Task 7). Subagent threads go
// first (deepest first), so the parent can adopt their unresolved reads by the call that spawned them.
// Only aggregates and per-read records leave this module: every `text` stays inside the passes.

import path from 'node:path';
import { CompositionPass, type Composition } from './analysis/composition.js';
import { CostAccumulator, type CostSummary } from './analysis/cost.js';
import { FingerprintPass, type Fingerprint } from './analysis/fingerprint.js';
import { ReadsPass, type CompactionRereads, type PendingRead, type ReadRecord } from './analysis/reads.js';
import { gitInfo } from './attribution/git.js';
import { newStats } from './io/jsonl.js';
import { META_MAX_BYTES, readSmallRegularFile } from './io/safe-read.js';
import type { AgentKind, FileStats, LedgerEvent, ParsedThread, PrLink, SourceSession } from './model.js';
import { parseClaudeThread } from './parse/claude.js';
import { parseCodexThread } from './parse/codex.js';
import { isObj, num, str } from './parse/common.js';
import { lookupPrice, requestCost, type PriceTable } from './prices/table.js';

/** Consecutive requests of one thread on the same cwd and branch, within an hour of the span's first request. */
export interface RequestSpan {
  ts: string;
  cwd: string | null;
  branch: string | null;
  /** Sum of the priced requests; null when none was priced. */
  usd: number | null;
  requests: number;
  /** A subagent's requests: a `HEAD` or missing branch inherits the parent's at that time. */
  subagent: boolean;
}

export interface ReadTotals {
  reads: number;
  readTokens: number;
  unreferenced: number;
  unreferencedTokens: number;
  /** Σ carried cost of the unreferenced reads whose first later request was priced. */
  unreferencedCarriedUSD: number;
  rereads: number;
  rereadsUnchanged: number;
  rereadUnchangedTokens: number;
  rereadsAfterCompaction: number;
}

export interface SessionResult {
  agent: AgentKind;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  cwd: string | null;
  entrypoint: string | null;
  version: string | null;
  cost: CostSummary;
  branchSpans: RequestSpan[];
  reads: ReadRecord[];
  readTotals: ReadTotals;
  compactions: number;
  compactionRereads: CompactionRereads;
  composition: Composition;
  fingerprint: Fingerprint;
  subagents: Array<{ threadId: string; agentType: string | null; usd: number }>;
  /** Successful edit and write calls (an edit whose result was an error does not count). */
  edits: number;
  /** Explicit PR links (`remote_session_change`), in the order seen. */
  explicitPrs: PrLink[];
  stats: FileStats;
  /** Git root of the session cwd (paths in the fingerprint are relative to it), when it still exists. */
  gitRoot: string | null;
}

export interface AnalyzeOptions {
  prices: PriceTable;
  maxLineBytes: number;
  includeSubagents: boolean;
  /** Git root of a directory; defaults to the hardened `gitInfo`. */
  gitRoot?: (dir: string) => Promise<string | null>;
}

const SPAN_MS = 60 * 60 * 1000;

interface SubagentFile {
  file: string;
  agentId: string;
  agentType: string | null;
  toolUseId: string | null;
  depth: number;
}

async function subagentMeta(file: string): Promise<SubagentFile> {
  const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
  const out: SubagentFile = { file, agentId, agentType: null, toolUseId: null, depth: 1 };
  // Only a regular file under the cap is read (security review F1): a FIFO or device would block or flood.
  const text = await readSmallRegularFile(file.replace(/\.jsonl$/, '.meta.json'), META_MAX_BYTES);
  if (text === null) return out; // No usable meta file: the thread is analysed standalone.
  try {
    const doc: unknown = JSON.parse(text);
    if (isObj(doc)) {
      out.agentType = str(doc.agentType);
      out.toolUseId = str(doc.toolUseId);
      out.depth = num(doc.spawnDepth) ?? 1;
    }
  } catch {
    // Not JSON: analysed standalone.
  }
  return out;
}

function addStats(into: FileStats, s: FileStats): void {
  into.lines += s.lines;
  into.badLines += s.badLines;
  into.skippedRecords += s.skippedRecords;
  into.longLines += s.longLines;
  into.deepValues += s.deepValues;
}

/** State shared by every thread of one session. */
class SessionState {
  readonly cost: CostAccumulator;
  readonly spans: RequestSpan[] = [];
  readonly reads = new Set<ReadRecord>();
  readonly compositions = new Map<string, CompositionPass>();
  readonly proxy: CompactionRereads = { readBefore: 0, rereadUnchangedAfter: 0, reattachedThenReread: 0 };
  /** Unresolved reads of finished subagents, by the call id that spawned them. */
  readonly pool = new Map<string, PendingRead[]>();
  compactions = 0;
  edits = 0;
  readonly explicitPrs: PrLink[] = [];
  startedAt = '';
  endedAt = '';

  constructor(readonly prices: PriceTable) {
    this.cost = new CostAccumulator(prices);
  }

  seeTs(ts: string): void {
    if (ts === '') return;
    if (this.startedAt === '' || ts < this.startedAt) this.startedAt = ts;
    if (ts > this.endedAt) this.endedAt = ts;
  }
}

interface ThreadOutcome {
  usd: number;
  pending: PendingRead[];
}

/**
 * Feeds one file's events through the passes. A file holds one thread, except a Claude main file of the
 * older layout, whose inline sidechains are threads of their own (by `threadId`).
 */
async function runThread(
  parsed: ParsedThread,
  mainThreadId: string,
  st: SessionState,
  opts: { subagent: boolean; fingerprint: FingerprintPass | null; harnessCost: boolean },
): Promise<ThreadOutcome> {
  const meta = await parsed.meta;
  const own = new CostAccumulator(st.prices);
  const reads = new Map<string, ReadsPass>();
  const editCalls = new Map<string, boolean>();
  let span: RequestSpan | null = null;
  let spanStartMs = 0;

  const readsOf = (threadId: string): ReadsPass => {
    let p = reads.get(threadId);
    if (!p) {
      p = new ReadsPass(threadId, st.prices);
      reads.set(threadId, p);
    }
    return p;
  };
  const compositionOf = (threadId: string): CompositionPass => {
    let p = st.compositions.get(threadId);
    if (!p) {
      p = new CompositionPass();
      st.compositions.set(threadId, p);
    }
    return p;
  };

  for await (const e of parsed.events as AsyncGenerator<LedgerEvent>) {
    st.seeTs(e.ts);
    const pass = readsOf(e.threadId);
    if (e.kind === 'tool_call') {
      const adopted = st.pool.get(e.callId);
      if (adopted) {
        st.pool.delete(e.callId);
        pass.adoptChildPending(e.callId, adopted);
      }
      if (e.toolClass === 'edit' || e.toolClass === 'write') editCalls.set(e.callId, true);
    } else if (e.kind === 'tool_result' && editCalls.has(e.callId)) {
      editCalls.delete(e.callId);
      if (!e.isError) st.edits++;
    } else if (e.kind === 'request') {
      st.cost.add(e);
      own.add(e);
      const usd = requestCost(e.usage, lookupPrice(st.prices, e.model));
      const ms = Date.parse(e.ts);
      const sameSpan =
        span !== null && span.cwd === e.cwd && span.branch === e.gitBranch && Number.isFinite(ms) && ms - spanStartMs < SPAN_MS && ms >= spanStartMs;
      if (span !== null && sameSpan) {
        span.requests++;
        if (usd !== null) span.usd = (span.usd ?? 0) + usd;
      } else {
        span = { ts: e.ts, cwd: e.cwd, branch: e.gitBranch, usd, requests: 1, subagent: opts.subagent || e.threadId !== mainThreadId };
        spanStartMs = Number.isFinite(ms) ? ms : 0;
        st.spans.push(span);
      }
    } else if (e.kind === 'harness_cost') {
      if (opts.harnessCost) st.cost.addHarnessCost(e.totalCostUSD);
    } else if (e.kind === 'compaction') {
      if (e.threadId === mainThreadId) st.compactions++;
    } else if (e.kind === 'injection' && e.prNumber !== undefined) {
      const link = { number: e.prNumber, repo: e.prRepo ?? null };
      if (!st.explicitPrs.some((l) => l.number === link.number && l.repo === link.repo)) st.explicitPrs.push(link);
    }
    pass.onEvent(e);
    compositionOf(e.threadId).onEvent(e);
    if (opts.fingerprint !== null && e.threadId === mainThreadId) opts.fingerprint.onEvent(e, meta);
  }
  // An edit call without a result in the file (a crash, a cut-off log) counts as made.
  st.edits += editCalls.size;

  const pending: PendingRead[] = [];
  for (const [threadId, p] of reads) {
    const r = p.finish();
    for (const rec of r.reads) st.reads.add(rec);
    st.proxy.readBefore += r.compactionRereads.readBefore;
    st.proxy.rereadUnchangedAfter += r.compactionRereads.rereadUnchangedAfter;
    st.proxy.reattachedThenReread += r.compactionRereads.reattachedThenReread;
    if (threadId === mainThreadId) pending.push(...r.pending);
  }
  return { usd: own.result().usd, pending };
}

function mergeCompositions(passes: Map<string, CompositionPass>, mainThreadId: string): Composition {
  const sources = new Map<string, { introduced: number; processed: number }>();
  let exactPromptTotal = 0;
  let main: Composition | null = null;
  for (const [threadId, p] of passes) {
    const c = p.finish();
    if (threadId === mainThreadId) main = c;
    exactPromptTotal += c.exactPromptTotal;
    for (const [k, v] of c.sources) {
      const s = sources.get(k) ?? { introduced: 0, processed: 0 };
      s.introduced += v.introduced;
      s.processed += v.processed;
      sources.set(k, s);
    }
  }
  return { sources, exactPromptFirst: main?.exactPromptFirst ?? null, exactPromptTotal, unattributedFirst: main?.unattributedFirst ?? null, lateSources: main?.lateSources ?? [] };
}

function readTotals(reads: ReadRecord[]): ReadTotals {
  const t: ReadTotals = {
    reads: 0,
    readTokens: 0,
    unreferenced: 0,
    unreferencedTokens: 0,
    unreferencedCarriedUSD: 0,
    rereads: 0,
    rereadsUnchanged: 0,
    rereadUnchangedTokens: 0,
    rereadsAfterCompaction: 0,
  };
  for (const r of reads) {
    t.reads++;
    t.readTokens += r.tokens;
    if (!r.referenced) {
      t.unreferenced++;
      t.unreferencedTokens += r.tokens;
      t.unreferencedCarriedUSD += r.carriedUSD ?? 0;
    }
    if (r.reread !== null) {
      t.rereads++;
      if (r.reread.kind === 'unchanged') {
        t.rereadsUnchanged++;
        t.rereadUnchangedTokens += r.tokens;
      }
      if (r.reread.afterCompaction) t.rereadsAfterCompaction++;
    }
  }
  return t;
}

const defaultGitRoot = async (dir: string): Promise<string | null> => (await gitInfo(dir))?.root ?? null;

export async function analyzeSession(src: SourceSession, opts: AnalyzeOptions): Promise<SessionResult> {
  const st = new SessionState(opts.prices);
  const stats = newStats();
  const subagents: SessionResult['subagents'] = [];
  const ctxBase = { maxLineBytes: opts.maxLineBytes };

  const mainStats = newStats();
  const main: ParsedThread =
    src.agent === 'codex'
      ? parseCodexThread(src.mainFile, ctxBase, mainStats)
      : parseClaudeThread(src.mainFile, { ...ctxBase, threadId: src.sessionId, parentThreadId: null, spawnedByCallId: null }, mainStats);
  const mainMeta = await main.meta;
  const gitRoot = mainMeta.cwd !== null ? await (opts.gitRoot ?? defaultGitRoot)(mainMeta.cwd) : null;

  if (src.agent === 'claude-code' && opts.includeSubagents && src.subagentFiles.length > 0) {
    const subs = await Promise.all(src.subagentFiles.map(subagentMeta));
    subs.sort((a, b) => b.depth - a.depth || (a.file < b.file ? -1 : 1));
    for (const s of subs) {
      const subStats = newStats();
      const parsed = parseClaudeThread(s.file, { ...ctxBase, threadId: s.agentId, parentThreadId: src.sessionId, spawnedByCallId: s.toolUseId }, subStats);
      const out = await runThread(parsed, s.agentId, st, { subagent: true, fingerprint: null, harnessCost: false });
      addStats(stats, subStats);
      subagents.push({ threadId: s.agentId, agentType: s.agentType, usd: out.usd });
      if (s.toolUseId !== null && out.pending.length > 0) {
        const list = st.pool.get(s.toolUseId) ?? [];
        list.push(...out.pending);
        st.pool.set(s.toolUseId, list);
      }
    }
  }

  const fingerprint = new FingerprintPass(gitRoot);
  const mainThreadId = mainMeta.threadId;
  await runThread(main, mainThreadId, st, { subagent: false, fingerprint, harnessCost: true });
  addStats(stats, mainStats);

  const reads = [...st.reads];
  return {
    agent: src.agent,
    sessionId: mainMeta.sessionId || src.sessionId,
    startedAt: st.startedAt,
    endedAt: st.endedAt,
    cwd: mainMeta.cwd,
    entrypoint: mainMeta.entrypoint,
    version: mainMeta.version,
    cost: st.cost.result(),
    branchSpans: st.spans,
    reads,
    readTotals: readTotals(reads),
    compactions: st.compactions,
    compactionRereads: st.proxy,
    composition: mergeCompositions(st.compositions, mainThreadId),
    fingerprint: fingerprint.finish(),
    subagents,
    edits: st.edits,
    explicitPrs: st.explicitPrs,
    stats,
    gitRoot,
  };
}

/** A JSON-ready copy: Maps become plain objects (keys from logs land as own data properties only). */
export function toPlain(v: unknown): unknown {
  if (v instanceof Map) {
    const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of v) Object.defineProperty(o, String(k), { value: toPlain(x), enumerable: true, writable: true, configurable: true });
    return o;
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = toPlain(x);
    return o;
  }
  return v;
}
