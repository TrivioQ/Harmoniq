# Feature: Workspace as Code (`harmoniq.yaml`)

> **Requirement IDs:** `IaC-09` – `IaC-12`; product-analysis §5.8  
> **Status:** `implemented`  
> **Phase:** M4.10

A workspace's configuration (host apps, environments, approval policies, freezes, modules and their owners, webhooks, alert rules) can live in a `harmoniq.yaml` in the repository. `harmoniq plan` shows how the workspace differs from the file; `harmoniq apply` makes it match; `harmoniq import` writes the current workspace to a file to start from.

---

## Overview

Changes to how a workspace is set up are reviewed like code: in a pull request, with the plan in the CI log, applied on merge. Deploys stay where they are (CLI, build plugin, GitHub Action): the file describes the platform, not which versions run.

```yaml
# yaml-language-server: $schema=https://registry.example.com/api/schema/harmoniq.json
version: 1
workspace: acme
hostApps:
  - slug: shop
    name: Shop
    sharedDependencies: { react: ^18.0.0 }
    environments:
      - slug: staging
      - slug: production
        default: true
        approvalPolicy: { requiredApprovers: 2, eligibleRoles: [admin, owner] }
    modules:
      - slug: cart
        specifier: '@acme/cart'
        owners: [jane@acme.com]
webhooks:
  - url: https://hooks.acme.com/harmoniq
    events: [deploy.success, canary.auto_rolled_back]
    secret: ${HARMONIQ_WEBHOOK_SECRET}
alertRules:
  - name: cart-errors
    condition: load_success_rate
    threshold: 0.95
    action: auto_rollback
    module: shop/cart
    environment: production
```

## Requirements

| ID                 | Requirement                                                   | Status                              |
| ------------------ | ------------------------------------------------------------- | ----------------------------------- |
| `IaC-09`           | `harmoniq.yaml` declaring a workspace's desired state         | ✅ Done (M4.10)                     |
| `IaC-10`           | `harmoniq plan`: structured diff, no changes                  | ✅ Done (M4.10)                     |
| `IaC-11`           | `harmoniq apply`: create, update and delete to match the file | ✅ Done (M4.10)                     |
| `IaC-12`           | `harmoniq import`: the file from the current state            | ✅ Done (M4.10)                     |
| `IaC-01`–`IaC-04`  | Terraform provider                                            | 📋 Planned (separate Go repository) |
| `IaC-13`, `IaC-14` | GitLab CI component                                           | 📋 Planned                          |

See [`docs/requirements.md`](../requirements.md) (GitOps / Infrastructure as Code).

## Architecture Notes

- **One endpoint, server-side diff.** The CLI parses the YAML, substitutes `${VAR}` references from its environment (secrets never live in the file) and posts it to `POST /api/workspaces/:ws/apply` with `dryRun` and `prune`. The registry validates it (`GitOpsConfigSchema`, also published as JSON Schema at `/api/schema/harmoniq.json`), computes the changes and, unless it's a dry run, applies them in one tenant transaction. A plan and its apply use the same code, so what the plan shows is what happens.
- **What the file manages.** Resources are identified by slug (host apps, environments within a host app, modules within a host app), URL (webhooks) and name (alert rules). Declared resources are created or updated. Optional fields left out are not managed and stay as they are; `null` clears them (`approvalPolicy: null` removes a policy, `freeze: null` unfreezes). Module owners are given by email and must be workspace members.
- **Pruning is opt-in and scoped.** Resources the file doesn't declare are deleted only with `--prune`, and only in sections the file has: a file without `webhooks:` never deletes a webhook. Environments, modules and host apps that still serve versions are never deleted; the plan lists them as blocked. Preview environments are never pruned.
- **Idempotent.** Applying a file twice changes nothing the second time; `harmoniq import` followed by `harmoniq plan --prune` shows no changes.
- **Audit and side effects.** An apply is one `gitops.apply` audit event with the changes (keys and field names, never secrets). Freezes send `env.frozen` / `env.unfrozen`; changed host apps get their cached and published manifests refreshed. Webhook secrets the registry generates are returned once.
- **Permissions.** `workspace:admin` (signed-in admins or `admin` API keys).

## Breaking Changes

None.

---

## Change History

### 2026-10-10 — `harmoniq plan`, `apply` and `import` (M4.10)

**Type:** `feature`  
**Refs:** IaC-09, IaC-10, IaC-11, IaC-12

#### What changed

- `GitOpsConfigSchema` (core) and its JSON Schema (`docs/schema/harmoniq.v1.json`, `GET /api/schema/harmoniq.json`).
- Registry: `POST /api/workspaces/:ws/apply` (plan or apply, with `prune`), `GET /api/workspaces/:ws/config` (export), `services/gitops.ts` reconciler.
- CLI: `harmoniq plan [--prune] [--detailed-exitcode]`, `harmoniq apply [--prune]`, `harmoniq import [-o file] [--force]`; `${VAR}` substitution; exit code 7 for drift.

#### Why

Product analysis §5.8: workspace configuration was only changeable by hand in the dashboard, without review or history outside the audit log.

#### Testing

Registry `gitops.test.ts`: export plans to nothing, plan then apply of every resource type, idempotency, updates of declared fields only, webhook secrets from the file, prune semantics (opt-in, declared sections only, live resources blocked), declarative freezes, validation (schema, unknown owners and references, other workspace, permissions), export round trip, JSON Schema. CLI `gitops.test.ts`: variable substitution and missing variables, invalid YAML, plan output, `--detailed-exitcode`, apply with prune and one-time secrets, import without accidental overwrite.
