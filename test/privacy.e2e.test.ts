import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildReport } from '../src/pipeline.js';
import { renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { shareReport } from '../src/report/share.js';
import { renderTerminal } from '../src/report/terminal.js';
import { CANARY, canaryTree } from './helpers/canary.js';
import { fixtureTree } from './helpers/fixture-tree.js';
import { defaults } from './helpers/report-defaults.js';
import { tmpDir } from './helpers/synth.js';

const CLI = path.resolve('src/cli.ts');
let dirs: { claudeDir: string; codexDir: string };

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, text: stdout + stderr }),
    );
  });
}
async function readIfExists(f: string): Promise<string> {
  try {
    return await readFile(f, 'utf8');
  } catch {
    return '';
  }
}

beforeAll(async () => {
  dirs = await canaryTree();
});

describe('--share', () => {
  const src = () => ['--claude-dir', dirs.claudeDir, '--codex-dir', dirs.codexDir, '--since', '2000-01-01'];
  // A fixed salt, so the test never writes a salt file into the real config directory.
  const SALT = ['--share-salt', '0123456789abcdef0123456789abcdef'];

  it('the unredacted outputs do carry the canaries (so the leak test can fail)', async () => {
    const out = path.join(await tmpDir(), 'raw.html');
    const j = await runCli(['--json', ...src()]);
    expect(j.text).toMatch(/CANARY-BRANCH-7/);
    expect(j.text).toMatch(/canary-user/);
    const h = await runCli(['--html', out, ...src()]);
    expect(h.code).toBe(0);
    expect(await readIfExists(out)).toMatch(CANARY);
  });

  it('leaks no canary in terminal, --json or --html output of any command', async () => {
    const out = path.join(await tmpDir(), 'shared.html');
    const runs = [
      ['--share'],
      ['--share', '--json'],
      ['--share', '--html', out],
      ['--share', '--json', '--html', out],
      ['sessions', '--share'],
      ['prs', '--share'],
      ['compare', '--by', 'instructions', '--share', '--html', out],
      ['compare', '--split-at', '2026-10-20', '--share', '--json'],
      ['session', 'c0ffee00', '--share'],
      ['session', 'c0ffee00', '--share', '--json'],
    ];
    for (const args of runs) {
      await rm(out, { force: true });
      const r = await runCli([...args, ...SALT, ...src()]);
      expect(r.code, args.join(' ')).toBe(0);
      const text = r.text + (await readIfExists(out));
      expect(text.length).toBeGreaterThan(100);
      expect(text, args.join(' ')).not.toMatch(CANARY);
    }
  }, 120_000);

  it('--share with no sessions names the searched dirs without the home directory', async () => {
    const r = await runCli(['--share', ...SALT, '--claude-dir', path.join(process.env.HOME ?? '/', '.no-such-dir-rr'), '--codex-dir', '/no-such-dir-rr']);
    expect(r.code).toBe(0);
    if (process.env.HOME) expect(r.text).not.toContain(process.env.HOME);
  });
});

describe('--share salt', () => {
  const src = () => ['--claude-dir', dirs.claudeDir, '--codex-dir', dirs.codexDir, '--since', '2000-01-01'];

  it('creates a 0600 salt file on first use and keeps labels stable across runs', async () => {
    const cfg = path.join(await tmpDir('rr-cfg-'), 'cfg');
    const env = { XDG_CONFIG_HOME: cfg };
    const a = await runCli(['--share', '--json', ...src()], env);
    const b = await runCli(['--share', '--json', ...src()], env);
    expect(a.code).toBe(0);
    const file = path.join(cfg, 'read-receipts', 'salt');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const id = (t: string) => (JSON.parse(t) as { sessions: Array<{ sessionId: string }> }).sessions[0]!.sessionId;
    expect(id(a.text)).toBe(id(b.text));
    const other = await runCli(['--share', '--json', '--share-salt', 'ab'.repeat(16), ...src()], env);
    expect(id(other.text)).not.toBe(id(a.text));
  });

  it('rejects a malformed --share-salt as a usage error', async () => {
    const r = await runCli(['--share', '--share-salt', 'xyz', ...src()]);
    expect(r.code).toBe(2);
  });
});

describe('no network', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes no network connection during a full run', async () => {
    const boom = () => {
      throw new Error('network access attempted');
    };
    const spies = [
      vi.spyOn(net, 'connect').mockImplementation(boom),
      vi.spyOn(net, 'createConnection').mockImplementation(boom),
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(boom),
      vi.spyOn(tls, 'connect').mockImplementation(boom),
      vi.spyOn(http, 'request').mockImplementation(boom),
      vi.spyOn(http, 'get').mockImplementation(boom),
      vi.spyOn(https, 'request').mockImplementation(boom),
      vi.spyOn(https, 'get').mockImplementation(boom),
      vi.spyOn(dns, 'lookup').mockImplementation(boom),
      vi.spyOn(dns, 'resolve').mockImplementation(boom),
      vi.spyOn(dns.promises, 'lookup').mockImplementation(boom),
      vi.spyOn(globalThis, 'fetch').mockImplementation(boom),
    ];
    const fx = await fixtureTree();
    for (const d of [fx, dirs]) {
      const r = await buildReport({ ...defaults, ...d, compare: { by: 'model', splitAt: null, outcome: 'any' } });
      expect(r.sessions.length).toBeGreaterThan(0);
      for (const rep of [r, shareReport(r, { home: '/home/canary-user', salt: '00'.repeat(32) })]) {
        expect(renderHtml(rep)).toContain('</html>');
        expect(renderJson(rep).length).toBeGreaterThan(100);
        expect(renderTerminal(rep, { color: false, width: 100 }).length).toBeGreaterThan(100);
      }
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
