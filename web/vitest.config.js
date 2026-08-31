import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Separate from vite.config.js on purpose: that file's `server.proxy` is about
// talking to the API container, which has nothing to do with the test run. Tests
// stub fetch instead — see test/setup.js.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    // Vitest's 5s default is per test and measured in wall clock, which is the
    // wrong unit here for the same reason as asyncUtilTimeout in test/setup.js:
    // the files run in parallel inside the web container, and the handful of
    // tests that drive `userEvent` against a full <App /> render occasionally
    // lose a couple of seconds to that contention. Nothing here is asserting a
    // performance budget — a test that genuinely hangs still fails, just later.
    testTimeout: 20000
  }
});
