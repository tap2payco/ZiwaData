import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    // The Postgres tests share one database and truncate between cases, so files must not overlap.
    // The suite is small, so running files in sequence costs little and removes a class of flakiness.
    fileParallelism: false,
  },
});
