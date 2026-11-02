#!/usr/bin/env node
// Redacts a Claude Code session file into a test fixture (spec section 9.7).
//
//   node scripts/redact-fixture.mjs <in.jsonl> <out.jsonl> --repo-root <abs path> [--repo-root <alias>]
//        [--keep-branch] [--keep-mcp <server>]... [--keep-ids]
//   node scripts/redact-fixture.mjs --map-id <id>     prints the fake id the script uses for <id>
//
// Allow-list redaction. Keeps numbers, booleans and null; string values only at the record paths the
// parsers read (record type and subtype, version, entrypoint, model id, roles, content block types,
// tool names, attachment type, hook event, instruction scope, compaction trigger), record timestamps,
// and object keys only from a fixed list of known schema keys (plus model ids such as the keys of
// cost-state `modelUsage`). Inside tool inputs and tool results every string is redacted. Ids and uuids
// become stable fake ids of the same shape (`--keep-ids` leaves them, for re-redacting a fixture whose
// ids are already fake; other opaque ids are still mapped). Strings that are paths under the repo root become `/repo/...`. Read results
// become synthetic code with the same line count (`function fnN`). Every other string, and every other
// key, becomes `x` repeated to the same length. `api-request-blob` and `api-request-shape` records, which
// the parsers skip, are dropped. Always review the output by hand as well.

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** Paths (keys joined with `.`, arrays as `[]`) whose string values are kept verbatim. */
const KEEP_VALUE_PATHS = new Set([
  'type', 'subtype', 'version', 'entrypoint', 'level', 'userType', 'permissionMode', 'promptSource', 'operation',
  'message.model', 'message.role', 'message.type', 'message.stop_reason', 'message.usage.service_tier',
  'message.usage.speed', 'message.usage.inference_geo',
  'message.content[].type', 'message.content[].name',
  'message.content[].content[].type', 'message.content[].content[].source.type', 'message.content[].content[].source.media_type',
  'attachment.type', 'attachment.hookEvent', 'attachment.files[].type', 'attachment.content.type',
  'attachment.tools[].name', 'attachment.surfacedDefinitions[].name',
  'compactMetadata.trigger',
]);
/** Paths whose string value is a tool name (MCP names are masked unless --keep-mcp). */
const TOOL_NAME_PATHS = new Set(['message.content[].name', 'attachment.tools[].name', 'attachment.surfacedDefinitions[].name']);
/** Record timestamps; any other date-like string is redacted. */
const DATE_PATHS = new Set(['timestamp', 'attachment.date', 'snapshot.timestamp']);

/** Object keys of the Claude Code record schema and of the built-in tools' inputs and results. */
const KNOWN_KEYS = new Set(`
$schema -A -B -C -i -n -o addedBlocks addedLines addedNames addedTypes additionalProperties additionalWorkingDirectories
advisorModel agentId agentType allUuids anchorUuid anyOf apiBlockIndex args atis attachment attributionAgent base
baseline bashCount betas blockCount blockHashes blockIndex builtInPluginTypes builtInTypes cacheControl
cacheCreationEphemeral1hInputTokens cacheCreationEphemeral5mInputTokens cacheCreationInputTokens cacheReadInputTokens
cache_creation cache_creation_input_tokens cache_miss_reason cache_missed_input_tokens cache_read_input_tokens callNumber
caller canContinueAgent cliPrefix clientChange command commit compactMetadata container content context contextRendering
context_management copy costUSD countIsComplete create cumulativeDroppedTokens cwd dangerouslyDisableSandbox date
decision default defer_loading definition delaySeconds description diagnostics digests display displayPath durationMs
eager_input_streaming echoWireToolInputs editFileCount edits effort entries entrypoint enum ephemeral_1h_input_tokens
ephemeral_5m_input_tokens exclusiveMinimum exitCode failedMcpServers fallback_credit file filePath file_path filename
filenames files first firstChangedMessageIndex firstReportForThreadInProcess gitBranch gitStatus glob harnessNoteCount
harnessSectionHash harnessTailCount hasOutput hasUnknownModelCost hash headUuid head_limit hookAdditionalContext
hookCount hookErrors hookEvent hookInfos hookName id identity inference_geo inlineTools input inputTokens input_schema
input_tokens input_transformations interrupted isCompactSummary isGitRepo isImage isInitial isMeta isSidechain
isVisibleInTranscriptOnly isWorktree is_error isolation items iterations keep keptReminders kind kinds knowledgeCutoff
language last lastPrompt leafUuid level limit line lines linesAdded linesRemoved listing logicalParentUuid managedCommit
managedPr marketingName maxItems maxLength max_results max_tokens maximum message messageIndex minimum mode model
modelId modelUsage multiline name names needsAuthMcpServers newLines newStart newString new_string newlyDropped
noOutputExpected noop numFiles numLines object offset oldLines oldStart oldString old_string operation organizationUuid
originalFile osVersion otherToolCount outputTokens output_config output_mode output_tokens output_tokens_details pages
params parentUuid path pattern payload pendingMcpServers perTurnEffort permissionDecision permissionMode platform
postTokens pr preTokens preservedMessages preservedSegment preventedContinuation prompt promptId promptIndex
promptSource properties query querySource readCount readdedNames reason reasonCounts reasonType reminderFold
removedNames removedTypes rendered renderedBesideToolResult renderedRole replaceAll replace_all requestDigest requestId
requestRef requestedModel required resolvedModel role ruleSource run_in_background sandboxed schema scope searchCount
sendUserFileHint server_tool_use service_tier sessionId shape shapeHash shell showConcurrencyNote signature skill
skillCount slug snapshot source sourceToolAssistantUUID speed startLine startTime status stderr stdout stop stopReason
stop_details stop_reason stop_sequence structuredPatch subagent_type subtype summary surfacedDefinitions surfacedNames
system systemPrompt systemTurns tail tailUuid text thinking thinkingBlocksSent thinkingDisplay thinkingDurationMs
thinkingTokens thinkingTurnsSent thinking_tokens timeout timestamp tool toolChangeHeader toolInputCopies toolStats
toolUseID toolUseResult tool_use_id tools toolsUsed totalAPIDuration totalAPIDurationWithoutRetries totalCostUSD
totalDuration totalDurationMs totalLines totalLinesAdded totalLinesRemoved totalMatches totalTokens totalToolDuration
totalToolUseCount trigger truncated ttl turnCount turnIndex turnOrigin turnPosition type url usage userEmail
userModified userType uuid uuids value verbose version webSearchRequests web_fetch_requests web_search_requests
wireHiddenNames wireToolInputs workingDirectory media_type data parentToolUseID messageId promptSource
`.split(/\s+/).filter(Boolean));
/** Model ids used as keys (cost-state `modelUsage`). */
const MODEL_KEY = /^(claude|gpt)-[a-z0-9.-]+$/;
/** Records the parsers skip and that only carry request payloads. */
const DROP_TYPES = new Set(['api-request-blob', 'api-request-shape']);

const ID_KEYS = new Set([
  'uuid', 'parentUuid', 'logicalParentUuid', 'leafUuid', 'promptId', 'sessionId', 'requestId', 'id',
  'tool_use_id', 'toolUseId', 'toolUseID', 'sourceToolAssistantUUID', 'sourceToolUseID', 'agentId',
  'organizationUuid', 'messageId', 'parentToolUseID', 'headUuid', 'anchorUuid', 'tailUuid',
  'response_id', 'call_id', 'turn_id',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** Vendor ids such as `toolu_01...`, `msg_01...`, `req_01...`, `srvtoolu_01...` (used as values and as map keys). */
const ID_LIKE = /^(toolu|srvtoolu|msg|req)_[A-Za-z0-9]{16,}$/;
const PATHISH =/^[\w./@+-]*$/;
const SALT = 'read-receipts fixture ids v1';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const HEX = '0123456789abcdef';

/** Stable fake id with the same shape: prefix up to `_` kept, digits stay digits, case kept, hex stays hex. */
export function fakeId(value) {
  const m = /^([A-Za-z]+_)(.*)$/.exec(value);
  const prefix = m ? m[1] : '';
  const body = m ? m[2] : value;
  let stream = Buffer.alloc(0);
  let counter = 0;
  while (stream.length < body.length) {
    stream = Buffer.concat([stream, createHmac('sha256', SALT).update(`${counter++}:${value}`).digest()]);
  }
  const allHex = /^[0-9a-f-]+$/.test(body);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const b = stream[i];
    if (c === '-' || c === '_') out += c;
    else if (allHex) out += HEX[b % 16];
    else if (c >= '0' && c <= '9') out += String(b % 10);
    else if (c >= 'A' && c <= 'Z') out += UPPER[b % 26];
    else if (c >= 'a' && c <= 'z') out += LOWER[b % 26];
    else out += 'x';
  }
  if (UUID.test(value)) out = `${out.slice(0, 14)}4${out.slice(15, 19)}8${out.slice(20)}`;
  return prefix + out;
}

function xs(s) {
  return 'x'.repeat(s.length);
}

function syntheticCode(lineCount, startLine = 1) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) lines.push(`function fn${startLine + i}() { return ${i}; }`);
  return lines.join('\n');
}

/** Numbered `N\t...` lines as Claude Code shows Read output, same line count as `original`. */
function syntheticNumbered(original) {
  const lines = original.split('\n');
  const first = /^\s*(\d+)\t/.exec(lines[0] ?? '');
  const start = first ? Number(first[1]) : 1;
  return lines.map((_, i) => `${start + i}\tfunction fn${start + i}() { return ${i}; }`).join('\n');
}

export function createRedactor(opts) {
  const roots = new Set();
  for (const r of opts.repoRoots) {
    const root = r.replace(/\/+$/, '');
    roots.add(root);
    if (/^\/(tmp|var)\//.test(root)) roots.add(`/private${root}`);
    if (/^\/private\/(tmp|var)\//.test(root)) roots.add(root.slice('/private'.length));
  }
  const sortedRoots = [...roots].sort((a, b) => b.length - a.length);
  const keepMcp = new Set(opts.keepMcp ?? []);
  const readCallIds = new Set();
  /** Objects whose `content`/`text` string is already synthetic and must be kept as is. */
  const synthetic = new WeakSet();

  function mapPath(s) {
    for (const root of sortedRoots) {
      if (s === root) return '/repo';
      if (s.startsWith(`${root}/`) && PATHISH.test(s.slice(root.length))) return `/repo${s.slice(root.length)}`;
    }
    return null;
  }

  function str(s, key, at) {
    // --keep-ids keeps only ids of the shapes a first pass already faked (uuids, `toolu_...`); any other
    // value under an id key (a hook's 12-char toolUseID) is always mapped.
    const fakeShape = UUID.test(s) || ID_LIKE.test(s);
    if (key !== null && ID_KEYS.has(key)) return opts.keepIds && fakeShape ? s : fakeId(s);
    if (fakeShape) return opts.keepIds ? s : fakeId(s);
    if (TOOL_NAME_PATHS.has(at) && s.startsWith('mcp__')) {
      const parts = s.split('__');
      const server = parts[1] ?? '';
      if (keepMcp.has(server)) return s;
      return ['mcp', xs(server), ...parts.slice(2).map(xs)].join('__');
    }
    if (KEEP_VALUE_PATHS.has(at)) return s;
    if (at === 'gitBranch' && opts.keepBranch) return s;
    if (DATE_PATHS.has(at) && ISO.test(s)) return s;
    return mapPath(s) ?? xs(s);
  }

  /** Keys outside the fixed list become same-length `x` runs, made unique within their object. */
  function redactKey(k, taken) {
    let out;
    if (UUID.test(k) || ID_LIKE.test(k)) out = opts.keepIds ? k : fakeId(k);
    else if (KNOWN_KEYS.has(k) || MODEL_KEY.test(k)) out = k;
    else out = mapPath(k) ?? xs(k);
    for (let n = 1; taken.has(out); n++) out = `${out.slice(0, Math.max(0, out.length - String(n).length))}${n}`;
    taken.add(out);
    return out;
  }

  function walk(v, key, at, parent = null) {
    if (typeof v === 'string') {
      if (parent !== null && synthetic.has(parent) && (key === 'content' || key === 'text')) return v;
      return str(v, key, at);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, `${at}[]`));
    if (v !== null && typeof v === 'object') {
      const out = {};
      const taken = new Set();
      for (const [k, x] of Object.entries(v)) out[redactKey(k, taken)] = walk(x, k, at === '' ? k : `${at}.${k}`, v);
      return out;
    }
    return v;
  }

  /** Read-like file objects `{filePath, content}` get synthetic content of the same line count. */
  function synthFile(file) {
    if (file && typeof file === 'object' && typeof file.content === 'string' && typeof file.filePath === 'string') {
      const n = typeof file.numLines === 'number' ? file.numLines : file.content.split('\n').length;
      const start = typeof file.startLine === 'number' ? file.startLine : 1;
      const out = { ...file, content: syntheticCode(n, start) };
      synthetic.add(out);
      return out;
    }
    return file;
  }

  return function redactRecord(rec) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return walk(rec, null, '');
    if (DROP_TYPES.has(rec.type)) return null;
    const r = structuredClone(rec);
    const content = r.message?.content;
    if (r.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use' && b.name === 'Read' && typeof b.id === 'string') readCallIds.add(b.id);
    }
    if (r.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result' || !readCallIds.has(b.tool_use_id) || b.is_error === true) continue;
        if (typeof b.content === 'string') {
          b.content = syntheticNumbered(b.content);
          synthetic.add(b);
        } else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (c?.type !== 'text' || typeof c.text !== 'string') continue;
            c.text = syntheticNumbered(c.text);
            synthetic.add(c);
          }
        }
      }
    }
    if (r.toolUseResult && typeof r.toolUseResult === 'object' && r.toolUseResult.file) {
      r.toolUseResult.file = synthFile(r.toolUseResult.file);
    }
    if (r.type === 'attachment' && r.attachment?.type === 'file' && r.attachment.content?.file) {
      r.attachment.content.file = synthFile(r.attachment.content.file);
    }
    return walk(r, null, '');
  };
}

function main(argv) {
  const pos = [];
  const repoRoots = [];
  const keepMcp = [];
  let keepBranch = false;
  let keepIds = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root') repoRoots.push(argv[++i]);
    else if (a === '--keep-mcp') keepMcp.push(argv[++i]);
    else if (a === '--keep-branch') keepBranch = true;
    else if (a === '--keep-ids') keepIds = true;
    else if (a === '--map-id') {
      process.stdout.write(`${fakeId(argv[++i])}\n`);
      return 0;
    } else pos.push(a);
  }
  if (pos.length !== 2 || repoRoots.length === 0 || repoRoots.some((r) => !r)) {
    process.stderr.write('usage: redact-fixture.mjs <in.jsonl> <out.jsonl> --repo-root <abs path> [--keep-branch] [--keep-mcp <server>] [--keep-ids]\n');
    return 2;
  }
  const redact = createRedactor({ repoRoots, keepBranch, keepMcp, keepIds });
  const out = [];
  for (const line of readFileSync(pos[0], 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = redact(JSON.parse(line));
    if (r !== null) out.push(JSON.stringify(r));
  }
  writeFileSync(pos[1], `${out.join('\n')}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('redact-fixture.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
