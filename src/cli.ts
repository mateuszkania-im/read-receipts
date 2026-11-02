#!/usr/bin/env node
// read-receipts CLI (spec section 7). Exit codes: 0 success (also when no sessions are found),
// 1 runtime error, 2 usage error.

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Fingerprint } from './analysis/fingerprint.js';
import { buildReport } from './pipeline.js';
import { loadPriceTable } from './prices/table.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { sanitizeTerminal } from './report/sanitize.js';
import { loadOrCreateSalt, parseSaltHex, saltPath } from './report/salt.js';
import { shareReport } from './report/share.js';
import { renderTerminal, type TerminalView } from './report/terminal.js';
import type { ReportOptions } from './report/types.js';
import { VERSION } from './version.js';

const COMPONENTS: Array<keyof Fingerprint> = ['instructions', 'skills', 'hooks', 'mcp', 'systemPrompt', 'model', 'fingerprint'];

class UsageError extends Error {}

/** `30d`, `2w`, `12h`, or a date / ISO time; relative values count back from `now`. */
export function parseWhen(v: string, now: Date): string {
  const rel = /^(\d+)([hdw])$/.exec(v.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as 'h' | 'd' | 'w'];
    return new Date(now.getTime() - n * unit).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())) {
    const ms = Date.parse(v.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new InvalidArgumentError(`expected 30d, 2w, 12h or YYYY-MM-DD, got "${v}"`);
}

function positiveNumber(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number');
  return n;
}

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

function defaultClaudeDir(): string {
  const c = process.env.CLAUDE_CONFIG_DIR;
  return c ? path.join(c, 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

function defaultCodexDir(): string {
  const c = process.env.CODEX_HOME;
  return c ? path.join(c, 'sessions') : path.join(os.homedir(), '.codex', 'sessions');
}

interface CommonFlags {
  since: string;
  until?: string;
  project: string[];
  agent: 'claude' | 'codex' | 'all';
  claudeDir?: string;
  codexDir?: string;
  subagents: boolean;
  prices?: string;
  gh: boolean;
  json: boolean;
  html?: string;
  share: boolean;
  shareSalt?: string;
  maxLineMb: number;
  force: boolean;
}

/** The options of every report command, shown in full by `<command> --help` and one per line by the top-level help. */
const COMMON_HELP: Array<[flags: string, short: string]> = [
  ['--since <when>', 'sessions active since 30d, 2w, 12h or YYYY-MM-DD (default 30d)'],
  ['--until <when>', 'sessions started before this date'],
  ['--project <path>', 'only sessions whose cwd is inside <path> (repeatable)'],
  ['--agent <agent>', 'claude, codex or all (default all)'],
  ['--claude-dir <dir>', 'Claude Code projects dir (default ~/.claude/projects)'],
  ['--codex-dir <dir>', 'Codex sessions dir (default ~/.codex/sessions)'],
  ['--no-subagents', 'leave subagent threads out'],
  ['--prices <file.json>', 'price entries merged over the defaults'],
  ['--gh', 'look up PRs with the gh CLI (the only network use)'],
  ['--json', 'machine output to stdout (docs/json-schema.md)'],
  ['--html <file>', 'write the self-contained HTML report'],
  ['--force', 'with --html, write even when <file> is a symlink'],
  ['--share', 'redact paths, branch names, ids and text for sharing'],
  ['--share-salt <hex>', 'key for the --share labels (default: per-machine salt)'],
  ['--max-line-mb <n>', 'skip and count longer log lines (default 256)'],
];

function addCommon(cmd: Command): Command {
  return cmd
    .option('--since <when>', 'only sessions active since 30d, 2w, 12h or YYYY-MM-DD', '30d')
    .option('--until <when>', 'only sessions started before this date')
    .option('--project <path>', 'only sessions whose cwd is inside <path> (repeatable)', collect, [])
    .addOption(new Option('--agent <agent>', 'which agent logs to read').choices(['claude', 'codex', 'all']).default('all'))
    .option('--claude-dir <dir>', 'Claude Code projects dir (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)')
    .option('--codex-dir <dir>', 'Codex sessions dir (default $CODEX_HOME/sessions or ~/.codex/sessions)')
    .option('--no-subagents', 'leave subagent threads out')
    .option('--prices <file.json>', 'price table entries merged over the defaults')
    .option('--gh', 'look up PRs with the gh CLI (the only network use)', false)
    .option('--json', 'machine output to stdout (fields: docs/json-schema.md)', false)
    .option('--html <file>', 'write the self-contained HTML report to <file>')
    .option('--force', 'with --html, write even when <file> is a symlink (its target is overwritten)', false)
    .option('--share', 'redact paths, branch names, ids and text for sharing (terminal, --json and --html)', false)
    .option('--share-salt <hex>', 'key for the --share labels (default: a per-machine salt in ~/.config/read-receipts/salt)')
    .option('--max-line-mb <n>', 'skip and count longer lines', positiveNumber, 256);
}

/** The top-level help's list of report options, one line each. */
function commonHelpText(): string {
  const w = Math.max(...COMMON_HELP.map(([f]) => f.length));
  return [
    '',
    'Report options (summary, sessions, session, prs, compare; `<command> --help` for details):',
    ...COMMON_HELP.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`),
    '',
    'Run with no command for the summary. Exit codes: 0 ok, 1 runtime error, 2 usage error.',
  ].join('\n');
}

/** A short reason for a file error, without the stack or the raw errno text. */
function fileProblem(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (e instanceof SyntaxError) return `not valid JSON (${e.message})`;
  switch (code) {
    case 'ENOENT':
      return 'no such file';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'is a directory';
    case 'ELOOP':
      return 'is a symlink';
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/** Loads `--prices` up front, so a bad file is a usage error that names the flag and the file. */
async function checkedPrices(file: string | undefined): Promise<Awaited<ReturnType<typeof loadPriceTable>>> {
  try {
    return await loadPriceTable(file ?? null);
  } catch (e) {
    throw new UsageError(`--prices ${sanitizeTerminal(file ?? '')}: ${sanitizeTerminal(fileProblem(e))}`);
  }
}

/** Refuses an `--html` target that is a symlink unless `--force` (security review F13). */
async function checkHtmlTarget(file: string, force: boolean): Promise<void> {
  let st;
  try {
    st = await lstat(file);
  } catch {
    return;
  }
  if (st.isSymbolicLink() && !force) {
    throw new UsageError(`--html ${sanitizeTerminal(file)}: is a symlink; refusing to write through it (pass --force to overwrite its target)`);
  }
}

/** Writes the HTML report; without `--force` a symlink planted after the check is not followed either. */
async function writeHtml(file: string, html: string, force: boolean): Promise<void> {
  const noFollow = force ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  try {
    const fh = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o644);
    try {
      await fh.writeFile(html);
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'cannot write: no such directory' : `cannot write: ${fileProblem(e)}`;
    throw new Error(`--html ${file}: ${why}`);
  }
}

function reportOptions(f: CommonFlags, extra: Partial<ReportOptions>): ReportOptions {
  const now = new Date();
  let since: string;
  let until: string | null;
  try {
    since = parseWhen(f.since, now);
    until = f.until !== undefined ? parseWhen(f.until, now) : null;
  } catch (e) {
    throw new UsageError(`invalid date: ${(e as Error).message}`);
  }
  return {
    claudeDir: path.resolve(f.claudeDir ?? defaultClaudeDir()),
    codexDir: path.resolve(f.codexDir ?? defaultCodexDir()),
    since,
    until,
    projects: f.project.map((p) => path.resolve(p)),
    agent: f.agent,
    includeSubagents: f.subagents,
    pricesPath: f.prices ?? null,
    gh: f.gh,
    maxLineMb: f.maxLineMb,
    compare: null,
    sessionPrefix: null,
    now: now.toISOString(),
    ...extra,
  };
}

function out(s: string): void {
  process.stdout.write(s);
}

function saltOverride(f: CommonFlags): string | null {
  if (f.shareSalt === undefined) return null;
  try {
    return parseSaltHex(f.shareSalt);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** The per-machine salt; a warning when the file had to be replaced (security review F13). */
async function shareSalt(): Promise<string> {
  const { salt, warning } = await loadOrCreateSalt(saltPath(process.env, os.homedir()));
  if (warning !== null) process.stderr.write(`warning: ${sanitizeTerminal(warning)}\n`);
  return salt;
}

async function report(f: CommonFlags, view: TerminalView, extra: Partial<ReportOptions> = {}): Promise<number> {
  const opts = reportOptions(f, extra);
  const override = saltOverride(f);
  if (f.prices !== undefined) await checkedPrices(f.prices);
  if (f.html !== undefined) await checkHtmlTarget(f.html, f.force);
  const built = await buildReport(opts);
  // Spec 9.6: redaction happens once, on the aggregate, before any renderer sees it.
  const r = f.share
    ? shareReport(built, { home: os.homedir(), salt: override ?? (await shareSalt()), defaultDirs: [path.resolve(defaultClaudeDir()), path.resolve(defaultCodexDir())] })
    : built;
  if (f.html !== undefined) {
    await writeHtml(f.html, renderHtml(r), f.force);
    process.stderr.write(`HTML report written to ${sanitizeTerminal(f.html)}\n`);
  }
  if (f.json) {
    out(renderJson(r));
  } else if (r.sessions.length === 0 && view !== 'session') {
    const where = r.redacted ? `the ${r.searched.join(' and ')} log dirs` : r.searched.map(sanitizeTerminal).join(' or ');
    out(`No sessions found in ${where} since ${(opts.since ?? '').slice(0, 10)}.\n`);
  } else if (view !== 'session' || r.sessions.length > 0) {
    const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
    out(renderTerminal(r, { color, width: process.stdout.columns ?? 100, view }));
  }
  if (view === 'session' && r.sessions.length === 0) {
    process.stderr.write(`No session matches "${sanitizeTerminal(extra.sessionPrefix ?? '')}" in ${r.searched.map(sanitizeTerminal).join(' or ')}.\n`);
    return 1;
  }
  return 0;
}

export function makeProgram(setExit: (code: number) => void): Command {
  const program = new Command('read-receipts')
    .description('Read receipts for your coding agent: what it read, what it never referred to again, and what each session, branch and PR cost.')
    .version(VERSION, '-V, --version')
    .showHelpAfterError()
    .addHelpText('after', commonHelpText())
    .exitOverride();
  const run = (fn: () => Promise<number>) => async () => setExit(await fn());

  addCommon(program.command('summary', { isDefault: true }).description('overall summary (default command)')).action(function (this: Command) {
    return run(() => report(this.opts<CommonFlags>(), 'summary'))();
  });
  addCommon(program.command('sessions').description('one row per session')).action(function (this: Command) {
    return run(() => report(this.opts<CommonFlags>(), 'sessions'))();
  });
  addCommon(program.command('session').argument('<id-prefix>', 'session id or its first characters').description('one session in detail')).action(
    function (this: Command, prefix: string) {
      return run(() => report(this.opts<CommonFlags>(), 'session', { sessionPrefix: prefix }))();
    },
  );
  addCommon(program.command('prs').description('cost per branch and PR with outcomes')).action(function (this: Command) {
    return run(() => report(this.opts<CommonFlags>(), 'prs'))();
  });
  addCommon(
    program
      .command('compare')
      .description('compare sessions by harness component or date')
      .addOption(new Option('--by <component>', 'group by this fingerprint component').choices(COMPONENTS).default('fingerprint'))
      .addOption(new Option('--outcome <outcome>', 'only sessions in this PR state').choices(['merged', 'any']).default('any'))
      .option('--split-at <date>', 'group into before and after this date instead'),
  ).action(function (this: Command) {
    const f = this.opts<CommonFlags & { by: keyof Fingerprint; outcome: 'merged' | 'any'; splitAt?: string }>();
    return run(async () => {
      // Review 7-8, ruling 5: merged PRs are only known through gh.
      if (f.outcome === 'merged' && !f.gh) throw new UsageError('--outcome merged needs --gh: without it no PR state is looked up, so no session counts as merged.');
      let splitAt: string | null = null;
      if (f.splitAt !== undefined) {
        try {
          splitAt = parseWhen(f.splitAt, new Date());
        } catch (e) {
          throw new UsageError(`invalid --split-at: ${(e as Error).message}`);
        }
      }
      return report(f, 'compare', { compare: { by: splitAt !== null ? null : f.by, splitAt, outcome: f.outcome } });
    })();
  });
  program
    .command('prices')
    .description('effective price table and its sources')
    .option('--prices <file.json>', 'price table entries merged over the defaults')
    .option('--json', 'machine output to stdout', false)
    .action(function (this: Command) {
      const f = this.opts<{ prices?: string; json: boolean }>();
      return run(async () => {
        const t = await checkedPrices(f.prices);
        const rows = [...t].map(([model, p]) => ({ model, ...p }));
        if (f.json) {
          out(`${JSON.stringify(rows, null, 2)}\n`);
          return 0;
        }
        out('USD per million tokens\n');
        out(`  ${'model'.padEnd(22)} ${'input'.padStart(8)} ${'output'.padStart(8)} ${'cache rd'.padStart(9)} ${'write 5m'.padStart(9)} ${'write 1h'.padStart(9)}  retrieved   source\n`);
        for (const r of rows) {
          const n = (x: number) => String(x).padStart(8);
          out(
            `  ${sanitizeTerminal(r.model).padEnd(22)} ${n(r.input)} ${n(r.output)} ${n(r.cacheRead).padStart(9)} ${n(r.cacheWrite5m).padStart(9)} ${n(r.cacheWrite1h).padStart(9)}  ${sanitizeTerminal(r.retrieved).padEnd(10)}  ${sanitizeTerminal(r.source)}\n`,
          );
        }
        return 0;
      })();
    });
  for (const c of program.commands) c.exitOverride().showHelpAfterError();
  return program;
}

export async function main(argv: string[]): Promise<number> {
  let code = 0;
  const program = makeProgram((c) => {
    code = c;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return 0;
      return 2;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`read-receipts: ${sanitizeTerminal(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
