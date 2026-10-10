# @harmoniq/cli

## 1.2.0

### Minor Changes

- 7c6c0d1: `harmoniq deploy` computes the integrity from the bundle at `--url` when neither `--integrity` nor `--file` is given. JSON output of `deploy` and `promote` now includes `manifestUrl` and `changeUrl`, and a pending approval includes `approvalUrl`.
- 623cd8e: Workspace as code: `harmoniq plan`, `harmoniq apply` and `harmoniq import` read and write `harmoniq.yaml` (host apps, environments, approval policies, freezes, modules and owners, webhooks, alert rules). `${VAR}` references are read from the environment; `plan --detailed-exitcode` exits with 7 when the workspace differs from the file.
