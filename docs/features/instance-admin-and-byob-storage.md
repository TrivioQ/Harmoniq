# Feature: Instance Admin UI & BYOB Storage

> **Requirement IDs:** `INST-01`–`INST-39`, `BYOB-01`–`BYOB-14`  
> **Status:** `implemented`  
> **Phase:** Phase 7 (§7.4 + §7.5)

Addresses two enterprise self-hosting requirements: a first-class instance admin panel that eliminates direct `.env` editing, and per-workspace bring-your-own-bucket storage for data residency compliance (HIPAA, FedRAMP, GDPR).

---

## Overview

Self-hosted enterprise deployments have two distinct operator roles — the _server operator_ (DevOps/infra) and the _workspace admin_ (product team lead). Currently:

- **Instance Admin UI:** Configuring storage adapters, SMTP, and OAuth providers requires direct `.env` editing and a process restart. This is unacceptable in regulated environments where config changes must be audited and applied without downtime.
- **BYOB Storage:** Enterprises subject to HIPAA, FedRAMP, or EU GDPR data residency requirements cannot store module bundles on shared infrastructure. Each workspace must route all storage I/O to their own S3/GCS/Azure bucket under their own IAM policy.

## Requirements

| ID                                                            | Requirement                                                                                                                                                            | Status                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `INST-01`–`INST-08`, `INST-10`–`INST-18`                      | Instance Admin UI                                                                                                                                                      | ✅ Done (M4.8; see [enterprise governance](./enterprise-governance.md))          |
| `INST-09`                                                     | Workspaces list, suspend, unsuspend, delete: done; "storage bytes used" is not reported yet (`USG-02`)                                                                 | 🔄 Partial (rest Phase 9.6, [tenant administration](./tenant-administration.md)) |
| `BYOB-02`–`BYOB-12`, `BYOB-14`                                | Bring-Your-Own-Bucket Storage: S3 (keys or IAM role, S3-compatible endpoints), GCS, Azure; verification, fail-closed deploys                                           | ✅ Done (M4.9)                                                                   |
| `BYOB-13`                                                     | Deleting a workspace removes its storage config and the objects in its bucket (bundles, published manifests)                                                           | ✅ Done (Phase 9, best effort; failures counted in the deletion's audit event)   |
| `BYOB-01`                                                     | Plan gating (startup / enterprise only, with plan enforcement)                                                                                                         | ✅ Done (M4.11)                                                                  |
| `INST-23`–`INST-25`                                           | Safety: no admin lockout through sign-in settings, recovery CLI, `/metrics` token, separate metrics port, tenant labels opt-in                                         | ✅ Done (Phase 9.1)                                                              |
| `INST-26`, `INST-31`–`INST-35`                                | Encryption keyring and re-seal, admin roles and invitations, step-up and admin session limits, instance API keys, more runtime settings, settings history and export   | ✅ Done (Phase 9.9)                                                              |
| `INST-19`–`INST-22`, `INST-27`–`INST-30`, `INST-36`–`INST-39` | Organizations, support access, overview with attention list, system info and jobs, workspace and user detail, audit search, maintenance mode, email log, security page | 📋 Planned (Phase 9.10)                                                          |

See [`docs/requirements.md §17`](../requirements.md), [`§18`](../requirements.md) and [`§19.9`](../requirements.md) for the full specification, and [the gap analysis §8](../multi-tenancy-gap-analysis.md#8-system-instance-administration) for the review behind the planned items.

## Architecture Notes

### §17 Instance Admin UI

- **§17.1 First-Boot Setup Wizard:** One-time token protection, 4-step guided setup, token consumption to prevent re-triggering
- **§17.2 Instance Admin Role:** Separate from all workspace roles; `/admin/*` route guard
- **§17.3 Admin Panel Pages:** System Health, Workspaces (suspend/unsuspend/delete), Users (revoke sessions/delete), Storage Settings, Email/SMTP, OAuth Providers, Branding
- **§17.4 Runtime Configuration:** Encrypted-at-rest `InstanceConfig` table; DB config takes precedence over `.env`; 60s hot-reload without process restart; audit log for all config changes (key only, never plaintext value)

### §18 BYOB Storage

- **§18.1 Storage Adapter Override:** Supported providers: S3, GCS, Azure. `local` explicitly disallowed as a BYOB target. Credentials encrypted at rest.
- **§18.2 Validation & Testing:** Mandatory canary write-read-delete cycle on save; Test Connection on-demand; credential rotation support
- **§18.3 Deploy-Time Behaviour:** Fail-closed (503, NO fallback to instance storage on BYOB failure); manifest CDN prefix override; CLI prefix-mismatch warning
- **§18.4 Data Residency & Migration:** No auto-migration of pre-BYOB modules; migration advisory banner; `storageRegion` in AuditEvent metadata for compliance

### New DB Tables

| Table                    | Notes                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `InstanceConfig`         | Encrypted key-value store for runtime config. NOT RLS-scoped. Unique on `key`.                                   |
| `InstanceAdmin`          | User-to-admin-role mapping. NOT RLS-scoped. Soft-revocable via `revokedAt`.                                      |
| `WorkspaceStorageConfig` | Per-workspace BYOB adapter config. RLS-scoped on `workspaceId`. Unique per workspace. Includes `lastVerifiedAt`. |

**Storage resolution cascade:** `WorkspaceStorageConfig → InstanceConfig → STORAGE_ADAPTER env var`

See [`docs/database-schema.md`](../database-schema.md) for full schema.

### System administration (Phase 9.1, 9.9; 9.10 planned)

- **No lockout (INST-23/24).** `InstanceSettings.prepare('auth')` checks each active instance admin's `Identity` providers against the methods that would remain enabled. The `harmoniq-admin` CLI runs inside the registry image with `SYSTEM_DATABASE_URL`, which works when no one can sign in. Its commands are the break-glass path, so they write system-actor audit events.
- **Keyring (INST-26, ADR-013).** Envelopes record `kid`. Values without one belong to the legacy single key, so existing data needs no migration before the first rotation. Re-sealing is a job, not a migration, because it needs the keys, which the migration runner doesn't have.
- **Capabilities, not role checks (INST-31).** `services/adminAccess.ts` maps each admin write (`METHOD route`) to a capability: `tenants`, `plans`, `sessions`, `users`, `jobs`, or `owner`. Reads need none. A write that isn't listed is owner-only, so a new route is safe by default. Roles are capability sets. Instance API keys use their scope instead (`instance:read` for reads, `instance:admin` for writes). They never manage admins or keys, so automation can't escalate (INST-33).
- **Step-up (INST-32).** A sign-in, or `POST /api/auth/reauth` with a TOTP or recovery code, stamps `RefreshToken.reauthAt`. Access tokens carry it as `rat`. Destructive routes need it within 10 minutes. A stolen long-lived refresh token can't delete tenants, because refreshing keeps the old stamp.
- **Settings versions (INST-35).** Each save, restore, import and reset writes an `InstanceConfigVersion` with the stored (sealed) value. History, export and import never show secrets. A restore re-seals the stored value. An import that leaves a secret out keeps the current one.
- **Operations data (INST-27/28).** Replicas write heartbeats (version, commit, start time, config load time). The overview reads existing signals (`Environment.lastPublishError`, `WebhookDeadLetter`, pg-boss failed jobs, `WorkspaceStorageConfig.lastVerifiedAt`, `AlertRule.lastError`, SAML certificate dates) instead of new bookkeeping.

## Breaking Changes

None. `STORAGE_ADAPTER` env var continues to work as the bootstrap default. Existing workspaces without `WorkspaceStorageConfig` continue using the instance default adapter unchanged.

---

## Change History

### 2026-10-12 — Phase 9.9: keyring, admin roles, step-up, instance keys, settings history

**Type:** security  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** INST-26, INST-31, INST-32, INST-33, INST-34, INST-35

#### What changed

- **INST-26:**
  - `HARMONIQ_ENCRYPTION_KEYS` keyring; sealed values record `kid`.
  - Re-sealing: the `secrets.reseal` job, `POST /api/admin/encryption/reseal` and `harmoniq-admin reseal-secrets`.
  - `GET /api/admin/encryption`, encryption counts in the health report, and the dashboard **Encryption** page.
- **INST-31:**
  - `InstanceAdmin.role` with four roles and `InstanceAdminInvitation`. One active owner always remains.
  - `/api/me` returns the role and capabilities; the dashboard hides owner-only pages from other roles.
- **INST-32:**
  - Re-authentication within 10 minutes for destructive actions (`REAUTH_REQUIRED`); the dashboard asks for a code inline.
  - Admin MFA requirement (`HARMONIQ_ADMIN_REQUIRE_MFA`), admin IP allowlist, and admin sessions capped at `auth.session.adminMaxHours`.
- **INST-33:**
  - Instance API keys (`hq_inst_`), managed under **Admin → API keys**.
  - Terraform resources `harmoniq_instance_setting`, `harmoniq_workspace_plan` and `harmoniq_organization_plan`, using `GET /api/admin/{workspaces,orgs}/:slug/plan`.
- **INST-34:** `plans`, `rateLimits`, `gc` and `bundles` settings, applied without a restart.
- **INST-35:** versions, history and restore, YAML export and import (dry run first). In the dashboard: **Admin → All settings** and `/admin/settings/:key`.

#### Testing

- `keyring.test.ts`: legacy and new envelopes, rotation, unknown keys fail closed, idempotent re-seal.
- `adminAccess.test.ts`:
  - the role matrix over every admin route, and `/api/me`;
  - step-up and admin session cap; MFA and IP allowlist;
  - instance keys: scopes, expiry, revocation, refused on tenant routes, and plans and settings as Terraform uses them.
- `settingsHistory.test.ts`: new settings on every replica, versions and restore, no secrets in history or exports, import dry run and apply.
- Terraform acceptance tests against a dev registry.
- Smoke test of the dashboard pages in English and Spanish, including the billing role's navigation.

#### Notes

- Instance admins are not managed by Terraform, because instance keys can't manage admins or keys.
- Admins without MFA re-authenticate by signing in again.

### 2026-10-11 — Admin lockout guard, recovery CLI, protected metrics

**Type:** security  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** INST-23, INST-24, INST-25

#### What changed

- **INST-23:** `PUT /api/admin/settings/auth` refuses a value with which no instance admin could still sign in, or with which the admin saving it couldn't (`409`). Only instance-wide methods count: email and dev for any account, GitHub and instance OIDC for admins who have used them. Other admins it locks out are listed in `adminsLockedOut` and in the dashboard message, and counted in the audit event.
- **INST-24:** `scripts/harmoniq-admin.ts` (`grant-admin`, `reset-setting`, `revoke-sessions`, `list-admins`) with `SYSTEM_DATABASE_URL`; each command is an `InstanceAuditEvent` by `system:harmoniq-admin`.
- **INST-25:** `HARMONIQ_METRICS_TOKEN` makes `/metrics` require a bearer token, and production logs a warning without one. Workspace labels are opt-in (`HARMONIQ_METRICS_TENANT_LABELS`). The metrics plugin uses its own meter provider.

#### Why

[Gap analysis §8](../multi-tenancy-gap-analysis.md#8-system-instance-administration), SA-1 and SA-2.

#### Testing

`adminLockout.test.ts`, `adminRecovery.test.ts`, `metricsAccess.test.ts`; the INST-13 tests now keep a way in for the admin.

### 2026-10-11 — System administration review and plan

**Type:** docs  
**PR / Branch:** —  
**Refs:** INST-19–INST-39, ADR-013

#### What changed

- Reviewed the instance admin API and panel ([gap analysis §8](../multi-tenancy-gap-analysis.md#8-system-instance-administration)). Three risks were found: admins can lock everyone out through the sign-in settings, `/metrics` is public and names tenants, and the encryption key can't be rotated.
- New requirements `INST-23`–`INST-39`; planned in Phase 9.1 (safety), 9.9 (security and automation) and 9.10 (dashboard and operations).

#### Why

The panel covers first boot and basic tenant moderation, but not the day-2 operation of a production instance.

#### Testing

Docs only.

### 2026-10-11 — Status corrections

**Type:** docs  
**PR / Branch:** —  
**Refs:** INST-09, BYOB-13, USG-02, TLC-03

#### What changed

- `INST-09` is partial: the admin workspace list has no storage bytes. That is planned as `USG-02` (Phase 9.6).
- `BYOB-13` is partial: deleting a workspace removes its storage config but not the bundles in its bucket or its published manifests. That is planned as `TLC-03` (Phase 9.2).
- Organization administration for instance admins (`INST-19`–`INST-22`) is planned in [tenant administration](./tenant-administration.md).

#### Why

Findings of the [multi-tenancy gap analysis](../multi-tenancy-gap-analysis.md).

#### Testing

Docs only.

### 2026-10-09 — Bring-your-own-bucket storage (M4.9)

**Type:** Feature
**Author:** Shashi Kumar Dhandapani
**Refs:** BYOB-02 – BYOB-14

**Summary:**

- Providers (BYOB-02/03): S3 with access keys or an IAM role assumed with the registry's own identity (`roleArn`, `externalId`) and optional S3-compatible `endpoint` (MinIO, R2; public HTTPS only in production), GCS with a service-account key file, and Azure Blob with a connection string (new `AzureBlobStorageAdapter`; SAS upload URLs). Credentials are validated per provider and never carry over to another provider.
- Verification (BYOB-04/05/06): every save writes, reads back and deletes a probe object under the path prefix first (`400` with the storage's error otherwise, nothing saved); `POST /api/workspaces/:ws/storage/test` tests the saved config or a candidate without saving; `lastVerifiedAt` records the last success; `DELETE /api/workspaces/:ws/storage` returns to the instance default.
- Deploys (BYOB-07..10, 14): `upload-url` issues the pre-signed URL in the workspace bucket (or the instance default) and returns the object's CDN `url`; deploying with `storagePath` serves the bundle from the workspace's CDN prefix; a URL outside the prefix gets a warning (printed by `harmoniq deploy`); deploy audit events carry `storageProvider` and `storageRegion`. A workspace bucket that can't be used is a `503 STORAGE_UNAVAILABLE`, never a fallback to shared storage.
- Dashboard (BYOB-12): Settings → Storage (also in the admin panel) with all providers, path prefix, Test Connection, Remove, last verification and the advisory that deployed modules stay where they are until redeployed.
- Azure Blob is also an instance storage adapter (INST-11).
- Migration `20261009180000_byob_endpoint` (`WorkspaceStorageConfig.endpoint`).

**Tests:** `byob.test.ts` against an S3-compatible test server: refused and accepted saves with the probe cycle under the path prefix, Test Connection of saved and candidate configs, rotated credentials re-verified, per-provider credential validation, upload URLs and CDN URLs, manifests served and published from the workspace bucket, warnings and audit metadata, fail-closed `503`, removal. `storage.test.ts`: Azure SAS upload URLs. `storageConfig.test.ts` now saves against the test server.

### 2026-10-09 — Instance admin (M4.8)

**Type:** Feature
**Refs:** INST-01 – INST-18

Setup wizard, health, workspaces, users, instance admins, instance settings with hot reload. See the [enterprise governance change history](./enterprise-governance.md#change-history).

### 2026-09-13 — Requirements, DB schema, and implementation plan added (Phase 7.4 + 7.5)

**Type:** `docs`  
**Refs:** `INST-01`–`INST-18`, `BYOB-01`–`BYOB-14`

#### What changed

- Added **§17 Instance Admin UI** (18 requirements) to `docs/requirements.md`
  - §17.1 First-Boot Setup Wizard, §17.2 Instance Admin Role, §17.3 Admin Panel Pages, §17.4 Runtime Configuration
- Added **§18 BYOB Storage** (14 requirements) to `docs/requirements.md`
  - §18.1 Storage Adapter Override, §18.2 Validation & Testing, §18.3 Deploy-Time Behaviour, §18.4 Data Residency & Migration
- Added 3 new DB tables (`InstanceConfig`, `InstanceAdmin`, `WorkspaceStorageConfig`) to `docs/database-schema.md`
- Added **§7.4 Instance Admin UI** and **§7.5 BYOB Storage** sub-sections to `docs/implementation-plan.md` (Phase 7)
  - Each sub-section covers: DB migration tasks, API endpoints, dashboard pages, and test suite checklists

#### Why

Two gaps identified in review of the `.env` configuration surface:

1. Regulated enterprise deployments require audited, no-downtime config changes.
2. HIPAA/FedRAMP/GDPR data residency requirements cannot be met with shared instance storage.

The fail-closed design (BYOB-09) is critical — silent fallback to instance storage would violate data residency guarantees.

#### Testing

Documentation only. All implementing PRs for §7.4 and §7.5 MUST include test suites per the Phase 7.4/7.5 checklists. Key security tests:

- Non-admin sessions rejected from all `/admin/*` routes (including workspace `owner`)
- BYOB fail-closed: 503 with NO fallback to instance storage
