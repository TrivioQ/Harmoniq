// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'tsup';
import { nodeResolveHarmoniq } from '../../scripts/tsup/nodeResolve';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @harmoniq/core is not published: bundle it (only zod-free modules are imported).
  noExternal: ['@harmoniq/core'],
  ...nodeResolveHarmoniq,
});
