// Normalised event model (spec section 4). Parsers produce these; everything downstream sees only these.

export type AgentKind = 'claude-code' | 'codex';

/** Normalised usage: `input` is the uncached input only. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Claude `usage.speed` (`standard`, `fast`) when the log carries it: a pricing modifier. */
  speed?: string;
  /** Claude `usage.inference_geo` (`global`, `us`) when the log carries it: a pricing modifier. */
  inferenceGeo?: string;
}

export interface ThreadMeta {
  agent: AgentKind;
  sessionId: string;
  /** sessionId for the main thread, agentId for subagents, `sidechain:<id>` for legacy inline sidechains. */
  threadId: string;
  parentThreadId: string | null;
  spawnedByCallId: string | null;
  file: string;
  version: string | null;
  entrypoint: string | null;
  cwd: string | null;
  gitBranch: string | null;
}

export type ToolClass = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'list' | 'task' | 'mcp' | 'skill' | 'other';

export type InjectionSource =
  | 'system_prompt'
  | 'tool_schemas'
  | 'mcp_tool_schemas'
  | 'instructions'
  | 'skills_listing'
  | 'skill_body'
  | 'hook'
  | 'reattached_file'
  | 'compaction_summary'
  | 'other';

export interface ReadInfo {
  path: string;
  startLine: number;
  numLines: number;
  totalLines: number | null;
  contentHash: string;
  /** The line range is a guess (a Bash read whose range could not be parsed): never compare hashes by range. */
  approximate?: boolean;
  /** A `tail -n N` read: the last N lines, placed once the file length is known. */
  fromEnd?: number;
}

/** Fields every event carries. `seq` is the line order within the source file (stable sort key). */
interface EventBase {
  threadId: string;
  seq: number;
  ts: string;
}

export interface RequestEvent extends EventBase {
  kind: 'request';
  requestId: string;
  model: string;
  usage: Usage | null;
  cwd: string | null;
  gitBranch: string | null;
}

export interface ToolCallEvent extends EventBase {
  kind: 'tool_call';
  callId: string;
  tool: string;
  toolClass: ToolClass;
  mcpServer: string | null;
  paths: string[];
  /** Agent-authored input: every string value of the input, except a built-in tool's target path. */
  text: string;
  /** The shell command alone (Claude Code Bash), for read and edit detection; `text` also holds the description. */
  command?: string;
}

export interface ToolResultEvent extends EventBase {
  kind: 'tool_result';
  callId: string;
  tool: string;
  isError: boolean;
  chars: number;
  read: ReadInfo | null;
  /** Result content as it entered the context (text only, never image data). */
  text: string;
}

export interface UserPromptEvent extends EventBase {
  kind: 'user_prompt';
  chars: number;
  text: string;
}

export interface AssistantTextEvent extends EventBase {
  kind: 'assistant_text';
  text: string;
}

export interface InjectionEvent extends EventBase {
  kind: 'injection';
  source: InjectionSource;
  name: string;
  chars: number;
  /** Content hash (sha256, 16 hex). */
  hash: string;
  // Harness fingerprint inputs (spec 6.5), set only where the source has them:
  /** instructions: the file's scope (`User`, `Project`, `Local`, ...). */
  scope?: string;
  /** skills_listing: the skill digests, or the skill names when the listing has no digests. */
  digests?: string[];
  /** hook: hash of the hook command. */
  commandHash?: string;
  /** tool_schemas, mcp_tool_schemas and deferred_tools_delta: the tool names. */
  tools?: string[];
  /** system_prompt: hash with date, cwd and git status lines removed. */
  stableHash?: string;
  /** remote_session_change: the PR number the session was linked to (spec 6.6, explicit PR). */
  prNumber?: number;
  /** remote_session_change with a PR URL: its `owner/name`, lowercased. */
  prRepo?: string;
}

/** An explicit PR link of a session: the repo is known when the link was a URL. */
export interface PrLink {
  number: number;
  repo: string | null;
}

export interface CompactionEvent extends EventBase {
  kind: 'compaction';
  trigger: 'manual' | 'auto' | 'unknown';
  preTokens: number | null;
}

export interface HarnessCostEvent extends EventBase {
  kind: 'harness_cost';
  totalCostUSD: number;
}

export type LedgerEvent =
  | RequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | UserPromptEvent
  | AssistantTextEvent
  | InjectionEvent
  | CompactionEvent
  | HarnessCostEvent;

/** Per-file counters. Bad or unknown input is counted here, never thrown. */
export interface FileStats {
  lines: number;
  badLines: number;
  skippedRecords: number;
  longLines: number;
  /** JSON values nested deeper than 64 levels, skipped (security review F3). */
  deepValues: number;
}

export interface SourceSession {
  agent: AgentKind;
  sessionId: string;
  mainFile: string;
  subagentFiles: string[];
  /** Newest mtime of the main file and its subagent files. */
  mtimeMs: number;
  /** Total size of the main file and its subagent files. */
  sizeBytes: number;
}

/** What a parser returns for one source file. */
export interface ParsedThread {
  meta: Promise<ThreadMeta>;
  events: AsyncGenerator<LedgerEvent>;
}
