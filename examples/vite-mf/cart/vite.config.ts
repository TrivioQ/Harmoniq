import { defineConfig } from 'vite';
import { federation } from '@module-federation/vite';
import { harmoniq } from '@harmoniq/build-plugin';

// Each version is built into its own directory and served from its own URL, so old
// versions stay available for rollback.
const version = process.env.VERSION ?? '1.0.0';
const cdn = (process.env.CDN_URL ?? 'http://localhost:5080').replace(/\/$/, '');
const base = `${cdn}/cart/${version}/`;
const outDir = `dist/${version}`;

export default defineConfig({
  base,
  define: { __VERSION__: JSON.stringify(version) },
  build: { outDir, target: 'esnext' },
  plugins: [
    federation({
      name: 'cart',
      filename: 'remoteEntry.js',
      exposes: { './widget': './src/widget.ts' },
      manifest: true,
      dts: false,
    }),
    // Registers the build with Harmoniq. Reads HARMONIQ_REGISTRY_URL, HARMONIQ_API_KEY
    // and HARMONIQ_WORKSPACE; deploys only when HARMONIQ_DEPLOY=1.
    harmoniq.vite({
      module: 'cart',
      environment: process.env.HARMONIQ_ENV ?? 'production',
      version,
      outDir,
      url: `${base}remoteEntry.js`,
      deploy: process.env.HARMONIQ_DEPLOY === '1',
    }),
  ],
});
