// Replaced at bundle time by scripts/build.mjs (esbuild `define`); tsx and vitest see the fallback.
declare const __READ_RECEIPTS_VERSION__: string | undefined;

export const VERSION: string =
  typeof __READ_RECEIPTS_VERSION__ === 'string' ? __READ_RECEIPTS_VERSION__ : '0.0.0-dev';
