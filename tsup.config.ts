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
  sourcemap: true,
  // Split the lazily imported command modules into their own chunks so the
  // fast paths (--version, --help, baseline show) never load zod or
  // chrome-launcher at startup.
  splitting: true,
  shims: false,
});
