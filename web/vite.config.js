import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // File watching over a bind mount needs polling inside the container.
    watch: { usePolling: true },
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
});
