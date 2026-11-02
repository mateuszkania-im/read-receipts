import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // RR_TEST_PLATFORM=win32 runs suites under win32 path rules on any host (see the helper).
    ...(process.env.RR_TEST_PLATFORM ? { setupFiles: ['test/helpers/force-platform.ts'] } : {}),
    // Windows runners start processes slowly (git spawns in attribution tests).
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
  },
});
