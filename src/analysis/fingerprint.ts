// Spec 6.5: the harness fingerprint of a session (main thread only). Each component is the sha256 of a
// canonical string, 12 hex chars; a component that was not observed is "-".

import { createHash } from 'node:crypto';
import os from 'node:os';
import type { LedgerEvent, ThreadMeta } from '../model.js';
import { normalizePath } from '../io/paths.js';
import { mcpServerOf } from '../parse/claude.js';

export interface Fingerprint {
  instructions: string;
  skills: string;
  hooks: string;
  mcp: string;
  systemPrompt: string;
  /** The most used model id (plain, not hashed), or "-". */
  model: string;
  fingerprint: string;
}

export const UNOBSERVED = '-';

function hash12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function component(lines: Set<string>): string {
  return lines.size === 0 ? UNOBSERVED : hash12([...lines].sort().join('\n'));
}

/**
 * Relative to the git root (else the session cwd when there is no repo), or `~`-relative, so the same
 * file hashes the same across sessions, also when a session starts in a subfolder of the repo.
 */
function stablePath(p: string, base: string | null, home: string): string {
  if (base !== null) {
    const root = normalizePath(base);
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  if (home !== '' && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

export class FingerprintPass {
  private readonly instructions = new Set<string>();
  private readonly skills = new Set<string>();
  private readonly hooks = new Set<string>();
  private readonly mcp = new Set<string>();
  private readonly systemPrompt = new Set<string>();
  private readonly models = new Map<string, number>();
  private readonly home = normalizePath(os.homedir());

  /** `gitRoot`: the repo root of the session cwd; null falls back to the cwd itself. */
  constructor(private readonly gitRoot: string | null = null) {}

  onEvent(e: LedgerEvent, meta: ThreadMeta): void {
    switch (e.kind) {
      case 'injection':
        switch (e.source) {
          case 'instructions':
            this.instructions.add(`${e.scope ?? UNOBSERVED}:${stablePath(e.name, this.gitRoot ?? meta.cwd, this.home)}:${e.hash}`);
            return;
          case 'skills_listing':
            for (const d of e.digests ?? []) this.skills.add(d);
            return;
          case 'hook':
            this.hooks.add(`${e.name}:${e.commandHash ?? UNOBSERVED}`);
            return;
          case 'system_prompt':
            this.systemPrompt.add(e.stableHash ?? e.hash);
            return;
          default:
            if (e.source === 'mcp_tool_schemas') this.addServer(e.name);
            for (const t of e.tools ?? []) this.addServer(t);
            return;
        }
      case 'tool_call':
        if (e.mcpServer !== null) this.mcp.add(e.mcpServer);
        return;
      case 'request':
        this.models.set(e.model, (this.models.get(e.model) ?? 0) + 1);
        return;
      default:
        return;
    }
  }

  finish(): Fingerprint {
    let model = UNOBSERVED;
    let best = 0;
    for (const [m, n] of [...this.models].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (n > best) {
        model = m;
        best = n;
      }
    }
    const parts = {
      instructions: component(this.instructions),
      skills: component(this.skills),
      hooks: component(this.hooks),
      mcp: component(this.mcp),
      systemPrompt: component(this.systemPrompt),
      model,
    };
    const fingerprint = hash12(
      [parts.instructions, parts.skills, parts.hooks, parts.mcp, parts.systemPrompt, parts.model === UNOBSERVED ? UNOBSERVED : hash12(parts.model)].join('|'),
    );
    return { ...parts, fingerprint };
  }

  private addServer(toolName: string): void {
    const s = mcpServerOf(toolName);
    if (s !== null) this.mcp.add(s);
  }
}
