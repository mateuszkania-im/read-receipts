// Fields the parsers add to injections for the harness fingerprint (spec 6.5).
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newStats } from '../../src/io/jsonl.js';
import type { InjectionEvent, LedgerEvent } from '../../src/model.js';
import { parseClaudeThread, prNumberOf, prRepoOf, stableSystemPromptHash } from '../../src/parse/claude.js';
import { parseCodexThread } from '../../src/parse/codex.js';
import { hash16 } from '../../src/parse/common.js';

async function tmp(lines: object[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-harness-'));
  const f = path.join(dir, 's.jsonl');
  await writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

async function claude(lines: object[]): Promise<InjectionEvent[]> {
  const f = await tmp(lines.map((l) => ({ cwd: '/home/dev/app', sessionId: 's', version: '2.1.316', timestamp: '2026-11-01T10:00:00.000Z', ...l })));
  const out: LedgerEvent[] = [];
  for await (const e of parseClaudeThread(f, { threadId: 'main', parentThreadId: null, spawnedByCallId: null, maxLineBytes: 1 << 20 }, newStats()).events) out.push(e);
  return out.filter((e): e is InjectionEvent => e.kind === 'injection');
}

const att = (attachment: object) => ({ type: 'attachment', attachment });

describe('Claude injections carry fingerprint fields', () => {
  it('instructions carry their scope', async () => {
    const ev = await claude([att({ type: 'instructions', files: [{ path: '/home/dev/app/CLAUDE.md', type: 'Project', content: 'v1' }, { path: '/home/u/.claude/CLAUDE.md', type: 'User', content: 'u' }] })]);
    expect(ev.map((e) => [e.name, e.scope])).toEqual([
      ['/home/dev/app/CLAUDE.md', 'Project'],
      ['/home/u/.claude/CLAUDE.md', 'User'],
    ]);
  });
  it('skill listings carry digests, or names when digests are missing', async () => {
    const ev = await claude([
      att({ type: 'skill_listing', content: 'c', names: ['b', 'a'], digests: ['d2', 'd1'] }),
      att({ type: 'skill_listing', content: 'c2', names: ['z', 'y'] }),
    ]);
    expect(ev.map((e) => e.digests)).toEqual([
      ['d2', 'd1'],
      ['z', 'y'],
    ]);
  });
  it('hooks carry a hash of their command', async () => {
    const ev = await claude([att({ type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:startup', command: 'node hook.js', content: 'ok' })]);
    expect(ev[0]).toMatchObject({ source: 'hook', name: 'SessionStart:SessionStart:startup', commandHash: hash16('node hook.js') });
  });
  it('tool schemas carry tool names, and deferred_tools_delta its added names', async () => {
    const ev = await claude([
      att({ type: 'prompt_snapshot', systemPrompt: ['s'], tools: [{ name: 'Read' }, { name: 'mcp__docs__search' }] }),
      att({ type: 'deferred_tools_delta', addedNames: ['mcp__jira__get', 'WebFetch'] }),
    ]);
    expect(ev.find((e) => e.source === 'tool_schemas')!.tools).toEqual(['Read']);
    expect(ev.find((e) => e.source === 'mcp_tool_schemas')!.tools).toEqual(['mcp__docs__search']);
    expect(ev.find((e) => e.name === 'deferred_tools_delta')!.tools).toEqual(['mcp__jira__get', 'WebFetch']);
  });
  it('deferred_tools_delta with surfaced definitions still reports its added names', async () => {
    const ev = await claude([
      att({ type: 'deferred_tools_delta', addedNames: ['mcp__docs__search'], surfacedDefinitions: [{ name: 'mcp__docs__search', definition: { d: 1 } }] }),
    ]);
    expect(ev.filter((e) => e.tools?.includes('mcp__docs__search'))).not.toHaveLength(0);
    expect(ev.reduce((s, e) => s + e.chars, 0)).toBe(JSON.stringify({ d: 1 }).length);
  });
  it('system prompts carry a hash without date, cwd and git status lines', async () => {
    const a = await claude([att({ type: 'prompt_snapshot', systemPrompt: ["You are an agent.\n - Today's date: 2026-11-01\n - Primary working directory: /a\ngitStatus: x\nCurrent branch: main\n\nDone."] })]);
    const b = await claude([att({ type: 'prompt_snapshot', systemPrompt: ["You are an agent.\n - Today's date: 2026-11-02\n - Primary working directory: /b\ngitStatus: y\nCurrent branch: dev\nStatus: M a.ts\n\nDone."] })]);
    expect(a[0]!.stableHash).toBeDefined();
    expect(a[0]!.stableHash).toBe(b[0]!.stableHash);
    expect(a[0]!.hash).not.toBe(b[0]!.hash);
  });
});

describe('stableSystemPromptHash', () => {
  it('keeps every other line', () => {
    expect(stableSystemPromptHash('A\nB')).not.toBe(stableSystemPromptHash('A\nC'));
    expect(stableSystemPromptHash('A\nCurrent date: 1\nB')).toBe(stableSystemPromptHash('A\nB'));
  });
});

describe('Codex injections carry fingerprint fields', () => {
  it('system prompts carry a stable hash', async () => {
    const out: LedgerEvent[] = [];
    for await (const e of parseCodexThread(path.resolve('test/fixtures/codex/rollout-0.162.jsonl'), { maxLineBytes: 1 << 20 }, newStats()).events) out.push(e);
    const sys = out.filter((e): e is InjectionEvent => e.kind === 'injection' && e.source === 'system_prompt');
    expect(sys.length).toBeGreaterThan(0);
    for (const s of sys) expect(s.stableHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('remote_session_change', () => {
  it.each([
    [42, 42],
    ['42', 42],
    ['#42', 42],
    ['https://github.com/acme/shop/pull/42', 42],
    ['https://github.com/acme/shop/pull/42/files', 42],
    ['xxxxxxxx', null],
    [null, null],
    [0, null],
  ])('pr %s gives %s', (v, want) => {
    expect(prNumberOf(v)).toBe(want);
  });
  it.each([
    ['https://github.com/Acme/Shop/pull/42', 'acme/shop'],
    ['https://ghe.example.com/team/api/pull/7/files', 'team/api'],
    ['#42', null],
    [42, null],
  ])('repo of %s is %s (review 7-8, ruling 3)', (v, want) => {
    expect(prRepoOf(v)).toBe(want);
  });
});

describe('stableSystemPromptHash: volatile parts (review fixes 4-6)', () => {
  const prompt = (o: { mem: string; scratch: string; date: string; time: string; model: string; status: string; extra?: string }) =>
    [
      'You are an interactive agent that helps with software engineering.',
      `You have a persistent file-based memory at \`${o.mem}\`. This directory already exists.`,
      `Scratchpad directory: ${o.scratch}`,
      `Session log: /tmp/claude/${'1b2c3d4e-0000-4000-8000-00000000000' + o.date.slice(-1)}.log`,
      `Today's date is ${o.date}.`,
      `The local time is ${o.time}.`,
      `You are powered by the model named ${o.model}.`,
      '',
      `gitStatus: This is the git status at the start of the conversation.`,
      `Current branch: ${o.status}`,
      '',
      'Main branch (you will usually use this for PRs): main',
      '',
      'Status:',
      `M src/${o.status}.ts`,
      '',
      'Recent commits:',
      `abc1234 ${o.status} work`,
      '',
      '# Tone',
      o.extra ?? 'Be concise.',
    ].join('\n');
  const a = { mem: '/Users/ann/.claude/projects/-Users-ann-shop/memory/', scratch: '/private/tmp/claude-501/-Users-ann-shop/0f3c2a10-1111-4222-8333-444455556666/scratchpad', date: '2026-11-01', time: '09:15', model: 'Claude Opus 5.5', status: 'feat/a' };
  const b = { mem: '/home/bob/.claude/projects/-home-bob-api/memory/', scratch: '/tmp/claude-1000/-home-bob-api/9a8b7c6d-1111-4222-8333-444455556666/scratchpad', date: '2026-11-02', time: '17:40:03', model: 'Claude Sonnet 5.5', status: 'fix/b' };
  it('is the same across sessions of one harness', () => {
    expect(stableSystemPromptHash(prompt(a))).toBe(stableSystemPromptHash(prompt(b)));
  });
  it('still changes when the instructions change, also after the git status block', () => {
    expect(stableSystemPromptHash(prompt(a))).not.toBe(stableSystemPromptHash(prompt({ ...a, extra: 'Be verbose.' })));
  });
});
