// Discover, analyse one session at a time (bounded memory), attribute, aggregate (plan Task 8).

import path from 'node:path';
import { compare } from './aggregate/compare.js';
import { analyzeSession, type SessionResult } from './analyze-session.js';
import { attribute, type AttributeDeps } from './attribution/attribute.js';
import { scriptOnlyBinary } from './attribution/exec.js';
import { gitInfo, startGitRun } from './attribution/git.js';
import { discoverSessions } from './io/discover.js';
import { newStats } from './io/jsonl.js';
import { normalizePath, toRepoRelative } from './io/paths.js';
import type { SourceSession, ThreadMeta, Usage } from './model.js';
import type { ReadRecord } from './analysis/reads.js';
import { parseClaudeThread } from './parse/claude.js';
import { parseCodexThread } from './parse/codex.js';
import { loadPriceTable } from './prices/table.js';
import { likelyUnused } from './analysis/study.js';
import { addUsage, isLowerBound, zeroUsage } from './analysis/usage.js';
import type { CompositionRow, FileRow, ReadRow, Report, ReportOptions, SessionRow, Totals } from './report/types.js';
import { VERSION } from './version.js';
import { DEFINITIONS } from './report/definitions.js';

export const TOP_READS_PER_SESSION = 50;

export { DEFINITIONS } from './report/definitions.js';
const TOP_FILES = 10;
const TOP_SESSIONS = 5;

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Claude's project folder name: the cwd with every non-alphanumeric character as `-`. */
function claudeSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

function inside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/**
 * With `--project`, a Claude session file is opened only if its project folder name could belong to one
 * of the projects, so sessions of other folders are never read at all.
 */
function mayBelong(src: SourceSession, projects: string[]): boolean {
  if (projects.length === 0 || src.agent !== 'claude-code') return true;
  const folder = path.basename(path.dirname(src.mainFile));
  return projects.some((p) => projectFolderMatches(folder, path.resolve(p)));
}

/**
 * Whether a Claude project folder can belong to the (resolved) project path: its slug, or a subfolder's.
 * Windows paths are case-insensitive, so the comparison is too there.
 */
export function projectFolderMatches(folder: string, project: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const slug = fold(claudeSlug(project));
  const f = fold(folder);
  return f === slug || f.startsWith(`${slug}-`);
}

async function metaOf(src: SourceSession, maxLineBytes: number): Promise<ThreadMeta> {
  return src.agent === 'codex'
    ? parseCodexThread(src.mainFile, { maxLineBytes }, newStats()).meta
    : parseClaudeThread(src.mainFile, { threadId: src.sessionId, parentThreadId: null, spawnedByCallId: null, maxLineBytes }, newStats()).meta;
}

function compositionRows(m: Map<string, { introduced: number; processed: number }>): CompositionRow[] {
  return [...m]
    .map(([source, v]) => ({ source, introduced: v.introduced, processed: v.processed }))
    .sort((a, b) => b.processed - a.processed || b.introduced - a.introduced || (a.source < b.source ? -1 : 1));
}

/** The reads kept past analysis: the top unreferenced by tokens, or all of them (for `session <id>`). */
function keptReads(reads: ReadRecord[], keepAll: boolean): ReadRecord[] {
  if (keepAll) return reads;
  return reads
    .filter((r) => !r.referenced)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_READS_PER_SESSION);
}

/** A session row; `s.reads` has already been trimmed by {@link keptReads}. */
function toRow(s: SessionResult): SessionRow {
  const root = s.gitRoot;
  const relative = (p: string) => toRepoRelative(p, root);
  const kept: ReadRow[] = s.reads.map((r) => {
    const rel = relative(r.path);
    return {
      threadId: r.threadId,
      seq: r.seq,
      path: rel.path,
      inRepo: rel.inRepo,
      referenced: r.referenced,
      reason: r.reason,
      reread: r.reread,
      approximateRange: r.approximateRange,
      estimated: { estimated: true, tokens: r.tokens, carriedUSD: r.carriedUSD },
    };
  });
  const t = s.readTotals;
  const c = s.cost;
  return {
    agent: s.agent,
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    cwd: s.cwd,
    repo: root,
    entrypoint: s.entrypoint,
    version: s.version,
    cost: {
      usd: c.usd,
      lowerBound: isLowerBound(c),
      requests: c.requests,
      requestsMissingUsage: c.requestsMissingUsage,
      requestsUnpriced: c.requestsUnpriced,
      unpricedModels: c.unpricedModels,
      requestsUnpricedModifier: c.requestsUnpricedModifier,
      unpricedModifiers: c.unpricedModifiers,
      requestsApproxWritePrice: c.requestsApproxWritePrice,
      byModel: [...c.byModel].map(([model, v]) => ({ model, usd: v.usd, usage: v.usage })).sort((a, b) => b.usd - a.usd),
      usage: c.usage,
      cacheHitShare: c.cacheHitShare,
      harnessUSD: c.harnessUSD,
      unloggedUSD: c.unloggedUSD,
      priceMismatch: c.priceMismatch,
    },
    branchSpans: s.branchSpans,
    readCounts: { total: t.reads, unreferenced: t.unreferenced, rereads: t.rereads, rereadsUnchanged: t.rereadsUnchanged, rereadsAfterCompaction: t.rereadsAfterCompaction },
    rereadRate: ratio(t.rereads, t.reads),
    reads: kept,
    readsOmitted: s.readTotals.reads - kept.length,
    compactions: s.compactions,
    compactionRereads: s.compactionRereads,
    compactionRereadRate: ratio(s.compactionRereads.rereadUnchangedAfter, s.compactionRereads.readBefore),
    fingerprint: s.fingerprint,
    subagents: s.subagents,
    edits: s.edits,
    explicitPrs: s.explicitPrs,
    estimated: {
      estimated: true,
      readTokens: t.readTokens,
      unreferencedTokens: t.unreferencedTokens,
      unreferencedTokenShare: ratio(t.unreferencedTokens, t.readTokens),
      unreferencedCarriedUSD: t.unreferencedCarriedUSD,
      rereadUnchangedTokens: t.rereadUnchangedTokens,
      composition: compositionRows(s.composition.sources),
      exactPromptFirst: s.composition.exactPromptFirst,
      exactPromptTotal: s.composition.exactPromptTotal,
      unattributedFirst: s.composition.unattributedFirst,
      lateSources: s.composition.lateSources,
    },
  };
}

/** Running totals, updated per session before its read list is trimmed. */
class TotalsBuilder {
  sessions = 0;
  byAgent = { 'claude-code': 0, codex: 0 };
  from: string | null = null;
  to: string | null = null;
  requests = 0;
  usd = 0;
  missing = 0;
  unpriced = 0;
  readonly unpricedModels = new Set<string>();
  unpricedModifier = 0;
  readonly unpricedModifiers = new Set<string>();
  approxWrites = 0;
  readonly byModel = new Map<string, { usd: number; usage: Usage }>();
  readonly usage = zeroUsage();
  harness = 0;
  harnessSeen = false;
  unlogged = 0;
  unloggedSeen = false;
  mismatches = 0;
  reads = 0;
  readTokens = 0;
  unref = 0;
  unrefTokens = 0;
  carried = 0;
  rereads = 0;
  rereadsUnchanged = 0;
  rereadsAfter = 0;
  rereadUnchangedTokens = 0;
  compactions = 0;
  readBefore = 0;
  rereadAfter = 0;
  reattached = 0;
  subagents = 0;
  subagentUSD = 0;
  readonly composition = new Map<string, { introduced: number; processed: number }>();
  readonly unrefFiles = new Map<string, { count: number; tokens: number }>();
  readonly rereadFiles = new Map<string, number>();
  readonly top: Totals['topSessions'] = [];
  readonly files = newStats();

  add(s: SessionResult): void {
    this.sessions++;
    this.byAgent[s.agent]++;
    if (s.startedAt !== '' && (this.from === null || s.startedAt < this.from)) this.from = s.startedAt;
    if (s.endedAt !== '' && (this.to === null || s.endedAt > this.to)) this.to = s.endedAt;
    const c = s.cost;
    this.requests += c.requests;
    this.usd += c.usd;
    this.missing += c.requestsMissingUsage;
    this.unpriced += c.requestsUnpriced;
    for (const m of c.unpricedModels) this.unpricedModels.add(m);
    this.unpricedModifier += c.requestsUnpricedModifier;
    for (const m of c.unpricedModifiers) this.unpricedModifiers.add(m);
    this.approxWrites += c.requestsApproxWritePrice;
    for (const [model, v] of c.byModel) {
      const b = this.byModel.get(model) ?? { usd: 0, usage: zeroUsage() };
      b.usd += v.usd;
      addUsage(b.usage, v.usage);
      this.byModel.set(model, b);
    }
    addUsage(this.usage, c.usage);
    if (c.harnessUSD !== null) {
      this.harness += c.harnessUSD;
      this.harnessSeen = true;
    }
    if (c.unloggedUSD !== null) {
      this.unlogged += c.unloggedUSD;
      this.unloggedSeen = true;
    }
    if (c.priceMismatch) this.mismatches++;
    const t = s.readTotals;
    this.reads += t.reads;
    this.readTokens += t.readTokens;
    this.unref += t.unreferenced;
    this.unrefTokens += t.unreferencedTokens;
    this.carried += t.unreferencedCarriedUSD;
    this.rereads += t.rereads;
    this.rereadsUnchanged += t.rereadsUnchanged;
    this.rereadsAfter += t.rereadsAfterCompaction;
    this.rereadUnchangedTokens += t.rereadUnchangedTokens;
    this.compactions += s.compactions;
    this.readBefore += s.compactionRereads.readBefore;
    this.rereadAfter += s.compactionRereads.rereadUnchangedAfter;
    this.reattached += s.compactionRereads.reattachedThenReread;
    this.subagents += s.subagents.length;
    for (const a of s.subagents) this.subagentUSD += a.usd;
    for (const [k, v] of s.composition.sources) {
      const b = this.composition.get(k) ?? { introduced: 0, processed: 0 };
      b.introduced += v.introduced;
      b.processed += v.processed;
      this.composition.set(k, b);
    }
    const repoName = s.gitRoot !== null ? path.posix.basename(s.gitRoot) : null;
    for (const r of s.reads) {
      const rel = toRepoRelative(r.path, s.gitRoot);
      const key = rel.inRepo && repoName !== null ? `${repoName}/${rel.path}` : rel.path;
      if (!r.referenced) {
        const f = this.unrefFiles.get(key) ?? { count: 0, tokens: 0 };
        f.count++;
        f.tokens += r.tokens;
        this.unrefFiles.set(key, f);
      }
      if (r.reread !== null) this.rereadFiles.set(key, (this.rereadFiles.get(key) ?? 0) + 1);
    }
    this.top.push({ sessionId: s.sessionId, usd: c.usd, lowerBound: isLowerBound(c), startedAt: s.startedAt, repo: s.gitRoot });
    this.top.sort((a, b) => b.usd - a.usd);
    if (this.top.length > TOP_SESSIONS) this.top.length = TOP_SESSIONS;
    this.files.lines += s.stats.lines;
    this.files.badLines += s.stats.badLines;
    this.files.skippedRecords += s.stats.skippedRecords;
    this.files.longLines += s.stats.longLines;
    this.files.deepValues += s.stats.deepValues;
  }

  build(unmergedSpend: number | null, noPrSpend: number): Totals {
    const u = this.usage;
    const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    const topUnref: FileRow[] = [...this.unrefFiles]
      .map(([p, v]) => ({ path: p, count: v.count, estimated: { estimated: true as const, tokens: v.tokens } }))
      .sort((a, b) => b.estimated.tokens - a.estimated.tokens || (a.path < b.path ? -1 : 1))
      .slice(0, TOP_FILES);
    return {
      sessions: this.sessions,
      sessionsByAgent: this.byAgent,
      period: { from: this.from, to: this.to },
      requests: this.requests,
      usd: this.usd,
      lowerBound: isLowerBound({ requestsMissingUsage: this.missing, requestsUnpriced: this.unpriced, requestsUnpricedModifier: this.unpricedModifier }),
      requestsMissingUsage: this.missing,
      requestsUnpriced: this.unpriced,
      unpricedModels: [...this.unpricedModels].sort(),
      requestsUnpricedModifier: this.unpricedModifier,
      unpricedModifiers: [...this.unpricedModifiers].sort(),
      requestsApproxWritePrice: this.approxWrites,
      byModel: [...this.byModel].map(([model, v]) => ({ model, usd: v.usd, usage: v.usage })).sort((a, b) => b.usd - a.usd),
      cacheHitShare: ratio(u.cacheRead, prompt),
      harnessUSD: this.harnessSeen ? this.harness : null,
      unloggedUSD: this.unloggedSeen ? this.unlogged : null,
      sessionsWithPriceMismatch: this.mismatches,
      readCounts: { total: this.reads, unreferenced: this.unref, rereads: this.rereads, rereadsUnchanged: this.rereadsUnchanged, rereadsAfterCompaction: this.rereadsAfter },
      unreferencedReadRate: ratio(this.unref, this.reads),
      rereadRate: ratio(this.rereads, this.reads),
      compactions: this.compactions,
      compactionRereadRate: ratio(this.rereadAfter, this.readBefore),
      reattachedThenReread: this.reattached,
      subagents: this.subagents,
      subagentUSD: this.subagentUSD,
      subagentCostShare: ratio(this.subagentUSD, this.usd),
      unmergedSpend,
      noPrSpend,
      topSessions: this.top,
      topRereadFiles: [...this.rereadFiles]
        .map(([p, count]) => ({ path: p, count }))
        .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
        .slice(0, TOP_FILES),
      files: this.files,
      estimated: {
        estimated: true,
        readTokens: this.readTokens,
        unreferencedTokens: this.unrefTokens,
        unreferencedTokenShare: ratio(this.unrefTokens, this.readTokens),
        unreferencedCarriedUSD: this.carried,
        likelyUnused: likelyUnused(this.unref),
        rereadUnchangedTokens: this.rereadUnchangedTokens,
        composition: compositionRows(this.composition),
        topUnreferencedFiles: topUnref,
      },
    };
  }
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Injection points for tests and the sample report: git, gh and the git-root lookup. */
export interface PipelineDeps extends Partial<AttributeDeps> {
  gitRoot?: (dir: string) => Promise<string | null>;
}

export async function buildReport(opts: ReportOptions, deps: PipelineDeps = {}): Promise<Report> {
  const prices = await loadPriceTable(opts.pricesPath);
  // One git budget and cache per report (security review F2); stale scratch dirs of killed runs go (F12).
  const gitRun = await startGitRun();
  const maxLineBytes = Math.max(1, Math.floor(opts.maxLineMb * 1024 * 1024));
  const sinceMs = opts.since !== null ? Date.parse(opts.since) : null;
  const warnings: string[] = [];
  const searched = [opts.agent !== 'codex' ? opts.claudeDir : null, opts.agent !== 'claude' ? opts.codexDir : null].filter((d): d is string => d !== null);

  const sources = (await discoverSessions({ claudeDir: opts.claudeDir, codexDir: opts.codexDir, sinceMs, agent: opts.agent, includeSubagents: opts.includeSubagents }))
    .filter((s) => mayBelong(s, opts.projects))
    .filter((s) => opts.sessionPrefix === null || s.agent === 'codex' || s.sessionId.startsWith(opts.sessionPrefix));

  const totals = new TotalsBuilder();
  const kept: SessionResult[] = [];
  for (const src of sources) {
    if (opts.projects.length > 0) {
      const cwd = (await metaOf(src, maxLineBytes)).cwd;
      if (cwd === null || !opts.projects.some((p) => inside(cwd, path.resolve(p)))) continue;
    }
    const s = await analyzeSession(src, { prices, maxLineBytes, includeSubagents: opts.includeSubagents, ...(deps.gitRoot ? { gitRoot: deps.gitRoot } : {}) });
    if (opts.sessionPrefix !== null && !s.sessionId.startsWith(opts.sessionPrefix)) continue;
    if (opts.since !== null && s.endedAt !== '' && s.endedAt < opts.since) continue;
    if (opts.until !== null && s.startedAt !== '' && s.startedAt > opts.until) continue;
    totals.add(s);
    // Only the top unreferenced reads stay in memory past this point.
    s.reads = keptReads(s.reads, opts.sessionPrefix !== null);
    kept.push(s);
  }

  const att = await attribute(kept, { gh: opts.gh, now: new Date(opts.now) }, { git: deps.git ?? gitInfo, ...(deps.listPrs ? { listPrs: deps.listPrs } : {}) });
  warnings.push(...att.warnings, ...gitRun.notes());
  const gitScript = scriptOnlyBinary('git');
  if (gitScript !== null) warnings.push(`git was found only as ${path.basename(gitScript)}, a script read-receipts does not run (no shell is used); put git.exe on PATH. Sessions count as outside a repo.`);
  // Without --gh no PR state is known, so unmerged spend cannot be told apart from work in progress.
  const t = totals.build(opts.gh ? att.unmergedSpend : null, att.noPrSpend);
  if (t.requestsMissingUsage > 0 || t.requestsUnpriced > 0) {
    const parts = [];
    if (t.requestsMissingUsage > 0) parts.push(`${fmtCount(t.requestsMissingUsage)} requests without usage`);
    if (t.requestsUnpriced > 0) parts.push(`${fmtCount(t.requestsUnpriced)} unpriced (${t.unpricedModels.join(', ')})`);
    warnings.push(`cost excludes ${parts.join(' / ')}; totals are lower bounds. Add prices with --prices <file.json>.`);
  }
  if (t.requestsUnpricedModifier > 0) {
    warnings.push(`cost excludes ${fmtCount(t.requestsUnpricedModifier)} requests with an unpriced modifier (${t.unpricedModifiers.join(', ')}); totals are lower bounds.`);
  }
  if (t.requestsApproxWritePrice > 0) {
    warnings.push(`${fmtCount(t.requestsApproxWritePrice)} requests have cache writes priced at the input price (no write price on the vendor page): approximate.`);
  }
  if (t.sessionsWithPriceMismatch > 0) warnings.push(`${t.sessionsWithPriceMismatch} sessions cost more by the price table than Claude Code's own total: the table may be off.`);
  if (t.files.badLines > 0) warnings.push(`${fmtCount(t.files.badLines)} unreadable lines skipped (a session still being written ends in a partial line).`);
  if (t.files.longLines > 0) warnings.push(`${fmtCount(t.files.longLines)} lines over --max-line-mb skipped.`);
  if (t.files.deepValues > 0) warnings.push(`${fmtCount(t.files.deepValues)} JSON values nested deeper than 64 levels skipped.`);
  if (opts.gh === false && att.branches.some((b) => b.outcome === 'noPr')) {
    warnings.push('PRs were not looked up (no --gh): unmerged spend is unknown, and branches without an explicit PR link count as noPr.');
  }

  const rows = kept.map(toRow);
  return {
    schemaVersion: 1,
    redacted: false,
    definitions: DEFINITIONS,
    generatedAt: opts.now,
    toolVersion: VERSION,
    options: opts,
    searched,
    totals: t,
    sessions: rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)),
    branches: att.branches,
    prs: att.prs,
    compare: opts.compare !== null ? compare(kept, att.prs, opts.compare) : null,
    warnings,
  };
}
