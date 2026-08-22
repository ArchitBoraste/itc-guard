import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads the repo-root .env by absolute path before any test module runs, so
    // the database target does not depend on the working directory.
    setupFiles: ['./test/setup/env.js'],
    // DB-backed suites run ONE FILE AT A TIME.
    //
    // Each owns its own org_id (see TEST_ORGS in test/helpers/db.js), so they do
    // not fight over rows — but they do bulk-insert into the same tables, and
    // InnoDB takes gap locks on shared indexes regardless of org_id. Run in
    // parallel they deadlock intermittently: roughly one run in three came back
    // with "Deadlock found when trying to get lock" from whichever suite lost.
    //
    // This used to say files ran one at a time while setting fileParallelism:
    // true, which is the opposite. The intent was right; the setting was not.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 120000
  }
});
