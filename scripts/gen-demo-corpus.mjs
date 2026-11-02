#!/usr/bin/env node
// A fictional demo corpus for the README sample report: Claude Code and Codex sessions on two invented
// repositories (acme-shop, acme-billing) over October 2026. Every path, name, branch, prompt and line of
// code is invented; nothing comes from real logs. Deterministic (seeded), so the sample is reproducible.
//
//   node scripts/gen-demo-corpus.mjs --out /tmp/read-receipts-demo

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_REPOS = {
  shop: { root: '/home/dev/acme-shop', origin: 'git@github.com:acme/shop.git' },
  billing: { root: '/home/dev/acme-billing', origin: 'git@github.com:acme/billing.git' },
};

/** The trimmed CLAUDE.md lands on this day: the before/after compare splits here. */
export const DEMO_SPLIT = '2026-10-18T00:00:00.000Z';

/** Fictional PRs, as `gh pr list` would return them, by origin. */
export const DEMO_PRS = {
  [DEMO_REPOS.shop.origin]: [
    pr(412, 'feat/cart-discounts', 'MERGED', '2026-10-06', '2026-10-10', 'Stackable percentage discounts in the cart'),
    pr(415, 'chore/deps-october', 'CLOSED', '2026-10-09', '2026-10-13', 'Bump framework and test runner'),
    pr(418, 'fix/tax-rounding', 'MERGED', '2026-10-13', '2026-10-16', 'Round tax per line, not per order'),
    pr(421, 'feat/checkout-redesign', 'OPEN', '2026-10-20', null, 'Checkout: one-page layout'),
    pr(426, 'fix/coupon-expiry', 'MERGED', '2026-10-27', '2026-10-29', 'Reject expired coupons at apply time'),
  ],
  [DEMO_REPOS.billing.origin]: [
    pr(88, 'feat/ledger-postings', 'MERGED', '2026-10-07', '2026-10-15', 'Double-entry postings for invoices'),
    pr(91, 'fix/invoice-pdf-fonts', 'MERGED', '2026-10-21', '2026-10-23', 'Embed fonts in invoice PDFs'),
    pr(94, 'feat/dunning-emails', 'OPEN', '2026-10-28', null, 'Dunning emails for overdue invoices'),
  ],
};

function pr(number, headRefName, state, created, done, title) {
  const end = done === null ? null : `${done}T16:00:00Z`;
  return {
    number,
    headRefName,
    state,
    createdAt: `${created}T08:00:00Z`,
    mergedAt: state === 'MERGED' ? end : null,
    closedAt: state === 'OPEN' ? null : end,
    title,
    url: `https://github.com/acme/${headRefName.includes('ledger') || headRefName.includes('invoice') || headRefName.includes('dunning') ? 'billing' : 'shop'}/pull/${number}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// Deterministic randomness.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------
// The fictional repositories: files, the identifiers each declares, and their size in lines.

const SHOP_FILES = [
  ['src/cart/cart.ts', ['cartTotal', 'addLineItem', 'removeLineItem', 'CartState'], 140],
  ['src/cart/discounts.ts', ['applyDiscount', 'stackDiscounts', 'DiscountRule'], 120],
  ['src/cart/tax.ts', ['lineTax', 'orderTax', 'TaxRegion'], 90],
  ['src/cart/coupons.ts', ['redeemCoupon', 'couponIsExpired', 'CouponCode'], 80],
  ['src/lib/money.ts', ['roundMoney', 'formatMoney', 'MinorUnits'], 70],
  ['src/api/orders.ts', ['createOrder', 'fetchOrder', 'OrderPayload'], 160],
  ['src/api/client.ts', ['apiClient', 'withRetry', 'ApiError'], 110],
  ['src/ui/CartPage.tsx', ['CartPage', 'CartLineRow', 'useCartTotals'], 210],
  ['src/ui/Checkout.tsx', ['CheckoutForm', 'PaymentStep', 'useCheckoutState'], 260],
  ['src/ui/theme.ts', ['themeTokens', 'spacingScale'], 120],
  ['test/cart.test.ts', ['describeCartTotals', 'cartFixture'], 180],
  ['test/checkout.test.tsx', ['renderCheckout', 'checkoutFixture'], 150],
  ['docs/architecture.md', ['Cart and pricing pipeline', 'Order lifecycle'], 140],
  ['README.md', ['Getting started', 'Running the tests'], 90],
  ['package.json', ['devDependencies', 'packageManager'], 60],
  ['src/generated/graphql.ts', ['GeneratedOrderFields', 'GeneratedCartFields'], 1400],
  ['pnpm-lock.yaml', ['lockfileVersion', 'importers'], 2600],
];

const BILLING_FILES = [
  ['services/invoice/render.py', ['render_invoice', 'InvoiceTemplate', 'embed_fonts'], 190],
  ['services/invoice/models.py', ['InvoiceLine', 'invoice_total', 'InvoiceStatus'], 150],
  ['services/ledger/post.py', ['post_invoice', 'LedgerEntry', 'balance_check'], 170],
  ['services/ledger/accounts.py', ['AccountCode', 'chart_of_accounts'], 110],
  ['services/dunning/schedule.py', ['dunning_schedule', 'overdue_invoices'], 120],
  ['migrations/0042_ledger.sql', ['ledger_entries', 'ledger_accounts'], 80],
  ['tests/test_invoice.py', ['test_invoice_total', 'invoice_factory'], 160],
  ['tests/test_ledger.py', ['test_posting_balances', 'ledger_factory'], 140],
  ['pyproject.toml', ['tool_pytest', 'project_deps'], 70],
  ['README.md', ['Local setup', 'Running migrations'], 80],
  ['vendor/openapi.json', ['paths', 'components'], 1900],
];

const FILLER_TS = [
  '  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);',
  '  if (!rule.enabled) return amount;',
  '  // Amounts are integers in minor units (cents) to avoid float drift.',
  '  return { ...state, updatedAt: clock.now() };',
  '  const region = regions.get(address.country) ?? defaultRegion;',
  '  for (const line of order.lines) totals.push(line.amount);',
  '  throw new Error(`unknown currency ${currency}`);',
  '  await queue.enqueue({ kind: "order.created", orderId: order.id });',
];
const FILLER_PY = [
  '    total = sum(line.amount for line in self.lines)',
  '    if not entries:',
  '        raise ValueError("no ledger entries to post")',
  '    # Amounts are Decimal, quantised to the currency exponent.',
  '    session.add_all(entries)',
  '    return InvoiceStatus.OPEN if balance > 0 else InvoiceStatus.PAID',
];

function fileContent(rel, symbols, lines) {
  const ext = path.extname(rel);
  const out = [];
  const filler = ext === '.py' ? FILLER_PY : FILLER_TS;
  const decl = (s) => {
    if (ext === '.md') return `## ${s}`;
    if (ext === '.json') return `  "${s}": {`;
    if (ext === '.yaml' || ext === '.toml') return `${s}:`;
    if (ext === '.sql') return `CREATE TABLE ${s} (`;
    if (ext === '.py') return /^[A-Z]/.test(s) ? `class ${s}:` : `def ${s}(*args):`;
    return /^[A-Z]/.test(s) ? `export interface ${s} {` : `export function ${s}(input) {`;
  };
  const every = Math.max(4, Math.floor(lines / symbols.length));
  let k = 0;
  for (let i = 0; i < lines; i++) {
    if (i % every === 0 && k < symbols.length) out.push(decl(symbols[k++]));
    else out.push(ext === '.md' ? 'The pricing pipeline runs cart, discounts, tax and money rounding in that order.' : ext === '.json' || ext === '.yaml' ? `    "k${i}": "v${i}",` : filler[i % filler.length]);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------
// Claude Code sessions.

const SYSTEM_PROMPT = 'You are Claude Code, an interactive coding assistant. '.repeat(1100);
const TOOL_SCHEMAS = [
  ['Read', 2600],
  ['Edit', 3100],
  ['Write', 1900],
  ['Bash', 7800],
  ['Grep', 4200],
  ['Glob', 1500],
  ['Agent', 5200],
  ['Skill', 1300],
].map(([name, n]) => ({ name, description: `Tool ${name}. ${'Usage notes. '.repeat(n / 13)}`, schema: { type: 'object' } }));
const CLAUDE_MD_BEFORE = `# acme engineering\n\n${'- Prefer small pure functions; keep money in minor units; run the full test suite before you finish; explain trade-offs in the PR body.\n'.repeat(180)}`;
const CLAUDE_MD_AFTER = `# acme engineering\n\n${'- Money is minor units. Run pnpm test before you finish.\n'.repeat(70)}`;
const SKILLS = `${'- release-notes: draft release notes from merged PRs\n- db-migrate: write and check a migration\n'.repeat(24)}`;

const PROMPTS = [
  'Discounts should stack: a percentage coupon on top of a member discount. Make it work and add tests.',
  'Tax is off by a cent on multi-line orders. Find out why and fix it.',
  'The checkout page should be a single page. Start with the payment step.',
  'Coupons past their expiry date are still accepted. Fix that.',
  'Bump the framework and the test runner, keep everything green.',
  'Try a GraphQL client for the orders API, just a spike.',
  'Post invoices to the ledger as double-entry postings.',
  'Invoice PDFs render with the wrong font on Linux. Embed the fonts.',
  'Add dunning emails for invoices that are 7, 14 and 30 days overdue.',
  'Why is the cart total wrong when an item is removed and added again?',
];

/** Session plans: [repo, branch, prompt index, day, model, size]. Size = number of steps. */
const CLAUDE_PLAN = [
  ['shop', 'feat/cart-discounts', 0, '2026-10-06', 'claude-sonnet-5-5', 34],
  ['shop', 'feat/cart-discounts', 0, '2026-10-07', 'claude-sonnet-5-5', 26],
  ['billing', 'feat/ledger-postings', 6, '2026-10-07', 'claude-opus-5-5', 30],
  ['shop', 'feat/cart-discounts', 0, '2026-10-08', 'claude-sonnet-5-5', 18],
  ['shop', 'main', 9, '2026-10-08', 'claude-sonnet-5-5', 12],
  ['billing', 'feat/ledger-postings', 6, '2026-10-09', 'claude-opus-5-5', 40],
  ['shop', 'chore/deps-october', 4, '2026-10-09', 'claude-sonnet-5-5', 22],
  ['shop', 'chore/deps-october', 4, '2026-10-10', 'claude-sonnet-5-5', 28],
  ['shop', 'feat/cart-discounts', 0, '2026-10-10', 'claude-sonnet-5-5', 14],
  ['billing', 'feat/ledger-postings', 6, '2026-10-12', 'claude-sonnet-5-5', 24],
  ['shop', 'spike/graphql-client', 5, '2026-10-12', 'claude-opus-5-5', 36],
  ['shop', 'fix/tax-rounding', 1, '2026-10-13', 'claude-sonnet-5-5', 30],
  ['shop', 'fix/tax-rounding', 1, '2026-10-14', 'claude-sonnet-5-5', 20],
  ['billing', 'feat/ledger-postings', 6, '2026-10-14', 'claude-sonnet-5-5', 16],
  ['shop', 'fix/tax-rounding', 1, '2026-10-15', 'claude-sonnet-5-5', 12],
  ['shop', 'spike/graphql-client', 5, '2026-10-16', 'claude-sonnet-5-5', 26],
  ['shop', 'main', 9, '2026-10-17', 'claude-sonnet-5-5', 10],
  // CLAUDE.md trimmed from here on.
  ['shop', 'feat/checkout-redesign', 2, '2026-10-20', 'claude-sonnet-5-5', 30],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-21', 'claude-sonnet-5-5', 22],
  ['billing', 'fix/invoice-pdf-fonts', 7, '2026-10-21', 'claude-sonnet-5-5', 18],
  ['billing', 'fix/invoice-pdf-fonts', 7, '2026-10-22', 'claude-sonnet-5-5', 14],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-22', 'claude-opus-5-5', 32],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-23', 'claude-sonnet-5-5', 16],
  ['shop', 'main', 9, '2026-10-24', 'claude-sonnet-5-5', 8],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-26', 'claude-sonnet-5-5', 20],
  ['shop', 'fix/coupon-expiry', 3, '2026-10-27', 'claude-sonnet-5-5', 18],
  ['shop', 'fix/coupon-expiry', 3, '2026-10-28', 'claude-sonnet-5-5', 12],
  ['billing', 'feat/dunning-emails', 8, '2026-10-28', 'claude-opus-5-5', 28],
  ['billing', 'feat/dunning-emails', 8, '2026-10-29', 'claude-sonnet-5-5', 22],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-29', 'claude-sonnet-5-5', 14],
  ['billing', 'feat/dunning-emails', 8, '2026-10-30', 'claude-sonnet-5-5', 18],
  ['shop', 'main', 9, '2026-10-30', 'claude-haiku-5-5', 10],
];

/** Codex sessions: [repo, branch, prompt index, day, size]. */
const CODEX_PLAN = [
  ['billing', 'feat/ledger-postings', 6, '2026-10-11', 14],
  ['billing', 'feat/ledger-postings', 6, '2026-10-13', 10],
  ['shop', 'fix/tax-rounding', 1, '2026-10-15', 12],
  ['billing', 'fix/invoice-pdf-fonts', 7, '2026-10-22', 10],
  ['shop', 'feat/checkout-redesign', 2, '2026-10-25', 16],
  ['billing', 'feat/dunning-emails', 8, '2026-10-30', 12],
];

const hex = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = (rnd) => `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-8${hex(rnd, 3)}-${hex(rnd, 12)}`;
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const est = (s) => Math.ceil(s.length / 4);

class ClaudeWriter {
  constructor(rnd, ctx) {
    this.rnd = rnd;
    this.ctx = ctx;
    this.lines = [];
    this.t = Date.parse(ctx.start);
    this.msg = 0;
    this.tool = 0;
    // Context size in tokens: what the next request re-sends.
    this.context = 0;
    this.pending = 0;
  }
  base(extra = {}) {
    this.t += 2000 + Math.floor(this.rnd() * 9000);
    const c = this.ctx;
    return {
      parentUuid: null,
      isSidechain: c.agentId !== undefined,
      ...(c.agentId !== undefined ? { agentId: c.agentId } : {}),
      userType: 'external',
      entrypoint: 'cli',
      cwd: c.cwd,
      sessionId: c.sessionId,
      version: '2.1.316',
      gitBranch: c.branch,
      type: 'user',
      uuid: uuid(this.rnd),
      timestamp: new Date(this.t).toISOString(),
      ...extra,
    };
  }
  attach(attachment, tokens) {
    this.lines.push({ ...this.base(), type: 'attachment', attachment });
    this.pending += tokens;
  }
  user(content, tokens) {
    this.lines.push({ ...this.base(), message: { role: 'user', content } });
    this.pending += tokens;
  }
  /** One model response: usage follows the context the request re-sent. */
  assistant(content, outTokens) {
    const write = this.pending;
    const read = this.context;
    this.context += write + outTokens;
    this.pending = 0;
    this.lines.push({
      ...this.base(),
      type: 'assistant',
      message: {
        model: this.ctx.model,
        id: `msg_demo${hex(this.rnd, 20)}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 3 + Math.floor(this.rnd() * 12), cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: outTokens, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard' },
      },
    });
  }
  call(name, input, text) {
    const id = `toolu_demo${String(++this.tool).padStart(4, '0')}${hex(this.rnd, 8)}`;
    const content = [];
    if (text) content.push({ type: 'text', text });
    content.push({ type: 'tool_use', id, name, input });
    this.assistant(content, 80 + Math.floor(this.rnd() * 500));
    return id;
  }
  result(id, content, toolUseResult, isError = false) {
    const text = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('');
    this.lines.push({ ...this.base(), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] }, ...(toolUseResult ? { toolUseResult } : {}) });
    this.pending += est(text);
  }
  read(rel, content) {
    const abs = `${this.ctx.root}/${rel}`;
    const id = this.call('Read', { file_path: abs });
    const numbered = content.split('\n').slice(0, -1).map((l, i) => `${i + 1}\t${l}`).join('\n');
    const n = content.split('\n').length - 1;
    this.result(id, numbered, { type: 'text', file: { filePath: abs, content, numLines: n, startLine: 1, totalLines: n } });
  }
  compact() {
    this.lines.push({ ...this.base(), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: this.context } });
    this.context = 0;
    this.pending = this.ctx.baseTokens;
    this.lines.push({ ...this.base(), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: `This session is being continued from a previous conversation. ${'Summary of the work so far. '.repeat(60)}` } });
    this.pending += 450;
  }
}

function writeClaudeSession(outDir, rnd, plan, index) {
  const [repoKey, branch, promptIndex, day, model, size] = plan;
  const repo = DEMO_REPOS[repoKey];
  const files = repoKey === 'shop' ? SHOP_FILES : BILLING_FILES;
  const sessionId = uuid(rnd);
  const start = `${day}T${String(8 + (index % 9)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00.000Z`;
  const trimmed = start >= DEMO_SPLIT;
  const claudeMd = trimmed ? CLAUDE_MD_AFTER : CLAUDE_MD_BEFORE;
  const baseTokens = est(SYSTEM_PROMPT) + TOOL_SCHEMAS.reduce((a, t) => a + est(t.description), 0) + est(claudeMd) + est(SKILLS);
  const w = new ClaudeWriter(rnd, { cwd: repo.root, root: repo.root, sessionId, branch, model, start, baseTokens });

  w.attach({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'branch status: clean', toolUseID: uuid(rnd) }, 12);
  w.user(PROMPTS[promptIndex], est(PROMPTS[promptIndex]));
  w.attach({ type: 'instructions', files: [{ path: `${repo.root}/CLAUDE.md`, type: 'Project', content: claudeMd }] }, est(claudeMd));
  w.attach({ type: 'skill_listing', names: ['release-notes', 'db-migrate'], digests: ['d1', 'd2'], content: SKILLS, skillCount: 2 }, est(SKILLS));
  w.attach({ type: 'prompt_snapshot', systemPrompt: [SYSTEM_PROMPT], tools: TOOL_SCHEMAS }, est(SYSTEM_PROMPT) + TOOL_SCHEMAS.reduce((a, t) => a + est(t.description), 0));
  const prLink = DEMO_PRS[repo.origin].find((p) => p.headRefName === branch);
  if (prLink && rnd() < 0.3) w.attach({ type: 'remote_session_change', pr: prLink.url, commit: null, url: null }, 0);

  const read = new Map();
  const mention = [];
  let compacted = false;
  const big = files.filter(([, , n]) => n > 1000);
  const normal = files.filter(([, , n]) => n <= 1000);
  const steps = Math.round(size * 1.6);
  for (let step = 0; step < steps; step++) {
    const r = rnd();
    if (!compacted && size >= 26 && step === Math.floor(steps * 0.6)) {
      w.compact();
      compacted = true;
      continue;
    }
    if (r < 0.42) {
      // A read. Large generated or vendored files are read now and then and rarely referred to again.
      const unread = normal.filter(([f]) => !read.has(f));
      const [rel, symbols, lines] = rnd() < 0.08 ? pick(rnd, big) : pick(rnd, unread.length > 0 && rnd() < 0.85 ? unread : normal);
      w.read(rel, fileContent(rel, symbols, lines));
      const again = read.has(rel);
      read.set(rel, symbols);
      if (!again && rnd() < 0.7) mention.push([rel, symbols]);
    } else if (r < 0.64 && mention.length > 0) {
      // Refer back to a file: name an identifier or edit it.
      const [rel, symbols] = mention.splice(Math.floor(rnd() * mention.length), 1)[0];
      if (rnd() < 0.5) {
        const id = w.call('Edit', { file_path: `${repo.root}/${rel}`, old_string: 'return amount;', new_string: 'return roundMoney(amount);', replace_all: false }, 'Making the change.');
        w.result(id, 'The file has been updated successfully.', { filePath: `${repo.root}/${rel}`, oldString: 'return amount;', newString: 'return roundMoney(amount);', structuredPatch: [], userModified: false });
      } else {
        w.assistant([{ type: 'text', text: `The behaviour comes from ${symbols[0]} in ${rel}; it runs before the totals are rounded.` }], 120 + Math.floor(rnd() * 300));
      }
    } else if (r < 0.74) {
      const id = w.call('Bash', { command: repoKey === 'shop' ? 'pnpm test --silent' : 'uv run pytest -q', description: 'Run the tests' });
      const fail = rnd() < 0.3;
      w.result(id, `${'.'.repeat(40 + Math.floor(rnd() * 80))}\n${fail ? '1 failed, ' : ''}${80 + Math.floor(rnd() * 40)} passed in ${(2 + rnd() * 6).toFixed(2)}s\n${fail ? 'FAILED: expected 1999 to equal 2000\n'.repeat(12) : ''}`);
    } else if (r < 0.84) {
      const id = w.call('Grep', { pattern: pick(rnd, files)[1][0], path: repo.root, output_mode: 'content' });
      w.result(id, Array.from({ length: 4 + Math.floor(rnd() * 20) }, (_, i) => `${pick(rnd, files)[0]}:${i + 3}: match`).join('\n'));
    } else if (r < 0.89) {
      const id = w.call('mcp__linear__get_issue', { id: `ACME-${100 + Math.floor(rnd() * 300)}` });
      w.result(id, [{ type: 'text', text: `${'Issue description and acceptance criteria. '.repeat(30 + Math.floor(rnd() * 40))}` }]);
    } else if (r < 0.93 && w.ctx.agentId === undefined && step < steps - 3) {
      const agentId = hex(rnd, 17);
      const id = w.call('Agent', { description: 'Map the code paths', prompt: 'Find every place that rounds money and report file and function.', subagent_type: 'Explore' });
      writeSubagent(outDir, rnd, { repo, files, sessionId, branch, agentId, start: new Date(w.t).toISOString(), toolUseId: id, baseTokens });
      w.result(id, [{ type: 'text', text: `Rounding happens in ${files[0][1][0]} and ${files[2][1][0]}. ${'Details. '.repeat(40)}` }], { status: 'completed', agentId, agentType: 'Explore', content: [] });
    } else {
      w.assistant([{ type: 'text', text: 'Checking the next part of the change.' }], 60 + Math.floor(rnd() * 200));
    }
    // Long sessions re-read what they already saw, more so after a compaction.
    if (read.size > 2 && rnd() < (compacted ? 0.14 : 0.04)) {
      const [rel, symbols] = pick(rnd, [...read]);
      const entry = files.find(([f]) => f === rel);
      w.read(rel, fileContent(rel, symbols, entry[2]));
    }
  }
  w.assistant([{ type: 'text', text: 'Done. The change is in place and the tests pass.' }], 300 + Math.floor(rnd() * 600));

  const dir = path.join(outDir, 'claude', repo.root.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${w.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function writeSubagent(outDir, rnd, o) {
  const w = new ClaudeWriter(rnd, { cwd: o.repo.root, root: o.repo.root, sessionId: o.sessionId, branch: o.branch, model: 'claude-sonnet-5-5', start: o.start, agentId: o.agentId, baseTokens: 0 });
  w.user('Find every place that rounds money and report file and function.', 20);
  w.pending += Math.floor(o.baseTokens * 0.6);
  const n = 4 + Math.floor(rnd() * 6);
  const named = [];
  for (let i = 0; i < n; i++) {
    const [rel, symbols, lines] = pick(rnd, o.files);
    w.read(rel, fileContent(rel, symbols, Math.min(lines, 400)));
    // The report names most of the files it looked at; the rest only ruled something out.
    if (rnd() < 0.7) named.push(rel);
  }
  w.assistant([{ type: 'text', text: `Rounding happens in these files: ${named.join(', ') || 'none'}.` }], 400);
  const dir = path.join(outDir, 'claude', o.repo.root.replace(/[^A-Za-z0-9]/g, '-'), o.sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `agent-${o.agentId}.jsonl`), `${w.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  writeFileSync(path.join(dir, `agent-${o.agentId}.meta.json`), `${JSON.stringify({ agentType: 'Explore', isBuiltIn: true, description: 'Map the code paths', toolUseId: o.toolUseId, spawnDepth: 1, finished: true })}\n`);
}

// ---------------------------------------------------------------------------------------------------
// Codex sessions (the 0.162 rollout shape).

function writeCodexSession(outDir, rnd, plan, index) {
  const [repoKey, branch, promptIndex, day, size] = plan;
  const repo = DEMO_REPOS[repoKey];
  const files = repoKey === 'shop' ? SHOP_FILES : BILLING_FILES;
  const id = `0199${hex(rnd, 4)}-${hex(rnd, 4)}-7${hex(rnd, 3)}-8${hex(rnd, 3)}-${hex(rnd, 12)}`;
  let t = Date.parse(`${day}T${String(9 + index).padStart(2, '0')}:15:00.000Z`);
  let ordinal = 0;
  const lines = [];
  const push = (type, payload) => {
    t += 3000 + Math.floor(rnd() * 8000);
    lines.push({ timestamp: new Date(t).toISOString(), type, payload, ordinal: ordinal++ });
  };
  const agentsMd = `# AGENTS.md instructions for ${repo.root}\n\n<INSTRUCTIONS>\n${'Run the tests before you finish. Keep money in minor units.\n'.repeat(30)}</INSTRUCTIONS>`;
  push('session_meta', { id, timestamp: new Date(t).toISOString(), cwd: repo.root, originator: 'codex_cli_rs', cli_version: '0.162.0-alpha.17.2', model_provider: 'openai', git: { branch, commit_hash: hex(rnd, 40) }, base_instructions: { text: 'You are Codex, a coding agent. '.repeat(700) } });
  push('turn_context', { turn_id: 'turn-1', cwd: repo.root, model: 'gpt-6-astra', effort: 'medium' });
  push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: agentsMd }] });
  push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPTS[promptIndex] }] });
  let ctx = 9000;
  let resp = 0;
  const usage = (added, out) => {
    ctx += added;
    push('token_usage_record', { response_id: `resp_${String(++resp).padStart(4, '0')}`, turn_id: 'turn-1', usage: { input_tokens: ctx, cached_input_tokens: Math.max(0, ctx - added), cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: Math.floor(out / 3), total_tokens: ctx + out } });
    ctx += out;
  };
  for (let step = 0; step < size; step++) {
    const callId = `call_${hex(rnd, 10)}`;
    if (rnd() < 0.55) {
      const [rel, symbols, lines] = pick(rnd, files);
      const content = fileContent(rel, symbols, Math.min(lines, 500));
      const cmd = `cat ${rel}`;
      push('response_item', { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `return await tools.shell({ command: '${cmd}' });` });
      push('event_msg', { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', id: `cmd-${step}`, command: ['bash', '-lc', cmd], cwd: repo.root, exit_code: 0, aggregated_output: content, parsed_cmd: [{ type: 'read', cmd, name: path.basename(rel), path: rel }] } });
      push('response_item', { type: 'custom_tool_call_output', call_id: callId, output: content });
      usage(est(content) + 40, 150 + Math.floor(rnd() * 400));
    } else if (rnd() < 0.5) {
      const [rel] = pick(rnd, files.filter(([, , n]) => n < 1000));
      push('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: `*** Begin Patch\n*** Update File: ${rel}\n@@\n-  return amount;\n+  return roundMoney(amount);\n*** End Patch\n` });
      push('response_item', { type: 'custom_tool_call_output', call_id: callId, output: `Success. Updated the following files:\nM ${rel}\n` });
      usage(80, 300 + Math.floor(rnd() * 500));
    } else {
      const cmd = repoKey === 'shop' ? 'pnpm test --silent' : 'uv run pytest -q';
      const out = `${90 + Math.floor(rnd() * 30)} passed in ${(2 + rnd() * 5).toFixed(2)}s\n`;
      push('response_item', { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `return await tools.shell({ command: '${cmd}' });` });
      push('event_msg', { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', id: `cmd-${step}`, command: ['bash', '-lc', cmd], cwd: repo.root, exit_code: 0, aggregated_output: out, parsed_cmd: [{ type: 'unknown', cmd }] } });
      push('response_item', { type: 'custom_tool_call_output', call_id: callId, output: out });
      usage(60, 100 + Math.floor(rnd() * 200));
    }
  }
  push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done; the tests pass.' }] });
  const d = new Date(Date.parse(day));
  const dir = path.join(outDir, 'codex', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.parse(lines[0].timestamp)).toISOString().slice(0, 19).replace(/:/g, '-');
  writeFileSync(path.join(dir, `rollout-${stamp}-${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** Writes the corpus under `outDir/claude` and `outDir/codex` (both replaced). */
export function generateDemoCorpus(outDir) {
  rmSync(path.join(outDir, 'claude'), { recursive: true, force: true });
  rmSync(path.join(outDir, 'codex'), { recursive: true, force: true });
  const rnd = mulberry32(20261101);
  CLAUDE_PLAN.forEach((p, i) => writeClaudeSession(outDir, rnd, p, i));
  CODEX_PLAN.forEach((p, i) => writeCodexSession(outDir, rnd, p, i));
  return { claudeDir: path.join(outDir, 'claude'), codexDir: path.join(outDir, 'codex') };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : '/tmp/read-receipts-demo';
  if (!out) throw new Error('usage: gen-demo-corpus.mjs --out <dir>');
  const dirs = generateDemoCorpus(path.resolve(out));
  process.stdout.write(`demo corpus written to ${dirs.claudeDir} and ${dirs.codexDir}\n`);
}
