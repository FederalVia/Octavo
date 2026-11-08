import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Drawings use Excalidraw's hand-drawn fonts. Ship them with the app (so drawings look right
 * offline), except the large Chinese/Japanese font, which Excalidraw fetches only if it's needed.
 */
function excalidrawFonts(): Plugin {
  let outDir = path.resolve(__dirname, 'dist');
  return {
    name: 'octavo-excalidraw-fonts',
    apply: 'build',
    configResolved(config) {
      // Follow `--outDir` so a build elsewhere still ships the fonts.
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const require = createRequire(import.meta.url);
      // index.js lives in dist/prod; the fonts sit next to it.
      const from = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
      const to = path.join(outDir, 'excalidraw-assets', 'fonts');
      if (!fs.existsSync(from)) return;
      for (const family of fs.readdirSync(from)) {
        if (family === 'Xiaolai') continue;
        fs.cpSync(path.join(from, family), path.join(to, family), { recursive: true });
      }
    },
  };
}

const target = process.env.OCTAVO_API ?? 'http://127.0.0.1:4321';

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  // One React for the app and the drawing library (a second copy breaks hooks).
  resolve: { dedupe: ['react', 'react-dom'] },
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
