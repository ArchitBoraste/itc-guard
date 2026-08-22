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
    include: ['test/**/*.test.{js,jsx}']
  }
});
