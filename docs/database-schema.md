# Harmoniq — Database Schema Reference

> **Version**: 1.0.0  
> **Last Updated**: 2026-10-11  
> **ORM**: Prisma  
> **Database**: PostgreSQL 15+

---

## Entity Relationship Overview

```text
Instance level (no RLS)      InstanceConfig · InstanceConfigVersion · InstanceAdmin · InstanceAdminInvitation · InstanceApiKey · InstanceAuditEvent
                             User · Identity · RefreshToken · EmailLoginToken

Organization (optional,      Organization ── OrganizationMember ── User
no RLS today, ADR-010)            │       ── OrgApiKey · OrganizationAuditEvent
                                  │       ── ScimUser / ScimGroup / ScimAuditEvent (org-scoped rows)
                                  ▼ organizationId (nullable)
Workspace (RLS tenant) ── WorkspaceMember ── User
     │
     ├── WorkspaceConfig · WorkspaceStorageConfig · ApiKey · AuditEvent
     ├── WebhookEndpoint ── WebhookDelivery · WebhookDeadLetter
     ├── ApprovalPolicy · DeploymentRequest ── DeploymentApproval · ScheduledOperation
     ├── AlertRule · ModuleHealthEvent · ModuleHealthRollup · ModuleEnvState
     └── HostApp ── Environment ── ManifestSnapshot
                └── RemoteModule ── ModuleVersion · ModuleOwnership
```

---

## Models

### `User`

| Column                           | Type                   | Notes                                                   |
| -------------------------------- | ---------------------- | ------------------------------------------------------- |
| `id`                             | `CUID`                 | Primary key                                             |
| `email`                          | `String`               | Unique                                                  |
| `name`                           | `String?`              | Display name from OAuth                                 |
| `avatarUrl`                      | `String?`              |                                                         |
| `suspendedAt`, `suspendedReason` | `DateTime?`, `String?` | SES-04: set by an instance admin                        |
| `mfaSecretSealed`                | `String?`              | SES-03: TOTP secret, sealed (`HARMONIQ_ENCRYPTION_KEY`) |
| `mfaEnabledAt`                   | `DateTime?`            | MFA is on once set                                      |
| `mfaRecoveryCodes`               | `String[]`             | sha256 of each unused recovery code                     |
| `mfaLastStep`                    | `Int?`                 | Last TOTP time step accepted (no replay)                |
| `createdAt`                      | `DateTime`             |                                                         |
| `updatedAt`                      | `DateTime`             |                                                         |

### `Workspace`

| Column          | Type       | Notes                       |
| --------------- | ---------- | --------------------------- |
| `id`            | `CUID`     | Primary key                 |
| `slug`          | `String`   | Unique, URL-safe identifier |
| `name`          | `String`   | Display name                |
| `retentionDays` | `Int`      | Default: 90. GC policy      |
| `createdAt`     | `DateTime` |                             |
| `updatedAt`     | `DateTime` |                             |

### `WorkspaceMember`

| Column           | Type        | Notes                                                                                                                     |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `CUID`      | Primary key                                                                                                               |
| `workspaceId`    | `CUID`      | FK → Workspace (RLS key)                                                                                                  |
| `userId`         | `CUID`      | FK → User                                                                                                                 |
| `role`           | `Enum`      | `owner \| admin \| developer \| viewer`                                                                                   |
| `invitedAt`      | `DateTime`  |                                                                                                                           |
| `joinedAt`       | `DateTime?` | Null until accepted                                                                                                       |
| `orgProvisioned` | `Boolean`   | ORG-07: granted by the organization's group rules, which keep it in line (and remove it); invited memberships are `false` |

**Unique constraint**: `(workspaceId, userId)`

### `HostApp`

| Column               | Type       | Notes                                                  |
| -------------------- | ---------- | ------------------------------------------------------ |
| `id`                 | `CUID`     | Primary key                                            |
| `workspaceId`        | `CUID`     | FK → Workspace (RLS key)                               |
| `name`               | `String`   | Display name                                           |
| `slug`               | `String`   | URL-safe, unique within workspace                      |
| `description`        | `String?`  |                                                        |
| `sharedDependencies` | `Json?`    | M3.7: package → semver range shared with every module  |
| `strictExposes`      | `Boolean`  | M3.7: reject deploys that drop exposes (default false) |
| `createdAt`          | `DateTime` |                                                        |

**Unique constraint**: `(workspaceId, slug)`  
**RLS**: enabled, policy on `workspaceId`

### `Environment`

| Column                                                            | Type        | Notes                              |
| ----------------------------------------------------------------- | ----------- | ---------------------------------- |
| `id`                                                              | `CUID`      | Primary key                        |
| `hostAppId`                                                       | `CUID`      | FK → HostApp                       |
| `name`                                                            | `String`    | e.g. `production`, `staging`       |
| `slug`                                                            | `String`    | URL-safe                           |
| `isDefault`                                                       | `Boolean`   | Default: false                     |
| `freezeFrom`                                                      | `DateTime?` | ENV-FRZ-04: scheduled freeze start |
| `freezeOverrideUntil`, `freezeOverrideReason`, `freezeOverrideBy` |             | ENV-FRZ-03: owner override window  |

**Unique constraint**: `(hostAppId, slug)`

### `RemoteModule`

| Column        | Type       | Notes                    |
| ------------- | ---------- | ------------------------ |
| `id`          | `CUID`     | Primary key              |
| `workspaceId` | `CUID`     | FK → Workspace (RLS key) |
| `hostAppId`   | `CUID`     | FK → HostApp             |
| `name`        | `String`   | Module federation name   |
| `slug`        | `String`   | URL-safe                 |
| `description` | `String?`  |                          |
| `orgShared`   | `Boolean`  | ORG-10, default false    |
| `createdAt`   | `DateTime` |                          |

**Unique constraint**: `(hostAppId, slug)`  
**RLS**: enabled, policy on `workspaceId`

### `ModuleVersion`

| Column           | Type        | Notes                                                                                     |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `id`             | `CUID`      | Primary key                                                                               |
| `workspaceId`    | `CUID`      | FK → Workspace (RLS key)                                                                  |
| `remoteModuleId` | `CUID`      | FK → RemoteModule                                                                         |
| `environmentId`  | `CUID`      | FK → Environment                                                                          |
| `version`        | `String`    | SemVer or arbitrary tag                                                                   |
| `url`            | `String`    | Public CDN URL of the bundle                                                              |
| `integrity`      | `String`    | SHA-256 hash of the bundle                                                                |
| `storagePath`    | `String?`   | Path in IStorage (null if external CDN)                                                   |
| `status`         | `Enum`      | `active \| inactive \| canary \| orphaned`                                                |
| `trafficPercent` | `Int?`      | 1–99; set when status = canary                                                            |
| `deployedBy`     | `String`    | User ID or API key ID                                                                     |
| `deployedByType` | `Enum`      | `user \| apiKey`                                                                          |
| `commitSha`      | `String?`   | Optional git commit reference                                                             |
| `sizeBytes`      | `BigInt?`   | USG-02: bundle size, measured by validation or reported by the uploader (null: unknown)   |
| `metadata`       | `Json?`     | Arbitrary key-value pairs                                                                 |
| `deployedAt`     | `DateTime`  |                                                                                           |
| `activatedAt`    | `DateTime?` | Last time it became active; null for aborted canaries, which "rollback to previous" skips |
| `deletedAt`      | `DateTime?` | Soft-delete timestamp; set by GC                                                          |

**Indexes**: `(workspaceId, remoteModuleId, environmentId, status)`, `(deletedAt)`  
**RLS**: enabled, policy on `workspaceId`

**Business rule**: only one version per `(remoteModuleId, environmentId)` may have `status = active` at a time. Enforced by transaction in application layer.

### `ApiKey`

| Column           | Type        | Notes                                     |
| ---------------- | ----------- | ----------------------------------------- |
| `id`             | `CUID`      | Primary key                               |
| `workspaceId`    | `CUID`      | FK → Workspace (RLS key)                  |
| `name`           | `String`    | Human-readable label                      |
| `keyHash`        | `String`    | argon2id hash of raw key                  |
| `prefix`         | `String`    | First 8 chars of raw key (for display)    |
| `scopes`         | `String[]`  | `deploy:write`, `manifest:read`, `admin`  |
| `expiresAt`      | `DateTime?` | Null = never expires                      |
| `gracePeriodEnd` | `DateTime?` | Set during key rotation                   |
| `lastUsedAt`     | `DateTime?` |                                           |
| `revokedAt`      | `DateTime?` | Null = active                             |
| `createdAt`      | `DateTime`  |                                           |
| `createdBy`      | `CUID?`     | FK → User; null when an org key issued it |
| `createdByKeyId` | `String?`   | The org API key that issued it (IaC-01)   |

**RLS**: enabled, policy on `workspaceId`

### `RefreshToken`

| Column            | Type        | Notes                                                                          |
| ----------------- | ----------- | ------------------------------------------------------------------------------ |
| `id`              | `CUID`      | Primary key                                                                    |
| `userId`          | `CUID`      | FK → User                                                                      |
| `tokenHash`       | `String`    | sha256 of the opaque token                                                     |
| `familyId`        | `String`    | The session; reuse of a rotated token revokes the family                       |
| `expiresAt`       | `DateTime`  | SES-01: the earlier of the session's maximum and the idle timeout              |
| `provider`        | `String?`   | How the session signed in                                                      |
| `mfaVerified`     | `Boolean`   | SES-03: the session passed a second factor                                     |
| `ip`, `userAgent` | `String?`   | SES-02: where it was used from                                                 |
| `reauthAt`        | `DateTime?` | INST-32: last sign-in or re-authentication; carried into access tokens (`rat`) |
| `usedAt`          | `DateTime?` | Set on rotation (invalidates after use)                                        |
| `revokedAt`       | `DateTime?` | Set on logout                                                                  |
| `createdAt`       | `DateTime`  |                                                                                |

### `WebhookEndpoint`

| Column        | Type       | Notes                                          |
| ------------- | ---------- | ---------------------------------------------- |
| `id`          | `CUID`     | Primary key                                    |
| `workspaceId` | `CUID`     | FK → Workspace (RLS key)                       |
| `url`         | `String`   | Target HTTP endpoint                           |
| `events`      | `String[]` | Subscribed event types                         |
| `secret`      | `String`   | HMAC-SHA256 signing secret (encrypted at rest) |
| `active`      | `Boolean`  | Default: true                                  |
| `createdAt`   | `DateTime` |                                                |

**RLS**: enabled, policy on `workspaceId`

### `WebhookDelivery`

| Column              | Type       | Notes                          |
| ------------------- | ---------- | ------------------------------ |
| `id`                | `CUID`     | Primary key                    |
| `webhookEndpointId` | `CUID`     | FK → WebhookEndpoint           |
| `workspaceId`       | `CUID`     | FK → Workspace (RLS key)       |
| `event`             | `String`   | e.g. `manifest.updated`        |
| `payload`           | `Json`     | Full event payload             |
| `statusCode`        | `Int?`     | HTTP response code from target |
| `attempt`           | `Int`      | 1-based retry count            |
| `durationMs`        | `Int?`     | Request round-trip time        |
| `success`           | `Boolean`  |                                |
| `createdAt`         | `DateTime` |                                |

### `AuditEvent`

| Column         | Type       | Notes                                                                             |
| -------------- | ---------- | --------------------------------------------------------------------------------- |
| `id`           | `CUID`     | Primary key                                                                       |
| `workspaceId`  | `CUID`     | Workspace id (RLS key); no FK, so the trail outlives a deleted workspace (AUD-05) |
| `actorId`      | `String`   | User ID or ApiKey ID                                                              |
| `actorType`    | `Enum`     | `user \| apiKey \| system` (jobs such as auto-rollback)                           |
| `action`       | `String`   | e.g. `module.deploy`, `key.revoke`                                                |
| `resourceType` | `String`   | e.g. `ModuleVersion`, `ApiKey`                                                    |
| `resourceId`   | `String`   | ID of the affected resource                                                       |
| `metadata`     | `Json?`    | Contextual data (version, env, etc.)                                              |
| `ip`           | `String?`  | Requester IP                                                                      |
| `createdAt`    | `DateTime` | Immutable                                                                         |

**RLS**: enabled, policy on `workspaceId`  
**No soft-delete**: this table is append-only and has no `deletedAt` column.  
**Index**: `(workspaceId, createdAt DESC)`, `(workspaceId, actorId)`, `(workspaceId, action)`

### `WorkspaceConfig`

| Column                      | Type                   | Notes                                                    |
| --------------------------- | ---------------------- | -------------------------------------------------------- |
| `id`                        | `CUID`                 | Primary key                                              |
| `workspaceId`               | `CUID`                 | Unique FK → Workspace (one per workspace)                |
| `oauthProvider`             | `String`               | `github \| google`                                       |
| `oauthConfig`               | `Json`                 | Encrypted provider-specific config                       |
| `storageProvider`           | `String`               | `local \| s3 \| gcs`                                     |
| `storageConfig`             | `Json`                 | Encrypted provider-specific config                       |
| `logProvider`               | `String`               | `console \| otel`                                        |
| `logConfig`                 | `Json`                 | Provider-specific config                                 |
| `plan`                      | `String`               | PLN-01: `hobby \| startup \| enterprise`                 |
| `planOverrides`             | `Json?`                | PLN-06: `{ features?, limits? }` set by instance admins  |
| `planExpiresAt`, `basePlan` | `DateTime?`, `String?` | PLN-06: a trial; `plans.expire` falls back to `basePlan` |
| `updatedAt`                 | `DateTime`             |                                                          |

---

## Row-Level Security Policies

See [ADR-003](./architecture.md#adr-003-postgresql-row-level-security-for-multi-tenancy) and [ADR-010](./architecture.md#adr-010-organization-scoped-row-level-security). The registry connects with two roles:

| Role           | Connection            | Used for                                                                                                     | RLS              |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| `harmoniq`     | `SYSTEM_DATABASE_URL` | Migrations (schema owner); `systemDb` for tenant resolution, creating tenants, sign-in, jobs, instance admin | Bypassed (owner) |
| `harmoniq_app` | `DATABASE_URL`        | Everything done for a tenant (`withTenant`, `withOrg`)                                                       | Always applies   |

Work for a workspace runs inside `withTenant`; work for an organization (its routes, SCIM and SSO provisioning, cross-workspace reads such as the org home, catalog, audit and shared modules) inside `withOrg`:

```typescript
// packages/db/src/index.ts
await client.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
  return fn(tx);
});

// withOrg: the organization, and its workspaces resolved inside the same transaction.
await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`;
await tx.$executeRaw`SELECT set_config('app.current_org_workspace_ids',
  coalesce((SELECT string_agg("id", ',') FROM "Workspace" WHERE "organizationId" = ${organizationId}), ''), true)`;
```

Policies are created in the migrations themselves. A workspace-scoped table admits its workspace, or one of the current organization's workspaces:

```sql
CREATE POLICY workspace_isolation_version ON "ModuleVersion"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)
      OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));
```

| Scope                                              | Tables                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| By `workspaceId` (workspace or its org)            | `WorkspaceMember`, `HostApp`, `RemoteModule`, `ModuleVersion`, `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`, `WebhookDeadLetter`, `AuditEvent`, `ModuleOwnership`, `AlertRule`, `ManifestSnapshot`, `ModuleHealthEvent`, `ModuleHealthRollup`, `ModuleEnvState`, `ScheduledOperation`, `ApprovalPolicy`, `DeploymentRequest`, `WorkspaceConfig`, `WorkspaceStorageConfig`, `UsageDaily` |
| By `workspaceId` or `organizationId`               | `ScimUser`, `ScimGroup`, `ScimAuditEvent`, `VerifiedDomain`, `OwnershipTransfer`, `Invitation` (rows of a workspace or of an organization)                                                                                                                                                                                                                                                |
| `Workspace`                                        | Its `id` is the current workspace or one of the organization's, or its `organizationId` is the current organization                                                                                                                                                                                                                                                                       |
| By `organizationId`                                | `OrganizationMember`, `OrgApiKey`, `OrganizationAuditEvent`; `Organization` by `id`                                                                                                                                                                                                                                                                                                       |
| By `organizationId`, read also from its workspaces | `OrgPolicy` (separate `SELECT` and write policies)                                                                                                                                                                                                                                                                                                                                        |
| Through the parent row                             | `Environment` (via `HostApp`), `DeploymentApproval` (via `DeploymentRequest`)                                                                                                                                                                                                                                                                                                             |
| No RLS, revoked from `harmoniq_app`                | `Identity`, `EmailLoginToken`, `RefreshToken`                                                                                                                                                                                                                                                                                                                                             |
| No RLS (global)                                    | `User` (accounts are shared across tenants), `InstanceConfig`, `InstanceConfigVersion`, `InstanceAdmin`, `InstanceAdminInvitation`, `InstanceApiKey`, `InstanceAuditEvent`                                                                                                                                                                                                                |

Append-only for `harmoniq_app` (`REVOKE UPDATE, DELETE`): `AuditEvent`, `OrganizationAuditEvent`, `InstanceAuditEvent`. `AuditEvent` and `ScimAuditEvent` have no foreign key to `Workspace` (AUD-05): a deleted workspace's audit trail stays, still scoped by `workspaceId`, until GC removes events older than `HARMONIQ_AUDIT_RETENTION_DAYS`.

MT-09: registry routes may not use `systemDb` (ESLint `no-restricted-syntax` on `apps/registry/src/routes`); each allowed use is marked with its reason. `packages/db/src/__tests__/rls.test.ts` checks both scopes (no rows without a context, nothing of another workspace or organization, no context left on pooled connections), and `apps/registry/src/__tests__/tenantIsolation.test.ts` calls every GET route as one organization and checks no response mentions another (MT-10).

---

## Migration Strategy

- Migrations are managed by Prisma (`prisma migrate dev` / `prisma migrate deploy`).
- RLS policies, grants and revokes are part of the migration SQL files. Roles are created before the first migration (`docker/init.sql` or `apps/registry/scripts/bootstrap-db.ts`; see [self-hosting](./self-hosting.md)).
- All migration files are committed to `packages/db/prisma/migrations/`.
- **Never use `prisma db push` in production**.

---

## Column Additions to Existing Models (v1.1)

### `ModuleVersion` — New Columns

| Column             | Type      | Notes                                                      |
| ------------------ | --------- | ---------------------------------------------------------- |
| `dependencies`     | `Json?`   | `Record<string, string>` — semver ranges (DEP-01)          |
| `exposes`          | `Json?`   | Module Federation exposes map (VAL-01)                     |
| `promotedFromId`   | `String?` | FK → `ModuleVersion` — source version if promoted (PRO-02) |
| `promotedFromEnv`  | `String?` | Snapshot of source environment slug (PRO-02)               |
| `rolloutSchedule`  | `Json?`   | `RolloutBand[]` — staged rollout config (STG-01)           |
| `currentBandIndex` | `Int?`    | Active band index during staged rollout (STG-02)           |

### `Environment` — New Columns

| Column         | Type        | Notes                                                |
| -------------- | ----------- | ---------------------------------------------------- |
| `frozenAt`     | `DateTime?` | Null = not frozen (ENV-FRZ-01)                       |
| `frozenBy`     | `String?`   | `WorkspaceMember` ID who froze the env               |
| `freezeReason` | `String?`   | Displayed in `423` responses and the dashboard badge |
| `freezeUntil`  | `DateTime?` | Null = manual unfreeze required (ENV-FRZ-04)         |

### `ApiKey` — New Columns

| Column      | Type       | Notes                                                                      |
| ----------- | ---------- | -------------------------------------------------------------------------- |
| `moduleIds` | `String[]` | Empty = all modules; non-empty = restricted to listed module IDs (RBAC-04) |

### `WebhookEndpoint` — New Columns

| Column             | Type      | Notes                        |
| ------------------ | --------- | ---------------------------- |
| `maxRetries`       | `Int`     | Default: 5, max: 25 (WHK-03) |
| `backoffCeilingMs` | `Int`     | Default: 300,000 (WHK-06)    |
| `paused`           | `Boolean` | Default: false (WHK-10)      |

### `WorkspaceConfig` — New Columns

| Column               | Type        | Notes                                                                         |
| -------------------- | ----------- | ----------------------------------------------------------------------------- |
| `oauthProvider`      | `String`    | Now supports: `github \| google \| oidc \| saml`                              |
| `oidcConfig`         | `Json?`     | Encrypted: issuer, clientId, clientSecret, scopes, roleMapping (SSO-03)       |
| `samlConfig`         | `Json?`     | Encrypted: entityId, ssoUrl, sloUrl, idpCert, spKeyPair, attrMapping (SSO-15) |
| `forceSso`           | `Boolean`   | Default: false (SSO-26)                                                       |
| `trustedDomains`     | `String[]`  | e.g. `["acme.com"]` (SSO-22)                                                  |
| `defaultSsoRole`     | `String`    | Default: `"viewer"` — role assigned on domain-based auto-join                 |
| `scimEnabled`        | `Boolean`   | Default: false (SSO-24)                                                       |
| `scimTokenHash`      | `String?`   | Unique; sha256 of the SCIM bearer token (high-entropy, looked up by hash)     |
| `scimTokenCreatedAt` | `DateTime?` | When the current token was issued                                             |
| `plan`               | `String`    | `hobby \| startup \| enterprise` — default: `hobby` (PLN-01)                  |

---

## New Tables (v1.1)

### `ModuleOwnership`

| Column              | Type   | Notes                    |
| ------------------- | ------ | ------------------------ |
| `id`                | `CUID` | Primary key              |
| `workspaceId`       | `CUID` | FK → Workspace (RLS key) |
| `remoteModuleId`    | `CUID` | FK → RemoteModule        |
| `workspaceMemberId` | `CUID` | FK → WorkspaceMember     |

**Unique constraint**: `(remoteModuleId, workspaceMemberId)`  
**RLS**: enabled, policy on `workspaceId`

---

### `AlertRule`

Evaluated every minute by `alert.evaluate` (ALT-05).

| Column                                                         | Type       | Notes                                                                                                                          |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                           | `CUID`     | Primary key                                                                                                                    |
| `workspaceId`                                                  | `CUID`     | FK → Workspace (RLS key)                                                                                                       |
| `name`                                                         | `String`   |                                                                                                                                |
| `remoteModuleId`                                               | `CUID?`    | FK → RemoteModule (cascade); required for module conditions                                                                    |
| `environmentId`                                                | `CUID?`    | FK → Environment (cascade); required for module conditions                                                                     |
| `condition`                                                    | `String`   | `canary_error_rate`, `canary_error_rate_delta`, `canary_load_p95ms`, `load_success_rate`, `load_p95ms`, `webhook_failure_rate` |
| `threshold`                                                    | `Float`    | Fraction (rates) or milliseconds                                                                                               |
| `action`                                                       | `String`   | `"webhook" \| "auto_rollback"`                                                                                                 |
| `actionConfig`                                                 | `Json`     | Reserved                                                                                                                       |
| `windowMinutes`, `minSamples`                                  | `Int`      | Defaults 5 and 20; no decision below `minSamples`                                                                              |
| `cooldownMinutes`                                              | `Int`      | Default 15; minimum time between firings                                                                                       |
| `enabled`                                                      | `Boolean`  | Default: true                                                                                                                  |
| `state`                                                        | `String`   | `ok` or `firing`                                                                                                               |
| `lastValue`, `lastEvaluatedAt`, `lastTriggeredAt`, `lastError` |            | Last evaluation; `lastError` explains a failed auto-rollback                                                                   |
| `createdAt`                                                    | `DateTime` |                                                                                                                                |

**RLS**: enabled, policy on `workspaceId`

---

### `ModuleEnvState`

Kill switch per module and environment (M3.6).

| Column           | Type       | Notes                                |
| ---------------- | ---------- | ------------------------------------ |
| `id`             | `CUID`     | Primary key                          |
| `workspaceId`    | `CUID`     | FK → Workspace (RLS key)             |
| `remoteModuleId` | `CUID`     | FK → RemoteModule                    |
| `environmentId`  | `CUID`     | FK → Environment                     |
| `disabled`       | `Boolean`  | Manifest marks the module `disabled` |
| `reason`         | `String?`  | Shown to hosts as `disabledReason`   |
| `updatedBy`      | `String`   | Principal id                         |
| `updatedAt`      | `DateTime` |                                      |

**Unique**: `(remoteModuleId, environmentId)`  
**RLS**: enabled, policy on `workspaceId`

---

### `ScheduledOperation`

An API call to run later (M3.6), as its creator.

| Column                                       | Type       | Notes                                                      |
| -------------------------------------------- | ---------- | ---------------------------------------------------------- |
| `id`                                         | `CUID`     | Primary key                                                |
| `workspaceId`                                | `CUID`     | FK → Workspace (RLS key)                                   |
| `type`                                       | `String`   | `deploy`, `promote`, `rollback`, `canary_*`, `kill_switch` |
| `module`, `environment`                      | `String?`  | For listings                                               |
| `method`, `path`, `body`                     |            | The call; the path uses the module id                      |
| `runAt`                                      | `DateTime` |                                                            |
| `status`                                     | `String`   | `pending`, `running`, `done`, `failed`, `cancelled`        |
| `createdById`, `createdByType`               |            | Who it runs as                                             |
| `startedAt`, `finishedAt`, `result`, `error` |            | Outcome                                                    |

**Index**: `(status, runAt)`, `(workspaceId, runAt)`  
**RLS**: enabled, policy on `workspaceId`

---

### `ManifestSnapshot`

| Column          | Type        | Notes                                        |
| --------------- | ----------- | -------------------------------------------- |
| `id`            | `CUID`      | Primary key                                  |
| `workspaceId`   | `CUID`      | FK → Workspace (RLS key)                     |
| `hostAppId`     | `CUID`      | FK → HostApp                                 |
| `environmentId` | `CUID`      | FK → Environment                             |
| `manifestJson`  | `Json`      | Full manifest at this point in time          |
| `etag`          | `String`    | ETag of this snapshot                        |
| `auditEventId`  | `String`    | FK → AuditEvent that triggered this snapshot |
| `createdAt`     | `DateTime`  | Immutable                                    |
| `deletedAt`     | `DateTime?` | Soft-delete (GC via retentionDays)           |

**Index**: `(workspaceId, hostAppId, environmentId, createdAt DESC)`  
**RLS**: enabled, policy on `workspaceId`

---

### `WebhookDeadLetter`

| Column              | Type        | Notes                                             |
| ------------------- | ----------- | ------------------------------------------------- |
| `id`                | `CUID`      | Primary key                                       |
| `workspaceId`       | `CUID`      | FK → Workspace (RLS key)                          |
| `webhookEndpointId` | `CUID`      | FK → WebhookEndpoint                              |
| `event`             | `String`    | Event type                                        |
| `payload`           | `Json`      | Full event payload                                |
| `finalStatusCode`   | `Int?`      | Last HTTP response code from target               |
| `finalResponseBody` | `String?`   | Truncated response body for debugging             |
| `totalAttempts`     | `Int`       | Total delivery attempts made                      |
| `firstAttemptAt`    | `DateTime`  |                                                   |
| `exhaustedAt`       | `DateTime`  | When retries were exhausted                       |
| `retriedAt`         | `DateTime?` | Set when manually retried from dashboard (WHK-09) |
| `resolvedAt`        | `DateTime?` | Set when delivery eventually succeeds             |

**RLS**: enabled, policy on `workspaceId`

---

### `ModuleHealthEvent`

| Column           | Type       | Notes                                                          |
| ---------------- | ---------- | -------------------------------------------------------------- |
| `id`             | `CUID`     | Primary key                                                    |
| `workspaceId`    | `CUID`     | FK → Workspace (RLS key)                                       |
| `remoteModuleId` | `CUID`     | FK → RemoteModule                                              |
| `environmentId`  | `CUID`     | FK → Environment                                               |
| `variant`        | `String`   | `"stable" \| "canary"`, derived by the registry from `version` |
| `version`        | `String?`  | Reported module version (must be live in the environment)      |
| `success`        | `Boolean`  | Whether the module loaded successfully                         |
| `loadMs`         | `Int?`     | Load time in milliseconds                                      |
| `errorMessage`   | `String?`  | Truncated error message on failure                             |
| `clientVersion`  | `String?`  | `@harmoniq/client` version                                     |
| `reportedAt`     | `DateTime` | Default: now()                                                 |

**Index**: `(workspaceId, remoteModuleId, environmentId, reportedAt)`, `(environmentId, reportedAt)`  
**RLS**: enabled, policy on `workspaceId`  
**Note**: Records older than 24h are eligible for purge (high-volume table — not subject to `retentionDays`).

### `ModuleHealthRollup`

Hourly totals per module, environment and variant, upserted from raw events every 5 minutes (`health.rollup`); feeds the sparklines. Kept 30 days.

| Column                      | Type       | Notes                    |
| --------------------------- | ---------- | ------------------------ |
| `id`                        | `String`   | Primary key              |
| `workspaceId`               | `CUID`     | FK → Workspace (RLS key) |
| `remoteModuleId`            | `CUID`     | FK → RemoteModule        |
| `environmentId`             | `CUID`     | FK → Environment         |
| `variant`                   | `String`   | `"stable" \| "canary"`   |
| `hour`                      | `DateTime` | Start of the hour (UTC)  |
| `sampleCount`, `errorCount` | `Int`      | Loads and failed loads   |
| `p50LoadMs`, `p95LoadMs`    | `Int?`     | Over successful loads    |

**Unique**: `(remoteModuleId, environmentId, variant, hour)`  
**RLS**: enabled, policy on `workspaceId`

---

### `ScimUser`

| Column                                   | Type        | Notes                                                 |
| ---------------------------------------- | ----------- | ----------------------------------------------------- |
| `id`                                     | `CUID`      | Primary key; the SCIM resource id                     |
| `workspaceId`                            | `CUID?`     | FK → Workspace (RLS key)                              |
| `organizationId`                         | `CUID?`     | FK → Organization (ORG-07); exactly one of the two    |
| `userId`                                 | `CUID`      | FK → User                                             |
| `userName`, `externalId`                 | `String`    | As sent by the IdP                                    |
| `displayName`, `givenName`, `familyName` | `String?`   |                                                       |
| `active`                                 | `Boolean`   | `false`: deprovisioned                                |
| `deletedAt`                              | `DateTime?` | Deleted at the IdP; kept so SSO can't re-add the user |

**Unique**: `(workspaceId, userId)`, `(workspaceId, userName)`, `(organizationId, userId)`, `(organizationId, userName)`  
**RLS**: enabled, policy on `workspaceId` (organization rows have none, so tenants never see them; the registry reads them with the system client)

### `ScimGroup`

| Column                      | Type       | Notes                                                                    |
| --------------------------- | ---------- | ------------------------------------------------------------------------ |
| `id`                        | `CUID`     | Primary key; the SCIM resource id                                        |
| `workspaceId`               | `CUID?`    | FK → Workspace (RLS key)                                                 |
| `organizationId`            | `CUID?`    | FK → Organization; exactly one of the two                                |
| `displayName`, `externalId` | `String`   | The name maps to a role (SSO mapping, or the organization's group rules) |
| `memberIds`                 | `String[]` | ScimUser ids                                                             |

**Unique**: `(workspaceId, displayName)`, `(organizationId, displayName)`  
**RLS**: enabled, policy on `workspaceId`

### `ScimAuditEvent`

| Column           | Type       | Notes                                     |
| ---------------- | ---------- | ----------------------------------------- |
| `id`             | `CUID`     | Primary key                               |
| `workspaceId`    | `CUID?`    | FK → Workspace (RLS key)                  |
| `organizationId` | `CUID?`    | FK → Organization; exactly one of the two |
| `operation`      | `String`   | Method and route, e.g. `PATCH /Users/:id` |
| `scimUserId`     | `String`   | The SCIM resource id (user or group)      |
| `payload`        | `Json`     | SCIM request body (passwords dropped)     |
| `statusCode`     | `Int`      | HTTP status code returned                 |
| `createdAt`      | `DateTime` | Immutable                                 |

**Index**: `(workspaceId, createdAt DESC)`, `(organizationId, createdAt DESC)`  
**RLS**: enabled, policy on `workspaceId`

---

## New Tables (Phase 8 — Enterprise Governance)

### Column Additions to Existing Models

#### `Workspace` — New Columns

| Column                           | Type                   | Notes                                                                         |
| -------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `organizationId`                 | `String?`              | FK → Organization. Null = standalone workspace (ORG-03)                       |
| `suspendedAt`, `suspendedReason` | `DateTime?`, `String?` | INST-09: set by an instance admin; writes are refused, manifests still served |

---

### `Organization`

| Column                                                        | Type        | Notes                                                                                        |
| ------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `id`                                                          | `CUID`      | Primary key                                                                                  |
| `slug`                                                        | `String`    | Unique, URL-safe (e.g., `acme-corp`)                                                         |
| `name`                                                        | `String`    | Display name                                                                                 |
| `plan`                                                        | `String`    | `hobby \| startup \| enterprise`                                                             |
| `planOverrides`, `planExpiresAt`, `basePlan`                  |             | PLN-06: as for workspaces                                                                    |
| `oidcConfig`                                                  | `Json?`     | ORG-05: org-level OIDC (client secret sealed), inherited by workspaces without their own SSO |
| `samlConfig`                                                  | `Json?`     | ORG-05/06: org-level SAML 2.0 (SP private key sealed)                                        |
| `forceSso`                                                    | `Boolean`   | Forced SSO for the inheriting workspaces                                                     |
| `trustedDomains`                                              | `String[]`  | Users of these domains join on SSO sign-in                                                   |
| `provisioning`                                                | `Json?`     | ORG-07: `{ rules: [{ group, workspace, role }], adminGroups }`                               |
| `scimEnabled`, `scimTokenHash` (unique), `scimTokenCreatedAt` |             | ORG-07: the org SCIM token (sha256)                                                          |
| `createdAt`                                                   | `DateTime`  |                                                                                              |
| `deletedAt`                                                   | `DateTime?` | Soft-delete                                                                                  |

**Unique**: `slug`  
**Note**: NOT tenant-scoped by RLS (Organization is the root entity, above workspace isolation).

---

### `OrganizationMember`

| Column           | Type       | Notes                     |
| ---------------- | ---------- | ------------------------- |
| `id`             | `CUID`     | Primary key               |
| `organizationId` | `CUID`     | FK → Organization         |
| `userId`         | `CUID`     | FK → User                 |
| `role`           | `String`   | `org_admin \| org_member` |
| `createdAt`      | `DateTime` |                           |

**Unique**: `(organizationId, userId)`

---

### `UsageDaily`

USG-01: one row per workspace and UTC day. Counters are added by every replica (`ON CONFLICT DO UPDATE SET x = x + excluded.x`, ADR-012); levels come from the nightly `usage.snapshot`, which also drops rows older than 13 months. No foreign key: history doesn't depend on the workspace row.

| Column             | Type     | Notes                                               |
| ------------------ | -------- | --------------------------------------------------- |
| `workspaceId`      | `CUID`   | Primary key with `day`                              |
| `day`              | `Date`   | UTC                                                 |
| `manifestRequests` | `BigInt` | Served manifests (200 and 304, cache hits included) |
| `deploys`          | `Int`    | Deploys and promotes                                |
| `healthEvents`     | `Int`    | Accepted health events                              |
| `storageBytes`     | `BigInt` | Snapshot: `sizeBytes` of versions not deleted       |
| `members`          | `Int`    | Snapshot: joined members                            |
| `apiKeys`          | `Int`    | Snapshot: active keys                               |

**Index**: `day`. RLS as other workspace rows (the workspace, or the current organization's workspaces).

### Audit chain columns (AUD-09)

`AuditEvent`, `OrganizationAuditEvent` and `InstanceAuditEvent` have `chainSeq` (`BigInt`), `prevHash` and `hash` (`String`), set by the `harmoniq_audit_chain` `BEFORE INSERT` trigger. It takes a transaction-level advisory lock per scope (workspace, organization or instance), so concurrent inserts can't fork a chain, and it hashes with `harmoniq_audit_hash()`, which the verify endpoints use too. Indexes: `(workspaceId, chainSeq)`, `(organizationId, chainSeq)`, `(chainSeq)`.

### `OrgWebhookEndpoint`, `OrgWebhookDelivery`, `OrgWebhookDeadLetter`

TAD-10: like the workspace webhook tables, keyed by `organizationId` (org RLS); `secret` is sealed.

### `NotificationChannel`

TAD-09: `organizationId`, `kind` (`email` \| `slack` \| `teams`), `name`, `target` (comma-separated emails, or the sealed incoming-webhook URL), `events[]`, `active`, `lastSentAt`, `lastError`. Org RLS.

### `AuditSink`, `AuditSinkDeadLetter`

AUD-06: `AuditSink` has `organizationId`, `kind` (`https` \| `s3`), `name`, `config` (sealed JSON with the URL and secret, or the bucket and credentials), `enabled`, the cursor `cursorAt`/`cursorId` (the last event delivered), `failures`, `lastError`, `lastDeliveredAt`. `AuditSinkDeadLetter` records a batch given up on (`fromAt`/`fromId` to `toAt`/`toId`, `events`, `error`, `retriedAt`). Org RLS.

### `OrgPolicy`

POL-01..08: one row per organization (`organizationId` is the key; deleted with it). Readable in the organization's scope and in its workspaces' (enforcement runs in workspace transactions), written only in the organization's scope.

| Column                   | Type                  | Notes                                                                                                            |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `organizationId`         | `CUID`                | Primary key, FK → Organization                                                                                   |
| `approvalDefaults`       | `Json`                | `[{ environmentPattern, requiredApprovers, eligibleRoles, requireChangeTicket, ticketUrlPattern, expiryHours }]` |
| `maxApiKeyDays`          | `Int?`                | Keys must expire within this many days                                                                           |
| `allowedKeyScopes`       | `String[]`            | Empty: every scope                                                                                               |
| `minRetentionDays`       | `Int?`                | Retention floor (PATCH and GC)                                                                                   |
| `freezeWindows`          | `Json`                | `[{ id, environmentPattern, from, until, reason, override: { until, reason, by } }]`                             |
| `lockSso`                | `Boolean`             | Workspace SSO ignored and refused                                                                                |
| `requireMfa`             | `Boolean`             | SES-03: members signing in without SSO need MFA                                                                  |
| `sessionMaxHours`        | `Int?`                | Checked at refresh                                                                                               |
| `idleTimeoutMinutes`     | `Int?`                | Checked at refresh                                                                                               |
| `ipAllowlist`            | `String[]`            | CIDR blocks or addresses                                                                                         |
| `ipAllowlistManifests`   | `Boolean`             | The allowlist also covers manifests and health                                                                   |
| `updatedAt`, `updatedBy` | `DateTime`, `String?` |                                                                                                                  |

### `OrgApiKey`

| Column           | Type        | Notes                                       |
| ---------------- | ----------- | ------------------------------------------- |
| `id`             | `CUID`      | Primary key                                 |
| `organizationId` | `CUID`      | FK → Organization                           |
| `keyHash`        | `String`    | argon2id hash of the raw key                |
| `name`           | `String`    | Human-readable label                        |
| `prefix`         | `String`    | Display prefix `hq_org_…`                   |
| `scopes`         | `String[]`  | As workspace keys                           |
| `workspaceScope` | `String[]`  | Workspace ids; empty = all                  |
| `moduleScope`    | `String[]`  | Module ids; empty = all                     |
| `expiresAt`      | `DateTime?` |                                             |
| `gracePeriodEnd` | `DateTime?` | Set on the old key during rotation (TAD-05) |
| `lastUsedAt`     | `DateTime?` |                                             |
| `createdBy`      | `String?`   | User id (null when an org key issued it)    |
| `createdAt`      | `DateTime`  |                                             |
| `revokedAt`      | `DateTime?` | Null = active                               |

### `InstanceAuditEvent`

INST-18: instance-level changes (setup, workspace suspension and deletion, users, instance admins, instance config). Append-only for `harmoniq_app` (`UPDATE`/`DELETE` revoked); never holds config values or secrets.

| Column                       | Type             | Notes                                  |
| ---------------------------- | ---------------- | -------------------------------------- |
| `id`                         | `CUID`           | Primary key                            |
| `actorType`, `actorId`       | `Enum`, `String` | The instance admin (or `system:setup`) |
| `action`                     | `String`         | `instance.*`                           |
| `resourceType`, `resourceId` | `String`         |                                        |
| `metadata`                   | `Json?`          |                                        |
| `ip`                         | `String?`        |                                        |
| `createdAt`                  | `DateTime`       |                                        |

**Index**: `createdAt DESC`. Not tenant-scoped.

### `OrganizationAuditEvent`

| Column                                 | Type       | Notes                 |
| -------------------------------------- | ---------- | --------------------- |
| `id`                                   | `CUID`     | Primary key           |
| `organizationId`                       | `CUID`     | FK → Organization     |
| `actorType`, `actorId`                 | —          | As `AuditEvent`       |
| `action`, `resourceType`, `resourceId` | `String`   | e.g. `org.member_add` |
| `metadata`                             | `Json?`    |                       |
| `ip`                                   | `String?`  |                       |
| `createdAt`                            | `DateTime` |                       |

**Index**: `(organizationId, createdAt DESC)`; append-only for the app role.

---

### `ApprovalPolicy`

| Column                | Type       | Notes                                           |
| --------------------- | ---------- | ----------------------------------------------- |
| `id`                  | `CUID`     | Primary key                                     |
| `workspaceId`         | `CUID`     | FK → Workspace (RLS key)                        |
| `environmentId`       | `CUID`     | FK → Environment (unique per env per workspace) |
| `requiredApprovers`   | `Int`      | Minimum number of `approved` decisions needed   |
| `eligibleRoles`       | `String[]` | e.g., `["admin", "owner"]`                      |
| `requireChangeTicket` | `Boolean`  | Default: false (APR-13)                         |
| `ticketUrlPattern`    | `String?`  | URL template with `{id}` placeholder            |
| `expiryHours`         | `Int`      | Default: 24 (APR-09)                            |
| `createdAt`           | `DateTime` |                                                 |
| `updatedAt`           | `DateTime` |                                                 |

**Unique**: `(workspaceId, environmentId)`  
**RLS**: enabled, policy on `workspaceId`

---

### `DeploymentRequest`

A change waiting for approval (APR-04): the API call itself, run as the requester once approved.

| Column                              | Type       | Notes                                                                                                 |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `id`                                | `CUID`     | Primary key                                                                                           |
| `workspaceId`                       | `CUID`     | FK → Workspace (RLS key)                                                                              |
| `moduleId`, `environmentId`         | `CUID`     | The module and the environment the change targets                                                     |
| `type`                              | `String`   | `deploy`, `rollback`, `promote`, `canary_traffic`, `canary_promote`, `canary_abort`, `canary_advance` |
| `requestedBy`, `requestedByType`    |            | User or API key id; who the call runs as                                                              |
| `method`, `path`, `payload`         |            | The call                                                                                              |
| `status`                            | `String`   | `pending_approval`, `executing`, `executed`, `failed`, `rejected`, `expired`                          |
| `requiredApprovers`                 | `Int`      | Copied from the policy when requested                                                                 |
| `changeTicketId`, `changeTicketUrl` | `String?`  | APR-13/14                                                                                             |
| `expiresAt`                         | `DateTime` | From `ApprovalPolicy.expiryHours`                                                                     |
| `resolvedAt`, `resolvedBy`          |            | Final approver, rejecter or bypassing owner                                                           |
| `bypassed`, `bypassJustification`   |            | APR-10/12                                                                                             |
| `result`                            | `Json?`    | `{ statusCode, body }` of the executed call                                                           |
| `resultVersionId`                   | `String?`  | Version created by an executed deploy or promote (APR-18)                                             |
| `createdAt`                         | `DateTime` |                                                                                                       |

**Index**: `(workspaceId)`, `(status, expiresAt)`, `(resultVersionId)`  
**RLS**: enabled, policy on `workspaceId`

---

### `DeploymentApproval`

| Column                | Type       | Notes                                                       |
| --------------------- | ---------- | ----------------------------------------------------------- |
| `id`                  | `CUID`     | Primary key                                                 |
| `workspaceId`         | `CUID`     | FK → Workspace (RLS key — denormalised for RLS enforcement) |
| `deploymentRequestId` | `CUID`     | FK → DeploymentRequest                                      |
| `approverId`          | `CUID`     | FK → WorkspaceMember                                        |
| `decision`            | `String`   | `approved \| rejected`                                      |
| `comment`             | `String?`  | Optional reviewer note                                      |
| `decidedAt`           | `DateTime` |                                                             |

**Unique**: `(deploymentRequestId, approverId)` — one vote per approver per request  
**RLS**: enabled, policy on `workspaceId`

---

## New Tables (Phase 7 — Instance Admin UI & BYOB Storage)

### `InstanceConfig`

Key-value store for all runtime instance configuration. Used by the admin panel (§17) to store adapter credentials, SMTP settings, and OAuth secrets without requiring `.env` changes.

| Column      | Type       | Notes                                                                                                                    |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`        | `CUID`     | Primary key                                                                                                              |
| `key`       | `String`   | `setup.completed` (INST-04) and `settings.storage`, `settings.email`, `settings.auth`, `settings.branding` (INST-11..14) |
| `value`     | `Json`     | The validated setting; secret fields (storage keys, SMTP password, GitHub client secret) sealed with AES-256-GCM         |
| `updatedAt` | `DateTime` | Last write timestamp                                                                                                     |
| `updatedBy` | `CUID?`    | FK → User (the InstanceAdmin who last changed it)                                                                        |

**Unique**: `key`  
**Note**: NOT RLS-scoped. This table is instance-wide, not tenant-scoped. Only `InstanceAdmin` sessions may read/write. Settings rows override the environment; each registry reloads them every 60 seconds (INST-16/17).

---

### `InstanceAdmin`

Grants `InstanceAdmin` privileges to a `User`. Entirely separate from workspace roles.

| Column      | Type        | Notes                                                                                                                   |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`        | `CUID`      | Primary key                                                                                                             |
| `userId`    | `CUID`      | Unique FK → User                                                                                                        |
| `grantedBy` | `CUID?`     | FK → User (the admin who granted this role; null for first setup)                                                       |
| `role`      | `String`    | INST-31: `instance_owner` (default; existing grants) \| `instance_operator` \| `instance_support` \| `instance_billing` |
| `createdAt` | `DateTime`  |                                                                                                                         |
| `revokedAt` | `DateTime?` | Null = active; set to now() on revocation                                                                               |

**Unique**: `userId`  
**Note**: NOT RLS-scoped. Instance-wide table.

---

### `InstanceAdminInvitation`

INST-31: an email invited to administer the instance before it has an account. The next sign-in with that email that isn't through a tenant's SSO, before `expiresAt` (7 days), accepts it.

| Column                    | Type        | Notes                          |
| ------------------------- | ----------- | ------------------------------ |
| `id`                      | `CUID`      | Primary key                    |
| `email`                   | `String`    | Lower-cased                    |
| `role`                    | `String`    | The role granted on acceptance |
| `invitedBy`               | `CUID`      | The instance owner             |
| `expiresAt`               | `DateTime`  |                                |
| `acceptedAt`, `revokedAt` | `DateTime?` |                                |
| `createdAt`               | `DateTime`  |                                |

**Note**: NOT RLS-scoped.

---

### `InstanceApiKey`

INST-33: keys for automation on `/api/admin` only (`hq_inst_<id>_<secret>`).

| Column                                 | Type        | Notes                               |
| -------------------------------------- | ----------- | ----------------------------------- |
| `id`                                   | `CUID`      | Primary key; part of the key        |
| `name`                                 | `String`    |                                     |
| `keyHash`                              | `String`    | bcrypt of the secret                |
| `prefix`                               | `String`    | Shown in lists                      |
| `scopes`                               | `String[]`  | `instance:read` \| `instance:admin` |
| `expiresAt`, `lastUsedAt`, `revokedAt` | `DateTime?` |                                     |
| `createdBy`                            | `CUID`      | The instance owner                  |
| `createdAt`                            | `DateTime`  |                                     |

**Note**: NOT RLS-scoped.

---

### `InstanceConfigVersion`

INST-35: every saved version of an instance setting.

| Column      | Type       | Notes                                                            |
| ----------- | ---------- | ---------------------------------------------------------------- |
| `id`        | `CUID`     | Primary key                                                      |
| `key`       | `String`   | The setting                                                      |
| `version`   | `Int`      | 1, 2, … per key                                                  |
| `value`     | `Json`     | As stored in `InstanceConfig` (secrets sealed); `{}` for a reset |
| `source`    | `String`   | `save` \| `restore` \| `import` \| `reset`                       |
| `createdBy` | `CUID?`    |                                                                  |
| `createdAt` | `DateTime` |                                                                  |

**Unique**: `(key, version)`  
**Note**: NOT RLS-scoped.

---

### `WorkspaceStorageConfig`

Per-workspace BYOB storage adapter override (§18). When present, the registry routes all deploy I/O for that workspace to this adapter instead of the instance default.

| Column                 | Type        | Notes                                                                                                                     |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `CUID`      | Primary key                                                                                                               |
| `workspaceId`          | `CUID`      | Unique FK → Workspace                                                                                                     |
| `provider`             | `String`    | `S3 \| GCS \| AZURE` (BYOB-02)                                                                                            |
| `bucket`               | `String`    | Bucket or container name                                                                                                  |
| `region`               | `String`    | Cloud region (e.g., `us-east-1`, `eu-west-1`)                                                                             |
| `credentialsEncrypted` | `Json`      | AES-256-GCM: access keys or `roleArn` (+ `externalId`) for S3, `serviceAccountJson` for GCS, `connectionString` for Azure |
| `endpoint`             | `String?`   | S3-compatible endpoint (MinIO, R2 …)                                                                                      |
| `cdnPrefix`            | `String?`   | Optional CDN URL prefix (e.g., `https://cdn.acme.com/mfe`)                                                                |
| `pathPrefix`           | `String?`   | Optional path prefix within the bucket (e.g., `harmoniq/`)                                                                |
| `lastVerifiedAt`       | `DateTime?` | Timestamp of last successful canary write-read-delete cycle (BYOB-04)                                                     |
| `createdAt`            | `DateTime`  |                                                                                                                           |
| `updatedAt`            | `DateTime`  |                                                                                                                           |

**Unique**: `workspaceId` (one BYOB config per workspace)  
**RLS**: enabled, policy on `workspaceId`

> **Storage resolution at deploy-time:**  
> `WorkspaceStorageConfig` present → use workspace adapter  
> No `WorkspaceStorageConfig` → use `InstanceConfig["storage.adapter"]`  
> No `InstanceConfig` entry → use `STORAGE_ADAPTER` env var (bootstrap default)

---

## New Tables (Phase 9 — Tenant Administration)

### Column additions (migration `20261011150000_tenant_lifecycle`)

| Model          | Columns                                                   | Notes                                                                                      |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Workspace`    | `deletedAt?`, `deletedBy?`, `purgeAfter?` (index)         | TLC-02/03: deleted, restorable until `purgeAfter`, then purged by `tenant.purge`           |
| `Organization` | `purgeAfter?` (index), `suspendedAt?`, `suspendedReason?` | TLC-02/03/04: restore window after `deletedAt`; suspension makes every workspace read-only |

`OrganizationAuditEvent` and `ScimAuditEvent` no longer have foreign keys to `Organization` (AUD-05): a purged organization's trail stays.

### `Invitation`

PPL-01/02 (migration `20261011170000_invitations_access_requests`). Pending invitations grant nothing; accepting creates the membership. Replaces `WorkspaceMember` rows with `joinedAt = null` (migrated).

| Column                                                   | Type                    | Notes                                                     |
| -------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `id`                                                     | `CUID`                  | Primary key                                               |
| `workspaceId`                                            | `CUID?`                 | Exactly one of the two (CHECK); RLS like SCIM rows; no FK |
| `organizationId`                                         | `CUID?`                 |                                                           |
| `email`                                                  | `String`                | Lowercase; indexed                                        |
| `role`                                                   | `String`                | Workspace role or org role                                |
| `tokenHash`                                              | `String`                | Unique; sha256 of the emailed token                       |
| `invitedBy`                                              | `String`                | `user:<id>`, `apiKey:<id>` or `system:<what>`             |
| `expiresAt`                                              | `DateTime`              | 7 days; renewed by resend                                 |
| `acceptedAt` / `acceptedBy` / `revokedAt` / `lastSentAt` | `DateTime?` / `String?` |                                                           |
| `createdAt`                                              | `DateTime`              |                                                           |

### `AccessRequest`

PPL-07. An org member asks to join a workspace: `workspaceId`, `userId`, `role` (default `viewer`), `message?`, `status` (`pending`, `approved`, `denied`), `decidedBy?`, `decidedAt?`, `createdAt`. RLS by `workspaceId` (also the organization's workspaces).

### `OwnershipTransfer`

TLC-06 (migration `20261011160000_ownership_transfers`). A pending handover of a workspace's ownership or an organization's admin seat.

| Column           | Type        | Notes                                                            |
| ---------------- | ----------- | ---------------------------------------------------------------- |
| `id`             | `CUID`      | Primary key                                                      |
| `workspaceId`    | `CUID?`     | Exactly one of the two is set (CHECK); RLS like SCIM rows; no FK |
| `organizationId` | `CUID?`     |                                                                  |
| `fromUserId`     | `CUID`      | Steps down when the transfer is accepted                         |
| `toUserId`       | `CUID`      | The recipient; indexed                                           |
| `expiresAt`      | `DateTime`  | 7 days after proposal                                            |
| `acceptedAt`     | `DateTime?` |                                                                  |
| `cancelledAt`    | `DateTime?` | Withdrawn, declined, or replaced by a newer proposal             |
| `createdAt`      | `DateTime`  |                                                                  |

### `VerifiedDomain`

DOM-01..05 (migration `20261011120000_verified_domains`). A domain claimed by an organization or a workspace, proven with the DNS TXT record `_harmoniq-challenge.<domain>` = `harmoniq-verification=<token>`. Many tenants may claim a domain; only one can verify it.

| Column           | Type        | Notes                                                                                          |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `id`             | `CUID`      | Primary key                                                                                    |
| `domain`         | `String`    | Lowercase; indexed. Unique per owner (`[domain, organizationId]`, `[domain, workspaceId]`)     |
| `organizationId` | `CUID?`     | FK → Organization (cascade). Exactly one of the two is set (CHECK)                             |
| `workspaceId`    | `CUID?`     | FK → Workspace (cascade); RLS key (organization claims are invisible to the tenant role)       |
| `token`          | `String`    | The TXT value's token (not a secret: DNS is public)                                            |
| `verifiedAt`     | `DateTime?` | Set by a successful check                                                                      |
| `verifiedDomain` | `String?`   | **Unique.** Equals `domain` while verified (CHECK), so a domain has at most one verified owner |
| `lastCheckedAt`  | `DateTime?` | DOM-05 re-checks                                                                               |
| `failingSince`   | `DateTime?` | Record missing since; unverified after 14 days                                                 |
| `createdBy`      | `String`    | User or key that claimed it                                                                    |
| `createdAt`      | `DateTime`  |                                                                                                |

`InstanceConfig` key `domains.graceUntil` holds the end of the DOM-04 transition period, fixed at the first start with domain verification.

---

## Planned Changes (Phase 9 — Tenant Administration)

> Not yet in `schema.prisma`. Designed in [features/tenant-administration.md](./features/tenant-administration.md) and tracked in [implementation-plan.md Phase 9](./implementation-plan.md). Move each entry into the sections above when its migration lands.

| Change                                                                                     | Sub-phase | Requirements              |
| ------------------------------------------------------------------------------------------ | --------- | ------------------------- |
| `OrgApiKey.gracePeriodEnd`                                                                 | 9.4       | TAD-05                    |
| `OrgPolicy`                                                                                | 9.5       | POL-01–POL-08             |
| `UsageDaily`, `ModuleVersion.sizeBytes`, plan `overrides` / `planExpiresAt` / `basePlan`   | 9.6       | USG-01, PLN-04–06         |
| `User.suspendedAt/suspendedReason/mfa*`; `RefreshToken.lastUsedAt/userAgent/ip`            | 9.7       | SES-01–SES-04             |
| `AuditSink`, audit `prevHash`/`hash`, org webhooks, `NotificationChannel`                  | 9.8       | AUD-06, AUD-09, TAD-09/10 |
| `SupportGrant`                                                                             | 9.10      | INST-20                   |
| Sealed JSON envelopes gain `kid` (key id); no schema change                                | 9.9       | INST-26                   |
| `InstanceAdmin.role`, `InstanceAdminInvitation`, `InstanceApiKey`, `InstanceConfigVersion` | 9.9       | INST-31, INST-33, INST-35 |
| `ReplicaHeartbeat`, `SignInEvent`, `EmailDelivery`                                         | 9.10      | INST-28, INST-38, INST-39 |
