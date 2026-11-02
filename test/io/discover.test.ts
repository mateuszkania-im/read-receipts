import { mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSessions } from '../../src/io/discover.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

async function touch(file: string, content = '{}\n'): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rr-discover-'));
}

const base = { codexDir: null, sinceMs: null, agent: 'all', includeSubagents: true } as const;

describe('discoverSessions', () => {
  it('finds Claude sessions with nested subagent and workflow files', async () => {
    const dir = await tmp();
    await touch(path.join(dir, '-r', `${U1}.jsonl`));
    await touch(path.join(dir, '-r', U1, 'subagents', 'agent-a1.jsonl'));
    await touch(path.join(dir, '-r', U1, 'subagents', 'agent-a1.meta.json'));
    await touch(path.join(dir, '-r', U1, 'subagents', 'workflows', 'wf_x', 'agent-b2.jsonl'));
    await touch(path.join(dir, '-r', U1, 'tool-results', 'big.txt'));
    const s = await discoverSessions({ ...base, claudeDir: dir });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ agent: 'claude-code', sessionId: U1, mainFile: path.join(dir, '-r', `${U1}.jsonl`) });
    expect(s[0]!.subagentFiles.map((f) => path.basename(f)).sort()).toEqual(['agent-a1.jsonl', 'agent-b2.jsonl']);
  });

  it('leaves subagent files out when includeSubagents is false', async () => {
    const dir = await tmp();
    await touch(path.join(dir, '-r', `${U1}.jsonl`));
    await touch(path.join(dir, '-r', U1, 'subagents', 'agent-a1.jsonl'));
    const s = await discoverSessions({ ...base, claudeDir: dir, includeSubagents: false });
    expect(s[0]!.subagentFiles).toEqual([]);
  });

  it('finds Codex rollouts under YYYY/MM/DD', async () => {
    const dir = await tmp();
    const f = await touch(path.join(dir, '2026', '10', '31', `rollout-2026-10-31T10-00-00-${U2}.jsonl`));
    await touch(path.join(dir, '2026', '10', '31', 'notes.txt'));
    const s = await discoverSessions({ ...base, claudeDir: null, codexDir: dir });
    expect(s).toEqual([expect.objectContaining({ agent: 'codex', sessionId: U2, mainFile: f, subagentFiles: [] })]);
  });

  it('filters by agent', async () => {
    const cdir = await tmp();
    const xdir = await tmp();
    await touch(path.join(cdir, '-r', `${U1}.jsonl`));
    await touch(path.join(xdir, '2026', '10', '31', `rollout-2026-10-31T10-00-00-${U2}.jsonl`));
    const both = await discoverSessions({ ...base, claudeDir: cdir, codexDir: xdir });
    expect(both.map((s) => s.agent).sort()).toEqual(['claude-code', 'codex']);
    const onlyCodex = await discoverSessions({ ...base, claudeDir: cdir, codexDir: xdir, agent: 'codex' });
    expect(onlyCodex.map((s) => s.agent)).toEqual(['codex']);
    const onlyClaude = await discoverSessions({ ...base, claudeDir: cdir, codexDir: xdir, agent: 'claude' });
    expect(onlyClaude.map((s) => s.agent)).toEqual(['claude-code']);
  });

  it('drops files older than sinceMs by mtime without opening them', async () => {
    const dir = await tmp();
    const old = await touch(path.join(dir, '-r', `${U1}.jsonl`));
    await touch(path.join(dir, '-r', `${U3}.jsonl`));
    const t = new Date('2020-01-01T00:00:00Z');
    await utimes(old, t, t);
    const s = await discoverSessions({ ...base, claudeDir: dir, sinceMs: Date.parse('2024-01-01T00:00:00Z') });
    expect(s.map((x) => x.sessionId)).toEqual([U3]);
  });

  it('ignores symlinks', async () => {
    const dir = await tmp();
    const real = await touch(path.join(await tmp(), 'x.jsonl'));
    await mkdir(path.join(dir, '-r'), { recursive: true });
    try {
      await symlink(real, path.join(dir, '-r', `${U1}.jsonl`));
    } catch {
      return; // symlinks need privileges on some Windows runners
    }
    expect(await discoverSessions({ ...base, claudeDir: dir })).toEqual([]);
  });

  it('returns [] when a directory does not exist', async () => {
    const dir = await tmp();
    await expect(
      discoverSessions({ ...base, claudeDir: path.join(dir, 'nope'), codexDir: path.join(dir, 'nope2') }),
    ).resolves.toEqual([]);
  });
});
