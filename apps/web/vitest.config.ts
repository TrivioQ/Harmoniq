// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    // next-intl's ESM imports `next/server` without an extension, which only Next's
    // bundler resolves. Inlining lets Vite resolve it in tests.
    server: { deps: { inline: ['next-intl'] } },
  },
});
