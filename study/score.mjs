#!/usr/bin/env node
// Validation study, scoring (spec section 11.4): joins the labeller's study/labels.jsonl with the read
// metric's outcome per read (study/.work/predictions.json). Positive class: unreferenced (metric) and
// unused (label). Precision = TP / (TP + FP), recall = TP / (TP + FN), `unclear` labels excluded and
// counted, 95% Wilson intervals.
//
//   node study/score.mjs [--labels study/labels.jsonl] [--predictions study/.work/predictions.json]
//   node study/score.mjs --write
//   node study/score.mjs --check
//
// Prints the result as JSON. With --write it scores the three sets of spec 11.6 (first sample against v1,
// first sample against v2 as a development figure, held-out referenced reads against v2), saves the counts
// to study/results.json and fills the generated blocks of docs/STUDY.md and README.md. The aggregate block
// comes from study/aggregate.json (totals only, written by study/aggregate.mjs).
// --check needs no predictions (they stay local): it re-renders the blocks from study/results.json and
// study/aggregate.json and exits 1 when README.md or docs/STUDY.md is out of date (CI runs it).
//
// Recall is never published: the first sample took every unreferenced read but only a subsample of the
// referenced ones, so TP / (TP + FN) on it overstates recall, and estimating it needs reweighting by the
// sampling fractions. What is published for the referenced class is its miss rate on the held-out sample:
// unused / (used + unused) among reads the heuristic calls referenced.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LABEL_FIELDS = ['label', 'path', 'readOrdinal', 'reason', 'repo', 'sessionHash'];
export const LABELS = ['used', 'unused', 'unclear'];
/** The public repos of the study corpus (study/allowlist.json). */
export const REPOS = ['why-diff', 'doc-router', 'recipe-units-agent', 'agent-ledger'];
const Z95 = 1.959963984540054;

/** 95% Wilson score interval for k successes out of n; [0, 1] when n is 0. */
export function wilson(k, n, z = Z95) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Problems with one labels.jsonl record (empty when it is well-formed). Labels never hold file content. */
export function validateLabel(l) {
  const errs = [];
  if (l === null || typeof l !== 'object' || Array.isArray(l)) return ['not an object'];
  const keys = Object.keys(l).sort();
  if (keys.join(',') !== LABEL_FIELDS.join(',')) errs.push(`fields must be exactly ${LABEL_FIELDS.join(', ')} (got ${keys.join(', ')})`);
  if (typeof l.sessionHash !== 'string' || !/^[0-9a-f]{12}$/.test(l.sessionHash)) errs.push('sessionHash must be 12 lowercase hex chars');
  if (!Number.isInteger(l.readOrdinal) || l.readOrdinal < 1) errs.push('readOrdinal must be a positive integer');
  if (!REPOS.includes(l.repo)) errs.push(`repo must be one of ${REPOS.join(', ')}`);
  if (typeof l.path !== 'string' || l.path === '' || l.path.startsWith('/') || l.path.startsWith('~') || /^[A-Za-z]:/.test(l.path) || l.path.split('/').includes('..')) {
    errs.push('path must be repo-relative');
  }
  if (!LABELS.includes(l.label)) errs.push(`label must be one of ${LABELS.join(', ')}`);
  if (typeof l.reason !== 'string' || l.reason.length > 200) errs.push('reason must be a string of at most 200 chars');
  return errs;
}

export async function readLabels(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * predictions.json as a Map from `${sessionHash}:${readOrdinal}` to "the metric calls it unreferenced".
 * Entries that hold both heuristic versions (`{v1, v2}`, the held-out file) need `version`.
 */
export async function readPredictions(file, version) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  return new Map(
    Object.entries(doc.predictions).map(([k, v]) => {
      if (typeof v.unreferenced === 'boolean') return [k, v.unreferenced];
      if (version === undefined || v[version] === undefined) throw new Error(`${file}: entries hold several versions; pass the version (${Object.keys(v).join(', ')})`);
      return [k, v[version].unreferenced === true];
    }),
  );
}

/**
 * Confusion counts over labels that have a prediction. `unclear` labels are counted, not scored; labels
 * without a prediction are counted as `unmatched`. A ratio with a zero denominator is NaN.
 */
export function score(labels, predictions) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let unclear = 0;
  let unclearUnreferenced = 0;
  let unmatched = 0;
  for (const l of labels) {
    const p = predictions.get(`${l.sessionHash}:${l.readOrdinal}`);
    if (p === undefined) {
      unmatched++;
      continue;
    }
    if (l.label === 'unclear') {
      unclear++;
      if (p) unclearUnreferenced++;
      continue;
    }
    const unused = l.label === 'unused';
    if (p && unused) tp++;
    else if (p && !unused) fp++;
    else if (!p && unused) fn++;
    else tn++;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    unclear,
    unclearUnreferenced,
    unmatched,
    precision: tp + fp > 0 ? tp / (tp + fp) : Number.NaN,
    recall: tp + fn > 0 ? tp / (tp + fn) : Number.NaN,
    precisionCI: wilson(tp, tp + fp),
    recallCI: wilson(tp, tp + fn),
  };
}

/**
 * How often a read the metric calls referenced was used (spec 11.6, held-out sample): used / (used +
 * unused) over labelled reads predicted referenced, `unclear` excluded and counted, with a Wilson interval.
 */
export function referencedReliability(labels, predictions) {
  let referenced = 0;
  let used = 0;
  let unused = 0;
  let unclear = 0;
  let unmatched = 0;
  for (const l of labels) {
    const p = predictions.get(`${l.sessionHash}:${l.readOrdinal}`);
    if (p === undefined) {
      unmatched++;
      continue;
    }
    if (p) continue;
    referenced++;
    if (l.label === 'used') used++;
    else if (l.label === 'unused') unused++;
    else unclear++;
  }
  const scored = used + unused;
  return {
    referenced,
    used,
    unused,
    unclear,
    unmatched,
    share: scored > 0 ? used / scored : Number.NaN,
    ci: wilson(used, scored),
    /** The miss rate: reads called referenced that were unused. */
    missRate: scored > 0 ? unused / scored : Number.NaN,
    missCI: wilson(unused, scored),
  };
}

/** Replaces the text between `<!-- NAME:START -->` and `<!-- NAME:END -->`, keeping both markers. */
export function replaceBlock(text, name, body) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) throw new Error(`markers ${start} and ${end} not found`);
  return `${text.slice(0, i + start.length)}\n${body.trim()}\n${text.slice(j)}`;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ci = ([lo, hi]) => `95% CI ${pct(lo)} to ${pct(hi)}`;
const usd = (x) => `$${x.toFixed(2)}`;
const mix = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

const RECALL_NOTE =
  'Recall is not published. The first sample was stratified: it took every read the heuristic calls unreferenced but only a subsample of the referenced ones, so recall cannot be estimated without reweighting by those sampling fractions, and an unweighted figure would overstate it.';

/** The labelled counts among reads the current heuristic (v2) calls unreferenced, from the first sample. */
const labelledUnreferenced = (dev) => `${dev.tp + dev.fp + dev.unclearUnreferenced}: ${dev.tp} unused, ${dev.fp} used, ${dev.unclearUnreferenced} unclear`;

/** The README block between STUDY:START and STUDY:END: measured corpus numbers, then the heuristic's error rates. */
export function renderReadmeBlock(results, agg) {
  const { first, dev, heldout } = results;
  const out = [];
  if (agg) {
    const gap = agg.harnessUSD ? (agg.harnessUSD - agg.usd) / agg.harnessUSD : null;
    out.push(
      '### What we measured',
      '',
      `One developer's Claude Code sessions in ${REPOS.length} allowlisted public repos: ${agg.sessions} sessions, measured with read-receipts ${agg.toolVersion} on ${agg.runAt.slice(0, 10)}. ` +
        `Almost all are headless runs (entrypoints: ${mix(agg.entrypoints)}), mostly code-review and benchmark sessions, so this is not a picture of interactive use. No Codex sessions.`,
      '',
      '| Measure | Value |',
      '|---|---|',
      `| Sessions (requests) | ${agg.sessions} (${agg.requests}) |`,
      `| Cost computed from token usage | ${usd(agg.usd)}${agg.usdLowerBound ? ' (lower bound)' : ''} |`,
      ...(agg.harnessUSD != null
        ? [`| Claude Code's own cost record | ${usd(agg.harnessUSD)}${gap !== null ? ` (computed is ${pct(gap)} lower: harness calls without a transcript record)` : ''} |`]
        : []),
      ...(agg.cacheHitShare != null ? [`| Cache hit share of input tokens | ${pct(agg.cacheHitShare)} |`] : []),
      `| Reads unreferenced | ${agg.unreferencedReads} of ${agg.reads} (${pct(agg.unreferencedReadRate)}), ≈ ${pct(agg.unreferencedTokenShare)} of read tokens |`,
      `| Labelled reads the heuristic calls unreferenced | ${labelledUnreferenced(dev)} |`,
      `| Re-read rate | ${pct(agg.rereadRate)} (${agg.rereads} re-reads, ${agg.rereadsUnchanged} of them unchanged) |`,
      `| Compactions, subagents | ${agg.compactions}, ${agg.subagents} |`,
      '',
      'The labelled row counts reads of the first sample, which took every read then called unreferenced; it is a direct count, not an estimate.',
      '',
    );
  }
  out.push(
    '### How good the read heuristic is',
    '',
    `Reads from these sessions were labelled by an LLM reviewer with a written rubric, blind to the heuristic, as used, unused or unclear. Full method and tables: [docs/STUDY.md](docs/STUDY.md).`,
    '',
    `- **"Unreferenced" precision**, first sample, heuristic v1: ${pct(first.precision)} (${first.tp} of ${first.tp + first.fp} reads called unreferenced were unused, ${ci(first.precisionCI)}). ${first.labels} reads labelled, ${first.unclear} unclear.`,
    `- **"Referenced" miss rate**, held-out sample: ${pct(heldout.missRate)} (${heldout.unused} of ${heldout.used + heldout.unused} were unused, ${ci(heldout.missCI)}), ${heldout.unclear} unclear.`,
    `- The current heuristic (v2) adds two test-file rules that came from the first labels. On that development set its precision is ${pct(dev.precision)} (${ci(dev.precisionCI)}); that is a development set number, not a validation. The report uses the v1 figure.`,
    `- ${RECALL_NOTE}`,
    '',
    'In short: a referenced read was almost always used. Unreferenced is an upper bound on unused reads, not a count of wasted ones.',
  );
  return out.join('\n');
}

/** The scored tables of docs/STUDY.md (between SCORES:START and SCORES:END). */
export function renderStudyScores(results) {
  const { first, dev, heldout } = results;
  return [
    `#### First sample, heuristic v1 (blind)`,
    '',
    `${first.labels} reads labelled: ${first.tp + first.fn} unused, ${first.fp + first.tn} used, ${first.unclear} unclear. Positive class: unreferenced (metric) and unused (label).`,
    '',
    '| | label unused | label used | label unclear |',
    '|---|---|---|---|',
    `| metric unreferenced | ${first.tp} | ${first.fp} | ${first.unclearUnreferenced} |`,
    `| metric referenced | ${first.fn} | ${first.tn} | ${first.unclear - first.unclearUnreferenced} |`,
    '',
    `- Precision: ${pct(first.precision)} (${first.tp} of ${first.tp + first.fp}, ${ci(first.precisionCI)})`,
    `- Miss rate of "referenced" in this sample: ${first.fn} of ${first.tn + first.fn} (${pct(first.fn / (first.tn + first.fn))}, ${ci(wilson(first.fn, first.tn + first.fn))})`,
    '',
    `#### First sample, heuristic v2 (development set, not a validation)`,
    '',
    `The test-file rules of v2 were written after reading these disagreements, so this figure is a development set number and is never used as the estimate.`,
    '',
    `| | label unused | label used | label unclear |`,
    '|---|---|---|---|',
    `| metric unreferenced | ${dev.tp} | ${dev.fp} | ${dev.unclearUnreferenced} |`,
    `| metric referenced | ${dev.fn} | ${dev.tn} | ${dev.unclear - dev.unclearUnreferenced} |`,
    '',
    `- Precision: ${pct(dev.precision)} (${dev.tp} of ${dev.tp + dev.fp}, ${ci(dev.precisionCI)})`,
    '',
    `#### Held-out sample, reads both versions call referenced (blind)`,
    '',
    `${heldout.labels} reads labelled: used ${heldout.used}, unused ${heldout.unused}, unclear ${heldout.unclear}.`,
    '',
    `- Miss rate of "referenced": ${pct(heldout.missRate)} (${heldout.unused} of ${heldout.used + heldout.unused}, ${ci(heldout.missCI)})`,
    '',
    `#### Recall`,
    '',
    RECALL_NOTE,
  ].join('\n');
}

/** The corpus numbers of docs/STUDY.md (between AGGREGATE:START and AGGREGATE:END). Totals only. */
export function renderAggregate(agg, results) {
  const shares = Object.entries(agg.compositionShares)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k} ${pct(v)}`)
    .join(', ');
  return [
    `Run on ${agg.runAt.slice(0, 10)} with read-receipts ${agg.toolVersion}, \`--share\`, over the allowlisted repos only. Totals only.`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Sessions | ${agg.sessions} |`,
    `| Entrypoints | ${mix(agg.entrypoints)} |`,
    `| Requests | ${agg.requests} |`,
    `| Cost computed from token usage | ${usd(agg.usd)}${agg.usdLowerBound ? ' (lower bound)' : ''} |`,
    ...(agg.harnessUSD != null ? [`| Claude Code's own cost record (${agg.sessionsWithHarnessCost} sessions have one) | ${usd(agg.harnessUSD)}, gap ${usd(agg.unloggedUSD ?? 0)} |`] : []),
    ...(agg.cacheHitShare != null ? [`| Cache hit share of input tokens | ${pct(agg.cacheHitShare)} |`] : []),
    `| Reads | ${agg.reads} |`,
    `| Unreferenced reads | ${agg.unreferencedReads} (${pct(agg.unreferencedReadRate)}) |`,
    `| Unreferenced share of read tokens (≈) | ${pct(agg.unreferencedTokenShare)} |`,
    ...(agg.unreferencedCarriedUSD != null ? [`| Cost of carrying unreferenced reads (≈) | ${usd(agg.unreferencedCarriedUSD)} |`] : []),
    `| Labelled reads the heuristic calls unreferenced (first sample, v2) | ${labelledUnreferenced(results.dev)} |`,
    `| Re-reads | ${agg.rereads} (${pct(agg.rereadRate)}), ${agg.rereadsUnchanged} unchanged |`,
    `| Compactions | ${agg.compactions}${agg.compactionRereadRate != null ? `, re-read rate ${pct(agg.compactionRereadRate)}` : ''} |`,
    `| Subagents | ${agg.subagents}${agg.subagents > 0 ? `, ${pct(agg.subagentCostShare)} of cost` : ''} |`,
    `| Largest context sources (introduced, ≈) | ${shares} |`,
  ].join('\n');
}

/** The body between `<!-- NAME:START -->` and `<!-- NAME:END -->`, trimmed; null without markers. */
function blockOf(text, name) {
  const start = `<!-- ${name}:START -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(`<!-- ${name}:END -->`);
  return i < 0 || j < i ? null : text.slice(i + start.length, j).trim();
}

/** The generated blocks of README.md and docs/STUDY.md that do not match `results` and `agg`. */
export function staleBlocks(docs, results, agg) {
  const want = [
    ['README.md', 'STUDY', docs.readme, renderReadmeBlock(results, agg)],
    ['docs/STUDY.md', 'SCORES', docs.study, renderStudyScores(results)],
    ['docs/STUDY.md', 'AGGREGATE', docs.study, renderAggregate(agg, results)],
  ];
  return want.filter(([, name, text, body]) => blockOf(text, name) !== body.trim()).map(([file, name]) => `${file} ${name}`);
}

/** Scores the three sets of spec 11.6 from the files in study/ and study/.work/. */
export async function computeStudy(dir = HERE) {
  const work = path.join(dir, '.work');
  const firstLabels = await readLabels(path.join(dir, 'labels.jsonl'));
  const heldLabels = await readLabels(path.join(dir, 'labels-heldout.jsonl'));
  for (const [name, list] of [['labels.jsonl', firstLabels], ['labels-heldout.jsonl', heldLabels]]) {
    const bad = list.map((l, i) => [i + 1, validateLabel(l)]).filter(([, e]) => e.length > 0);
    if (bad.length > 0) throw new Error(bad.map(([line, e]) => `${name} line ${line}: ${e.join('; ')}`).join('\n'));
  }
  const first = { labels: firstLabels.length, ...score(firstLabels, await readPredictions(path.join(work, 'predictions.json'))) };
  const dev = { labels: firstLabels.length, ...score(firstLabels, await readPredictions(path.join(work, 'predictions-dev.json'), 'v2')) };
  const heldout = { labels: heldLabels.length, ...referencedReliability(heldLabels, await readPredictions(path.join(work, 'predictions-heldout.json'), 'v2')) };
  for (const [name, r] of [['first', first], ['dev', dev], ['heldout', heldout]]) if (r.unmatched > 0) throw new Error(`${name}: ${r.unmatched} labels without a prediction`);
  return { first, dev, heldout };
}

const RESULTS_FILE = path.join(HERE, 'results.json');
const AGGREGATE_FILE = path.join(HERE, 'aggregate.json');

async function readDocs(root) {
  return { readme: await readFile(path.join(root, 'README.md'), 'utf8'), study: await readFile(path.join(root, 'docs', 'STUDY.md'), 'utf8') };
}

async function writeDocs() {
  const root = path.join(HERE, '..');
  const results = await computeStudy();
  await writeFile(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
  if (!existsSync(AGGREGATE_FILE)) throw new Error('study/aggregate.json is missing; run study/aggregate.mjs first');
  const agg = JSON.parse(await readFile(AGGREGATE_FILE, 'utf8'));
  const docs = await readDocs(root);
  await writeFile(path.join(root, 'docs', 'STUDY.md'), replaceBlock(replaceBlock(docs.study, 'SCORES', renderStudyScores(results)), 'AGGREGATE', renderAggregate(agg, results)));
  await writeFile(path.join(root, 'README.md'), replaceBlock(docs.readme, 'STUDY', renderReadmeBlock(results, agg)));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function checkDocs() {
  const results = JSON.parse(await readFile(RESULTS_FILE, 'utf8'));
  const agg = JSON.parse(await readFile(AGGREGATE_FILE, 'utf8'));
  const stale = staleBlocks(await readDocs(path.join(HERE, '..')), results, agg);
  if (stale.length > 0) {
    process.stderr.write(`out of date: ${stale.join(', ')}; run node study/score.mjs --write\n`);
    process.exit(1);
  }
  process.stdout.write('study blocks are up to date\n');
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--write')) return writeDocs();
  if (process.argv.includes('--check')) return checkDocs();
  const labels = await readLabels(path.resolve(arg('--labels', path.join(HERE, 'labels.jsonl'))));
  const bad = labels.map((l, i) => [i + 1, validateLabel(l)]).filter(([, e]) => e.length > 0);
  if (bad.length > 0) {
    for (const [line, e] of bad) process.stderr.write(`labels.jsonl line ${line}: ${e.join('; ')}\n`);
    process.exit(1);
  }
  const predictions = await readPredictions(path.resolve(arg('--predictions', path.join(HERE, '.work', 'predictions.json'))));
  process.stdout.write(`${JSON.stringify({ labels: labels.length, ...score(labels, predictions) }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
