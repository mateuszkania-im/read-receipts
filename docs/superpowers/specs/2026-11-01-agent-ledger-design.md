# read-receipts (working name agent-ledger): design spec

Date: 1 November 2026. Status: approved brief, spec for v0.1.
Novelty and name: [docs/novelty.md](../../novelty.md).

## 1. Intent

Coding agents spend most of their money re-sending context, not writing code. `read-receipts` is a local CLI that reads the session logs Claude Code and Codex already write and answers four questions per session, branch and PR:

1. What filled the context (system prompt, AGENTS.md/CLAUDE.md, skills, MCP tool schemas, tool results by tool, user prompts)?
2. Which files did the agent read and never refer to again ("unreferenced", never "wasted")?
3. Which files did it read again, with or without a change in between, and after a compaction?
4. What did it cost, cache-adjusted, including subagents and attempts that never merged, and how does that change when the harness (instruction files, skills, hooks, MCP servers) changes?

## 2. Goals and non-goals

Goals (v0.1):

- Claude Code parser as the main, fully supported source; pinned to fixtures of version 2.1.316 (versions 2.1.301 and 2.1.312 also seen locally).
- Codex parser for the rollout format seen locally (CLI 0.162.0-alpha) plus the older `shell`/`token_count` shape, with synthetic fixtures.
- Metrics in section 6 with exact formulas; every estimated number labelled as estimated.
- The unreferenced-read heuristic validated on at least 100 labelled reads from public-repo sessions, with its precision and the miss rate of "referenced" published. Recall is not published, because the labelled sample is stratified by the heuristic's call (11.4).
- Outputs: terminal summary, `--json`, self-contained HTML (`--html`), and `--share` for any of them.
- 1 GB of logs in under 60 s, streaming, bounded memory.

Non-goals (v0.1):

- LLM compaction probes (the Factory method). Listed as future work; the re-read-after-compaction proxy replaces them.
- Any network call other than the opt-in `gh` PR lookup. No telemetry, no update check, no remote fonts.
- Judging code quality or task success beyond PR state.
- Live/real-time monitoring, OpenTelemetry export, a Claude Code plugin. (Future work.)
- Other agents (Cursor, OpenCode, Gemini CLI). The event model leaves room for them.

## 3. Log formats (observed 1 November 2026)

Shapes were catalogued from local sessions of public repos only (why-diff and its bench runs, doc-router, recipe-units-agent) plus one throwaway synthetic session created to capture compaction, a subagent and Write. Every example below is synthetic.

### 3.1 Claude Code

Location: `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the session cwd with `/` and `.` replaced by `-`. Overridable with `CLAUDE_CONFIG_DIR`. Next to each session file:

- `<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json` (`{"agentType","description","toolUseId","spawnDepth","finished"}`); subagent records carry `isSidechain: true` and `agentId`.
- `<sessionId>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl` (same shape, nested one level).
- `<sessionId>/tool-results/` (large tool outputs spilled to disk; the transcript keeps only the stub that went into context, so we count the stub).
- Older versions wrote sidechain records inline in the session file with `isSidechain: true`. Both layouts are supported.

One JSON object per line. Record `type`s seen, and how we use them:

| `type` | Use |
|---|---|
| `assistant` | One line per content block of a model response. `message.id` and `requestId` repeat across the lines of one response and **every line repeats the same `message.usage`** (seen: 401 lines, 261 unique ids, 0 usage mismatches). Dedupe by `message.id`. Fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `entrypoint` (`cli`, `sdk-cli`, `sdk-py`), `isSidechain`, `agentId` (subagents), `message.model`, `message.content[]` (`text`, `thinking`, `tool_use`). |
| `user` | A user prompt (`message.content` is a string, or `text` blocks), or tool results (`tool_result` blocks with `tool_use_id`, `is_error`, `content` string or blocks), plus a structured `toolUseResult`. Flags: `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `promptSource`, `permissionMode`. |
| `attachment` | Harness injections. `attachment.type` seen: `instructions` (`files[]: {path, type: "User"|"Project"|..., content}`: CLAUDE.md/AGENTS.md), `skill_listing` (`names[]`, `digests[]`, `content`, `skillCount`), `prompt_snapshot` (`systemPrompt: string[]`, `tools: {name, description, schema}[]`), `deferred_tools_delta`, `deferred_tools_record`, `mcp_instructions_delta`, `hook_success` / `hook_additional_context` (`hookEvent`, `hookName`, `command`, `content`), `file` (a file re-attached by the harness, for example after a compaction: `{filename, displayPath, content: {type: "text", file: {...}}}`), `environment`, `session_context`, `date`, `model`, `total_tokens_reminder`, `structured_output`, `remote_session_change` (`pr`, `commit`, `url`), `thinking_drop`, `language`, `credential_org`, `command_permissions`. |
| `system` | `subtype: "compact_boundary"` with `compactMetadata: {trigger: "manual"|"auto", preTokens, durationMs, preservedSegment, preservedMessages}`; `subtype: "stop_hook_summary"`. |
| `cost-state` | Claude Code's own cumulative cost for the process: `totalCostUSD`, `modelUsage{model: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, cacheCreationEphemeral5mInputTokens, cacheCreationEphemeral1hInputTokens, costUSD}}`. Used as a cross-check and to expose calls that have no `assistant` record (the compaction call itself). |
| `api-request`, `api-request-blob`, `api-request-shape`, `atis-latch`, `last-prompt`, `ai-title`, `tools-used`, `queue-operation`, `mode`, `summary` (older) | Ignored in v0.1 (counted as "skipped records"). |

Usage on `assistant.message.usage`:

```json
{"input_tokens": 3, "output_tokens": 412, "cache_read_input_tokens": 25642,
 "cache_creation_input_tokens": 3706,
 "cache_creation": {"ephemeral_5m_input_tokens": 3706, "ephemeral_1h_input_tokens": 0},
 "output_tokens_details": {"thinking_tokens": 120}, "service_tier": "standard"}
```

`input_tokens` is the uncached remainder; total prompt = `input + cache_creation + cache_read`.

Tool calls (`tool_use.name`, `input` keys seen): `Read {file_path, offset?, limit?}`, `Edit {file_path, old_string, new_string, replace_all}`, `Write {file_path, content}`, `Bash {command, description}`, `Grep {pattern, path?, glob?, output_mode?, ...}`, `Glob {pattern, path?}`, `Agent`/`Task {description, prompt, subagent_type, run_in_background?}`, `Skill {skill}`, `StructuredOutput`, MCP tools named `mcp__<server>__<tool>`.

`toolUseResult` for a successful Read (synthetic):

```json
{"type": "text", "file": {"filePath": "/home/dev/shop/src/cart.ts", "content": "export function total(...", "numLines": 40, "startLine": 1, "totalLines": 40}}
```

For Write: `{"type": "create"|"update", "filePath", "content", "structuredPatch", "originalFile"}`. For Edit: `{"filePath", "oldString", "newString", "structuredPatch", "originalFile", "userModified"}`. For Agent: `{"status", "agentId", "agentType", "content": [...], "totalTokens", "usage", "toolStats": {"readCount", ...}}`. **The Agent result's `usage` duplicates the subagent's last request and must not be added to cost** (the subagent file holds every request).

Compaction sequence (synthetic, as observed):

```jsonl
{"type":"system","subtype":"compact_boundary","uuid":"b1","logicalParentUuid":"a9","compactMetadata":{"trigger":"manual","preTokens":41267}}
{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"parentUuid":"b1","message":{"role":"user","content":"This session is being continued ..."}}
{"type":"attachment","attachment":{"type":"file","displayPath":"src/cart.ts","filename":"/home/dev/shop/src/cart.ts","content":{"type":"text","file":{"filePath":"/home/dev/shop/src/cart.ts","content":"...","numLines":40,"startLine":1,"totalLines":40}}}}
```

The compaction model call has no `assistant` record; its cost shows only as a jump in the next `cost-state`.

### 3.2 Codex

Location: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` (overridable with `CODEX_HOME`). One local session was found (CLI `0.162.0-alpha.17.2`, originator Codex Desktop). It belongs to a private project, so only its key structure was catalogued and **all Codex fixtures are synthetic**.

Each line: `{"timestamp", "type", "payload"}` (newer lines also have `ordinal`). Types seen:

| `type` / `payload.type` | Use |
|---|---|
| `session_meta` | `id`, `cwd`, `cli_version`, `originator`, `model_provider`, `git: {branch, commit_hash}`, `base_instructions: {text, provenance}` (system prompt). |
| `turn_context` | `model`, `cwd`, `effort`, `turn_id`. Model per turn. |
| `response_item` / `message` | `role: user|assistant|developer`, `content[]` (`input_text`, `output_text`, `input_image`). AGENTS.md is injected as a user or developer message starting with `# AGENTS.md instructions for` (from Codex source; heuristic). |
| `response_item` / `function_call`, `custom_tool_call` | `name` (`exec`, `wait`, `shell`, `apply_patch`, ...), `arguments` (JSON string) or `input` (free text), `call_id`. |
| `response_item` / `function_call_output`, `custom_tool_call_output` | `call_id`, `output` (string or content list). |
| `response_item` / `reasoning` | Encrypted; ignored except for counting. |
| `event_msg` / `item_completed` with `item.type: "CommandExecution"` | `command[]`, `cwd`, `exit_code`, `aggregated_output`, **`parsed_cmd[]: {type: "read"|"search"|"list_files"|"unknown", cmd, path?, name?, query?}`**. Our read source for Codex. |
| `token_usage_record` | Per response: `payload.usage {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `response_id`. Observed: `cached_input_tokens <= input_tokens` in 70/70 records and `total = input + output`, so `input_tokens` **includes** cached tokens and `output_tokens` includes reasoning. |
| `event_msg` / `token_count` | `info.total_token_usage`, `info.last_token_usage` (same keys). Fallback when there is no `token_usage_record`. |
| `compacted`, `event_msg` / `context_compacted` | Compaction marker (from Codex source, not seen locally; synthetic fixture). |
| `world_state`, `event_msg` / `task_started`, `task_complete`, `thread_settings_applied` | Ignored. |

Codex subagent rollouts are separate files; v0.1 treats each rollout as its own session and links it to a parent only when `session_meta` names one (field name to be confirmed on a real multi-agent rollout; otherwise standalone).

## 4. Normalised event model

Parsers turn each source file into one ordered stream of events per **thread** (the main session, or one subagent). Everything downstream sees only these types (`src/model.ts`).

```ts
type AgentKind = 'claude-code' | 'codex';

interface Usage {            // normalised: input = uncached input only
  input: number; output: number; cacheRead: number;
  cacheWrite5m: number; cacheWrite1h: number;
}

interface ThreadMeta {
  agent: AgentKind; sessionId: string; threadId: string;   // threadId = sessionId for the main thread, agentId for subagents
  parentThreadId: string | null; spawnedByCallId: string | null;
  file: string; version: string | null; entrypoint: string | null;
  cwd: string | null; gitBranch: string | null;
}

type ToolClass = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'list' | 'task' | 'mcp' | 'skill' | 'other';

type LedgerEvent =
  | { kind: 'request'; seq: number; ts: string; requestId: string; model: string; usage: Usage | null; cwd: string | null; gitBranch: string | null }
  | { kind: 'tool_call'; seq: number; ts: string; callId: string; tool: string; toolClass: ToolClass; mcpServer: string | null;
      paths: string[]; text: string }                       // text = agent-authored input (command, new_string, prompt, pattern)
  | { kind: 'tool_result'; seq: number; ts: string; callId: string; tool: string; isError: boolean; chars: number;
      read: ReadInfo | null; text: string }                 // text = result content as it entered context
  | { kind: 'user_prompt'; seq: number; ts: string; chars: number; text: string }
  | { kind: 'assistant_text'; seq: number; ts: string; text: string }    // text and thinking blocks with readable text
  | { kind: 'injection'; seq: number; ts: string; source: InjectionSource; name: string; chars: number; hash: string }
  | { kind: 'compaction'; seq: number; ts: string; trigger: 'manual' | 'auto' | 'unknown'; preTokens: number | null }
  | { kind: 'harness_cost'; seq: number; ts: string; totalCostUSD: number }  // Claude Code cost-state

interface ReadInfo { path: string; startLine: number; numLines: number; totalLines: number | null; contentHash: string }

type InjectionSource = 'system_prompt' | 'tool_schemas' | 'mcp_tool_schemas' | 'instructions' | 'skills_listing'
  | 'skill_body' | 'hook' | 'reattached_file' | 'compaction_summary' | 'other';
```

Rules:

- Every event also carries `threadId: string` (the thread it belongs to; legacy inline sidechains get `sidechain:<agentId or chain root uuid>`).
- `seq` is the line order within the thread file (stable sort key; timestamps can tie).
- `text` fields live only in memory during analysis of one thread and are dropped before aggregation. They never reach `--share` output.
- Paths are normalised once: Windows separators to `/`, `..` resolved, and made repo-relative when under the thread's repo root (section 8). Matching is case-insensitive on win32 only.
- Unknown record types and unparseable lines are counted per file (`skippedRecords`, `badLines`), never thrown.

## 5. Parsing rules

Claude Code:

1. `assistant`: emit one `request` per unique `message.id` (first occurrence position; usage = per-field maximum over all lines of that response, since a streamed response can carry growing usage). Emit `assistant_text` for `text` and non-empty `thinking` blocks; `tool_call` for `tool_use`.
2. `user` with a string or text content and not `isMeta`/`isCompactSummary`: `user_prompt`. With `isCompactSummary`: `injection` source `compaction_summary`. With `tool_result` blocks: `tool_result`; `read` is filled from `toolUseResult.file` when the matching call was `Read` and `is_error` is false; `contentHash` = sha256 of `file.content`.
3. `attachment`: `instructions` gives one `injection` per file (`name` = path, `source` `instructions`); `skill_listing` gives `skills_listing`; `prompt_snapshot` gives `system_prompt` (sum of `systemPrompt` strings) plus `tool_schemas` and `mcp_tool_schemas` (tools split by the `mcp__` prefix, chars = `JSON.stringify(tool)`), emitted once per distinct hash per thread; `hook_success`/`hook_additional_context` give `hook`; `file` gives `reattached_file` (name = path); `deferred_tools_delta` with `surfacedDefinitions` gives `tool_schemas`/`mcp_tool_schemas`; the rest gives `other`.
4. `system` `compact_boundary`: `compaction`.
5. `cost-state`: `harness_cost`.
6. Tool classes: `Read` read, `Edit`/`MultiEdit`/`NotebookEdit` edit, `Write` write, `Bash` bash, `Grep` search, `Glob`/`LS` list, `Agent`/`Task` task, `Skill` skill (its result is also an `injection` `skill_body`), `mcp__*` mcp, else other.
7. Bash reads: a `Bash` command whose first simple command is `cat`, `head`, `tail`, `nl`, `less` or `sed -n` on exactly one path argument counts as a read (`read.path` set, `contentHash` of stdout). Anything piped or with globs is not a read. The line range is parsed for `sed -n 'A,Bp'`, `head -n N` and `tail -n N` (placed once the file length is known); any other range starts at line 1 and is marked approximate. `sed -i` (with or without `-n`) is an edit of its files, not a read.

Codex:

1. `turn_context.model` sets the model for following requests.
2. `token_usage_record` gives one `request` per `response_id`. Normalise, following OpenAI's prompt-caching guide (ordinary input = `input_tokens - cached_tokens - cache_write_tokens`; `cached_tokens` excludes writes): `cacheRead = cached_input_tokens`, `input = input_tokens - cached_input_tokens - cache_write_input_tokens`, `output = output_tokens`. Writes: when the record splits them (`cache_write_input_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`, the API's names, not yet seen in a rollout), 30m writes are `cacheWrite5m` and 12h writes `cacheWrite1h` (the table's 12h price); otherwise all of `cache_write_input_tokens` is `cacheWrite5m`. For models whose pricing page gives no write price, writes are priced at the input price and counted as approximate. Without any `token_usage_record` in the file, use `token_count`: one request per strictly increasing `total_token_usage.total_tokens`, usage = the difference from the previous total.
3. `CommandExecution` items: each `parsed_cmd` entry of type `read` with a `path` gives a `tool_result` with `read` set (hash of `aggregated_output`); `search` gives toolClass search; others bash.
4. `apply_patch` (as a tool name, or `*** Begin Patch` text anywhere in a tool input) gives `tool_call` edit/write with `paths` from `*** (Add|Update|Delete) File: <path>` lines.
5. `message` role user: `user_prompt`, except text starting with `# AGENTS.md instructions for` or `<environment_context>` which give `injection` (`instructions` / `other`). Role developer: `injection` `system_prompt`. Role assistant: `assistant_text`. `session_meta.base_instructions.text`: `injection` `system_prompt`.
6. `compacted` or `context_compacted`: `compaction` (`trigger` unknown, `preTokens` null).

## 6. Metrics (exact definitions)

Notation: a thread has requests `r_1..r_n` in `seq` order. A **segment** is the run of requests between two compactions (or thread start/end). `t(x) = ceil(chars(x) / 4)` is the token estimate for text `x`; every metric built on `t` is labelled `≈` in output.

### 6.1 Cost

Price table entry per model: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` in USD per million tokens. Model lookup: exact id, then the longest table id that the model id extends only by a non-version suffix (a release date such as `-20250514`, `@20250514` or `-2025-08-07`, a context tag such as `[1m]`, a provider version such as `-v1:0`, or `-latest`), else **unpriced**. So `claude-opus-4` prices `claude-opus-4-20250514` but never `claude-opus-4-9`, and `gpt-5` never prices `gpt-5-codex`. Unpriced requests are counted and listed by model, never guessed.

```
cost(r) = ( u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead
          + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h ) / 1e6
```

- Claude Code: when `cache_creation` has no 5m/1h split, all of `cache_creation_input_tokens` is `cacheWrite5m`.
- A request with `usage === null` or an unpriced model contributes `null`. Session cost = sum of non-null costs, plus `requestsMissingUsage` and `requestsUnpriced` counts; output prints "cost excludes N requests without usage / M unpriced" whenever either is non-zero, and the session cost is shown as a lower bound (`≥ $x`).
- Subagent threads add to their session; the parent's Agent `toolUseResult.usage` is never added.
- Pricing modifiers in Claude usage: `speed: "fast"` uses the model's fast-mode input and output prices from the pricing page, with the cache prices scaled by the same factor as input; `inference_geo: "us"` multiplies every price by 1.1 on Claude 4.6 and later. `standard`, `global` and `not_available` are standard pricing. Any other value, or a modifier on a model the table has no modifier price for, makes the request an **unpriced modifier**: left out of the cost, counted and listed by model and value, the cost shown as a lower bound, and never reported as unlogged harness cost (unlogged cost is not computed for a session with one).
- `unloggedCost = lastHarnessCost - computedCost` when the session has `harness_cost` events and every request was priced (Claude Code only). Reported as "harness calls without a transcript record (compaction and similar)". Negative values within 1% are shown as 0; larger mismatches are reported as a price-table warning.
- Default table `src/prices/defaults.json` holds the current Claude and OpenAI models with the source URL and retrieval date of each price. Prices are copied from the vendors' pricing pages when the table is written, never from memory. `--prices <file.json>` merges over the defaults.

Derived:

```
cacheHitShare  = Σ cacheRead / Σ (input + cacheWrite5m + cacheWrite1h + cacheRead)
costShare(src) = cost component of src / total cost   (input, output, cacheRead, cacheWrite)
```

### 6.2 Context composition

For each thread, per source `s`: `introduced(s) = Σ t(x)` over events of that source, where sources are the `InjectionSource` values plus `tool_result:<tool>` (by tool name, MCP grouped as `mcp:<server>`), `user_prompt` and `assistant_output` (exact `output` tokens). Reported next to the exact `promptTotal(r_1)` and the per-thread `Σ (input + cacheWrite + cacheRead)`; the gap is shown as `unattributed` (hidden system text, message framing, image tokens).

`processed(x) = t(x) * k(x)`, where `k(x)` = number of requests in the same segment that come after `x` (how many times it was re-sent). The system prompt and the tool and MCP tool schemas are re-sent with every request, also after a compaction: the latest snapshot of each is carried into every later segment (counted in `processed` for all its requests, not introduced again; a re-sent identical snapshot is not counted twice, a changed one replaces it). Composition is reported both as introduced and processed.

A re-sent source whose first snapshot is logged after the first request (Claude Code 2.1.316 writes its first `prompt_snapshot` without `tools`) is attributed from the first request after it. Its part of the first prompt cannot be attributed, so the first-request gap is labelled "unattributed (before first snapshot)" and the late sources are named (`lateSources`).

### 6.3 Reads and unreferenced reads

A **read** is a `tool_result` with `read !== null` and `isError === false`. Searches (`Grep`, Codex `search`) and listings are not reads.

A read `R` of path `P` in thread `T` is **referenced** if any agent-authored event `E` in `T` after `R` (by `seq`) matches one of:

1. **edit**: `E` is a `tool_call` of class edit or write with `P` in `E.paths`.
2. **path mention**: `E.text` (tool_call input or assistant_text) contains the repo-relative path of `P`, or its basename when the basename is at least 6 characters long and contains a `.` (so `index.ts` counts, `a.md` does not).
3. **symbol use**: `E.text` contains, as a whole word, one of the anchors of `R`.
4. **test title** (test files only): `E.text` contains, as a whole phrase, one of the test titles of `R`. Reason code `symbol`.
5. **edit-subject** (test files only): `E` is a `tool_call` of class edit or write whose path is a module `R` imports, or the same-named source file of `R`. Reason code `edit-subject`.

A **test file** is a read whose cwd-relative path has a basename matching `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py` or `*_test.go`, or lies under a directory named `test`, `tests`, `__tests__`, `spec` or `specs`. Its **test titles** are the string arguments of `it(...)`, `test(...)` and `describe(...)` (also `.only`, `.skip`, `.todo`, `.concurrent`, `.fails`) in quotes or a template literal without `${}`, 4 to 120 characters and at least two words, deduped, up to 30; they are added to the anchors as phrases. Its **imports** are the relative specifiers (`./x`, `../src/cart.js`) of `from`, `import`, `require(...)` and `import(...)`, resolved against the test file's directory, compared with the edited path without a code extension (`.js .ts .jsx .tsx .mjs .cjs .mts .cts .py .go .rb .rs`), so `../src/cart.js` matches an edit of `src/cart.ts` and `./x` matches `x/index.ts`. Its **same-named source file** is any non-test code file whose name without extension equals the test's subject name (`cart.test.js`, `test_cart.py`, `cart_test.go` give `cart`). Why: in the validation study (section 11) 10 of 33 false positives were test files read before a fix, used through their titles, expected values or the module under test, never through a declared identifier. Rule 5 is checked last, so a read that also matches rules 1 to 4 keeps that reason.

For subagent threads, the subagent's final answer (the parent's `tool_result` of the Agent call) also counts as an `E` for reads in the subagent, and the parent's events after that result count too.

**Anchors** of `R`: identifiers declared in the read content, from these patterns, in order of appearance, deduped, up to 30:
`(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module)\s+([A-Za-z_][A-Za-z0-9_]{3,})`, `export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_][A-Za-z0-9_]{3,})`, Markdown headings `^#{1,3}\s+(.{4,60})$` (whole heading text), JSON/YAML top-level keys `^\s{0,2}"?([A-Za-z_][A-Za-z0-9_-]{3,})"?\s*:`. Anchors in a fixed stoplist of 200 common words (`data`, `name`, `type`, `value`, `this`, `self`, `true`, `false`, `null`, `return`, `default`, `props`, `test`, `config`, ...; full list in `src/analysis/stoplist.ts`) are dropped.

Tool results, injections and user prompts never count as references: they are what the agent was given, not what it did.

Precisely: a read is **referenced** when a later agent-authored event (rules 1 to 5) refers back to it, and **unreferenced** otherwise. Path mentions (rule 2) must name the full repo-relative (cwd-relative) or absolute path; a shorter `/`-suffix or the basename counts only while no other file read or edited in the session shares that suffix, and a longer path that merely ends with it (`packages/other/src/a.ts` for `src/a.ts`) never counts. A Bash read of the same file (`cat src/a.ts`) is a re-read, not a reference to the earlier read. Anchors (rule 3) are taken from the file text with the Read line numbers (`N<tab>` or `N→`) stripped, and only identifier-shaped anchors count: camelCase or PascalCase with two humps, snake_case, kebab-case, or a token holding a digit or a dot; a Markdown heading of two or more words is kept as a phrase. Plain English words never count, stoplist or not. "Unreferenced" includes reads the agent used to rule something out without naming them again, so it does not mean the read was wasted; "referenced" includes files named only to dismiss them. Every report carries these definitions.

Output per read: `referenced: boolean`, `reason: 'edit' | 'path' | 'symbol' | 'edit-subject' | null`, `tokens: t(content)`.

**How to read the two classes** (from the validation study, section 11). "Unreferenced" is an **upper bound** on unused reads: it also holds reads the agent used without naming anything from them, most often a review verdict that paraphrases the code. "Referenced" is a **reliable signal** that the read was used. Reports and the README say this in these words and never present "unreferenced" as "unused".

**Likely unused (derived estimate).** When study numbers are configured, the report adds one line under the read numbers: `likely unused ≈ unreferenced reads × precision`, with a range "scaled from the precision CI" (unreferenced reads times each end of the 95% Wilson interval of that precision, the low end rounded down and the high end up; it is not a 95% interval for the count), labelled as an estimate and naming the sample it comes from (11.6). The numbers live in a constant table in `src/analysis/study.ts` (`STUDY`: precision, CI, the unused and scored counts behind it, unclear count, sample, the held-out miss rate of "referenced", date), filled in by hand from `study/results.json`. The method note of every report states the configured precision as "11 of 44 reads called unreferenced (v1, blind)" with its interval, the miss rate of "referenced", the upper-bound reading above, and why recall is not published. While `STUDY` is `null` the line is left out entirely, in every renderer, and `totals.estimated.likelyUnused` is `null` in the JSON. The estimate scales read counts only, not tokens or cost, because the precision was measured per read.

```
unreferencedReadRate   = #unreferenced reads / #reads
unreferencedTokenShare = Σ tokens(unreferenced reads) / Σ tokens(reads)      (≈, the headline)
unreferencedCarriedUSD = Σ carriedCost(R) over unreferenced reads              (≈)
carriedCost(R)         = t(R) * ( p.cacheWrite(r_a) + (m - a) * p.cacheRead(r_a) ) / 1e6
```

where `r_a` is the first request after `R` in its segment and `r_m` the last request of that segment. `p.cacheWrite` uses the 1h price if `r_a` wrote only 1h cache, else the 5m price. If `R` has no later request, carriedCost is 0.

### 6.4 Re-reads

Within one thread, a read `R2` of path `P` is a **re-read** if an earlier read `R1` of `P` exists in the same thread. Classified against the latest such `R1`:

- `unchanged`: no edit/write `tool_call` on `P` between `R1` and `R2`, and, when both reads cover the same line range, equal `contentHash`.
- `changed`: an edit/write on `P` in between, or a different hash for the same range.
- `afterCompaction`: a `compaction` lies between `R1` and `R2`. This flag combines with `unchanged`/`changed`.

```
rereadRate              = #re-reads / #reads
rereadUnchangedTokens   = Σ t(R2) over unchanged re-reads                       (≈)
compactionRereadRate    = #{P : P read before compaction C and re-read, unchanged, after C}
                          / #{P : P read before C}            (per compaction, then pooled per session)
reattachedThenReread    = #{P : harness re-attached P after C (reattached_file) and the agent still re-read P}
```

`compactionRereadRate` is the compaction-loss proxy: the agent needed a file again that it had already seen and that had not changed. It needs no LLM. It says nothing about information lost from the conversation itself (that is what the future Factory-style probes would measure).

### 6.5 Harness fingerprint

Per session (main thread only), each component is `sha256` of a canonical string, truncated to 12 hex chars:

- `instructions`: sorted `"<scope>:<path>:<sha256(content)>"`, the path relative to the git root of the session cwd (the cwd itself only when there is no repo), else `~`-relative, so a session started in a subfolder fingerprints like one started at the root; lines from `instructions` injections (Claude) or AGENTS.md messages (Codex).
- `skills`: sorted `skill_listing.digests`, or sorted names when digests are missing.
- `hooks`: sorted `"<hookEvent>:<hookName>:<sha256(command)>"` from hook injections.
- `mcp`: sorted MCP server names from `mcp__<server>__*` tool schemas and `deferred_tools_delta.addedNames`.
- `systemPrompt`: hash of the system prompt text with every per-session part removed or replaced, so one harness hashes the same in every session: the whole gitStatus block (blank lines included, up to the next heading or tag line, else the end), the date, time, cwd, platform and model lines, then uuids, absolute paths (memory, scratchpad and temp directories), dates and times replaced by placeholders. Checked on the real prompt snapshots of 80 public-repo sessions of one Claude Code version: one hash (it was 80 before).
- `model`: the most used model.
- `fingerprint` = hash of the six component hashes joined with `|`. A component that was not observed is `"-"`.

### 6.6 Attribution and cost per branch and PR

Per request: repo = git top level of the request's `cwd` (collapsing worktrees through `git rev-parse --git-common-dir`); branch = request `gitBranch` (Claude) or `session_meta.git.branch` (Codex). Requests of a subagent with `HEAD` or no branch inherit the parent thread's branch at that time.

PR matching, only with `--gh`: `gh pr list --repo <origin> --state all --limit 500 --json number,headRefName,state,createdAt,mergedAt,closedAt,title,url`, then a request belongs to PR `n` if `headRefName == branch` and `createdAt - 24h <= request.ts <= (mergedAt ?? closedAt ?? now)`. An explicit `remote_session_change.pr` in the session wins over branch matching. Without `--gh`: PR = the explicit links only; everything else stays at branch level.

Attribution works on request spans: consecutive requests of one thread with the same cwd and branch, within one hour of the span's first request (the PR window is tested at the span start). An explicit PR applies to the session's requests that are not on the default branch; without `--gh` its state is `unknown`. When `refs/remotes/origin/HEAD` is not known locally, `main` and `master` count as the default branch. A missing `gh`, no auth, a timeout or unreadable output is a warning and attribution stays at branch level.

Outcome per PR: `merged`, `open`, `closedUnmerged`. Per branch with no PR: `noPr`. Requests on the repo's default branch: `default`.

```
prCost(n)        = Σ cost(r) over requests attributed to n, subagents included
attempts(n)      = #sessions with at least one request attributed to n
attemptsNoEdit(n)= #those sessions with zero successful edit/write calls
unmergedSpend    = Σ cost over closedUnmerged PRs and noPr branches (the tokentab "dead spend"; credited in the README)
```

### 6.7 Compare

`compare --by <instructions|skills|hooks|mcp|systemPrompt|model|fingerprint>` groups sessions by that component and prints per group: sessions, median and p90 cost per session, median cost per merged PR, `unreferencedTokenShare`, `rereadRate`, `compactionRereadRate`, `cacheHitShare`. `--outcome merged|any` (default `any`) keeps only sessions in that PR state so groups are compared at the same outcome. `--split-at <ISO date>` instead groups by before/after a date. Groups with fewer than 5 sessions are marked "too few to compare" and the medians are hidden.

## 7. CLI surface

```
read-receipts [summary]              overall summary (default command)
read-receipts sessions               one row per session
read-receipts session <id-prefix>    one session: composition, reads, re-reads, compactions, subagents
read-receipts prs                    cost per branch and PR with outcomes
read-receipts compare --by <component> [--outcome merged|any] [--split-at <date>]
read-receipts prices                 effective price table and its sources

Common options:
  --since <30d|2w|12h|YYYY-MM-DD>    default 30d
  --until <date>
  --project <path>                   only sessions whose cwd is inside <path>
  --agent claude|codex|all           default all
  --claude-dir <dir>                 default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects
  --codex-dir <dir>                  default $CODEX_HOME/sessions or ~/.codex/sessions
  --no-subagents
  --prices <file.json>
  --gh                               look up PRs with the gh CLI (the only network use)
  --json                             machine output to stdout
  --html <file>                      write the HTML report
  --share                            redact for sharing (applies to terminal, --json and --html)
  --max-line-mb <n>                  default 256; longer lines are skipped and counted
```

Exit codes: 0 success, 1 runtime error, 2 usage error. No sessions found is exit 0 with a message naming the directories searched.

## 8. Reports

Terminal summary sections: period and source counts; cost (total, by model, cache share, missing-usage and unpriced notes, unlogged cost); context composition (top 8 sources, introduced and processed); reads (count, unreferenced rate and token share, carried cost, top 10 unreferenced files by tokens); re-reads (rates, top files); compactions (count, compaction re-read rate); subagents (count, cost share); top 5 sessions by cost; a "how to read this" footer with the heuristic's measured precision, the miss rate of "referenced", and why recall is not published.

`--json`: one object `{ schemaVersion: 1, generatedAt, options, totals, sessions[], branches[], prs[], compare?, warnings[] }`. Field names as in section 6.

HTML: one file, no external requests, enforced by `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`. Data is embedded as JSON in `<script type="application/json">` with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\uXXXX`. All text inserted by script uses `textContent`, never `innerHTML`. Sections: Summary, Where the money went, Context composition, Unreferenced reads, Re-reads and compactions, Cost per PR and branch, Subagents, Harness fingerprints and compare, Method and limits. Light and dark via `prefers-color-scheme`, works offline and printed.

## 9. Privacy and security rules

1. No network calls. The only child processes are `git` (read-only plumbing) and, with `--gh`, `gh`. Both are spawned with an argument array, never a shell.
2. `git` runs in directories named by untrusted logs, so every call is `git --no-pager -c core.fsmonitor=false -c core.hooksPath=<empty temp dir> -C <dir> rev-parse ...` (and `remote get-url origin`, `symbolic-ref refs/remotes/origin/HEAD`), only when `<dir>` exists and is a directory, with a 5 s timeout and `GIT_OPTIONAL_LOCKS=0`. `safe.directory` is never overridden: a repo git refuses is treated as "no repo".
3. Logs are untrusted input: `JSON.parse` only, keyed lookups use `Map` (no `obj[key]` writes with log-provided keys), no `eval`, no regex built from log text (literal `includes` and word-boundary checks with escaped input only).
4. Terminal output strips C0/C1 control characters and ANSI escapes from every log-derived string.
5. HTML: section 8 rules.
6. `--share` keeps only: numbers, model names, built-in tool names, repo basenames, repo-relative paths, PR numbers and states, fingerprint hashes, dates. It drops: absolute paths (paths outside a repo become `<outside-repo>`), the home directory, prompts, assistant text, tool inputs and results, commands, PR titles and URLs, branch names (replaced by `branch-<6-char label>`), session ids (replaced by `s-<8-char label>`), MCP server names (replaced by `server-<6-char label>`; Codex MCP tools `mcp__<server>__<tool>` or `<server>__<tool>` count too), tool names that are not Claude Code or Codex built-ins (replaced by `tool-<6-char label>`), cwd values. Labels are HMAC-SHA256 keyed by a per-machine random salt (`~/.config/read-receipts/salt`, or `$XDG_CONFIG_HOME/read-receipts/salt`, created on first use with mode 0600; `--share-salt <hex>` overrides it), so they are stable for one user and cannot be recovered by hashing common names. The hashed fingerprint components (instructions, skills, hooks, mcp, system prompt and the combined fingerprint) are keyed the same way under `--share`: each plain hash becomes HMAC-SHA256(salt, component and hash), 12 hex chars, one-to-one per salt, so `compare --by` groups still match; the model stays plain. Output without `--share` keeps the plain hashes of section 6.5. Redaction happens once, on the aggregate object, before any renderer sees it; renderers never receive raw events.
7. Fixtures: synthetic, or from public-repo sessions passed through `scripts/redact-fixture.mjs` (keeps keys, types, numbers, enum fields and tool names; replaces every other string with a same-length placeholder; maps paths to `/repo/...`), then reviewed by hand. Never from private folders, employer repos or any private project.

## 10. Performance

- Files are read with `fs.createReadStream` + `readline`, one thread at a time; per-thread state is released when the thread is analysed. Only aggregates and per-read records without text are kept across threads.
- Files are pre-filtered by mtime against `--since` before opening.
- Lines over `--max-line-mb` are skipped and counted (the one local Codex rollout has 617 lines in 358 MB).
- Target: 1 GB of mixed logs in under 60 s and under 1 GB RSS on a 2023 laptop. CI checks throughput on a generated 64 MB corpus (must exceed 17 MB/s); `npm run perf` runs the full 1 GB check locally.

## 11. Validation study ("What we measured")

1. **Corpus**: sessions whose cwd is inside one of exactly four public repos: `why-diff` (including its `bench/runs/*` sandboxes), `doc-router`, `recipe-units-agent`, and `agent-ledger` itself (this tool's own repo, published with this release). The allowlist is in `study/allowlist.json`; anything else is refused by the study scripts. Two local repos that were on the allowlist when the samples were drawn turned out not to be public; their 2 labels were removed before publication and every number was re-scored without them.
2. **Sampling**: `study/sample-reads.mjs` lists every read in the corpus, then draws a stratified random sample (seed fixed in the script) of at least 120 reads: proportional per repo, with at least 30 reads the heuristic calls unreferenced and 30 it calls referenced, so both classes have support. It writes one packet per read to `study/.work/` (gitignored): the read, then every later event in the thread with tool results truncated to 400 chars. Packets contain **no heuristic output**.
3. **Labelling**: a separate labeller agent follows `study/RUBRIC.md` and writes `study/labels.jsonl` lines `{sessionHash, repo, path, readOrdinal, label: "used"|"unused"|"unclear", reason}`. `sessionHash` = first 12 hex chars of sha256(sessionId); `path` is repo-relative; `reason` is at most 200 chars and must not quote file content. The rubric: **used** if the agent later edited the file, cited it, acted on a fact or identifier from it, or stated a conclusion that depends on it (including ruling out a hypothesis); **unused** if nothing later depends on it; **unclear** if the packet cannot decide.
4. **Scoring**: `study/score.mjs` joins labels with the heuristic output. Positive class = unreferenced/unused. Precision = TP/(TP+FP); the miss rate of "referenced" = unused/(used+unused) over reads called referenced, measured on the held-out sample. `unclear` excluded and counted. 95% Wilson intervals. Recall is not published: the sample takes every unreferenced read but only a subsample of referenced ones, so TP/(TP+FN) on it overstates recall and a real estimate needs reweighting by the sampling fractions. Writes `study/results.json`, `docs/STUDY.md` and the README block between `<!-- STUDY:START -->` and `<!-- STUDY:END -->`; `--check` (run in CI) fails when they are out of date.
5. **Aggregate numbers**: `study/aggregate.mjs` runs `read-receipts --json --share` over the corpus and writes totals only (sessions, requests, cost, unreferenced token share, re-read rate, compaction re-read rate, composition shares) with the run date and tool version. The README states the corpus composition honestly (see risk below) and the sentence "labelled by an LLM reviewer with a written rubric, blind to the heuristic". No predicted numbers anywhere before the run.

6. **Held-out validation and the configured numbers**: the rules derived from the first labels (6.3 rules 4 and 5) are not judged on those labels.
   - The first sample took every unreferenced read in the corpus (its floor), so the remaining candidates are all referenced but one. A held-out precision needs new sessions (about 200 paid runs for about 40 unreferenced reads); that is a follow-up, pending the owner's decision.
   - What is held out now: `study/sample-heldout.mjs` draws 90 reads with seed 20261103 from the candidates not in the first 150 that both versions call referenced, with the same fail-closed packet filter, into `study/.work/packets-heldout/`. `study/.work/predictions-heldout.json` holds the predictions of v1 (commit f74cc20, before the test-file rules, loaded from a checkout) and v2 for each read; the packets hold none. A fresh blind labeller writes `study/labels-heldout.jsonl`. It measures the miss rate of "referenced" (unused / (used + unused)), on reads no rule was derived from. After the removal of the non-public repos it holds 89 reads.
   - Configured `STUDY` numbers: the blind first-sample labels scored against v1, precision 11/44 = 0.250 (95% CI 0.146 to 0.394), shown as "11 of 44 reads called unreferenced (v1, blind)", 27 more unclear, 2026-11-02, labelled "blind labels, heuristic v1 before test-file rules 4 and 5, so conservative for the current heuristic"; with the held-out miss rate of "referenced", 3 of 81 = 0.037 (95% CI 0.013 to 0.103). It is a valid blind measurement of v1. v2 only turns unreferenced reads into referenced ones, and on that set it is at least as precise (TP unchanged, 9 false positives removed), so the v1 figure is a lower bound for v2's precision there. The v2 development-set figure (0.314, CI 0.186 to 0.480) was measured on the labels the rules came from and is never configured as the estimate.

Known corpus risk: the public-repo sessions found locally are almost all headless (`sdk-py`, `sdk-cli`) review and benchmark runs; none has a compaction, a subagent or an MCP call. The interactive sessions that build this tool (cwd `agent-ledger`) will add those. The study reports per-entrypoint counts so the reader can see the mix.

## 12. Future work

LLM compaction probes (Factory method), OpenTelemetry GenAI span export, a Claude Code plugin with a `/receipts` command, more agents (OpenCode, Gemini CLI, Cursor), live mode.
