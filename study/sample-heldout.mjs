#!/usr/bin/env node
// Validation study, held-out sample (spec section 11.6): reads not in the first sample, drawn with their
// own seed, with predictions of both heuristic versions. v1 is the read metric before the test-file rules
// (commit f74cc20), loaded from a checkout of that commit; v2 is this checkout.
//
//   git worktree add ../rr-v1 f74cc20 && ln -s "$PWD/node_modules" ../rr-v1/node_modules
//   node study/sample-heldout.mjs --v1 ../rr-v1 [--target 90] [--seed 20261103] [--referenced-only]
//
// Writes study/.work/packets-heldout/ and study/.work/predictions-heldout.json (`{v1, v2, tool, repo}` per
// read). Packets hold no predictions. The first sample (study/.work/predictions.json) is left untouched.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectCorpus, loadAllowlist, runSample } from './sample-reads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELDOUT_SEED = 20261103;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main() {
  const v1Dir = arg('--v1', null);
  if (v1Dir === null) throw new Error('--v1 <checkout of the v1 commit> is required');
  const home = os.homedir();
  const outDir = path.join(HERE, '.work');
  const denyFile = path.join(outDir, 'deny.txt');
  const deny = existsSync(denyFile) ? (await readFile(denyFile, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')) : [];
  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  const codexDir = path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions');
  const allowlist = await loadAllowlist(path.join(HERE, 'allowlist.json'));
  const opts = { claudeDir, codexDir, allowlist, home, user: os.userInfo().username, deny };

  const first = new Set(Object.keys(JSON.parse(await readFile(path.join(outDir, 'predictions.json'), 'utf8')).predictions));
  const v1Mod = await import(pathToFileURL(path.resolve(v1Dir, 'study/sample-reads.mjs')).href);
  const v1 = new Map((await v1Mod.collectCorpus(opts)).candidates.map((c) => [`${c.sessionHash}:${c.readOrdinal}`, c]));
  const key = (c) => `${c.sessionHash}:${c.readOrdinal}`;
  const referencedOnly = process.argv.includes('--referenced-only');
  const v2Count = (await collectCorpus(opts)).candidates.length;

  const r = await runSample({
    ...opts,
    outDir,
    target: Number(arg('--target', '90')),
    seed: Number(arg('--seed', String(HELDOUT_SEED))),
    packetsName: 'packets-heldout',
    predictionsName: 'predictions-heldout.json',
    select: (cands) =>
      cands.filter((c) => {
        const old = v1.get(key(c));
        if (first.has(key(c)) || old === undefined || old.path !== c.path) return false;
        return !referencedOnly || (!c.unreferenced && !old.unreferenced);
      }),
    predictionOf: (c) => {
      const old = v1.get(key(c));
      return { v1: { unreferenced: old.unreferenced, reason: old.reason }, v2: { unreferenced: c.unreferenced, reason: c.reason }, tool: c.tool, repo: c.repo };
    },
  });
  process.stdout.write(`corpus candidates v2 ${v2Count}, v1 ${v1.size}; held-out packets ${r.packets}: ${Object.entries(r.strata).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
