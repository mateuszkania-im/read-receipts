import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FingerprintPass } from '../../src/analysis/fingerprint.js';
import { newStats } from '../../src/io/jsonl.js';
import type { InjectionEvent, LedgerEvent, ThreadMeta } from '../../src/model.js';
import { parseCodexThread } from '../../src/parse/codex.js';
import { hash16 } from '../../src/parse/common.js';

const meta: ThreadMeta = {
  agent: 'claude-code',
  sessionId: 's',
  threadId: 's',
  parentThreadId: null,
  spawnedByCallId: null,
  file: 'f',
  version: null,
  entrypoint: null,
  cwd: '/home/dev/app',
  gitBranch: null,
};
const base = { threadId: 's', seq: 1, ts: '' };
const ev = (o: Partial<InjectionEvent>): LedgerEvent => ({ kind: 'injection', ...base, source: 'other', name: 'x', chars: 1, hash: 'h', ...o });
const instr = (scope: string, file: string, content: string) =>
  ev({ source: 'instructions', scope, name: `/home/dev/app/${file}`, hash: hash16(content) });
const skills = (digests: string[]) => ev({ source: 'skills_listing', digests });
const hook = (name: string, cmd: string) => ev({ source: 'hook', name, commandHash: hash16(cmd) });
const sys = (stable: string) => ev({ source: 'system_prompt', stableHash: stable });
const mcpCall = (tool: string): LedgerEvent => ({
  kind: 'tool_call',
  ...base,
  callId: tool,
  tool,
  toolClass: 'mcp',
  mcpServer: tool.split('__')[1]!,
  paths: [],
  text: '',
});
const req = (model: string): LedgerEvent => ({ kind: 'request', ...base, requestId: model + Math.random(), model, usage: null, cwd: null, gitBranch: null });

function fp(events: LedgerEvent[], m: ThreadMeta = meta) {
  const p = new FingerprintPass();
  for (const e of events) p.onEvent(e, m);
  return p.finish();
}

describe('FingerprintPass', () => {
  it('fingerprint changes only the instructions component when CLAUDE.md content changes', () => {
    const a = fp([instr('Project', 'CLAUDE.md', 'v1'), skills(['d1'])]);
    const b = fp([instr('Project', 'CLAUDE.md', 'v2'), skills(['d1'])]);
    expect(a.instructions).not.toBe(b.instructions);
    expect(a.skills).toBe(b.skills);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it('instructions depend on scope and on the repo-relative path, not on the cwd', () => {
    const a = fp([instr('Project', 'CLAUDE.md', 'v1')]);
    expect(fp([instr('User', 'CLAUDE.md', 'v1')]).instructions).not.toBe(a.instructions);
    const moved = { ...meta, cwd: '/other/place' };
    const m = fp([ev({ source: 'instructions', scope: 'Project', name: '/other/place/CLAUDE.md', hash: hash16('v1') })], moved);
    expect(m.instructions).toBe(a.instructions);
  });
  it('repeated injections (resume, compaction) do not change a component', () => {
    expect(fp([instr('Project', 'CLAUDE.md', 'v1'), instr('Project', 'CLAUDE.md', 'v1')]).instructions).toBe(fp([instr('Project', 'CLAUDE.md', 'v1')]).instructions);
  });
  it('skills are the sorted digests', () => {
    expect(fp([skills(['b', 'a'])]).skills).toBe(fp([skills(['a', 'b'])]).skills);
    expect(fp([skills(['a'])]).skills).not.toBe(fp([skills(['a', 'b'])]).skills);
  });
  it('hooks hash event, name and command', () => {
    expect(fp([hook('Stop:x', 'a')]).hooks).not.toBe(fp([hook('Stop:x', 'b')]).hooks);
    expect(fp([hook('Stop:x', 'a'), hook('Pre:y', 'b')]).hooks).toBe(fp([hook('Pre:y', 'b'), hook('Stop:x', 'a')]).hooks);
  });
  it('system prompt hash ignores date and cwd lines', () => {
    // The parser computes stableHash without those lines; the pass uses it, not the raw hash.
    expect(fp([ev({ source: 'system_prompt', hash: 'raw1', stableHash: 'same' })]).systemPrompt).toBe(
      fp([ev({ source: 'system_prompt', hash: 'raw2', stableHash: 'same' })]).systemPrompt,
    );
  });
  it('MCP component is the sorted server set', () => {
    expect(fp([mcpCall('mcp__b__x'), mcpCall('mcp__a__y')]).mcp).toBe(fp([mcpCall('mcp__a__y'), mcpCall('mcp__b__x')]).mcp);
    expect(fp([ev({ source: 'mcp_tool_schemas', tools: ['mcp__a__y', 'mcp__b__x'] })]).mcp).toBe(fp([mcpCall('mcp__b__x'), mcpCall('mcp__a__y')]).mcp);
    expect(fp([ev({ name: 'deferred_tools_delta', tools: ['mcp__a__q', 'WebFetch'] }), ev({ source: 'mcp_tool_schemas', tools: ['mcp__b__z'] })]).mcp).toBe(
      fp([mcpCall('mcp__b__x'), mcpCall('mcp__a__y')]).mcp,
    );
  });
  it('model is the most used model', () => {
    expect(fp([req('a'), req('b'), req('b')]).model).toBe('b');
  });
  it('unobserved components are "-"', async () => {
    const p = new FingerprintPass();
    const parsed = parseCodexThread(path.resolve('test/fixtures/codex/rollout-0.162.jsonl'), { maxLineBytes: 1 << 26 }, newStats());
    const m = await parsed.meta;
    for await (const e of parsed.events) p.onEvent(e, m);
    const f = p.finish();
    expect(f).toMatchObject({ skills: '-', hooks: '-', mcp: '-', model: 'gpt-6-astra' });
    expect(f.instructions).not.toBe('-');
    expect(f.systemPrompt).not.toBe('-');
    expect(fp([]).fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fp([])).toMatchObject({ instructions: '-', skills: '-', hooks: '-', mcp: '-', systemPrompt: '-', model: '-' });
  });
  it('hash values are 12 hex chars', () => {
    const f = fp([instr('Project', 'CLAUDE.md', 'v1'), skills(['a']), hook('Stop:x', 'a'), sys('s'), mcpCall('mcp__a__b')]);
    for (const k of ['instructions', 'skills', 'hooks', 'mcp', 'systemPrompt', 'fingerprint'] as const) expect(f[k]).toMatch(/^[0-9a-f]{12}$|^-$/);
  });
});

describe('FingerprintPass: paths relative to the git root', () => {
  const sub: ThreadMeta = { ...meta, cwd: '/home/dev/app/packages/web' };
  const events = [instr('Project', 'CLAUDE.md', 'be terse'), instr('Project', 'packages/web/CLAUDE.md', 'web rules')];
  it('a session started in a subfolder fingerprints like one started at the root', () => {
    const atRoot = new FingerprintPass('/home/dev/app');
    const inSub = new FingerprintPass('/home/dev/app');
    for (const e of events) {
      atRoot.onEvent(e, meta);
      inSub.onEvent(e, sub);
    }
    expect(inSub.finish().instructions).toBe(atRoot.finish().instructions);
  });
  it('falls back to the session cwd when there is no repo', () => {
    const noRepo = new FingerprintPass(null);
    const rooted = new FingerprintPass('/home/dev/app');
    for (const e of events) {
      noRepo.onEvent(e, meta);
      rooted.onEvent(e, meta);
    }
    expect(noRepo.finish().instructions).toBe(rooted.finish().instructions);
  });
});
