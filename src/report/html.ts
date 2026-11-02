// `--html` (spec section 8): one self-contained file. No external requests (enforced by the CSP meta),
// every log-derived string goes through escapeHtml, charts are inline SVG drawn to scale, and the report
// is embedded as JSON with `<`, `>`, `&`, U+2028 and U+2029 escaped. The inline script only sorts tables.

import type { BranchRow, PrRow } from '../attribution/attribute.js';
import type { CompositionRow, Report, SessionRow } from './types.js';
import { CSP, CSS, SCRIPT } from './html-template.js';
import { studySentence } from '../analysis/study.js';
import { pct, tokens } from './terminal.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Characters that reorder or hide text (security review F9): C0 controls other than tab and line breaks,
 * DEL and C1, the bidi marks, embeddings, overrides and isolates, and the Unicode line and paragraph
 * separators. Removed from displayed text and escaped in the embedded JSON.
 */
// oxlint-disable-next-line no-control-regex
const INVISIBLE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]', 'g');

/** Escapes text for HTML element content and quoted attribute values, without control or bidi characters. */
export function escapeHtml(s: string): string {
  return s.replace(INVISIBLE, '').replace(/[&<>"']/g, (c) => ESC[c]!);
}
const e = escapeHtml;

/** JSON for a `<script type="application/json">` block: nothing in it can end the element or reorder text. */
export function embedJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Dollars for the page: cents are enough to read, sub-cent amounts show as < $0.01. */
export function usd(n: number | null): string {
  if (n === null) return 'n/a';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 0.005) return n < 0 ? '> -$0.01' : '< $0.01';
  if (a >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const count = (n: number) => n.toLocaleString('en-US');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'n/a');
const cost = (n: number, lowerBound: boolean) => `${lowerBound ? '≥ ' : ''}${usd(n)}`;
const approxTokens = (n: number) => `≈ ${tokens(n)}`;
/** A number for an attribute: finite and plain. */
const num = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0');
const baseName = (p: string | null) => (p === null ? '-' : (p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p));

const SECTIONS = [
  ['summary', 'Summary'],
  ['money', 'Where the money went'],
  ['prs', 'Cost per PR and branch'],
  ['composition', 'Context composition'],
  ['unreferenced', 'Unreferenced reads'],
  ['rereads', 'Re-reads and compactions'],
  ['subagents', 'Subagents'],
  ['harness', 'Harness fingerprints and compare'],
  ['method', 'Method and limits'],
] as const;
type SectionId = (typeof SECTIONS)[number][0];

function section(id: SectionId, lede: string, body: string): string {
  const i = SECTIONS.findIndex(([s]) => s === id);
  const title = SECTIONS[i]![1];
  return `<section id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h"><span class="num">${String(i + 1).padStart(2, '0')}</span>${title}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}${body}</section>`;
}

function tile(k: string, v: string, s: string, extra = '', cls = ''): string {
  return `<div class="tile${cls ? ` ${cls}` : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>${extra}</div>`;
}

/** A share in [0, 1] as a thin meter, to scale. */
function meter(share: number | null, slot: string): string {
  const w = share === null ? 0 : Math.max(0, Math.min(1, share)) * 100;
  return `<svg class="meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" x="0" y="0" width="100" height="6"/><rect class="bar ${slot}" x="0" y="0" width="${num(w)}" height="6"/></svg>`;
}

interface BarItem {
  label: string;
  note?: string;
  value: number;
  text: string;
}

/** Horizontal bars, one per row, all on one scale (the largest value fills the track). */
function bars(items: BarItem[], slot: string, empty: string): string {
  if (items.length === 0) return `<p class="empty">${empty}</p>`;
  const max = Math.max(...items.map((i) => i.value), 0);
  const rows = items.map((i) => {
    const w = max > 0 ? (Math.max(0, i.value) / max) * 100 : 0;
    return `<li><span class="bl">${e(i.label)}${i.note ? `<small>${e(i.note)}</small>` : ''}</span><svg viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="${e(`${i.label}: ${i.text}`)}"><title>${e(`${i.label}: ${i.text}`)}</title><rect class="track" x="0" y="0" width="100" height="14"/><rect class="bar ${slot}" x="0" y="0" height="14" width="${num(w)}"/></svg><span class="bv">${e(i.text)}</span></li>`;
  });
  return `<ol class="bars">${rows.join('')}</ol>`;
}

interface Col<T> {
  head: string;
  cell: (row: T) => string;
  /** Numeric sort key; marks the column as numeric (right-aligned). */
  v?: (row: T) => number;
  cls?: string;
}

function table<T>(cols: Col<T>[], rows: T[], cls = '', empty = 'Nothing recorded.'): string {
  if (rows.length === 0) return `<p class="empty">${empty}</p>`;
  const head = cols.map((c) => `<th scope="col"${c.v ? ' class="n"' : ''}>${c.head}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${cols
          .map((c) => {
            const classes = [c.v ? 'n' : '', c.cls ?? ''].filter(Boolean).join(' ');
            return `<td${classes ? ` class="${classes}"` : ''}${c.v ? ` data-v="${num(c.v(r))}"` : ''}>${c.cell(r)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table class="sortable${cls ? ` ${cls}` : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const SOURCE_LABELS: Record<string, string> = {
  system_prompt: 'System prompt',
  tool_schemas: 'Tool schemas',
  mcp_tool_schemas: 'MCP tool schemas',
  instructions: 'Instruction files',
  skills_listing: 'Skills listing',
  skill_body: 'Skill bodies',
  hook: 'Hook output',
  reattached_file: 'Re-attached files',
  compaction_summary: 'Compaction summaries',
  user_prompt: 'User prompts',
  assistant_output: 'Assistant output',
  other: 'Other injections',
};

function sourceLabel(source: string): string {
  const known = SOURCE_LABELS[source];
  if (known !== undefined) return known;
  if (source.startsWith('tool_result:')) {
    const tool = source.slice('tool_result:'.length);
    return `${tool.charAt(0).toUpperCase()}${tool.slice(1)} results`;
  }
  if (source.startsWith('mcp:')) return `MCP ${source.slice('mcp:'.length)} results`;
  return source;
}

const SLOTS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
const MAX_SEGMENTS = 7;

function compositionSection(rows: CompositionRow[]): string {
  const live = rows.filter((r) => r.introduced > 0 || r.processed > 0);
  if (live.length === 0) return `<p class="empty">No context recorded.</p>`;
  const top = live.slice(0, MAX_SEGMENTS);
  const rest = live.slice(MAX_SEGMENTS);
  const segs = top.map((r, i) => ({ label: sourceLabel(r.source), key: r.source, introduced: r.introduced, processed: r.processed, slot: SLOTS[i]!, exact: r.source === 'assistant_output' }));
  if (rest.length > 0) {
    segs.push({
      label: `${rest.length} more sources`,
      key: rest.map((r) => r.source).join(', '),
      introduced: rest.reduce((a, r) => a + r.introduced, 0),
      processed: rest.reduce((a, r) => a + r.processed, 0),
      slot: 'so',
      exact: false,
    });
  }
  const stack = (label: string, pick: (s: (typeof segs)[number]) => number) => {
    const total = segs.reduce((a, s) => a + pick(s), 0);
    let x = 0;
    const rects = segs
      .map((s) => {
        const w = total > 0 ? (pick(s) / total) * 1000 : 0;
        const r = `<rect class="bar ${s.slot}" x="${num(x)}" y="0" height="26" width="${num(w)}"><title>${e(`${s.label}: ${pct(total > 0 ? pick(s) / total : null)}`)}</title></rect>`;
        x += w;
        return w > 0 ? r : '';
      })
      .join('');
    return `<div class="stack-row"><span class="lab">${label}</span><svg class="stack" viewBox="0 0 1000 26" preserveAspectRatio="none" role="img" aria-label="${label} tokens by source">${rects}</svg></div>`;
  };
  const totalProcessed = segs.reduce((a, s) => a + s.processed, 0);
  const totalIntroduced = segs.reduce((a, s) => a + s.introduced, 0);
  const legend = table(
    [
      { head: 'Source', cell: (s) => `<span class="sw ${s.slot}"></span>${e(s.label)}` },
      { head: 'Introduced', cell: (s) => (s.exact ? tokens(s.introduced) : approxTokens(s.introduced)), v: (s) => s.introduced },
      { head: 'Share', cell: (s) => pct(totalIntroduced > 0 ? s.introduced / totalIntroduced : null), v: (s) => s.introduced },
      { head: 'Processed', cell: (s) => (s.exact ? tokens(s.processed) : approxTokens(s.processed)), v: (s) => s.processed },
      { head: 'Share', cell: (s) => pct(totalProcessed > 0 ? s.processed / totalProcessed : null), v: (s) => s.processed },
    ],
    segs,
  );
  return `${stack('Introduced', (s) => s.introduced)}${stack('Processed', (s) => s.processed)}<h3>Sources</h3>${legend}`;
}

function branchLabel(b: BranchRow): string {
  return `${baseName(b.repo)} / ${b.branch}`;
}
const OUTCOME: Record<BranchRow['outcome'], string> = { default: 'default branch', noPr: 'no PR found', pr: 'PR', noRepo: 'no repo', detached: 'detached HEAD', worktreeGone: 'unattributed (worktree gone)' };
const unmergedText = (t: Report['totals']) => (t.unmergedSpend === null ? 'unknown without --gh' : usd(t.unmergedSpend));
const PR_STATE: Record<PrRow['state'], string> = { merged: 'merged', open: 'open', closedUnmerged: 'closed, not merged', unknown: 'not looked up' };

function summarySection(r: Report): string {
  const t = r.totals;
  const x = t.estimated;
  const models = t.byModel.length;
  const unpricedCount = t.requestsUnpriced + t.requestsMissingUsage + t.requestsUnpricedModifier;
  const unpricedParts: string[] = [];
  if (t.requestsUnpriced > 0) unpricedParts.push(`${count(t.requestsUnpriced)} with no price: ${t.unpricedModels.map(e).join(', ')}`);
  if (t.requestsMissingUsage > 0) unpricedParts.push(`${count(t.requestsMissingUsage)} without usage`);
  if (t.requestsUnpricedModifier > 0) unpricedParts.push(`${count(t.requestsUnpricedModifier)} with an unpriced modifier: ${t.unpricedModifiers.map(e).join(', ')}`);
  const tiles = [
    tile('Total cost', e(cost(t.usd, t.lowerBound)), `${count(t.requests)} requests, ${count(models)} ${models === 1 ? 'model' : 'models'}${t.lowerBound ? ', a lower bound' : ''}`),
    tile('Cache hit share', e(pct(t.cacheHitShare)), 'of prompt tokens were read from cache', meter(t.cacheHitShare, 's1')),
    tile(
      'Unreferenced reads',
      e(`≈ ${pct(x.unreferencedTokenShare)}`),
      `of read tokens; ${count(t.readCounts.unreferenced)} of ${count(t.readCounts.total)} reads, ≈ ${e(usd(x.unreferencedCarriedUSD))} carried in cache`,
      meter(x.unreferencedTokenShare, 's2'),
    ),
    `<div class="tile def"><div class="def-title">Unreferenced is not useless</div><p>${e(r.definitions.unreferenced.replace(/ Full rules: spec 6\.3, \S+$/, ' Full rules: spec 6.3, linked under Method and limits.'))}</p></div>`,
    tile('Re-read rate', e(pct(t.rereadRate)), `${count(t.readCounts.rereads)} re-reads, ${count(t.readCounts.rereadsUnchanged)} unchanged, ${count(t.readCounts.rereadsAfterCompaction)} after a compaction`, meter(t.rereadRate, 's3')),
    unpricedCount > 0
      ? tile('Unpriced', `${count(unpricedCount)}`, `requests left out of the cost: ${unpricedParts.join('; ')}`, '', 'alert')
      : tile('Unpriced', '0', 'every request had usage and a price'),
  ];
  return section('summary', '', `<div class="tiles">${tiles.join('')}</div>`);
}

function moneySection(r: Report): string {
  const t = r.totals;
  const facts = [
    ['Subagents', `${usd(t.subagentUSD)} (${pct(t.subagentCostShare)})`],
    ['Unmerged spend', unmergedText(t)],
    ['Branches with no known PR', usd(t.noPrSpend)],
    ...(t.harnessUSD !== null ? [["Claude Code's own total", usd(t.harnessUSD)]] : []),
    ...(t.unloggedUSD !== null && t.unloggedUSD > 0 ? [['Calls without a transcript record', usd(t.unloggedUSD)]] : []),
  ];
  const byModel = bars(
    t.byModel.map((m) => ({ label: m.model, value: m.usd, text: t.unpricedModels.includes(m.model) && m.usd === 0 ? 'unpriced' : usd(m.usd) })),
    's1',
    'No priced requests.',
  );
  const top = table(
    [
      { head: 'Session', cell: (s) => `<code>${e(s.sessionId.slice(0, 8))}</code>` },
      { head: 'Started', cell: (s) => e(day(s.startedAt)), cls: 'mono' },
      { head: 'Repo', cell: (s) => e(baseName(s.repo)), cls: 'nowrap' },
      { head: 'Cost', cell: (s) => e(cost(s.usd, s.lowerBound)), v: (s) => s.usd },
    ],
    t.topSessions,
  );
  return section(
    'money',
    'Cache-adjusted cost from the logged usage and the price table. Costs marked ≥ are lower bounds.',
    `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${e(k!)}</div><div class="v">${e(v!)}</div></div>`).join('')}</div><div class="split"><div><h3>By model</h3>${byModel}</div><div><h3>Top sessions</h3>${top}</div></div>`,
  );
}

function prsSection(r: Report): string {
  const branches = bars(
    r.branches.slice(0, 12).map((b) => ({ label: branchLabel(b), note: `${OUTCOME[b.outcome]}, ${count(b.sessions)} ${b.sessions === 1 ? 'session' : 'sessions'}`, value: b.usd, text: usd(b.usd) })),
    's1',
    'No branch data.',
  );
  const more = r.branches.length > 12 ? `<p class="empty">${count(r.branches.length - 12)} more branches in the embedded JSON.</p>` : '';
  const prs = table(
    [
      { head: 'PR', cell: (p) => `${e(baseName(p.repo))}#${count(p.number)}`, cls: 'mono' },
      { head: 'State', cell: (p) => `<span class="chip ${p.state}">${PR_STATE[p.state]}</span>`, cls: 'nowrap' },
      { head: 'Attempts', cell: (p) => count(p.attempts), v: (p) => p.attempts },
      { head: 'No edit', cell: (p) => count(p.attemptsNoEdit), v: (p) => p.attemptsNoEdit },
      { head: 'Cost', cell: (p) => e(usd(p.usd)), v: (p) => p.usd },
      { head: 'Title', cell: (p) => e(p.title), cls: 'wide' },
    ],
    r.prs,
    '',
    'No PRs known. Run with --gh to look them up.',
  );
  return section(
    'prs',
    `Cost is attributed per request span, so a session that switched branch is split. Unmerged spend (closed-unmerged PRs and branches without a PR): ${e(unmergedText(r.totals))}. Sessions outside a repo, on a detached HEAD or in a removed worktree are kept apart and never count as unmerged.`,
    `<h3>Cost per branch</h3>${branches}${more}<h3>Cost per PR</h3>${prs}`,
  );
}

function unreferencedSection(r: Report): string {
  const t = r.totals;
  const x = t.estimated;
  const facts = [
    ['Reads', count(t.readCounts.total)],
    ['Unreferenced', `${count(t.readCounts.unreferenced)} (${pct(t.unreferencedReadRate)})`],
    ['Share of read tokens', `≈ ${pct(x.unreferencedTokenShare)}`],
    ['Carried in cache', `≈ ${usd(x.unreferencedCarriedUSD)}`],
    ...(x.likelyUnused === null
      ? []
      : [
          [
            'Likely unused (estimate)',
            `≈ ${count(x.likelyUnused.count)} ${x.likelyUnused.count === 1 ? 'read' : 'reads'} (${count(x.likelyUnused.low)} to ${count(x.likelyUnused.high)}, scaled from the precision CI): unreferenced × precision ${pct(x.likelyUnused.precision)}, 95% CI ${pct(x.likelyUnused.ci[0])} to ${pct(x.likelyUnused.ci[1])}, ${x.likelyUnused.sample}`,
          ],
        ]),
  ];
  const files = bars(
    x.topUnreferencedFiles.map((f) => ({ label: f.path, note: `${count(f.count)} ${f.count === 1 ? 'read' : 'reads'}`, value: f.estimated.tokens, text: approxTokens(f.estimated.tokens) })),
    's2',
    'No unreferenced reads.',
  );
  return section(
    'unreferenced',
    e(r.definitions.unreferenced),
    `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${e(k!)}</div><div class="v">${e(v!)}</div></div>`).join('')}</div><h3>Top unreferenced files by tokens</h3>${files}`,
  );
}

function rereadsSection(r: Report): string {
  const t = r.totals;
  const facts = [
    ['Re-reads', `${count(t.readCounts.rereads)} (${pct(t.rereadRate)})`],
    ['Unchanged', count(t.readCounts.rereadsUnchanged)],
    ['Unchanged, tokens', `≈ ${tokens(t.estimated.rereadUnchangedTokens)}`],
    ['After a compaction', count(t.readCounts.rereadsAfterCompaction)],
    ['Compactions', count(t.compactions)],
    ['Compaction re-read rate', pct(t.compactionRereadRate)],
    ['Re-attached, then re-read', count(t.reattachedThenReread)],
  ];
  const files = bars(
    t.topRereadFiles.map((f) => ({ label: f.path, value: f.count, text: `${count(f.count)}×` })),
    's3',
    'No re-reads.',
  );
  return section(
    'rereads',
    'A re-read is a read of a file the same thread had already read. The compaction re-read rate is the share of files read before a compaction that were read again, unchanged, after it: the agent needed something it had already seen.',
    `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${e(k!)}</div><div class="v">${e(v!)}</div></div>`).join('')}</div><h3>Most re-read files</h3>${files}`,
  );
}

function subagentsSection(r: Report): string {
  const t = r.totals;
  const byType = new Map<string, { n: number; usd: number }>();
  for (const s of r.sessions) {
    for (const a of s.subagents) {
      const k = a.agentType ?? '(unknown type)';
      const b = byType.get(k) ?? { n: 0, usd: 0 };
      b.n++;
      b.usd += a.usd;
      byType.set(k, b);
    }
  }
  const rows = [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.usd - a.usd);
  const tbl = table(
    [
      { head: 'Type', cell: (x) => e(x.type) },
      { head: 'Runs', cell: (x) => count(x.n), v: (x) => x.n },
      { head: 'Cost', cell: (x) => e(usd(x.usd)), v: (x) => x.usd },
      { head: 'Share of total', cell: (x) => pct(t.usd > 0 ? x.usd / t.usd : null), v: (x) => x.usd },
    ],
    rows,
    '',
    'No subagents.',
  );
  return section('subagents', `${count(t.subagents)} ${t.subagents === 1 ? 'subagent' : 'subagents'}, ${e(usd(t.subagentUSD))}, ${pct(t.subagentCostShare)} of the total cost.`, tbl);
}

function harnessSection(r: Report): string {
  const groups = new Map<string, { f: SessionRow['fingerprint']; n: number; usd: number; lowerBound: boolean }>();
  for (const s of r.sessions) {
    const g = groups.get(s.fingerprint.fingerprint) ?? { f: s.fingerprint, n: 0, usd: 0, lowerBound: false };
    g.n++;
    g.usd += s.cost.usd;
    g.lowerBound ||= s.cost.lowerBound;
    groups.set(s.fingerprint.fingerprint, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n || b.usd - a.usd);
  const fp = table(
    [
      { head: 'Fingerprint', cell: (g) => `<code>${e(g.f.fingerprint)}</code>` },
      { head: 'Model', cell: (g) => e(g.f.model), cls: 'nowrap' },
      { head: 'Instructions', cell: (g) => `<code>${e(g.f.instructions)}</code>` },
      { head: 'Skills', cell: (g) => `<code>${e(g.f.skills)}</code>` },
      { head: 'Hooks', cell: (g) => `<code>${e(g.f.hooks)}</code>` },
      { head: 'MCP', cell: (g) => `<code>${e(g.f.mcp)}</code>` },
      { head: 'Sessions', cell: (g) => count(g.n), v: (g) => g.n },
      { head: 'Cost', cell: (g) => e(cost(g.usd, g.lowerBound)), v: (g) => g.usd },
    ],
    rows.slice(0, 15),
    '',
    'No sessions.',
  );
  let cmp = '';
  if (r.compare !== null) {
    const o = r.options.compare;
    const by = o === null ? '' : o.splitAt !== null ? `before and after ${day(o.splitAt)}` : `by ${o.by ?? 'fingerprint'}`;
    cmp = `<h3>Compare ${e(by)}${o !== null && o.outcome === 'merged' ? ', merged PRs only' : ''}</h3>${table(
      [
        { head: 'Group', cell: (c) => `<code>${e(c.group)}</code>` },
        { head: 'Sessions', cell: (c) => count(c.sessions), v: (c) => c.sessions },
        { head: 'Median', cell: (c) => (c.tooFew ? 'too few' : e(usd(c.medianUsd))), v: (c) => c.medianUsd ?? 0 },
        { head: 'p90', cell: (c) => (c.tooFew ? '' : e(usd(c.p90Usd))), v: (c) => c.p90Usd ?? 0 },
        { head: 'Per merged PR', cell: (c) => (c.tooFew ? '' : e(usd(c.medianUsdPerMergedPr))), v: (c) => c.medianUsdPerMergedPr ?? 0 },
        { head: 'Unref. tokens', cell: (c) => `≈ ${pct(c.unreferencedTokenShare)}`, v: (c) => c.unreferencedTokenShare ?? 0 },
        { head: 'Re-read', cell: (c) => pct(c.rereadRate), v: (c) => c.rereadRate ?? 0 },
        { head: 'Compaction re-read', cell: (c) => pct(c.compactionRereadRate), v: (c) => c.compactionRereadRate ?? 0 },
        { head: 'Cache hit', cell: (c) => pct(c.cacheHitShare), v: (c) => c.cacheHitShare ?? 0 },
      ],
      r.compare,
      'compare',
      'No sessions to compare.',
    )}${r.compare.some((c) => c.tooFew) ? '<p class="empty">Too few: under 5 sessions, so medians are hidden.</p>' : ''}`;
  }
  return section(
    'harness',
    'Each session gets a fingerprint of its harness: instruction files, skills, hooks, MCP servers, system prompt and model, each hashed. Sessions with the same fingerprint ran under the same setup.',
    `${fp}${cmp}`,
  );
}

function methodSection(r: Report): string {
  const f = r.totals.files;
  const defs = [
    ['Unreferenced', e(r.definitions.unreferenced)],
    ['Referenced', e(r.definitions.referenced)],
    ['≈', 'An estimate: tokens counted as characters / 4. Assistant output tokens are exact.'],
    ['≥', 'A lower bound: some requests had no usage or no price and are left out.'],
    ['Precision and miss rate', e(studySentence())],
    ['Data read', `${count(f.lines)} lines; ${count(f.badLines)} unreadable, ${count(f.skippedRecords)} records skipped, ${count(f.longLines)} over the line limit, ${count(f.deepValues)} values nested too deep.`],
  ];
  const notes = r.warnings.length > 0 ? `<h3>Notes</h3><ul class="notes">${r.warnings.map((w) => `<li>${e(w)}</li>`).join('')}</ul>` : '';
  return section('method', '', `<dl class="defs">${defs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${notes}`);
}

export function renderHtml(r: Report): string {
  const t = r.totals;
  const agents = `${count(t.sessionsByAgent['claude-code'])} Claude Code, ${count(t.sessionsByAgent.codex)} Codex`;
  const meta = `${e(day(t.period.from))} to ${e(day(t.period.to))} · ${count(t.sessions)} ${t.sessions === 1 ? 'session' : 'sessions'} (${agents}) · ${count(t.requests)} requests · generated ${e(day(r.generatedAt))}`;
  const toc = SECTIONS.map(([id, title], i) => `<a href="#${id}"><span class="num">${String(i + 1).padStart(2, '0')}</span>${title}</a>`).join('');
  const body = [
    summarySection(r),
    moneySection(r),
    prsSection(r),
    section('composition', 'What filled the context. Introduced counts each piece once; processed counts it again for every request that re-sent it, which is what the cache bills.', compositionSection(t.estimated.composition)),
    unreferencedSection(r),
    rereadsSection(r),
    subagentsSection(r),
    harnessSection(r),
    methodSection(r),
  ].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>read-receipts report</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
<header class="masthead">
<div class="brand">read-receipts <span class="ver">${e(r.toolVersion)}</span>${r.redacted ? '<span class="badge">Redacted for sharing</span>' : ''}</div>
<h1>Coding agent session report</h1>
<p class="meta">${meta}</p>
</header>
<nav class="toc" aria-label="Sections">${toc}</nav>
${body}
<footer>Generated locally by read-receipts ${e(r.toolVersion)}. This file makes no network requests. The report data is embedded below as JSON.</footer>
</main>
<script type="application/json" id="report-data">${embedJson(r)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
