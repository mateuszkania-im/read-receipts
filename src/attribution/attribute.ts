// Spec 6.6: cost per repo, branch and PR. Attribution is per request span, not per session, so a session
// that switches branch or worktree halfway is split. PRs come from explicit links in the session, and with
// `--gh` from `gh pr list` matched by head branch within the PR's time window.
//
// Spans that cannot belong to a PR stay out of unmerged spend: a cwd that is not a repo ("no repo"), a
// detached HEAD or no branch ("detached"), and a cwd that no longer exists, such as a removed worktree
// ("unattributed (worktree gone)"), unless its branch still resolves to a PR through the main repo.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { RequestSpan, SessionResult } from '../analyze-session.js';
import { normalizePath } from '../io/paths.js';
import { currentGitRun, gitInfo, type GitInfo } from './git.js';
import { listPrs, originToRepo, type Pr, type PrLookup } from './gh.js';

export type BranchOutcome = 'default' | 'noPr' | 'pr' | 'noRepo' | 'detached' | 'worktreeGone';

export interface BranchRow {
  /** The main repository root (worktrees collapsed), else the cwd when it is not (or no longer) a repo. */
  repo: string;
  branch: string;
  /**
   * `noRepo`: the cwd is not a git repo. `detached`: a detached HEAD or no branch. `worktreeGone`: the cwd
   * no longer exists and no PR was found for its branch. None of these count as unmerged spend.
   */
  outcome: BranchOutcome;
  usd: number;
  sessions: number;
}

export interface PrRow {
  repo: string;
  number: number;
  /** `unknown`: an explicit PR link seen without `--gh`, so its state was not looked up. */
  state: 'merged' | 'open' | 'closedUnmerged' | 'unknown';
  usd: number;
  attempts: number;
  attemptsNoEdit: number;
  title: string;
  url: string;
  sessionIds: string[];
  /** The cost each session in `sessionIds` spent on this PR (same order). */
  sessionUsd: number[];
}

export interface Attribution {
  branches: BranchRow[];
  prs: PrRow[];
  /** Σ cost over closed-unmerged PRs and over branch requests matched to no PR (meaningful with `--gh`). */
  unmergedSpend: number;
  /** Σ cost of requests on a real, non-default branch in a repo with no known PR. */
  noPrSpend: number;
  warnings: string[];
}

export interface AttributeDeps {
  git: (dir: string) => Promise<GitInfo | null>;
  listPrs: (origin: string) => Promise<PrLookup>;
  /** Whether a directory exists (a removed worktree does not). */
  exists: (dir: string) => Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const NO_BRANCH = '(no branch)';
const NO_REPO = '(unknown repo)';

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function prState(p: Pr): PrRow['state'] {
  return p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closedUnmerged';
}

/** Subagent spans on `HEAD` or no branch take the main thread's branch (and cwd) at that time. */
function inheritBranches(spans: RequestSpan[]): RequestSpan[] {
  const main = spans.filter((s) => !s.subagent).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return spans.map((s) => {
    if (!s.subagent || (s.branch !== null && s.branch !== 'HEAD' && s.branch !== '')) return s;
    let parent: RequestSpan | undefined;
    for (const m of main) {
      if (m.ts <= s.ts) parent = m;
      else break;
    }
    parent ??= main[0];
    return parent ? { ...s, branch: parent.branch ?? s.branch, cwd: s.cwd ?? parent.cwd } : s;
  });
}

function inWindow(p: Pr, ms: number, now: Date): boolean {
  const start = Date.parse(p.createdAt) - DAY_MS;
  const endIso = p.mergedAt ?? p.closedAt;
  const end = endIso !== null ? Date.parse(endIso) : now.getTime();
  return ms >= start && ms <= end;
}

/** Whether a git origin is the `owner/name` a PR URL named. */
function originIs(origin: string | null, repo: string): boolean {
  if (origin === null) return false;
  const r = originToRepo(origin)?.toLowerCase();
  return r !== undefined && (r === repo || r.endsWith(`/${repo}`));
}

const realBranch = (b: string | null): string | null => (b === null || b === '' || b === 'HEAD' ? null : b);

interface Entry {
  s: SessionResult;
  span: RequestSpan;
  cwd: string | null;
  branch: string | null;
  info: GitInfo | null;
  /** The cwd no longer exists. */
  gone: boolean;
}

export async function attribute(
  sessions: SessionResult[],
  opts: { gh: boolean; now: Date },
  deps: Partial<AttributeDeps> = {},
): Promise<Attribution> {
  const git = deps.git ?? gitInfo;
  const exists = deps.exists ?? dirExists;
  const lookupPrs = deps.listPrs ?? ((origin: string) => listPrs(origin));
  const warnings: string[] = [];
  const prLists = new Map<string, Promise<PrLookup>>();
  const branches = new Map<string, BranchRow & { sessionSet: Set<string> }>();
  const prs = new Map<string, Omit<PrRow, 'sessionIds' | 'sessionUsd'> & { bySession: Map<string, number>; noEditSet: Set<string> }>();
  let unmergedSpend = 0;
  let noPrSpend = 0;

  const prsFor = async (origin: string | null): Promise<Pr[]> => {
    if (!opts.gh || origin === null) return [];
    let p = prLists.get(origin);
    if (!p) {
      p = lookupPrs(origin).then((r) => {
        if (r.note !== null && !warnings.includes(r.note)) warnings.push(r.note);
        return r;
      });
      prLists.set(origin, p);
    }
    return (await p).prs;
  };

  // Pass 1: the repo of every span, and whether its cwd still exists.
  const entries: Entry[] = [];
  for (const s of sessions) {
    for (const span of inheritBranches(s.branchSpans)) {
      const cwd = span.cwd ?? s.cwd;
      // Only a local absolute path is opened, not even stat-ed otherwise (security review F4).
      if (cwd !== null && currentGitRun().refuseNonLocal(cwd)) {
        entries.push({ s, span, cwd, branch: span.branch === '' ? null : span.branch, info: null, gone: false });
        continue;
      }
      const info = cwd !== null ? await git(cwd) : null;
      const gone = cwd !== null && info === null && !(await exists(cwd));
      entries.push({ s, span, cwd, branch: span.branch === '' ? null : span.branch, info, gone });
    }
  }

  // A branch name seen in exactly one repo can name the main repo of a removed worktree.
  const reposByBranch = new Map<string, Map<string, GitInfo>>();
  for (const e of entries) {
    const b = realBranch(e.branch);
    if (e.info === null || b === null) continue;
    const m = reposByBranch.get(b) ?? new Map<string, GitInfo>();
    m.set(e.info.commonRoot, e.info);
    reposByBranch.set(b, m);
  }
  const mainRepoOf = async (e: Entry): Promise<GitInfo | null> => {
    // An ancestor that is still a repo (Claude Code puts worktrees under <repo>/.claude/worktrees/).
    let dir = e.cwd !== null ? path.dirname(e.cwd) : null;
    while (dir !== null && dir !== path.dirname(dir)) {
      if (await exists(dir)) {
        const info = await git(dir);
        if (info !== null) return info;
        break;
      }
      dir = path.dirname(dir);
    }
    const b = realBranch(e.branch);
    const byBranch = b !== null ? reposByBranch.get(b) : undefined;
    if (byBranch !== undefined && byBranch.size === 1) return [...byBranch.values()][0]!;
    return null;
  };

  const firstRepo = new Map<string, string>();
  for (const e of entries) if (e.info !== null && !firstRepo.has(e.s.sessionId)) firstRepo.set(e.s.sessionId, e.info.commonRoot);

  /** The PR of a span in `info`'s repo: the last explicit link that names this repo, else gh by branch. */
  const matchPr = async (e: Entry, info: GitInfo, branch: string): Promise<{ number: number; pr: Pr | null } | null> => {
    const list = await prsFor(info.origin);
    const links = e.s.explicitPrs.filter((l) => (l.repo !== null ? originIs(info.origin, l.repo) : firstRepo.get(e.s.sessionId) === info.commonRoot));
    const explicit = links.at(-1);
    if (explicit !== undefined) return { number: explicit.number, pr: list.find((p) => p.number === explicit.number) ?? null };
    const ms = Date.parse(e.span.ts);
    const hit = list.filter((p) => p.headRefName === branch && inWindow(p, ms, opts.now)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return hit ? { number: hit.number, pr: hit } : null;
  };

  const addBranch = (repo: string, branch: string, outcome: BranchOutcome, usd: number, sessionId: string) => {
    const key = `${repo}\u0000${branch}\u0000${outcome === 'pr' || outcome === 'noPr' ? 'repo' : outcome}`;
    let b = branches.get(key);
    if (!b) {
      b = { repo, branch, outcome, usd: 0, sessions: 0, sessionSet: new Set() };
      branches.set(key, b);
    }
    b.usd += usd;
    b.sessionSet.add(sessionId);
    if (outcome === 'pr') b.outcome = 'pr';
  };

  const addPr = (repo: string, matched: { number: number; pr: Pr | null }, e: Entry, usd: number) => {
    const key = `${repo}\u0000${matched.number}`;
    let row = prs.get(key);
    if (!row) {
      const pr = matched.pr;
      row = { repo, number: matched.number, state: pr !== null ? prState(pr) : 'unknown', usd: 0, attempts: 0, attemptsNoEdit: 0, title: pr?.title ?? '', url: pr?.url ?? '', bySession: new Map(), noEditSet: new Set() };
      prs.set(key, row);
    }
    row.usd += usd;
    row.bySession.set(e.s.sessionId, (row.bySession.get(e.s.sessionId) ?? 0) + usd);
    if (e.s.edits === 0) row.noEditSet.add(e.s.sessionId);
    if (row.state === 'closedUnmerged') unmergedSpend += usd;
  };

  // Pass 2: book every span.
  const goneSessions = new Set<string>();
  for (const e of entries) {
    const usd = e.span.usd ?? 0;
    const sid = e.s.sessionId;
    const branch = realBranch(e.branch);
    const label = e.branch ?? NO_BRANCH;

    if (e.info === null) {
      if (e.gone) {
        const main = await mainRepoOf(e);
        const matched = main !== null && branch !== null ? await matchPr(e, main, branch) : null;
        if (main !== null && matched !== null) {
          addBranch(main.commonRoot, label, 'pr', usd, sid);
          addPr(main.commonRoot, matched, e, usd);
        } else {
          goneSessions.add(sid);
          addBranch(normalizePath(e.cwd!), label, 'worktreeGone', usd, sid);
        }
      } else {
        addBranch(e.cwd !== null ? normalizePath(e.cwd) : NO_REPO, label, 'noRepo', usd, sid);
      }
      continue;
    }

    const repo = e.info.commonRoot;
    if (branch === null) {
      addBranch(repo, label, 'detached', usd, sid);
      continue;
    }
    const isDefault = e.info.defaultBranch != null ? branch === e.info.defaultBranch : branch === 'main' || branch === 'master';
    if (isDefault) {
      addBranch(repo, branch, 'default', usd, sid);
      continue;
    }
    const matched = await matchPr(e, e.info, branch);
    if (matched === null) {
      addBranch(repo, branch, 'noPr', usd, sid);
      unmergedSpend += usd;
      noPrSpend += usd;
      continue;
    }
    addBranch(repo, branch, 'pr', usd, sid);
    addPr(repo, matched, e, usd);
  }

  if (goneSessions.size > 0) {
    const n = goneSessions.size;
    warnings.push(`${n} ${n === 1 ? 'session' : 'sessions'} ran in a worktree or directory that no longer exists and matched no PR: shown as unattributed (worktree gone), not as unmerged spend.`);
  }

  return {
    branches: [...branches.values()]
      .map(({ sessionSet, ...b }) => ({ ...b, sessions: sessionSet.size }))
      .sort((a, b) => b.usd - a.usd || (a.branch < b.branch ? -1 : 1)),
    prs: [...prs.values()]
      .map(({ bySession, noEditSet, ...p }) => ({ ...p, attempts: bySession.size, attemptsNoEdit: noEditSet.size, sessionIds: [...bySession.keys()], sessionUsd: [...bySession.values()] }))
      .sort((a, b) => b.usd - a.usd || a.number - b.number),
    unmergedSpend,
    noPrSpend,
    warnings,
  };
}
