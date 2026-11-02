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
  ThreadMeta,
  ToolCallEvent,
  ToolResultEvent,
  UserPromptEvent,
} from '../../src/model.js';
import { parseCodexThread } from '../../src/parse/codex.js';

const FIX = path.resolve('test/fixtures/codex');
const MAX = 1 << 26;

async function collect(rel: string, stats: FileStats = newStats()): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const e of parseCodexThread(path.join(FIX, rel), { maxLineBytes: MAX }, stats).events) out.push(e);
  return out;
}

function meta(rel: string): Promise<ThreadMeta> {
  return parseCodexThread(path.join(FIX, rel), { maxLineBytes: MAX }, newStats()).meta;
}

const requests = (ev: LedgerEvent[]) => ev.filter((e): e is RequestEvent => e.kind === 'request');
const results = (ev: LedgerEvent[]) => ev.filter((e): e is ToolResultEvent => e.kind === 'tool_result');
const calls = (ev: LedgerEvent[]) => ev.filter((e): e is ToolCallEvent => e.kind === 'tool_call');
const injections = (ev: LedgerEvent[]) => ev.filter((e): e is InjectionEvent => e.kind === 'injection');
const prompts = (ev: LedgerEvent[]) => ev.filter((e): e is UserPromptEvent => e.kind === 'user_prompt');

const CART = 'export function cartTotal(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n';

describe('parseCodexThread: 0.162 rollout', () => {
  it('normalises usage: input excludes cached tokens', async () => {
    const r = requests(await collect('rollout-0.162.jsonl'))[0]!;
    expect(r.usage).toEqual({ input: 1200 - 1000, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0, output: 300 });
    expect(r.model).toBe('gpt-6-astra');
    expect(r.requestId).toBe('resp_0001');
    expect(r).toMatchObject({ cwd: '/home/dev/shop', gitBranch: 'feat/cart' });
  });

  it('emits one request per token_usage_record and ignores token_count when records exist', async () => {
    expect(requests(await collect('rollout-0.162.jsonl')).map((r) => r.requestId)).toEqual(['resp_0001', 'resp_0002', 'resp_0003']);
  });

  it('reads come from parsed_cmd type read', async () => {
    const reads = results(await collect('rollout-0.162.jsonl')).filter((r) => r.read);
    expect(reads.map((r) => r.read!.path)).toEqual([normalizePath('/home/dev/shop/src/cart.ts'), normalizePath('/home/dev/shop/src/cart.ts')]);
    expect(reads[0]!.read!.contentHash).toBe(reads[1]!.read!.contentHash);
    expect(reads[0]!.read).toMatchObject({ startLine: 1, numLines: 3, totalLines: 3 });
    expect(reads[0]!.chars).toBe(CART.length);
  });

  it('gives each command its own call: read, search, with the command as text', async () => {
    const ev = calls(await collect('rollout-0.162.jsonl'));
    const cmds = ev.filter((c) => c.tool === 'shell');
    expect(cmds.map((c) => c.toolClass)).toEqual(['read', 'search', 'read']);
    expect(cmds[0]).toMatchObject({ text: 'cat src/cart.ts', paths: [normalizePath('/home/dev/shop/src/cart.ts')] });
    expect(ev.filter((c) => c.tool === 'exec').map((c) => c.toolClass)).toEqual(['bash', 'bash', 'bash']);
  });

  it('does not count a command output twice in the exec output', async () => {
    const ev = results(await collect('rollout-0.162.jsonl'));
    const execOut = ev.find((r) => r.callId === 'call_exec_1')!;
    const readOut = ev.find((r) => r.read !== null)!;
    expect(readOut.chars + execOut.chars).toBe(CART.length);
  });

  it('apply_patch becomes an edit with paths', async () => {
    const p = calls(await collect('rollout-0.162.jsonl')).find((c) => c.tool === 'apply_patch')!;
    expect(p).toMatchObject({ toolClass: 'edit', paths: [normalizePath('/home/dev/shop/src/cart.ts')] });
    expect(p.text).toContain('applyDiscount');
  });

  it('AGENTS.md message is an instructions injection, not a user prompt', async () => {
    const ev = await collect('rollout-0.162.jsonl');
    const inst = injections(ev).filter((i) => i.source === 'instructions');
    expect(inst).toHaveLength(1);
    expect(inst[0]!.name).toBe(normalizePath('/home/dev/shop/AGENTS.md'));
    expect(prompts(ev).some((p) => p.text.includes('AGENTS.md'))).toBe(false);
    expect(prompts(ev).some((p) => p.text.includes('<environment_context>'))).toBe(false);
    expect(injections(ev).find((i) => i.name === 'environment_context')?.source).toBe('other');
  });

  it('base instructions and developer messages are system_prompt injections', async () => {
    const sys = injections(await collect('rollout-0.162.jsonl')).filter((i) => i.source === 'system_prompt');
    expect(sys.map((i) => i.name)).toEqual(['base_instructions', 'developer']);
  });

  it('compacted record becomes a compaction with unknown trigger', async () => {
    const c = (await collect('rollout-0.162.jsonl')).filter((e) => e.kind === 'compaction');
    // `compacted` and the `context_compacted` event that follows it are one compaction.
    expect(c).toEqual([expect.objectContaining({ kind: 'compaction', trigger: 'unknown', preTokens: null })]);
  });

  it('meta has cwd, branch and version', async () => {
    expect(await meta('rollout-0.162.jsonl')).toMatchObject({
      agent: 'codex', sessionId: '0199f0aa-1111-7222-8333-444455556666', threadId: '0199f0aa-1111-7222-8333-444455556666',
      parentThreadId: null, cwd: '/home/dev/shop', gitBranch: 'feat/cart', version: '0.162.0-alpha.17.2', entrypoint: 'codex_cli_rs',
    });
  });

  it('input_image content is not counted as text', async () => {
    const p = prompts(await collect('rollout-0.162.jsonl'));
    expect(p).toHaveLength(1);
    expect(p[0]!.chars).toBe('Add a discount to the cart total, see the screenshot.'.length);
  });

  it('emits the assistant message as assistant_text, every event on the session thread', async () => {
    const ev = await collect('rollout-0.162.jsonl');
    expect(ev.filter((e) => e.kind === 'assistant_text').map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'Added applyDiscount in src/cart.ts; cartTotal is unchanged.',
    ]);
    expect(new Set(ev.map((e) => e.threadId))).toEqual(new Set(['0199f0aa-1111-7222-8333-444455556666']));
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.seq).toBeGreaterThanOrEqual(ev[i - 1]!.seq);
  });

  it('counts ignored records as skipped, never as bad lines', async () => {
    const stats = newStats();
    await collect('rollout-0.162.jsonl', stats);
    expect(stats.badLines).toBe(0);
    expect(stats.skippedRecords).toBeGreaterThan(0); // world_state, task_started, task_complete
  });
});

describe('parseCodexThread: legacy rollout', () => {
  it('legacy token_count: one request per increase, repeated totals ignored', async () => {
    const reqs = requests(await collect('rollout-legacy.jsonl'));
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.usage).toEqual({ input: 900, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 });
    expect(reqs[1]!.usage).toEqual({ input: 300, cacheRead: 800, cacheWrite5m: 0, cacheWrite1h: 0, output: 30 });
    expect(reqs.every((r) => r.model === 'gpt-5-codex')).toBe(true);
  });

  it('legacy shell cat is a read', async () => {
    const ev = await collect('rollout-legacy.jsonl');
    const r = results(ev).find((x) => x.read)!;
    expect(r.read).toMatchObject({ path: normalizePath('/home/dev/old/src/a.ts'), startLine: 1, numLines: 2, totalLines: 2 });
    expect(r.text).toBe('export const a = 1;\nexport function helperFn() {}\n');
    expect(calls(ev)[0]).toMatchObject({ tool: 'shell', toolClass: 'bash', text: 'cat src/a.ts' });
  });

  it('meta falls back to the file name for a missing file', async () => {
    const m = await parseCodexThread(path.join(FIX, 'rollout-2026-01-01T00-00-00-0199ffff-0000-7000-8000-00000000abcd.jsonl'), { maxLineBytes: MAX }, newStats()).meta;
    expect(m).toMatchObject({ agent: 'codex', sessionId: '0199ffff-0000-7000-8000-00000000abcd', cwd: null, version: null });
  });
});

describe('parseCodexThread: review fixes', () => {
  it('normalises the AGENTS.md path like every other path on win32', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const inst = injections(await collect('rollout-0.162.jsonl')).filter((i) => i.source === 'instructions');
      expect(inst[0]!.name).toBe('/home/dev/shop/agents.md');
      const reads = results(await collect('rollout-0.162.jsonl')).filter((r) => r.read);
      expect(reads[0]!.read!.path).toBe('/home/dev/shop/src/cart.ts');
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });

  async function synth(lines: object[]): Promise<LedgerEvent[]> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-codex-'));
    const f = path.join(dir, 'rollout-2026-10-20T08-00-00-0198aaaa-0000-7000-8000-00000000abcd.jsonl');
    const head = [
      { type: 'session_meta', payload: { id: 's', cwd: '/home/dev/shop', cli_version: '0.162.0' } },
      { type: 'turn_context', payload: { cwd: '/home/dev/shop', model: 'gpt-6-astra' } },
    ];
    await writeFile(f, [...head, ...lines].map((l, i) => JSON.stringify({ timestamp: `2026-10-20T08:00:${String(i).padStart(2, '0')}.000Z`, ...l })).join('\n'));
    const out: LedgerEvent[] = [];
    for await (const e of parseCodexThread(f, { maxLineBytes: MAX }, newStats()).events) out.push(e);
    return out;
  }
  const exec = (callId: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'run' } });
  const output = (callId: string, out: unknown) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: out } });
  const command = (callId: string, id: string, cmd: string, out: string, extra: object = {}) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'CommandExecution', id, call_id: callId, command: ['bash', '-lc', cmd], cwd: '/home/dev/shop', exit_code: 0, aggregated_output: out, parsed_cmd: [{ type: 'read', cmd, name: 'a.ts', path: 'src/a.ts' }], ...extra },
    },
  });

  it('MCP tools (`mcp__server__tool`, or the older `server__tool`) get class mcp, the server and the mcp__ name', async () => {
    const fn = (callId: string, name: string) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: '{"q":"x"}' } });
    const out = (callId: string) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: 'result text' } });
    const ev = await synth([fn('m1', 'mcp__docs__search'), out('m1'), fn('m2', 'tracker__list_issues'), out('m2'), fn('m3', 'update_plan'), out('m3')]);
    const c = calls(ev);
    expect(c.map((x) => [x.tool, x.toolClass, x.mcpServer])).toEqual([
      ['mcp__docs__search', 'mcp', 'docs'],
      ['mcp__tracker__list_issues', 'mcp', 'tracker'],
      ['update_plan', 'other', null],
    ]);
    expect(results(ev).map((r) => r.tool)).toEqual(['mcp__docs__search', 'mcp__tracker__list_issues', 'update_plan']);
  });

  it('a command reported after its call output is not counted twice', async () => {
    const ev = await synth([exec('c1'), output('c1', 'line1\n'), command('c1', 'cmd-1', 'cat src/a.ts', 'line1\n')]);
    const total = results(ev).reduce((s, r) => s + r.chars, 0);
    expect(total).toBe('line1\n'.length);
    expect(results(ev).find((r) => r.read)!.read!.path).toBe(normalizePath('/home/dev/shop/src/a.ts'));
  });
  it('a repeated command or output with the same ids is emitted once', async () => {
    const ev = await synth([exec('c1'), command('c1', 'cmd-1', 'cat src/a.ts', 'x\n'), command('c1', 'cmd-1', 'cat src/a.ts', 'x\n'), output('c1', 'x\n'), output('c1', 'x\n')]);
    expect(results(ev).filter((r) => r.read)).toHaveLength(1);
    expect(results(ev).filter((r) => r.callId === 'c1')).toHaveLength(1);
    expect(results(ev).reduce((s, r) => s + r.chars, 0)).toBe(2);
  });
  it('flags errors from custom_tool_call_output', async () => {
    const ev = await synth([exec('c1'), output('c1', { content: 'boom', success: false }), exec('c2'), output('c2', 'fine')]);
    expect(results(ev).map((r) => [r.callId, r.isError])).toEqual([
      ['c1', true],
      ['c2', false],
    ]);
  });
  it('sed -i in a command is an edit, not a read', async () => {
    const ev = await synth([
      exec('c1'),
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'cmd-9', call_id: 'c1', command: ['bash', '-lc', "sed -i 's/a/b/' src/a.ts"], cwd: '/home/dev/shop', exit_code: 0, aggregated_output: '', parsed_cmd: [{ type: 'unknown', cmd: "sed -i 's/a/b/' src/a.ts" }] } } },
      output('c1', ''),
    ]);
    const c = calls(ev).find((x) => x.callId.startsWith('c1#'))!;
    expect(c).toMatchObject({ toolClass: 'edit', paths: [normalizePath('/home/dev/shop/src/a.ts')] });
  });
});

describe('parseCodexThread: cache writes (review fixes 4-6)', () => {
  async function usageOfRecord(usage: object) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-cx-'));
    const f = path.join(dir, 'rollout-2026-11-01T00-00-00-0199ffff-0000-7000-8000-00000000abcd.jsonl');
    const lines = [
      { timestamp: '2026-11-01T00:00:00Z', type: 'session_meta', payload: { id: '0199ffff-0000-7000-8000-00000000abcd', cwd: '/w' } },
      { timestamp: '2026-11-01T00:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/w' } },
      { timestamp: '2026-11-01T00:00:02Z', type: 'token_usage_record', payload: { response_id: 'resp_1', usage } },
    ];
    await writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const out: LedgerEvent[] = [];
    for await (const e of parseCodexThread(f, { maxLineBytes: MAX }, newStats()).events) out.push(e);
    const r = out.find((e) => e.kind === 'request');
    return r && r.kind === 'request' ? r.usage : null;
  }
  it('ordinary input is input_tokens minus cached minus cache writes', async () => {
    expect(await usageOfRecord({ input_tokens: 12000, cached_input_tokens: 4000, cache_write_input_tokens: 7000, output_tokens: 10 })).toEqual({
      input: 1000,
      output: 10,
      cacheRead: 4000,
      cacheWrite5m: 7000,
      cacheWrite1h: 0,
    });
  });
  it('12h writes go to their own rate when the record splits them', async () => {
    expect(
      await usageOfRecord({ input_tokens: 12000, cached_input_tokens: 4000, cache_write_input_tokens: 7000, cache_write_input_tokens_details: { ttl_30m_tokens: 5000, ttl_12h_tokens: 2000 }, output_tokens: 10 }),
    ).toMatchObject({ input: 1000, cacheWrite5m: 5000, cacheWrite1h: 2000 });
  });
});
