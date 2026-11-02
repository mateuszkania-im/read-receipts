// Copies the parser fixtures into a temp tree in the discovery layout.

import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpDir } from './synth.js';

const FIX = path.resolve('test/fixtures');

export async function fixtureTree(): Promise<{ root: string; claudeDir: string; codexDir: string }> {
  const root = await tmpDir('rr-tree-');
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  const proj = path.join(claudeDir, '-repo');
  await mkdir(proj, { recursive: true });
  for (const f of ['basic-2.1.316.jsonl', 'legacy-inline-sidechain.jsonl', 'mcp-and-image.jsonl']) {
    await cp(path.join(FIX, 'claude', f), path.join(proj, f));
  }
  await cp(path.join(FIX, 'claude', 'compaction-subagent'), proj, { recursive: true });
  const day = path.join(codexDir, '2026', '11', '01');
  await mkdir(day, { recursive: true });
  await cp(path.join(FIX, 'codex', 'rollout-0.162.jsonl'), path.join(day, 'rollout-2026-11-01T10-00-00-0199aaaa-0000-7000-8000-000000000001.jsonl'));
  await cp(path.join(FIX, 'codex', 'rollout-legacy.jsonl'), path.join(day, 'rollout-2026-11-01T11-00-00-0199aaaa-0000-7000-8000-000000000002.jsonl'));
  return { root, claudeDir, codexDir };
}
