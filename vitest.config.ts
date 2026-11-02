import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Lighthouse flows are heavy; never run two Chrome audits at once.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
