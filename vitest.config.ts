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
    env: {
      // Deliberately NOT UTC.
      //
      // The chronology turns stored dates into positions on an axis, and every
      // conversion must be UTC. A slip -- `new Date('1943-06-02T14:30')` parses
      // as local time -- would be invisible on a UTC machine, which every CI
      // runner is, and would appear only on the operator's own. Running the
      // suite in a zone far from UTC makes that class of bug fail loudly here
      // instead of quietly there.
      TZ: 'America/Anchorage',
    },
  },
});
