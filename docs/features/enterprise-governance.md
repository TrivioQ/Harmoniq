# Feature: Enterprise-Grade Governance

> **Requirement IDs:** `APR-01`–`APR-18`, `ORG-01`–`ORG-15`, `IaC-01`–`IaC-14`  
> **Status:** `planned`  
> **Phase:** Phase 8

Covers the three enterprise procurement blockers identified in gap analysis: Change Approval Workflows, Organization Hierarchy, and GitOps / Infrastructure as Code. Targets regulated industries (SOX, PCI-DSS, HIPAA) and large enterprises with complex team structures.

---

## Overview

Large enterprises operating in regulated industries require three capabilities that Harmoniq currently lacks:

1. **Change Approval Workflows** — SOX, PCI-DSS, and HIPAA-regulated orgs cannot legally deploy to production without a documented 4-eyes approval trail.
2. **Organization Hierarchy** — Enterprises with 50+ product teams cannot model their structure without a container entity above "workspace."
3. **GitOps / IaC** — Mature DevOps teams manage all infrastructure as code. Without a Terraform provider and declarative YAML support, platform engineering teams are forced to build their own tooling.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| `APR-01`–`APR-18` | Change Approval Workflows | 📋 Planned |
| `ORG-01`–`ORG-15` | Organization Hierarchy | 📋 Planned |
| `IaC-01`–`IaC-14` | GitOps / Infrastructure as Code | 📋 Planned |

See [`docs/requirements.md §16`](../requirements.md) for the full specification.

## Architecture Notes

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
| Table | Notes |
|-------|-------|
| `Organization` | Root entity, NOT RLS-scoped (above workspace isolation) |
| `OrganizationMember` | User ↔ org with `org_admin \| org_member` roles |
| `OrgApiKey` | Org-scoped API keys with workspace/module scope arrays |
| `ApprovalPolicy` | Per-environment approval rules (unique per workspaceId + environmentId) |
| `DeploymentRequest` | pending/executed/rejected/expired/bypassed deploy requests |
| `DeploymentApproval` | Individual approver decisions (unique per request + approver) |

**Column addition:** `Workspace.organizationId` (nullable FK, ORG-03)

See [`docs/database-schema.md`](../database-schema.md) for full schema.

## Breaking Changes

None. `Workspace.organizationId` is nullable — all existing standalone workspaces remain fully functional with no migration required.

---

## Change History

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
