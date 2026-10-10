import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres; some touch instance-wide state (setup marker).
    fileParallelism: false,
    // As in CI. A local .env may select Redis, whose shared, persistent rate-limit counters
    // would leak between test files and runs; tests that need Redis opt in themselves.
    env: { CACHE_ADAPTER: 'memory' },
  },
});
