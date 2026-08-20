import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads the repo-root .env by absolute path before any test module runs, so
    // the database target does not depend on the working directory.
    setupFiles: ['./test/setup/env.js'],
    // The integration suite resets and rebuilds org 1. Running it beside another
    // file that touches the same rows would make both flaky, so DB-backed files
    // run one at a time while the pure unit suites still run in parallel.
    poolOptions: {
      threads: { singleThread: false }
    },
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 120000
  }
});
