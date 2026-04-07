import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Vite config for the GRVT Grid dashboard.
// - React 19 + Tailwind v4 plugin (no PostCSS config needed)
// - Path alias `@/*` → `src/*`
// - Dev proxy: /api/* and /ws → backend at localhost:3848 (override via env)
//   This avoids CORS issues during development without touching the backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_TARGET ?? 'http://localhost:3848',
        changeOrigin: true,
      },
      '/ws': {
        target: (process.env.VITE_BACKEND_TARGET ?? 'http://localhost:3848').replace(
          /^http/,
          'ws'
        ),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
