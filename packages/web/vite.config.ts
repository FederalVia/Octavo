import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.OCTAVO_API ?? 'http://127.0.0.1:4321';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/mcp': { target, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
