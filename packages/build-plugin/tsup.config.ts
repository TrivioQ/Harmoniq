import { defineConfig } from 'tsup';
import { nodeResolveHarmoniq } from '../../scripts/tsup/nodeResolve';

export default defineConfig({
  entry: ['src/index.ts'],
  // unplugin 3 is ESM-only.
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  // Bundle the (unpublished) core helpers; unplugin stays a dependency.
  noExternal: ['@harmoniq/core'],
  ...nodeResolveHarmoniq,
});
