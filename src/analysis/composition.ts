// Spec 6.2: what filled the context, per source, introduced once and processed (re-sent) per request.

import type { LedgerEvent } from '../model.js';
import { mcpServerOf } from '../parse/claude.js';
import { estTokens } from './reads.js';

export interface Composition {
  /** Keys: InjectionSource values, `tool_result:<tool>`, `mcp:<server>`, `user_prompt`, `assistant_output`. All ≈ except assistant_output. */
  sources: Map<string, { introduced: number; processed: number }>;
  /** Exact prompt tokens of the first request (input + cache writes + cache reads). */
  exactPromptFirst: number | null;
  /** Exact prompt tokens summed over every request of the thread. */
  exactPromptTotal: number;
  /** exactPromptFirst minus the estimated sources before it: hidden system text, framing, images (≈). */
  unattributedFirst: number | null;
  /**
   * Re-sent sources (system prompt, tool schemas) first logged after the first request. Their part of
   * the first prompt cannot be attributed, so the gap is labelled "unattributed (before first snapshot)".
   */
  lateSources: string[];
}

/** Sources the harness re-sends with every request, also after a compaction, until a newer snapshot replaces them. */
const PERSISTENT: ReadonlySet<string> = new Set(['system_prompt', 'tool_schemas', 'mcp_tool_schemas']);

interface SegmentSums {
  /** Σ tokens of the items in the segment. */
  tokens: number;
  /** Σ tokens × (requests in the segment before the item). */
  weighted: number;
}

export class CompositionPass {
  private readonly sources = new Map<string, { introduced: number; processed: number }>();
  /** Per key: sums for the current segment, so processed = Σ t × (m − c) settles in O(keys). */
  private segment = new Map<string, SegmentSums>();
  private segRequests = 0;
  private exactPromptFirst: number | null = null;
  private exactPromptTotal = 0;
  private beforeFirst = 0;
  private sawRequest = false;
  /** The latest snapshot of each re-sent source, by `source` and name, and whether it is in the current segment's sums. */
  private readonly persistent = new Map<string, { key: string; tokens: number }>();
  private readonly carried = new Map<string, number>();
  private readonly late = new Set<string>();

  onEvent(e: LedgerEvent): void {
    switch (e.kind) {
      case 'injection': {
        const tokens = estTokens(e.chars);
        if (PERSISTENT.has(e.source)) {
          const id = `${e.source}\u0000${e.name}`;
          if (this.sawRequest && !this.sources.has(e.source)) this.late.add(e.source);
          const carried = this.carried.get(id);
          if (carried !== undefined) {
            // The same snapshot re-sent after a compaction is already counted from the segment start.
            if (carried === tokens) return;
            // A changed one replaces the carried copy (carried at the segment start, so with no weight).
            this.carried.delete(id);
            this.uncarry(e.source, carried);
          }
          this.persistent.set(id, { key: e.source, tokens });
        }
        this.add(e.source, tokens);
        return;
      }
      case 'tool_result': {
        // A Skill result is also emitted as a skill_body injection; count it once, there.
        if (e.tool === 'Skill') return;
        const server = mcpServerOf(e.tool);
        this.add(server !== null ? `mcp:${server}` : `tool_result:${e.tool}`, estTokens(e.chars));
        return;
      }
      case 'user_prompt':
        this.add('user_prompt', estTokens(e.chars));
        return;
      case 'request': {
        if (e.usage !== null) {
          const prompt = e.usage.input + e.usage.cacheWrite5m + e.usage.cacheWrite1h + e.usage.cacheRead;
          this.exactPromptTotal += prompt;
          if (!this.sawRequest) this.exactPromptFirst = prompt;
        }
        this.sawRequest = true;
        this.segRequests++;
        // Output enters the context after this request and is re-sent by the later ones.
        if (e.usage !== null && e.usage.output > 0) this.add('assistant_output', e.usage.output, true);
        return;
      }
      case 'compaction':
        this.settle();
        return;
      default:
        return;
    }
  }

  finish(): Composition {
    this.settle();
    return {
      sources: new Map([...this.sources].map(([k, v]) => [k, { ...v }])),
      exactPromptFirst: this.exactPromptFirst,
      exactPromptTotal: this.exactPromptTotal,
      unattributedFirst: this.exactPromptFirst === null ? null : this.exactPromptFirst - this.beforeFirst,
      lateSources: [...this.late].sort(),
    };
  }

  private add(key: string, tokens: number, exact = false): void {
    let s = this.sources.get(key);
    if (!s) {
      s = { introduced: 0, processed: 0 };
      this.sources.set(key, s);
    }
    s.introduced += tokens;
    if (!this.sawRequest && !exact) this.beforeFirst += tokens;
    let seg = this.segment.get(key);
    if (!seg) {
      seg = { tokens: 0, weighted: 0 };
      this.segment.set(key, seg);
    }
    seg.tokens += tokens;
    seg.weighted += tokens * this.segRequests;
  }

  /** processed(x) = t(x) × (requests of the segment after x). */
  private settle(): void {
    const m = this.segRequests;
    for (const [key, seg] of this.segment) {
      const s = this.sources.get(key);
      if (s) s.processed += m * seg.tokens - seg.weighted;
    }
    this.segment = new Map();
    this.segRequests = 0;
    this.carried.clear();
    // Re-sent sources are present from the start of the next segment, without being introduced again.
    for (const [id, p] of this.persistent) {
      this.carry(p.key, p.tokens);
      this.carried.set(id, p.tokens);
    }
  }

  private carry(key: string, tokens: number): void {
    let seg = this.segment.get(key);
    if (!seg) {
      seg = { tokens: 0, weighted: 0 };
      this.segment.set(key, seg);
    }
    seg.tokens += tokens;
    seg.weighted += tokens * this.segRequests;
  }

  private uncarry(key: string, tokens: number): void {
    const seg = this.segment.get(key);
    if (seg) seg.tokens -= tokens;
  }
}
