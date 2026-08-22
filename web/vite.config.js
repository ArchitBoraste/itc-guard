import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_BASE ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // File watching over a bind mount needs polling inside the container.
    watch: { usePolling: true },
    // The api mounts its router AT /api, so the prefix is passed through rather
    // than stripped. /health sits outside that router and needs its own entry.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true }
    }
  }
});
