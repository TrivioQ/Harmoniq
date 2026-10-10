# Harmoniq Deploy

Deploys a micro frontend version with [Harmoniq](https://github.com/TrivioQ/Harmoniq), or promotes one between environments, and adds a deployment card to the job summary: module, version, environment, approval status, manifest URL and a link to the change with its manifest diff.

```yaml
- uses: harmoniq-dev/deploy-action@v1
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    environment: staging
    version: ${{ github.sha }}
    url: https://cdn.acme.dev/checkout/${{ github.sha }}/remoteEntry.js
    file: dist/remoteEntry.js # integrity from the built file; without it, from the uploaded one
```

Upload the build output to your CDN before this step. Inside this repository, use `./actions/deploy`.

## Promote

```yaml
- uses: harmoniq-dev/deploy-action@v1
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    promote-from: staging
    environment: production
    wait-for-approval: true # production needs approval; block until it is decided
    change-ticket: OPS-1234 # when the approval policy requires one
```

## Preview environment per pull request

The workspace must allow preview environments; set a preview URL template on the host app to get a link.

```yaml
- uses: harmoniq-dev/deploy-action@v1
  id: preview
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    environment: pr-${{ github.event.number }}
    preview-ttl-hours: 72
    version: ${{ github.sha }}
    url: https://cdn.acme.dev/checkout/${{ github.sha }}/remoteEntry.js
- run: gh pr comment ${{ github.event.number }} --body "Preview: ${{ steps.preview.outputs.preview-url }}"
  env:
    GH_TOKEN: ${{ github.token }}
```

## Inputs

| Input               | Required | Description                                                                        |
| ------------------- | -------- | ---------------------------------------------------------------------------------- |
| `registry-url`      | yes      | Harmoniq registry URL                                                              |
| `api-key`           | yes      | API key with the `deploy:write` scope (a secret)                                   |
| `workspace`         | yes      | Workspace slug                                                                     |
| `module`            | yes      | Module slug or id                                                                  |
| `environment`       | yes      | Target environment (deploy) or destination (promote)                               |
| `version`           | deploy   | Version being deployed, e.g. a tag or the commit SHA                               |
| `url`               | deploy   | Public URL of the uploaded remote entry                                            |
| `integrity`         | no       | SRI hash; computed from `file`, else downloaded from `url`                         |
| `file`              | no       | Local remote entry to compute the integrity from                                   |
| `promote-from`      | no       | Promote the version running in this environment instead of deploying               |
| `preview-ttl-hours` | no       | Create `environment` as a preview environment expiring after this many hours       |
| `change-ticket`     | no       | Change ticket id, for approval policies that require one                           |
| `wait-for-approval` | no       | Wait for a pending approval to be decided (default `false`: fail with exit code 6) |
| `dry-run`           | no       | Validate and show the projected change without deploying (default `false`)         |
| `cli`               | no       | Command that runs the Harmoniq CLI (default `npx --yes @harmoniq/cli@1`)           |

## Outputs

| Output                | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `version-id`          | Id of the version record created                           |
| `manifest-url`        | URL of the environment's manifest                          |
| `deployed-at`         | When the version went live (ISO 8601)                      |
| `status`              | `deployed`, `promoted`, `dry-run` or `pending-approval`    |
| `approval-request-id` | Approval request id, when the change waits or waited       |
| `change-url`          | Dashboard link to the change and its manifest diff         |
| `manifest-etag`       | ETag of the manifest after the change                      |
| `preview-url`         | Preview link, when the host app has a preview URL template |

The step fails with the CLI's exit code: `2` invalid input or bundle, `3` authentication, `4` the environment is frozen, `5` conflict (e.g. dependency gate), `6` waiting for approval. Outputs and the card are still written for `6`.

## Publishing (maintainers)

The Marketplace lists actions from the root of a public repository. To release `harmoniq-dev/deploy-action`:

1. Copy `action.yml`, `run.sh` and this README to the root of that repository (with `LICENSE`).
2. Run `bash test.sh` from this directory first; CI runs it on every change here.
3. Tag the release (`v1.2.0`) and move the major tag (`v1`).
4. Draft a GitHub release from the tag and tick **Publish this Action to the GitHub Marketplace** (category: Deployment).
