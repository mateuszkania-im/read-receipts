# Novelty check (1 November 2026)

Working name: `agent-ledger`. Published name: **`read-receipts`** (see "Name" below).

Method: read the README of every tool the brief names, plus the closest tools that turned up while checking the name (GitHub and npm search for the name, for "unused reads", "context waste", "cost per PR"). Only what a README claims counts; a tool may do more internally. Star counts are from 1 November 2026.

## What each tool claims

| Tool | Stars | Agents | What it claims | Overlap with us |
|---|---|---|---|---|
| [ccusage](https://github.com/ccusage/ccusage) | 19.3k | Claude Code, Codex and 12 more | Token usage and cost per day, week, month, session, model | Cost from usage records. No per-file, per-read, per-branch or per-PR view. |
| [token-dashboard](https://github.com/nateherkai/token-dashboard) | 755 | Claude Code | Per-prompt cost, tool and file heatmaps, subagent attribution, cache analytics; "the same file read twenty times" as a pattern to spot | Repeated reads visible in a heatmap. No referenced/unreferenced test, no compaction link, no PR. |
| [claude-devtools](https://github.com/matt1398/claude-devtools) (the "claude-dt" in the brief) | 4.0k | Claude Code | Visual session inspector: per-turn token attribution in 7 categories, compaction visualisation, subagent trees with cost | Context composition per turn. A viewer, not a measurement: no read usage, no PR cost. |
| [claude-trace-replay](https://github.com/harrylettering/claude-trace-replay) | 264 | Claude Code | Replay sessions, token spikes, compare two sessions, follow subagents | Session compare. No read usage, no PR, no harness fingerprint. |
| [claude-session-analyzer (yonk-labs)](https://github.com/yonk-labs/claude-session-analyzer) | 3 | Claude Code | Context per session and per skill, CLAUDE.md/skills/MCP "bloat ratio" | Context composition by source. No read usage, no PR. |
| [claude-session-analyzer (lucemia)](https://github.com/lucemia/claude-session-analyzer) | 16 | Claude Code | Read:Edit ratio, edits without prior Read, thinking depth, sentiment, cost | Read counts as a behaviour ratio, not per-read use. |
| [contextclues](https://github.com/MaxwellVolz/contextclues) | 2 | Claude Code (live session) | Composition by source, "files loaded repeatedly", compaction token drops, unused enabled tools, "stale heavy evidence" | Closest on context: repeated loads and composition. Live single session; no "never referenced" test, no cost per PR. |
| [context-autopsy](https://github.com/AlistairClark7/context-autopsy) (npm) | 1 | 13 agents incl. Claude Code, Codex | Context by category (overhead incl. CLAUDE.md/AGENTS.md, build output, environment), "exact duplicates (the same file read twice)", failed commands, compactions, a shareable card | Duplicate reads and composition. Exact-duplicate only; no use test, no compaction re-read, no PR. |
| [anthropometer (amtr)](https://github.com/arian-shamaei/anthropometer) | 29 | Claude Code, Codex, Gemini, OpenCode | Context as a memory map, "prices re-reads", per-subagent economics, compaction forensics (what a compaction dropped) | Re-read pricing and compaction set-difference. Interactive TUI; no "never referenced" test, no PR. |
| [tokentab](https://github.com/smerwin/tokentab) | 2 | Claude Code (+ OTel, vendor APIs) | **Cost per merged PR** from transcripts + `gh`, "dead spend" (closed-unmerged PRs and repo work that never reached a PR), subagents on a detached HEAD inherit the parent branch | **Covers cost per PR with failed attempts.** We credit it and do not claim this part as new. |

Also seen while checking the name, not overlapping the core: `context-audit` (npm; instruction-file cost and skills that never fire), `context-ledger` (npm; session analytics and memory handoff), `ethanplusai/agent-ledger` (Python; history search and decision recall), `rzaaeeff/agent-ledger` (PIN lines restored after compaction).

## Verdict

No tool claims the core combination, so we go ahead. Cost per PR including failed and abandoned attempts is already done by tokentab, and repeated or duplicate reads are already flagged by token-dashboard, contextclues, context-autopsy and anthropometer. Our README must say so and must not lead with either. What none of them claims, and what `read-receipts` leads with, has three parts. First, a per-read test of whether anything the agent did later (an edit, a command, a later tool input, its own text) refers to the file or to a symbol defined in it, with the heuristic's precision and the miss rate of "referenced" published against blind labels. Recall is not published: the labelled sample was stratified by the heuristic's call, so recall cannot be estimated from it without reweighting. Second, re-reads of the same unchanged file after a compaction as a compaction-loss measure that needs no LLM. Third, a harness fingerprint per session (hashes of AGENTS.md/CLAUDE.md, skills, hooks, MCP servers), so `compare` can put cost, unreferenced share and re-read rate side by side before and after a harness change. Sessions are grouped by outcome, using the PR state where one exists. All three run on Claude Code and Codex logs, in one local CLI with a `--share` report.

## Name

`agent-ledger` is free on npm, but GitHub already has at least three coding-agent tools with that exact name: `ethanplusai/agent-ledger` (Claude Code and Codex history and usage), `rzaaeeff/agent-ledger` (a Claude Code and Codex compaction plugin) and `WDZ-Dev/agent-ledger` (agent cost proxy). npm also has `agentledger` (agent observability) and `context-ledger` (coding-agent session analytics). That is confusing in exactly our niche.

Alternatives checked on npm and GitHub:

1. **`read-receipts`**: free on npm. No GitHub repo with this name for coding agents; the existing ones are messaging read-receipts. It names the differentiator (what the agent read) and the bill (receipts) in one phrase.
2. `context-bill`: free on npm and GitHub, but says less about reads and is easy to misread.

Choice: **`read-receipts`**. The CLI command and npm name are `read-receipts`. The GitHub repo will be `mateuszkania-im/read-receipts` at release time. The local folder keeps the working name `agent-ledger` until then, and so do the spec and plan file names.
