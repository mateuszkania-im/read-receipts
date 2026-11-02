import type { ReportOptions } from '../../src/report/types.js';

export const defaults: ReportOptions = {
  claudeDir: null,
  codexDir: null,
  since: null,
  until: null,
  projects: [],
  agent: 'all',
  includeSubagents: true,
  pricesPath: null,
  gh: false,
  maxLineMb: 256,
  compare: null,
  sessionPrefix: null,
  now: '2026-11-02T00:00:00.000Z',
};
