// The aggregate report (spec section 8). Renderers only ever see this object, never events or text.
// Every estimated number sits under an `estimated` object that carries `estimated: true`.

import type { CompareOptions, CompareRow } from '../aggregate/compare.js';
import type { RequestSpan } from '../analyze-session.js';
import type { Fingerprint } from '../analysis/fingerprint.js';
import type { LikelyUnused } from '../analysis/study.js';
import type { BranchRow, PrRow } from '../attribution/attribute.js';
import type { AgentKind, FileStats, PrLink, Usage } from '../model.js';

export interface ReportOptions {
  claudeDir: string | null;
  codexDir: string | null;
  /** ISO timestamps; sessions outside the window are dropped (files by mtime before they are opened). */
  since: string | null;
  until: string | null;
  /** Keep only sessions whose cwd is inside one of these directories (empty: all). */
  projects: string[];
  agent: 'claude' | 'codex' | 'all';
  includeSubagents: boolean;
  pricesPath: string | null;
  gh: boolean;
  maxLineMb: number;
  compare: CompareOptions | null;
  /** Keep every read (not only the top 50 unreferenced) for sessions whose id starts with this. */
  sessionPrefix: string | null;
  /** ISO time the report is built at (open PR windows end here). */
  now: string;
}

export interface EstimatedTokens {
  estimated: true;
  tokens: number;
}

export interface CompositionRow {
  source: string;
  /** Exact output tokens for `assistant_output`, ≈ chars / 4 for everything else. */
  introduced: number;
  processed: number;
}

export interface ReadRow {
  threadId: string;
  seq: number;
  /** Repo-relative when the file is under the session's git root. */
  path: string;
  inRepo: boolean;
  referenced: boolean;
  reason: 'edit' | 'path' | 'symbol' | 'edit-subject' | null;
  reread: null | { kind: 'unchanged' | 'changed'; afterCompaction: boolean };
  approximateRange: boolean;
  estimated: { estimated: true; tokens: number; carriedUSD: number | null };
}

/** Read counts (spec 6.3, 6.4). `reads` in this schema always names a list of read rows, never a count. */
export interface ReadCounts {
  total: number;
  unreferenced: number;
  rereads: number;
  rereadsUnchanged: number;
  rereadsAfterCompaction: number;
}

export interface SessionRow {
  agent: AgentKind;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  cwd: string | null;
  repo: string | null;
  entrypoint: string | null;
  version: string | null;
  cost: {
    usd: number;
    /** usd is a lower bound: some requests had no usage or an unpriced model. */
    lowerBound: boolean;
    requests: number;
    requestsMissingUsage: number;
    requestsUnpriced: number;
    unpricedModels: string[];
    requestsUnpricedModifier: number;
    unpricedModifiers: string[];
    requestsApproxWritePrice: number;
    byModel: Array<{ model: string; usd: number; usage: Usage }>;
    usage: Usage;
    cacheHitShare: number | null;
    harnessUSD: number | null;
    unloggedUSD: number | null;
    priceMismatch: boolean;
  };
  branchSpans: RequestSpan[];
  readCounts: ReadCounts;
  rereadRate: number | null;
  /** The reads kept in the report: the top 50 unreferenced by tokens, or all of them for `session <id>`. */
  reads: ReadRow[];
  readsOmitted: number;
  compactions: number;
  compactionRereads: { readBefore: number; rereadUnchangedAfter: number; reattachedThenReread: number };
  compactionRereadRate: number | null;
  fingerprint: Fingerprint;
  subagents: Array<{ threadId: string; agentType: string | null; usd: number }>;
  edits: number;
  explicitPrs: PrLink[];
  estimated: {
    estimated: true;
    readTokens: number;
    unreferencedTokens: number;
    unreferencedTokenShare: number | null;
    unreferencedCarriedUSD: number;
    rereadUnchangedTokens: number;
    composition: CompositionRow[];
    exactPromptFirst: number | null;
    exactPromptTotal: number;
    /** Labelled "unattributed (before first snapshot)" when lateSources is not empty. */
    unattributedFirst: number | null;
    lateSources: string[];
  };
}

export interface FileRow {
  path: string;
  count: number;
  estimated: EstimatedTokens;
}

export interface Totals {
  sessions: number;
  sessionsByAgent: { 'claude-code': number; codex: number };
  period: { from: string | null; to: string | null };
  requests: number;
  usd: number;
  lowerBound: boolean;
  requestsMissingUsage: number;
  requestsUnpriced: number;
  unpricedModels: string[];
  requestsUnpricedModifier: number;
  unpricedModifiers: string[];
  requestsApproxWritePrice: number;
  byModel: Array<{ model: string; usd: number; usage: Usage }>;
  cacheHitShare: number | null;
  harnessUSD: number | null;
  unloggedUSD: number | null;
  sessionsWithPriceMismatch: number;
  readCounts: ReadCounts;
  unreferencedReadRate: number | null;
  rereadRate: number | null;
  compactions: number;
  compactionRereadRate: number | null;
  reattachedThenReread: number;
  subagents: number;
  subagentUSD: number;
  subagentCostShare: number | null;
  /** Closed-unmerged PRs plus branch spend with no PR; null without `--gh` (PR states unknown). */
  unmergedSpend: number | null;
  /** Spend on real, non-default branches in a repo with no known PR (no PR link, or none found by gh). */
  noPrSpend: number;
  topSessions: Array<{ sessionId: string; usd: number; lowerBound: boolean; startedAt: string; repo: string | null }>;
  topRereadFiles: Array<{ path: string; count: number }>;
  files: FileStats;
  estimated: {
    estimated: true;
    readTokens: number;
    unreferencedTokens: number;
    unreferencedTokenShare: number | null;
    unreferencedCarriedUSD: number;
    /** likely unused ≈ unreferenced × the configured v1 first-sample precision (spec 6.3); null when no study numbers are configured. */
    likelyUnused: LikelyUnused | null;
    rereadUnchangedTokens: number;
    composition: CompositionRow[];
    topUnreferencedFiles: FileRow[];
  };
}

export interface Report {
  schemaVersion: 1;
  /** True after `--share`: paths, branch names, ids and text are redacted (spec 9.6). */
  redacted: boolean;
  /** What the read metrics mean, carried with every report. */
  definitions: { unreferenced: string; referenced: string };
  generatedAt: string;
  toolVersion: string;
  options: ReportOptions;
  /** Directories searched, for the "no sessions found" message. */
  searched: string[];
  totals: Totals;
  sessions: SessionRow[];
  branches: BranchRow[];
  prs: PrRow[];
  compare: CompareRow[] | null;
  warnings: string[];
}
