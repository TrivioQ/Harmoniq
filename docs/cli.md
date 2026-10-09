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

| Flag                                                                                                    | Description                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--module`                                                                                              | Module slug or id (required)                                                         |
| `--env`                                                                                                 | Target environment (required)                                                        |
| `--release`                                                                                             | Version string (required)                                                            |
| `--url`                                                                                                 | Public URL of the bundle (required)                                                  |
| `--integrity`                                                                                           | SRI hash, e.g. `sha384-…`                                                            |
| `--file`                                                                                                | Local copy of the bundle; computes `--integrity` (sha384)                            |
| `--commit`                                                                                              | Commit SHA; defaults to `GITHUB_SHA` / `CI_COMMIT_SHA`                               |
| `--meta key=value`                                                                                      | Metadata, repeatable                                                                 |
| `--validate`                                                                                            | Fetch the URL and check the integrity locally before deploying                       |
| `--dry-run`                                                                                             | Validate on the registry and show the projected manifest change                      |
| `--rollout <percents>`, `--hold`, `--max-error-rate`, `--max-error-delta`, `--max-p95`, `--min-samples` | Staged canary rollout (see `harmoniq canary`)                                        |
| `--canary <percent>`                                                                                    | Deploy as a canary for this share of users (1–99); the active version keeps the rest |

### `harmoniq canary`

```bash
harmoniq deploy --module checkout --env production --release 1.3.0 --url … --file … --canary 10
harmoniq canary set-traffic 50 --module checkout --env production   # ramp up
harmoniq canary promote --module checkout --env production          # 1.3.0 for everyone
harmoniq canary abort --module checkout --env production --reason "error rate up"
```

Staged rollout: each band runs for `--hold`, then advances if the canary is healthy; reaching 100 promotes, a failed check aborts.

```bash
harmoniq deploy --module checkout --env production --release 1.3.0 --url … --file … \
  --rollout 1,10,50,100 --hold 30m --max-error-rate 0.02 --max-error-delta 0.01 --min-samples 50
harmoniq canary advance --module checkout --env production   # next band now, skip the check
```

`--target attribute=v1,v2` (repeatable, on `deploy --canary`/`--rollout` and `set-traffic`) always serves the canary to matching users; with targets, `--canary 0` limits it to them:

```bash
harmoniq deploy … --canary 0 --target plan=beta --target userId=qa-1,qa-2
```

`set-traffic --version-id <id>` makes an earlier version of the module the canary. All three fail with exit code 4 in a frozen environment.

### `harmoniq disable` / `harmoniq enable`

Kill switch: hosts stop loading the module at their next manifest fetch. Works in frozen environments.

```bash
harmoniq disable --module checkout --env production --reason "payment errors since 14:02"
harmoniq enable --module checkout --env production
```

### Scheduling (`--at`)

`deploy`, `promote`, `rollback`, `canary set-traffic|promote|abort` and `disable`/`enable` accept `--at` with an ISO time or an offset. The command is registered and runs then, as you, with your access checked again at that time.

```bash
harmoniq promote --module checkout --from staging --to production --at 2026-10-12T09:00:00Z
harmoniq disable --module checkout --env production --reason "maintenance" --at +8h
harmoniq schedule list [--status pending]
harmoniq schedule cancel <id>
```

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

### Preview environments

```bash
harmoniq deploy --module checkout --env pr-123 --preview-ttl 72 --release $SHA --url … --file dist/remoteEntry.js
```

Creates `pr-123` on first deploy (the workspace must allow preview environments: `PATCH /api/workspaces/:ws { "allowEphemeralEnvironments": true }`), and deletes it 72 hours after the last deploy. With a preview URL template on the host app (`PATCH /api/workspaces/:ws/host-apps/:host { "previewUrlTemplate": "https://staging.acme.com/?harmoniq-env={environment}" }`) the command prints the preview link.

### `harmoniq doctor`

Explains why a module isn't loading. Checks the registry, the API key, that the manifest resolves and contains the module, that the bundle is reachable with a matching SRI hash and CORS header, that declared `exposes` exist in the bundle's `mf-manifest.json`, and that the CDN copy is current. Exits 2 if any check fails.

```bash
harmoniq doctor --module checkout --env production
✓ registry reachable: https://registry.acme.dev
✓ manifest resolves: 4 modules (sha256-…)
✓ integrity (SRI) matches: sha384-…
✗ exposes match the bundle: declared but not built: ./Cart
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
