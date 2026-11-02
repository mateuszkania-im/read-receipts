import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedRoot, callTouchesOutside, collectCorpus, devPredictions, loadAllowlist, runSample, scrubText } from '../../study/sample-reads.mjs';
import { claudeLines, tmpDir, writeClaudeSession } from '../helpers/synth.js';

const HOME = '/home/x';
const allow = { parents: ['Desktop', 'Desktop/open-source'], repos: ['why-diff', 'why-diff-bench', 'doc-router'] };
const CART = 'export function cartTotal(items) {\n  return items.length;\n}\n';

describe('study/allowlist.json', () => {
  it('lists exactly the four public repos', async () => {
    const a = await loadAllowlist(path.resolve('study/allowlist.json'));
    expect([...a.repos].sort()).toEqual(['agent-ledger', 'doc-router', 'recipe-units-agent', 'why-diff']);
    expect(JSON.stringify(a)).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe('allowedRoot', () => {
  it('accepts a repo or a folder inside it, under an allowlisted parent of home', () => {
    expect(allowedRoot('/home/x/Desktop/why-diff', allow, HOME)).toBe('/home/x/Desktop/why-diff');
    expect(allowedRoot('/home/x/Desktop/open-source/why-diff/bench/runs/f01', allow, HOME)).toBe('/home/x/Desktop/open-source/why-diff');
    expect(allowedRoot('/home/x/Desktop/open-source/why-diff-bench', allow, HOME)).toBe('/home/x/Desktop/open-source/why-diff-bench');
  });
  it('refuses everything else', () => {
    for (const cwd of ['/home/x/private', '/home/x/Desktop', '/home/x/Desktop/secret-project/why-diff', '/home/x/Desktop/why-diff-private', '/srv/why-diff', '/home/x/why-diff', null]) {
      expect(allowedRoot(cwd, allow, HOME), String(cwd)).toBeNull();
    }
  });
});

async function corpus(): Promise<string> {
  const claudeDir = path.join(await tmpDir('rr-study-'), 'claude');
  const ok = '/home/x/Desktop/why-diff';
  const ts = (n: number) => `2026-10-20T09:0${n}:00.000Z`;
  await writeClaudeSession(claudeDir, ok, '11111111-1111-4111-8111-111111111111', claudeLines('11111111-1111-4111-8111-111111111111', [
    { ts: ts(1), cwd: ok, read: { file: `${ok}/src/cart.ts`, content: CART } },
    { ts: ts(2), cwd: ok, text: 'cartTotal returns the length; I will change it.', edit: { file: `${ok}/src/cart.ts` } },
    { ts: ts(3), cwd: ok, read: { file: `${ok}/README.md`, content: '# Why diff\n\nA tool.\n' } },
  ]));
  // Outside the allowlist.
  const priv = '/home/x/private/PRIVMARK-proj';
  await writeClaudeSession(claudeDir, priv, '22222222-2222-4222-8222-222222222222', claudeLines('22222222-2222-4222-8222-222222222222', [
    { ts: ts(1), cwd: priv, read: { file: `${priv}/src/secret.ts`, content: 'const PRIVMARK_value = 1;\n' } },
  ]));
  // A repo of the allowlisted name, under a folder that is not an allowlisted parent.
  const nested = '/home/x/Desktop/PRIVMARK-folder/why-diff';
  await writeClaudeSession(claudeDir, nested, '33333333-3333-4333-8333-333333333333', claudeLines('33333333-3333-4333-8333-333333333333', [
    { ts: ts(1), cwd: nested, read: { file: `${nested}/src/a.ts`, content: 'const PRIVMARK_a = 1;\n' } },
  ]));
  // Starts in the allowlisted repo, then works in a private folder: the whole session is refused.
  await writeClaudeSession(claudeDir, ok, '44444444-4444-4444-8444-444444444444', claudeLines('44444444-4444-4444-8444-444444444444', [
    { ts: ts(1), cwd: ok, read: { file: `${ok}/src/b.ts`, content: 'const bValue = 1;\n' } },
    { ts: ts(2), cwd: priv, read: { file: `${priv}/x.ts`, content: 'const PRIVMARK_x = 1;\n' } },
  ]));
  return claudeDir;
}

describe('sample-reads', () => {
  it('refuses every session whose cwd is not inside an allowlisted repo', async () => {
    const claudeDir = await corpus();
    const c = await collectCorpus({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [] });
    expect(c.sessions).toBe(1);
    expect(c.refusedSessions).toBe(3);
    expect(c.candidates.map((x) => [x.repo, x.path, x.tool])).toEqual([
      ['why-diff', 'src/cart.ts', 'read'],
      ['why-diff', 'README.md', 'read'],
    ]);
  });

  it('writes packets without heuristic output, and predictions separately', async () => {
    const claudeDir = await corpus();
    const out = await tmpDir('rr-study-out-');
    const r = await runSample({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: out, target: 10 });
    expect(r.packets).toBe(2);
    const files = (await readdir(path.join(out, 'packets'))).sort();
    expect(files).toHaveLength(2);
    for (const f of files) {
      const text = await readFile(path.join(out, 'packets', f), 'utf8');
      expect(text).not.toMatch(/PRIVMARK|\/home\/x/);
      expect(text).not.toMatch(/referenced|unreferenced|predict|heuristic|anchor/i);
      expect(text).toMatch(/repo: why-diff/);
    }
    const cart = await readFile(path.join(out, 'packets', files.find((f) => f.endsWith('-1.md'))!), 'utf8');
    expect(cart).toContain('path: src/cart.ts');
    expect(cart).toContain('export function cartTotal');
    expect(cart).toContain('cartTotal returns the length');
    expect(cart).toMatch(/tool call: Edit/);
    const pred = JSON.parse(await readFile(path.join(out, 'predictions.json'), 'utf8')) as { predictions: Record<string, { unreferenced: boolean }> };
    expect(Object.keys(pred.predictions)).toHaveLength(2);
    expect(Object.values(pred.predictions).map((p) => p.unreferenced).sort()).toEqual([false, true]);
  });

  it('shows the full tool input from the log, also for tools whose input the parser does not keep', async () => {
    const claudeDir = path.join(await tmpDir('rr-study-'), 'claude');
    const ok = '/home/x/Desktop/why-diff';
    const id = '55555555-5555-4555-8555-555555555555';
    const body = claudeLines(id, [{ ts: '2026-10-20T09:01:00.000Z', cwd: ok, read: { file: `${ok}/src/cart.ts`, content: CART } }]);
    const final = { type: 'assistant', sessionId: id, cwd: ok, gitBranch: 'main', version: '2.1.316', entrypoint: 'sdk-py', timestamp: '2026-10-20T09:02:00.000Z', uuid: 'u-final',
      message: { id: 'msg-final', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_final', name: 'StructuredOutput', input: { verdict: 'FINALVERDICT the cart sums lengths' } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    await writeClaudeSession(claudeDir, ok, id, body + JSON.stringify(final) + '\n');
    const out = await tmpDir('rr-study-out-');
    await runSample({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: out, target: 10 });
    const [f] = await readdir(path.join(out, 'packets'));
    const text = await readFile(path.join(out, 'packets', f!), 'utf8');
    expect(text).toMatch(/tool call: StructuredOutput/);
    expect(text).toContain('FINALVERDICT the cart sums lengths');
  });

  it('leaves out calls and results that touch paths outside the repo (reads, cat and cd)', async () => {
    const claudeDir = path.join(await tmpDir('rr-study-'), 'claude');
    const ok = '/home/x/Desktop/why-diff';
    const id = '77777777-7777-4777-8777-777777777777';
    const ts = (n: number) => `2026-10-20T09:0${n}:00.000Z`;
    const body = claudeLines(id, [
      { ts: ts(1), cwd: ok, read: { file: `${ok}/src/cart.ts`, content: CART } },
      { ts: ts(2), cwd: ok, read: { file: '/home/x/secret.txt', content: 'SECRETCONTENT one\n' } },
      { ts: ts(3), cwd: ok, read: { file: '/etc/hosts', content: 'HOSTSCONTENT localhost\n' } },
    ]);
    const bash = (n: number, callId: string, command: string, out: string) => [
      { type: 'assistant', sessionId: id, cwd: ok, gitBranch: 'main', version: '2.1.316', entrypoint: 'sdk-py', timestamp: ts(n), uuid: `ua-${callId}`,
        message: { id: `m-${callId}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'user', sessionId: id, cwd: ok, gitBranch: 'main', version: '2.1.316', entrypoint: 'sdk-py', timestamp: ts(n), uuid: `ur-${callId}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: out }] } },
    ];
    const extra = [
      ...bash(4, 'toolu_b1', 'cat ~/notes.txt', 'BASHHOME notes'),
      ...bash(5, 'toolu_b2', 'cd /var/lib/app && ls', 'BASHCD listing'),
      ...bash(6, 'toolu_b3', 'cat ../../outside.md', 'BASHUP text'),
      ...bash(7, 'toolu_b4', 'npm test 2>/dev/null', 'INSIDE ok'),
      ...bash(8, 'toolu_b5', 'cd .. && ls', 'BASHDOTDOT listing'),
      ...bash(8, 'toolu_b6', 'cat $HOME/notes.txt', 'BASHVAR text'),
      ...bash(8, 'toolu_b7', 'cd && ls', 'BASHBARECD listing'),
      ...bash(8, 'toolu_b8', 'pushd src && ls', 'INSIDEPUSHD listing'),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    await writeClaudeSession(claudeDir, ok, id, body + extra);
    const out = await tmpDir('rr-study-out-');
    await runSample({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: out, target: 10 });
    const files = await readdir(path.join(out, 'packets'));
    expect(files).toHaveLength(1);
    const text = await readFile(path.join(out, 'packets', files[0]!), 'utf8');
    expect(text).not.toMatch(/secret\.txt|SECRETCONTENT|\/etc\/hosts|hosts|HOSTSCONTENT|notes\.txt|BASHHOME|\/var\/lib|BASHCD|outside\.md|BASHUP|BASHDOTDOT|BASHVAR|BASHBARECD/);
    expect(text.match(/\[left out: outside repo\]/g)?.length).toBe(16);
    expect(text).toContain('npm test');
    expect(text).toContain('INSIDE ok');
    expect(text).toContain('INSIDEPUSHD listing');
  });

  it('can write a second sample under other names, from a selected pool, with custom predictions', async () => {
    const claudeDir = await corpus();
    const out = await tmpDir('rr-study-out-');
    const r = await runSample({
      claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: out, target: 10, seed: 20261103,
      select: (cands) => cands.filter((c) => !c.unreferenced),
      packetsName: 'packets-heldout',
      predictionsName: 'predictions-heldout.json',
      predictionOf: (c) => ({ v1: { unreferenced: c.unreferenced }, v2: { unreferenced: c.unreferenced, reason: c.reason } }),
    });
    expect(r.packets).toBe(1);
    expect(await readdir(out)).toEqual(expect.arrayContaining(['packets-heldout', 'predictions-heldout.json']));
    expect(await readdir(out)).not.toContain('packets');
    const [f] = await readdir(path.join(out, 'packets-heldout'));
    expect(await readFile(path.join(out, 'packets-heldout', f!), 'utf8')).not.toMatch(/referenced|unreferenced|predict|heuristic|anchor|v1|v2/i);
    const doc = JSON.parse(await readFile(path.join(out, 'predictions-heldout.json'), 'utf8')) as { seed: number; predictions: Record<string, unknown> };
    expect(doc.seed).toBe(20261103);
    expect(Object.values(doc.predictions)).toEqual([{ v1: { unreferenced: false }, v2: { unreferenced: false, reason: 'symbol' } }]);
  });

  it('is deterministic for a fixed seed', async () => {
    const claudeDir = await corpus();
    const a = await tmpDir('rr-study-a-');
    const b = await tmpDir('rr-study-b-');
    await runSample({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: a, target: 1 });
    await runSample({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: [], outDir: b, target: 1 });
    expect(await readdir(path.join(a, 'packets'))).toEqual(await readdir(path.join(b, 'packets')));
  });

  it('drops reads that carry a deny marker', async () => {
    const claudeDir = await corpus();
    const c = await collectCorpus({ claudeDir, codexDir: null, allowlist: allow, home: HOME, deny: ['cartTotal'] });
    expect(c.candidates.map((x) => x.path)).toEqual(['README.md']);
  });
});

describe('callTouchesOutside (fail-closed packet filter)', () => {
  const root = '/home/x/Desktop/why-diff';
  const ctx = { root, home: HOME, cwd: root, agent: 'claude' as const };
  const bash = (command: string) => ({ tool: 'Bash', toolClass: 'bash', paths: [], text: command, command });
  const grep = (text: string) => ({ tool: 'Grep', toolClass: 'search', paths: [`${root}/src`], text });

  it('keeps plain commands on paths inside the root', () => {
    for (const c of ['npm test 2>/dev/null', 'ls src', 'git diff main..HEAD -- src/a.ts', 'cd src && ls', 'pushd test/unit', `cd ${root}/src`]) {
      expect(callTouchesOutside(bash(c), undefined, ctx), c).toBe(false);
    }
  });
  it('treats any `..` path segment as outside, even one that would resolve inside', () => {
    for (const c of ['cd ..', 'cd .. && ls', 'cat src/../README.md', 'ls ../why-diff/src', 'cat src/..', 'type src\\..\\x']) {
      expect(callTouchesOutside(bash(c), undefined, ctx), c).toBe(true);
    }
    expect(callTouchesOutside(grep('pattern ../secret'), undefined, ctx)).toBe(true);
    expect(callTouchesOutside(grep('x'), '{"path": "src/../../other"}', ctx)).toBe(true);
  });
  it('treats shell expansion as outside', () => {
    for (const c of ['cat $HOME/x', 'cat ${D}/x', 'cat "$(pwd)/x"', 'ls *.md', 'ls src/?.ts', 'ls [ab].ts', 'cat `echo x`', 'cat ~root/.ssh/id', 'cd ~other', 'ls ~+']) {
      expect(callTouchesOutside(bash(c), undefined, ctx), c).toBe(true);
    }
  });
  it('treats cd or pushd without an explicit target inside the root as outside', () => {
    for (const c of ['cd', 'cd && ls', 'cd; cat x', 'pushd', 'cd -', 'cd -P src', 'cd /tmp', 'pushd /home/x/Desktop', 'ls && cd', 'cd ~']) {
      expect(callTouchesOutside(bash(c), undefined, ctx), c).toBe(true);
    }
  });
  it('resolves relative targets against the call\'s own cwd and fails closed when it is unknown', () => {
    expect(callTouchesOutside(bash('cd src'), undefined, { ...ctx, cwd: `${root}/bench/runs/r1` })).toBe(false);
    expect(callTouchesOutside(bash('cd src'), undefined, { ...ctx, cwd: null })).toBe(true);
    expect(callTouchesOutside(bash('ls'), undefined, { ...ctx, cwd: null })).toBe(true);
    expect(callTouchesOutside(grep('x'), undefined, { ...ctx, cwd: null })).toBe(true);
    expect(callTouchesOutside(bash('ls'), undefined, { ...ctx, cwd: '/home/x/Desktop/other' })).toBe(true);
  });
  it('fails closed on Codex shell calls, whose workdir the event does not carry', () => {
    expect(callTouchesOutside({ tool: 'exec_command', toolClass: 'bash', paths: [], text: 'ls' }, undefined, { ...ctx, agent: 'codex' })).toBe(true);
  });
});

describe('scrubText', () => {
  const ctx = { root: '/home/x/Desktop/why-diff', home: HOME, user: 'x-user', deny: ['PRIVMARK'] };
  it('makes repo paths relative and hides other paths, the user and secrets', () => {
    const t = scrubText('see /home/x/Desktop/why-diff/src/a.ts and ~/Desktop/why-diff/b.ts, /home/x/other/c.ts, ~/notes.md, /private/tmp/-home-x-user-y/z, /tmp/q, key sk-ant-abcdefghijklmnopqrstuvwxyz012345 mail a.b@example.com x-user', ctx);
    expect(t).toContain('src/a.ts');
    expect(t).toContain('b.ts');
    expect(t).not.toMatch(/\/home\/x|~\/|x-user|sk-ant|example\.com|\/tmp/);
  });
  it('returns null for text with a deny marker', () => {
    expect(scrubText('mentions privmark here', ctx)).toBeNull();
  });
});

describe('devPredictions', () => {
  const cand = (sessionHash: string, readOrdinal: number, unreferenced: boolean, repo = 'why-diff') =>
    ({ sessionHash, readOrdinal, repo, path: 'src/a.ts', tool: 'read', threadId: 't', seq: 1, unreferenced, reason: unreferenced ? null : 'path' }) as const;
  it('gives the current prediction of every first-sample read, as v2', () => {
    const doc = devPredictions([cand('a', 1, false), cand('a', 2, true), cand('b', 1, true)], { 'a:1': { repo: 'why-diff' }, 'b:1': { repo: 'why-diff' } });
    expect(doc).toEqual({
      'a:1': { v2: { unreferenced: false, reason: 'path' }, repo: 'why-diff' },
      'b:1': { v2: { unreferenced: true, reason: null }, repo: 'why-diff' },
    });
  });
  it('refuses a read that is missing or moved to another repo', () => {
    expect(() => devPredictions([cand('a', 1, false)], { 'a:2': { repo: 'why-diff' } })).toThrow(/a:2/);
    expect(() => devPredictions([cand('a', 1, false, 'doc-router')], { 'a:1': { repo: 'why-diff' } })).toThrow(/a:1/);
  });
});
