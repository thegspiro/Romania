import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share a single MySQL schema, so they must not run
    // concurrently against each other.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
