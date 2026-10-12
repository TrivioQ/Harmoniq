# Feature: Tenant Lifecycle & Tenant Administration

> **Requirement IDs:** `MT-07`–`MT-12`, `TLC-01`–`TLC-08`, `PPL-01`–`PPL-08`, `POL-01`–`POL-09`, `DOM-01`–`DOM-05`, `PLN-04`–`PLN-06`, `USG-01`–`USG-04`, `SES-01`–`SES-04`, `AUD-05`–`AUD-09`, `INST-19`–`INST-22`, `TAD-01`–`TAD-10`  
> **Status:** `in-progress`  
> **Phase:** Phase 9 (M5.1–M5.9)

This feature completes the multi-tenant model introduced with organizations (M4.7) and the instance admin (M4.8). It covers lifecycle integrity from creation to purge, onboarding and offboarding, organization-wide policy, usage and quotas, identity hardening, audit streaming, and a tenant admin dashboard that lets an organization run itself without instance-admin help.

---

## Overview

Harmoniq's tenants form three levels: **Instance → Organization → Workspace**. Workspaces are the RLS tenant. Organizations group workspaces and carry SSO, SCIM, org keys and a cross-workspace audit log. The [gap analysis](../multi-tenancy-gap-analysis.md) (2026-10-11) found that this model is sound, but enterprise tenants hit gaps in their first weeks:

- **Integrity:** workspaces created by org keys can never get an owner; deleting a workspace erases its audit trail and leaves bundles and published manifests in storage; SSO trusted domains are unverified and match across tenants; removing an org member leaves their workspace access and keys.
- **Administration:** invitations aren't emailed; there are no org settings, people, usage or policy pages; org keys lack expiry, module scope and rotation in the UI; audit shows raw ids.
- **Commercial:** plans gate four features but have no numeric quotas and no usage metering (INST-09 storage bytes missing).
- **Security:** no MFA outside SSO, a fixed 30-day session, no IP allowlists, pull-only audit.

The audience is org admins (self-service tenant administration), security and compliance reviewers (policy, audit, offboarding) and operators of hosted or large self-hosted instances (quotas, suspension, support access).

## Requirements

| ID                                                      | Requirement                                                                                                                                                                                | Status                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `MT-07`–`MT-10`                                         | Org-scope RLS (`withOrg`), system-client rule for routes, cross-org isolation suite                                                                                                        | ✅ Done (9.1)                               |
| `MT-11`                                                 | Production refuses to start while the app role accepts the placeholder password                                                                                                            | ✅ Done (9.1)                               |
| `TLC-05`                                                | Every workspace can get an owner: org admins act as owners while none has joined and can always assign owners; `owners` on org workspace creation                                          | ✅ Done (9.1, including Terraform `owners`) |
| `DOM-01`–`DOM-05`                                       | Verified domains (DNS TXT), one verified owner per domain, discovery and trusted emails on verified domains, grace period, daily re-checks                                                 | ✅ Done (9.1)                               |
| `PPL-04`, `PPL-05`                                      | Offboarding: org member removal cascades to workspaces, keys and org-SSO sessions; workspace member removal revokes their keys                                                             | ✅ Done (9.1)                               |
| `TLC-03`                                                | Deleting a workspace removes its bundles and published copies (immediately, best effort; the retrying purge job comes with soft delete)                                                    | 🔄 Partial                                  |
| `TLC-01`, `TLC-02`, `TLC-04`, `TLC-06`–`TLC-08`         | Owner self-delete, soft delete and restore, org suspension, transfers, exports, creation policy                                                                                            | 📋 Planned (9.2)                            |
| `AUD-05`                                                | Audit history survives workspace deletion; retention GC; export of a deleted workspace's log                                                                                               | ✅ Done (9.2 item, delivered with 9.1)      |
| `PPL-02` (scope)                                        | A sign-in accepts only invitations its session can reach                                                                                                                                   | ✅ Done                                     |
| `PPL-01`–`PPL-03`, `PPL-06`–`PPL-08`                    | Invitations (emailed, expiring), People directory, effective access, access requests, billing/auditor roles                                                                                | 📋 Planned (9.3)                            |
| `TAD-01`, `TAD-04`–`TAD-08`, `AUD-07`, `AUD-08`         | Org settings and people pages, org key parity, org home and catalog upgrades, shared navigation, audit UX                                                                                  | 📋 Planned (9.4)                            |
| `POL-01`–`POL-09`, `TAD-03`                             | Organization policy center (approval defaults complete `ORG-08`)                                                                                                                           | 📋 Planned (9.5)                            |
| `PLN-04`–`PLN-06`, `USG-01`–`USG-04`, `MT-12`, `TAD-02` | Usage metering, numeric quotas, overrides and trials, per-tenant API rate limits, usage pages (complete `INST-09`)                                                                         | 📋 Planned (9.6)                            |
| `SES-01`–`SES-04`                                       | Session settings, self-service sessions, TOTP MFA, user suspension                                                                                                                         | 📋 Planned (9.7)                            |
| `AUD-06`, `AUD-09`, `TAD-09`, `TAD-10`                  | Audit streaming, hash-chained audit, org notifications and webhooks                                                                                                                        | 📋 Planned (9.8)                            |
| `INST-19`–`INST-22`                                     | Operator tooling: org administration, support access, user/workspace CSV, announcements (with the rest of system administration in [instance admin](./instance-admin-and-byob-storage.md)) | 📋 Planned (9.10)                           |

See [`docs/requirements.md §19`](../requirements.md) for the full specification and [`implementation-plan.md` Phase 9](../implementation-plan.md) for the task checklists.

## Architecture Notes

### Organization-scoped RLS (ADR-010)

Organization tables move under RLS with a second setting, `app.current_org_id`. A new `withOrg(orgId, fn)` helper in `@harmoniq/db` mirrors `withTenant`. It resolves the org's workspace ids with the system client and sets both `app.current_org_id` and `app.current_org_workspace_ids` local to the transaction. Workspace-scoped policies gain one clause:

```sql
USING (
  "workspaceId" = current_setting('app.current_workspace_id', TRUE)
  OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
)
```

Cross-workspace org views (home, catalog, audit, usage, people) then run as the app role and can only see the org's own workspaces. A bug that drops the `organizationId` filter returns nothing extra. The system client stays for tenant resolution, authentication, jobs and instance-admin routes. The lint rule `harmoniq/no-system-db-in-routes` keeps it that way (MT-09).

### Tenant lifecycle states (ADR-011)

```text
active ──suspend──▶ suspended ──unsuspend──▶ active
  │                     │
  └──────delete─────────┴──▶ deleted (deletedAt, purgeAfter) ──restore──▶ active
                                   │
                                   └──purgeAfter passed──▶ purged (rows and objects gone; audit kept)
```

- **Suspended:** reads and manifests are served; writes get `403 WORKSPACE_SUSPENDED` (INST-09). Org suspension applies this to every workspace of the org and to org keys.
- **Deleted:** writes get `410 WORKSPACE_DELETED`; manifests get `410 Gone`; the slug stays reserved; restore is possible until `purgeAfter`.
- **Purge (`tenant.purge` job):** collects version `storagePath`s with `storageBackend` and the published paths of every environment, deletes the objects (instance storage or the workspace bucket), drops cache keys, then deletes the rows. Every step is idempotent, so a failed run is simply retried.
- **Audit tables** lose their cascading foreign keys to `Workspace` and `Organization` (the ids stay, indexed). Audit rows survive the purge and are removed `HARMONIQ_AUDIT_RETENTION_DAYS` after it. RLS is unaffected because it keys on the id column, not the relation.

### Ownership (TLC-05)

Org-key workspace creation (IaC-01) accepts `owners` (emails), which become invitations with the `owner` role. Until a workspace has a joined owner, `requireWorkspace` gives org admins `owner` instead of `admin`. Org admins may assign `owner` in their org's workspaces at any time, through `assertCanAssign` with an org-admin check. The last-owner guards are unchanged.

### Offboarding (PPL-04/05)

Org member removal reuses the org SCIM deprovisioning routine (`services/scim.ts` / `orgProvisioning.ts`), which already removes workspace memberships, revokes keys and ends org-SSO sessions. One code path therefore serves SCIM, SSO group changes and manual removal. Keys are attributed through `ApiKey.createdBy`. Org keys created by the user (`OrgApiKey.createdBy`) are revoked too unless `keepKeys=true`.

### Invitations (PPL-01/02)

Today an invitation is a `WorkspaceMember` row with `joinedAt = null` plus a `User` row created for the email, and org members are added without any pending state. The new `Invitation` table is the single pending state for both scopes:

- The token (32 random bytes) is sent by email and stored as a sha256 hash.
- Acceptance requires a session whose verified email matches the invited one, then creates the membership in the same transaction.
- Without a mailer, the first sign-in with a matching email accepts the invitation, which preserves today's behaviour.

The migration converts pending `WorkspaceMember` rows into invitations. `POST …/members` keeps working: it creates an invitation, or a membership for a user who is already a member of the organization.

### Verified domains (DOM-01–05)

A `VerifiedDomain` row with a unique `domain` belongs to one organization or one standalone workspace. Verification is a DNS TXT lookup of `harmoniq-verification=<token>` through the outbound guard. SSO discovery becomes an indexed lookup (`VerifiedDomain` → owner → SSO config) instead of scanning every `WorkspaceConfig` and `Organization`. Unverified `trustedDomains` keep JIT and domain join working during the grace period but never route discovery, which closes the cross-tenant login-routing issue.

### Policy resolution (POL-09)

`services/policy.ts` merges the instance, org (`OrgPolicy`) and workspace values, field by field, with "strictest wins":

| Field                                                    | Strictest means                 |
| -------------------------------------------------------- | ------------------------------- |
| `requiredApprovers`                                      | maximum                         |
| `eligibleRoles`, `allowedKeyScopes`                      | intersection                    |
| `maxApiKeyDays`, `sessionMaxHours`, `idleTimeoutMinutes` | minimum                         |
| `minRetentionDays`                                       | maximum                         |
| `ipAllowlist`                                            | intersection of non-empty lists |
| booleans (`lockSso`, `requireMfa`)                       | OR                              |

Each value carries its source (`instance` / `organization` / `workspace`) for the dashboard. The approval gate reads the effective policy, so org approval defaults (ORG-08) need no copy in each workspace and apply to workspaces created later.

### Usage metering and quotas (ADR-012)

- **Counters:** request-path counters (manifest requests, health events) are kept per replica in memory. They are flushed every 60 s with an additive upsert into `UsageDaily`, so the manifest path never waits on the database. Losing a replica loses at most a minute of counts, which is acceptable for usage display and soft quotas. Deploys are counted transactionally.
- **Storage:** `ModuleVersion.sizeBytes` is recorded at deploy. A nightly `usage.snapshot` job writes storage, members and keys.
- **Quotas:** the `Quotas` service sits next to `Plans` and reads `HARMONIQ_PLAN_LIMITS` plus per-tenant overrides. It is checked in create routes (`402 QUOTA_EXCEEDED`) and is unlimited when `HARMONIQ_PLAN_ENFORCEMENT` is off (PLN-02).

### Support access (INST-20)

Instance admins no longer get workspace access implicitly. Only the storage routes use `allowInstanceAdmin` today, and they keep it. A `SupportGrant` admits read permissions only, until it expires. It is recorded in `InstanceAuditEvent` and in the tenant's audit log, and `GET /api/workspaces/:ws` and the org home report active grants so the tenant sees a banner.

### New configuration

| Variable / setting              | Default                  | Requirement |
| ------------------------------- | ------------------------ | ----------- |
| `HARMONIQ_TENANT_RESTORE_DAYS`  | `30`                     | TLC-02      |
| `HARMONIQ_AUDIT_RETENTION_DAYS` | `400`                    | AUD-05      |
| `HARMONIQ_DOMAIN_GRACE_DAYS`    | `30`                     | DOM-04      |
| `HARMONIQ_PLAN_LIMITS`          | unlimited                | PLN-04      |
| `HARMONIQ_API_RATE_LIMIT*`      | current global           | MT-12       |
| setting `tenancy.creation`      | `anyone`                 | TLC-08      |
| setting `auth.session`          | 30 days, no idle timeout | SES-01      |
| setting `announcement`          | none                     | INST-22     |

## Breaking Changes

**YES** (behavioural, staged across Phase 9), each with a migration path:

| Change                                                                                                                                                                             | Migration path                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deleting a workspace or org is a soft delete; manifests of a deleted workspace answer `410` instead of `404`                                                                       | Set `HARMONIQ_TENANT_RESTORE_DAYS=0` for immediate purge. `@harmoniq/client` is updated in 9.2 to treat `410` like `404` (fallback manifest).                                 |
| SSO discovery uses verified domains only                                                                                                                                           | Unverified domains keep JIT/domain join for `HARMONIQ_DOMAIN_GRACE_DAYS`; the dashboard prompts for verification.                                                             |
| Removing an org member removes their workspace memberships, created keys and org-SSO sessions; `DELETE /api/orgs/:org/members/:id` answers `200` with the effects instead of `204` | `?keepKeys=true` keeps keys; the confirmation lists effects. SCIM behaviour is unchanged. Clients that expected an empty `204` body should accept `200`.                      |
| SSO discovery no longer picks the first of several workspaces or organizations listing the same unverified domain                                                                  | Verify the domain; until then such a domain returns `404` from discovery (users can still choose the workspace's SSO directly).                                               |
| Pending workspace invitations become `Invitation` rows (7-day expiry from the migration)                                                                                           | Data migration; resend from the dashboard.                                                                                                                                    |
| The RLS migration no longer creates `harmoniq_app`                                                                                                                                 | Only affects new databases: run `scripts/bootstrap-db.ts` or `docker/init.sql` first (already documented in `self-hosting.md`).                                               |
| `AuditEvent` / `ScimAuditEvent` lose their cascading FK to `Workspace`: a deleted workspace's events stay until retention                                                          | Schema-only; `HARMONIQ_AUDIT_RETENTION_DAYS` (default 400) sets how long. Code that counted on audit rows disappearing with the workspace must filter by existing workspaces. |

All API additions are additive. New org roles don't change the meaning of `org_admin` / `org_member`.

---

## Change History

### 2026-10-11 — Terraform workspace owners, separate metrics port

**Type:** feature  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** TLC-05, INST-25

#### What changed

- Terraform: `harmoniq_workspace.owners` (set of emails) invites the workspace's owners at creation. It isn't read back, because org keys don't manage members. Provider docs and examples are regenerated.
- `HARMONIQ_METRICS_PORT` serves `/metrics` on its own listener (with the token, if set), and the API port stops serving it. Helm `registry.metricsPort` (chart 0.3.0) adds the container and Service port.

#### Testing

Terraform acceptance suite (`TF_ACC=1`, Terraform 1.16.5) against a local registry, including `owners`. `metricsAccess.test.ts` covers the separate port, token and 404s. `helm lint` and `helm template` were run with and without `metricsPort`.

### 2026-10-11 — Organization-scoped RLS, audit retention, deletion purge, invitation scope

**Type:** security, bugfix  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** MT-07, MT-08, MT-09, MT-10, AUD-05, TLC-03, PPL-02, ADR-010, ADR-011

#### What changed

- **MT-07/08 (ADR-010):** migration `20261011130000_org_rls` puts the organization tables under RLS and lets workspace-scoped tables admit the current organization's workspaces. `withOrg` in `@harmoniq/db` resolves those workspaces inside the transaction.
  - Moved to `withOrg`: organization routes (home, members, workspaces, audit and export, catalog, keys), org SSO and provisioning routes, org SCIM, org SSO provisioning, and org-shared modules.
  - Attaching a workspace runs in that workspace's own scope.
- **MT-09:** an ESLint rule rejects `systemDb` in registry routes unless the use is marked with its reason. Files that span tenants (instance admin, sign-in, SAML, SCIM) say why at the top. `gitops` now uses `withTenant`.
- **MT-10:** `tenantIsolation.test.ts` calls every GET route of the OpenAPI document as one organization's admin and org key, and fails on any trace of another organization or any 5xx.
- **AUD-05 (P0-2):**
  - `AuditEvent` and `ScimAuditEvent` lose their cascading foreign key to `Workspace`, so a deleted workspace's trail stays.
  - `gc.auditRetention` removes those events once they are older than `HARMONIQ_AUDIT_RETENTION_DAYS` (default 400).
  - `GET /api/admin/workspace-audit/:workspaceId/export` gives instance admins the log of a deleted workspace.
- **TLC-03 (P0-3):** deleting a workspace also deletes its bundles and published manifest and import-map copies, in its bucket and in the instance storage. The counts are in the deletion's audit event.
- **PPL-02 (P1-9):** a sign-in through a workspace's own SSO accepts only that workspace's invitations, and one through an organization's SSO only those of the org's workspaces that use it. Instance-wide methods still accept all.
- Member counts on the org home and the instance admin workspace list count joined members only, not pending invitations.

#### Why

These close the remaining integrity findings of the [gap analysis](../multi-tenancy-gap-analysis.md): P0-2, P0-3 (partly), P0-7 and P1-9.

#### Testing

`rls.test.ts` (organization scope), `tenantIsolation.test.ts`, `workspaceDeletion.test.ts` (purge on both storages, failing storage, audit kept and exported, retention), `invitationScope.test.ts`. Full suites: registry 55 files / 373 tests, db 15 tests, web 21 tests; lint clean.

### 2026-10-11 — Phase 9.1: owners, offboarding, verified domains, database role check

**Type:** feature, security  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** TLC-05, PPL-04, PPL-05, DOM-01–DOM-05, MT-11

#### What changed

- **TLC-05:** `requireWorkspace` gives org admins `owner` while a workspace has no joined owner (`admin` otherwise). Org admins may assign and change owners (`assertCanAssign`, `request.viaOrgAdmin`). The forced-SSO exemption still applies only to real owners. `POST /api/orgs/:org/workspaces` accepts `owners: [email]`, which become owner invitations. `GET /api/workspaces/:ws` reports `viaOrgAdmin`.
- **PPL-04:** removing an org member removes them from every workspace of the organization (each workspace's last owner is kept), revokes the workspace keys and org keys they created (`?keepKeys=true` keeps them), and ends their org-SSO sessions. The response is now `200` with the effects (was `204`). This shares `removeFromWorkspaces` with SCIM deprovisioning.
- **PPL-05:** removing a workspace member revokes the API keys they created there unless `?keepKeys=true`.
- **DOM-01..05:**
  - New `VerifiedDomain` table (migration `20261011120000_verified_domains`, RLS on `workspaceId`) and `services/domains.ts`.
  - Endpoints under `/api/orgs/:org/domains` and `/api/workspaces/:ws/domains`, plus `/api/admin/domains` to release a claim.
  - SSO discovery uses verified domains. During the grace period it also routes an unverified domain that exactly one tenant lists, never an ambiguous one.
  - OIDC and SAML configurations load only the trusted domains the tenant may use, so another tenant's domain no longer makes an IdP's emails count as verified.
  - Daily `domains.recheck` job.
  - Dashboard: Verified domains on both SSO pages.
- **MT-11:** a production registry refuses to start while `DATABASE_URL`'s role accepts the placeholder password. The applied migration is left alone.
- Dashboard: org removal reports what was removed, "keep their API keys" options, and org admins can pick `owner`.

#### Why

These are the [gap analysis](../multi-tenancy-gap-analysis.md) P0 items P0-1 and P0-4 to P0-6. Domain verification also closes a related path the analysis hadn't covered: a trusted domain made an IdP's emails count as verified even without `email_verified`.

#### Testing

`ownerlessWorkspace.test.ts`, `offboarding.test.ts`, `domains.test.ts` (claim, verify, uniqueness, discovery during and after grace, trusted-domain filtering, re-check, instance release), `dbRoleCheck.test.ts`. Full registry suite green (53 files).

### 2026-10-11 — Gap analysis, requirements and implementation plan

**Type:** docs  
**PR / Branch:** —  
**Refs:** MT-07–MT-12, TLC-01–TLC-08, PPL-01–PPL-08, POL-01–POL-09, DOM-01–DOM-05, PLN-04–PLN-06, USG-01–USG-04, SES-01–SES-04, AUD-05–AUD-09, INST-19–INST-22, TAD-01–TAD-10, ORG-08, INST-09

#### What changed

- [Multi-tenancy gap analysis](../multi-tenancy-gap-analysis.md) of the tenant model, isolation, the org dashboard and the instance admin.
- New requirements in [`requirements.md §19`](../requirements.md).
- Phase 9 task checklists in [`implementation-plan.md`](../implementation-plan.md).
- Proposed ADR-010 (org-scoped RLS), ADR-011 (tenant soft delete and audit retention) and ADR-012 (usage metering) in [`architecture.md`](../architecture.md).
- Corrected statuses in related docs: `ORG-08` (approval defaults) and `PLN-03` are partial; `INST-09` lacks storage bytes; `BYOB-13` doesn't remove bucket objects.

#### Why

Enterprise adoption needs a complete tenant lifecycle and self-service tenant administration. The review found integrity defects (ownerless workspaces, audit loss and leftover objects on deletion, unverified SSO domains, incomplete offboarding) alongside missing admin features.

#### Testing

Docs only. Every finding was checked against the code on `main` (`604a1a3`), with file and line references in the gap analysis.
