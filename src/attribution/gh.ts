// Optional PR lookup with the GitHub CLI (spec 6.6), only behind `--gh`: the one network use. gh is
// spawned with an argument array, no prompts, no pager and a timeout. A missing gh, no auth, a timeout
// or bad output becomes a note, never an error: attribution then stays at branch level.

import path from 'node:path';
import { defaultExec, noCwdSearch, resolveBinary, scriptOnlyBinary, spawnCwd, type ExecCallback, type ExecFn } from './exec.js';
import { isObj } from '../parse/common.js';

export interface Pr {
  number: number;
  headRefName: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  title: string;
  url: string;
}

export interface PrLookup {
  prs: Pr[];
  /** Why PRs could not be looked up (shown as a warning); null on success. */
  note: string | null;
}

export const GH_TIMEOUT_MS = 20_000;
const FIELDS = 'number,headRefName,state,createdAt,mergedAt,closedAt,title,url';
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/;

/**
 * `[HOST/]OWNER/REPO` for `gh --repo`, from an origin URL (`git@host:o/r.git`, `https://host/o/r`,
 * `ssh://git@host/o/r.git`). Anything else, or a part that could read as an option, gives null.
 */
export function originToRepo(origin: string): string | null {
  let host: string;
  let rest: string;
  const scp = /^[A-Za-z0-9_.-]+@([^:/]+):(.+)$/.exec(origin);
  if (scp) {
    host = scp[1]!;
    rest = scp[2]!;
  } else {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') return null;
    host = u.host;
    rest = u.pathname.replace(/^\/+/, '');
  }
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!HOST.test(host) || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  return `${host}/${owner}/${repo}`;
}

function nullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

function toPr(v: unknown): Pr | null {
  if (!isObj(v)) return null;
  const { number, headRefName, state, createdAt, title, url } = v;
  const mergedAt = nullableString(v.mergedAt);
  const closedAt = nullableString(v.closedAt);
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof headRefName !== 'string' || typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return null;
  if (mergedAt === undefined || closedAt === undefined) return null;
  return { number, headRefName, state, createdAt, mergedAt, closedAt, title: typeof title === 'string' ? title : '', url: typeof url === 'string' ? url : '' };
}

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

function hostOf(repo: string): string {
  return repo.slice(0, repo.indexOf('/')).replace(/:\d+$/, '').toLowerCase();
}

/**
 * The env for a gh call about `host`: no prompts, no pager, and only the tokens meant for that host.
 * GH_TOKEN / GITHUB_TOKEN are for github.com; the enterprise tokens only for the enterprise host named
 * by GH_HOST. `probe` (an auth check) gets no token at all, so it reports only stored logins.
 */
function ghEnv(host: string, probe: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', GH_SPINNER_DISABLED: '1' };
  const ghHost = (process.env.GH_HOST ?? '').toLowerCase();
  for (const k of TOKEN_VARS) {
    const enterprise = k.includes('ENTERPRISE');
    const keep = !probe && (enterprise ? host !== 'github.com' && host === ghHost : host === 'github.com');
    if (!keep) delete env[k];
  }
  return noCwdSearch(env);
}

interface GhRun {
  err: Parameters<ExecCallback>[0];
  stdout: string;
  stderr: string;
}

function runGh(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, exec: ExecFn): Promise<GhRun> {
  return new Promise((resolve) => exec(bin, args, { cwd: spawnCwd(), env, timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

/**
 * `gh pr list` for the repository behind `origin`; never throws. An origin is whatever the repository
 * (that is, the agent) set, so gh is asked about it only when its host is github.com, the GH_HOST host,
 * or a host gh is already logged in to; any other host gets a note and no PR lookup, so no token is sent
 * to a host the user did not choose.
 */
export async function listPrs(origin: string, opts: { bin?: string; timeoutMs?: number; exec?: ExecFn; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<PrLookup> {
  const repo = originToRepo(origin);
  if (repo === null) return { prs: [], note: 'origin is not a GitHub-style remote; PRs are not looked up for it' };
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? resolveBinary('gh', env, [], opts.platform);
  if (bin === null) {
    const script = scriptOnlyBinary('gh', env, opts.platform);
    if (script !== null) {
      return { prs: [], note: `gh was found only as ${path.basename(script)}, a script read-receipts does not run (no shell is used); put gh.exe on PATH. Cost stays at branch level.` };
    }
    return { prs: [], note: 'gh not found on PATH; cost stays at branch level' };
  }
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? GH_TIMEOUT_MS;
  const host = hostOf(repo);
  const ghHost = (process.env.GH_HOST ?? '').toLowerCase();

  if (host !== 'github.com' && host !== ghHost) {
    const probe = await runGh(bin, ['auth', 'status', '--hostname', host], ghEnv(host, true), timeout, exec);
    if (probe.err) return { prs: [], note: `origin host ${host} is not github.com and gh is not logged in to it; PRs are not looked up there` };
  }

  const args = ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', FIELDS];
  const { err, stdout, stderr } = await runGh(bin, args, ghEnv(host, false), timeout, exec);
  if (err) {
    if (err.code === 'ENOENT') return { prs: [], note: 'gh not found on PATH; cost stays at branch level' };
    if (err.killed) return { prs: [], note: `gh pr list timed out for ${repo}; cost stays at branch level` };
    const auth = /auth login|not logged|authentication/i.test(stderr);
    return { prs: [], note: auth ? 'gh is not logged in (run gh auth login); cost stays at branch level' : `gh pr list failed for ${repo}; cost stays at branch level` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { prs: [], note: `gh pr list gave unreadable output for ${repo}` };
  }
  if (!Array.isArray(doc)) return { prs: [], note: `gh pr list gave unreadable output for ${repo}` };
  return { prs: doc.map(toPr).filter((p): p is Pr => p !== null), note: null };
}
