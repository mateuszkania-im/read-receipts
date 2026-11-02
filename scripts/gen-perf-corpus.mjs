#!/usr/bin/env node
/**
 * Writes a synthetic Claude Code corpus for the performance check: sessions in the discovery layout
 * (`<out>/claude/<slug>/<uuid>.jsonl`), each a run of fixture-shaped turns (prompt, response with a
 * Read or an Edit, the tool result with ~2 KB of invented code, cost-state, an occasional compaction)
 * with fresh ids and file names. Every value is generated; nothing comes from real logs.
 *
 *   node scripts/gen-perf-corpus.mjs --size <MB> [--out <dir>]
 *
 * The default output is `<os tmpdir>/read-receipts-perf/<MB>`. Output inside the repository is refused.
 * Remove it with `node scripts/clean-perf-corpus.mjs`.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PERF_ROOT = path.join(os.tmpdir(), 'read-receipts-perf');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

/** mulberry32: a fixed-seed PRNG so every run writes the same corpus. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`;

function code(file, lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(i % 6 === 0 ? `export function ${file}Step${i}(input: number): number {` : i % 6 === 5 ? '}' : `  const v${i} = input * ${i} + ${(i * 7) % 13};`);
  }
  return out.join('\n');
}

export async function generate(sizeMb, out) {
  const resolved = path.resolve(out);
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) throw new Error(`refusing to write the perf corpus inside the repository: ${resolved}`);
  await rm(resolved, { recursive: true, force: true });
  const target = sizeMb * 1024 * 1024;
  const r = rng(sizeMb);
  let written = 0;
  let session = 0;
  const big = 'x'.repeat(20_000);
  while (written < target) {
    const cwd = `/home/dev/project${session % 8}`;
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(resolved, 'claude', slug);
    await mkdir(dir, { recursive: true });
    const sid = uuid(r);
    const ws = createWriteStream(path.join(dir, `${sid}.jsonl`));
    const write = (o) => {
      const line = `${JSON.stringify(o)}\n`;
      written += Buffer.byteLength(line);
      if (!ws.write(line)) return new Promise((res) => ws.once('drain', res));
      return null;
    };
    const t0 = Date.parse('2026-10-01T00:00:00Z') + session * 3_600_000;
    let n = 0;
    const base = () => ({ sessionId: sid, cwd, gitBranch: `feat/perf-${session % 5}`, version: '2.1.316', entrypoint: 'cli', uuid: uuid(r), timestamp: new Date(t0 + n++ * 1000).toISOString() });
    await write({ type: 'attachment', ...base(), attachment: { type: 'instructions', files: [{ path: `${cwd}/CLAUDE.md`, type: 'Project', content: 'Keep functions small.' }] } });
    await write({ type: 'attachment', ...base(), attachment: { type: 'skill_listing', names: ['a', 'b'], content: big } });
    await write({ type: 'attachment', ...base(), attachment: { type: 'prompt_snapshot', systemPrompt: [`You are a coding agent.\nToday's date is 2026-10-01.\n${big}`], tools: [{ name: 'Read', description: big, schema: {} }] } });
    const sessionBytes = 2 * 1024 * 1024 + Math.floor(r() * 2 * 1024 * 1024);
    const start = written;
    let turn = 0;
    let cost = 0;
    while (written - start < sessionBytes && written < target) {
      const file = `${cwd}/src/mod${Math.floor(r() * 40)}/file${Math.floor(r() * 25)}.ts`;
      const name = `m${Math.floor(r() * 1e6).toString(36)}`;
      await write({ type: 'user', ...base(), message: { role: 'user', content: `Look at ${name} and tidy it up, please.` } });
      const callId = `toolu_${hex(r, 24)}`;
      const edit = turn % 5 === 4;
      const usage = { input_tokens: 5, output_tokens: 200 + (turn % 300), cache_read_input_tokens: 20_000 + turn * 50, cache_creation_input_tokens: 1500, cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 0 } };
      await write({
        type: 'assistant',
        ...base(),
        message: {
          id: `msg_${hex(r, 24)}`,
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          usage,
          content: [
            { type: 'text', text: turn % 3 === 0 ? `The helper ${name}Step6 in ${file.slice(cwd.length + 1)} looks off.` : 'Checking the next file.' },
            edit
              ? { type: 'tool_use', id: callId, name: 'Edit', input: { file_path: file, old_string: 'const v1', new_string: 'const w1' } }
              : { type: 'tool_use', id: callId, name: 'Read', input: { file_path: file } },
          ],
        },
      });
      if (edit) {
        await write({ type: 'user', ...base(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'The file has been updated.' }] } });
      } else {
        const content = code(name, 60 + Math.floor(r() * 60));
        const lines = content.split('\n').length;
        await write({
          type: 'user',
          ...base(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content }] },
          toolUseResult: { type: 'text', file: { filePath: file, content, numLines: lines, startLine: 1, totalLines: lines } },
        });
      }
      cost += 0.01;
      if (turn % 50 === 49) await write({ type: 'cost-state', ...base(), totalCostUSD: cost });
      if (turn % 400 === 399) await write({ type: 'system', subtype: 'compact_boundary', ...base(), compactMetadata: { trigger: 'auto', preTokens: 150_000 } });
      turn++;
    }
    await new Promise((res) => ws.end(res));
    session++;
  }
  return { dir: resolved, claudeDir: path.join(resolved, 'claude'), bytes: written, sessions: session };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const size = Number(arg('--size', '64'));
  if (!Number.isFinite(size) || size <= 0) {
    console.error('usage: gen-perf-corpus.mjs --size <MB> [--out <dir>]');
    process.exit(2);
  }
  const t0 = Date.now();
  const res = await generate(size, arg('--out', path.join(PERF_ROOT, String(size))));
  console.log(`wrote ${(res.bytes / 1024 / 1024).toFixed(0)} MB in ${res.sessions} sessions to ${res.dir} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
