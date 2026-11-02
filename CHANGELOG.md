# Changelog

## 0.1.0 (2026-11-02)

First release.

- Reads Claude Code session logs (pinned to fixtures of version 2.1.316) and Codex rollouts, subagent threads included.
- Commands: `summary`, `sessions`, `session <id-prefix>`, `prs`, `compare` and `prices`, with terminal, `--json` and self-contained `--html` output.
- Cost per request from a bundled price table with sources, cache-adjusted, compared with Claude Code's own cost record.
- Context composition by source, introduced and processed.
- Referenced and unreferenced reads per file read, with a "likely unused" estimate from the validation study.
- Re-reads, unchanged re-reads and re-reads after a compaction.
- Harness fingerprint per session and `compare --by` a harness component or `--split-at` a date.
- Cost per branch and PR, with PR states from the `gh` CLI under `--gh`, attempts and unmerged spend.
- `--share` redaction with keyed labels for branch names, session ids and MCP server names.
- Validation study of the read heuristic in `docs/STUDY.md`, on four public repos: precision of "unreferenced" and the miss rate of "referenced"; recall is not published (stratified sample).
- `--json` schema version 1, documented in `docs/json-schema.md`.
- Node.js 20.19 or later. The bundled CLI parser is commander 14, which supports Node 20 (commander 15 needs Node 22.12); `engines` says `>=20.19`, the oldest version CI runs.
- Hardening from the security review: session-side files must be regular files under a size cap, a 30 s git budget per run, a depth cap of 64 for nested JSON, only local absolute working directories are opened, stricter `--share` lists, no control or bidi characters in output, and checks on the salt file and the `--html` target.
