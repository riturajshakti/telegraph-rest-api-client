import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
};

const extensionConfig = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviewConfig = {
  ...shared,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

const workerConfig = {
  ...shared,
  entryPoints: ['src/core/read-file-worker.ts'],
  outfile: 'dist/read-file-worker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
};

const sidebarConfig = {
  ...shared,
  entryPoints: ['src/webview/sidebar.ts'],
  outfile: 'dist/sidebar.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

const envConfig = {
  ...shared,
  entryPoints: ['src/webview/env.ts'],
  outfile: 'dist/env.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

const cssConfig = {
  ...shared,
  entryPoints: ['src/webview/style.css'],
  outfile: 'dist/webview.css',
};

const configs = [extensionConfig, workerConfig, webviewConfig, sidebarConfig, envConfig, cssConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[watch] build finished, watching for changes...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log(production ? 'Production build complete.' : 'Build complete.');
}
