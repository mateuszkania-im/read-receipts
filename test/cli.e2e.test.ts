import { execFile } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureTree } from './helpers/fixture-tree.js';
import { tmpDir } from './helpers/synth.js';

const CLI = path.resolve('src/cli.ts');
let tree: { claudeDir: string; codexDir: string };

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: path.resolve('.'), env: { ...process.env, NO_COLOR: '1' }, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const src = () => ['--claude-dir', tree.claudeDir, '--codex-dir', tree.codexDir, '--since', '2000-01-01'];

beforeAll(async () => {
  tree = await fixtureTree();
});

describe('cli', () => {
  it('--help lists the commands', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['summary', 'sessions', 'session', 'prs', 'compare', 'prices']) expect(r.stdout).toContain(c);
  });
  it('top-level --help lists the global options and every command on one line each (final review C7)', async () => {
    const r = await run(['--help']);
    const lines = r.stdout.split('\n');
    for (const flag of ['--since', '--until', '--project', '--agent', '--claude-dir', '--codex-dir', '--no-subagents', '--prices', '--gh', '--json', '--html', '--share', '--share-salt', '--max-line-mb', '--force']) {
      expect(lines.filter((l) => new RegExp(`^\\s+${flag}(?: <[^>]+>)?\\s{2,}\\S`).test(l)), flag).toHaveLength(1);
    }
    for (const c of ['summary', 'sessions', 'session', 'prs', 'compare', 'prices']) {
      const i = lines.findIndex((l) => new RegExp(`^  ${c} `).test(l));
      expect(i, c).toBeGreaterThan(0);
      expect(lines[i]!.trim().split(/\s{2,}/).length, lines[i]).toBe(2);
      expect(lines[i + 1], `${c} wraps`).not.toMatch(/^\s{10,}\S/);
    }
  });
  it('--version prints the version', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('exit 2 on an unknown option or a bad --since', async () => {
    expect((await run(['--no-such-option'])).code).toBe(2);
    expect((await run(['summary', '--since', 'yesterday'])).code).toBe(2);
    expect((await run(['compare', '--by', 'colour'])).code).toBe(2);
  });
  it('exit 0 with no sessions and a message naming the dirs', async () => {
    const empty = await tmpDir();
    const r = await run(['--claude-dir', path.join(empty, 'c'), '--codex-dir', path.join(empty, 'x')]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain(path.join(empty, 'c'));
  });
  it('summary prints totals, --json prints the report', async () => {
    const t = await run(['summary', ...src()]);
    expect(t.code).toBe(0);
    expect(t.stdout).toMatch(/6 sessions/);
    const j = await run(['--json', ...src()]);
    expect(JSON.parse(j.stdout).sessions).toHaveLength(6);
  });
  it('session <prefix> shows the reads table for one session', async () => {
    const r = await run(['session', '7a6a9ed0', ...src()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5');
    expect(r.stdout).toMatch(/Reads/);
    expect(r.stdout).toContain('math.js');
  });
  it('compare --outcome merged without --gh is a usage error with a clear message (review 7-8, ruling 5)', async () => {
    const r = await run(['compare', '--outcome', 'merged', ...src()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--outcome merged needs --gh/);
  });
  it('session with no match exits 1', async () => {
    expect((await run(['session', 'ffffffff', ...src()])).code).toBe(1);
  });
  it('sessions, prs, compare and prices run', async () => {
    expect((await run(['sessions', ...src()])).code).toBe(0);
    expect((await run(['prs', ...src()])).code).toBe(0);
    const c = await run(['compare', '--by', 'model', ...src()]);
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/too few/);
    const p = await run(['prices']);
    expect(p.stdout).toContain('claude-sonnet-5-5');
    expect(JSON.parse((await run(['prices', '--json'])).stdout).length).toBeGreaterThan(10);
  });
  it('a missing or invalid --prices file is a usage error that names the flag and the file (final review C12)', async () => {
    const dir = await tmpDir();
    const missing = path.join(dir, 'nope.json');
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{oops');
    for (const args of [['--prices', missing, ...src()], ['prices', '--prices', missing]]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('--prices');
      expect(r.stderr).toContain(missing);
      expect(r.stderr).toMatch(/no such file/i);
    }
    const r = await run(['--prices', bad, ...src()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`--prices ${bad}`);
    expect(r.stderr).toMatch(/not valid JSON/);
  });
  it('an --html file that cannot be written names the flag and the file (final review C12)', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'missing-dir', 'r.html');
    const r = await run(['--html', target, ...src()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`--html ${target}`);
    expect(r.stderr).toMatch(/no such directory|no such file/i);
  });
  it('--html refuses to write through a symlink unless --force (F13)', async () => {
    const dir = await tmpDir();
    const victim = path.join(dir, 'victim.txt');
    const link = path.join(dir, 'report.html');
    await writeFile(victim, 'ORIGINAL');
    await symlink(victim, link);
    const r = await run(['--html', link, ...src()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--html .*symlink.*--force/);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL');
    const f = await run(['--html', link, '--force', ...src()]);
    expect(f.code).toBe(0);
    expect(await readFile(victim, 'utf8')).toMatch(/^<!doctype html>/i);
  });
});
