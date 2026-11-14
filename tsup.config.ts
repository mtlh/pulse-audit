import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    'audit-worker': 'src/audit-worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  // Sourcemaps are not useful in an npm install and were half of dist/.
  sourcemap: false,
  // Split the lazily imported command modules into their own chunks so the
  // fast paths (--version, --help, baseline show) never load zod or
  // chrome-launcher at startup.
  splitting: true,
  shims: false,
  // Bundle the small dependencies that are not needed on disk. zod stays
  // external because the published types reference it; chrome-launcher stays
  // external because Lighthouse depends on it anyway; Lighthouse and
  // puppeteer-core stay external for now.
  noExternal: ['commander', 'picocolors'],
  minify: true,
  esbuildOptions(options) {
    // Minification must not erase names that show up in stack traces.
    options.keepNames = true;
  },
});
