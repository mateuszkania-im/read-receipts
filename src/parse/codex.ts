// Codex rollout parser (spec sections 3.2 and 5, Codex rules 1 to 6).
//
// Each rollout is one thread. In the 0.162 shape, the model sees the output of an `exec` (or `shell`)
// call, while `item_completed` `CommandExecution` events describe each command it ran, with
// `parsed_cmd` saying which ones were reads. Every command becomes its own `shell` tool call and
// result (so reads carry `ReadInfo`), and the chars of those results are taken off the enclosing
// call's output so nothing is counted twice. `exec` inputs are free text (JavaScript in code mode):
// they are never evaluated, only scanned for `*** Begin Patch` file headers.

import path from 'node:path';
import { newStats, streamJsonl } from '../io/jsonl.js';
import { regularFileChunks } from '../io/safe-read.js';
import { normalizePath } from '../io/paths.js';
import type { FileStats, LedgerEvent, ParsedThread, ReadInfo, ThreadMeta, ToolClass, Usage } from '../model.js';
import { bashReadLines, detectBashEdit, detectBashReadSpec, type BashRange } from './bash-read.js';
import { arr, hash16, isObj, num, obj, resolveAgainst, stableSystemPromptHash, str, type Obj } from './common.js';
import { mcpServerOf } from './claude.js';

export interface CodexThreadContext {
  maxLineBytes: number;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
const AGENTS_PREFIX = '# AGENTS.md instructions for';

/** Session id from a rollout file name (`rollout-<timestamp>-<uuid>.jsonl`): the last uuid in it. */
function idFromFileName(file: string): string {
  const name = path.basename(file).replace(/\.jsonl$/, '');
  const all = name.match(UUID);
  return all && all.length > 0 ? all[all.length - 1]! : name;
}

/**
 * `input_tokens` includes cache reads and cache writes (OpenAI's prompt-caching guide: ordinary input =
 * input − cached − cache writes). A 30m / 12h split of the writes is used when the record carries one
 * (`cache_write_input_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`, field names from the API, not yet
 * seen in a rollout); otherwise every write is a 30m write.
 */
function usageOf(u: Obj): Usage {
  const input = num(u.input_tokens) ?? 0;
  const cached = num(u.cached_input_tokens) ?? 0;
  const writes = num(u.cache_write_input_tokens) ?? 0;
  const details = obj(u.cache_write_input_tokens_details) ?? obj(u.cache_write_tokens_details);
  const w12h = details ? (num(details.ttl_12h_tokens) ?? 0) : 0;
  const w30m = details && num(details.ttl_30m_tokens) !== null ? num(details.ttl_30m_tokens)! : Math.max(0, writes - w12h);
  return {
    input: Math.max(0, input - cached - writes),
    output: num(u.output_tokens) ?? 0,
    cacheRead: cached,
    cacheWrite5m: w30m,
    cacheWrite1h: w12h,
  };
}

/** Text of a message or output content: a string, or the text entries of a list. Images never count. */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  const parts: string[] = [];
  for (const b of arr(c)) {
    const o = obj(b);
    if (!o) continue;
    if ((o.type === 'input_text' || o.type === 'output_text' || o.type === 'text') && typeof o.text === 'string') parts.push(o.text);
  }
  return parts.join('\n');
}

/**
 * A call output as text, and whether it reports a failure. Older `shell` outputs are a JSON string
 * `{"output": "...", "metadata": {"exit_code": n}}`; newer ones can be `{content, success}` objects.
 */
function unwrapOutput(output: unknown): { text: string; failed: boolean } {
  if (typeof output === 'string' && output.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(output);
      if (isObj(v) && typeof v.output === 'string') {
        const exit = num(obj(v.metadata)?.exit_code);
        return { text: v.output, failed: exit !== null && exit !== 0 };
      }
    } catch {
      // Not JSON: plain text output.
    }
  }
  if (isObj(output)) {
    const exit = num(output.exit_code) ?? num(obj(output.metadata)?.exit_code);
    const text = typeof output.output === 'string' ? output.output : contentText(output.content);
    return { text, failed: output.success === false || (exit !== null && exit !== 0) };
  }
  return { text: contentText(output), failed: false };
}

/** The script of a command array: `bash -lc <script>` gives the script, anything else is joined. */
function commandText(command: unknown): string {
  if (typeof command === 'string') return command;
  const parts = arr(command).filter((s): s is string => typeof s === 'string');
  if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && (parts[1] === '-lc' || parts[1] === '-c')) return parts[2]!;
  return parts.join(' ');
}

function patchPaths(text: string, cwd: string | null): { paths: string[]; onlyAdds: boolean } {
  const paths: string[] = [];
  let onlyAdds = true;
  for (const m of text.matchAll(PATCH_FILE)) {
    const p = (m[2] ?? '').trim();
    if (p === '') continue;
    paths.push(resolveAgainst(p, cwd));
    if (m[1] !== 'Add') onlyAdds = false;
  }
  return { paths, onlyAdds };
}

/** Whether the file has any `token_usage_record` (rule 2): a raw byte scan, no parsing. */
async function hasTokenUsageRecords(file: string): Promise<boolean> {
  const needle = Buffer.from('"token_usage_record"');
  let tail: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of regularFileChunks(file)) {
      const buf = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      if (buf.indexOf(needle) !== -1) return true;
      tail = buf.subarray(Math.max(0, buf.length - needle.length + 1));
    }
  } catch {
    return false;
  }
  return false;
}

async function scanMeta(file: string, ctx: CodexThreadContext): Promise<ThreadMeta> {
  const id = idFromFileName(file);
  const meta: ThreadMeta = {
    agent: 'codex',
    sessionId: id,
    threadId: id,
    parentThreadId: null,
    spawnedByCallId: null,
    file,
    version: null,
    entrypoint: null,
    cwd: null,
    gitBranch: null,
  };
  try {
    for await (const r of streamJsonl(file, { maxLineBytes: ctx.maxLineBytes }, newStats())) {
      if (!isObj(r)) continue;
      const p = obj(r.payload);
      if (r.type === 'session_meta' && p) {
        const sid = str(p.id);
        if (sid !== null) {
          meta.sessionId = sid;
          meta.threadId = sid;
        }
        meta.cwd = str(p.cwd);
        meta.version = str(p.cli_version);
        meta.entrypoint = str(p.originator);
        meta.gitBranch = str(obj(p.git)?.branch);
        if (meta.cwd !== null) break;
      } else if (r.type === 'turn_context' && p && meta.cwd === null) {
        meta.cwd = str(p.cwd);
        break;
      }
    }
  } catch {
    // Unreadable file: defaults from the file name.
  }
  return meta;
}

/**
 * Parses one Codex rollout. `meta` is computed on first access from the head of the file,
 * independently of `events`.
 */
/**
 * Codex names MCP tools `mcp__<server>__<tool>` (older builds: `<server>__<tool>`); no built-in Codex tool
 * has `__` in its name. Both give the `mcp__` form, so composition and the fingerprint see one convention.
 */
export function codexMcpTool(name: string): { tool: string; server: string } | null {
  if (name.startsWith('mcp__')) {
    const server = mcpServerOf(name);
    return server !== null ? { tool: name, server } : null;
  }
  const i = name.indexOf('__');
  return i > 0 && i < name.length - 2 ? { tool: `mcp__${name}`, server: name.slice(0, i) } : null;
}

export function parseCodexThread(file: string, ctx: CodexThreadContext, stats: FileStats): ParsedThread {
  let metaPromise: Promise<ThreadMeta> | null = null;
  return {
    get meta() {
      metaPromise ??= scanMeta(file, ctx);
      return metaPromise;
    },
    events: codexEvents(file, ctx, stats),
  };
}

interface OpenCall {
  tool: string;
  /** Chars of per-command results already emitted for this call, taken off its output. */
  consumed: number;
  commands: number;
  bashReadPath: string | null;
  bashReadRange: BashRange | null;
  /** The call's output was already emitted (a later CommandExecution then adds no chars). */
  outputDone: boolean;
}

async function* codexEvents(file: string, ctx: CodexThreadContext, stats: FileStats): AsyncGenerator<LedgerEvent> {
  const useRecords = await hasTokenUsageRecords(file);
  let threadId = idFromFileName(file);
  let model = 'unknown';
  let sessionCwd: string | null = null;
  let turnCwd: string | null = null;
  let branch: string | null = null;
  const seenResponses = new Set<string>();
  const calls = new Map<string, OpenCall>();
  const seenCommands = new Set<string>();
  /** A command's cwd, else the turn's, else the session's (Codex paths are relative to it). */
  const resolveCwd = (own: string | null): string | null => own ?? turnCwd ?? sessionCwd;
  /** Call ids in the order they were made, still waiting for their output. */
  const open: string[] = [];
  let lastTotal: Obj | null = null;
  let lastTotalTokens = 0;
  let compactionPending = false;
  const startLines = stats.lines;
  let lastTs = '';

  for await (const raw of streamJsonl(file, { maxLineBytes: ctx.maxLineBytes }, stats)) {
    if (!isObj(raw)) continue;
    const seq = stats.lines - startLines - 1;
    const ts = str(raw.timestamp) ?? lastTs;
    lastTs = ts;
    const type = str(raw.type);
    const p = obj(raw.payload);
    const base = () => ({ threadId, seq, ts });
    const injection = (source: 'system_prompt' | 'instructions' | 'other', name: string, text: string): LedgerEvent => ({
      kind: 'injection',
      ...base(),
      source,
      name,
      chars: text.length,
      hash: hash16(text),
      ...(source === 'system_prompt' ? { stableHash: stableSystemPromptHash(text) } : {}),
    });
    const request = (requestId: string, usage: Usage): LedgerEvent => {
      compactionPending = false;
      return { kind: 'request', ...base(), requestId, model, usage, cwd: turnCwd ?? sessionCwd, gitBranch: branch };
    };

    if (!p) {
      stats.skippedRecords++;
      continue;
    }

    switch (type) {
      case 'session_meta': {
        const sid = str(p.id);
        if (sid !== null) threadId = sid;
        sessionCwd = str(p.cwd);
        branch = str(obj(p.git)?.branch);
        const bi = str(obj(p.base_instructions)?.text) ?? str(p.instructions);
        if (bi !== null && bi !== '') yield injection('system_prompt', 'base_instructions', bi);
        break;
      }

      case 'turn_context': {
        model = str(p.model) ?? model;
        turnCwd = str(p.cwd) ?? turnCwd;
        break;
      }

      case 'token_usage_record': {
        const u = obj(p.usage);
        if (!useRecords || !u) break;
        const id = str(p.response_id) ?? `line-${seq}`;
        if (seenResponses.has(id)) break;
        seenResponses.add(id);
        yield request(id, usageOf(u));
        break;
      }

      case 'compacted': {
        if (!compactionPending) yield { kind: 'compaction', ...base(), trigger: 'unknown', preTokens: null };
        compactionPending = true;
        break;
      }

      case 'response_item':
        yield* responseItem(p);
        break;

      case 'event_msg':
        yield* eventMsg(p);
        break;

      default:
        // world_state and anything unknown.
        stats.skippedRecords++;
    }

    function* responseItem(item: Obj): Generator<LedgerEvent> {
      const itemType = str(item.type);
      if (itemType === 'message') {
        const role = str(item.role);
        const text = contentText(item.content);
        if (role === 'assistant') {
          if (text !== '') yield { kind: 'assistant_text', ...base(), text };
        } else if (role === 'developer' || role === 'system') {
          yield injection('system_prompt', 'developer', text);
        } else if (role === 'user') {
          const trimmed = text.trimStart();
          if (trimmed.startsWith(AGENTS_PREFIX)) {
            const dir = trimmed.slice(AGENTS_PREFIX.length).split('\n')[0]!.trim();
            yield injection('instructions', dir !== '' ? normalizePath(`${dir}/AGENTS.md`) : 'AGENTS.md', text);
          } else if (trimmed.startsWith('<user_instructions>')) {
            yield injection('instructions', 'AGENTS.md', text);
          } else if (trimmed.startsWith('<environment_context>')) {
            yield injection('other', 'environment_context', text);
          } else {
            compactionPending = false;
            yield { kind: 'user_prompt', ...base(), chars: text.length, text };
          }
        }
        return;
      }
      if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'local_shell_call') {
        const rawName = str(item.name) ?? (itemType === 'local_shell_call' ? 'shell' : 'unknown');
        const mcp = codexMcpTool(rawName);
        const name = mcp?.tool ?? rawName;
        const callId = str(item.call_id) ?? str(item.id) ?? `call-${seq}`;
        let input = str(item.input) ?? '';
        let shellScript: string | null = null;
        let workdir: string | null = null;
        const args = str(item.arguments);
        if (args !== null) {
          try {
            const v: unknown = JSON.parse(args);
            if (isObj(v)) {
              workdir = str(v.workdir);
              if (v.command !== undefined) shellScript = commandText(v.command);
              input = shellScript ?? str(v.input) ?? str(v.patch) ?? args;
            } else input = args;
          } catch {
            input = args;
          }
        }
        const action = obj(item.action);
        if (action && action.command !== undefined) shellScript = commandText(action.command);
        if (shellScript !== null) input = shellScript;

        const cwd = workdir ?? turnCwd ?? sessionCwd;
        const isPatch = name === 'apply_patch' || input.includes('*** Begin Patch');
        const patch = isPatch ? patchPaths(input, cwd) : { paths: [], onlyAdds: false };
        const sedEdit = shellScript !== null ? detectBashEdit(shellScript) : null;
        if (sedEdit !== null) for (const sp of sedEdit) patch.paths.push(resolveAgainst(sp, cwd));
        let toolClass: ToolClass;
        if (mcp !== null) toolClass = 'mcp';
        else if (isPatch && patch.paths.length > 0) toolClass = patch.onlyAdds ? 'write' : 'edit';
        else if (sedEdit !== null) toolClass = 'edit';
        else if (name === 'apply_patch') toolClass = 'edit';
        else if (shellScript !== null || name === 'exec' || name === 'shell' || name === 'exec_command') toolClass = 'bash';
        else toolClass = 'other';

        const bashRead = shellScript !== null ? detectBashReadSpec(shellScript) : null;
        calls.set(callId, { tool: name, consumed: 0, commands: 0, bashReadPath: bashRead !== null ? resolveAgainst(bashRead.path, cwd) : null, outputDone: false, bashReadRange: bashRead?.range ?? null });
        open.push(callId);
        compactionPending = false;
        yield { kind: 'tool_call', ...base(), callId, tool: name, toolClass, mcpServer: mcp?.server ?? null, paths: patch.paths, text: input };
        return;
      }
      if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        const callId = str(item.call_id) ?? `result-${seq}`;
        const call = calls.get(callId);
        if (call?.outputDone) {
          stats.skippedRecords++; // the same output again
          return;
        }
        if (call) call.outputDone = true;
        const at = open.indexOf(callId);
        if (at !== -1) open.splice(at, 1);
        const { text, failed } = unwrapOutput(item.output);
        let read: ReadInfo | null = null;
        const status = str(item.status);
        const isError = failed || status === 'failed' || status === 'error';
        if (call && call.commands === 0 && call.bashReadPath !== null && !isError) {
          read = { path: call.bashReadPath, ...bashReadLines(call.bashReadRange ?? { kind: 'unknown' }, text), contentHash: hash16(text) };
        }
        const chars = Math.max(0, text.length - (call?.consumed ?? 0));
        yield { kind: 'tool_result', ...base(), callId, tool: call?.tool ?? 'unknown', isError, chars, read, text };
        return;
      }
      // reasoning (encrypted) and other items carry nothing for v0.1.
    }

    function* eventMsg(ev: Obj): Generator<LedgerEvent> {
      const evType = str(ev.type);
      if (evType === 'context_compacted') {
        if (!compactionPending) yield { kind: 'compaction', ...base(), trigger: 'unknown', preTokens: null };
        compactionPending = true;
        return;
      }
      if (evType === 'token_usage_record') {
        const u = obj(ev.usage);
        const id = str(ev.response_id) ?? `line-${seq}`;
        if (useRecords && u && !seenResponses.has(id)) {
          seenResponses.add(id);
          yield request(id, usageOf(u));
        }
        return;
      }
      if (evType === 'token_count' && !useRecords) {
        const total = obj(obj(ev.info)?.total_token_usage);
        const totalTokens = total ? (num(total.total_tokens) ?? 0) : 0;
        if (total && totalTokens > lastTotalTokens) {
          const prev = lastTotal;
          const diff = (k: string) => (num(total[k]) ?? 0) - (prev ? (num(prev[k]) ?? 0) : 0);
          const delta: Obj = {
            input_tokens: diff('input_tokens'),
            cached_input_tokens: diff('cached_input_tokens'),
            cache_write_input_tokens: diff('cache_write_input_tokens'),
            output_tokens: diff('output_tokens'),
          };
          lastTotal = total;
          lastTotalTokens = totalTokens;
          yield request(`token_count:${seq}`, usageOf(delta));
        }
        return;
      }
      if (evType === 'item_completed') {
        const item = obj(ev.item);
        if (item && item.type === 'CommandExecution') {
          yield* commandExecution(item);
          return;
        }
      }
      // task_started, task_complete, thread_settings_applied, user_message and agent_message (which
      // repeat response items), token_count when token_usage_record exists, other items, unknown types.
      stats.skippedRecords++;
    }

    function* commandExecution(item: Obj): Generator<LedgerEvent> {
      const parentId = str(item.call_id) ?? open[open.length - 1] ?? null;
      const parent = parentId !== null ? calls.get(parentId) : undefined;
      const itemId = str(item.id);
      const n = parent ? parent.commands + 1 : 0;
      const callId = `${parentId ?? 'cmd'}#${itemId ?? n}`;
      if (seenCommands.has(callId)) {
        stats.skippedRecords++; // the same command reported again
        return;
      }
      seenCommands.add(callId);
      if (parent) parent.commands++;
      const cwd = resolveCwd(str(item.cwd));
      const script = commandText(item.command);
      const parsed = arr(item.parsed_cmd).map(obj).filter((x): x is Obj => x !== null);
      const readPaths = parsed.filter((x) => x.type === 'read' && typeof x.path === 'string').map((x) => resolveAgainst(x.path as string, cwd));
      const edited = detectBashEdit(script);
      let toolClass: ToolClass = 'bash';
      if (edited !== null) toolClass = 'edit';
      else if (parsed.length > 0 && readPaths.length === parsed.length) toolClass = 'read';
      else if (parsed.some((x) => x.type === 'search')) toolClass = 'search';
      else if (parsed.some((x) => x.type === 'list_files')) toolClass = 'list';
      const output = str(item.aggregated_output) ?? '';
      const exitCode = num(item.exit_code);
      const isError = exitCode !== null && exitCode !== 0;
      // The enclosing call's output holds this text. Counted here when it comes first, else already counted there.
      const counted = parent?.outputDone ? 0 : output.length;
      if (parent && !parent.outputDone) parent.consumed += output.length;
      compactionPending = false;
      const paths = edited !== null ? edited.map((e) => resolveAgainst(e, cwd)) : readPaths;
      yield { kind: 'tool_call', ...base(), callId, tool: 'shell', toolClass, mcpServer: null, paths, text: script };
      if (readPaths.length === 0 || isError || edited !== null) {
        yield { kind: 'tool_result', ...base(), callId, tool: 'shell', isError, chars: counted, read: null, text: output };
        return;
      }
      // One result per file read; the output is counted once, on the first.
      const contentHash = hash16(output);
      // With one read, its `cmd` gives the line range; several reads share one output, so their range is unknown.
      const cmd = readPaths.length === 1 ? str(parsed.find((x) => x.type === 'read')?.cmd) : null;
      const range: BashRange = (cmd !== null ? detectBashReadSpec(cmd)?.range : undefined) ?? { kind: 'unknown' };
      for (const [i, p] of readPaths.entries()) {
        const first = i === 0;
        yield {
          kind: 'tool_result',
          ...base(),
          callId,
          tool: 'shell',
          isError,
          chars: first ? counted : 0,
          read: { path: p, ...bashReadLines(range, output), contentHash },
          text: first ? output : '',
        };
      }
    }
  }
}
