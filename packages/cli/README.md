# @harmoniq/cli

Command-line interface for [Harmoniq](https://github.com/TrivioQ/Harmoniq), the open-source micro frontend control plane.

Deploy, promote and roll back module versions, run canary releases, flip the kill switch, schedule changes and manage your workspace as code, from CI or a terminal.

## Install

```bash
npm install -g @harmoniq/cli
# or run without installing:
npx @harmoniq/cli --help
```

Requires Node.js 20 or later. The binary is called `harmoniq`.

## Setup

Create an API key in the dashboard (workspace settings → API keys). CI pipelines need the `deploy:write` scope.

```bash
# Save a profile (verified against the registry, stored in ~/.harmoniq/config.json with 0600 permissions)
harmoniq --registry-url https://registry.acme.dev --workspace acme-corp --api-key hq_… login

# Check what the CLI is using
harmoniq whoami
```

In CI, skip `login` and use environment variables:

```bash
export HARMONIQ_REGISTRY_URL=https://registry.acme.dev
export HARMONIQ_WORKSPACE=acme-corp
export HARMONIQ_API_KEY=hq_…
```

### Global options

Every setting resolves in this order: **flag → environment variable → saved profile → default**.

| Flag                   | Environment variable     | Default                 | Description                                             |
| ---------------------- | ------------------------ | ----------------------- | ------------------------------------------------------- |
| `--registry-url <url>` | `HARMONIQ_REGISTRY_URL`  | `http://localhost:4000` | Registry URL.                                           |
| `--api-key <key>`      | `HARMONIQ_API_KEY`       |                         | API key.                                                |
| `--workspace <slug>`   | `HARMONIQ_WORKSPACE`     |                         | Workspace slug.                                         |
| `--profile <name>`     | `HARMONIQ_PROFILE`       | `default`               | Saved profile to use.                                   |
| `--change-ticket <id>` | `HARMONIQ_CHANGE_TICKET` |                         | Change ticket for environments that require one.        |
| `--wait`               |                          | off                     | When a change needs approval, wait until it is decided. |
| `--json`               |                          | off                     | Machine-readable JSON output.                           |

## Common workflows

### Deploy a new version

```bash
harmoniq deploy \
  --module checkout \
  --env staging \
  --release 1.2.4 \
  --url https://cdn.acme.com/checkout/1.2.4/remoteEntry.js \
  --file dist/remoteEntry.js
```

`--file` computes the SRI hash from your local build. Alternatively pass `--integrity sha384-…`, or omit both and the hash is computed from `--url`.

Preview what would change without deploying anything:

```bash
harmoniq deploy --module checkout --env production --release 1.2.4 \
  --url https://cdn.acme.com/checkout/1.2.4/remoteEntry.js --file dist/remoteEntry.js --dry-run
```

### Promote staging to production

Promotion moves the exact artifact (URL and hash) that runs in staging, with no rebuild.

```bash
harmoniq promote --module checkout --from staging --to production
```

### Roll back

```bash
harmoniq rollback --module checkout --env production            # previous version
harmoniq rollback --module checkout --env production --to 1.2.2  # a named version
```

### Canary and staged rollouts

```bash
# Give 10% of users the new version; everyone else keeps the active one
harmoniq deploy --module checkout --env production --release 1.3.0 \
  --url https://cdn.acme.com/checkout/1.3.0/remoteEntry.js --file dist/remoteEntry.js \
  --canary 10

# Always give the canary to beta users, regardless of the percentage
harmoniq deploy … --canary 0 --target plan=beta

# Staged rollout: 1% → 10% → 50% → 100%, each band held 30 minutes,
# advancing only while the canary stays healthy
harmoniq deploy … --rollout 1,10,50,100 --hold 30m --max-error-rate 0.02 --max-p95 1500

# Manage a running canary
harmoniq canary set-traffic 25 --module checkout --env production
harmoniq canary advance --module checkout --env production   # next band now
harmoniq canary promote --module checkout --env production   # 100% of users
harmoniq canary abort --module checkout --env production --reason "error spike"
```

### Kill switch

Turn a module off for every host in seconds, even in a frozen environment:

```bash
harmoniq disable --module checkout --env production --reason "payment errors, INC-1234"
harmoniq enable  --module checkout --env production
```

### Schedule a change

Most mutating commands accept `--at` with an ISO time or an offset (`+30m`, `+2h`, `+1d`):

```bash
harmoniq promote --module checkout --from staging --to production --at 2026-10-12T09:00:00Z
harmoniq schedule list --status pending
harmoniq schedule cancel <id>
```

### Preview environments

```bash
harmoniq deploy --module checkout --env pr-123 --release $GITHUB_SHA \
  --url https://cdn.acme.com/checkout/$GITHUB_SHA/remoteEntry.js \
  --file dist/remoteEntry.js --preview-ttl 48
```

The preview environment expires after the given number of hours, and the command prints a preview link.

## Commands

| Command                                       | Description                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `login`                                       | Save an API key for a workspace, verified against the registry.                   |
| `whoami`                                      | Show the registry and workspace in use, and verify the key.                       |
| `deploy`                                      | Deploy a module version, optionally as a canary or staged rollout.                |
| `promote`                                     | Promote the artifact running in one environment to another.                       |
| `rollback`                                    | Roll a module back to an earlier version.                                         |
| `canary set-traffic\|promote\|advance\|abort` | Manage a running canary.                                                          |
| `disable` / `enable`                          | Kill switch: turn a module off or back on in an environment.                      |
| `schedule list\|cancel`                       | List or cancel scheduled operations.                                              |
| `validate`                                    | Check that a bundle URL is reachable and matches its integrity hash.              |
| `manifest get\|pull`                          | Print the current manifest, or save it to a file (e.g. as a build-time fallback). |
| `doctor`                                      | Diagnose why a module is not loading the way you expect in an environment.        |
| `plan`                                        | Show what applying `harmoniq.yaml` would change, without changing anything.       |
| `apply`                                       | Make the workspace match `harmoniq.yaml`.                                         |
| `import`                                      | Write the workspace as it is now to `harmoniq.yaml`, to start using GitOps.       |

Run `harmoniq <command> --help` for every flag.

### Validate a bundle

```bash
harmoniq validate --url https://cdn.acme.com/checkout/1.2.4/remoteEntry.js --file dist/remoteEntry.js
```

### Save a fallback manifest

```bash
harmoniq manifest pull --env production --out src/fallback-manifest.json
```

Import it in your host and pass it as `fallbackManifest` to `@harmoniq/client`.

### Infrastructure as code

```bash
harmoniq import                      # write the current workspace to harmoniq.yaml
harmoniq plan --detailed-exitcode    # in CI: exit 7 when the workspace has drifted
harmoniq apply                       # make the workspace match the file
```

## Exit codes

CI pipelines can branch on these.

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Success.                                                                        |
| `1`  | Generic error.                                                                  |
| `2`  | Validation error (bad input, or the bundle failed validation).                  |
| `3`  | Authentication or authorization failure.                                        |
| `4`  | The environment is frozen.                                                      |
| `5`  | Conflict.                                                                       |
| `6`  | The change is waiting for approval (use `--wait` to block until it is decided). |
| `7`  | `plan --detailed-exitcode`: the workspace differs from `harmoniq.yaml`.         |

## GitHub Actions

```yaml
- run: npx @harmoniq/cli deploy --module checkout --env staging --release ${{ github.sha }}
    --url https://cdn.acme.com/checkout/${{ github.sha }}/remoteEntry.js --file dist/remoteEntry.js
  env:
    HARMONIQ_REGISTRY_URL: ${{ vars.HARMONIQ_REGISTRY_URL }}
    HARMONIQ_WORKSPACE: ${{ vars.HARMONIQ_WORKSPACE }}
    HARMONIQ_API_KEY: ${{ secrets.HARMONIQ_API_KEY }}
```

Commit SHA is picked up from `GITHUB_SHA` or `CI_COMMIT_SHA` automatically.

## Related packages

- [`@harmoniq/build-plugin`](../build-plugin): register a remote from your bundler instead of a CLI step.
- [`@harmoniq/client`](../client): the host SDK that reads what you deploy.
- [`@harmoniq/mf-plugin`](../mf-plugin): Module Federation 2.0 runtime plugin for hosts.

Full command reference: [docs/cli.md](../../docs/cli.md).

## License

Apache-2.0
