// The canary corpus: a synthetic session whose every free-text field carries a distinct marker (plan Task 9).

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitInfo } from '../../src/attribution/git.js';
import type { Pr, PrLookup } from '../../src/attribution/gh.js';
import { normalizePath } from '../../src/io/paths.js';
import { isWin } from './platform-path.js';
import { tmpDir } from './synth.js';

// The fixtures were logged on Linux. On win32 only drive-letter paths are local (security review F4), so
// canaryTree() moves every absolute path in the copied logs under C: (forward slashes, as JSON-safe as
// the originals) and these constants follow.
const drive = (p: string): string => (isWin() ? `C:${p}` : p);
export const CANARY_CWD = drive('/home/canary-user/acme-repo');
export const CANARY_HOME = drive('/home/canary-user');
export const CANARY_FILE_ID = 'c0ffee00-9f30-4a11-8000-00000000ca9a';
/** Matches every planted marker, the username, and the raw session file id; any case, since win32 lowercases paths. */
export const CANARY = /CANARY[_-]|canary-user|c0ffee00/i;

/** Copies the fixture into `<tmp>/claude/<slug>/` (the Claude discovery layout). */
export async function canaryTree(): Promise<{ claudeDir: string; codexDir: string }> {
  const root = await tmpDir('rr-canary-');
  const claudeDir = path.join(root, 'claude');
  const proj = path.join(claudeDir, '-home-canary-user-acme-repo');
  await mkdir(proj, { recursive: true });
  await cp(path.resolve('test/fixtures/claude/canary'), proj, { recursive: true });
  // A Codex rollout in the same repo, with an MCP call whose server name is a marker.
  const codexDir = path.join(root, 'codex');
  const day = path.join(codexDir, '2026', '10', '20');
  await mkdir(day, { recursive: true });
  await cp(path.resolve('test/fixtures/codex-canary'), day, { recursive: true });
  if (isWin()) await toDrivePaths(root);
  return { claudeDir, codexDir };
}

async function toDrivePaths(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath, e.name);
    const text = await readFile(f, 'utf8');
    await writeFile(f, text.replace(/(?<![\w:/.-])\/(home\/canary-user|etc\/CANARY_ABS)/g, 'C:/$1'));
  }
}

export const canaryPr: Pr = {
  number: 7,
  headRefName: 'feat/CANARY-BRANCH-7',
  state: 'MERGED',
  createdAt: '2026-10-19T00:00:00Z',
  mergedAt: '2026-10-21T00:00:00Z',
  closedAt: '2026-10-21T00:00:00Z',
  title: 'Cart discount CANARY_PRTITLE_9f3',
  url: 'https://github.com/canary-user/acme-repo/pull/7',
};

/** Stubs that place the canary session in a git repo with a GitHub origin and one merged PR. */
export function canaryDeps(lookup: PrLookup = { prs: [canaryPr], note: null }) {
  const root = normalizePath(CANARY_CWD);
  const info: GitInfo = { root, commonRoot: root, origin: 'git@github.com:canary-user/acme-repo.git', defaultBranch: 'main' };
  return {
    git: async (dir: string) => (dir.startsWith(CANARY_CWD) ? info : null),
    gitRoot: async (dir: string) => (dir.startsWith(CANARY_CWD) ? CANARY_CWD : null),
    listPrs: async () => lookup,
  };
}
