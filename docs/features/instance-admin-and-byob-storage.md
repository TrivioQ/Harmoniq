# Feature: Instance Admin UI & BYOB Storage

> **Requirement IDs:** `INST-01`–`INST-18`, `BYOB-01`–`BYOB-14`  
> **Status:** `active`  
> **Phase:** Phase 7 (§7.4 + §7.5)

Addresses two enterprise self-hosting requirements: a first-class instance admin panel that eliminates direct `.env` editing, and per-workspace bring-your-own-bucket storage for data residency compliance (HIPAA, FedRAMP, GDPR).

---

## Overview

Self-hosted enterprise deployments have two distinct operator roles — the _server operator_ (DevOps/infra) and the _workspace admin_ (product team lead). Currently:

- **Instance Admin UI:** Configuring storage adapters, SMTP, and OAuth providers requires direct `.env` editing and a process restart. This is unacceptable in regulated environments where config changes must be audited and applied without downtime.
- **BYOB Storage:** Enterprises subject to HIPAA, FedRAMP, or EU GDPR data residency requirements cannot store module bundles on shared infrastructure. Each workspace must route all storage I/O to their own S3/GCS/Azure bucket under their own IAM policy.

## Requirements

| ID                  | Requirement                                                                                                                  | Status                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `INST-01`–`INST-18` | Instance Admin UI                                                                                                            | ✅ Done (M4.8; see [enterprise governance](./enterprise-governance.md)) |
| `BYOB-02`–`BYOB-14` | Bring-Your-Own-Bucket Storage: S3 (keys or IAM role, S3-compatible endpoints), GCS, Azure; verification, fail-closed deploys | ✅ Done (M4.9)                                                          |
| `BYOB-01`           | Plan gating (startup / enterprise only, with plan enforcement)                                                               | ✅ Done (M4.11)                                                         |

See [`docs/requirements.md §17`](../requirements.md) and [`§18`](../requirements.md) for the full specification.

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

## Breaking Changes

None. `STORAGE_ADAPTER` env var continues to work as the bootstrap default. Existing workspaces without `WorkspaceStorageConfig` continue using the instance default adapter unchanged.

---

## Change History

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
