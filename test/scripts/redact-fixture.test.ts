import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = path.resolve('scripts/redact-fixture.mjs');

async function redactLines(lines: unknown[], root: string, extra: string[] = []): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rr-redact-'));
  const input = path.join(dir, 'in.jsonl');
  const output = path.join(dir, 'out.jsonl');
  await writeFile(input, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await run(process.execPath, [script, input, output, '--repo-root', root, ...extra]);
  return (await readFile(output, 'utf8')).trimEnd().split('\n');
}

async function redact(line: unknown, root: string): Promise<string> {
  return (await redactLines([line], root))[0]!;
}

const assistantLine = {
  type: 'assistant',
  uuid: '00000000-1111-4222-8333-444444444444',
  sessionId: '55555555-6666-4777-8888-999999999999',
  cwd: '/Users/someone/repo',
  gitBranch: 'secret-branch',
  timestamp: '2026-11-01T22:06:42.603Z',
  version: '2.1.316',
  message: {
    id: 'msg_01SynthTestMessageIdAAAA',
    model: 'claude-sonnet-5-5',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_01SynthTestCallIdBBBB', name: 'Read', input: { file_path: '/Users/someone/repo/src/a.ts' } },
      { type: 'text', text: 'my secret plan' },
    ],
    usage: { input_tokens: 3, output_tokens: 7 },
  },
};

describe('redact-fixture', () => {
  it('removes every non-allowlisted string and keeps structure', async () => {
    const out = await redact(assistantLine, '/Users/someone/repo');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('/Users/someone');
    const r = JSON.parse(out);
    expect(r.message.content[0].name).toBe('Read');
    expect(r.message.content[0].input.file_path).toBe('/repo/src/a.ts');
    expect(r.message.content[1].text).toBe('x'.repeat('my secret plan'.length));
    expect(r.cwd).toBe('/repo');
    expect(r.message.usage).toEqual({ input_tokens: 3, output_tokens: 7 });
    expect(r.message.model).toBe('claude-sonnet-5-5');
    expect(r.timestamp).toBe('2026-11-01T22:06:42.603Z');
  });

  it('maps ids to stable fake ids of the same shape', async () => {
    const [a, b] = await redactLines([assistantLine, { type: 'user', parentUuid: assistantLine.uuid }], '/r');
    const ra = JSON.parse(a!);
    const rb = JSON.parse(b!);
    expect(ra.uuid).not.toBe(assistantLine.uuid);
    expect(ra.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rb.parentUuid).toBe(ra.uuid);
    expect(ra.message.id).toMatch(/^msg_[A-Za-z0-9]{24}$/);
    expect(ra.message.id).not.toBe(assistantLine.message.id);
    expect(ra.message.content[0].id).toMatch(/^toolu_/);
  });

  it('replaces Read results with synthetic code of the same line count', async () => {
    const result = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01SynthTestCallIdBBBB', content: '1\tconst token = "abc";\n2\tsecretCall();\n3\t' }],
      },
      toolUseResult: {
        type: 'text',
        file: { filePath: '/Users/someone/repo/src/a.ts', content: 'const token = "abc";\nsecretCall();\n', numLines: 3, startLine: 1, totalLines: 3 },
      },
    };
    const [, out] = await redactLines([assistantLine, result], '/Users/someone/repo');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('token');
    const r = JSON.parse(out!);
    expect(r.toolUseResult.file.filePath).toBe('/repo/src/a.ts');
    expect(r.toolUseResult.file.content.split('\n')).toHaveLength(3);
    expect(r.toolUseResult.file.content).toContain('function fn1');
    expect(r.message.content[0].content.split('\n')).toHaveLength(3);
    expect(r.message.content[0].content.startsWith('1\t')).toBe(true);
  });

  it('keeps gitBranch only with --keep-branch and hides MCP tool names', async () => {
    const line = { ...assistantLine, message: { ...assistantLine.message, content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__private_server__do_thing', input: {} }] } };
    const [plain] = await redactLines([line], '/r');
    expect(JSON.parse(plain!).gitBranch).toBe('xxxxxxxxxxxxx');
    expect(JSON.parse(plain!).message.content[0].name).toMatch(/^mcp__x+__x+$/);
    const [kept] = await redactLines([line], '/r', ['--keep-branch', '--keep-mcp', 'private_server']);
    expect(JSON.parse(kept!).gitBranch).toBe('secret-branch');
    expect(JSON.parse(kept!).message.content[0].name).toBe('mcp__private_server__do_thing');
  });

  it('maps object keys that are ids to the same fake ids as values', async () => {
    const id = 'toolu_01SynthTestCallIdCCCC';
    const uuid = '00000000-1111-4222-8333-444444444444';
    const out = await redact({ type: 'x', tool_use_id: id, wireToolInputs: { [id]: { a: 1 } }, uuids: { [uuid]: 2 } }, '/r');
    expect(out).not.toContain(id);
    expect(out).not.toContain(uuid);
    const r = JSON.parse(out);
    expect(Object.keys(r.wireToolInputs)).toEqual([r.tool_use_id]);
    expect(Object.keys(r.uuids)[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('redacts object keys that look like paths', async () => {
    const out = await redact({ type: 'x', files: { '/Users/someone/repo/a.ts': 1, '/Users/someone/other.txt': 2 } }, '/Users/someone/repo');
    expect(out).not.toContain('/Users/someone');
    expect(Object.keys(JSON.parse(out).files)).toEqual(['/repo/a.ts', 'x'.repeat('/Users/someone/other.txt'.length)]);
  });

  it('redacts name, type, model and version values inside tool inputs and results', async () => {
    const call = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'toolu_01SynthTestCallIdDDDD', name: 'mcp__docs__create', input: { name: 'Quarterly plan', type: 'memo', model: 'secret-model', version: 'v9' } }],
      },
    };
    const result = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01SynthTestCallIdDDDD', content: [{ type: 'text', text: 'ok' }] }] },
      toolUseResult: { name: 'Jane Roe', type: 'person', version: '3' },
    };
    const [a, b] = await redactLines([call, result], '/r');
    for (const word of ['Quarterly', 'memo', 'secret-model', 'v9', 'Jane', 'person']) expect(a! + b!).not.toContain(word);
    const ra = JSON.parse(a!);
    expect(ra.type).toBe('assistant');
    expect(ra.message.model).toBe('claude-sonnet-5-5');
    expect(ra.message.content[0].type).toBe('tool_use');
    expect(ra.message.content[0].name).toMatch(/^mcp__x+__x+$/);
    const rb = JSON.parse(b!);
    expect(rb.message.content[0].type).toBe('tool_result');
    expect(rb.message.content[0].content[0].type).toBe('text');
  });

  it('redacts unknown object keys, keeps known schema keys and model ids', async () => {
    const out = await redact(
      {
        type: 'cost-state',
        modelUsage: { 'claude-sonnet-5-5': { costUSD: 1 } },
        projects: { '-Users-someone-Desktop-private': 1, 'build.example.internal': 2, brainstorming: 3 },
      },
      '/r',
    );
    for (const word of ['someone', 'private', 'example', 'brainstorming', 'projects']) expect(out).not.toContain(word);
    const r = JSON.parse(out);
    expect(r.modelUsage['claude-sonnet-5-5']).toEqual({ costUSD: 1 });
    const inner = Object.values(r)[2] as Record<string, number>;
    expect(Object.values(inner)).toEqual([1, 2, 3]);
  });

  it('keeps the attachment fields the parsers read', async () => {
    const out = await redact(
      {
        type: 'attachment',
        timestamp: '2026-11-01T10:00:00.000Z',
        attachment: { type: 'instructions', files: [{ path: '/home/someone/.claude/CLAUDE.md', type: 'User', content: 'my rules' }] },
      },
      '/r',
    );
    const r = JSON.parse(out);
    expect(r.attachment.type).toBe('instructions');
    expect(r.attachment.files[0].type).toBe('User');
    expect(r.timestamp).toBe('2026-11-01T10:00:00.000Z');
    expect(out).not.toContain('someone');
    expect(out).not.toContain('rules');
  });

  it('drops api-request-blob and api-request-shape records', async () => {
    const lines = await redactLines([{ type: 'api-request-blob', blob: 'x' }, { type: 'api-request-shape' }, { type: 'user', message: { content: 'hi' } }], '/r');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['user']);
  });

  it('--keep-ids leaves ids that are already fake', async () => {
    const [out] = await redactLines([assistantLine], '/r', ['--keep-ids']);
    expect(JSON.parse(out!).uuid).toBe(assistantLine.uuid);
  });
});

describe('redact-fixture: review fixes 4-6', () => {
  it('--keep-ids still maps opaque ids (hook toolUseID) and keeps usage speed and inference_geo', async () => {
    const line = {
      type: 'attachment',
      toolUseID: 'AbcdEfghIjkl',
      attachment: { type: 'hook_success', hookEvent: 'SessionStart', toolUseID: 'MnopQrstUvwx' },
    };
    const usageLine = { type: 'assistant', message: { id: 'msg_01SynthTestMessageId00', model: 'claude-opus-5-5', usage: { speed: 'standard', inference_geo: 'global' } } };
    const out = await redactLines([line, usageLine], '/r', ['--keep-ids']);
    const joined = out.join('\n');
    expect(joined).not.toContain('AbcdEfghIjkl');
    expect(joined).not.toContain('MnopQrstUvwx');
    expect(JSON.parse(out[0]!).toolUseID).toMatch(/^[A-Za-z]{12}$/);
    expect(joined).toContain('msg_01SynthTestMessageId00');
    expect(JSON.parse(out[1]!).message.usage).toEqual({ speed: 'standard', inference_geo: 'global' });
  });
});
