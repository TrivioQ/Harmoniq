# Harmoniq CLI Reference

`@harmoniq/cli` deploys, promotes and rolls back modules from CI or a terminal.

```bash
npm install -g @harmoniq/cli   # or: npx @harmoniq/cli <command>
```

## Configuration

Every command resolves its settings in this order: **flag → environment variable → saved profile → default**.

| Flag             | Environment variable    | Default                 |
| ---------------- | ----------------------- | ----------------------- |
| `--registry-url` | `HARMONIQ_REGISTRY_URL` | `http://localhost:4000` |
| `--api-key`      | `HARMONIQ_API_KEY`      | —                       |
| `--workspace`    | `HARMONIQ_WORKSPACE`    | —                       |
| `--profile`      | `HARMONIQ_PROFILE`      | `default`               |
| `--json`         | —                       | off                     |

API keys are created in the dashboard (workspace settings → API keys) or with `POST /api/workspaces/:ws/api-keys`. Use the `deploy:write` scope for CI.

### `harmoniq login`

Verifies an API key against the registry and saves it as a profile in `~/.harmoniq/config.json` (permissions `0600`). Prompts for anything not given as a flag or environment variable.

```bash
harmoniq --workspace acme --api-key hq_… login
harmoniq --profile staging-ci --registry-url https://registry.acme.dev login
```

### `harmoniq whoami`

Shows the registry, workspace and key prefix in use, and checks that the key works.

## Deploying

### `harmoniq deploy`

```bash
harmoniq deploy \
  --module checkout \
  --env staging \
  --release 1.2.3 \
  --url https://cdn.acme.com/checkout/1.2.3/remoteEntry.js \
  --file dist/remoteEntry.js
```

| Flag               | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `--module`         | Module slug or id (required)                                    |
| `--env`            | Target environment (required)                                   |
| `--release`        | Version string (required)                                       |
| `--url`            | Public URL of the bundle (required)                             |
| `--integrity`      | SRI hash, e.g. `sha384-…`                                       |
| `--file`           | Local copy of the bundle; computes `--integrity` (sha384)       |
| `--commit`         | Commit SHA; defaults to `GITHUB_SHA` / `CI_COMMIT_SHA`          |
| `--meta key=value` | Metadata, repeatable                                            |
| `--validate`       | Fetch the URL and check the integrity locally before deploying  |
| `--dry-run`        | Validate on the registry and show the projected manifest change |

### `harmoniq promote`

Copies the exact artifact (URL and integrity) running in one environment to another — production only ever runs what was tested.

```bash
harmoniq promote --module checkout --from staging --to production
```

### `harmoniq rollback`

```bash
harmoniq rollback --module checkout --env production            # previous version
harmoniq rollback --module checkout --env production --to 1.2.2
harmoniq rollback --module checkout --env production --version-id <id>
```

### `harmoniq validate`

Checks that a URL is reachable and matches the expected hash, and warns about missing CORS headers or an unexpected content type.

```bash
harmoniq validate --url https://cdn.acme.com/checkout/1.2.3/remoteEntry.js --file dist/remoteEntry.js
```

## Manifests

Manifests are public; these commands need no API key.

```bash
harmoniq manifest get --env production [--host consumer-portal]
harmoniq manifest pull --env production --out src/harmoniq-fallback.json
```

`manifest pull` is meant for a host app's build: ship the file as a fallback for when the registry is unreachable.

## Exit codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | Success                                                       |
| 1    | Generic error (network, server error, not found)              |
| 2    | Invalid input or bundle failed validation                     |
| 3    | Authentication or authorization failed                        |
| 4    | Target environment is frozen                                  |
| 5    | Conflict (e.g. version already active, ambiguous module slug) |

With `--json`, successful commands print exactly one JSON document on stdout; errors go to stderr.

## Build plugin

`@harmoniq/build-plugin` registers a remote straight from your bundler (Vite, Rollup, webpack, Rspack, esbuild). After the bundle is written it computes the remote entry's SRI hash, reads `exposes` from `mf-manifest.json` when present, and — in CI (`CI=true`) — deploys it. Locally it only prints the hash.

```ts
// vite.config.ts
import { harmoniq } from '@harmoniq/build-plugin';

export default defineConfig({
  plugins: [
    federation({
      name: 'checkout',
      filename: 'remoteEntry.js',
      exposes: { './CheckoutPage': './src/CheckoutPage' },
    }),
    harmoniq.vite({
      module: 'checkout',
      environment: 'staging',
      version: process.env.GITHUB_SHA ?? 'dev',
      outDir: 'dist',
      url: `https://cdn.acme.com/checkout/${process.env.GITHUB_SHA}/remoteEntry.js`,
    }),
  ],
});
```

Credentials come from `HARMONIQ_REGISTRY_URL`, `HARMONIQ_API_KEY` and `HARMONIQ_WORKSPACE` (or the `registryUrl`, `apiKey`, `workspace` options). Upload the build output to the URL's location first; a rejected deploy (e.g. frozen environment) fails the build. Other bundlers: `harmoniq.webpack(…)`, `harmoniq.rspack(…)`, `harmoniq.rollup(…)`, `harmoniq.esbuild(…)`.

## GitHub Action

[`actions/deploy`](../actions/deploy/README.md) wraps the CLI: deploy or promote, `version-id` / `manifest-etag` outputs, and a job summary.

## CI example (GitHub Actions)

```yaml
- name: Deploy checkout to staging
  run: |
    npx @harmoniq/cli deploy \
      --module checkout --env staging --release ${{ github.sha }} \
      --url https://cdn.acme.com/checkout/${{ github.sha }}/remoteEntry.js \
      --file dist/remoteEntry.js
  env:
    HARMONIQ_REGISTRY_URL: https://registry.acme.dev
    HARMONIQ_WORKSPACE: acme
    HARMONIQ_API_KEY: ${{ secrets.HARMONIQ_API_KEY }}
```
