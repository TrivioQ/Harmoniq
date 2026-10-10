# @harmoniq/build-plugin

Bundler plugin that registers a freshly built remote module with [Harmoniq](https://github.com/TrivioQ/Harmoniq).

After the bundle is written, the plugin computes the SRI integrity hash of your remote entry and, in CI, calls the registry's deploy endpoint with the URL, version, integrity hash, commit SHA, and (when your build emits an `mf-manifest.json`) the module's `exposes` and shared dependency ranges. The registry's dependency gate can then block a deploy that would conflict with other modules.

Built on [unplugin](https://github.com/unjs/unplugin), so one package covers **Vite, Rollup, webpack, Rspack and esbuild**.

> The plugin registers the version; it does not upload your files. Upload the build output to the location `url` points at before the new version takes traffic.

## Install

```bash
npm install --save-dev @harmoniq/build-plugin
```

Requires Node.js 20 or later. The package is ESM-only.

## Usage

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { federation } from '@module-federation/vite';
import { harmoniq } from '@harmoniq/build-plugin';

const sha = process.env.GITHUB_SHA!;

export default defineConfig({
  plugins: [
    federation({/* … */}),
    harmoniq.vite({
      module: 'checkout',
      environment: 'staging',
      version: sha,
      outDir: 'dist',
      url: `https://cdn.acme.com/checkout/${sha}/remoteEntry.js`,
    }),
  ],
});
```

### webpack / Rspack / Rollup / esbuild

```js
// webpack.config.js
const { harmoniq } = require('@harmoniq/build-plugin'); // or import in ESM configs

module.exports = {
  plugins: [
    harmoniq.webpack({
      module: 'checkout',
      environment: 'staging',
      version: process.env.GITHUB_SHA,
      outDir: 'dist',
      url: `https://cdn.acme.com/checkout/${process.env.GITHUB_SHA}/remoteEntry.js`,
    }),
  ],
};
```

Use `harmoniq.rspack(...)`, `harmoniq.rollup(...)` or `harmoniq.esbuild(...)` for the other bundlers.

### Credentials

The registry connection is read from the environment, so no secret lives in your config:

```bash
export HARMONIQ_REGISTRY_URL=https://registry.acme.dev
export HARMONIQ_WORKSPACE=acme-corp
export HARMONIQ_API_KEY=hq_…   # needs the deploy:write scope
```

### Without a bundler plugin

`harmoniqDeploy()` is the function the plugin runs. Call it directly from a script or a custom build step:

```ts
import { harmoniqDeploy } from '@harmoniq/build-plugin';

const result = await harmoniqDeploy({
  module: 'checkout',
  environment: 'staging',
  version: '1.2.3',
  outDir: 'dist',
  url: 'https://cdn.acme.com/checkout/1.2.3/remoteEntry.js',
  deploy: true,
});

console.log(result.integrity, result.deployed, result.pendingApproval);
```

## Options

| Option         | Type                        | Default                                | Description                                                                                    |
| -------------- | --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `module`       | `string`                    | required                               | Harmoniq module slug or id.                                                                    |
| `environment`  | `string`                    | required                               | Target environment, e.g. `staging`.                                                            |
| `version`      | `string`                    | required                               | Version being built, e.g. `1.2.3` or a commit SHA.                                             |
| `url`          | `string`                    | required                               | Public URL the remote entry will be served from once uploaded.                                 |
| `outDir`       | `string`                    | required                               | Build output directory. Required because it is bundler-agnostic.                               |
| `entry`        | `string`                    | `remoteEntry.js`                       | Remote entry file inside `outDir`.                                                             |
| `registryUrl`  | `string`                    | `HARMONIQ_REGISTRY_URL`                | Registry base URL.                                                                             |
| `apiKey`       | `string`                    | `HARMONIQ_API_KEY`                     | API key with the `deploy:write` scope.                                                         |
| `workspace`    | `string`                    | `HARMONIQ_WORKSPACE`                   | Workspace slug.                                                                                |
| `commitSha`    | `string`                    | `GITHUB_SHA` / `CI_COMMIT_SHA`         | Commit recorded with the version.                                                              |
| `deploy`       | `boolean`                   | `true` when `CI=true`                  | Register the version with the registry. Local builds only print the integrity hash by default. |
| `dryRun`       | `boolean`                   | `false`                                | Validate on the registry and print the projected change without deploying.                     |
| `dependencies` | `Record<string, string>`    | read from `mf-manifest.json`           | Shared dependency ranges for the dependency gate. Entries here are added or take precedence.   |
| `force`        | `boolean`                   | `false`                                | Deploy despite dependency conflicts or removed exposes (audited by the registry).              |
| `changeTicket` | `string`                    | `HARMONIQ_CHANGE_TICKET`               | Change ticket for environments that require one.                                               |
| `log`          | `(message: string) => void` | `console.log` with `[harmoniq]` prefix | Custom logger.                                                                                 |

## Result

`harmoniqDeploy()` resolves to:

| Field             | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `integrity`       | `sha384-…` hash of the remote entry.                                              |
| `deployed`        | `true` when the version was registered (never for dry runs or pending approvals). |
| `pendingApproval` | Request id when the environment needs approval before the deploy applies.         |
| `exposes`         | Exposed modules read from `mf-manifest.json`, if present.                         |
| `dependencies`    | Shared dependency ranges sent to the registry, if any.                            |
| `response`        | The registry's response body.                                                     |

It throws when the remote entry is missing, when required settings are absent, or when the registry rejects the deploy (for example, a dependency gate failure or a frozen environment).

## Typical CI order

1. Build the remote (the plugin computes the hash and registers the version).
2. Upload `dist/` to the CDN path in `url`.

Because registration happens at build time, make sure the upload step completes before traffic reaches the new version. To register after the upload instead, run `harmoniq deploy` from [`@harmoniq/cli`](../cli) in a later pipeline step and leave `deploy` off in the plugin.

## Related packages

- [`@harmoniq/cli`](../cli): the same deploy, with promote, rollback and canary commands.
- [`@harmoniq/client`](../client): the host SDK that reads what you register here.
- [`@harmoniq/mf-plugin`](../mf-plugin): Module Federation 2.0 runtime plugin for hosts.

## License

Apache-2.0
