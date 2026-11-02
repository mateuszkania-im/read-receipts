import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Windows runners start processes slowly (git spawns in attribution tests).
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
  },
});
