#!/usr/bin/env node
// Validation study, aggregate numbers (spec section 11.5): runs `read-receipts --json --share` over the
// allowlisted repos and keeps totals only (sessions, requests, cost, unreferenced token share, re-read
// rate, compaction re-read rate, composition shares) with the run date, tool version and the
// per-entrypoint corpus mix.
//
//   node study/aggregate.mjs [--out study/aggregate.json]
//
// The output holds totals only and is committed; study/score.mjs --write puts it into docs/STUDY.md and
// the README. No "likely unused" estimate is kept for this corpus: its reads were labelled, so the docs
// give the labelled counts instead.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

/** Totals only: nothing per session, no paths, no ids. */
export function aggregateTotals(report) {
  const t = report.totals;
  const comp = t.estimated?.composition ?? [];
  const introduced = comp.reduce((s, c) => s + c.introduced, 0);
  const compositionShares = {};
  for (const c of comp) compositionShares[c.source] = introduced > 0 ? c.introduced / introduced : 0;
  const entrypoints = {};
  for (const s of report.sessions ?? []) {
    const k = typeof s.entrypoint === 'string' && s.entrypoint !== '' ? s.entrypoint : 'unknown';
    entrypoints[k] = (entrypoints[k] ?? 0) + 1;
  }
  return {
    runAt: report.generatedAt,
    toolVersion: report.toolVersion,
    sessions: t.sessions,
    requests: t.requests,
    usd: t.usd,
    usdLowerBound: t.lowerBound,
    harnessUSD: t.harnessUSD ?? null,
    unloggedUSD: t.unloggedUSD ?? null,
    sessionsWithHarnessCost: (report.sessions ?? []).filter((s) => typeof s.cost?.harnessUSD === 'number').length,
    cacheHitShare: t.cacheHitShare ?? null,
    reads: t.readCounts?.total ?? null,
    unreferencedReads: t.readCounts?.unreferenced ?? null,
    unreferencedReadRate: t.unreferencedReadRate,
    unreferencedTokenShare: t.estimated?.unreferencedTokenShare ?? null,
    unreferencedCarriedUSD: t.estimated?.unreferencedCarriedUSD ?? null,
    rereads: t.readCounts?.rereads ?? null,
    rereadsUnchanged: t.readCounts?.rereadsUnchanged ?? null,
    rereadRate: t.rereadRate,
    compactions: t.compactions,
    compactionRereadRate: t.compactionRereadRate,
    subagents: t.subagents ?? 0,
    subagentCostShare: t.subagentCostShare ?? 0,
    compositionShares,
    entrypoints,
  };
}

async function main() {
  const home = os.homedir();
  const allow = JSON.parse(await readFile(path.join(HERE, 'allowlist.json'), 'utf8'));
  const roots = allow.parents.flatMap((p) => allow.repos.map((r) => path.join(home, p, r))).filter((d) => existsSync(d));
  const args = [path.join(HERE, '..', 'bin', 'read-receipts.mjs'), '--json', '--share', '--share-salt', randomBytes(32).toString('hex'), '--since', '2000-01-01'];
  for (const r of roots) args.push('--project', r);
  const { stdout } = await run(process.execPath, args, { maxBuffer: 512 * 1024 * 1024 });
  const totals = aggregateTotals(JSON.parse(stdout));
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(HERE, 'aggregate.json'));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(totals, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(totals, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
