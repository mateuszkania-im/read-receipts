import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompositionPass } from '../../src/analysis/composition.js';
import { newStats } from '../../src/io/jsonl.js';
import type { InjectionSource, LedgerEvent, Usage } from '../../src/model.js';
import { parseClaudeThread } from '../../src/parse/claude.js';

const base = (seq: number) => ({ threadId: 'main', seq, ts: '' });
const inj = (seq: number, source: InjectionSource, chars: number): LedgerEvent => ({ kind: 'injection', ...base(seq), source, name: source, chars, hash: 'h' });
const toolRes = (seq: number, tool: string, chars: number): LedgerEvent => ({
  kind: 'tool_result',
  ...base(seq),
  callId: `c${seq}`,
  tool,
  isError: false,
  chars,
  read: null,
  text: '',
});
const prompt = (seq: number, chars: number): LedgerEvent => ({ kind: 'user_prompt', ...base(seq), chars, text: '' });
const req = (seq: number, u: Partial<Usage> = {}): LedgerEvent => ({
  kind: 'request',
  ...base(seq),
  requestId: `r${seq}`,
  model: 'm',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...u },
  cwd: null,
  gitBranch: null,
});
const compact = (seq: number): LedgerEvent => ({ kind: 'compaction', ...base(seq), trigger: 'auto', preTokens: null });

function run(events: LedgerEvent[]) {
  const p = new CompositionPass();
  for (const e of events) p.onEvent(e);
  return p.finish();
}

describe('CompositionPass', () => {
  it('introduced = ceil(chars/4) per source; assistant_output uses exact output tokens', () => {
    const c = run([inj(1, 'instructions', 400), toolRes(2, 'Read', 800), req(3, { output: 50 })]);
    expect(c.sources.get('instructions')!.introduced).toBe(100);
    expect(c.sources.get('tool_result:Read')!.introduced).toBe(200);
    expect(c.sources.get('assistant_output')!.introduced).toBe(50);
  });
  it('processed = introduced x requests after it in the segment', () => {
    const c = run([toolRes(1, 'Read', 400), req(2), req(3), compact(4), req(5)]);
    expect(c.sources.get('tool_result:Read')!.processed).toBe(100 * 2);
  });
  it('assistant output is re-sent by the later requests of its segment', () => {
    const c = run([req(1, { output: 10 }), req(2, { output: 20 }), req(3), compact(4), req(5)]);
    expect(c.sources.get('assistant_output')).toEqual({ introduced: 30, processed: 10 * 2 + 20 * 1 });
  });
  it('groups MCP results by server', () => {
    const c = run([toolRes(1, 'mcp__docs__search', 40), toolRes(2, 'mcp__docs__fetch', 40)]);
    expect(c.sources.get('mcp:docs')!.introduced).toBe(20);
    expect(c.sources.has('tool_result:mcp__docs__search')).toBe(false);
  });
  it('counts user prompts, and Skill results once (as skill_body)', () => {
    const c = run([prompt(1, 8), toolRes(2, 'Skill', 40), inj(2, 'skill_body', 40)]);
    expect(c.sources.get('user_prompt')!.introduced).toBe(2);
    expect(c.sources.get('skill_body')!.introduced).toBe(10);
    expect(c.sources.has('tool_result:Skill')).toBe(false);
  });
  it('unattributed = exact first prompt minus estimated sources before it', () => {
    const c = run([inj(1, 'system_prompt', 4000), inj(2, 'tool_schemas', 2000), prompt(3, 400), req(4, { input: 10, cacheWrite5m: 1990 }), req(5, { cacheRead: 2000, input: 100 })]);
    expect(c.exactPromptFirst).toBe(2000);
    expect(c.exactPromptTotal).toBe(2000 + 2100);
    expect(c.unattributedFirst).toBe(2000 - (1000 + 500 + 100));
  });
  it('no request: exact numbers are null and 0', () => {
    const c = run([inj(1, 'system_prompt', 4)]);
    expect(c).toMatchObject({ exactPromptFirst: null, exactPromptTotal: 0, unattributedFirst: null });
  });
  it('on the basic fixture: system_prompt, tool_schemas and instructions are all non-zero', async () => {
    const p = new CompositionPass();
    const { events } = parseClaudeThread(
      path.resolve('test/fixtures/claude/basic-2.1.316.jsonl'),
      { threadId: 'main', parentThreadId: null, spawnedByCallId: null, maxLineBytes: 1 << 26 },
      newStats(),
    );
    for await (const e of events) p.onEvent(e);
    const c = p.finish();
    for (const k of ['system_prompt', 'tool_schemas', 'instructions']) expect(c.sources.get(k)?.introduced ?? 0, k).toBeGreaterThan(0);
    expect(c.exactPromptFirst).toBeGreaterThan(0);
  });
});

describe('CompositionPass: review fixes 4-6', () => {
  const named = (seq: number, source: InjectionSource, name: string, chars: number): LedgerEvent => ({ kind: 'injection', ...base(seq), source, name, chars, hash: 'h' });
  it('the system prompt and tool schemas keep counting as processed after a compaction', () => {
    const c = run([named(1, 'system_prompt', 'system_prompt', 400), named(2, 'tool_schemas', 'tools', 800), req(3), req(4), compact(5), req(6), req(7)]);
    expect(c.sources.get('system_prompt')).toEqual({ introduced: 100, processed: 400 });
    expect(c.sources.get('tool_schemas')).toEqual({ introduced: 200, processed: 800 });
  });
  it('a re-sent snapshot with the same name after a compaction is not counted twice', () => {
    const c = run([named(1, 'system_prompt', 'system_prompt', 400), req(2), compact(3), named(4, 'system_prompt', 'system_prompt', 400), req(5)]);
    expect(c.sources.get('system_prompt')!.processed).toBe(200);
  });
  it('a newer snapshot replaces the carried one', () => {
    const c = run([named(1, 'tool_schemas', 'tools', 400), req(2), compact(3), named(4, 'tool_schemas', 'tools', 800), req(5)]);
    expect(c.sources.get('tool_schemas')).toEqual({ introduced: 300, processed: 300 });
  });
  it('names the sources first seen after the first request, so the gap is labelled', () => {
    const c = run([named(1, 'system_prompt', 'system_prompt', 400), req(2, { input: 500 }), named(3, 'tool_schemas', 'tools', 800), req(4)]);
    expect(c.lateSources).toEqual(['tool_schemas']);
    expect(c.unattributedFirst).toBe(400);
  });
});
