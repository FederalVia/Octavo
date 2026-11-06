#!/usr/bin/env node
/**
 * Package the Octavo desktop app for distribution.
 *
 *   npm run dist:desktop              # installer for the current OS
 *   npm run dist:desktop -- --win     # (or --mac / --linux, plus any electron-builder flags)
 *
 * Steps: bundle the Electron main process and the server CLI (with all their
 * dependencies) into single files with esbuild, copy the built web UI next to
 * them, then let electron-builder produce installers in release/dist/.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const appDir = path.join(root, 'release', 'app');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;

const webDist = path.join(root, 'packages', 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('The web UI is not built yet. Run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

// Bundled CommonJS dependencies call require(); give the ESM bundle a real one.
const banner = {
  js: "import { createRequire as __octavoCreateRequire } from 'node:module'; const require = __octavoCreateRequire(import.meta.url);",
};
/**
 * Some ESM packages read their own package.json at runtime with
 * createRequire(import.meta.url)('../../package.json'), which can't work once
 * bundled. Inline those reads at build time.
 */
const inlinePackageJson = {
  name: 'inline-package-json',
  setup(b) {
    b.onLoad({ filter: /node_modules[\\/].*\.(m?js|cjs)$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      if (!src.includes('createRequire') || !src.includes('package.json')) return undefined;
      const out = src.replace(/\b([A-Za-z_$][\w$]*)\(\s*(["'])((?:\.\.?\/)+package\.json)\2\s*\)/g, (m, fn, _q, rel) => {
        if (fn === 'import') return m;
        try {
          const json = JSON.parse(fs.readFileSync(path.resolve(path.dirname(args.path), rel), 'utf8'));
          return `(${JSON.stringify({ name: json.name, version: json.version })})`;
        } catch {
          return m;
        }
      });
      return out === src ? undefined : { contents: out, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};

const common = {
  plugins: [inlinePackageJson],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner,
  legalComments: 'none',
  logLevel: 'warning',
};

console.log('Bundling the desktop app…');
await build({ ...common, entryPoints: [path.join(root, 'packages/desktop/src/main.js')], outfile: path.join(appDir, 'main.mjs'), external: ['electron'] });
console.log('Bundling the server CLI (used by Claude Desktop)…');
await build({ ...common, entryPoints: [path.join(root, 'packages/server/dist/cli.js')], outfile: path.join(appDir, 'cli.mjs') });

fs.cpSync(webDist, path.join(appDir, 'web'), { recursive: true });
fs.copyFileSync(path.join(root, 'packages/desktop/src/preload.cjs'), path.join(appDir, 'preload.cjs'));
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'octavo',
      productName: 'Octavo',
      version: rootPkg.version,
      description: 'A Markdown knowledge base you see as a brain, shared with Claude.',
      author: 'Octavo',
      license: 'UNLICENSED',
      main: 'main.mjs',
      type: 'module',
    },
    null,
    2,
  ),
);

console.log(`Packaging with electron-builder (Electron ${electronVersion})…`);
const builderCli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
execFileSync(
  process.execPath,
  [builderCli, '--config', path.join(root, 'packages/desktop/electron-builder.json'), `-c.electronVersion=${electronVersion}`, '--publish', 'never', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root },
);
console.log(`\nDone. Installers are in ${path.join(root, 'release', 'dist')}`);
