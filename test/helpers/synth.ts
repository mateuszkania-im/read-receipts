// Synthetic Claude Code session files for tests. Every value is invented.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SynthRequest {
  ts: string;
  cwd: string;
  branch?: string | null;
  model?: string;
  /** Uncached input, output, cache read, 5m cache write. */
  usage?: [number, number, number, number];
  text?: string;
  read?: { file: string; content: string };
  edit?: { file: string; ok?: boolean };
  agentCall?: string;
}

let counter = 0;
const id = (p: string) => `${p}_${(++counter).toString(36).padStart(6, '0')}`;

/** One assistant response per request, with an optional Read or Edit tool call and its result. */
export function claudeLines(sessionId: string, reqs: SynthRequest[], extra: { instructions?: { file: string; content: string }[]; prUrl?: string; agentId?: string } = {}): string {
  const lines: object[] = [];
  const first = reqs[0];
  const common = (r: SynthRequest) => ({
    sessionId,
    cwd: r.cwd,
    gitBranch: r.branch ?? 'main',
    version: '2.1.316',
    entrypoint: 'cli',
    timestamp: r.ts,
    ...(extra.agentId ? { isSidechain: true, agentId: extra.agentId } : {}),
  });
  if (first) {
    lines.push({ type: 'user', ...common(first), uuid: id('u'), message: { role: 'user', content: 'Please look at the cart total.' } });
    for (const f of extra.instructions ?? []) {
      lines.push({ type: 'attachment', ...common(first), uuid: id('u'), attachment: { type: 'instructions', files: [{ path: f.file, type: 'Project', content: f.content }] } });
    }
    if (extra.prUrl) lines.push({ type: 'attachment', ...common(first), uuid: id('u'), attachment: { type: 'remote_session_change', pr: extra.prUrl, commit: null, url: null } });
  }
  for (const r of reqs) {
    const [input, output, cacheRead, write] = r.usage ?? [10, 100, 1000, 200];
    const content: object[] = [{ type: 'text', text: r.text ?? 'Working on it.' }];
    const callId = id('toolu');
    if (r.read) content.push({ type: 'tool_use', id: callId, name: 'Read', input: { file_path: r.read.file } });
    if (r.edit) content.push({ type: 'tool_use', id: callId, name: 'Edit', input: { file_path: r.edit.file, old_string: 'a', new_string: 'b' } });
    if (r.agentCall) content.push({ type: 'tool_use', id: r.agentCall, name: 'Agent', input: { description: 'look', prompt: 'Look around.', subagent_type: 'general-purpose' } });
    lines.push({
      type: 'assistant',
      ...common(r),
      uuid: id('u'),
      message: {
        id: id('msg'),
        role: 'assistant',
        model: r.model ?? 'claude-sonnet-5-5',
        content,
        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } },
      },
    });
    if (r.read) {
      const n = r.read.content.split('\n').length;
      lines.push({
        type: 'user',
        ...common(r),
        uuid: id('u'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: r.read.content }] },
        toolUseResult: { type: 'text', file: { filePath: r.read.file, content: r.read.content, numLines: n, startLine: 1, totalLines: n } },
      });
    }
    if (r.edit) {
      const ok = r.edit.ok !== false;
      lines.push({ type: 'user', ...common(r), uuid: id('u'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: ok ? 'The file has been updated.' : 'String not found.', is_error: !ok }] } });
    }
    if (r.agentCall) {
      lines.push({ type: 'user', ...common(r), uuid: id('u'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.agentCall, content: 'The subagent finished.' }] } });
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export async function tmpDir(prefix = 'rr-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Writes `<claudeDir>/<slug>/<sessionId>.jsonl` and returns its path. */
export async function writeClaudeSession(claudeDir: string, cwd: string, sessionId: string, body: string): Promise<string> {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(claudeDir, slug);
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(f, body);
  return f;
}
