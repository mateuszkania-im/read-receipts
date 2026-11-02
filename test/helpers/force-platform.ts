// Loaded by vitest.config.ts when RR_TEST_PLATFORM is set: runs a suite under another platform's path
// rules (process.platform only; node:path and the file system stay the host's), so the win32 path cases
// can be checked on a POSIX machine before CI runs them on Windows.

import os from 'node:os';

const forced = process.env.RR_TEST_PLATFORM as NodeJS.Platform | undefined;
if (forced) {
  // os.tmpdir() reads TEMP on win32; keep the host's temp directory.
  process.env.TEMP = os.tmpdir();
  Object.defineProperty(process, 'platform', { value: forced });
}
