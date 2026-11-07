import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/flows/**/*.test.ts'],
    environment: 'node',
    // Each flow file owns a fixture server and a Chrome instance. Lighthouse 13
    // audits are heavier, so two at a time keeps the suite quick without
    // letting timing-sensitive API checks starve on small CI runners.
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
