import { builtinModules, createRequire } from 'module';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @harmoniq/core is not published: bundle it (only zod-free modules are imported).
  noExternal: ['@harmoniq/core'],
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  esbuildPlugins: [
    {
      // Resolve workspace packages with Node's resolver. esbuild otherwise switches to
      // Yarn PnP resolution if any parent directory (e.g. $HOME) contains a .pnp.cjs.
      name: 'node-resolve-harmoniq',
      setup(build) {
        build.onResolve({ filter: /^@harmoniq\// }, (args) => ({
          path: require.resolve(args.path, { paths: [args.resolveDir] }),
        }));
      },
    },
  ],
});
