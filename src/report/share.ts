// `--share` (spec 9.6): one pass over the aggregate report, before any renderer sees it. Keeps numbers,
// model and built-in tool names, repo basenames, repo-relative paths, PR numbers and states,
// fingerprint hashes and dates. Drops absolute paths (outside every session root they become
// `<outside-repo>`), the home directory and username, cwd values, PR titles and URLs, and free text.
// Branch names become `branch-<6 hex>`, session and thread ids `s-<8 hex>` and MCP server names
// `server-<6 hex>`, tool names that are not built in `tool-<6 hex>`: HMAC-SHA256 keyed by the per-machine salt (src/report/salt.ts), so one user's labels
// are stable across reports but cannot be recovered by hashing common names. Model and built-in tool
// names stay. Hashed fingerprint components get a keyed 12-hex label the same way. A working directory that
// is not a repo becomes `r-<6 hex>` and no path under it is kept; log dirs show as `default` or `custom`;
// version, entrypoint and originator are kept only from fixed lists. Pure: returns a new object.

import { createHmac } from 'node:crypto';
import path from 'node:path';
import { normalizePath } from '../io/paths.js';
import { UNOBSERVED, type Fingerprint } from '../analysis/fingerprint.js';
import type { CompositionRow, FileRow, ReadRow, Report, SessionRow } from './types.js';

export interface ShareOptions {
  /** The home directory of the user who made the report. */
  home: string;
  /** Hex key for the HMAC labels (the per-machine salt, or `--share-salt`). */
  salt: string;
  /** The default Claude and Codex log dirs: a searched dir equal to one shows as `default`, any other as `custom`. */
  defaultDirs?: string[];
}

export const OUTSIDE_REPO = '<outside-repo>';
const NO_BRANCH = '(no branch)';
/** Built-in tool names of Claude Code and Codex: kept under `--share`. Any other tool name may be private. */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code
  'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Grep', 'Glob', 'LS',
  'Task', 'Agent', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Skill', 'SlashCommand', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  'ToolSearch', 'Monitor', 'SendMessage', 'TaskStop', 'TaskOutput', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'LSP',
  // Codex
  'shell', 'local_shell', 'exec', 'exec_command', 'write_stdin', 'unified_exec', 'apply_patch', 'update_plan', 'view_image', 'web_search',
  'read_file', 'list_dir', 'grep_files', 'unknown',
]);
const BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'output-style-setup']);
/** Security review F7: only a plain `X.Y.Z` version, and only known entrypoints (Claude) and originators (Codex), are kept. */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const KNOWN_ENTRYPOINTS: ReadonlySet<string> = new Set([
  // Claude Code `entrypoint`
  'cli', 'sdk-cli', 'sdk-py', 'sdk-ts', 'claude-vscode', 'claude-desktop', 'claude-code-github-action', 'remote', 'mcp',
  // Codex `originator`
  'codex_cli_rs', 'codex_vscode', 'codex_exec', 'codex_sdk_ts', 'codex-tui',
]);
const OTHER = 'other';
const keepKnown = (v: string | null, ok: (x: string) => boolean): string | null => (v === null ? null : ok(v) ? v : OTHER);

/** The first `hexChars` of HMAC-SHA256(salt, `<kind>\0<value>`); the kind keeps label spaces apart. */
export function hmacLabel(salt: string, kind: 'branch' | 'session' | 'mcp' | 'tool' | 'fingerprint' | 'repo', value: string, hexChars: number): string {
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(`${kind}\0${value}`).digest('hex').slice(0, hexChars);
}

type HashedPart = Exclude<keyof Fingerprint, 'model'>;
const HASHED_PARTS: readonly HashedPart[] = ['instructions', 'skills', 'hooks', 'mcp', 'systemPrompt', 'fingerprint'];

class Labels {
  constructor(private readonly salt: string) {}
  session = (id: string): string => `s-${hmacLabel(this.salt, 'session', id, 8)}`;
  branch = (b: string): string => (b === NO_BRANCH ? b : `branch-${hmacLabel(this.salt, 'branch', b, 6)}`);
  /** A working directory that is not (or no longer) a repo: its name may be private, so it gets a label (F6). */
  dirLabel = (d: string): string => `r-${hmacLabel(this.salt, 'repo', d, 6)}`;
  /**
   * A hashed fingerprint component (plain sha256 of names, paths and digests, guessable from common
   * names) becomes a keyed label of the same length. One-to-one per salt, so compare groups still match.
   */
  fingerprintPart = (component: HashedPart, value: string): string =>
    value === UNOBSERVED ? value : hmacLabel(this.salt, 'fingerprint', `${component}\0${value}`, 12);
  fingerprint = (f: Fingerprint): Fingerprint => {
    const out: Fingerprint = { ...f };
    for (const k of HASHED_PARTS) out[k] = this.fingerprintPart(k, f[k]);
    return out;
  };
  /** A composition source: `mcp:<server>` gets a server label, a non-built-in tool a tool label; the rest stays. */
  source = (src: string): string => {
    if (src.startsWith('mcp:')) return `mcp:server-${hmacLabel(this.salt, 'mcp', src.slice('mcp:'.length), 6)}`;
    if (src.startsWith('tool_result:')) {
      const tool = src.slice('tool_result:'.length);
      return BUILTIN_TOOLS.has(tool) ? src : `tool_result:tool-${hmacLabel(this.salt, 'tool', tool, 6)}`;
    }
    return src;
  };
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.includes('/../') || rel.endsWith('/..') || rel.startsWith('~');
}

class Redactor {
  readonly home: string;
  readonly user: string;
  /** Absolute session roots (repo, else cwd), longest first: what is scrubbed from warnings. */
  private readonly roots: string[];
  /** Git roots only: the only roots a path may be kept relative to (F6). */
  private readonly repoRoots: string[];
  private readonly defaultDirs: Set<string>;
  private readonly secrets: string[];

  constructor(r: Report, opts: ShareOptions) {
    this.home = normalizePath(opts.home);
    this.user = path.posix.basename(this.home);
    const roots = new Set<string>();
    const repoRoots = new Set<string>();
    const secrets = new Set<string>();
    for (const s of r.sessions) if (s.repo !== null) repoRoots.add(normalizePath(s.repo));
    for (const b of r.branches) if (isAbsoluteLike(b.repo) && (b.outcome !== 'noRepo' && b.outcome !== 'worktreeGone')) repoRoots.add(normalizePath(b.repo));
    for (const t of r.totals.topSessions) if (t.repo !== null) repoRoots.add(normalizePath(t.repo));
    this.defaultDirs = new Set((opts.defaultDirs ?? []).map((d) => normalizePath(d)));
    for (const s of r.sessions) {
      if (s.repo !== null) roots.add(normalizePath(s.repo));
      if (s.cwd !== null) roots.add(normalizePath(s.cwd));
      for (const b of s.branchSpans) {
        if (b.cwd !== null) roots.add(normalizePath(b.cwd));
        if (b.branch !== null) secrets.add(b.branch);
      }
      secrets.add(s.sessionId);
      for (const a of s.subagents) secrets.add(a.threadId);
    }
    for (const b of r.branches) {
      if (isAbsoluteLike(b.repo)) roots.add(normalizePath(b.repo));
      secrets.add(b.branch);
    }
    for (const p of r.prs) {
      secrets.add(p.title);
      secrets.add(p.url);
    }
    for (const t of r.totals.topSessions) if (t.repo !== null) roots.add(normalizePath(t.repo));
    for (const c of r.totals.estimated.composition) {
      if (c.source.startsWith('mcp:')) secrets.add(c.source.slice('mcp:'.length));
      else if (c.source.startsWith('tool_result:') && !BUILTIN_TOOLS.has(c.source.slice('tool_result:'.length))) secrets.add(c.source.slice('tool_result:'.length));
    }
    this.roots = [...roots].filter((x) => x !== '' && x !== '/' && x !== this.home).sort((a, b) => b.length - a.length);
    this.repoRoots = [...repoRoots].filter((x) => x !== '' && x !== '/' && x !== this.home).sort((a, b) => b.length - a.length);
    for (const root of this.roots) secrets.add(root);
    if (this.home !== '' && this.home !== '/') secrets.add(this.home);
    if (this.user.length >= 3) secrets.add(this.user);
    secrets.delete(NO_BRANCH);
    this.secrets = [...secrets].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
  }

  /** A directory as a label: its basename, or `~` for the home directory and its ancestors. */
  name(dir: string | null): string | null {
    if (dir === null) return null;
    const d = normalizePath(dir);
    if (d === '' || d === '/' || /^[a-z]:$/i.test(d)) return OUTSIDE_REPO;
    if (this.home !== '' && (d === this.home || this.home.startsWith(`${d}/`))) return '~';
    const base = path.posix.basename(d);
    return this.user.length >= 3 ? base.split(this.user).join('~') : base;
  }

  /** A log directory (options, searched dirs): `default` or `custom`, never the path (F8). */
  dir(p: string): string {
    return this.defaultDirs.has(normalizePath(p)) ? 'default' : 'custom';
  }

  /** A path relative to `root` when it lies under it, else null. */
  private under(p: string, root: string | null): string | null {
    if (root === null) return null;
    const r = normalizePath(root);
    if (r === '' || r === '/' || r === this.home) return null;
    return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
  }

  /** A read row's path: kept when repo-relative, else `<outside-repo>`. Outside a repo nothing is kept (F6). */
  readPath(row: ReadRow, s: SessionRow): { path: string; inRepo: boolean } {
    if (s.repo === null) return { path: OUTSIDE_REPO, inRepo: false };
    const p = normalizePath(row.path);
    if (!isAbsoluteLike(p)) return escapesRoot(p) || !row.inRepo ? { path: OUTSIDE_REPO, inRepo: false } : { path: p, inRepo: true };
    const rel = this.under(p, s.repo);
    return rel !== null && !escapesRoot(rel) ? { path: rel, inRepo: true } : { path: OUTSIDE_REPO, inRepo: false };
  }

  /** A totals file key (`<repo basename>/<path>`, or an absolute path when there was no repo). */
  filePath(key: string): string {
    const p = normalizePath(key);
    if (!isAbsoluteLike(p)) {
      if (escapesRoot(p)) return OUTSIDE_REPO;
      const [first, ...rest] = p.split('/');
      return this.user.length >= 3 && first === this.user ? ['~', ...rest].join('/') : p;
    }
    for (const root of this.repoRoots) {
      const rel = this.under(p, root);
      if (rel !== null && !escapesRoot(rel)) return `${this.name(root)}/${rel}`;
    }
    return OUTSIDE_REPO;
  }

  /** Code-written warnings can name a repo owner, a host or a path: those parts are replaced. */
  warning(w: string): string {
    let out = w
      .replace(/\bfor [A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g, 'for <repo>')
      .replace(/\bhost [^\s;,]+/g, 'host <host>')
      .replace(/(?:[A-Za-z]:)?\/(?:[^\s,;)'"/]+\/?)+/g, '<path>');
    for (const s of this.secrets) out = out.split(s).join('<redacted>');
    return out;
  }
}

function mergeFiles<T extends { path: string; count: number }>(rows: T[], add: (into: T, row: T) => void): T[] {
  const by = new Map<string, T>();
  for (const r of rows) {
    const prev = by.get(r.path);
    if (prev === undefined) by.set(r.path, r);
    else add(prev, r);
  }
  return [...by.values()];
}

function mergeComposition(rows: CompositionRow[], label: (s: string) => string): CompositionRow[] {
  const by = new Map<string, CompositionRow>();
  for (const c of rows) {
    const source = label(c.source);
    const prev = by.get(source);
    if (prev === undefined) by.set(source, { ...c, source });
    else {
      prev.introduced += c.introduced;
      prev.processed += c.processed;
    }
  }
  return [...by.values()];
}

export function shareReport(r: Report, opts: ShareOptions): Report {
  const x = new Redactor(r, opts);
  const L = new Labels(opts.salt);
  const by = r.options.compare !== null && r.options.compare.splitAt === null ? (r.options.compare.by ?? 'fingerprint') : null;
  const compareGroup = (g: string): string => (by !== null && by !== 'model' ? L.fingerprintPart(by, g) : g);
  const hashSession = L.session;
  const hashBranch = L.branch;
  const t = r.totals;

  const sessions: SessionRow[] = r.sessions.map((s) => ({
    ...s,
    sessionId: hashSession(s.sessionId),
    cwd: null,
    repo: x.name(s.repo),
    entrypoint: keepKnown(s.entrypoint, (v) => KNOWN_ENTRYPOINTS.has(v)),
    version: keepKnown(s.version, (v) => VERSION.test(v)),
    cost: { ...s.cost, unpricedModels: [...s.cost.unpricedModels], unpricedModifiers: [...s.cost.unpricedModifiers], byModel: s.cost.byModel.map((m) => ({ ...m, usage: { ...m.usage } })), usage: { ...s.cost.usage } },
    branchSpans: s.branchSpans.map((b) => ({ ...b, cwd: null, branch: b.branch === null ? null : hashBranch(b.branch) })),
    readCounts: { ...s.readCounts },
    reads: s.reads.map((row) => ({ ...row, threadId: hashSession(row.threadId), ...x.readPath(row, s), reread: row.reread === null ? null : { ...row.reread }, estimated: { ...row.estimated } })),
    compactionRereads: { ...s.compactionRereads },
    fingerprint: L.fingerprint(s.fingerprint),
    subagents: s.subagents.map((a) => ({ threadId: hashSession(a.threadId), agentType: a.agentType === null ? null : BUILTIN_AGENT_TYPES.has(a.agentType) ? a.agentType : 'custom', usd: a.usd })),
    // The owner of a linked PR is a username: only the repo name is kept.
    explicitPrs: s.explicitPrs.map((l) => ({ number: l.number, repo: l.repo === null ? null : (l.repo.split('/').at(-1) ?? null) })),
    estimated: { ...s.estimated, composition: mergeComposition(s.estimated.composition, L.source), lateSources: [...s.estimated.lateSources] },
  }));

  const unref: FileRow[] = mergeFiles(
    t.estimated.topUnreferencedFiles.map((f) => ({ path: x.filePath(f.path), count: f.count, estimated: { estimated: true as const, tokens: f.estimated.tokens } })),
    (a, b) => {
      a.count += b.count;
      a.estimated.tokens += b.estimated.tokens;
    },
  ).sort((a, b) => b.estimated.tokens - a.estimated.tokens || (a.path < b.path ? -1 : 1));
  const reread = mergeFiles(
    t.topRereadFiles.map((f) => ({ path: x.filePath(f.path), count: f.count })),
    (a, b) => {
      a.count += b.count;
    },
  ).sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));

  return {
    ...r,
    redacted: true,
    definitions: { ...r.definitions },
    options: {
      ...r.options,
      claudeDir: r.options.claudeDir === null ? null : x.dir(r.options.claudeDir),
      codexDir: r.options.codexDir === null ? null : x.dir(r.options.codexDir),
      projects: r.options.projects.map((p) => x.name(p) ?? OUTSIDE_REPO),
      pricesPath: r.options.pricesPath === null ? null : path.posix.basename(normalizePath(r.options.pricesPath)),
      compare: r.options.compare === null ? null : { ...r.options.compare },
      sessionPrefix: null,
    },
    searched: r.searched.map((d) => x.dir(d)),
    totals: {
      ...t,
      sessionsByAgent: { ...t.sessionsByAgent },
      period: { ...t.period },
      unpricedModels: [...t.unpricedModels],
      unpricedModifiers: [...t.unpricedModifiers],
      byModel: t.byModel.map((m) => ({ ...m, usage: { ...m.usage } })),
      topSessions: t.topSessions.map((s) => ({ ...s, sessionId: hashSession(s.sessionId), repo: x.name(s.repo) })),
      topRereadFiles: reread,
      files: { ...t.files },
      estimated: { ...t.estimated, composition: mergeComposition(t.estimated.composition, L.source), topUnreferencedFiles: unref },
    },
    sessions,
    branches: r.branches.map((b) => ({
      ...b,
      repo: b.outcome === 'noRepo' || b.outcome === 'worktreeGone' ? L.dirLabel(b.repo) : isAbsoluteLike(b.repo) ? (x.name(b.repo) ?? OUTSIDE_REPO) : b.repo,
      branch: hashBranch(b.branch),
    })),
    prs: r.prs.map((p) => ({ ...p, repo: isAbsoluteLike(p.repo) ? (x.name(p.repo) ?? OUTSIDE_REPO) : p.repo, title: '', url: '', sessionIds: p.sessionIds.map(hashSession), sessionUsd: [...p.sessionUsd] })),
    compare: r.compare === null ? null : r.compare.map((c) => ({ ...c, group: compareGroup(c.group) })),
    warnings: r.warnings.map((w) => x.warning(w)),
  };
}
