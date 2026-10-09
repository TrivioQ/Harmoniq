# Feature: Enterprise-Grade Governance

> **Requirement IDs:** `RBAC-01`–`RBAC-06`, `ENV-FRZ-03`–`04`, `APR-01`–`APR-18`, `SSO-*`, `ORG-01`–`ORG-15`, `INST-*`, `BYOB-*`, `IaC-01`–`IaC-14`  
> **Status:** `in-progress`  
> **Phase:** M4

Covers the three enterprise procurement blockers identified in gap analysis: Change Approval Workflows, Organization Hierarchy, and GitOps / Infrastructure as Code. Targets regulated industries (SOX, PCI-DSS, HIPAA) and large enterprises with complex team structures.

---

## Overview

Large enterprises operating in regulated industries require three capabilities that Harmoniq currently lacks:

1. **Change Approval Workflows** — SOX, PCI-DSS, and HIPAA-regulated orgs cannot legally deploy to production without a documented 4-eyes approval trail.
2. **Organization Hierarchy** — Enterprises with 50+ product teams cannot model their structure without a container entity above "workspace."
3. **GitOps / IaC** — Mature DevOps teams manage all infrastructure as code. Without a Terraform provider and declarative YAML support, platform engineering teams are forced to build their own tooling.

## Requirements

| ID                  | Requirement                                     | Status         |
| ------------------- | ----------------------------------------------- | -------------- |
| `RBAC-01`–`RBAC-06` | Module ownership and module-scoped access       | ✅ Done (M4.1) |
| `ENV-FRZ-03`–`04`   | Owner freeze override, scheduled freeze windows | ✅ Done (M4.2) |
| `APR-01`–`APR-18`   | Change Approval Workflows                       | 📋 Planned     |
| `ORG-01`–`ORG-15`   | Organization Hierarchy                          | 📋 Planned     |
| `IaC-01`–`IaC-14`   | GitOps / Infrastructure as Code                 | 📋 Planned     |

See [`docs/requirements.md §16`](../requirements.md) for the full specification.

## Architecture Notes

### Change approvals (APR-01..18)

A held-back change is stored as the API call itself, exactly like a scheduled operation, and executed the same way: in-process through the original route, as the requester, marked with an internal-only header (honoured only for requests authenticated by the per-process secret) that skips the approval check and carries the approval chain into the change's audit metadata. Because execution goes through the route, ownership, freezes, the dependency gate and validation all apply at execution time, not just at request time. Completing the approval count claims the request with a conditional `pending_approval → executing` update, so concurrent approvals run it once. The executed deploy's version id is kept on the request (`resultVersionId`) to show the approval chain in the version history.

### Freezes (ENV-FRZ-03/04)

A freeze has an optional start (`freezeFrom`) and end; `isFrozen` evaluates the window at check time, so no job is needed to start or end one. Owners override in two ways: per request with the `X-Harmoniq-Freeze-Override` header (sessions only), or by opening a time-boxed window (`POST …/freeze/override`, at most 4 hours) during which changes from any authorized caller pass. That second form is the practical one for a CI hotfix, since API keys can never override. Every change made in a window records `freezeOverride` (reason, owner, end) in its audit event.

### Module ownership (RBAC)

One check, `canWriteModule`, guards every module-changing route (deploy, upload URL, rollback, promote, canary, kill switch) and the scheduling of such operations: workspace admins and owners always pass; API keys within their `moduleIds`; developers when the module has no owners or they own it. A refusal is a `403` plus a `module.unauthorized_attempt` audit event written in its own transaction (the request's own transaction rolls back with the error). Module detail responses carry `owners` and `canWrite` so the dashboard only offers what the registry would accept. Scheduled operations run as their creator, so ownership is checked again when they run.

### §16.1 Change Approval Workflows

- Approval policy configuration per environment (required approvers, eligible roles, expiry window)
- Deployment request lifecycle: `pending → approved/rejected → executed`
- Self-approval prevention enforced at the application layer
- Emergency bypass with mandatory written justification + `⚠️ BYPASSED` audit flag
- Change ticket integration (Jira, ServiceNow URL pattern)
- Pending Approvals dashboard queue per user; full approval chain in deployment history

### §16.2 Organization Hierarchy

- `Organization` top-level container (`Organization → [Workspaces]`)
- `Workspace.organizationId` nullable FK — standalone workspaces fully unaffected
- Org-level SAML 2.0 and OIDC (configure once, all child workspaces inherit)
- Org-level SCIM 2.0 with group-rule auto-assignment to workspaces
- Cross-workspace audit log at `GET /api/orgs/:orgSlug/audit`
- Org-shared module publishing + Org Module Catalog
- Org-level API keys scoped to specific workspaces/modules

### §16.3 GitOps / IaC

- Terraform provider `harmoniq-dev/harmoniq` — 9 resources, 3 data sources
- GitHub Actions composite action `harmoniq-dev/deploy-action@v1`
- `harmoniq.yaml` declarative workspace state file
- `harmoniq plan` / `harmoniq apply` / `harmoniq import` CLI commands
- GitLab CI component

### New DB Tables

| Table                | Notes                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `Organization`       | Root entity, NOT RLS-scoped (above workspace isolation)                 |
| `OrganizationMember` | User ↔ org with `org_admin \| org_member` roles                         |
| `OrgApiKey`          | Org-scoped API keys with workspace/module scope arrays                  |
| `ApprovalPolicy`     | Per-environment approval rules (unique per workspaceId + environmentId) |
| `DeploymentRequest`  | pending/executed/rejected/expired/bypassed deploy requests              |
| `DeploymentApproval` | Individual approver decisions (unique per request + approver)           |

**Column addition:** `Workspace.organizationId` (nullable FK, ORG-03)

See [`docs/database-schema.md`](../database-schema.md) for full schema.

## Breaking Changes

None. `Workspace.organizationId` is nullable — all existing standalone workspaces remain fully functional with no migration required.

---

## Change History

### 2026-10-09 — Change approvals (M4.3)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** APR-01 – APR-18

#### What changed

- Approval policies per environment; deploys, rollbacks, promotes and canary changes into them return `202` with a request; approve (eligible roles, not the requester, users only), reject (one is enough), owner emergency bypass; atomic execution as the requester; expiry job; change tickets; webhooks; approval chain on versions and audit events.
- CLI: exit code 6 for pending, global `--wait` and `--change-ticket`. Build plugin: reports `pendingApproval`, sends the change ticket.
- Dashboard: Approvals queue (approve with comment, reject, bypass), Settings → Approval rules, approval/BYPASSED marks in version history, audit lines.

#### Testing

`approvals.test.ts` (7 cases: policies, pending with webhook and ticket, eligibility and two-approver execution with the chain on the version and audit event, self-approval and rejection, bypass, expiry, other operations, dry runs and the kill switch exempt, policy removal); CLI and build-plugin tests. End to end in headless Chrome: rules set in the UI, a CLI deploy pending (exit 6), approvals by two users applying it, an owner bypass flagged in history.

### 2026-10-09 — Freeze windows and owner overrides (M4.2)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** ENV-FRZ-03, ENV-FRZ-04

#### What changed

- `freeze` accepts `from` (scheduled windows); environments show `scheduledFreeze`.
- Owner overrides: the `X-Harmoniq-Freeze-Override` header, and time-boxed override windows (`POST/DELETE …/freeze/override`) that let CI hotfixes through; audited as `env.freeze_override`, with the override recorded on each change.
- Dashboard: "from" on the freeze form, scheduled-freeze and override notices, owner controls; audit lines.

#### Testing

`freezeWindows.test.ts`: window evaluation, a scheduled freeze that only blocks once started, header override limited to owners with a reason, an override window letting an API-key deploy through with the override in its audit, closing it, unfreezing clearing everything. Checked in headless Chrome.

### 2026-10-09 — Module ownership (M4.1)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** RBAC-01 – RBAC-06

#### What changed

- `GET/PUT /api/workspaces/:ws/modules/:ref/owners` (admin to change); module writes restricted to owners and admins when a module has owners; refusals audited as `module.unauthorized_attempt`; `owners` and `canWrite` on module detail.
- Dashboard: Module owners section (admins edit), actions shown according to `canWrite`; audit lines.

#### Testing

`moduleRbac.test.ts`: ownerless modules open to developers, admin-only owner changes, owners/admins/other developers on deploy, rollback, kill switch and scheduling, audited refusals, API-key scopes and `canWrite`. Checked in headless Chrome with an admin, an owner and a non-owner developer.

### 2026-09-13 — Implemented Phase 8 database models and Zod schemas

**Type:** `feat`
**Refs:** `ORG-03`, `APR-01`

#### What changed

- Added `Organization`, `OrganizationMember`, `OrgApiKey`, `ApprovalPolicy`, `DeploymentRequest`, `DeploymentApproval`, `InstanceConfig`, `InstanceAdmin`, and `WorkspaceStorageConfig` models to `schema.prisma`.
- Added `organizationId` foreign key to `Workspace` model.
- Created Zod schemas for the new Phase 8 operations (`ApprovalPolicySchema`, `CreateOrganizationSchema`, etc.).
- Wrote unit tests for new Zod schemas.
- Generated and applied Prisma migration `phase8`.
- Reconfigured RLS (Row Level Security) and seeding script for `WorkspaceMember`.

#### Why

Executing Phase 1 of the implementation plan, bringing the DB schema up to parity with all phases including the newly planned Phase 8 Enterprise Governance.

#### Testing

Zod schema unit tests passed. Database migration reset and seed script succeeded.

### 2026-09-13 — Requirements, DB schema, and implementation plan added (Phase 8)

**Type:** `docs`  
**Refs:** `APR-01`–`APR-18`, `ORG-01`–`ORG-15`, `IaC-01`–`IaC-14`

#### What changed

- Added **§16 Enterprise-Grade Governance** (47 requirements) to `docs/requirements.md`
- Added 5 new DB tables and `Workspace.organizationId` column to `docs/database-schema.md`
- Added **Phase 8** to `docs/implementation-plan.md` with three sub-sections (approval workflows, org hierarchy, GitOps), each with DB, registry endpoint, dashboard, and test suite tasks
- Phase 1 DB checklist updated with 5 new models
- Milestone timeline updated: 17 weeks → 20 weeks

#### Why

Gap analysis identified these three features as procurement blockers for regulated industries and large enterprise customers.

#### Testing

Documentation only. All implementing PRs MUST include test suites as documented in the Phase 8 test suite checklists and per AGENTS.md §5.
