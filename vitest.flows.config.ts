import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/flows/**/*.test.ts'],
    environment: 'node',
    // Each flow file owns a fixture server and a Chrome instance. Running a
    // few side by side keeps the suite quick without letting heavy audits
    // starve each other on small CI runners.
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
