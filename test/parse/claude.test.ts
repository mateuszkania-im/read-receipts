import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newStats } from '../../src/io/jsonl.js';
import { normalizePath } from '../../src/io/paths.js';
import type {
  FileStats,
  InjectionEvent,
  LedgerEvent,
  RequestEvent,
  ToolCallEvent,
  ToolResultEvent,
  UserPromptEvent,
} from '../../src/model.js';
import { parseClaudeThread } from '../../src/parse/claude.js';
import { hash16 } from '../../src/parse/common.js';

const FIX = path.resolve('test/fixtures/claude');
const SESSION = '7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5';
const AGENT = '71c7d308f94630cb0';
const basicFile = path.join(FIX, 'basic-2.1.316.jsonl');
const mainFile = path.join(FIX, 'compaction-subagent', `${SESSION}.jsonl`);
const subagentFile = path.join(FIX, 'compaction-subagent', SESSION, 'subagents', `agent-${AGENT}.jsonl`);
const subagentMeta = path.join(FIX, 'compaction-subagent', SESSION, 'subagents', `agent-${AGENT}.meta.json`);
const mcpFile = path.join(FIX, 'mcp-and-image.jsonl');
const legacyFile = path.join(FIX, 'legacy-inline-sidechain.jsonl');

const MAX = 1 << 26;

async function collect(
  file: string,
  ctx: { threadId?: string; parentThreadId?: string | null; spawnedByCallId?: string | null } = {},
  stats: FileStats = newStats(),
): Promise<LedgerEvent[]> {
  const { events } = parseClaudeThread(
    file,
    { threadId: ctx.threadId ?? 'main', parentThreadId: ctx.parentThreadId ?? null, spawnedByCallId: ctx.spawnedByCallId ?? null, maxLineBytes: MAX },
    stats,
  );
  const out: LedgerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function rawLines<T = Record<string, unknown>>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

interface RawAssistant {
  type: string;
  message?: { id?: string; model?: string; usage?: { cache_creation_input_tokens?: number } };
}

function rawCacheCreationOf(file: string, messageId: string): number {
  const line = rawLines<RawAssistant>(file).find((r) => r.type === 'assistant' && r.message?.id === messageId);
  return line?.message?.usage?.cache_creation_input_tokens ?? -1;
}

function uniqueAssistantMessageIds(file: string): number {
  const ids = new Set<string>();
  for (const r of rawLines(file) as RawAssistant[]) {
    if (r.type === 'assistant' && r.message?.model !== '<synthetic>' && r.message?.id) ids.add(r.message.id);
  }
  return ids.size;
}

const requests = (ev: LedgerEvent[]) => ev.filter((e): e is RequestEvent => e.kind === 'request');
const results = (ev: LedgerEvent[]) => ev.filter((e): e is ToolResultEvent => e.kind === 'tool_result');
const calls = (ev: LedgerEvent[]) => ev.filter((e): e is ToolCallEvent => e.kind === 'tool_call');
const injections = (ev: LedgerEvent[]) => ev.filter((e): e is InjectionEvent => e.kind === 'injection');

function toolClasses(ev: LedgerEvent[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of calls(ev)) out[c.tool] = c.toolClass;
  return out;
}

describe('parseClaudeThread: requests and usage', () => {
  it('emits one request per message.id with its usage', async () => {
    const reqs = requests(await collect(basicFile));
    expect(reqs.length).toBeGreaterThan(0);
    expect(new Set(reqs.map((r) => r.requestId)).size).toBe(reqs.length);
    expect(reqs.every((r) => r.usage !== null)).toBe(true);
    expect(reqs.length).toBe(uniqueAssistantMessageIds(basicFile));
    // The fixture has a response split over several lines with one message.id.
    const ids = rawLines<RawAssistant>(basicFile).filter((r) => r.type === 'assistant').map((r) => r.message?.id);
    expect(ids.length).toBeGreaterThan(reqs.length);
  });

  it('splits cache_creation into 5m and 1h', async () => {
    const r = requests(await collect(basicFile)).find((x) => (x.usage?.cacheWrite1h ?? 0) > 0)!;
    expect(r).toBeDefined();
    expect(r.usage!.cacheWrite1h).toBeGreaterThan(0);
    expect(r.usage!.cacheWrite5m + r.usage!.cacheWrite1h).toBe(rawCacheCreationOf(basicFile, r.requestId));
  });

  it('puts all cache_creation into 5m when there is no split', async () => {
    const r = requests(await collect(legacyFile))[0]!;
    expect(r.usage).toEqual({ input: 4, output: 90, cacheRead: 12000, cacheWrite5m: 500, cacheWrite1h: 0 });
  });

  it('carries model, cwd and branch on requests', async () => {
    const r = requests(await collect(mainFile))[0]!;
    expect(r).toMatchObject({ model: 'claude-sonnet-5-5', cwd: '/repo', gitBranch: 'fixture-branch', threadId: 'main' });
  });

  it('does not add the Agent toolUseResult.usage as a request', async () => {
    const reqs = requests(await collect(mainFile));
    expect(reqs.map((r) => r.requestId)).not.toContain(undefined);
    expect(reqs.length).toBe(uniqueAssistantMessageIds(mainFile));
  });

  it('ignores <synthetic> assistant records', async () => {
    const ev = await collect(mcpFile);
    expect(requests(ev).filter((e) => e.model === '<synthetic>')).toHaveLength(0);
    expect(requests(ev)).toHaveLength(3);
  });
});

describe('parseClaudeThread: tools and reads', () => {
  it('classifies tools', async () => {
    expect(toolClasses(await collect(basicFile))).toMatchObject({ Read: 'read', Edit: 'edit', Bash: 'bash', Grep: 'search', Glob: 'list' });
    expect(toolClasses(await collect(mainFile))).toMatchObject({ Agent: 'task', Write: 'write' });
    expect(toolClasses(await collect(legacyFile))).toMatchObject({ Task: 'task' });
    const mcp = calls(await collect(mcpFile)).find((c) => c.tool === 'mcp__docs__search')!;
    expect(mcp).toMatchObject({ toolClass: 'mcp', mcpServer: 'docs', text: 'logo size rules' });
  });

  it('fills paths and agent-authored text on tool calls', async () => {
    const ev = calls(await collect(mainFile));
    expect(ev.filter((c) => c.tool === 'Read').map((c) => c.paths)).toEqual([[normalizePath('/repo/README.md')], ['/repo/math.js'], ['/repo/math.js']]);
    expect(ev.find((c) => c.tool === 'Write')).toMatchObject({ paths: ['/repo/notes.txt'], text: 'xxx' });
    const bash = calls(await collect(mcpFile)).find((c) => c.tool === 'Bash')!;
    // Every string of the input is agent-authored text; the command is kept apart for read detection.
    expect(bash.text).toBe('cat src/logo.ts\nShow the logo module');
    expect(bash.command).toBe('cat src/logo.ts');
  });

  it('fills ReadInfo for successful Reads only', async () => {
    const ev = await collect(mainFile);
    const reads = results(ev).filter((r) => r.read);
    expect(reads.map((r) => r.read!.path)).toContain('/repo/math.js');
    expect(reads[0]!.read).toMatchObject({ startLine: 1, numLines: 4, totalLines: 4 });
    expect(reads[0]!.read!.contentHash).toMatch(/^[0-9a-f]{16}$/);
    const missing = results(ev).find((r) => r.isError);
    expect(missing).toMatchObject({ tool: 'Read', read: null }); // README.md does not exist
  });

  it('reads the subagent Read from the numbered result when there is no toolUseResult', async () => {
    const sub = results(await collect(subagentFile, { threadId: AGENT, parentThreadId: SESSION })).filter((r) => r.read);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.read).toMatchObject({ path: '/repo/math.js', startLine: 1, numLines: 4, totalLines: null });
    // Same file content as the main thread's Read of math.js (before the Edit), so the same hash.
    const main = results(await collect(mainFile)).filter((r) => r.read?.path === '/repo/math.js');
    expect(sub[0]!.read!.contentHash).toBe(main[0]!.read!.contentHash);
  });

  it('detects a Bash cat as a read, resolved against the cwd', async () => {
    const r = results(await collect(mcpFile)).find((x) => x.tool === 'Bash')!;
    expect(r.read).toMatchObject({ path: '/home/dev/app/src/logo.ts', startLine: 1, numLines: 4 });
  });

  it('Bash reads carry their line range, approximate when it cannot be known', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-bash-'));
    const f = path.join(dir, 's.jsonl');
    const line = (o: object) => JSON.stringify({ cwd: '/home/dev/app', sessionId: 's', version: '2.1.316', timestamp: '2026-11-01T10:00:00.000Z', ...o });
    const call = (id: string, command: string) =>
      line({ type: 'assistant', message: { id: `msg_${id}`, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: {} } });
    const result = (id: string, stdout: string) =>
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: stdout }] }, toolUseResult: { stdout, stderr: '' } });
    await writeFile(
      f,
      [
        call('t1', "sed -n '3,4p' src/a.ts"),
        result('t1', 'c\nd\n'),
        call('t2', 'tail -n 2 src/a.ts'),
        result('t2', 'd\ne\n'),
        call('t3', 'cat src/a.ts'),
        result('t3', 'a\nb\nc\nd\ne\n'),
      ].join('\n'),
    );
    const reads = results(await collect(f)).map((r) => r.read);
    expect(reads[0]).toMatchObject({ path: '/home/dev/app/src/a.ts', startLine: 3, numLines: 2, totalLines: null });
    expect(reads[0]!.approximate).toBeUndefined();
    expect(reads[1]).toMatchObject({ startLine: 1, numLines: 2, approximate: true, fromEnd: 2 });
    expect(reads[2]).toMatchObject({ startLine: 1, numLines: 5, totalLines: 5 });
  });

  it('does not count base64 image blocks as text', async () => {
    const ev = await collect(mcpFile);
    const r = results(ev).find((e) => e.tool === 'Read')!;
    expect(r.chars).toBeLessThan(200);
    expect(r.read).toBeNull();
    const prompt = ev.find((e): e is UserPromptEvent => e.kind === 'user_prompt')!;
    expect(prompt.chars).toBe('Check the logo against the docs.'.length);
  });
});

describe('parseClaudeThread: injections, compaction, cost', () => {
  it('emits instructions, skills_listing, system_prompt, tool_schemas and hook injections', async () => {
    const main = new Set(injections(await collect(mainFile)).map((i) => i.source));
    for (const s of ['instructions', 'skills_listing', 'system_prompt', 'tool_schemas', 'mcp_tool_schemas', 'hook'] as const) {
      expect(main).toContain(s);
    }
    // The headless why-diff bench run has no hooks or skills, but has the rest.
    const basic = new Set(injections(await collect(basicFile)).map((i) => i.source));
    for (const s of ['instructions', 'system_prompt', 'tool_schemas'] as const) expect(basic).toContain(s);
    const mcp = injections(await collect(mcpFile)).filter((i) => i.source === 'mcp_tool_schemas');
    expect(mcp.map((i) => i.name)).toEqual(['mcp__docs__search']);
  });

  it('emits prompt_snapshot injections only when their hash changes', async () => {
    const snapshots = rawLines(mainFile).filter(
      (r) => r.type === 'attachment' && (r.attachment as { type?: string }).type === 'prompt_snapshot',
    ).length;
    const sys = injections(await collect(mainFile)).filter((i) => i.source === 'system_prompt');
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.length).toBeLessThan(snapshots);
    const hashes = sys.map((i) => i.hash);
    for (let i = 1; i < hashes.length; i++) expect(hashes[i]).not.toBe(hashes[i - 1]);
  });

  it('emits one instructions injection per file, named by path', async () => {
    const inst = injections(await collect(mainFile)).filter((i) => i.source === 'instructions');
    expect(inst.map((i) => i.name)).toContain(normalizePath('/repo/CLAUDE.md'));
    expect(inst.every((i) => i.chars > 0 && /^[0-9a-f]{16}$/.test(i.hash))).toBe(true);
  });

  it('emits compaction, compaction_summary and reattached_file in order', async () => {
    const kinds = (await collect(mainFile))
      .filter((e) => e.kind === 'compaction' || (e.kind === 'injection' && ['compaction_summary', 'reattached_file'].includes(e.source)))
      .map((e) => (e.kind === 'injection' ? e.source : e.kind));
    expect(kinds.slice(0, 2)).toEqual(['compaction', 'compaction_summary']);
    expect(kinds).toContain('reattached_file');
    const c = (await collect(mainFile)).find((e) => e.kind === 'compaction');
    expect(c).toMatchObject({ trigger: 'manual', preTokens: 41267 });
    const re = injections(await collect(mainFile)).filter((i) => i.source === 'reattached_file').map((i) => i.name);
    expect(re).toEqual(['/repo/math.js', '/repo/notes.txt']);
  });

  it('emits harness_cost from cost-state', async () => {
    const costs = (await collect(basicFile)).filter((e) => e.kind === 'harness_cost');
    expect(costs).toEqual([expect.objectContaining({ totalCostUSD: 0.0383777 })]);
    const main = (await collect(mainFile)).filter((e) => e.kind === 'harness_cost');
    expect(main.map((e) => (e.kind === 'harness_cost' ? e.totalCostUSD : 0)).at(-1)).toBe(0.3545853);
  });

  it('keeps seq in line order and sets ts', async () => {
    const ev = await collect(basicFile);
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.seq).toBeGreaterThanOrEqual(ev[i - 1]!.seq);
    expect(requests(ev)[0]!.ts).toMatch(/^2026-/);
  });
});

describe('parseClaudeThread: threads and meta', () => {
  it('parses the subagent file as its own thread linked to the Agent call', async () => {
    const spawnedBy = (JSON.parse(readFileSync(subagentMeta, 'utf8')) as { toolUseId: string }).toolUseId;
    const { meta, events } = parseClaudeThread(
      subagentFile,
      { threadId: AGENT, parentThreadId: SESSION, spawnedByCallId: spawnedBy, maxLineBytes: MAX },
      newStats(),
    );
    expect(await meta).toMatchObject({
      agent: 'claude-code', sessionId: SESSION, threadId: AGENT, parentThreadId: SESSION, spawnedByCallId: spawnedBy,
      version: '2.1.316', cwd: '/repo', gitBranch: 'fixture-branch', entrypoint: 'sdk-cli', file: subagentFile,
    });
    const threads = new Set<string>();
    for await (const e of events) threads.add(e.threadId);
    expect([...threads]).toEqual([AGENT]);
    // The main thread's Agent call is the one the meta file names.
    expect(calls(await collect(mainFile)).find((c) => c.tool === 'Agent')!.callId).toBe(spawnedBy);
  });

  it('resolves meta for the main thread without iterating events', async () => {
    const { meta } = parseClaudeThread(basicFile, { threadId: 'b', parentThreadId: null, spawnedByCallId: null, maxLineBytes: MAX }, newStats());
    expect(await meta).toMatchObject({ threadId: 'b', parentThreadId: null, version: '2.1.316', cwd: '/repo', gitBranch: 'main' });
  });

  it('resolves meta with nulls for a missing file instead of throwing', async () => {
    const { meta } = parseClaudeThread(path.join(FIX, 'nope.jsonl'), { threadId: 'x', parentThreadId: null, spawnedByCallId: null, maxLineBytes: MAX }, newStats());
    expect(await meta).toMatchObject({ threadId: 'x', sessionId: 'nope', version: null, cwd: null });
  });

  it('yields legacy inline sidechain records under their own threadId', async () => {
    const ev = await collect(legacyFile, { threadId: 'legacy' });
    const side = 'sidechain:20000000-0000-4000-8000-000000000001';
    expect(new Set(ev.map((e) => e.threadId))).toEqual(new Set(['legacy', side]));
    expect(requests(ev).filter((r) => r.threadId === 'legacy')).toHaveLength(2);
    expect(requests(ev).filter((r) => r.threadId === side)).toHaveLength(2);
    expect(results(ev).find((r) => r.read)).toMatchObject({ threadId: side, read: { path: '/home/dev/legacy/src/config.ts' } });
  });

  it('counts unknown record types as skipped, not errors', async () => {
    const stats = newStats();
    await collect(mcpFile, {}, stats);
    expect(stats.skippedRecords).toBeGreaterThan(0);
    expect(stats.badLines).toBe(0);
    const basic = newStats();
    await collect(basicFile, {}, basic);
    expect(basic.skippedRecords).toBeGreaterThan(0); // api-request, atis-latch, last-prompt, ...
    expect(basic.badLines).toBe(0);
  });
});

describe('parseClaudeThread: review fixes', () => {
  async function synth(lines: object[]): Promise<LedgerEvent[]> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-claude-'));
    const f = path.join(dir, 's.jsonl');
    await writeFile(f, lines.map((o) => JSON.stringify({ cwd: '/home/dev/app', sessionId: 's', version: '2.1.316', timestamp: '2026-11-01T10:00:00.000Z', ...o })).join('\n'));
    return collect(f);
  }
  const usage = (output: number, extra: object = {}) => ({ input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100, ...extra });
  const assistant = (id: string, content: object[], u: object) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content, usage: u } });

  it('a split response takes the per-field maximum usage over its lines, and stays in order', async () => {
    const ev = await synth([
      assistant('msg_1', [{ type: 'text', text: 'hi' }], usage(1)),
      assistant('msg_1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage(40, { cache_creation_input_tokens: 7 })),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] } },
      assistant('msg_1', [{ type: 'text', text: 'more' }], usage(30)),
      assistant('msg_2', [{ type: 'text', text: 'next' }], usage(3)),
    ]);
    const reqs = requests(ev);
    expect(reqs.map((r) => r.requestId)).toEqual(['msg_1', 'msg_2']);
    expect(reqs[0]!.usage).toEqual({ input: 5, output: 40, cacheRead: 100, cacheWrite5m: 7, cacheWrite1h: 0 });
    expect(ev.map((e) => e.kind)).toEqual(['request', 'assistant_text', 'tool_call', 'tool_result', 'assistant_text', 'request', 'assistant_text']);
    expect(ev.map((e) => e.seq)).toEqual([0, 0, 1, 2, 3, 4, 4]);
  });

  it('slash-command wrappers and command output are not user prompts', async () => {
    const ev = await synth([
      { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
      { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted.</local-command-stdout>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stderr>oops</local-command-stderr>' }] } },
      { type: 'user', message: { role: 'user', content: 'a real question' } },
    ]);
    expect(ev.filter((e) => e.kind === 'user_prompt').map((e) => (e as UserPromptEvent).text)).toEqual(['a real question']);
    expect(injections(ev).map((i) => [i.source, i.name])).toEqual([
      ['other', 'slash_command'],
      ['other', 'command_output'],
      ['other', 'command_output'],
    ]);
  });

  it('the numbered Read fallback hashes the text without line numbers, approximate when a line was cut', async () => {
    const long = 'y'.repeat(2000);
    const ev = await synth([
      assistant('msg_1', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/home/dev/app/a.ts' } }, { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/home/dev/app/b.ts' } }], usage(1)),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: '     1\tconst a = 1;\n     2\tconst b = 2;' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: `1\t${long}\n2\tend` }] } },
    ]);
    const reads = results(ev).map((r) => r.read!);
    expect(reads[0]).toMatchObject({ startLine: 1, numLines: 2, contentHash: hash16('const a = 1;\nconst b = 2;') });
    expect(reads[0]!.approximate).toBeUndefined();
    expect(reads[1]!.approximate).toBe(true);
  });

  it('sed -i in Bash is an edit of the resolved path', async () => {
    const ev = await synth([assistant('msg_1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: "sed -i 's/a/b/' src/a.ts" } }], usage(1))]);
    expect(calls(ev)[0]).toMatchObject({ toolClass: 'edit', paths: [normalizePath('/home/dev/app/src/a.ts')] });
  });
});

describe('parseClaudeThread: pricing modifiers in usage', () => {
  it('carries usage.speed and usage.inference_geo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-mod-'));
    const f = path.join(dir, 's.jsonl');
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: 'fast', inference_geo: 'us' };
    await writeFile(f, `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T00:00:00Z', sessionId: 's', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [], usage } })}\n`);
    const out: LedgerEvent[] = [];
    for await (const e of parseClaudeThread(f, { threadId: 'main', parentThreadId: null, spawnedByCallId: null, maxLineBytes: 1 << 20 }, newStats()).events) out.push(e);
    const r = out.find((e) => e.kind === 'request');
    expect(r && r.kind === 'request' && r.usage).toMatchObject({ speed: 'fast', inferenceGeo: 'us' });
  });
});
