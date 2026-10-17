import { defineConfig } from 'vitest/config';

// The first PGlite (PostgreSQL in WebAssembly) of each test file takes 4.5-5 s to start while
// the files run in parallel, which left no margin under the default 5 s: in Step 10 five such
// first tests timed out on a busy machine and passed alone. The assertions are unchanged.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
