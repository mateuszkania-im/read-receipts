import { defineConfig } from 'vitest/config';

// `npm run perf`: the perf test alone, at PERF_MB (set by scripts/perf.mjs, 1024 by default there).
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
