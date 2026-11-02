import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeSession, toPlain } from '../src/analyze-session.js';
import { discoverSessions } from '../src/io/discover.js';
import type { SourceSession } from '../src/model.js';
import { loadPriceTable, type PriceTable } from '../src/prices/table.js';
import { claudeLines, tmpDir, writeClaudeSession } from './helpers/synth.js';

const FIX = path.resolve('test/fixtures/claude/compaction-subagent');
const SESSION = '7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5';
let prices: PriceTable;
let compaction: SourceSession;
const noRepo = async () => null;

beforeAll(async () => {
  prices = await loadPriceTable(null);
  const [s] = await discoverSessions({ claudeDir: path.dirname(FIX), codexDir: null, sinceMs: null, agent: 'claude', includeSubagents: true }).then((all) =>
    all.filter((x) => x.sessionId === SESSION),
  );
  compaction = s!;
});

describe('analyzeSession', () => {
  it('rolls subagent cost into the session and lists the subagent', async () => {
    const s = await analyzeSession(compaction, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    const mainOnly = await analyzeSession({ ...compaction, subagentFiles: [] }, { prices, maxLineBytes: 1 << 26, includeSubagents: false, gitRoot: noRepo });
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0]!.agentType).toBe('general-purpose');
    expect(s.subagents[0]!.usd).toBeGreaterThan(0);
    expect(s.cost.usd).toBeCloseTo(mainOnly.cost.usd + s.subagents[0]!.usd, 6);
  });
  it('resolves the subagent read through the parent edit, and lists each read once', async () => {
    const s = await analyzeSession(compaction, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    const sub = s.reads.filter((r) => r.threadId !== s.sessionId);
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ referenced: true, reason: 'edit' });
    expect(new Set(s.reads).size).toBe(s.reads.length);
    expect(s.readTotals.reads).toBe(s.reads.length);
    expect(s.compactions).toBe(1);
  });
  it('marks subagent request spans so attribution can inherit the parent branch', async () => {
    const s = await analyzeSession(compaction, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    expect(s.branchSpans.some((r) => r.subagent)).toBe(true);
    expect(s.branchSpans.some((r) => !r.subagent)).toBe(true);
    const total = s.branchSpans.reduce((a, r) => a + (r.usd ?? 0), 0);
    expect(total).toBeCloseTo(s.cost.usd, 9);
  });
  it('keeps no text in the result', async () => {
    const s = await analyzeSession(compaction, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    const json = JSON.stringify(toPlain(s));
    expect(json).not.toMatch(/function fn\d/);
    expect(json).not.toContain('needles');
  });
  it('counts successful edits only and finds an explicit PR link', async () => {
    const dir = await tmpDir();
    const f = await writeClaudeSession(
      dir,
      '/home/dev/shop',
      'aaaaaaaa-0000-4000-8000-000000000001',
      claudeLines(
        'aaaaaaaa-0000-4000-8000-000000000001',
        [
          { ts: '2026-10-02T10:00:00.000Z', cwd: '/home/dev/shop', branch: 'feat/x', edit: { file: '/home/dev/shop/a.ts' } },
          { ts: '2026-10-02T10:01:00.000Z', cwd: '/home/dev/shop', branch: 'feat/x', edit: { file: '/home/dev/shop/b.ts', ok: false } },
        ],
        { prUrl: 'https://github.com/acme/shop/pull/42' },
      ),
    );
    const src: SourceSession = { agent: 'claude-code', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', mainFile: f, subagentFiles: [], mtimeMs: 0, sizeBytes: 0 };
    const s = await analyzeSession(src, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    expect(s.edits).toBe(1);
    expect(s.explicitPrs).toEqual([{ number: 42, repo: 'acme/shop' }]);
    expect(s.branchSpans).toHaveLength(1);
    expect(s.branchSpans[0]).toMatchObject({ branch: 'feat/x', requests: 2 });
  });
  it('splits request spans when the branch changes halfway', async () => {
    const dir = await tmpDir();
    const id = 'aaaaaaaa-0000-4000-8000-000000000002';
    const f = await writeClaudeSession(
      dir,
      '/home/dev/shop',
      id,
      claudeLines(id, [
        { ts: '2026-10-02T10:00:00.000Z', cwd: '/home/dev/shop', branch: 'feat/a' },
        { ts: '2026-10-02T10:01:00.000Z', cwd: '/home/dev/shop', branch: 'feat/b' },
        { ts: '2026-10-02T10:02:00.000Z', cwd: '/home/dev/shop', branch: 'feat/b' },
      ]),
    );
    const s = await analyzeSession({ agent: 'claude-code', sessionId: id, mainFile: f, subagentFiles: [], mtimeMs: 0, sizeBytes: 0 }, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    expect(s.branchSpans.map((r) => [r.branch, r.requests])).toEqual([
      ['feat/a', 1],
      ['feat/b', 2],
    ]);
  });
  it('fingerprints instruction paths relative to the git root, also for a session started in a subfolder', async () => {
    const repo = await realpath(await tmpDir('rr-fp-repo-'));
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(path.join(repo, 'packages', 'web'), { recursive: true });
    await writeFile(path.join(repo, 'CLAUDE.md'), 'be terse');
    const dir = await tmpDir();
    const instructions = [{ file: path.join(repo, 'CLAUDE.md'), content: 'be terse' }];
    const mk = async (id: string, cwd: string) => {
      const f = await writeClaudeSession(dir, cwd, id, claudeLines(id, [{ ts: '2026-10-02T10:00:00.000Z', cwd }], { instructions }));
      return analyzeSession({ agent: 'claude-code', sessionId: id, mainFile: f, subagentFiles: [], mtimeMs: 0, sizeBytes: 0 }, { prices, maxLineBytes: 1 << 26, includeSubagents: true });
    };
    const atRoot = await mk('aaaaaaaa-0000-4000-8000-000000000003', repo);
    const inSub = await mk('aaaaaaaa-0000-4000-8000-000000000004', path.join(repo, 'packages', 'web'));
    expect(atRoot.fingerprint.instructions).not.toBe('-');
    expect(inSub.fingerprint.instructions).toBe(atRoot.fingerprint.instructions);
    expect(inSub.gitRoot).toBe(atRoot.gitRoot);
  });
});

describe('analyzeSession: structured output and full tool inputs', () => {
  const cwd = '/home/dev/shop';
  const id = '66666666-6666-4666-8666-666666666666';
  const CART = 'export function cartTotal(items) {\n  return items.length;\n}\n';
  const tail = (content: object[], extra: object[] = []) =>
    [
      { type: 'assistant', sessionId: id, cwd, gitBranch: 'main', version: '2.1.316', entrypoint: 'sdk-py', timestamp: '2026-10-20T09:05:00.000Z', uuid: 'u-so',
        message: { id: 'msg-so', role: 'assistant', model: 'claude-sonnet-5-5', content, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ...extra,
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';

  async function readOf(extraLines: string): Promise<boolean> {
    const dir = path.join(await tmpDir('rr-so-'), 'claude');
    await writeClaudeSession(dir, cwd, id, claudeLines(id, [{ ts: '2026-10-20T09:01:00.000Z', cwd, read: { file: `${cwd}/src/cart.ts`, content: CART } }]) + extraLines);
    const [src] = await discoverSessions({ claudeDir: dir, codexDir: null, sinceMs: null, agent: 'claude', includeSubagents: true });
    const s = await analyzeSession(src!, { prices, maxLineBytes: 1 << 26, includeSubagents: true, gitRoot: noRepo });
    return s.reads.find((r) => r.path.endsWith('src/cart.ts'))!.referenced;
  }

  it('baseline: without a later reference the read is unreferenced', async () => {
    expect(await readOf('')).toBe(false);
  });

  it('a read whose only later reference is inside a StructuredOutput input counts as referenced', async () => {
    const so = { type: 'tool_use', id: 'toolu_so', name: 'StructuredOutput', input: { findings: [{ note: 'cartTotal ignores the quantity', severity: 'high' }] } };
    expect(await readOf(tail([so]))).toBe(true);
  });

  it('a structured_output attachment payload counts as agent-authored', async () => {
    const att = { type: 'attachment', sessionId: id, cwd, gitBranch: 'main', version: '2.1.316', entrypoint: 'sdk-py', timestamp: '2026-10-20T09:06:00.000Z', uuid: 'u-att',
      attachment: { type: 'structured_output', toolUseID: 'toolu_x', data: { findings: [{ explanation: 'cartTotal sums lengths' }] } } };
    expect(await readOf(JSON.stringify(att) + '\n')).toBe(true);
  });

  it('a later Read of the same file is still not a reference', async () => {
    const again = { type: 'tool_use', id: 'toolu_again', name: 'Read', input: { file_path: `${cwd}/src/cart.ts` } };
    expect(await readOf(tail([again]))).toBe(false);
  });
});
