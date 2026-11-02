// Terminal output (spec section 8). Every log-derived string goes through sanitizeTerminal; estimated
// numbers carry a leading ≈, lower-bound costs a leading ≥.

import pc from 'picocolors';
import type { CompositionRow, Report, SessionRow } from './types.js';
import { sanitizeTerminal } from './sanitize.js';
import { studySentence } from '../analysis/study.js';
import { REFERENCE_RULES, SPEC_6_3_URL } from './definitions.js';

export type TerminalView = 'summary' | 'sessions' | 'session' | 'prs' | 'compare';

interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  yellow: (s: string) => string;
}

const S = sanitizeTerminal;

export function usd(n: number | null): string {
  if (n === null) return 'n/a';
  const a = Math.abs(n);
  if (a >= 100) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  if (a === 0) return '$0';
  return `$${n.toFixed(4)}`;
}
const cost = (n: number, lowerBound: boolean) => `${lowerBound ? '≥ ' : ''}${usd(n)}`;
export function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
export function tokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'n/a');
const base = (p: string | null) => (p === null ? '-' : S(p.split('/').filter(Boolean).at(-1) ?? p));

function fit(s: string, max: number): string {
  if (max < 4 || s.length <= max) return s;
  return `...${s.slice(s.length - max + 3)}`;
}

/** Shortens `s` to `max` characters by cutting the middle, so both ends of a key stay readable. */
export function middle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/** The shortest a group key is ever shown in the compare table. */
const MIN_KEY = 20;

/** Width of the label column of the cost block, so every value starts in one column. */
const LABEL_W = 34;
const kv = (indent: string, label: string, value: string) => `${indent}${label.padEnd(LABEL_W)}  ${value}`;

/** A plain table: the first column left-aligned and truncated to fit, the rest right-aligned. */
function table(head: string[], rows: string[][], width: number, st: Style, leftCols = 1): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const others = widths.slice(1).reduce((a, w) => a + w + 2, 0);
  widths[0] = Math.max(8, Math.min(widths[0]!, width - 2 - others));
  const line = (r: string[]) =>
    `  ${r
      .map((c, i) => (i === 0 ? fit(c, widths[0]!).padEnd(widths[0]!) : i < leftCols ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join('  ')
      .trimEnd()}`;
  return [st.dim(line(head)), ...rows.map(line)];
}

function compositionLines(rows: CompositionRow[], width: number, st: Style, limit = 8): string[] {
  if (rows.length === 0) return ['  nothing recorded'];
  return table(
    ['source', 'introduced', 'processed'],
    rows.slice(0, limit).map((r) => {
      const exact = r.source === 'assistant_output';
      return [S(r.source), `${exact ? '' : '≈ '}${tokens(r.introduced)}`, `${exact ? '' : '≈ '}${tokens(r.processed)}`];
    }),
    width,
    st,
  );
}

const FOOTER = [
  'How to read this',
  '  A read is "unreferenced" when nothing the agent did after it refers back to it through',
  ...REFERENCE_RULES.map((r) => `    - ${r}`),
  '  That includes reads used to rule something out, so unreferenced does not mean the read was',
  '  useless or the tokens were thrown away. Full rules: spec 6.3,',
  `  ${SPEC_6_3_URL}`,
  '  Numbers marked ≈ are estimates (characters / 4). Costs marked ≥ are lower bounds (see the notes).',
  ...studySentence()
    .split(/(?<=\.) /)
    .map((line) => `  ${line}`),
];

/** Ruling 4 of the 7-8 review: without --gh no PR state is known, so unmerged spend is not a number. */
function unmergedLines(t: Report['totals'], indent: string): string[] {
  return [
    t.unmergedSpend === null
      ? `${indent}unmerged spend: unknown without --gh`
      : kv(indent, 'unmerged spend', `${usd(t.unmergedSpend)} (closed-unmerged PRs and branches without a PR)`),
    kv(indent, 'spend on branches with no known PR', usd(t.noPrSpend)),
  ];
}

function summary(r: Report, width: number, st: Style): string[] {
  const t = r.totals;
  const out: string[] = [];
  out.push(st.bold(`read-receipts ${r.toolVersion}`));
  out.push(
    `  ${plural(t.sessions, 'session')} (${count(t.sessionsByAgent['claude-code'])} Claude Code, ${count(t.sessionsByAgent.codex)} Codex), ${day(t.period.from)} to ${day(t.period.to)}, ${plural(t.requests, 'request')}`,
  );
  out.push('', st.bold('Cost'));
  out.push(kv('  ', 'total', cost(t.usd, t.lowerBound)));
  for (const m of t.byModel.slice(0, 6)) out.push(kv('  ', fit(S(m.model), LABEL_W), t.unpricedModels.includes(m.model) ? 'unpriced' : usd(m.usd)));
  out.push(kv('  ', 'cache hit share', pct(t.cacheHitShare)));
  if (t.requestsMissingUsage > 0 || t.requestsUnpriced > 0) {
    const parts = [];
    if (t.requestsMissingUsage > 0) parts.push(`${plural(t.requestsMissingUsage, 'request')} without usage`);
    if (t.requestsUnpriced > 0) parts.push(`${count(t.requestsUnpriced)} unpriced (${t.unpricedModels.map(S).join(', ')})`);
    out.push(st.yellow(`  cost excludes ${parts.join(' / ')}`));
  }
  if (t.requestsUnpricedModifier > 0) out.push(st.yellow(`  cost excludes ${plural(t.requestsUnpricedModifier, 'request')} with an unpriced modifier (${t.unpricedModifiers.map(S).join(', ')})`));
  if (t.harnessUSD !== null) out.push(kv('  ', "Claude Code's own total", usd(t.harnessUSD)));
  if (t.unloggedUSD !== null && t.unloggedUSD > 0) out.push(kv('  ', 'unlogged harness calls', `${usd(t.unloggedUSD)} (compaction and similar, no transcript record)`));
  out.push(...unmergedLines(t, '  '));

  out.push('', st.bold('Context composition (top 8 sources, tokens)'));
  out.push(...compositionLines(t.estimated.composition, width, st));

  const e = t.estimated;
  out.push('', st.bold('Reads'));
  out.push(
    `  ${plural(t.readCounts.total, 'read')}, ${count(t.readCounts.unreferenced)} unreferenced (${pct(t.unreferencedReadRate)}), ≈ ${pct(e.unreferencedTokenShare)} of read tokens, ≈ ${usd(e.unreferencedCarriedUSD)} carried in cache`,
  );
  if (e.likelyUnused !== null) {
    const l = e.likelyUnused;
    out.push(
      `  likely unused ≈ ${plural(l.count, 'read')} (${count(l.low)} to ${count(l.high)}, scaled from the precision CI); estimate: unreferenced × precision ${pct(l.precision)} (95% CI ${pct(l.ci[0])} to ${pct(l.ci[1])}, ${S(l.sample)})`,
    );
  }
  if (e.topUnreferencedFiles.length > 0) {
    out.push('  top unreferenced files by tokens:');
    out.push(...table(['file', 'reads', 'tokens'], e.topUnreferencedFiles.map((f) => [S(f.path), count(f.count), `≈ ${tokens(f.estimated.tokens)}`]), width, st));
  }
  out.push('', st.bold('Re-reads'));
  out.push(
    `  ${plural(t.readCounts.rereads, 're-read')} (${pct(t.rereadRate)} of reads), ${count(t.readCounts.rereadsUnchanged)} unchanged (≈ ${tokens(e.rereadUnchangedTokens)} tokens), ${count(t.readCounts.rereadsAfterCompaction)} after a compaction`,
  );
  if (t.topRereadFiles.length > 0) out.push(...table(['file', 're-reads'], t.topRereadFiles.map((f) => [S(f.path), count(f.count)]), width, st));
  out.push('', st.bold('Compactions'));
  out.push(`  ${plural(t.compactions, 'compaction')}, compaction re-read rate ${pct(t.compactionRereadRate)}, re-attached then re-read ${count(t.reattachedThenReread)}`);
  out.push('', st.bold('Subagents'));
  out.push(`  ${plural(t.subagents, 'subagent')}, ${usd(t.subagentUSD)} (${pct(t.subagentCostShare)} of cost)`);
  if (t.topSessions.length > 0) {
    out.push('', st.bold('Top sessions by cost'));
    out.push(...table(['session', 'started', 'repo', 'cost'], t.topSessions.map((s) => [S(s.sessionId.slice(0, 8)), day(s.startedAt), base(s.repo), cost(s.usd, s.lowerBound)]), width, st, 3));
  }
  return out;
}

function sessionsView(r: Report, width: number, st: Style): string[] {
  return [
    st.bold(plural(r.sessions.length, 'session')),
    ...table(
      ['started', 'session', 'agent', 'repo', 'requests', 'cost', 'reads', 'unref tokens', 're-read'],
      r.sessions.map((s) => [
        day(s.startedAt),
        S(s.sessionId.slice(0, 8)),
        s.agent,
        base(s.repo ?? s.cwd),
        count(s.cost.requests),
        cost(s.cost.usd, s.cost.lowerBound),
        count(s.readCounts.total),
        `≈ ${pct(s.estimated.unreferencedTokenShare)}`,
        pct(s.rereadRate),
      ]),
      width,
      st,
      4,
    ),
  ];
}

function oneSession(s: SessionRow, width: number, st: Style): string[] {
  const out: string[] = [];
  out.push(st.bold(`Session ${S(s.sessionId)}`));
  out.push(`  ${s.agent} ${S(s.version ?? '')} ${S(s.entrypoint ?? '')}, ${S(s.startedAt)} to ${S(s.endedAt)}`);
  out.push(`  cwd ${S(s.cwd ?? '-')}${s.repo !== null ? `, repo ${S(s.repo)}` : ''}`);
  out.push('', st.bold('Cost'));
  out.push(`  total ${cost(s.cost.usd, s.cost.lowerBound)} over ${plural(s.cost.requests, 'request')}, cache hit share ${pct(s.cost.cacheHitShare)}`);
  if (s.cost.requestsMissingUsage > 0 || s.cost.requestsUnpriced > 0) {
    out.push(st.yellow(`  cost excludes ${plural(s.cost.requestsMissingUsage, 'request')} without usage / ${count(s.cost.requestsUnpriced)} unpriced (${s.cost.unpricedModels.map(S).join(', ')})`));
  }
  if (s.cost.requestsUnpricedModifier > 0) out.push(st.yellow(`  cost excludes ${plural(s.cost.requestsUnpricedModifier, 'request')} with an unpriced modifier (${s.cost.unpricedModifiers.map(S).join(', ')})`));
  if (s.cost.unloggedUSD !== null && s.cost.unloggedUSD > 0) out.push(`  unlogged harness calls ${usd(s.cost.unloggedUSD)} (compaction and similar, no transcript record)`);
  for (const b of s.branchSpans.slice(0, 10)) {
    out.push(`  ${S(b.ts.slice(0, 16))} ${S(b.branch ?? '(no branch)')}${b.subagent ? ' (subagent)' : ''}: ${plural(b.requests, 'request')}, ${usd(b.usd)}`);
  }
  out.push('', st.bold('Context composition (tokens)'));
  out.push(...compositionLines(s.estimated.composition, width, st, 12));
  if (s.estimated.unattributedFirst !== null) {
    const label = s.estimated.lateSources.length > 0 ? `unattributed (before first snapshot of ${s.estimated.lateSources.map(S).join(', ')})` : 'unattributed in the first request';
    out.push(`  ${label}: ≈ ${tokens(s.estimated.unattributedFirst)}`);
  }
  out.push('', st.bold('Reads'));
  out.push(
    `  ${plural(s.readCounts.total, 'read')}, ${count(s.readCounts.unreferenced)} unreferenced, ≈ ${pct(s.estimated.unreferencedTokenShare)} of read tokens; ${plural(s.readCounts.rereads, 're-read')} (${count(s.readCounts.rereadsUnchanged)} unchanged)`,
  );
  if (s.reads.length > 0) {
    out.push(
      ...table(
        ['file', 'tokens', 'referenced', 're-read'],
        s.reads.map((r) => [
          S(r.path),
          `≈ ${tokens(r.estimated.tokens)}`,
          r.referenced ? `yes (${r.reason ?? ''})` : 'no',
          r.reread === null ? '-' : `${r.reread.kind}${r.reread.afterCompaction ? ', after compaction' : ''}`,
        ]),
        width,
        st,
        4,
      ),
    );
  }
  if (s.readsOmitted > 0) out.push(st.dim(`  ${plural(s.readsOmitted, 'more read')} not shown`));
  out.push('', st.bold('Compactions'));
  out.push(
    `  ${plural(s.compactions, 'compaction')}, files read before: ${count(s.compactionRereads.readBefore)}, re-read unchanged after: ${count(s.compactionRereads.rereadUnchangedAfter)}, re-attached then re-read: ${count(s.compactionRereads.reattachedThenReread)}`,
  );
  out.push('', st.bold('Subagents'));
  if (s.subagents.length === 0) out.push('  none');
  for (const a of s.subagents) out.push(`  ${S(a.threadId)} ${S(a.agentType ?? '')}: ${usd(a.usd)}`);
  out.push('', st.bold('Harness fingerprint'));
  const f = s.fingerprint;
  out.push(`  ${f.fingerprint}: instructions ${f.instructions}, skills ${f.skills}, hooks ${f.hooks}, mcp ${f.mcp}, system prompt ${f.systemPrompt}, model ${S(f.model)}`);
  return out;
}

function prsView(r: Report, width: number, st: Style): string[] {
  const out: string[] = [st.bold('Cost per branch')];
  out.push(...table(['repo / branch', 'outcome', 'sessions', 'cost'], r.branches.map((b) => [`${base(b.repo)} ${S(b.branch)}`, b.outcome, count(b.sessions), usd(b.usd)]), width, st, 2));
  out.push('', st.bold('Cost per PR'));
  if (r.prs.length === 0) out.push('  no PRs known (use --gh to look them up)');
  else
    out.push(
      ...table(
        ['PR', 'state', 'attempts', 'no edit', 'cost', 'title'],
        r.prs.map((p) => [`${base(p.repo)}#${p.number}`, p.state, count(p.attempts), count(p.attemptsNoEdit), usd(p.usd), fit(S(p.title), 40)]),
        width,
        st,
        2,
      ),
    );
  out.push('', ...unmergedLines(r.totals, '  '));
  return out;
}

function compareView(r: Report, width: number, st: Style): string[] {
  const rows = r.compare ?? [];
  const out = [st.bold('Compare')];
  if (rows.length === 0) return [...out, '  no sessions to compare'];
  const head = ['sessions', 'median', 'p90', 'per merged PR', 'unref tokens', 're-read', 'compaction re-read', 'cache hit'];
  const cells = rows.map((c) => [
    count(c.sessions),
    c.tooFew ? 'too few' : usd(c.medianUsd),
    c.tooFew ? '' : usd(c.p90Usd),
    c.tooFew ? '' : usd(c.medianUsdPerMergedPr),
    `≈ ${pct(c.unreferencedTokenShare)}`,
    pct(c.rereadRate),
    pct(c.compactionRereadRate),
    pct(c.cacheHitShare),
  ]);
  const groups = rows.map((c) => S(c.group));
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i]!.length)));
  const others = widths.reduce((a, w) => a + w + 2, 0);
  const longest = Math.max('group'.length, ...groups.map((g) => g.length));
  const room = width - 2 - others;
  const metrics = (row: string[]) => row.map((c, i) => c.padStart(widths[i]!)).join('  ');
  if (room >= Math.min(longest, MIN_KEY)) {
    // One line per group: the key column gets what is left, never under MIN_KEY, cut in the middle if longer.
    const keyW = Math.min(longest, Math.max(room, MIN_KEY));
    const line = (key: string, row: string[]) => `  ${middle(key, keyW).padEnd(keyW)}  ${metrics(row)}`.trimEnd();
    out.push(st.dim(line('group', head)), ...rows.map((_, i) => line(groups[i]!, cells[i]!)));
  } else {
    // Too narrow for a key column: each group key gets a line of its own above its numbers.
    const keyW = Math.max(MIN_KEY, width - 2);
    out.push(st.dim(`    ${metrics(head)}`));
    rows.forEach((_, i) => out.push(`  ${middle(groups[i]!, keyW)}`, `    ${metrics(cells[i]!)}`));
  }
  if (rows.some((c) => c.tooFew)) out.push(st.dim('  too few: under 5 sessions, too few to compare; medians hidden'));
  return out;
}

export function renderTerminal(r: Report, opts: { color: boolean; width: number; view?: TerminalView }): string {
  const c = pc.createColors(opts.color);
  const st: Style = { bold: c.bold, dim: c.dim, yellow: c.yellow };
  const width = Math.max(60, opts.width);
  let lines: string[];
  switch (opts.view ?? 'summary') {
    case 'sessions':
      lines = sessionsView(r, width, st);
      break;
    case 'session':
      lines = r.sessions.flatMap((s, i) => [...(i > 0 ? [''] : []), ...oneSession(s, width, st)]);
      break;
    case 'prs':
      lines = prsView(r, width, st);
      break;
    case 'compare':
      lines = compareView(r, width, st);
      break;
    default:
      lines = summary(r, width, st);
  }
  if (r.warnings.length > 0) lines.push('', st.bold('Notes'), ...r.warnings.map((w) => st.yellow(`  ${S(w)}`)));
  if ((opts.view ?? 'summary') === 'summary' || opts.view === 'session') lines.push('', ...FOOTER.map((l, i) => (i === 0 ? st.bold(l) : st.dim(l))));
  return `${lines.join('\n')}\n`;
}
