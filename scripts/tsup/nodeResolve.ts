// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { builtinModules, createRequire } from 'module';
import type { Options } from 'tsup';

const require = createRequire(import.meta.url);

/**
 * tsup settings for Node packages that bundle unpublished workspace packages
 * (`@harmoniq/*`). Resolution goes through Node's resolver: esbuild otherwise switches
 * to Yarn PnP resolution if any parent directory (e.g. $HOME) contains a `.pnp.cjs`,
 * and then fails on pnpm workspaces and Node built-ins.
 */
export const nodeResolveHarmoniq: Pick<Options, 'external' | 'esbuildPlugins'> = {
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  esbuildPlugins: [
    {
      name: 'node-resolve-harmoniq',
      setup(build) {
        build.onResolve({ filter: /^@harmoniq\// }, (args) => ({
          path: require.resolve(args.path, { paths: [args.resolveDir] }),
        }));
      },
    },
  ],
};
