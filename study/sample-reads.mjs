#!/usr/bin/env node
// Validation study, step 1 (spec section 11.1 and 11.2): list every read in the allowlisted corpus,
// draw a stratified sample with a fixed seed and write one packet per read for the labeller.
//
//   node study/sample-reads.mjs --dev   (v2 predictions for the first sample: study/.work/predictions-dev.json)
//   node study/sample-reads.mjs [--claude-dir <dir>] [--codex-dir <dir>] [--out study/.work] [--target 150]
//                               [--deny study/.work/deny.txt]
//
// Only sessions whose cwd (and every request cwd) lies inside an allowlisted public repo are read; every
// other session is refused before any of its content is kept. A repo counts only at
// `<home>/<parent>/<name>` with `parent` and `name` from study/allowlist.json.
//
// Packets go to `<out>/packets/<sessionHash>-<readOrdinal>.md` and hold the read and what the agent did
// after it, with paths outside the repo, the home directory, the user name, e-mail addresses and
// common token formats replaced. They hold no output of the read metrics. The metric's outcome per read
// goes to `<out>/predictions.json`, which the labeller never sees. `<out>` (study/.work/) is gitignored.
//
// Optional `--deny <file>` (default `<out>/deny.txt`, one marker per line, kept out of git): a read
// whose path or content holds a marker is dropped, and a later event holding one is left out.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export const SEED = 20261102;
export const DEFAULT_TARGET = 150;
/** At most this many sampled reads from one session, so a few long sessions cannot fill the sample. */
export const PER_SESSION_CAP = 3;
/** Each tool stratum gets at least this many reads per outcome class when the corpus has them. */
export const TOOL_FLOOR = 15;
const READ_CAP = 4000;
const RESULT_CAP = 400;
const CALL_CAP = 2000;
const TEXT_CAP = 1200;
const PROMPT_CAP = 400;
const LATER_CAP = 20000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The source modules, loaded through tsx when this runs under plain node (vitest loads TS itself). */
async function src() {
  if (!process.env.VITEST) {
    const { register } = await import('tsx/esm/api');
    register();
  }
  const [analyze, discover, claude, codex, prices, paths] = await Promise.all([
    import('../src/analyze-session.ts'),
    import('../src/io/discover.ts'),
    import('../src/parse/claude.ts'),
    import('../src/parse/codex.ts'),
    import('../src/prices/table.ts'),
    import('../src/io/paths.ts'),
  ]);
  const jsonl = await import('../src/io/jsonl.ts');
  return { ...analyze, ...discover, ...claude, ...codex, ...prices, ...paths, ...jsonl };
}

// ---------------------------------------------------------------------------------------------------
// Allowlist

export async function loadAllowlist(file) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(doc.repos) || !Array.isArray(doc.parents)) throw new Error(`${file}: needs "repos" and "parents" arrays`);
  return { repos: doc.repos.map(String), parents: doc.parents.map(String) };
}

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** The allowlisted repo root that contains `cwd`, or null. */
export function allowedRoot(cwd, allowlist, home) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const c = norm(cwd);
  const h = norm(home);
  for (const parent of allowlist.parents) {
    for (const repo of allowlist.repos) {
      const root = `${h}/${norm(parent)}/${repo}`;
      if (c === root || c.startsWith(`${root}/`)) return root;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Scrubbing

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STOP = `\\s"'\`()<>\\[\\]{},;`;
const ABS_PATH = new RegExp(`(?<![\\w.~-])/(?:Users|home|private|tmp|var|Volumes|opt|root|etc|mnt|srv|workspace)(?:/[^${STOP}]*)?`, 'g');
const TILDE_PATH = new RegExp(`(?<![\\w.-])~/[^${STOP}]*`, 'g');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKENS = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

/**
 * Text for a packet: the repo root becomes relative, every other absolute or `~` path becomes
 * `<outside-repo>`, tokens holding the user name become `<redacted>`, e-mails and common API token
 * formats are replaced. Returns null when the text holds a deny marker (case-insensitive).
 */
export function scrubText(text, ctx) {
  let t = String(text);
  const root = norm(ctx.root);
  const home = norm(ctx.home);
  const tildeRoot = root.startsWith(`${home}/`) ? `~/${root.slice(home.length + 1)}` : null;
  for (const r of [root, tildeRoot]) {
    if (r === null) continue;
    t = t.split(`${r}/`).join('').split(r).join('.');
  }
  t = t.replace(TOKENS, '<secret>').replace(EMAIL, '<email>');
  if (ctx.user && ctx.user.length >= 3) t = t.replace(new RegExp(`[^${STOP}]*${esc(ctx.user)}[^${STOP}]*`, 'gi'), '<redacted>');
  t = t.split(`${home}/`).join('~/').split(home).join('~');
  t = t.replace(ABS_PATH, '<outside-repo>').replace(TILDE_PATH, '<outside-repo>');
  const lower = t.toLowerCase();
  for (const m of ctx.deny) if (m !== '' && lower.includes(m.toLowerCase())) return null;
  return t;
}

function hasDeny(text, deny) {
  const lower = String(text).toLowerCase();
  return deny.some((m) => m !== '' && lower.includes(m.toLowerCase()));
}

/** The one root check: a normalised absolute path at or under the repo root. */
export function insideRoot(p, root) {
  const a = path.posix.normalize(norm(p));
  return a === root || a.startsWith(`${root}/`);
}

/** System paths a command may name without touching files outside the repo. */
const HARMLESS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/env']);
const TOKEN_SPLIT = /[\s"'`()<>[\]{},;=|&]+/;
/** Shell expansion the filter cannot follow: parameters, globs, command substitution. `~` is checked per token. */
const SHELL_EXPANSION = /[$*?[`]/;
/** Shell tool names whose input is a command line (Claude Code `Bash`, Codex shells). */
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec', 'exec_command', 'unified_exec', 'write_stdin']);

/** A token with `..` as one of its path segments (`/` or `\` separated). */
const hasDotDot = (tok) => tok.split(/[\\/]/).includes('..');

/** An absolute or `~` path token as an absolute path; null for anything else. */
function resolveToken(tok, home) {
  const t = tok.replace(/[.:]+$/, '');
  if (t === '~' || t.startsWith('~/')) return path.posix.normalize(`${norm(home)}${t.slice(1)}`);
  if (/^\/[A-Za-z0-9._-]/.test(t)) return path.posix.normalize(t);
  return null;
}

/**
 * True when the text names a path outside the root: an absolute or `~` path that resolves outside it, or
 * any token with a `..` segment (outside even when it would resolve back inside: the filter does not
 * follow symlinks or the shell's notion of the current directory).
 */
export function touchesOutside(text, ctx) {
  for (const tok of String(text).replace(/\\n/g, ' ').split(TOKEN_SPLIT)) {
    if (tok === '') continue;
    if (hasDotDot(tok)) return true;
    const r = resolveToken(tok, ctx.home);
    if (r !== null && !HARMLESS.has(r) && !insideRoot(r, ctx.root)) return true;
  }
  return false;
}

/** Shell words, with the command separators as words of their own. */
function shellWords(cmd) {
  return cmd
    .replace(/\\n/g, '\n')
    .replace(/([;&|()<>\n])/g, ' $1 ')
    .split(/[\s"']+/)
    .filter((w) => w !== '');
}

/**
 * True when a command line may touch files outside the root: shell expansion, a `~` word, or a `cd` or
 * `pushd` whose target is missing, an option, or not a path inside the root (resolved against `cwd`).
 */
function shellTouchesOutside(cmd, ctx) {
  if (SHELL_EXPANSION.test(cmd)) return true;
  const words = shellWords(cmd);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('~')) return true;
    if (w !== 'cd' && w !== 'pushd') continue;
    const target = words[i + 1];
    if (target === undefined || /^[;&|()<>\n]/.test(target) || target.startsWith('-')) return true;
    const abs = target.startsWith('/') ? target : `${norm(ctx.cwd)}/${target}`;
    if (hasDotDot(target) || !insideRoot(abs, ctx.root)) return true;
  }
  return false;
}

/**
 * The one packet filter for a tool call: true unless the call provably stays inside the root. Fails
 * closed: an unknown cwd (or one outside the root), a Codex shell call (its workdir is not on the event),
 * a path or token outside, any `..` segment, shell expansion and an unchecked `cd` all count as outside.
 * `ctx.cwd` is the cwd of the call's own thread at that point.
 */
export function callTouchesOutside(call, raw, ctx) {
  if (typeof ctx.cwd !== 'string' || ctx.cwd === '' || !insideRoot(ctx.cwd, ctx.root)) return true;
  const shell = call.command !== undefined ? call.command : SHELL_TOOLS.has(call.tool) || call.toolClass === 'bash' ? call.text : null;
  if (shell !== null && ctx.agent === 'codex') return true;
  if (call.paths.some((p) => hasDotDot(p) || !insideRoot(p, ctx.root))) return true;
  if (touchesOutside(call.text, ctx) || (raw !== undefined && touchesOutside(raw, ctx))) return true;
  return shell !== null && shellTouchesOutside(shell, ctx);
}

/**
 * The call ids of a session whose call may touch a path outside the root. Each call is judged against
 * its own thread's cwd at that point: the cwd of the latest request before it, else the thread's.
 */
function outsideCalls(threads, rawInputs, ctx) {
  const out = new Set();
  for (const t of threads) {
    let cwd = t.meta.cwd ?? null;
    for (const e of t.events) {
      if (e.kind === 'request' && typeof e.cwd === 'string' && e.cwd !== '') cwd = e.cwd;
      if (e.kind !== 'tool_call') continue;
      if (callTouchesOutside(e, rawInputs.get(e.callId), { ...ctx, cwd })) out.add(e.callId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Corpus

export const sessionHash = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);

/**
 * Claude Code tool inputs as written in the log, by tool_use id. The parser keeps only some input keys
 * (the ones the read metric looks at); a labeller needs the whole input, e.g. a StructuredOutput answer.
 */
async function rawToolInputs(files, into) {
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && b.type === 'tool_use' && typeof b.id === 'string' && b.input !== undefined) into.set(b.id, JSON.stringify(b.input, null, 1));
      }
    }
  }
  return into;
}

async function threadsOf(S, source, maxLineBytes) {
  const threads = [];
  const collect = async (parsed) => {
    const meta = await parsed.meta;
    const events = [];
    for await (const e of parsed.events) events.push(e);
    return { meta, events };
  };
  const ctx = { maxLineBytes };
  if (source.agent === 'codex') {
    threads.push(await collect(S.parseCodexThread(source.mainFile, ctx, S.newStats())));
    return threads;
  }
  threads.push(await collect(S.parseClaudeThread(source.mainFile, { ...ctx, threadId: source.sessionId, parentThreadId: null, spawnedByCallId: null }, S.newStats())));
  for (const file of source.subagentFiles) {
    const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
    let toolUseId = null;
    try {
      const m = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (typeof m?.toolUseId === 'string') toolUseId = m.toolUseId;
    } catch {
      // no meta file
    }
    threads.push(await collect(S.parseClaudeThread(file, { ...ctx, threadId: agentId, parentThreadId: source.sessionId, spawnedByCallId: toolUseId }, S.newStats())));
  }
  return threads;
}

/** Every cwd a session names (thread metas and requests) must lie inside the same allowlisted repo. */
function sessionRoot(threads, allowlist, home) {
  const main = threads[0];
  const root = allowedRoot(main.meta.cwd, allowlist, home);
  if (root === null) return null;
  for (const t of threads) {
    if (t.meta.cwd !== null && allowedRoot(t.meta.cwd, allowlist, home) !== root) return null;
    for (const e of t.events) if (e.kind === 'request' && e.cwd !== null && allowedRoot(e.cwd, allowlist, home) !== root) return null;
  }
  return root;
}

function toolKind(agent, tool) {
  if (agent === 'codex') return 'codex';
  return tool === 'Read' ? 'read' : 'bash';
}

/**
 * Lists the reads of the allowlisted corpus. Each candidate carries its prediction (kept apart from the
 * packet) and a handle to the session's events for the packet writer.
 */
export async function collectCorpus(opts) {
  const S = await src();
  const prices = await S.loadPriceTable(null);
  const maxLineBytes = 256 * 1024 * 1024;
  const sources = await S.discoverSessions({ claudeDir: opts.claudeDir, codexDir: opts.codexDir, sinceMs: null, agent: 'all', includeSubagents: true });
  sources.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const out = { sessions: 0, refusedSessions: 0, readsOutsideRepo: 0, readsDenied: 0, totalReads: 0, byEntrypoint: {}, byRepo: {}, candidates: [], data: new Map() };
  for (const source of sources) {
    const threads = await threadsOf(S, source, maxLineBytes);
    const root = sessionRoot(threads, opts.allowlist, opts.home);
    if (root === null) {
      out.refusedSessions++;
      continue;
    }
    const repo = path.posix.basename(root);
    const result = await S.analyzeSession(source, { prices, maxLineBytes, includeSubagents: true, gitRoot: async () => root });
    out.sessions++;
    const ep = threads[0].meta.entrypoint ?? 'unknown';
    out.byEntrypoint[ep] = (out.byEntrypoint[ep] ?? 0) + 1;
    const hash = sessionHash(result.sessionId);
    const mainId = threads[0].meta.threadId;
    const reads = [...result.reads].sort((a, b) => (a.threadId === mainId ? 0 : 1) - (b.threadId === mainId ? 0 : 1) || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0) || a.seq - b.seq);
    const byKey = new Map();
    for (const t of threads) for (const e of t.events) if (e.kind === 'tool_result' && e.read !== null) byKey.set(`${e.threadId}\u0000${e.seq}`, e);
    const rawInputs = source.agent === 'codex' ? new Map() : await rawToolInputs([source.mainFile, ...source.subagentFiles], new Map());
    const outside = outsideCalls(threads, rawInputs, { root, home: opts.home, agent: source.agent });
    out.data.set(hash, { threads, root, repo, agent: source.agent, mainId, rawInputs, outside });
    reads.forEach((r, i) => {
      out.totalReads++;
      const ev = byKey.get(`${r.threadId}\u0000${r.seq}`);
      const abs = norm(S.normalizePath(r.path));
      if (ev === undefined || abs === root || !insideRoot(abs, root) || outside.has(ev.callId)) {
        out.readsOutsideRepo++;
        return;
      }
      const rel = abs.slice(root.length + 1);
      if (hasDeny(rel, opts.deny) || hasDeny(ev.text, opts.deny)) {
        out.readsDenied++;
        return;
      }
      out.byRepo[repo] = (out.byRepo[repo] ?? 0) + 1;
      out.candidates.push({ sessionHash: hash, readOrdinal: i + 1, repo, path: rel, tool: toolKind(source.agent, ev.tool), threadId: r.threadId, seq: r.seq, unreferenced: !r.referenced, reason: r.reason });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Sampling

/** mulberry32: a small seeded PRNG, so the sample is the same on every run over the same corpus. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Largest-remainder split of `n` over `weights`, never above `caps`. */
function apportion(n, weights, caps) {
  const keys = Object.keys(weights);
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  let left = Math.min(n, keys.reduce((s, k) => s + caps[k], 0));
  while (left > 0) {
    const open = keys.filter((k) => out[k] < caps[k]);
    const total = open.reduce((s, k) => s + weights[k], 0);
    if (open.length === 0 || total === 0) break;
    const exact = Object.fromEntries(open.map((k) => [k, (left * weights[k]) / total]));
    let given = 0;
    for (const k of open) {
      const g = Math.min(Math.floor(exact[k]), caps[k] - out[k]);
      out[k] += g;
      given += g;
    }
    if (given === 0) {
      const k = [...open].sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])) || (a < b ? -1 : 1))[0];
      out[k]++;
      given = 1;
    }
    left -= given;
  }
  return out;
}

const keyOf = (c) => `${c.sessionHash}:${c.readOrdinal}`;

/**
 * Stratified by predicted outcome (half each when the corpus allows), then by tool (each tool at least
 * TOOL_FLOOR when available, the rest proportional), then proportional per repo. At most
 * PER_SESSION_CAP reads per session.
 */
export function drawSample(candidates, target, seed = SEED) {
  const rand = rng(seed);
  const perSession = new Map();
  const picked = [];
  const take = (c) => {
    const n = perSession.get(c.sessionHash) ?? 0;
    if (n >= PER_SESSION_CAP) return false;
    perSession.set(c.sessionHash, n + 1);
    picked.push(c);
    return true;
  };
  const classes = [true, false].map((u) => candidates.filter((c) => c.unreferenced === u));
  const half = Math.floor(target / 2);
  const want = [Math.min(classes[0].length, target - Math.min(classes[1].length, half)), 0];
  want[1] = Math.min(classes[1].length, target - want[0]);
  classes.forEach((pool, ci) => {
    const tools = [...new Set(pool.map((c) => c.tool))].sort();
    const avail = Object.fromEntries(tools.map((t) => [t, pool.filter((c) => c.tool === t).length]));
    const floor = Object.fromEntries(tools.map((t) => [t, Math.min(avail[t], TOOL_FLOOR)]));
    const rest = apportion(want[ci] - Object.values(floor).reduce((s, x) => s + x, 0), avail, Object.fromEntries(tools.map((t) => [t, avail[t] - floor[t]])));
    for (const tool of tools) {
      const cell = pool.filter((c) => c.tool === tool);
      const n = floor[tool] + rest[tool];
      const repos = [...new Set(cell.map((c) => c.repo))].sort();
      const byRepo = Object.fromEntries(repos.map((r) => [r, shuffle(cell.filter((c) => c.repo === r), rand)]));
      const quota = apportion(n, Object.fromEntries(repos.map((r) => [r, byRepo[r].length])), Object.fromEntries(repos.map((r) => [r, byRepo[r].length])));
      let got = 0;
      const used = new Set();
      for (const r of repos) {
        let q = quota[r];
        for (const c of byRepo[r]) {
          if (q === 0) break;
          if (take(c)) {
            used.add(keyOf(c));
            q--;
            got++;
          }
        }
      }
      // Session caps can leave a repo short: fill from the rest of the cell.
      for (const c of shuffle(cell, rand)) {
        if (got >= n) break;
        if (!used.has(keyOf(c)) && take(c)) {
          used.add(keyOf(c));
          got++;
        }
      }
    }
  });
  return picked.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------
// Packets

function fence(text) {
  const runs = String(text).match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  return '`'.repeat(n);
}

function block(text) {
  const f = fence(text);
  return `${f}text\n${text}\n${f}\n`;
}

function cap(text, n) {
  return text.length <= n ? { text, cut: false } : { text: text.slice(0, n), cut: true };
}

const SKIP_KINDS = new Set(['request', 'injection', 'harness_cost']);

const LEFT_OUT = '[left out: outside repo]';

function describeEvent(e, callTools, ctx, rawInputs, outside) {
  if (e.kind === 'tool_call' && outside.has(e.callId)) return { head: `tool call: ${e.tool}`, body: LEFT_OUT };
  if (e.kind === 'tool_result' && (outside.has(e.callId) || (e.read !== null && !insideRoot(e.read.path, ctx.root)))) {
    return { head: `tool result: ${callTools.get(e.callId) ?? e.tool}`, body: LEFT_OUT };
  }
  if (e.kind === 'tool_call') {
    const paths = e.paths.map((p) => scrubText(p, ctx)).filter((p) => p !== null);
    const body = scrubText(rawInputs.get(e.callId) ?? e.text, ctx);
    if (body === null) return { head: `tool call: ${e.tool}`, body: '[left out: private content]' };
    const c = cap(body, CALL_CAP);
    const head = `tool call: ${e.tool}${paths.length > 0 ? ` (${paths.join(', ')})` : ''}${c.cut ? ` (input, first ${CALL_CAP} chars)` : ''}`;
    return { head, body: c.text };
  }
  if (e.kind === 'tool_result') {
    const body = scrubText(e.text, ctx);
    const tool = callTools.get(e.callId) ?? e.tool;
    if (body === null) return { head: `tool result: ${tool}`, body: '[left out: private content]' };
    const c = cap(body, RESULT_CAP);
    return { head: `tool result: ${tool}${e.isError ? ' (error)' : ''}${c.cut ? ` (first ${RESULT_CAP} of ${body.length} chars)` : ''}`, body: c.text };
  }
  if (e.kind === 'assistant_text') {
    const body = scrubText(e.text, ctx);
    if (body === null) return { head: 'assistant text', body: '[left out: private content]' };
    const c = cap(body, TEXT_CAP);
    return { head: `assistant text${c.cut ? ` (first ${TEXT_CAP} chars)` : ''}`, body: c.text };
  }
  if (e.kind === 'user_prompt') {
    const body = scrubText(e.text, ctx);
    if (body === null) return { head: 'user message (not the agent)', body: '[left out: private content]' };
    const c = cap(body, PROMPT_CAP);
    return { head: `user message (not the agent)${c.cut ? ` (first ${PROMPT_CAP} chars)` : ''}`, body: c.text };
  }
  if (e.kind === 'compaction') return { head: 'context compaction (earlier conversation summarised)', body: null };
  return null;
}

/** The events after the read: the rest of its thread, then for a subagent the parent from its result on. */
function laterEvents(data, cand) {
  const thread = data.threads.find((t) => t.meta.threadId === cand.threadId) ?? data.threads.find((t) => t.events.some((e) => e.threadId === cand.threadId));
  const own = thread.events.filter((e) => e.threadId === cand.threadId && e.seq > cand.seq);
  const parts = [{ label: null, events: own }];
  const spawn = thread.meta.threadId === cand.threadId ? thread.meta.spawnedByCallId : null;
  if (spawn !== null && thread.meta.parentThreadId !== null) {
    const parent = data.threads.find((t) => t.meta.threadId === thread.meta.parentThreadId);
    const start = parent?.events.findIndex((e) => e.kind === 'tool_result' && e.callId === spawn) ?? -1;
    if (parent && start >= 0) parts.push({ label: 'Back in the parent thread (from the subagent\'s final answer on)', events: parent.events.slice(start).filter((e) => e.threadId === parent.meta.threadId) });
  }
  return { thread, parts };
}

export function renderPacket(data, cand, ctx) {
  const { thread, parts } = laterEvents(data, cand);
  const readEv = thread.events.find((e) => e.threadId === cand.threadId && e.seq === cand.seq && e.kind === 'tool_result');
  const call = thread.events.find((e) => e.kind === 'tool_call' && e.callId === readEv.callId);
  const callTools = new Map();
  for (const t of data.threads) for (const e of t.events) if (e.kind === 'tool_call') callTools.set(e.callId, e.tool);
  const via = cand.tool === 'read' ? 'Read tool' : cand.tool === 'bash' ? 'Bash command' : 'Codex shell command';
  const content = scrubText(readEv.text, ctx) ?? '';
  const c = cap(content, READ_CAP);
  const out = [];
  out.push(`# Read packet ${cand.sessionHash}-${cand.readOrdinal}`, '');
  out.push(`- sessionHash: ${cand.sessionHash}`, `- readOrdinal: ${cand.readOrdinal}`, `- repo: ${cand.repo}`, `- path: ${cand.path}`, `- read via: ${via}`, `- thread: ${cand.threadId === data.mainId ? 'main' : 'subagent'}`, '');
  out.push('## The read', '');
  if (call && cand.tool !== 'read') {
    const cmd = scrubText(call.text, ctx);
    if (cmd !== null) out.push('Command:', '', block(cap(cmd, CALL_CAP).text));
  }
  out.push(c.cut ? `Content (first ${READ_CAP} of ${content.length} chars):` : `Content (${content.length} chars):`, '', block(c.text));
  out.push('## What happened after the read, in order', '');
  let used = 0;
  let n = 0;
  let left = 0;
  for (const part of parts) {
    if (part.label !== null && used < LATER_CAP) out.push(`### ${part.label}`, '');
    for (const e of part.events) {
      if (SKIP_KINDS.has(e.kind)) continue;
      const d = describeEvent(e, callTools, ctx, data.rawInputs, data.outside);
      if (d === null) continue;
      const size = d.head.length + (d.body?.length ?? 0);
      if (used + size > LATER_CAP) {
        left++;
        continue;
      }
      used += size;
      n++;
      out.push(`#### ${n}. ${d.head}`, '');
      if (d.body !== null) out.push(block(d.body));
    }
  }
  if (n === 0 && left === 0) out.push('(nothing: the session ends after this read)', '');
  if (left > 0) out.push(`[${left} more events not shown: the packet is capped at ${LATER_CAP} chars of later events]`, '');
  return out.join('\n');
}

/**
 * Current-heuristic (v2) predictions for the reads of an earlier sample, keyed like that sample: the
 * development-set figure of spec 11.6. Throws when a read is gone or now belongs to another repo.
 */
export function devPredictions(candidates, firstPredictions) {
  const byKey = new Map(candidates.map((c) => [keyOf(c), c]));
  const out = {};
  for (const [k, p] of Object.entries(firstPredictions)) {
    const c = byKey.get(k);
    if (c === undefined || c.repo !== p.repo) throw new Error(`first-sample read ${k} is not in the corpus as before`);
    out[k] = { v2: { unreferenced: c.unreferenced, reason: c.reason }, repo: c.repo };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Run

export async function runSample(opts) {
  const corpus = await collectCorpus(opts);
  const pool = opts.select ? opts.select(corpus.candidates) : corpus.candidates;
  const sample = drawSample(pool, opts.target ?? DEFAULT_TARGET, opts.seed ?? SEED);
  const packets = path.join(opts.outDir, opts.packetsName ?? 'packets');
  const predictionOf = opts.predictionOf ?? ((c) => ({ unreferenced: c.unreferenced, reason: c.reason, tool: c.tool, repo: c.repo }));
  await rm(packets, { recursive: true, force: true });
  await mkdir(packets, { recursive: true });
  const user = opts.user ?? path.posix.basename(norm(opts.home));
  const predictions = {};
  const strata = {};
  for (const c of sample) {
    const data = corpus.data.get(c.sessionHash);
    const ctx = { root: data.root, home: opts.home, user, deny: opts.deny };
    await writeFile(path.join(packets, `${c.sessionHash}-${c.readOrdinal}.md`), renderPacket(data, c, ctx));
    predictions[keyOf(c)] = predictionOf(c);
    const k = `${c.tool}/${c.unreferenced ? 'unreferenced' : 'referenced'}`;
    strata[k] = (strata[k] ?? 0) + 1;
  }
  const available = {};
  for (const c of corpus.candidates) {
    const k = `${c.tool}/${c.unreferenced ? 'unreferenced' : 'referenced'}`;
    available[k] = (available[k] ?? 0) + 1;
  }
  const doc = {
    seed: opts.seed ?? SEED,
    target: opts.target ?? DEFAULT_TARGET,
    perSessionCap: PER_SESSION_CAP,
    corpus: {
      sessions: corpus.sessions,
      refusedSessions: corpus.refusedSessions,
      reads: corpus.totalReads,
      readsOutsideRepo: corpus.readsOutsideRepo,
      readsDenied: corpus.readsDenied,
      candidates: corpus.candidates.length,
      byRepo: corpus.byRepo,
      byEntrypoint: corpus.byEntrypoint,
      available,
    },
    sample: { packets: sample.length, strata, byRepo: count(sample, (c) => c.repo) },
    predictions,
  };
  await writeFile(path.join(opts.outDir, opts.predictionsName ?? 'predictions.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return { packets: sample.length, strata, corpus: doc.corpus };
}

function count(list, key) {
  const o = {};
  for (const x of list) o[key(x)] = (o[key(x)] ?? 0) + 1;
  return o;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main() {
  const home = os.homedir();
  const outDir = path.resolve(arg('--out', path.join(HERE, '.work')));
  const denyFile = path.resolve(arg('--deny', path.join(outDir, 'deny.txt')));
  const deny = existsSync(denyFile) ? (await readFile(denyFile, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')) : [];
  const claudeDir = path.resolve(arg('--claude-dir', path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects')));
  const codexDir = path.resolve(arg('--codex-dir', path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions')));
  const allowlist = await loadAllowlist(path.join(HERE, 'allowlist.json'));
  if (process.argv.includes('--dev')) {
    // Spec 11.6: the current heuristic on the first sample, a development-set figure; no packets written.
    const first = JSON.parse(await readFile(path.join(outDir, 'predictions.json'), 'utf8')).predictions;
    const corpus = await collectCorpus({ claudeDir, codexDir, allowlist, home, user: os.userInfo().username, deny });
    const predictions = devPredictions(corpus.candidates, first);
    await writeFile(path.join(outDir, 'predictions-dev.json'), `${JSON.stringify({ note: 'v2 predictions for the first-sample reads (development set)', predictions }, null, 2)}\n`);
    process.stdout.write(`dev predictions ${Object.keys(predictions).length}\n`);
    return;
  }
  const target = Number(arg('--target', String(DEFAULT_TARGET)));
  const r = await runSample({ claudeDir, codexDir, allowlist, home, user: os.userInfo().username, deny, outDir, target });
  process.stdout.write(
    `sessions ${r.corpus.sessions} (refused ${r.corpus.refusedSessions}), reads ${r.corpus.reads}, candidates ${r.corpus.candidates} ` +
      `(outside repo ${r.corpus.readsOutsideRepo}, denied ${r.corpus.readsDenied}), deny markers ${deny.length}\n` +
      `packets ${r.packets}: ${Object.entries(r.strata).map(([k, v]) => `${k} ${v}`).join(', ')}\n` +
      `written to ${path.relative(process.cwd(), path.join(outDir, 'packets')) || '.'}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
