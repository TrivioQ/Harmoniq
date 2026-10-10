// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    dir: 'src',
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'],
      reporter: ['text-summary'],
      // The contract every other package builds on: keep it above 90%.
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
