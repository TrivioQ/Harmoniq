# Harmoniq CI/CD component for GitLab

Deploys a micro frontend version with [Harmoniq](https://github.com/TrivioQ/Harmoniq), or promotes one between environments. It takes the same inputs and gives the same outputs as the [GitHub action](../../actions/deploy/README.md). Outputs reach later jobs as dotenv variables, and the deployment card is printed in the job log. The GitLab environment links to the change in the Harmoniq dashboard.

Store the API key as a masked CI/CD variable named `HARMONIQ_API_KEY` (or pass `api-key`).

```yaml
include:
  - component: $CI_SERVER_FQDN/harmoniq-dev/harmoniq-ci/deploy@1
    inputs:
      job-name: deploy-checkout-staging
      registry-url: https://registry.acme.dev
      workspace: acme
      module: checkout
      environment: staging
      version: $CI_COMMIT_SHA
      url: https://cdn.acme.dev/checkout/$CI_COMMIT_SHA/remoteEntry.js
      file: dist/remoteEntry.js # from a build job's artifacts; else the integrity is computed from `url`

  - component: $CI_SERVER_FQDN/harmoniq-dev/harmoniq-ci/deploy@1
    inputs:
      job-name: promote-checkout-production
      registry-url: https://registry.acme.dev
      workspace: acme
      module: checkout
      promote-from: staging
      environment: production
      wait-for-approval: true
      change-ticket: $CHANGE_TICKET

deploy-checkout-staging:
  needs: [build]

promote-checkout-production:
  needs: [deploy-checkout-staging]
  when: manual
```

Jobs extend like any other: add `needs`, `rules` or `when` under the `job-name` you chose.

## Inputs

| Input                | Default             | Description                                                                         |
| -------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `job-name`           | `harmoniq-deploy`   | Job name; one per module and environment in a pipeline                              |
| `stage`              | `deploy`            | Pipeline stage                                                                      |
| `registry-url`       | required            | Harmoniq registry URL                                                               |
| `api-key`            | `$HARMONIQ_API_KEY` | API key with the `deploy:write` scope                                               |
| `workspace`          | required            | Workspace slug                                                                      |
| `module`             | required            | Module slug or id                                                                   |
| `environment`        | required            | Target environment (deploy) or destination (promote)                                |
| `version`            |                     | Version being deployed. Deploy only                                                 |
| `url`                |                     | Public URL of the uploaded remote entry. Deploy only                                |
| `integrity`          |                     | SRI hash; computed from `file`, else downloaded from `url`                          |
| `file`               |                     | Local remote entry to compute the integrity from                                    |
| `promote-from`       |                     | Promote the version running in this environment instead of deploying                |
| `preview-ttl-hours`  |                     | Create `environment` as a preview environment expiring after this many hours        |
| `change-ticket`      |                     | Change ticket id, for approval policies that require one                            |
| `wait-for-approval`  | `false`             | Wait for a pending approval to be decided instead of failing with exit code 6       |
| `dry-run`            | `false`             | Validate and show the projected change without deploying                            |
| `environment-action` | `start`             | GitLab environment action; use `verify` with `dry-run` so no deployment is recorded |
| `cli-version`        | `1`                 | `@harmoniq/cli` version range                                                       |
| `image`              | `node:20-alpine`    | Image with Node.js 20 or later                                                      |

## Outputs (dotenv)

| Variable                       | Description                                             |
| ------------------------------ | ------------------------------------------------------- |
| `HARMONIQ_VERSION_ID`          | Id of the version record created                        |
| `HARMONIQ_MANIFEST_URL`        | URL of the environment's manifest                       |
| `HARMONIQ_DEPLOYED_AT`         | When the version went live (ISO 8601)                   |
| `HARMONIQ_STATUS`              | `deployed`, `promoted`, `dry-run` or `pending-approval` |
| `HARMONIQ_APPROVAL_REQUEST_ID` | Approval request id, when the change waits or waited    |
| `HARMONIQ_CHANGE_URL`          | Dashboard link to the change and its manifest diff      |
| `HARMONIQ_MANIFEST_ETAG`       | ETag of the manifest after the change                   |
| `HARMONIQ_PREVIEW_URL`         | Preview link, when the host app has a URL template      |

The job fails with the CLI's exit code: `2` invalid input or bundle, `3` authentication, `4` the environment is frozen, `5` conflict, `6` waiting for approval (outputs are still written).

## Publishing (maintainers)

The CI/CD Catalog lists components from a project's `templates/` directory. To release `harmoniq-dev/harmoniq-ci`:

1. Copy `templates/`, this README and `LICENSE` to the root of that GitLab project, and mark it as a CI/CD Catalog project (Settings → General → Visibility).
2. Run `node integrations/gitlab/test.mjs` here first; CI runs it on every change.
3. Tag a release (`1.2.0`) from a pipeline with the `release` keyword; the catalog shows the new version.
