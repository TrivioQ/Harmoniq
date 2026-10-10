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

### 2026-10-10 — SchemaStore submission for `harmoniq.yaml`; URL templates in the schema

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** IaC-09

#### What changed

- `integrations/schemastore`: the schema as SchemaStore hosts it (`$id` `https://json.schemastore.org/harmoniq.json`), a test file and a negative test file in their layout, the catalog entry and the submission steps. Generated with the other schemas (`schema:generate`).
- Fix: the published `harmoniq.yaml` schema marked `previewUrlTemplate` and `ticketUrlPattern` as `format: uri`, which rejects their `{environment}` / `{id}` placeholders; editors flagged valid files. The format is dropped for those fields (the registry still checks them).

#### Testing

`schemaStore.test.ts`: the copy matches the generated schema; the test file validates with Ajv (formats on) and with the registry's Zod schema, the negative one fails both.

### 2026-10-10 — Terraform provider (IaC-01..04)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** IaC-01, IaC-02, IaC-03, IaC-04

#### What changed

- `integrations/terraform-provider-harmoniq` (Go, `terraform-plugin-framework`): resources `harmoniq_workspace`, `harmoniq_host_app`, `harmoniq_environment` (with an optional `approval_policy`), `harmoniq_remote_module`, `harmoniq_api_key`, `harmoniq_webhook_endpoint`, `harmoniq_alert_rule`, `harmoniq_approval_policy`, all with import; data sources `harmoniq_workspace`, `harmoniq_environment`, `harmoniq_manifest`. Docs generated by `tfplugindocs` from the schemas and examples; GoReleaser config and registry manifest for publishing.
- Registry, for a full lifecycle: org API keys with the `admin` scope (for all workspaces) can create and delete the org's workspaces (created ownerless; org admins administer them) and issue workspace API keys (never wider than themselves; workspace keys still can't). New `DELETE` for modules, host apps and environments (`409` while anything is live, as `apply --prune`), `PATCH` for environments (`name`, `isDefault`). Host apps can be created without environments; `GET` of a module includes its `specifier`. Migration: `ApiKey.createdBy` is optional, `createdByKeyId` records a key that issued another.

#### Testing

Registry: `iacLifecycle.test.ts` (org-key workspace creation and deletion, refused scoped keys, environment updates, deletes refused while live, key issuance limits). Provider: client unit tests; an acceptance test with Terraform 1.16 against a real registry that creates every resource, updates them, checks the next plan is empty, imports each one and destroys everything. Both run in CI, with a check that the generated docs are current.

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
