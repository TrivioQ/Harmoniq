import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres; some touch instance-wide state (setup marker).
    fileParallelism: false,
  },
});
