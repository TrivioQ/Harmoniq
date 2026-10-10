---
'@harmoniq/cli': minor
---

`harmoniq deploy` computes the integrity from the bundle at `--url` when neither `--integrity` nor `--file` is given. JSON output of `deploy` and `promote` now includes `manifestUrl` and `changeUrl`, and a pending approval includes `approvalUrl`.
