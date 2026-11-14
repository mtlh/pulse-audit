import { defineConfig } from 'tsup';
import { lighthouseBundlePlugin } from './scripts/lighthouse-build.mjs';

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
  // Bundle the small dependencies and Lighthouse itself, so an install only
  // unpacks puppeteer-core and zod. zod stays external because the published
  // types reference it. Sentry is only imported when Lighthouse's CLI error
  // reporting is enabled, which Pulse never does; keeping it external drops the
  // whole @sentry/node tree from the install.
  noExternal: ['commander', 'picocolors', 'chrome-launcher', 'lighthouse'],
  external: ['puppeteer-core', '@sentry/node'],
  // Some bundled CJS dependencies call require() for Node builtins. An ESM
  // bundle has no require, so provide one before esbuild's __require helper
  // runs. This is a standard esbuild ESM banner, not a Lighthouse patch.
  banner: {
    js: `import { createRequire as __pulseCreateRequire } from 'node:module'; const require = __pulseCreateRequire(import.meta.url);`,
  },
  // Identifier minification is off on purpose: esbuild emits a separate
  // __name helper per chunk, and Lighthouse injects one helper name into page
  // functions. Renaming identifiers would make those names disagree across
  // chunks. Whitespace and syntax minification are safe and still shrink dist.
  minify: false,
  esbuildOptions(options) {
    // Minification must not erase names that show up in stack traces.
    options.keepNames = true;
    options.minifyWhitespace = true;
    options.minifySyntax = true;
    options.minifyIdentifiers = false;
    // The license collector reads the list of bundled packages from it.
    options.metafile = true;
  },
  esbuildPlugins: [lighthouseBundlePlugin()],
});
