import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Keep the default suite deterministic; the Chrome flows opt into
    // parallel workers in vitest.flows.config.ts.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
