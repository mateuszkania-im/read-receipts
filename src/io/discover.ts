import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceSession } from '../model.js';

export interface DiscoverOptions {
  claudeDir: string | null;
  codexDir: string | null;
  sinceMs: number | null;
  agent: 'claude' | 'codex' | 'all';
  includeSubagents: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODEX_ROLLOUT = /^rollout-.*\.jsonl$/;

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileInfo(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Every `*.jsonl` under `dir` (recursive, symlinks ignored), sorted. */
async function jsonlFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await entries(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonlFilesUnder(full)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out.sort();
}

async function claudeSessions(dir: string, opts: DiscoverOptions): Promise<SourceSession[]> {
  const out: SourceSession[] = [];
  for (const project of await entries(dir)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(dir, project.name);
    for (const e of await entries(projectDir)) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.slice(0, -'.jsonl'.length);
      const mainFile = path.join(projectDir, e.name);
      const main = await fileInfo(mainFile);
      if (!main) continue;
      const subagentFiles = opts.includeSubagents
        ? (await jsonlFilesUnder(path.join(projectDir, sessionId, 'subagents'))).filter((f) =>
            path.basename(f).startsWith('agent-'),
          )
        : [];
      let mtimeMs = main.mtimeMs;
      let sizeBytes = main.size;
      for (const f of subagentFiles) {
        const info = await fileInfo(f);
        if (!info) continue;
        mtimeMs = Math.max(mtimeMs, info.mtimeMs);
        sizeBytes += info.size;
      }
      if (opts.sinceMs !== null && mtimeMs < opts.sinceMs) continue;
      out.push({ agent: 'claude-code', sessionId, mainFile, subagentFiles, mtimeMs, sizeBytes });
    }
  }
  return out;
}

async function codexSessions(dir: string, opts: DiscoverOptions): Promise<SourceSession[]> {
  const out: SourceSession[] = [];
  for (const mainFile of await jsonlFilesUnder(dir)) {
    const name = path.basename(mainFile);
    if (!CODEX_ROLLOUT.test(name)) continue;
    const info = await fileInfo(mainFile);
    if (!info) continue;
    if (opts.sinceMs !== null && info.mtimeMs < opts.sinceMs) continue;
    const id = UUID.exec(name.slice(-'.jsonl'.length - 36))?.[0] ?? name.slice(0, -'.jsonl'.length);
    out.push({ agent: 'codex', sessionId: id, mainFile, subagentFiles: [], mtimeMs: info.mtimeMs, sizeBytes: info.size });
  }
  return out;
}

/**
 * Finds session files. Missing directories give no sessions, never an error. Files are filtered by
 * mtime against `sinceMs` before anything opens them.
 */
export async function discoverSessions(opts: DiscoverOptions): Promise<SourceSession[]> {
  const out: SourceSession[] = [];
  if (opts.claudeDir !== null && opts.agent !== 'codex') out.push(...(await claudeSessions(opts.claudeDir, opts)));
  if (opts.codexDir !== null && opts.agent !== 'claude') out.push(...(await codexSessions(opts.codexDir, opts)));
  return out;
}
