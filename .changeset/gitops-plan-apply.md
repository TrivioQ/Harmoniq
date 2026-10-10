---
'@harmoniq/cli': minor
---

Workspace as code: `harmoniq plan`, `harmoniq apply` and `harmoniq import` read and write `harmoniq.yaml` (host apps, environments, approval policies, freezes, modules and owners, webhooks, alert rules). `${VAR}` references are read from the environment; `plan --detailed-exitcode` exits with 7 when the workspace differs from the file.
