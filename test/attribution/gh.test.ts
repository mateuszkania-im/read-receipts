import fs from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listPrs, originToRepo } from '../../src/attribution/gh.js';
import { tmpDir } from '../helpers/synth.js';

const isWin = process.platform === 'win32';

async function fakeGh(body: string): Promise<string> {
  const bin = path.join(await tmpDir('rr-fakegh-'), 'gh');
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe('originToRepo', () => {
  it.each([
    ['git@github.com:acme/shop.git', 'github.com/acme/shop'],
    ['https://github.com/acme/shop.git', 'github.com/acme/shop'],
    ['https://github.com/acme/shop', 'github.com/acme/shop'],
    ['ssh://git@github.com/acme/shop.git', 'github.com/acme/shop'],
    ['https://user:token@ghe.example.com/acme/shop.git', 'ghe.example.com/acme/shop'],
  ])('%s gives %s', (origin, want) => {
    expect(originToRepo(origin)).toBe(want);
  });
  it.each(['--repo=x', '/local/path/repo', 'git@github.com:-x/y.git', 'https://github.com/acme', 'file:///tmp/r.git'])('rejects %s', (origin) => {
    expect(originToRepo(origin)).toBeNull();
  });
});

describe('listPrs', () => {
  it('degrades to a note when gh is not installed', async () => {
    const r = await listPrs('git@github.com:acme/shop.git', { bin: path.join(await tmpDir(), 'no-such-gh') });
    expect(r.prs).toEqual([]);
    expect(r.note).toMatch(/gh not found/);
  });
  it('degrades to a note for an origin it cannot name', async () => {
    const r = await listPrs('/srv/git/shop', {});
    expect(r).toEqual({ prs: [], note: expect.stringMatching(/not a GitHub-style remote/) });
  });
  it.skipIf(isWin)('degrades to a note when gh is not logged in', async () => {
    const bin = await fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4');
    const r = await listPrs('git@github.com:acme/shop.git', { bin });
    expect(r.prs).toEqual([]);
    expect(r.note).toMatch(/gh auth login/);
  });
  it.skipIf(isWin)('times out instead of hanging', async () => {
    const bin = await fakeGh('sleep 10');
    const t0 = Date.now();
    const r = await listPrs('git@github.com:acme/shop.git', { bin, timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.note).toMatch(/timed out|failed/);
  });
  it.skipIf(isWin)('runs without prompts and parses the PR list, dropping malformed entries', async () => {
    const prs = JSON.stringify([
      { number: 7, headRefName: 'feat/x', state: 'CLOSED', createdAt: '2026-10-02T12:00:00Z', mergedAt: null, closedAt: '2026-10-05T00:00:00Z', title: 't', url: 'https://github.com/acme/shop/pull/7' },
      { number: 'eight', headRefName: 'feat/y' },
    ]);
    const bin = await fakeGh(`[ "$GH_PROMPT_DISABLED" = 1 ] || exit 9\n[ "$3" = "--repo" ] && [ "$4" = "github.com/acme/shop" ] || exit 8\ncat <<'JSON'\n${prs}\nJSON`);
    const r = await listPrs('git@github.com:acme/shop.git', { bin });
    expect(r.note).toBeNull();
    expect(r.prs).toEqual([
      { number: 7, headRefName: 'feat/x', state: 'CLOSED', createdAt: '2026-10-02T12:00:00Z', mergedAt: null, closedAt: '2026-10-05T00:00:00Z', title: 't', url: 'https://github.com/acme/shop/pull/7' },
    ]);
  });
});

describe('listPrs: token safety', () => {
  const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  async function loggingGh(authExit: number): Promise<{ bin: string; log: string }> {
    const log = path.join(await tmpDir('rr-ghlog-'), 'calls');
    const bin = await fakeGh(
      `echo "ARGS $*" >> '${log}'\nenv | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)=' | sed 's/^/ENV /' >> '${log}'\nif [ "$1" = auth ]; then exit ${authExit}; fi\necho '[]'`,
    );
    return { bin, log };
  }
  const withTokens = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = Object.fromEntries(TOKENS.map((k) => [k, process.env[k]]));
    for (const k of TOKENS) process.env[k] = `secret-${k}`;
    try {
      return await fn();
    } finally {
      for (const k of TOKENS) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  };
  it.skipIf(isWin)('an origin on an unauthenticated host gets a note, no pr list call and no token in any env', async () => {
    const { bin, log } = await loggingGh(1);
    const r = await withTokens(() => listPrs('https://evil.example/acme/shop.git', { bin }));
    expect(r.prs).toEqual([]);
    expect(r.note).toMatch(/evil\.example/);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    expect(calls).not.toMatch(/ARGS pr list/);
    expect(calls).not.toMatch(/^ENV /m);
  });
  it.skipIf(isWin)('github.com is looked up without an auth probe and without enterprise tokens', async () => {
    const { bin, log } = await loggingGh(0);
    await withTokens(() => listPrs('git@github.com:acme/shop.git', { bin }));
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/ARGS auth/);
    expect(calls).toMatch(/ARGS pr list/);
    expect(calls).not.toMatch(/ENTERPRISE/);
  });
  it.skipIf(isWin)('an enterprise host gh is logged in to is looked up, with enterprise tokens only when it is GH_HOST', async () => {
    const { bin, log } = await loggingGh(0);
    await withTokens(() => listPrs('https://ghe.example.com/acme/shop.git', { bin }));
    let calls = fs.readFileSync(log, 'utf8');
    expect(calls).toMatch(/ARGS auth status --hostname ghe\.example\.com/);
    expect(calls).toMatch(/ARGS pr list/);
    expect(calls).not.toMatch(/^ENV /m);
    fs.rmSync(log);
    process.env.GH_HOST = 'ghe.example.com';
    try {
      await withTokens(() => listPrs('https://ghe.example.com/acme/shop.git', { bin }));
    } finally {
      delete process.env.GH_HOST;
    }
    calls = fs.readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/ARGS auth/);
    expect(calls).toMatch(/ENV GH_ENTERPRISE_TOKEN=/);
    expect(calls).not.toMatch(/ENV GH_TOKEN=/);
  });
});

describe('listPrs: spawning', () => {
  it('spawns gh from the temp directory, never a repository', async () => {
    const cwds: string[] = [];
    await listPrs('git@github.com:acme/shop.git', {
      bin: '/usr/bin/gh',
      exec: (_b, _a, o, cb) => {
        cwds.push(o.cwd);
        cb(null, '[]', '');
      },
    });
    expect(cwds).toEqual([os.tmpdir()]);
  });
});

describe('listPrs on Windows (review 7-8, ruling 9)', () => {
  it('reports a gh that exists only as a .cmd or .bat script instead of running it', async () => {
    const d = await tmpDir('rr-ghwin-');
    await writeFile(path.join(d, 'gh.cmd'), '');
    const r = await listPrs('git@github.com:acme/shop.git', { env: { PATH: d, PATHEXT: '.EXE;.CMD' }, platform: 'win32' });
    expect(r.prs).toEqual([]);
    expect(r.note).toMatch(/gh\.cmd/);
    expect(r.note).toMatch(/\.exe/);
  });
});
