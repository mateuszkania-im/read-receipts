// Security review F3: deeply nested JSON in a log never crashes the run. Values nested deeper than 64
// levels are skipped and counted.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/pipeline.js';
import { depthExceeds } from '../../src/parse/common.js';
import { claudeLines, tmpDir, writeClaudeSession } from '../helpers/synth.js';
import { defaults } from '../helpers/report-defaults.js';

const nest = (d: number) => '['.repeat(d) + '1' + ']'.repeat(d);
const nestObj = (d: number) => '{"a":'.repeat(d) + '1' + '}'.repeat(d);

describe('depthExceeds', () => {
  it('walks iteratively, so even a million levels do not overflow the stack', () => {
    expect(depthExceeds(JSON.parse(nest(64)), 64)).toBe(false);
    expect(depthExceeds(JSON.parse(nest(65)), 64)).toBe(true);
    expect(depthExceeds(JSON.parse(nestObj(100_000)), 64)).toBe(true);
    expect(depthExceeds({ a: [1, { b: 'x' }], c: null }, 64)).toBe(false);
  });
});

describe('a run over a log with deeply nested tool definitions', () => {
  it('finishes, keeps the session, and counts the skipped values', async () => {
    const claudeDir = path.join(await tmpDir('rr-f3-'), 'claude');
    const sid = '11111111-2222-4333-8444-555555555555';
    const cwd = '/nonexistent/f3';
    const body = claudeLines(sid, [{ ts: '2026-10-25T09:00:00.000Z', cwd }]);
    const snap = (tools: string, defs: string) =>
      `{"type":"attachment","sessionId":"${sid}","cwd":"${cwd}","timestamp":"2026-10-25T09:00:01.000Z","uuid":"u-snap","attachment":{"type":"prompt_snapshot","systemPrompt":["s"],"tools":[{"name":"Read"},${tools}]}}\n` +
      `{"type":"attachment","sessionId":"${sid}","cwd":"${cwd}","timestamp":"2026-10-25T09:00:02.000Z","uuid":"u-def","attachment":{"type":"deferred_tools_delta","addedNames":["X"],"surfacedDefinitions":[{"name":"X","definition":${defs}}]}}\n`;
    await writeClaudeSession(claudeDir, cwd, sid, body + snap(nestObj(20_000), nest(20_000)));
    const r = await buildReport({ ...defaults, claudeDir, codexDir: null }, { gitRoot: async () => null, git: async () => null });
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.files.deepValues).toBe(2);
    expect(r.warnings.join('\n')).toMatch(/2 JSON values nested deeper than 64 levels skipped/);
  });
});
