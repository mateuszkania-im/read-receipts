# read-receipts (agent-ledger) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local CLI, `read-receipts`, that reads Claude Code and Codex session logs and reports context composition, unreferenced reads, re-reads (also after compaction), cache-adjusted cost per session, branch and PR, and harness fingerprints with a before/after compare.

**Architecture:** Source files are discovered, then streamed line by line through a per-agent parser into one normalised event stream per thread (`src/model.ts`). A per-session analyser runs the metric passes (cost, reads, composition, fingerprint) in one pass over each thread, keeps only aggregates, and drops all text. Attribution joins sessions to repo, branch and (opt-in) PR. Renderers (terminal, JSON, HTML) only see the aggregate report, after `--share` redaction when requested.

**Tech Stack:** TypeScript 7 (ESM, NodeNext, strict), Node >= 20, vitest 5, oxlint, esbuild standalone bundle (`bin/read-receipts.mjs`), commander and picocolors bundled (no runtime dependencies).

**Spec:** `docs/superpowers/specs/2026-11-01-agent-ledger-design.md` (read it with this plan; section numbers below refer to it). Novelty and name: `docs/novelty.md`.

## Global Constraints

- Package and command name `read-receipts`; folder keeps the working name `agent-ledger` until release.
- Node `>=20`; `"type": "module"`; tsconfig `strict`, `noUncheckedIndexedAccess`; no `any` in `src/`.
- Zero runtime dependencies: everything ships inside `bin/read-receipts.mjs` built by `scripts/build.mjs`; `npm run check:bundle` must pass in CI after Task 8.
- No network calls. Only child processes: `git` (spec section 9.2 flags) and `gh` behind `--gh`, both spawned with `execFile`/`spawn` argument arrays, never a shell.
- User-facing wording: "unreferenced", never "wasted" or "unused"; every estimated number is printed with a leading `≈` and carries `estimated: true` in JSON.
- No em dashes and no arrows in README, CLI output or report copy.
- Fixtures are synthetic or redacted public-repo sessions (spec section 9.7). Nothing from private folders, employer repos or other private projects (the controller's brief, kept outside this repo, names them). Codex fixtures are synthetic only.
- Paths in all outputs use `/`; repo-relative whenever under a repo root.
- Every task ends with `npm run typecheck && npm run lint && npm test` green.
- Commits: conventional prefixes (`feat:`, `test:`, `docs:`, `chore:`), no attribution trailers, on `main` locally; no push until release.

## Review Focus

1. A session file whose last line is truncated because the agent is still writing it: earlier records must be analysed and the partial line counted in `badLines`, never thrown (test in Task 1).
2. One file reached through different spellings (`./src/a.ts`, absolute path, `/private/tmp` vs `/tmp` on macOS, `C:\repo\src\a.ts`): must be one path for re-reads and references (test in Task 1).
3. A session that changes branch or cwd halfway (worktree, `git checkout`): attribution is per request, not per session (test in Task 7).
4. Model ids the table does not know, including Claude Code's `<synthetic>` error records with zero usage: unknown ids are "unpriced" and listed; `<synthetic>` records are not requests at all (test in Task 4).
5. Image or base64 content in tool results (Read of a PNG, Codex `input_image`): must not be counted as text tokens or as a read with anchors (test in Task 2).

---

### Task 1: Event model, JSONL streaming and source discovery

**Files:**
- Create: `src/model.ts`, `src/io/jsonl.ts`, `src/io/discover.ts`, `src/io/paths.ts`
- Test: `test/io/jsonl.test.ts`, `test/io/discover.test.ts`, `test/io/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/model.ts`: every type in spec section 4 (`AgentKind`, `Usage`, `ThreadMeta`, `ToolClass`, `LedgerEvent`, `ReadInfo`, `InjectionSource`), plus `interface FileStats { lines: number; badLines: number; skippedRecords: number; longLines: number }` and `interface SourceSession { agent: AgentKind; sessionId: string; mainFile: string; subagentFiles: string[]; mtimeMs: number; sizeBytes: number }`.
  - `streamJsonl(file: string, opts: { maxLineBytes: number }, stats: FileStats): AsyncGenerator<unknown>`
  - `discoverSessions(opts: { claudeDir: string | null; codexDir: string | null; sinceMs: number | null; agent: 'claude' | 'codex' | 'all'; includeSubagents: boolean }): Promise<SourceSession[]>`
  - `normalizePath(p: string, platform?: NodeJS.Platform): string` and `toRepoRelative(p: string, repoRoot: string | null): { path: string; inRepo: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/io/jsonl.test.ts
it('yields parsed objects and counts a truncated last line as bad', async () => {
  const f = await tmpFile('{"a":1}\n{"b":2}\n{"c":');
  const stats = newStats();
  const out = []; for await (const r of streamJsonl(f, { maxLineBytes: 1 << 20 }, stats)) out.push(r);
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  expect(stats).toMatchObject({ lines: 3, badLines: 1 });
});
it('skips lines longer than maxLineBytes and counts them', async () => {
  const f = await tmpFile(`{"x":"${'y'.repeat(2000)}"}\n{"ok":true}\n`);
  const stats = newStats(); const out = [];
  for await (const r of streamJsonl(f, { maxLineBytes: 1000 }, stats)) out.push(r);
  expect(out).toEqual([{ ok: true }]); expect(stats.longLines).toBe(1);
});
it('handles CRLF and a UTF-8 BOM', async () => { /* '\uFEFF{"a":1}\r\n{"b":2}\r\n' yields both objects */ });

// test/io/paths.test.ts
it.each([
  ['./src/a.ts', '/r', 'src/a.ts'],
  ['/r/src/../src/a.ts', '/r', 'src/a.ts'],
  ['C:\\r\\src\\a.ts', 'C:/r', 'src/a.ts'],
])('normalises %s under %s to %s', (p, root, want) => {
  expect(toRepoRelative(normalizePath(p, 'win32'), normalizePath(root, 'win32')).path).toBe(want);
});
it('treats /private/tmp and /tmp as one path on darwin', () => {
  expect(normalizePath('/private/tmp/x/a.ts', 'darwin')).toBe(normalizePath('/tmp/x/a.ts', 'darwin'));
});
it('marks paths outside the repo', () => {
  expect(toRepoRelative('/etc/hosts', '/r')).toEqual({ path: '/etc/hosts', inRepo: false });
});

// test/io/discover.test.ts  (builds a temp tree)
it('finds Claude sessions with nested subagent and workflow files', async () => {
  // <dir>/-r/<uuid>.jsonl, <dir>/-r/<uuid>/subagents/agent-a1.jsonl, .../subagents/workflows/wf_x/agent-b2.jsonl
  const s = await discoverSessions({ claudeDir: dir, codexDir: null, sinceMs: null, agent: 'all', includeSubagents: true });
  expect(s).toHaveLength(1);
  expect(s[0]!.subagentFiles.map(f => path.basename(f)).sort()).toEqual(['agent-a1.jsonl', 'agent-b2.jsonl']);
});
it('finds Codex rollouts under YYYY/MM/DD', async () => { /* sessionId = uuid from the file name */ });
it('drops files older than sinceMs by mtime without opening them', async () => { /* utimes an old file; expect it absent */ });
it('returns [] when a directory does not exist', async () => { /* no throw */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/io`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/model.ts`, `src/io/paths.ts`, `src/io/jsonl.ts`, `src/io/discover.ts`**

`streamJsonl`: `fs.createReadStream` + `readline` with `crlfDelay: Infinity`; strip a leading BOM; check `Buffer.byteLength(line)` against `maxLineBytes` before `JSON.parse`; non-object results count as bad. `normalizePath`: backslashes to `/`, `path.posix.normalize`, drop a trailing `/`, darwin maps leading `/private/tmp/` and `/private/var/` to `/tmp/` and `/var/`, win32 lowercases the whole path. `toRepoRelative` returns a relative input unchanged with `inRepo: true` (tool inputs are relative to the session cwd, which is resolved before this call when known). Fixture and test trees use the discovery layout (`<claudeDir>/<project slug>/<uuid>.jsonl`). `discoverSessions`: `fs.promises.readdir` with `withFileTypes`, ignore symlinks, session id from the file name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/io` then `npm run typecheck && npm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/io test/io
git commit -m "feat: event model, streaming JSONL reader and session discovery"
```

---

### Task 2: Claude Code parser with pinned fixtures

**Files:**
- Create: `src/parse/claude.ts`, `src/parse/bash-read.ts`, `scripts/redact-fixture.mjs`, `test/fixtures/README.md`, `test/fixtures/claude/basic-2.1.316.jsonl`, `test/fixtures/claude/compaction-subagent/<uuid>.jsonl`, `test/fixtures/claude/compaction-subagent/<uuid>/subagents/agent-<id>.jsonl` and `.meta.json`, `test/fixtures/claude/legacy-inline-sidechain.jsonl`, `test/fixtures/claude/mcp-and-image.jsonl`
- Test: `test/parse/claude.test.ts`, `test/parse/bash-read.test.ts`, `test/scripts/redact-fixture.test.ts`

**Interfaces:**
- Consumes: Task 1 `streamJsonl`, `FileStats`, `normalizePath`, all model types.
- Produces:
  - `parseClaudeThread(file: string, ctx: { threadId: string; parentThreadId: string | null; spawnedByCallId: string | null; maxLineBytes: number }, stats: FileStats): { meta: Promise<ThreadMeta>; events: AsyncGenerator<LedgerEvent> }` (meta resolves after the first record that carries `cwd`/`version`, or at end of file).
  - Legacy layout: for inline `isSidechain: true` records, the same `parseClaudeThread` call yields their events with `threadId = 'sidechain:' + (agentId ?? root uuid of the chain)`; the main thread's events keep `ctx.threadId`. Downstream code groups by the `threadId` carried on each event's meta (add `threadId: string` to every `LedgerEvent` in `src/model.ts`).
  - `detectBashRead(command: string): string | null` (spec section 5, Claude rule 7).

- [ ] **Step 1: Build the fixtures**

1. `scripts/redact-fixture.mjs <in.jsonl> <out.jsonl> --repo-root <abs path>`: keeps keys, numbers, booleans, `null`, and the string values of `type`, `subtype`, `name` (tool names), `model`, `version`, `entrypoint`, `level`, `trigger`, `operation`, `hookEvent`, `role`, `stop_reason`, `service_tier`, `agentType`, ids/uuids (replaced by a stable fake uuid map); rewrites strings that start with the repo root to `/repo/...`; replaces every other string with `x` repeated to the same length. `file.content` of Read results is replaced by synthetic code of the same line count that declares `function fnN`.
2. `basic-2.1.316.jsonl`: one complete, untrimmed why-diff bench-run session (cwd under `~/Desktop/open-source/why-diff/bench/runs/`, public repo; these sessions are about 40 lines, and untrimmed keeps the `cost-state` total consistent with the requests), redacted; it must contain `Read`, `Edit`, `Bash`, `Grep`, `Glob`, `hook_success`, `instructions`, `skill_listing`, `prompt_snapshot`, a `cost-state`, and an assistant response split over several lines with the same `message.id`.
3. `compaction-subagent/`: capture a fresh session in a throwaway sandbox (`mkdir sandbox && cd sandbox && git init -b fixture-branch`, files `math.js` and `CLAUDE.md` with synthetic text), then:
   `claude -p "1) Use the Agent tool to have a general-purpose subagent read math.js and list its functions. 2) Write notes.txt containing ok. 3) Read README.md (it does not exist). 4) Run: ls. 5) Edit math.js to rename add to sum." --model sonnet --permission-mode acceptEdits --allowedTools "Read,Write,Edit,Bash(ls),Agent,Glob" --output-format json`, then `claude -p "/compact" --resume <id>`, then `claude -p "Read math.js again and tell me the function name." --resume <id> --allowedTools Read`. Copy the session file and its `subagents/` folder from `~/.claude/projects/<sandbox slug>/`, run the redaction script with `--repo-root <sandbox>`, and hand-check that no user-level CLAUDE.md text, skill names or home paths remain (replace `instructions` files of type `User` and `skill_listing.names` with synthetic ones).
4. `legacy-inline-sidechain.jsonl` and `mcp-and-image.jsonl`: hand-written synthetic lines. The second has an `mcp__docs__search` tool_use and result, a `deferred_tools_delta` adding `mcp__docs__search`, a Read of `logo.png` whose result has an `image` content block with base64 data, and one assistant record with `model: "<synthetic>"` and all-zero usage.
5. `test/fixtures/README.md`: one paragraph per fixture: origin, Claude Code version, how it was redacted.

- [ ] **Step 2: Write the failing tests**

```ts
// test/parse/claude.test.ts
it('emits one request per message.id with its usage', async () => {
  const ev = await collect('claude/basic-2.1.316.jsonl');
  const reqs = ev.filter(e => e.kind === 'request');
  expect(new Set(reqs.map(r => r.requestId)).size).toBe(reqs.length);
  expect(reqs.every(r => r.usage !== null)).toBe(true);
});
it('splits cache_creation into 5m and 1h', async () => {
  const r = firstRequestWith1hCache(await collect('claude/basic-2.1.316.jsonl'));
  expect(r.usage!.cacheWrite1h).toBeGreaterThan(0);
  expect(r.usage!.cacheWrite5m + r.usage!.cacheWrite1h).toBe(rawCacheCreationOf(fixtureFile, r.requestId)); // test helper reads the raw line
});
it('fills ReadInfo for successful Reads only', async () => {
  const ev = await collect('claude/compaction-subagent/<uuid>.jsonl');
  const reads = ev.filter(e => e.kind === 'tool_result' && e.read);
  expect(reads.map(r => r.read!.path)).toContain('/repo/math.js');
  expect(ev.some(e => e.kind === 'tool_result' && e.isError && e.read === null)).toBe(true); // missing README.md
});
it('classifies tools', async () => {
  const classes = toolClasses(await collect('claude/basic-2.1.316.jsonl'));
  expect(classes).toMatchObject({ Read: 'read', Edit: 'edit', Bash: 'bash', Grep: 'search', Glob: 'list' });
  expect(toolClasses(await collect('claude/mcp-and-image.jsonl'))).toMatchObject({ mcp__docs__search: 'mcp' });
});
it('emits compaction, compaction_summary and reattached_file in order', async () => {
  const kinds = (await collect('claude/compaction-subagent/<uuid>.jsonl'))
    .filter(e => e.kind === 'compaction' || (e.kind === 'injection' && ['compaction_summary', 'reattached_file'].includes(e.source)))
    .map(e => e.kind === 'injection' ? e.source : e.kind);
  expect(kinds.slice(0, 2)).toEqual(['compaction', 'compaction_summary']);
  expect(kinds).toContain('reattached_file');
});
it('parses the subagent file as its own thread linked to the Agent call', async () => {
  const { meta } = parseClaudeThread(subagentFile, { threadId: 'a1', parentThreadId: 'main', spawnedByCallId: 'toolu_x', maxLineBytes: 1 << 26 }, newStats());
  expect(await meta).toMatchObject({ threadId: 'a1', parentThreadId: 'main' });
});
it('does not add the Agent toolUseResult.usage as a request', async () => {
  const reqs = (await collect('claude/compaction-subagent/<uuid>.jsonl')).filter(e => e.kind === 'request');
  expect(reqs.map(r => r.requestId)).not.toContain(undefined);
  expect(reqs.length).toBe(uniqueAssistantMessageIds(mainFile));
});
it('emits instructions, skills_listing, system_prompt, tool_schemas and hook injections', async () => { /* each source present at least once in basic fixture */ });
it('emits harness_cost from cost-state', async () => { /* totalCostUSD equals the fixture value */ });
it('yields legacy inline sidechain records under their own threadId', async () => { /* two threads */ });
it('ignores <synthetic> assistant records', async () => {
  expect((await collect('claude/mcp-and-image.jsonl')).filter(e => e.kind === 'request' && e.model === '<synthetic>')).toHaveLength(0);
});
it('does not count base64 image blocks as text', async () => {
  const r = (await collect('claude/mcp-and-image.jsonl')).find(e => e.kind === 'tool_result' && e.tool === 'Read')!;
  expect(r.chars).toBeLessThan(200); expect(r.read).toBeNull();
});
it('counts unknown record types as skipped, not errors', async () => { /* stats.skippedRecords > 0, badLines === 0 */ });

// test/parse/bash-read.test.ts
it.each([['cat src/a.ts', 'src/a.ts'], ["sed -n '1,40p' src/a.ts", 'src/a.ts'], ['head -50 README.md', 'README.md'],
         ['cat a.ts | grep x', null], ['cat src/*.ts', null], ['cat a.ts b.ts', null], ['ls src', null]])
  ('%s gives %s', (cmd, want) => expect(detectBashRead(cmd)).toBe(want));

// test/scripts/redact-fixture.test.ts
it('removes every non-allowlisted string and keeps structure', async () => {
  // input line with a prompt "my secret plan", cwd "/Users/someone/repo", tool name "Read"
  const out = await redact(line, '/Users/someone/repo');
  expect(out).not.toContain('secret'); expect(out).not.toContain('/Users/someone');
  expect(JSON.parse(out).message.content[0].name).toBe('Read');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/parse test/scripts`
Expected: FAIL, `parseClaudeThread` not defined.

- [ ] **Step 4: Implement `parseClaudeThread` and `detectBashRead`**

Follow spec section 5 (Claude rules 1 to 7) and section 3.1. Keep a `Map<callId, {tool, toolClass}>` to attach `tool` and `read` to results. `tool_call.text` = the agent-authored parts of `input` only (`command`, `new_string`, `content`, `prompt`, `pattern`, `query`, any string field of MCP inputs), joined by `\n`. `tool_call.paths` = normalised `file_path`/`path`/`notebook_path`. Hashes: `crypto.createHash('sha256')`, hex, first 16 chars. `prompt_snapshot` injections are emitted only when their hash differs from the last one in the thread.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/parse test/scripts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/parse scripts/redact-fixture.mjs test/parse test/scripts test/fixtures
git commit -m "feat: Claude Code parser pinned to 2.1.316 fixtures"
```

---

### Task 3: Codex parser with synthetic fixtures

**Files:**
- Create: `src/parse/codex.ts`, `test/fixtures/codex/rollout-0.162.jsonl`, `test/fixtures/codex/rollout-legacy.jsonl`
- Modify: `test/fixtures/README.md` (two paragraphs)
- Test: `test/parse/codex.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `streamJsonl`; Task 2 `detectBashRead` (legacy `shell` calls).
- Produces: `parseCodexThread(file: string, ctx: { maxLineBytes: number }, stats: FileStats): { meta: Promise<ThreadMeta>; events: AsyncGenerator<LedgerEvent> }`.

- [ ] **Step 1: Write the synthetic fixtures**

`rollout-0.162.jsonl` (about 30 lines, shapes from spec section 3.2): `session_meta` (cwd `/home/dev/shop`, `cli_version` `0.162.0-alpha.17.2`, `git.branch` `feat/cart`, `base_instructions.text`), `turn_context` (model `gpt-6-astra`), a user message, a user message starting `# AGENTS.md instructions for /home/dev/shop`, three `token_usage_record`s, an `exec` `custom_tool_call` plus `item_completed` `CommandExecution` with `parsed_cmd` `[{type:"read",cmd:"cat src/cart.ts",name:"cart.ts",path:"src/cart.ts"}]`, a second identical read later, an `apply_patch` with `*** Update File: src/cart.ts`, a `compacted` record, an assistant message mentioning `applyDiscount`. `rollout-legacy.jsonl`: `session_meta`, `function_call` `shell` with `{"command":["bash","-lc","cat src/a.ts"]}`, its output, two `event_msg` `token_count` records with increasing `total_token_usage` and one repeated.

- [ ] **Step 2: Write the failing tests**

```ts
it('normalises usage: input excludes cached tokens', async () => {
  const r = firstRequest(await collect('codex/rollout-0.162.jsonl'));
  expect(r.usage).toEqual({ input: 1200 - 1000, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0, output: 300 });
  expect(r.model).toBe('gpt-6-astra');
});
it('reads come from parsed_cmd type read', async () => {
  const reads = (await collect('codex/rollout-0.162.jsonl')).filter(e => e.kind === 'tool_result' && e.read);
  expect(reads.map(r => r.read!.path)).toEqual(['src/cart.ts', 'src/cart.ts']);
});
it('apply_patch becomes an edit with paths', async () => { /* tool_call toolClass 'edit', paths ['src/cart.ts'] */ });
it('AGENTS.md message is an instructions injection, not a user prompt', async () => { /* source 'instructions' */ });
it('compacted record becomes a compaction with unknown trigger', async () => { /* trigger 'unknown', preTokens null */ });
it('meta has cwd, branch and version', async () => {
  expect(await meta('codex/rollout-0.162.jsonl')).toMatchObject({ agent: 'codex', cwd: '/home/dev/shop', gitBranch: 'feat/cart', version: '0.162.0-alpha.17.2' });
});
it('legacy token_count: one request per increase, repeated totals ignored', async () => {
  expect((await collect('codex/rollout-legacy.jsonl')).filter(e => e.kind === 'request')).toHaveLength(2);
});
it('legacy shell cat is a read', async () => { /* read.path 'src/a.ts' */ });
it('input_image content is not counted as text', async () => { /* chars of that prompt excludes the image */ });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/parse/codex.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `parseCodexThread`** following spec section 5 (Codex rules 1 to 6). `exec` inputs are free text (JS in code mode): never execute or evaluate them; only scan for `*** (Add|Update|Delete) File:` lines.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/parse && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/parse/codex.ts test/parse/codex.test.ts test/fixtures/codex test/fixtures/README.md
git commit -m "feat: Codex rollout parser (0.162 and legacy shapes)"
```

---

### Task 4: Price table and cost

**Files:**
- Create: `src/prices/defaults.json`, `src/prices/table.ts`, `src/analysis/cost.ts`
- Test: `test/prices/table.test.ts`, `test/analysis/cost.test.ts`

**Interfaces:**
- Consumes: `Usage`, `LedgerEvent` from Task 1; Claude fixtures from Task 2.
- Produces:
  - `interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; source: string; retrieved: string }`
  - `type PriceTable = Map<string, ModelPrice>`; `loadPriceTable(overridePath: string | null): Promise<PriceTable>`; `lookupPrice(table: PriceTable, model: string): ModelPrice | null`
  - `requestCost(usage: Usage | null, price: ModelPrice | null): number | null` (spec 6.1 formula)
  - `class CostAccumulator { add(e: Extract<LedgerEvent, {kind:'request'}>): void; addHarnessCost(totalCostUSD: number): void; result(): CostSummary }` with `interface CostSummary { usd: number; requests: number; requestsMissingUsage: number; requestsUnpriced: number; unpricedModels: string[]; byModel: Map<string, { usd: number; usage: Usage }>; usage: Usage; cacheHitShare: number | null; harnessUSD: number | null; unloggedUSD: number | null; priceMismatch: boolean }`

- [ ] **Step 1: Fill `src/prices/defaults.json`**

One entry per current Claude model (at least every model id in the fixtures, plus the current Opus, Sonnet and Haiku) and current OpenAI coding models (at least the Codex fixture model). Copy every number from the vendor pricing pages (Anthropic pricing docs, OpenAI API pricing) on the day you write it; put the page URL in `source` and the date in `retrieved`. Do not fill a price from memory; a model you cannot source stays out of the table.

- [ ] **Step 2: Write the failing tests**

```ts
it('applies the spec formula', () => {
  const p = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, source: 's', retrieved: 'd' };
  expect(requestCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, p)).toBeCloseTo(28.05);
});
it('returns null for missing usage or unknown price', () => {
  expect(requestCost(null, p)).toBeNull(); expect(requestCost(u, null)).toBeNull();
});
it('matches by exact id, then longest prefix', () => {
  const t = new Map([['claude-sonnet', a], ['claude-sonnet-5-5', b]]);
  expect(lookupPrice(t, 'claude-sonnet-5-5')).toBe(b); expect(lookupPrice(t, 'claude-sonnet-5-5-20261101')).toBe(b);
  expect(lookupPrice(t, 'gpt-unknown')).toBeNull();
});
it('override file merges over defaults', async () => { /* temp JSON changes one model's output price */ });
it('every default entry has a source URL and a retrieved date', async () => {
  for (const [, p] of await loadPriceTable(null)) { expect(p.source).toMatch(/^https:\/\//); expect(p.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
});
it('matches Claude Code cost-state within 1% on the basic fixture', async () => {
  const s = await costOf('claude/basic-2.1.316.jsonl');
  expect(s.requestsUnpriced).toBe(0);
  expect(Math.abs(s.usd - s.harnessUSD!) / s.harnessUSD!).toBeLessThan(0.01);
});
it('reports the compaction call as unlogged cost', async () => {
  const s = await costOf('claude/compaction-subagent/<uuid>.jsonl', { withSubagents: true });
  expect(s.unloggedUSD!).toBeGreaterThan(0);
});
it('lists unpriced models and counts missing usage', () => { /* model 'claude-future-9' -> unpricedModels ['claude-future-9'] */ });
it('cacheHitShare = cacheRead / all prompt tokens', () => { /* hand-made usages */ });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/prices test/analysis/cost.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `table.ts` and `cost.ts`.** `harnessUSD` = the last `harness_cost` value per Claude Code process (values only grow within a process; a drop means a new process, so sum the last value of each run). The JSON default table is imported with `import defaults from './defaults.json' with { type: 'json' }` so it ends up in the bundle.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/prices test/analysis && npm run typecheck && npm run lint`
Expected: PASS. If the 1% cost-state test fails, fix the table entry against the vendor page, not the tolerance.

- [ ] **Step 6: Commit**

```bash
git add src/prices src/analysis/cost.ts test/prices test/analysis/cost.test.ts
git commit -m "feat: sourced price table and cache-adjusted cost"
```

---

### Task 5: Reads: unreferenced heuristic, re-reads, compaction re-reads

**Files:**
- Create: `src/analysis/anchors.ts`, `src/analysis/stoplist.ts`, `src/analysis/reads.ts`
- Test: `test/analysis/anchors.test.ts`, `test/analysis/reads.test.ts`

**Interfaces:**
- Consumes: `LedgerEvent`, `ReadInfo` (Task 1); `lookupPrice`, `PriceTable` (Task 4).
- Produces:
  - `extractAnchors(content: string): string[]` (spec 6.3 patterns, max 30, stoplist removed)
  - `interface ReadRecord { threadId: string; seq: number; path: string; tokens: number; referenced: boolean; reason: 'edit' | 'path' | 'symbol' | null; reread: null | { kind: 'unchanged' | 'changed'; afterCompaction: boolean }; carriedUSD: number | null }`
  - `interface PendingRead { record: ReadRecord; needles: { path: string; basename: string | null; anchors: string[] } }`
  - `class ReadsPass { constructor(threadId: string, prices: PriceTable); onEvent(e: LedgerEvent): void; finish(): { reads: ReadRecord[]; pending: PendingRead[]; compactionRereads: { readBefore: number; rereadUnchangedAfter: number; reattachedThenReread: number } }; adoptChildPending(callId: string, pending: PendingRead[]): void }`. `adoptChildPending` registers a subagent's unresolved reads, to be matched from the parent's `tool_result` for `callId` onwards.

- [ ] **Step 1: Write the failing tests** (events built with small helpers `read(seq, path, content)`, `edit(seq, path)`, `say(seq, text)`, `call(seq, tool, text)`, `req(seq)`, `compact(seq)`)

```ts
// anchors
it('extracts declared identifiers and headings, drops stoplist words', () => {
  expect(extractAnchors('export function applyDiscount(a) {}\nconst data = 1\nclass CartTotals {}\n# Rate limiter'))
    .toEqual(['applyDiscount', 'CartTotals', 'Rate limiter']);
});
it('caps at 30 anchors', () => { /* 40 declarations -> 30 */ });

// reads
it('an edit of the same file makes the read referenced (edit)', () => {
  expect(run([read(1, 'src/a.ts', 'x'), edit(2, 'src/a.ts')]).reads[0]).toMatchObject({ referenced: true, reason: 'edit' });
});
it('a later path mention references it (path)', () => { /* say(2, 'see src/a.ts') -> reason 'path' */ });
it('a short generic basename does not count', () => { /* read 'docs/a.md', say 'a.md' -> referenced false */ });
it('a symbol from the content used later references it (symbol)', () => {
  expect(run([read(1, 'src/cart.ts', 'export function applyDiscount() {}'), call(2, 'Bash', 'node -e "applyDiscount()"')]).reads[0])
    .toMatchObject({ referenced: true, reason: 'symbol' });
});
it('mentions inside tool results or user prompts do not count', () => { /* only a later tool_result containing the path -> referenced false */ });
it('mentions before the read do not count', () => { /* say(0,'src/a.ts') then read(1) -> false */ });
it('symbol match is whole-word', () => { /* anchor 'applyDiscount' vs text 'applyDiscountV2' -> false */ });
it('re-read with no edit and same hash is unchanged', () => {
  expect(run([read(1, 'a.ts', 'x'), read(3, 'a.ts', 'x')]).reads[1]!.reread).toEqual({ kind: 'unchanged', afterCompaction: false });
});
it('re-read after an edit is changed', () => { /* read, edit, read -> 'changed' */ });
it('re-read across a compaction is flagged and counted for the proxy', () => {
  const r = run([read(1, 'a.ts', 'x'), read(2, 'b.ts', 'y'), compact(3), read(4, 'a.ts', 'x')]);
  expect(r.reads[2]!.reread).toEqual({ kind: 'unchanged', afterCompaction: true });
  expect(r.compactionRereads).toEqual({ readBefore: 2, rereadUnchangedAfter: 1, reattachedThenReread: 0 });
});
it('carried cost counts requests until the segment ends', () => {
  // read (1000 chars = 250 tokens) then 3 requests then compaction then 2 requests; sonnet-like prices
  expect(run([read(1, 'a.ts', 'z'.repeat(1000)), req(2), req(3), req(4), compact(5), req(6)]).reads[0]!.carriedUSD)
    .toBeCloseTo(250 * (3.75 + 2 * 0.3) / 1e6);
});
it('a subagent read is referenced by the parent using it after the Agent result', () => {
  const child = run([read(1, 'src/a.ts', 'export function applyDiscount(){}')]);
  const parent = new ReadsPass('main', prices);
  parent.adoptChildPending('toolu_1', child.pending);
  [agentResult(5, 'toolu_1', 'found applyDiscount'), say(6, 'ok')].forEach(e => parent.onEvent(e));
  expect(parent.finish().reads.find(r => r.threadId === 'sub')).toMatchObject({ referenced: true, reason: 'symbol' });
});
it('on the compaction fixture: math.js re-read after compaction is unchanged-after-compaction', async () => { /* real parser + pass */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/analysis/anchors.test.ts test/analysis/reads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `extractAnchors`, `stoplist.ts` (200 words, spec 6.3) and `ReadsPass`**

Single pass. Keep open reads in an array; for each agent-authored event, build the set of identifier tokens of `e.text` once (`/[A-Za-z_][A-Za-z0-9_]*/g`, plus each line for heading anchors) and test each open read with `Set.has` for anchors and `String.includes` for path needles; a referenced read leaves the open list. Carried cost: remember the request count of the current segment at read time; settle `carriedUSD` at each compaction and at `finish()`. Never build a `RegExp` from log text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/analysis && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/anchors.ts src/analysis/stoplist.ts src/analysis/reads.ts test/analysis
git commit -m "feat: unreferenced reads, re-reads and compaction re-read proxy"
```

---

### Task 6: Context composition and harness fingerprint

**Files:**
- Create: `src/analysis/composition.ts`, `src/analysis/fingerprint.ts`
- Test: `test/analysis/composition.test.ts`, `test/analysis/fingerprint.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 and 3 fixtures.
- Produces:
  - `class CompositionPass { onEvent(e: LedgerEvent): void; finish(): Composition }` with `interface Composition { sources: Map<string, { introduced: number; processed: number }>; exactPromptFirst: number | null; exactPromptTotal: number; unattributedFirst: number | null }` (keys: `InjectionSource` values, `tool_result:<tool>`, `mcp:<server>`, `user_prompt`, `assistant_output`)
  - `class FingerprintPass { onEvent(e: LedgerEvent, meta: ThreadMeta): void; finish(): Fingerprint }` with `interface Fingerprint { instructions: string; skills: string; hooks: string; mcp: string; systemPrompt: string; model: string; fingerprint: string }` (spec 6.5; unobserved component `"-"`)

- [ ] **Step 1: Write the failing tests**

```ts
it('introduced = ceil(chars/4) per source; assistant_output uses exact output tokens', () => {
  const c = run([inj(1, 'instructions', 400), toolRes(2, 'Read', 800), req(3, { output: 50 })]);
  expect(c.sources.get('instructions')!.introduced).toBe(100);
  expect(c.sources.get('tool_result:Read')!.introduced).toBe(200);
  expect(c.sources.get('assistant_output')!.introduced).toBe(50);
});
it('processed = introduced x requests after it in the segment', () => {
  const c = run([toolRes(1, 'Read', 400), req(2), req(3), compact(4), req(5)]);
  expect(c.sources.get('tool_result:Read')!.processed).toBe(100 * 2);
});
it('groups MCP results by server', () => { /* tool 'mcp__docs__search' -> key 'mcp:docs' */ });
it('unattributed = exact first prompt minus estimated sources before it', () => { /* numbers */ });
it('on the basic fixture: system_prompt, tool_schemas and instructions are all non-zero', async () => { /* real parser */ });

it('fingerprint changes only the instructions component when CLAUDE.md content changes', () => {
  const a = fp([instr('Project', 'CLAUDE.md', 'v1')]); const b = fp([instr('Project', 'CLAUDE.md', 'v2')]);
  expect(a.instructions).not.toBe(b.instructions); expect(a.skills).toBe(b.skills); expect(a.fingerprint).not.toBe(b.fingerprint);
});
it('system prompt hash ignores date and cwd lines', () => { /* two prompts differing only in "Today's date" -> same hash */ });
it('MCP component is the sorted server set', () => { /* tools mcp__b__x, mcp__a__y -> same as a,b */ });
it('unobserved components are "-"', () => { /* Codex fixture: skills '-' , hooks '-' */ });
it('hash values are 12 hex chars', () => { /* regex /^[0-9a-f]{12}$|^-$/ */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/analysis/composition.test.ts test/analysis/fingerprint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both passes** per spec 6.2 and 6.5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/analysis && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/composition.ts src/analysis/fingerprint.ts test/analysis
git commit -m "feat: context composition and harness fingerprint"
```

---

### Task 7: Session analysis, attribution to repo, branch and PR, and compare

**Files:**
- Create: `src/analyze-session.ts`, `src/attribution/git.ts`, `src/attribution/gh.ts`, `src/attribution/attribute.ts`, `src/aggregate/compare.ts`
- Test: `test/analyze-session.test.ts`, `test/attribution/git.test.ts`, `test/attribution/attribute.test.ts`, `test/aggregate/compare.test.ts`

**Interfaces:**
- Consumes: parsers (Tasks 2, 3), `CostAccumulator` (Task 4), `ReadsPass` (Task 5), `CompositionPass`, `FingerprintPass` (Task 6).
- Produces:
  - `analyzeSession(src: SourceSession, opts: { prices: PriceTable; maxLineBytes: number; includeSubagents: boolean }): Promise<SessionResult>` where `interface SessionResult { agent: AgentKind; sessionId: string; startedAt: string; endedAt: string; cwd: string | null; entrypoint: string | null; version: string | null; cost: CostSummary; requestsByBranch: Array<{ ts: string; cwd: string | null; branch: string | null; usd: number | null }>; reads: ReadRecord[]; compactions: number; compactionRereads: {...same as Task 5}; composition: Composition; fingerprint: Fingerprint; subagents: Array<{ threadId: string; agentType: string | null; usd: number }>; edits: number; explicitPrs: number[]; stats: FileStats }`. Subagent threads are analysed first, their pending reads adopted by the parent (`adoptChildPending` keyed by `spawnedByCallId`). All `text` is gone when this resolves.
  - `gitInfo(dir: string): Promise<{ root: string; commonRoot: string; origin: string | null; defaultBranch: string | null } | null>` (cached per dir; spec 9.2 flags)
  - `listPrs(origin: string): Promise<Pr[]>` with `interface Pr { number: number; headRefName: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; createdAt: string; mergedAt: string | null; closedAt: string | null; title: string; url: string }`
  - `attribute(sessions: SessionResult[], opts: { gh: boolean; now: Date }): Promise<{ branches: BranchRow[]; prs: PrRow[] }>` with `BranchRow { repo: string; branch: string; outcome: 'default' | 'noPr' | 'pr'; usd: number; sessions: number }`, `PrRow { repo: string; number: number; state: 'merged' | 'open' | 'closedUnmerged'; usd: number; attempts: number; attemptsNoEdit: number; title: string; url: string }`, plus `unmergedSpend: number`
  - `compare(sessions: SessionResult[], prs: PrRow[], opts: { by: keyof Fingerprint | null; splitAt: string | null; outcome: 'merged' | 'any' }): CompareRow[]` with `CompareRow { group: string; sessions: number; tooFew: boolean; medianUsd: number | null; p90Usd: number | null; medianUsdPerMergedPr: number | null; unreferencedTokenShare: number | null; rereadRate: number | null; compactionRereadRate: number | null; cacheHitShare: number | null }`

- [ ] **Step 1: Write the failing tests**

```ts
// analyze-session
it('rolls subagent cost into the session and lists the subagent', async () => {
  const s = await analyzeSession(compactionFixture, { prices, maxLineBytes: 1 << 26, includeSubagents: true });
  const mainOnly = await analyzeSession(compactionFixture, { prices, maxLineBytes: 1 << 26, includeSubagents: false });
  expect(s.subagents).toHaveLength(1); expect(s.subagents[0]!.agentType).toBe('general-purpose');
  expect(s.subagents[0]!.usd).toBeGreaterThan(0);
  expect(s.cost.usd).toBeCloseTo(mainOnly.cost.usd + s.subagents[0]!.usd, 6);
});
it('keeps no text in the result', async () => {
  expect(JSON.stringify(serialise(await analyzeSession(compactionFixture, opts)))).not.toContain('function sum');
});

// git (real temp repos; runs on Windows too)
it('finds the root of a worktree through the common dir', async () => { /* git worktree add; commonRoot === main repo root */ });
it('returns null for a non-repo and for a missing directory', async () => {});
it('never runs a fsmonitor configured by the repo', async () => {
  // repo with core.fsmonitor = a script that writes a marker file; call gitInfo; expect marker absent
});

// attribute (gh stubbed via an injected listPrs)
it('attributes by branch within the PR window, including closed-unmerged attempts', async () => {
  const r = await attribute([sessOn('feat/x', '2026-10-02'), sessOn('feat/x', '2026-10-03', { edits: 0 })], { gh: true, now });
  expect(r.prs[0]).toMatchObject({ number: 7, state: 'closedUnmerged', attempts: 2, attemptsNoEdit: 1 });
  expect(r.unmergedSpend).toBeCloseTo(r.prs[0]!.usd);
});
it('splits one session that switches branch halfway', async () => { /* requestsByBranch with two branches -> two BranchRows */ });
it('explicit remote_session_change PR wins over branch matching', async () => {});
it('without gh only explicit PRs are known and nothing is spawned', async () => { /* spy on listPrs: not called */ });
it('subagent requests on HEAD inherit the parent branch', async () => {});

// compare
it('groups by instructions hash and hides medians below 5 sessions', () => {
  const rows = compare(sessionsWith({ instructions: ['aaa', 'aaa', 'aaa', 'aaa', 'aaa', 'bbb'] }), [], { by: 'instructions', splitAt: null, outcome: 'any' });
  expect(rows.find(r => r.group === 'bbb')).toMatchObject({ tooFew: true, medianUsd: null });
  expect(rows.find(r => r.group === 'aaa')!.medianUsd).not.toBeNull();
});
it('--split-at groups into before and after', () => {});
it('--outcome merged keeps only sessions attributed to merged PRs', () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/analyze-session.test.ts test/attribution test/aggregate`
Expected: FAIL.

- [ ] **Step 3: Implement.** `git.ts` uses `execFile('git', [...], { timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })` with the spec 9.2 flags and an empty temp `hooksPath` created once. `gh.ts` uses `execFile('gh', ['pr', 'list', '--repo', origin, '--state', 'all', '--limit', '500', '--json', 'number,headRefName,state,createdAt,mergedAt,closedAt,title,url'])`; a missing `gh` or a non-zero exit becomes a warning, not an error. Attribution follows spec 6.6; medians and p90 use nearest-rank.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/analyze-session.ts src/attribution src/aggregate test/analyze-session.test.ts test/attribution test/aggregate
git commit -m "feat: per-session analysis, branch and PR attribution, compare"
```

---

### Task 8: Pipeline, CLI, terminal and JSON output, performance, bundle

**Files:**
- Create: `src/pipeline.ts`, `src/report/types.ts`, `src/report/terminal.ts`, `src/report/json.ts`, `src/report/sanitize.ts`, `src/cli.ts`, `scripts/gen-perf-corpus.mjs`, `test/perf/perf.test.ts`, `bin/read-receipts.mjs` (generated)
- Modify: `package.json` (`"perf": "node scripts/gen-perf-corpus.mjs --size 1024 && vitest run test/perf --config vitest.perf.config.ts"`), `.github/workflows/ci.yml` (uncomment the bundle check and smoke steps)
- Create: `vitest.perf.config.ts`
- Test: `test/pipeline.test.ts`, `test/report/terminal.test.ts`, `test/report/json.test.ts`, `test/cli.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7.
- Produces:
  - `interface Report { schemaVersion: 1; generatedAt: string; options: ReportOptions; totals: Totals; sessions: SessionRow[]; branches: BranchRow[]; prs: PrRow[]; compare: CompareRow[] | null; warnings: string[] }` in `src/report/types.ts` (`Totals` holds the section 8 summary numbers; `SessionRow` = `SessionResult` minus `stats`, plus `unreferencedTokenShare`, `rereadRate`; every estimated field name ends in `Est` or sits under an `estimated` object)
  - `buildReport(opts: ReportOptions): Promise<Report>` (`ReportOptions` = the CLI options of spec section 7, parsed)
  - `renderTerminal(r: Report, opts: { color: boolean; width: number }): string`; `renderJson(r: Report): string`
  - `sanitizeTerminal(s: string): string` (strips C0/C1 and ANSI)
  - CLI commands of spec section 7 via commander.

- [ ] **Step 1: Write the failing tests**

```ts
// pipeline
it('builds a report over a fixture directory tree', async () => {
  // copies the four Task 2 Claude fixtures and the two Task 3 Codex fixtures into a temp tree in discovery layout
  const { claudeDir, codexDir } = await fixtureTree();
  const r = await buildReport({ ...defaults, claudeDir, codexDir, since: null });
  expect(r.sessions.length).toBe(6); expect(r.totals.reads).toBeGreaterThan(0);
  expect(r.warnings.join('\n')).toMatch(/unpriced|without usage/);    // mcp-and-image fixture has an unpriced model
});
it('--project keeps only sessions whose cwd is inside the path', async () => {});

// terminal
it('prints estimated numbers with ≈ and never the word wasted', () => {
  const out = renderTerminal(sampleReport, { color: false, width: 100 });
  expect(out).toMatch(/≈/); expect(out.toLowerCase()).not.toContain('wasted'); expect(out).not.toMatch(/\u2014|\u2192/);
});
it('strips terminal escapes from log-derived strings', () => {
  expect(sanitizeTerminal('src/\u001b[31mevil\u0007.ts')).toBe('src/evil.ts');
});
it('shows a lower bound when usage is missing', () => { /* "≥ $" in cost line */ });

// json
it('has schemaVersion 1 and round-trips', () => { const j = JSON.parse(renderJson(sampleReport)); expect(j.schemaVersion).toBe(1); });

// cli e2e (spawns `node --import tsx src/cli.ts`)
it('--help lists the commands', async () => { /* summary, sessions, session, prs, compare, prices */ });
it('exit 2 on an unknown option, 0 with no sessions and a message naming the dirs', async () => {});
it('session <prefix> shows the reads table for one session', async () => {});

// perf (CI size)
it('parses a generated 64 MB corpus at more than 17 MB/s', async () => {
  const { bytes, ms } = await timeBuildReport(perfDir64);
  expect(bytes / 1e6 / (ms / 1000)).toBeGreaterThan(17);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pipeline.test.ts test/report test/cli.e2e.test.ts test/perf`
Expected: FAIL.

- [ ] **Step 3: Implement.** `buildReport` processes sessions sequentially (no `Promise.all` over all files, to bound memory) and drops each `SessionResult`'s per-read list down to the top 50 unreferenced reads by tokens after totals are updated. `scripts/gen-perf-corpus.mjs --size <MB> --out test/.perf/<MB>` writes synthetic Claude sessions by repeating fixture-shaped lines with fresh ids and file names. `vitest.perf.config.ts` sets `include: ['test/perf/**/*.test.ts']`, `testTimeout: 120_000`; the default config excludes `test/perf` except the 64 MB case (`PERF_MB` env, default 64). Run `npm run build` to create `bin/read-receipts.mjs`.

- [ ] **Step 4: Run tests to verify they pass, then the full perf check**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run build && npm run check:bundle && node bin/read-receipts.mjs --help`
Expected: all PASS, help printed.
Run: `npm run perf`
Expected: PASS: 1 GB under 60 s; note the measured time and peak RSS (`/usr/bin/time -l` on macOS) in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts src/report src/cli.ts scripts/gen-perf-corpus.mjs vitest.perf.config.ts test bin package.json .github/workflows/ci.yml
git commit -m "feat: CLI with terminal and JSON reports, streaming pipeline, perf check"
```

---

### Task 9: HTML report, `--share` redaction, leak and no-network tests

**Files:**
- Create: `src/report/share.ts`, `src/report/html.ts`, `src/report/html-template.ts`
- Modify: `src/cli.ts` (wire `--html`, `--share`)
- Test: `test/report/share.test.ts`, `test/report/html.test.ts`, `test/privacy.e2e.test.ts`, `test/fixtures/claude/canary/<uuid>.jsonl`

**Interfaces:**
- Consumes: `Report` (Task 8), `toRepoRelative` (Task 1).
- Produces:
  - `shareReport(r: Report, opts: { home: string }): Report` (spec 9.6; pure, returns a new object)
  - `renderHtml(r: Report): string`

- [ ] **Step 1: Write the canary fixture**

Synthetic session (cwd `/home/canary-user/acme-repo`, branch `feat/CANARY-BRANCH-7`) whose prompt, assistant text, Bash command, tool result, Read of `/etc/CANARY_ABS/secret.txt`, PR title (via a stubbed `listPrs`) and session id each contain a distinct canary string `CANARY_<field>_9f3`.

- [ ] **Step 2: Write the failing tests**

```ts
// share
it('keeps aggregates and repo-relative paths only', () => {
  const s = shareReport(canaryReport, { home: '/home/canary-user' });
  const txt = JSON.stringify(s);
  expect(txt).not.toMatch(/CANARY_|canary-user|\/etc\//);
  expect(txt).toContain('src/cart.ts'); expect(txt).toMatch(/branch-[0-9a-f]{6}/); expect(txt).toMatch(/s-[0-9a-f]{8}/);
});
it('is pure', () => { const before = JSON.stringify(canaryReport); shareReport(canaryReport, o); expect(JSON.stringify(canaryReport)).toBe(before); });

// html
it('has the CSP meta and no external URLs', () => {
  const h = renderHtml(sampleReport);
  expect(h).toContain("default-src 'none'");
  expect(h).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
});
it('escapes script-breaking content in embedded JSON', () => {
  const h = renderHtml(withPath(sampleReport, '</script><img src=x onerror=alert(1)>.ts'));
  expect(h).not.toContain('</script><img'); expect(h).toContain('\\u003c/script\\u003e');
});
it('uses textContent, never innerHTML, in the inline script', () => { expect(renderHtml(sampleReport)).not.toContain('innerHTML'); });
it('has every section heading of spec section 8', () => { /* nine headings */ });

// privacy e2e
it('--share leaks no canary in terminal, --json or --html output', async () => {
  for (const args of [['--share'], ['--share', '--json'], ['--share', '--html', out]]) {
    const text = await runCli([...args, '--claude-dir', canaryDir]);
    expect(text + (await readIfExists(out))).not.toMatch(/CANARY_|canary-user/);
  }
});
it('makes no network connection during a full run', async () => {
  // in-process: vi.spyOn(net, 'connect'), net.Socket.prototype.connect, globalThis.fetch, dns.lookup all throw; buildReport + renders succeed
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/report test/privacy.e2e.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** `renderHtml`: static template string with inline CSS (light/dark via `prefers-color-scheme`, tokens on `:root`), JSON embedded per spec section 8, a small inline script that builds the tables and bar charts with `document.createElement` and `textContent`. No external fonts or libraries. `--share` is applied once in `cli.ts` before any renderer.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run build && npm run check:bundle`
Expected: PASS. Open one generated report in a browser with the network disabled and check every section renders.

- [ ] **Step 6: Commit**

```bash
git add src/report src/cli.ts test bin
git commit -m "feat: self-contained HTML report and --share redaction with leak tests"
```

---

### Task 10: Validation study, README and release readiness

**Files:**
- Create: `study/allowlist.json`, `study/RUBRIC.md`, `study/sample-reads.mjs`, `study/score.mjs`, `study/aggregate.mjs`, `study/labels.jsonl`, `docs/STUDY.md`, `README.md`, `CHANGELOG.md`
- Modify: `package.json` (`"version": "0.1.0"`, remove `"private"`), `bin/read-receipts.mjs` (rebuild)
- Test: `test/study/score.test.ts`, `test/study/allowlist.test.ts`

**Interfaces:**
- Consumes: `buildReport`, `analyzeSession`, `ReadRecord` (Tasks 5, 7, 8).
- Produces: `wilson(k: number, n: number): [number, number]` and `score(labels: Label[], predictions: Map<string, boolean>): { tp: number; fp: number; fn: number; tn: number; unclear: number; precision: number; recall: number; precisionCI: [number, number]; recallCI: [number, number] }` exported from `study/score.mjs`; key = `${sessionHash}:${readOrdinal}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('wilson interval matches a known value', () => { const [lo, hi] = wilson(8, 10); expect(lo).toBeCloseTo(0.490, 2); expect(hi).toBeCloseTo(0.943, 2); });
it('positive class is unreferenced/unused; unclear is excluded', () => {
  const s = score([lab('a', 1, 'unused'), lab('a', 2, 'used'), lab('a', 3, 'unclear'), lab('b', 1, 'unused')],
                  new Map([['a:1', true], ['a:2', true], ['a:3', true], ['b:1', false]]));
  expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 0, unclear: 1, precision: 0.5, recall: 0.5 });
});
it('labels.jsonl has the allowed fields only, repo-relative paths, short reasons', async () => {
  for (const l of await readLabels()) {
    expect(Object.keys(l).sort()).toEqual(['label', 'path', 'readOrdinal', 'reason', 'repo', 'sessionHash']);
    expect(l.sessionHash).toMatch(/^[0-9a-f]{12}$/); expect(l.path.startsWith('/')).toBe(false); expect(l.reason.length).toBeLessThanOrEqual(200);
  }
  expect((await readLabels()).length).toBeGreaterThanOrEqual(100);
});
it('sample-reads refuses sessions outside the allowlist', async () => { /* cwd /home/x/private -> excluded */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/study`
Expected: FAIL.

- [ ] **Step 3: Implement the study scripts** per spec section 11 (fixed seed, stratified sample of at least 120 reads, packets to `study/.work/` with no heuristic output). Write `study/RUBRIC.md` with the used/unused/unclear definitions of spec 11.3 and three synthetic worked examples.

- [ ] **Step 4: Run the study**

1. `node study/sample-reads.mjs` (writes `study/.work/packets/*.md` and `study/.work/predictions.json`).
2. Dispatch one labeller agent (fresh context) with only `study/RUBRIC.md` and the packets directory; it writes `study/labels.jsonl`. It must not see `predictions.json`, `src/analysis/reads.ts` or this plan.
3. `node study/score.mjs` writes `docs/STUDY.md` and the README block; `node study/aggregate.mjs` adds the aggregate numbers and the per-entrypoint corpus mix.
4. Before committing, grep the whole repo (`git grep -n -i -E "<markers>"`) for the private markers named in the controller's brief (private folder names, employer names, `/Users/<name>` home paths); it must print nothing except the synthetic `/Users/someone` test string.

- [ ] **Step 5: Write `README.md`** in this order: one-sentence problem; the study block (`<!-- STUDY:START -->`...`<!-- STUDY:END -->`, real numbers only, the sentence "labelled by an LLM reviewer with a written rubric, blind to the heuristic"); quick start (`npx <release .tgz URL>`, `--html`, `--share`); how it differs (credit tokentab for cost per PR with dead spend, and token-dashboard, contextclues, context-autopsy and anthropometer for duplicate reads, linking `docs/novelty.md`); how to read the report (every metric in one line with its formula link to the spec); limits (estimates, heuristic error rates, Codex fixtures synthetic, corpus mix, Claude Code format is not a stable API); privacy. `CHANGELOG.md` with `0.1.0`.

- [ ] **Step 6: Release readiness checks**

Run: `npm run typecheck && npm run lint && npm test && npm run build && npm run check:bundle && npm pack`
Then: `cd "$(mktemp -d)" && npx -y <abs path>/read-receipts-0.1.0.tgz --help`
Expected: all PASS and the help text prints from the packed tarball. Then request the independent code review and the security/privacy review (spec section 9 is the checklist), fix findings, and only then ask Mateusz to create `mateuszkania-im/read-receipts` and release.

- [ ] **Step 7: Commit**

```bash
git add study docs/STUDY.md README.md CHANGELOG.md package.json bin test/study
git commit -m "docs: validation study, README and 0.1.0 release prep"
```
