import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadsPass } from '../../src/analysis/reads.js';
import { newStats } from '../../src/io/jsonl.js';
import { normalizePath } from '../../src/io/paths.js';
import type { LedgerEvent, ReadInfo, ToolClass, Usage } from '../../src/model.js';
import { parseClaudeThread } from '../../src/parse/claude.js';
import { parseCodexThread } from '../../src/parse/codex.js';
import type { PriceTable } from '../../src/prices/table.js';

// Sonnet-like prices so carried cost is easy to check by hand.
const prices: PriceTable = new Map([
  ['m', { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, source: 'https://x', retrieved: '2026-11-02' }],
]);

const T = 'sub';
const base = (seq: number) => ({ threadId: T, seq, ts: '' });
let ids = 0;

function read(seq: number, p: string, content: string, extra: Partial<ReadInfo> = {}): LedgerEvent {
  const lines = content.split('\n').length;
  return {
    kind: 'tool_result',
    ...base(seq),
    callId: `r${ids++}`,
    tool: 'Read',
    isError: false,
    chars: content.length,
    read: { path: p, startLine: 1, numLines: lines, totalLines: lines, contentHash: `h:${content}`, ...extra },
    text: content,
  };
}
function call(seq: number, tool: string, text: string, toolClass: ToolClass = 'bash', paths: string[] = []): LedgerEvent {
  return { kind: 'tool_call', ...base(seq), callId: `c${ids++}`, tool, toolClass, mcpServer: null, paths, text };
}
const edit = (seq: number, p: string) => call(seq, 'Edit', '', 'edit', [p]);
const say = (seq: number, text: string): LedgerEvent => ({ kind: 'assistant_text', ...base(seq), text });
const prompt = (seq: number, text: string): LedgerEvent => ({ kind: 'user_prompt', ...base(seq), chars: text.length, text });
const result = (seq: number, text: string): LedgerEvent => ({
  kind: 'tool_result',
  ...base(seq),
  callId: `x${ids++}`,
  tool: 'Bash',
  isError: false,
  chars: text.length,
  read: null,
  text,
});
const U = (o: Partial<Usage> = {}): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1, cacheWrite1h: 0, ...o });
const req = (seq: number, usage: Usage = U(), cwd: string | null = null): LedgerEvent => ({
  kind: 'request',
  ...base(seq),
  requestId: `q${seq}`,
  model: 'm',
  usage,
  cwd,
  gitBranch: null,
});
const compact = (seq: number): LedgerEvent => ({ kind: 'compaction', ...base(seq), trigger: 'manual', preTokens: null });
const reattach = (seq: number, p: string): LedgerEvent => ({ kind: 'injection', ...base(seq), source: 'reattached_file', name: p, chars: 1, hash: 'h' });
const agentResult = (seq: number, callId: string, text: string): LedgerEvent => ({
  kind: 'tool_result',
  threadId: 'main',
  seq,
  ts: '',
  callId,
  tool: 'Agent',
  isError: false,
  chars: text.length,
  read: null,
  text,
});

function run(events: LedgerEvent[], threadId = T, platform: NodeJS.Platform = 'linux') {
  const p = new ReadsPass(threadId, prices, platform);
  for (const e of events) p.onEvent(e);
  return p.finish();
}

describe('ReadsPass: references', () => {
  it('an edit of the same file makes the read referenced (edit)', () => {
    expect(run([read(1, 'src/a.ts', 'x'), edit(2, 'src/a.ts')]).reads[0]).toMatchObject({ referenced: true, reason: 'edit' });
  });
  it('an edit matches an absolute read path against a relative edit path', () => {
    expect(run([read(1, '/r/src/a.ts', 'x'), edit(2, 'src/a.ts')]).reads[0]).toMatchObject({ referenced: true, reason: 'edit' });
  });
  it('a later path mention references it (path)', () => {
    expect(run([read(1, 'src/a.ts', 'x'), say(2, 'see src/a.ts:12 for that')]).reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('the repo-relative form of an absolute read path counts, using the request cwd', () => {
    const r = run([req(0, U(), '/home/dev/shop'), read(1, '/home/dev/shop/src/cart.ts', 'x'), say(2, 'I changed `src/cart.ts`.')]);
    expect(r.reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('a long basename with a dot counts', () => {
    expect(run([read(1, 'src/deep/index.ts', 'x'), say(2, 'index.ts exports it')]).reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('a short generic basename does not count', () => {
    expect(run([read(1, 'docs/a.md', 'x'), say(2, 'a.md')]).reads[0]).toMatchObject({ referenced: false, reason: null });
  });
  it('a path inside a longer file name does not count', () => {
    expect(run([read(1, 'src/cart.ts', 'x'), say(2, 'see src/cart.tsx')]).reads[0]!.referenced).toBe(false);
  });
  it('a symbol from the content used later references it (symbol)', () => {
    expect(run([read(1, 'src/cart.ts', 'export function applyDiscount() {}'), call(2, 'Bash', 'node -e "applyDiscount()"')]).reads[0]).toMatchObject({
      referenced: true,
      reason: 'symbol',
    });
  });
  it('a heading anchor counts as a whole phrase', () => {
    const r = run([read(1, 'docs/guide.md', '# Rate limiter\ntext'), say(2, 'The Rate limiter section says so.')]);
    expect(r.reads[0]).toMatchObject({ referenced: true, reason: 'symbol' });
  });
  it('mentions inside tool results or user prompts do not count', () => {
    const r = run([read(1, 'src/a.ts', 'export function applyDiscount() {}'), result(2, 'src/a.ts applyDiscount'), prompt(3, 'src/a.ts applyDiscount')]);
    expect(r.reads[0]!.referenced).toBe(false);
  });
  it('mentions before the read do not count', () => {
    expect(run([say(0, 'src/a.ts'), read(1, 'src/a.ts', 'x')]).reads[0]!.referenced).toBe(false);
  });
  it('symbol match is whole-word', () => {
    expect(run([read(1, 'src/cart.ts', 'export function applyDiscount() {}'), say(2, 'applyDiscountV2 is new')]).reads[0]!.referenced).toBe(false);
  });
  it('reports tokens as ceil(chars / 4)', () => {
    expect(run([read(1, 'a.ts', 'z'.repeat(1001))]).reads[0]!.tokens).toBe(251);
  });
});

describe('ReadsPass: test files', () => {
  const TEST = [
    "import { total } from '../src/cart.js';",
    "describe('cart totals', () => {",
    "  it('applies tax to the discounted subtotal', () => {",
    '    expect(total([{ price: 3000 }], 0.1, 0.2)).toBe(3240);',
    '  });',
    "  test.skip(`rounds half cents up`, () => {});",
    "  it('works', () => {});",
    '});',
  ].join('\n');

  it('a quoted test title used later references the test read (symbol)', () => {
    const r = run([read(1, '/r/test/cart.test.js', TEST), say(2, 'The test "applies tax to the discounted subtotal" expects 3240.')]);
    expect(r.reads[0]).toMatchObject({ referenced: true, reason: 'symbol' });
  });
  it('titles of describe blocks and template-literal titles count too', () => {
    expect(run([read(1, '/r/test/cart.test.js', TEST), say(2, 'Only cart totals fail.')]).reads[0]!.referenced).toBe(true);
    expect(run([read(1, '/r/test/cart.test.js', TEST), say(2, 'The rounds half cents up case is skipped.')]).reads[0]!.referenced).toBe(true);
  });
  it('a one-word title is not an anchor', () => {
    expect(run([read(1, '/r/test/cart.test.js', TEST), say(2, 'It works now.')]).reads[0]!.referenced).toBe(false);
  });
  it('an edit of a module the test imports references the test read (edit-subject)', () => {
    const r = run([read(1, '/r/test/cart.test.js', TEST), edit(2, '/r/src/cart.js')]);
    expect(r.reads[0]).toMatchObject({ referenced: true, reason: 'edit-subject' });
  });
  it('an import specifier without the source extension still names the subject (.js import of a .ts file, no extension)', () => {
    const ts = "import { total } from '../src/cart.js';\nimport { fmt } from './helpers/fmt';\n";
    expect(run([read(1, '/r/test/cart.spec.ts', ts), edit(2, '/r/src/cart.ts')]).reads[0]!.reason).toBe('edit-subject');
    expect(run([read(1, '/r/test/cart.spec.ts', ts), edit(2, '/r/test/helpers/fmt.ts')]).reads[0]!.reason).toBe('edit-subject');
  });
  it('an edit of the same-named source file references the test read (edit-subject)', () => {
    expect(run([read(1, '/r/test/money.test.js', 'x'), edit(2, '/r/src/money.js')]).reads[0]!.reason).toBe('edit-subject');
    expect(run([read(1, '/r/tests/test_money.py', 'x'), edit(2, '/r/app/money.py')]).reads[0]!.reason).toBe('edit-subject');
    expect(run([read(1, '/r/pkg/money_test.go', 'x'), edit(2, '/r/pkg/money.go')]).reads[0]!.reason).toBe('edit-subject');
  });
  it('an edit of an unrelated file, or of another test, does not count', () => {
    expect(run([read(1, '/r/test/cart.test.js', TEST), edit(2, '/r/src/slugify.js')]).reads[0]!.referenced).toBe(false);
    expect(run([read(1, '/r/test/money.test.js', 'x'), edit(2, '/r/test/money.spec.js')]).reads[0]!.referenced).toBe(false);
  });
  it('the rules apply only to files that look like tests', () => {
    const src = "import { total } from './cart.js';\nit('applies tax to the discounted subtotal', () => {});\n";
    expect(run([read(1, '/r/src/checkout.js', src), edit(2, '/r/src/cart.js')]).reads[0]!.referenced).toBe(false);
    expect(run([read(1, '/r/src/checkout.js', src), say(2, 'applies tax to the discounted subtotal')]).reads[0]!.referenced).toBe(false);
    expect(run([read(1, '/r/src/money.js', 'x'), edit(2, '/r/lib/money.js')]).reads[0]!.referenced).toBe(false);
  });
});

describe('ReadsPass: re-reads', () => {
  it('re-read with no edit and same hash is unchanged', () => {
    expect(run([read(1, 'a.ts', 'x'), read(3, 'a.ts', 'x')]).reads[1]!.reread).toEqual({ kind: 'unchanged', afterCompaction: false });
  });
  it('the first read is not a re-read', () => {
    expect(run([read(1, 'a.ts', 'x')]).reads[0]!.reread).toBeNull();
  });
  it('re-read after an edit is changed', () => {
    expect(run([read(1, 'a.ts', 'x'), edit(2, 'a.ts'), read(3, 'a.ts', 'x')]).reads[1]!.reread).toEqual({ kind: 'changed', afterCompaction: false });
  });
  it('same range with a different hash is changed (edited outside the agent)', () => {
    expect(run([read(1, 'a.ts', 'x'), read(3, 'a.ts', 'y')]).reads[1]!.reread!.kind).toBe('changed');
  });
  it('a different range with no edit is unchanged', () => {
    const r = run([read(1, 'a.ts', 'x\ny'), read(3, 'a.ts', 'q', { startLine: 40 })]);
    expect(r.reads[1]!.reread!.kind).toBe('unchanged');
  });
  it('an approximate Bash range never compares hashes', () => {
    const r = run([read(1, 'a.ts', 'x'), read(3, 'a.ts', 'y', { approximate: true })]);
    expect(r.reads[1]).toMatchObject({ reread: { kind: 'unchanged' }, approximateRange: true });
  });
  it('a tail read becomes exact once the file length is known', () => {
    const r = run([read(1, 'a.ts', '1\n2\n3\n4\n5'), read(3, 'a.ts', '4\n5', { approximate: true, fromEnd: 2, totalLines: null })]);
    expect(r.reads[1]!.approximateRange).toBe(false);
  });
  it('re-read across a compaction is flagged and counted for the proxy', () => {
    const r = run([read(1, 'a.ts', 'x'), read(2, 'b.ts', 'y'), compact(3), read(4, 'a.ts', 'x')]);
    expect(r.reads[2]!.reread).toEqual({ kind: 'unchanged', afterCompaction: true });
    expect(r.compactionRereads).toEqual({ readBefore: 2, rereadUnchangedAfter: 1, reattachedThenReread: 0 });
  });
  it('counts files the harness re-attached and the agent still re-read', () => {
    const r = run([read(1, 'a.ts', 'x'), compact(2), reattach(3, 'a.ts'), read(4, 'a.ts', 'x'), read(5, 'a.ts', 'x')]);
    expect(r.compactionRereads).toEqual({ readBefore: 1, rereadUnchangedAfter: 1, reattachedThenReread: 1 });
  });
  it('pools the proxy over several compactions', () => {
    const r = run([read(1, 'a.ts', 'x'), compact(2), read(3, 'b.ts', 'y'), compact(4), read(5, 'b.ts', 'y')]);
    expect(r.compactionRereads).toEqual({ readBefore: 3, rereadUnchangedAfter: 1, reattachedThenReread: 0 });
  });
});

describe('ReadsPass: carried cost', () => {
  it('carried cost counts requests until the segment ends', () => {
    // read (1000 chars = 250 tokens) then 3 requests then compaction then 2 requests; sonnet-like prices
    expect(run([read(1, 'a.ts', 'z'.repeat(1000)), req(2), req(3), req(4), compact(5), req(6)]).reads[0]!.carriedUSD).toBeCloseTo(
      (250 * (3.75 + 2 * 0.3)) / 1e6,
    );
  });
  it('uses the 1h write price when the first request wrote only 1h cache', () => {
    const r = run([read(1, 'a.ts', 'z'.repeat(1000)), req(2, U({ cacheWrite5m: 0, cacheWrite1h: 5 })), req(3)]);
    expect(r.reads[0]!.carriedUSD).toBeCloseTo((250 * (6 + 0.3)) / 1e6);
  });
  it('is 0 without a later request and null when the request is unpriced', () => {
    expect(run([read(1, 'a.ts', 'z')]).reads[0]!.carriedUSD).toBe(0);
    const unpriced: LedgerEvent = { kind: 'request', ...base(2), requestId: 'q', model: 'other', usage: U(), cwd: null, gitBranch: null };
    expect(run([read(1, 'a.ts', 'z'), unpriced]).reads[0]!.carriedUSD).toBeNull();
  });
});

describe('ReadsPass: subagents', () => {
  it('a subagent read is referenced by the parent using it after the Agent result', () => {
    const child = run([read(1, 'src/a.ts', 'export function applyDiscount(){}')]);
    const parent = new ReadsPass('main', prices);
    parent.adoptChildPending('toolu_1', child.pending);
    for (const e of [agentResult(5, 'toolu_1', 'found applyDiscount'), say(6, 'ok')]) parent.onEvent(e);
    expect(parent.finish().reads.find((r) => r.threadId === 'sub')).toMatchObject({ referenced: true, reason: 'symbol' });
  });
  it('the parent edits a file the subagent read', () => {
    const child = run([read(1, 'src/a.ts', 'x')]);
    const parent = new ReadsPass('main', prices);
    parent.adoptChildPending('toolu_1', child.pending);
    for (const e of [agentResult(5, 'toolu_1', 'done'), edit(6, 'src/a.ts')]) parent.onEvent(e);
    expect(parent.finish().reads.find((r) => r.threadId === 'sub')).toMatchObject({ referenced: true, reason: 'edit' });
  });
  it('parent events before the Agent result do not count, and unresolved reads stay pending', () => {
    const child = run([read(1, 'src/a.ts', 'export function applyDiscount(){}')]);
    const parent = new ReadsPass('main', prices);
    parent.adoptChildPending('toolu_1', child.pending);
    parent.onEvent(say(4, 'applyDiscount'));
    parent.onEvent(agentResult(5, 'toolu_1', 'nothing'));
    const out = parent.finish();
    expect(out.reads.find((r) => r.threadId === 'sub')!.referenced).toBe(false);
    expect(out.pending.map((p) => p.record.threadId)).toEqual(['sub']);
  });
});

describe('ReadsPass: review fixes 4-6', () => {
  it('a Bash re-read of a file is not a reference to the earlier read', () => {
    const p = new ReadsPass(T, prices);
    for (const e of [req(1, U(), '/r'), read(2, '/r/src/notes.txt', 'plain words only'), call(3, 'Bash', 'cat src/notes.txt'), read(4, '/r/src/notes.txt', 'plain words only')]) p.onEvent(e);
    const out = p.finish().reads;
    expect(out[0]).toMatchObject({ referenced: false, reason: null });
  });
  it('a Bash re-read with a description line is still a re-read (detection uses the command)', () => {
    const p = new ReadsPass(T, prices);
    const bash: LedgerEvent = { kind: 'tool_call', ...base(3), callId: 'cdesc', tool: 'Bash', toolClass: 'bash', mcpServer: null, paths: [], text: 'cat src/notes.txt\nShow the notes file', command: 'cat src/notes.txt' };
    for (const e of [req(1, U(), '/r'), read(2, '/r/src/notes.txt', 'plain words only'), bash, read(4, '/r/src/notes.txt', 'plain words only')]) p.onEvent(e);
    expect(p.finish().reads[0]).toMatchObject({ referenced: false, reason: null });
  });
  it('a Bash command that is not a read of the file still references it by path', () => {
    const p = new ReadsPass(T, prices);
    for (const e of [req(1, U(), '/r'), read(2, '/r/src/notes.txt', 'plain words only'), call(3, 'Bash', 'wc -l src/notes.txt | sort')]) p.onEvent(e);
    expect(p.finish().reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('a longer path that ends with the read path is a different file', () => {
    const p = new ReadsPass(T, prices);
    for (const e of [req(1, U(), '/r'), read(2, '/r/src/a.ts', 'plain words only'), say(3, 'See packages/other/src/a.ts and /elsewhere/src/a.ts.')]) p.onEvent(e);
    expect(p.finish().reads[0]).toMatchObject({ referenced: false });
  });
  it('the full repo-relative path or the absolute path references the read', () => {
    for (const text of ['Look at src/a.ts now.', 'Look at /r/src/a.ts now.', 'Look at ./src/a.ts now.']) {
      const p = new ReadsPass(T, prices);
      for (const e of [req(1, U(), '/r'), read(2, '/r/src/a.ts', 'plain words only'), say(3, text)]) p.onEvent(e);
      expect(p.finish().reads[0], text).toMatchObject({ referenced: true, reason: 'path' });
    }
  });
  it('a suffix references the read only while it is unique among the files seen in the session', () => {
    const unique = new ReadsPass(T, prices);
    for (const e of [req(1, U(), '/r'), read(2, '/r/src/util/helpers.ts', 'plain words'), say(3, 'util/helpers.ts is fine')]) unique.onEvent(e);
    expect(unique.finish().reads[0]).toMatchObject({ referenced: true, reason: 'path' });
    const ambiguous = new ReadsPass(T, prices);
    for (const e of [
      req(1, U(), '/r'),
      read(2, '/r/lib/util/helpers.ts', 'other words'),
      read(3, '/r/src/util/helpers.ts', 'plain words'),
      say(4, 'util/helpers.ts and helpers.ts are fine'),
    ])
      ambiguous.onEvent(e);
    expect(ambiguous.finish().reads.map((r) => r.referenced)).toEqual([false, false]);
  });
});

const CLAUDE = path.resolve('test/fixtures/claude/compaction-subagent');
const SESSION = '7a6a9ed0-5c89-4dfd-8974-9950a1d3c4d5';
const AGENT = '71c7d308f94630cb0';

async function passOver(events: AsyncGenerator<LedgerEvent>, pass: ReadsPass): Promise<void> {
  for await (const e of events) pass.onEvent(e);
}

describe('ReadsPass on parsed fixtures', () => {
  it('on the compaction fixture: math.js re-read after the edit and the compaction', async () => {
    const pass = new ReadsPass('main', prices);
    const ctx = { threadId: 'main', parentThreadId: null, spawnedByCallId: null, maxLineBytes: 1 << 26 };
    await passOver(parseClaudeThread(path.join(CLAUDE, `${SESSION}.jsonl`), ctx, newStats()).events, pass);
    const out = pass.finish();
    const math = out.reads.filter((r) => r.path === normalizePath('/repo/math.js'));
    expect(math).toHaveLength(2);
    expect(math[0]).toMatchObject({ referenced: true, reason: 'edit', reread: null });
    // The main agent edited math.js before /compact, so the re-read is changed, and across the compaction.
    expect(math[1]!.reread).toEqual({ kind: 'changed', afterCompaction: true });
    expect(out.compactionRereads).toEqual({ readBefore: 1, rereadUnchangedAfter: 0, reattachedThenReread: 1 });
  });
  it('the subagent read of math.js is resolved by the parent edit', async () => {
    const child = new ReadsPass(AGENT, prices);
    const sub = path.join(CLAUDE, SESSION, 'subagents', `agent-${AGENT}.jsonl`);
    const callId = 'toolu_80OAjFJ8cDrAD1ItD70ibn9G';
    await passOver(parseClaudeThread(sub, { threadId: AGENT, parentThreadId: 'main', spawnedByCallId: callId, maxLineBytes: 1 << 26 }, newStats()).events, child);
    const parent = new ReadsPass('main', prices);
    parent.adoptChildPending(callId, child.finish().pending);
    const ctx = { threadId: 'main', parentThreadId: null, spawnedByCallId: null, maxLineBytes: 1 << 26 };
    await passOver(parseClaudeThread(path.join(CLAUDE, `${SESSION}.jsonl`), ctx, newStats()).events, parent);
    expect(parent.finish().reads.find((r) => r.threadId === AGENT)).toMatchObject({ referenced: true, reason: 'edit' });
  });
  it('on the Codex fixture: cart.ts is read twice and referenced by the patch', async () => {
    const pass = new ReadsPass('codex', prices);
    await passOver(parseCodexThread(path.resolve('test/fixtures/codex/rollout-0.162.jsonl'), { maxLineBytes: 1 << 26 }, newStats()).events, pass);
    const reads = pass.finish().reads;
    expect(reads).toHaveLength(2);
    expect(reads[1]!.reread).toEqual({ kind: 'changed', afterCompaction: true }); // apply_patch in between
    expect(reads.every((r) => r.referenced)).toBe(true);
  });
});

describe('ReadsPass: test files are judged by their cwd-relative path', () => {
  it('a source file in a repo that lives under a folder named test is not a test file', () => {
    const r = run([req(0, U(), '/home/test/shop'), read(1, '/home/test/shop/src/checkout.js', "import { total } from './cart.js';\n"), edit(2, '/home/test/shop/src/cart.js')]);
    expect(r.reads[0]!.referenced).toBe(false);
  });
});

describe('ReadsPass: Windows paths match case-insensitively on both sides (final review C13)', () => {
  it('an upper-case read path matches a lower-case mention, and the reverse', () => {
    expect(run([read(1, 'Src/Widget.ts', 'x'), say(2, 'see src/widget.ts')], T, 'win32').reads[0]).toMatchObject({ referenced: true, reason: 'path' });
    expect(run([read(1, 'src/widget.ts', 'x'), say(2, 'see Src/Widget.ts')], T, 'win32').reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('a repo-relative suffix in another case matches too', () => {
    const r = run([req(0, U(), 'C:/Repo'), read(1, 'C:/Repo/src/Widget.ts', 'x'), say(2, 'I changed SRC/widget.ts.')], T, 'win32');
    expect(r.reads[0]).toMatchObject({ referenced: true, reason: 'path' });
  });
  it('stays case-sensitive elsewhere', () => {
    expect(run([read(1, '/repo/src/Widget.ts', 'x'), say(2, 'see /repo/src/widget.ts')], T, 'linux').reads[0]).toMatchObject({ referenced: false });
  });
});
