import { createUnplugin } from 'unplugin';
import { HarmoniqBuildOptions, harmoniqDeploy } from './deploy';

export type { HarmoniqBuildOptions, HarmoniqBuildResult } from './deploy';
export { harmoniqDeploy } from './deploy';

/**
 * Registers the built remote with Harmoniq after the bundle is written.
 *
 *   // vite.config.ts
 *   import { harmoniq } from '@harmoniq/build-plugin';
 *   plugins: [federation(...), harmoniq.vite({ module: 'checkout', environment: 'staging',
 *     version: process.env.GITHUB_SHA!, outDir: 'dist',
 *     url: `https://cdn.acme.com/checkout/${process.env.GITHUB_SHA}/remoteEntry.js` })]
 */
export const harmoniq = createUnplugin((options: HarmoniqBuildOptions) => ({
  name: 'harmoniq',
  async writeBundle() {
    await harmoniqDeploy(options);
  },
}));
