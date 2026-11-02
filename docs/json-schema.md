# `--json` output, schema version 1

`read-receipts --json` prints one object, the same aggregate the terminal and HTML views are rendered from. This page lists every field. Names are stable within `schemaVersion: 1`; a rename or a removed field raises the version, a new field does not.

Conventions:

- Money is in US dollars, as a plain number (`usd`, `harnessUSD`, `unloggedUSD`, `carriedUSD`, `subagentUSD`, `unmergedSpend`, `noPrSpend`).
- Shares and rates are fractions from 0 to 1, or `null` when the denominator is 0.
- Times are ISO 8601 strings in UTC.
- Every number computed from a token estimate (4 characters per token) sits inside an object named `estimated` that has `estimated: true`.
- `readCounts` always holds counts. A field named `reads` is always a list of read rows, never a count.
- Under `--share`, `redacted` is `true` and the fields marked "redacted" below hold labels or are emptied (spec 9.6).

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Version of this layout. |
| `redacted` | boolean | `true` after `--share`. |
| `definitions` | object | `unreferenced` and `referenced`: the definitions of the read metric, as shown in the reports. |
| `generatedAt` | string | When the report was built. |
| `toolVersion` | string | The `read-receipts` version. |
| `options` | object | The options the report was built with (below). |
| `searched` | string[] | The log directories searched. Redacted to `default` or `custom`. |
| `totals` | object | Totals over every session (below). |
| `sessions` | object[] | One row per session, newest first (below). |
| `branches` | object[] | Cost per repo and branch (below). |
| `prs` | object[] | Cost per PR (below). |
| `compare` | object[] or null | Groups of `compare`, else `null` (below). |
| `warnings` | string[] | The notes printed under the report. |

## `options`

| Field | Type | Meaning |
|---|---|---|
| `claudeDir`, `codexDir` | string or null | Log directories. Redacted to `default` or `custom`. |
| `since`, `until` | string or null | Time window. |
| `projects` | string[] | `--project` directories. Redacted to basenames. |
| `agent` | `claude`, `codex` or `all` | Which logs were read. |
| `includeSubagents` | boolean | `false` with `--no-subagents`. |
| `pricesPath` | string or null | `--prices` file. Redacted to its basename. |
| `gh` | boolean | PRs looked up with `gh`. |
| `maxLineMb` | number | `--max-line-mb`. |
| `compare` | object or null | `by` (a fingerprint component or `null`), `splitAt` (string or `null`), `outcome` (`merged` or `any`). |
| `sessionPrefix` | string or null | The prefix of `session <id>`. Redacted to `null`. |
| `now` | string | The time open PR windows end at; equal to `generatedAt`. |

## `totals`

| Field | Type | Meaning |
|---|---|---|
| `sessions` | number | Sessions in the report. |
| `sessionsByAgent` | object | `claude-code` and `codex` session counts. |
| `period` | object | `from` and `to`: first and last event time. |
| `requests` | number | Model requests. |
| `usd` | number | Cost computed from token usage (spec 6.1). |
| `lowerBound` | boolean | `usd` leaves out requests without usage or price. |
| `requestsMissingUsage`, `requestsUnpriced`, `requestsUnpricedModifier`, `requestsApproxWritePrice` | number | Requests left out of `usd`, or priced approximately. |
| `unpricedModels`, `unpricedModifiers` | string[] | What had no price. |
| `byModel` | object[] | `model`, `usd`, `usage` per model. |
| `usage` (in `byModel` and `cost`) | object | Tokens: `input` (uncached), `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`. |
| `cacheHitShare` | number or null | Cache hit share: cache-read tokens over all input tokens. |
| `harnessUSD` | number or null | Claude Code's own cost record, summed. |
| `unloggedUSD` | number or null | `harnessUSD` minus the computed cost: harness calls without a transcript record. |
| `sessionsWithPriceMismatch` | number | Sessions whose computed cost is above the harness record by more than 1%. |
| `readCounts` | object | Read counts (below). |
| `unreferencedReadRate` | number or null | `readCounts.unreferenced / readCounts.total`. |
| `rereadRate` | number or null | `readCounts.rereads / readCounts.total`. |
| `compactions` | number | Compactions of main threads. |
| `compactionRereadRate` | number or null | Files read before a compaction and re-read unchanged after it, over files read before it (spec 6.4). |
| `reattachedThenReread` | number | Files re-attached by a compaction and then read again. |
| `subagents`, `subagentUSD`, `subagentCostShare` | number | Subagent threads, their cost and its share of `usd`. |
| `unmergedSpend` | number or null | Closed-unmerged PRs plus branch spend with no PR; `null` without `--gh`. |
| `noPrSpend` | number | Spend on non-default branches with no known PR. |
| `topSessions` | object[] | The 5 costliest sessions: `sessionId`, `usd`, `lowerBound`, `startedAt`, `repo`. |
| `topRereadFiles` | object[] | `path` and `count` of the most re-read files. |
| `files` | object | Log lines read: `lines`, `badLines` (unparseable), `skippedRecords`, `longLines` (over `--max-line-mb`), `deepValues` (JSON values nested deeper than 64 levels, skipped). |
| `estimated` | object | Estimated totals (below). |

### `readCounts` (in `totals` and in each session)

| Field | Type | Meaning |
|---|---|---|
| `total` | number | File reads. |
| `unreferenced` | number | Reads nothing later refers back to (spec 6.3). |
| `rereads` | number | Reads of a file the same thread had read before. |
| `rereadsUnchanged` | number | Re-reads of an unchanged file. |
| `rereadsAfterCompaction` | number | Re-reads after a compaction. |

### `totals.estimated`

| Field | Type | Meaning |
|---|---|---|
| `estimated` | `true` | Marks the block. |
| `readTokens`, `unreferencedTokens` | number | Tokens of all reads and of unreferenced reads (≈). |
| `unreferencedTokenShare` | number or null | `unreferencedTokens / readTokens`. |
| `unreferencedCarriedUSD` | number | Cost of keeping unreferenced reads in the cached context (≈). |
| `likelyUnused` | object or null | `count`, `low`, `high`, `precision`, `ci`, `sample`: unreferenced reads times the study precision, with the range scaled from the precision CI (low end rounded down, high end up). `null` when no study numbers are configured. |
| `rereadUnchangedTokens` | number | Tokens of unchanged re-reads (≈). |
| `composition` | object[] | Per context source: `source`, `introduced` (tokens it put into the context) and `processed` (tokens sent again with later requests). |
| `topUnreferencedFiles` | object[] | `path`, `count` and `estimated.tokens` of the files with the most unreferenced tokens. |

## `sessions[]`

| Field | Type | Meaning |
|---|---|---|
| `agent` | `claude-code` or `codex` | |
| `sessionId` | string | Redacted to an `s-` label. |
| `startedAt`, `endedAt` | string | First and last event. |
| `cwd` | string or null | Working directory. Redacted to `null`. |
| `repo` | string or null | Git root. Redacted to its basename. |
| `entrypoint`, `version` | string or null | How the agent was started, and its version. Under `--share` only known values are kept; others become `other`. |
| `cost` | object | As in `totals`: `usd`, `lowerBound`, `requests`, `requestsMissingUsage`, `requestsUnpriced`, `unpricedModels`, `requestsUnpricedModifier`, `unpricedModifiers`, `requestsApproxWritePrice`, `byModel`, `usage`, `cacheHitShare`, `harnessUSD`, `unloggedUSD`, and `priceMismatch` (boolean). |
| `branchSpans` | object[] | Time spans of one cwd and branch: `ts` (start), `cwd`, `branch`, `usd`, `requests`, `subagent`. Redacted: `cwd` is `null`, `branch` a label. |
| `readCounts` | object | As above, for this session. |
| `rereadRate` | number or null | |
| `reads` | object[] | Read rows kept in the report: the top 50 unreferenced by tokens, or every read for `session <id>`. |
| `readsOmitted` | number | Reads not in `reads`. |
| `compactions` | number | Compactions in this session. |
| `compactionRereads` | object | `readBefore`, `rereadUnchangedAfter`, `reattachedThenReread`. |
| `compactionRereadRate` | number or null | |
| `fingerprint` | object | Harness fingerprint (spec 6.5): `instructions`, `skills`, `hooks`, `mcp`, `systemPrompt`, `model`, and the combined `fingerprint`. |
| `subagents` | object[] | `threadId`, `agentType`, `usd`. |
| `edits` | number | Successful edit and write calls. |
| `explicitPrs` | object[] | PR links seen in the session: `number`, `repo`. |
| `estimated` | object | `estimated`, `readTokens`, `unreferencedTokens`, `unreferencedTokenShare`, `unreferencedCarriedUSD`, `rereadUnchangedTokens`, `composition`, `exactPromptFirst`, `exactPromptTotal`, `unattributedFirst`, `lateSources`. |

### `sessions[].reads[]`

| Field | Type | Meaning |
|---|---|---|
| `threadId` | string | The thread that read the file. Redacted to an `s-` label. |
| `seq` | number | Event number in the thread. |
| `path` | string | Repo-relative when under the git root. |
| `inRepo` | boolean | |
| `referenced` | boolean | |
| `reason` | string or null | What referred to it: `edit`, `path`, `symbol` or `edit-subject`. |
| `reread` | object or null | `kind` (`unchanged` or `changed`) and `afterCompaction`. |
| `approximateRange` | boolean | The line range read is not known exactly. |
| `estimated` | object | `estimated`, `tokens` and `carriedUSD`. |

## `branches[]`

`repo` (the main repository root; redacted to a basename, or an `r-` label when the directory is not a repo), `branch` (redacted to a label), `outcome` (`default`, `noPr`, `pr`, `noRepo`, `detached` or `worktreeGone`), `usd`, `sessions`.

## `prs[]`

`repo`, `number`, `state` (`merged`, `open`, `closedUnmerged` or `unknown`), `usd`, `attempts` (sessions), `attemptsNoEdit`, `title` and `url` (emptied when redacted), `sessionIds`, `sessionUsd` (cost of each session in `sessionIds`).

## `compare[]`

`group`, `sessions`, `tooFew` (under 5 sessions; the medians are then `null`), `medianUsd`, `p90Usd`, `medianUsdPerMergedPr`, `unreferencedTokenShare`, `rereadRate`, `compactionRereadRate`, `cacheHitShare`.
