// Claude Code session parser (spec sections 3.1 and 5, Claude rules 1 to 7).
//
// One call parses one file. A subagent file (`<session>/subagents/agent-<id>.jsonl`) is its own thread:
// the caller passes `parentThreadId` and every event gets `ctx.threadId`. In a main file, records with
// `isSidechain: true` come from the older inline layout and go to `sidechain:<agentId or chain root>`.

import path from 'node:path';
import { newStats, streamJsonl } from '../io/jsonl.js';
import { normalizePath } from '../io/paths.js';
import type {
  FileStats,
  InjectionSource,
  LedgerEvent,
  ParsedThread,
  ReadInfo,
  RequestEvent,
  ThreadMeta,
  ToolClass,
  Usage,
} from '../model.js';
import { bashReadLines, detectBashEdit, detectBashReadSpec, type BashRange } from './bash-read.js';
import { arr, depthExceeds, hash16, isObj, num, obj, resolveAgainst, stableSystemPromptHash, str, type Obj } from './common.js';

export { stableSystemPromptHash };

export interface ClaudeThreadContext {
  threadId: string;
  parentThreadId: string | null;
  spawnedByCallId: string | null;
  maxLineBytes: number;
}

/** Input fields the agent wrote itself (rule: tool_call.text). */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
const NUMBERED_LINE = /^\s*(\d+)(?:\t|\u2192)(.*)$/;
const DISPLAY_LINE_LIMIT = 2000;
const SLASH_COMMAND = /^<command-(?:name|message|args)>/;
const COMMAND_OUTPUT = /^<local-command-(?:stdout|stderr|caveat)>/;

export function toolClassOf(name: string): ToolClass {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return 'write';
    case 'Bash':
      return 'bash';
    case 'Grep':
      return 'search';
    case 'Glob':
    case 'LS':
      return 'list';
    case 'Agent':
    case 'Task':
      return 'task';
    case 'Skill':
      return 'skill';
    default:
      return 'other';
  }
}

/** `mcp__<server>__<tool>` gives `<server>`. */
export function mcpServerOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const end = rest.indexOf('__');
  return end > 0 ? rest.slice(0, end) : rest || null;
}

function usageOf(u: unknown): Usage | null {
  const o = obj(u);
  if (!o) return null;
  const total = num(o.cache_creation_input_tokens) ?? 0;
  const split = obj(o.cache_creation);
  const w5 = split ? num(split.ephemeral_5m_input_tokens) : null;
  const w1 = split ? num(split.ephemeral_1h_input_tokens) : null;
  const hasSplit = w5 !== null || w1 !== null;
  const out: Usage = {
    input: num(o.input_tokens) ?? 0,
    output: num(o.output_tokens) ?? 0,
    cacheRead: num(o.cache_read_input_tokens) ?? 0,
    cacheWrite5m: hasSplit ? (w5 ?? 0) : total,
    cacheWrite1h: hasSplit ? (w1 ?? 0) : 0,
  };
  // Pricing modifiers (fast mode, data residency), kept only when the log carries them.
  const speed = str(o.speed);
  const geo = str(o.inference_geo);
  if (speed !== null) out.speed = speed;
  if (geo !== null) out.inferenceGeo = geo;
  return out;
}

/** Text that entered the context from a content value: a string, or the `text` blocks of a list. Images never count. */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  const parts: string[] = [];
  for (const b of arr(c)) {
    const o = obj(b);
    if (o && o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
  }
  return parts.join('\n');
}

function hasImage(c: unknown): boolean {
  return arr(c).some((b) => isObj(b) && b.type === 'image');
}

/** Most agent-authored text kept from one tool input or payload; longer text is cut (memory bound). */
const AUTHORED_CAP = 1_000_000;
const AUTHORED_DEPTH = 12;

/** Every string value of a JSON value, depth-first, up to AUTHORED_CAP chars in total. Keys are not text. */
function stringsOf(v: unknown, out: string[], budget: { left: number }, depth = 0): void {
  if (budget.left <= 0 || depth > AUTHORED_DEPTH) return;
  if (typeof v === 'string') {
    const s = v.length > budget.left ? v.slice(0, budget.left) : v;
    budget.left -= s.length;
    if (s !== '') out.push(s);
  } else if (Array.isArray(v)) {
    for (const x of v) stringsOf(x, out, budget, depth + 1);
  } else if (isObj(v)) {
    for (const x of Object.values(v)) stringsOf(x, out, budget, depth + 1);
  }
}

/**
 * The agent-authored text of a tool input: every string value at any depth (StructuredOutput answers,
 * TodoWrite items, subagent prompts, edits). The target path of a built-in tool (`file_path`, `path`,
 * `notebook_path` at the top level) is not text: a later Read of a file is a re-read, not a reference.
 */
export function authoredText(name: string, input: Obj): string {
  const parts: string[] = [];
  const budget = { left: AUTHORED_CAP };
  const skip: ReadonlySet<string> = name.startsWith('mcp__') ? new Set() : new Set<string>(PATH_KEYS);
  for (const [k, v] of Object.entries(input)) if (!skip.has(k)) stringsOf(v, parts, budget);
  return parts.join('\n');
}

/** A structured-output or final-answer payload as agent-authored text. */
export function payloadText(v: unknown): string {
  const parts: string[] = [];
  stringsOf(v, parts, { left: AUTHORED_CAP });
  return parts.join('\n');
}

/** Read output shown as numbered lines (`N\t...`), used when the record has no `toolUseResult.file`. */
function readFromNumbered(text: string, filePath: string): ReadInfo | null {
  const lines = text.split('\n');
  const body: string[] = [];
  let start: number | null = null;
  for (const line of lines) {
    const m = NUMBERED_LINE.exec(line);
    if (!m) break;
    if (start === null) start = Number(m[1]);
    body.push(m[2] ?? '');
  }
  if (start === null) return null;
  const info: ReadInfo = { path: normalizePath(filePath), startLine: start, numLines: body.length, totalLines: null, contentHash: hash16(body.join('\n')) };
  // Claude Code cuts displayed lines at 2000 chars, so the hash may not match the file's content hash.
  if (body.some((l) => l.length >= DISPLAY_LINE_LIMIT)) info.approximate = true;
  return info;
}

function readFromFile(file: Obj): ReadInfo | null {
  const filePath = str(file.filePath);
  const content = str(file.content);
  if (filePath === null || content === null) return null;
  return {
    path: normalizePath(filePath),
    startLine: num(file.startLine) ?? 1,
    numLines: num(file.numLines) ?? content.split('\n').length,
    totalLines: num(file.totalLines),
    contentHash: hash16(content),
  };
}

interface CallInfo {
  tool: string;
  toolClass: ToolClass;
  filePath: string | null;
  bashReadPath: string | null;
  bashReadRange: BashRange | null;
  skill: string | null;
}

async function scanMeta(file: string, ctx: ClaudeThreadContext): Promise<ThreadMeta> {
  const meta: ThreadMeta = {
    agent: 'claude-code',
    sessionId: path.basename(file).replace(/\.jsonl$/, ''),
    threadId: ctx.threadId,
    parentThreadId: ctx.parentThreadId,
    spawnedByCallId: ctx.spawnedByCallId,
    file,
    version: null,
    entrypoint: null,
    cwd: null,
    gitBranch: null,
  };
  let sawSession = false;
  try {
    for await (const r of streamJsonl(file, { maxLineBytes: ctx.maxLineBytes }, newStats())) {
      if (!isObj(r)) continue;
      const sid = str(r.sessionId);
      if (sid !== null && !sawSession) {
        meta.sessionId = sid;
        sawSession = true;
      }
      if (typeof r.cwd === 'string' || typeof r.version === 'string') {
        meta.version = str(r.version);
        meta.entrypoint = str(r.entrypoint);
        meta.cwd = str(r.cwd);
        meta.gitBranch = str(r.gitBranch);
        break;
      }
    }
  } catch {
    // Unreadable file: meta stays at its defaults; the events stream reports nothing.
  }
  return meta;
}

/**
 * Parses one Claude Code JSONL file. `meta` is computed on first access from the head of the file,
 * independently of `events`, so it can be awaited before, after or without iterating.
 */
export function parseClaudeThread(file: string, ctx: ClaudeThreadContext, stats: FileStats): ParsedThread {
  let metaPromise: Promise<ThreadMeta> | null = null;
  return {
    get meta() {
      metaPromise ??= scanMeta(file, ctx);
      return metaPromise;
    },
    events: claudeEvents(file, ctx, stats),
  };
}

/** A later line of an already emitted response: its usage, merged into the request by per-field maximum. */
interface UsageUpdate {
  kind: 'usage_update';
  requestId: string;
  usage: Usage | null;
}

function maxUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (a === null || b === null) return a ?? b;
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

/**
 * A response streamed over several lines can carry growing usage. The request is emitted at its first
 * line, but held (with everything after it) until the next response starts or the file ends, so its usage
 * is the per-field maximum over all its lines and the event order is unchanged.
 */
async function* claudeEvents(file: string, ctx: ClaudeThreadContext, stats: FileStats): AsyncGenerator<LedgerEvent> {
  let held: LedgerEvent[] = [];
  let open: RequestEvent | null = null;
  for await (const e of claudeRecordEvents(file, ctx, stats)) {
    if (e.kind === 'usage_update') {
      if (open !== null && open.requestId === e.requestId) open.usage = maxUsage(open.usage, e.usage);
      continue;
    }
    if (e.kind === 'request') {
      yield* held;
      held = [];
      open = e;
    }
    if (open !== null) held.push(e);
    else yield e;
  }
  yield* held;
}

async function* claudeRecordEvents(file: string, ctx: ClaudeThreadContext, stats: FileStats): AsyncGenerator<LedgerEvent | UsageUpdate> {
  const isSubagentFile = ctx.parentThreadId !== null;
  const seenMessages = new Set<string>();
  const callsById = new Map<string, CallInfo>();
  /** Last prompt_snapshot hash per thread and source, so unchanged snapshots are not repeated. */
  const lastSnapshot = new Map<string, string>();
  /** Legacy inline sidechains without agentId: uuid of a sidechain record to the uuid of its chain root. */
  const chainRoot = new Map<string, string>();
  const startLines = stats.lines;
  let lastTs = '';

  for await (const raw of streamJsonl(file, { maxLineBytes: ctx.maxLineBytes }, stats)) {
    if (!isObj(raw)) continue;
    const r = raw;
    const seq = stats.lines - startLines - 1;
    const ts = str(r.timestamp) ?? lastTs;
    lastTs = ts;
    const type = str(r.type);

    let threadId = ctx.threadId;
    if (!isSubagentFile && r.isSidechain === true) {
      const uuid = str(r.uuid);
      const parent = str(r.parentUuid);
      const root = (parent !== null ? chainRoot.get(parent) : undefined) ?? uuid ?? 'unknown';
      if (uuid !== null) chainRoot.set(uuid, root);
      threadId = `sidechain:${str(r.agentId) ?? root}`;
    }
    const base = { threadId, seq, ts };
    const cwd = str(r.cwd);

    const injection = (source: InjectionSource, name: string, text: string): LedgerEvent => ({
      kind: 'injection',
      ...base,
      source,
      name,
      chars: text.length,
      hash: hash16(text),
    });

    switch (type) {
      case 'assistant': {
        const msg = obj(r.message);
        if (!msg) break;
        const model = str(msg.model) ?? 'unknown';
        if (model === '<synthetic>') break; // harness error records, not model requests
        const id = str(msg.id) ?? str(r.requestId) ?? str(r.uuid) ?? `line-${seq}`;
        if (!seenMessages.has(id)) {
          seenMessages.add(id);
          yield { kind: 'request', ...base, requestId: id, model, usage: usageOf(msg.usage), cwd, gitBranch: str(r.gitBranch) };
        } else {
          yield { kind: 'usage_update', requestId: id, usage: usageOf(msg.usage) };
        }
        for (const b of arr(msg.content)) {
          const block = obj(b);
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            yield { kind: 'assistant_text', ...base, text: block.text };
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
            yield { kind: 'assistant_text', ...base, text: block.thinking };
          } else if (block.type === 'tool_use') {
            const name = str(block.name) ?? 'unknown';
            const callId = str(block.id) ?? `call-${seq}`;
            const input = obj(block.input) ?? {};
            const toolClass = toolClassOf(name);
            const paths: string[] = [];
            for (const k of PATH_KEYS) {
              const p = str(input[k]);
              if (p !== null && p !== '') paths.push(normalizePath(p));
            }
            const command = name === 'Bash' ? str(input.command) : null;
            const bashRead = command !== null ? detectBashReadSpec(command) : null;
            const bashEdit = command !== null ? detectBashEdit(command) : null;
            if (bashEdit !== null) for (const p of bashEdit) paths.push(resolveAgainst(p, cwd));
            callsById.set(callId, {
              tool: name,
              toolClass,
              filePath: str(input.file_path),
              bashReadPath: bashRead !== null ? resolveAgainst(bashRead.path, cwd) : null,
              bashReadRange: bashRead?.range ?? null,
              skill: name === 'Skill' ? str(input.skill) : null,
            });
            yield {
              kind: 'tool_call',
              ...base,
              callId,
              tool: name,
              toolClass: bashEdit !== null ? 'edit' : toolClass,
              mcpServer: mcpServerOf(name),
              paths,
              text: authoredText(name, input),
              ...(command !== null ? { command } : {}),
            };
          }
        }
        break;
      }

      case 'user': {
        const msg = obj(r.message);
        if (!msg) break;
        const content = msg.content;
        const blocks = arr(content).map(obj).filter((b): b is Obj => b !== null);
        const toolResults = blocks.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          const tur = r.toolUseResult;
          for (const b of toolResults) {
            const callId = str(b.tool_use_id) ?? `result-${seq}`;
            const call = callsById.get(callId);
            const tool = call?.tool ?? 'unknown';
            const isError = b.is_error === true;
            const text = contentText(b.content);
            let read: ReadInfo | null = null;
            const image = hasImage(b.content) || (isObj(tur) && (tur.type === 'image' || tur.isImage === true));
            if (!isError && !image && call) {
              if (call.tool === 'Read') {
                const f = isObj(tur) ? obj(tur.file) : null;
                read = f ? readFromFile(f) : null;
                if (read === null && call.filePath !== null) read = readFromNumbered(text, call.filePath);
              } else if (call.bashReadPath !== null) {
                const stdout = isObj(tur) ? (str(tur.stdout) ?? text) : text;
                read = { path: call.bashReadPath, ...bashReadLines(call.bashReadRange ?? { kind: 'unknown' }, stdout), contentHash: hash16(stdout) };
              }
            }
            yield { kind: 'tool_result', ...base, callId, tool, isError, chars: text.length, read, text };
            if (call?.tool === 'Skill' && !isError) yield injection('skill_body', call.skill ?? 'unknown', text);
          }
          break;
        }
        const text = contentText(content);
        const lead = text.trimStart();
        if (r.isCompactSummary === true) yield injection('compaction_summary', 'compaction_summary', text);
        else if (r.isMeta === true) yield injection('other', 'user_meta', text);
        else if (SLASH_COMMAND.test(lead)) yield injection('other', 'slash_command', text);
        else if (COMMAND_OUTPUT.test(lead)) yield injection('other', 'command_output', text);
        else yield { kind: 'user_prompt', ...base, chars: text.length, text };
        break;
      }

      case 'attachment': {
        const a = obj(r.attachment);
        if (!a) break;
        yield* attachmentEvents(a, r, base, lastSnapshot, injection, stats);
        break;
      }

      case 'system': {
        if (r.subtype !== 'compact_boundary') {
          stats.skippedRecords++;
          break;
        }
        const m = obj(r.compactMetadata);
        const trigger = m?.trigger === 'manual' || m?.trigger === 'auto' ? m.trigger : 'unknown';
        yield { kind: 'compaction', ...base, trigger, preTokens: m ? num(m.preTokens) : null };
        break;
      }

      case 'cost-state': {
        const total = num(r.totalCostUSD);
        if (total !== null) yield { kind: 'harness_cost', ...base, totalCostUSD: total };
        break;
      }

      default:
        // Ignored in v0.1 (api-request, api-request-blob, api-request-shape, atis-latch, last-prompt,
        // ai-title, tools-used, queue-operation, mode, summary) and unknown types alike.
        stats.skippedRecords++;
    }
  }
}

function* attachmentEvents(
  a: Obj,
  r: Obj,
  base: { threadId: string; seq: number; ts: string },
  lastSnapshot: Map<string, string>,
  injection: (source: InjectionSource, name: string, text: string) => LedgerEvent,
  stats: FileStats,
): Generator<LedgerEvent> {
  const kind = str(a.type) ?? 'unknown';
  switch (kind) {
    case 'instructions':
      for (const f of arr(a.files)) {
        const o = obj(f);
        if (!o) continue;
        const p = str(o.path);
        const scope = str(o.type);
        const ev = injection('instructions', p !== null ? normalizePath(p) : 'unknown', str(o.content) ?? '');
        yield scope !== null && ev.kind === 'injection' ? { ...ev, scope } : ev;
      }
      return;
    case 'skill_listing':
      {
        const strings = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string');
        const digests = strings(a.digests);
        const ev = injection('skills_listing', 'skill_listing', str(a.content) ?? '');
        yield ev.kind === 'injection' ? { ...ev, digests: digests.length > 0 ? digests : strings(a.names) } : ev;
      }
      return;
    case 'prompt_snapshot': {
      const changed = (source: InjectionSource, name: string, text: string): LedgerEvent | null => {
        const ev = injection(source, name, text);
        if (ev.kind !== 'injection') return null;
        const key = `${base.threadId}\u0000${source}`;
        if (lastSnapshot.get(key) === ev.hash) return null;
        lastSnapshot.set(key, ev.hash);
        return ev;
      };
      const sys = arr(a.systemPrompt).filter((s): s is string => typeof s === 'string');
      if (sys.length > 0) {
        const text = sys.join('');
        const ev = changed('system_prompt', 'system_prompt', text);
        if (ev && ev.kind === 'injection') yield { ...ev, stableHash: stableSystemPromptHash(text) };
      }
      if (Array.isArray(a.tools)) {
        const builtIn: string[] = [];
        const mcp: string[] = [];
        const builtInNames: string[] = [];
        const mcpNames: string[] = [];
        for (const t of a.tools) {
          // JSON.stringify recurses: a value nested past the cap is skipped and counted (F3).
          if (depthExceeds(t)) {
            stats.deepValues++;
            continue;
          }
          const name = isObj(t) ? (str(t.name) ?? '') : '';
          const isMcp = name.startsWith('mcp__');
          (isMcp ? mcp : builtIn).push(JSON.stringify(t));
          if (name !== '') (isMcp ? mcpNames : builtInNames).push(name);
        }
        const b = changed('tool_schemas', 'tools', builtIn.join(''));
        if (b && b.kind === 'injection') yield { ...b, tools: builtInNames };
        if (mcp.length > 0) {
          const m = changed('mcp_tool_schemas', 'mcp_tools', mcp.join(''));
          if (m && m.kind === 'injection') yield { ...m, tools: mcpNames };
        }
      }
      return;
    }
    case 'hook_success':
    case 'hook_additional_context': {
      const content = Array.isArray(a.content) ? a.content.filter((s): s is string => typeof s === 'string').join('\n') : (str(a.content) ?? '');
      const ev = injection('hook', `${str(a.hookEvent) ?? 'unknown'}:${str(a.hookName) ?? 'unknown'}`, content);
      const command = str(a.command);
      yield command !== null && ev.kind === 'injection' ? { ...ev, commandHash: hash16(command) } : ev;
      return;
    }
    case 'file': {
      const inner = obj(obj(a.content)?.file);
      const p = str(a.filename) ?? (inner ? str(inner.filePath) : null);
      yield injection('reattached_file', p !== null ? normalizePath(p) : 'unknown', inner ? (str(inner.content) ?? '') : '');
      return;
    }
    case 'structured_output': {
      // The final structured answer of a headless run is agent-authored: references are checked in it.
      const text = payloadText(a.data);
      if (text !== '') yield { kind: 'assistant_text', ...base, text };
      break;
    }
    case 'deferred_tools_delta': {
      const defs = arr(a.surfacedDefinitions);
      const added = arr(a.addedNames).filter((x): x is string => typeof x === 'string');
      if (defs.length > 0) {
        // The definitions carry the chars; the added names go on a zero-char marker for the fingerprint.
        if (added.length > 0) {
          const marker = injection('other', 'deferred_tools_delta', '');
          if (marker.kind === 'injection') yield { ...marker, tools: added };
        }
        for (const d of defs) {
          const o = obj(d);
          if (!o) continue;
          const name = str(o.name) ?? 'unknown';
          const def = o.definition ?? o;
          if (depthExceeds(def)) {
            stats.deepValues++;
            continue;
          }
          yield injection(name.startsWith('mcp__') ? 'mcp_tool_schemas' : 'tool_schemas', name, JSON.stringify(def));
        }
        return;
      }
      break;
    }
    default:
      break;
  }
  // Everything else: what the harness rendered into the context, if anything.
  const rendered = arr(r.rendered)
    .map((x) => (isObj(x) ? str(x.content) : null))
    .filter((s): s is string => s !== null)
    .join('\n');
  const tools = kind === 'deferred_tools_delta' ? arr(a.addedNames).filter((x): x is string => typeof x === 'string') : [];
  const prNumber = kind === 'remote_session_change' ? prNumberOf(a.pr) : null;
  const prRepo = prNumber !== null ? prRepoOf(a.pr) : null;
  if (rendered !== '' || tools.length > 0 || prNumber !== null) {
    const ev = injection('other', kind, rendered);
    if (ev.kind !== 'injection') return;
    yield { ...ev, ...(tools.length > 0 ? { tools } : {}), ...(prNumber !== null ? { prNumber } : {}), ...(prRepo !== null ? { prRepo } : {}) };
  }
}

/** A PR number from `remote_session_change.pr`: a number, digits, `#12`, or a URL ending in `/pull/12`. */
export function prNumberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^#?(\d{1,9})$/.exec(v.trim()) ?? /\/pull\/(\d{1,9})(?:[/?#]|$)/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** `owner/name` (lowercased) of a PR URL `https://<host>/<owner>/<name>/pull/<n>`, else null. */
export function prRepoOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d{1,9}(?:[/?#]|$)/.exec(v.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
