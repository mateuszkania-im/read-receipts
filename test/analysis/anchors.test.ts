import { describe, expect, it } from 'vitest';
import { extractAnchors, extractTestTitles, isTestPath } from '../../src/analysis/anchors.js';
import { STOPLIST } from '../../src/analysis/stoplist.js';

describe('extractAnchors', () => {
  it('extracts declared identifiers and headings, drops stoplist words', () => {
    expect(extractAnchors('export function applyDiscount(a) {}\nconst data = 1\nclass CartTotals {}\n# Rate limiter')).toEqual([
      'applyDiscount',
      'CartTotals',
      'Rate limiter',
    ]);
  });
  it('caps at 30 anchors', () => {
    const src = Array.from({ length: 40 }, (_, i) => `function handler${i}() {}`).join('\n');
    const a = extractAnchors(src);
    expect(a).toHaveLength(30);
    expect(a[0]).toBe('handler0');
  });
  it('keeps the order of appearance across patterns and dedupes', () => {
    expect(extractAnchors('## Setup steps\ndef load_users():\n    pass\nstruct Point3 {}\ndef load_users(): ...')).toEqual([
      'Setup steps',
      'load_users',
      'Point3',
    ]);
  });
  it('reads JSON and YAML top-level keys', () => {
    expect(extractAnchors('{\n  "scripts": {},\n  "devDependencies": {}\n}')).toEqual(['devDependencies']);
    expect(extractAnchors('services:\n  web-app:\n      image: x\n')).toEqual(['web-app']);
  });
  it('ignores identifiers shorter than 4 characters', () => {
    expect(extractAnchors('const abc = 1\nfn run() {}')).toEqual([]);
  });
  it('matches stoplist words case-insensitively', () => {
    expect(extractAnchors('class Config {}\nconst Props = 1')).toEqual([]);
  });
});

describe('extractAnchors: review fixes 4-6', () => {
  it('strips the Read line numbers (tab and arrow forms) so headings and keys are found', () => {
    expect(extractAnchors('     1\t# Rate limiter design\n     2\tapiKey: x\n     3\tretry_count: 3')).toEqual(['Rate limiter design', 'apiKey', 'retry_count']);
    expect(extractAnchors('     1\u2192## Token bucket notes\n     2\u2192maxBurst: 10')).toEqual(['Token bucket notes', 'maxBurst']);
  });
  it('keeps only identifier-shaped anchors: plain English words never count', () => {
    const prose = [
      'This function returns the type which should be used whenever the class above changes.',
      '// Here we define const value that matters, then module handles everything.',
      'Overview:',
      '# Overview',
      'timeout: 30',
    ].join('\n');
    expect(extractAnchors(prose)).toEqual([]);
  });
  it('identifier shapes: camelCase, PascalCase, snake_case, kebab-case, digits and dots', () => {
    expect(extractAnchors('class RateLimiter {}\nfunction tryAcquire() {}\ndef load_users(): pass\nweb-app:\nconst http2Agent = 1\nconst Limiter = 2\nversion.lock:')).toEqual([
      'RateLimiter',
      'tryAcquire',
      'load_users',
      'web-app',
      'http2Agent',
      'version.lock',
    ]);
  });
});

describe('STOPLIST', () => {
  it('has 200 lowercase words', () => {
    expect(STOPLIST.size).toBe(200);
    for (const w of STOPLIST) expect(w).toBe(w.toLowerCase());
  });
});

describe('test files', () => {
  it('isTestPath knows the common test file layouts', () => {
    for (const p of ['test/cart.test.js', 'src/cart.spec.ts', '/r/__tests__/x.js', 'tests/test_money.py', 'pkg/money_test.go', 'tests/conftest.py', 'test/helpers.js']) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ['src/cart.js', 'src/testing.ts', 'docs/test-plan.md', 'src/latest.ts', 'contest/x.js']) expect(isTestPath(p), p).toBe(false);
  });
  it('extractTestTitles keeps multi-word titles of it/test/describe, in order, deduped', () => {
    const c = "1\tdescribe('cart totals', () => {\n2\t  it(\"adds tax\", () => {});\n3\t  it.only('works', () => {});\n4\t  test(`x ${y} z`, () => {});\n5\t  it('adds tax', () => {});\n";
    expect(extractTestTitles(c)).toEqual(['cart totals', 'adds tax']);
  });
});
