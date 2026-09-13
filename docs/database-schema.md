# Harmoniq — Database Schema Reference

> **Version**: 1.0.0  
> **Last Updated**: 2026-09-13  
> **ORM**: Prisma  
> **Database**: PostgreSQL 15+

---

## Entity Relationship Overview

```
User ─────────────────── WorkspaceMember ─────────── Workspace
                                                          │
                    ┌─────────────────────────────────────┼──────────────────────────────┐
                    │                    │                 │                │              │
               HostApp            ApiKey         WebhookEndpoint      AuditEvent   WorkspaceConfig
                    │                                 │
              Environment               WebhookDelivery
                    │
             RemoteModule
                    │
             ModuleVersion
```

---

## Models

### `User`

| Column      | Type       | Notes                   |
| ----------- | ---------- | ----------------------- |
| `id`        | `CUID`     | Primary key             |
| `email`     | `String`   | Unique                  |
| `name`      | `String?`  | Display name from OAuth |
| `avatarUrl` | `String?`  |                         |
| `createdAt` | `DateTime` |                         |
| `updatedAt` | `DateTime` |                         |

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

| Column        | Type        | Notes                                   |
| ------------- | ----------- | --------------------------------------- |
| `id`          | `CUID`      | Primary key                             |
| `workspaceId` | `CUID`      | FK → Workspace (RLS key)                |
| `userId`      | `CUID`      | FK → User                               |
| `role`        | `Enum`      | `owner \| admin \| developer \| viewer` |
| `invitedAt`   | `DateTime`  |                                         |
| `joinedAt`    | `DateTime?` | Null until accepted                     |

**Unique constraint**: `(workspaceId, userId)`

### `HostApp`

| Column        | Type       | Notes                             |
| ------------- | ---------- | --------------------------------- |
| `id`          | `CUID`     | Primary key                       |
| `workspaceId` | `CUID`     | FK → Workspace (RLS key)          |
| `name`        | `String`   | Display name                      |
| `slug`        | `String`   | URL-safe, unique within workspace |
| `description` | `String?`  |                                   |
| `createdAt`   | `DateTime` |                                   |

**Unique constraint**: `(workspaceId, slug)`  
**RLS**: enabled, policy on `workspaceId`

### `Environment`

| Column      | Type      | Notes                        |
| ----------- | --------- | ---------------------------- |
| `id`        | `CUID`    | Primary key                  |
| `hostAppId` | `CUID`    | FK → HostApp                 |
| `name`      | `String`  | e.g. `production`, `staging` |
| `slug`      | `String`  | URL-safe                     |
| `isDefault` | `Boolean` | Default: false               |

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
| `createdAt`   | `DateTime` |                          |

**Unique constraint**: `(hostAppId, slug)`  
**RLS**: enabled, policy on `workspaceId`

### `ModuleVersion`

| Column           | Type        | Notes                                      |
| ---------------- | ----------- | ------------------------------------------ |
| `id`             | `CUID`      | Primary key                                |
| `workspaceId`    | `CUID`      | FK → Workspace (RLS key)                   |
| `remoteModuleId` | `CUID`      | FK → RemoteModule                          |
| `environmentId`  | `CUID`      | FK → Environment                           |
| `version`        | `String`    | SemVer or arbitrary tag                    |
| `url`            | `String`    | Public CDN URL of the bundle               |
| `integrity`      | `String`    | SHA-256 hash of the bundle                 |
| `storagePath`    | `String?`   | Path in IStorage (null if external CDN)    |
| `status`         | `Enum`      | `active \| inactive \| canary \| orphaned` |
| `trafficPercent` | `Int?`      | 1–99; set when status = canary             |
| `deployedBy`     | `String`    | User ID or API key ID                      |
| `deployedByType` | `Enum`      | `user \| apiKey`                           |
| `commitSha`      | `String?`   | Optional git commit reference              |
| `metadata`       | `Json?`     | Arbitrary key-value pairs                  |
| `deployedAt`     | `DateTime`  |                                            |
| `deletedAt`      | `DateTime?` | Soft-delete timestamp; set by GC           |

**Indexes**: `(workspaceId, remoteModuleId, environmentId, status)`, `(deletedAt)`  
**RLS**: enabled, policy on `workspaceId`

**Business rule**: only one version per `(remoteModuleId, environmentId)` may have `status = active` at a time. Enforced by transaction in application layer.

### `ApiKey`

| Column           | Type        | Notes                                    |
| ---------------- | ----------- | ---------------------------------------- |
| `id`             | `CUID`      | Primary key                              |
| `workspaceId`    | `CUID`      | FK → Workspace (RLS key)                 |
| `name`           | `String`    | Human-readable label                     |
| `keyHash`        | `String`    | argon2id hash of raw key                 |
| `prefix`         | `String`    | First 8 chars of raw key (for display)   |
| `scopes`         | `String[]`  | `deploy:write`, `manifest:read`, `admin` |
| `expiresAt`      | `DateTime?` | Null = never expires                     |
| `gracePeriodEnd` | `DateTime?` | Set during key rotation                  |
| `lastUsedAt`     | `DateTime?` |                                          |
| `revokedAt`      | `DateTime?` | Null = active                            |
| `createdAt`      | `DateTime`  |                                          |
| `createdBy`      | `CUID`      | FK → User                                |

**RLS**: enabled, policy on `workspaceId`

### `RefreshToken`

| Column      | Type        | Notes                                   |
| ----------- | ----------- | --------------------------------------- |
| `id`        | `CUID`      | Primary key                             |
| `userId`    | `CUID`      | FK → User                               |
| `tokenHash` | `String`    | bcrypt hash of opaque token             |
| `expiresAt` | `DateTime`  | Default: 30 days                        |
| `usedAt`    | `DateTime?` | Set on rotation (invalidates after use) |
| `revokedAt` | `DateTime?` | Set on logout                           |
| `createdAt` | `DateTime`  |                                         |

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

| Column         | Type       | Notes                                |
| -------------- | ---------- | ------------------------------------ |
| `id`           | `CUID`     | Primary key                          |
| `workspaceId`  | `CUID`     | FK → Workspace (RLS key)             |
| `actorId`      | `String`   | User ID or ApiKey ID                 |
| `actorType`    | `Enum`     | `user \| apiKey`                     |
| `action`       | `String`   | e.g. `module.deploy`, `key.revoke`   |
| `resourceType` | `String`   | e.g. `ModuleVersion`, `ApiKey`       |
| `resourceId`   | `String`   | ID of the affected resource          |
| `metadata`     | `Json?`    | Contextual data (version, env, etc.) |
| `ip`           | `String?`  | Requester IP                         |
| `createdAt`    | `DateTime` | Immutable                            |

**RLS**: enabled, policy on `workspaceId`  
**No soft-delete**: this table is append-only and has no `deletedAt` column.  
**Index**: `(workspaceId, createdAt DESC)`, `(workspaceId, actorId)`, `(workspaceId, action)`

### `WorkspaceConfig`

| Column            | Type       | Notes                                     |
| ----------------- | ---------- | ----------------------------------------- |
| `id`              | `CUID`     | Primary key                               |
| `workspaceId`     | `CUID`     | Unique FK → Workspace (one per workspace) |
| `oauthProvider`   | `String`   | `github \| google`                        |
| `oauthConfig`     | `Json`     | Encrypted provider-specific config        |
| `storageProvider` | `String`   | `local \| s3 \| gcs`                      |
| `storageConfig`   | `Json`     | Encrypted provider-specific config        |
| `logProvider`     | `String`   | `console \| otel`                         |
| `logConfig`       | `Json`     | Provider-specific config                  |
| `updatedAt`       | `DateTime` |                                           |

---

## Row-Level Security Policies

The following RLS is applied to all tables marked with **RLS: enabled**.

```sql
-- Enable RLS
ALTER TABLE "ModuleVersion" ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY workspace_isolation ON "ModuleVersion"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT
  );

-- App role cannot bypass RLS
ALTER ROLE harmoniq_app NOINHERIT;
```

The Prisma client middleware sets the session variable at the start of every request:

```typescript
prisma.$use(async (params, next) => {
  await prisma.$executeRaw`SET LOCAL app.current_workspace_id = ${workspaceId}`;
  return next(params);
});
```

---

## Migration Strategy

- Migrations are managed by Prisma (`prisma migrate dev` / `prisma migrate deploy`).
- Post-migration SQL hooks (RLS policies, roles) are applied via a custom `db:migrate` script that runs `prisma migrate deploy` followed by `psql` with the RLS SQL file.
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

| Column           | Type       | Notes                                                                         |
| ---------------- | ---------- | ----------------------------------------------------------------------------- |
| `oauthProvider`  | `String`   | Now supports: `github \| google \| oidc \| saml`                              |
| `oidcConfig`     | `Json?`    | Encrypted: issuer, clientId, clientSecret, scopes, roleMapping (SSO-03)       |
| `samlConfig`     | `Json?`    | Encrypted: entityId, ssoUrl, sloUrl, idpCert, spKeyPair, attrMapping (SSO-15) |
| `forceSso`       | `Boolean`  | Default: false (SSO-26)                                                       |
| `trustedDomains` | `String[]` | e.g. `["acme.com"]` (SSO-22)                                                  |
| `defaultSsoRole` | `String`   | Default: `"viewer"` — role assigned on domain-based auto-join                 |
| `scimEnabled`    | `Boolean`  | Default: false (SSO-24)                                                       |
| `scimTokenHash`  | `String?`  | argon2id hash of the SCIM bearer token                                        |
| `plan`           | `String`   | `hobby \| startup \| enterprise` — default: `hobby` (PLN-01)                  |

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

| Column           | Type       | Notes                                                |
| ---------------- | ---------- | ---------------------------------------------------- |
| `id`             | `CUID`     | Primary key                                          |
| `workspaceId`    | `CUID`     | FK → Workspace (RLS key)                             |
| `remoteModuleId` | `CUID?`    | Null = all modules                                   |
| `environmentId`  | `CUID?`    | Null = all environments                              |
| `condition`      | `String`   | e.g. `"canary_error_rate"`                           |
| `threshold`      | `Float`    | Trigger value                                        |
| `action`         | `String`   | `"webhook" \| "auto_rollback"`                       |
| `actionConfig`   | `Json`     | `{ "url": "..." }` or `{ "targetVersionId": "..." }` |
| `enabled`        | `Boolean`  | Default: true                                        |
| `createdAt`      | `DateTime` |                                                      |

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

| Column           | Type       | Notes                                  |
| ---------------- | ---------- | -------------------------------------- |
| `id`             | `CUID`     | Primary key                            |
| `workspaceId`    | `CUID`     | FK → Workspace (RLS key)               |
| `remoteModuleId` | `CUID`     | FK → RemoteModule                      |
| `environmentId`  | `CUID`     | FK → Environment                       |
| `variant`        | `String`   | `"stable" \| "canary"`                 |
| `success`        | `Boolean`  | Whether the module loaded successfully |
| `loadMs`         | `Int?`     | Load time in milliseconds              |
| `errorMessage`   | `String?`  | Truncated error message on failure     |
| `clientVersion`  | `String?`  | `@harmoniq/client` version             |
| `reportedAt`     | `DateTime` | Default: now()                         |

**Index**: `(workspaceId, remoteModuleId, environmentId, reportedAt)`  
**RLS**: enabled, policy on `workspaceId`  
**Note**: Records older than 24h are eligible for purge (high-volume table — not subject to `retentionDays`).

---

### `ScimAuditEvent`

| Column        | Type       | Notes                                                  |
| ------------- | ---------- | ------------------------------------------------------ |
| `id`          | `CUID`     | Primary key                                            |
| `workspaceId` | `CUID`     | FK → Workspace (RLS key)                               |
| `operation`   | `String`   | `"user.create" \| "user.update" \| "user.deprovision"` |
| `scimUserId`  | `String`   | External SCIM user ID                                  |
| `payload`     | `Json`     | SCIM request/response payload                          |
| `statusCode`  | `Int`      | HTTP status code returned                              |
| `createdAt`   | `DateTime` | Immutable                                              |

**Index**: `(workspaceId, createdAt DESC)`  
**RLS**: enabled, policy on `workspaceId`

---

## New Tables (Phase 8 — Enterprise Governance)

### Column Additions to Existing Models

#### `Workspace` — New Columns

| Column           | Type      | Notes                                                   |
| ---------------- | --------- | ------------------------------------------------------- |
| `organizationId` | `String?` | FK → Organization. Null = standalone workspace (ORG-03) |

---

### `Organization`

| Column       | Type        | Notes                                                     |
| ------------ | ----------- | --------------------------------------------------------- |
| `id`         | `CUID`      | Primary key                                               |
| `slug`       | `String`    | Unique, URL-safe (e.g., `acme-corp`)                      |
| `name`       | `String`    | Display name                                              |
| `plan`       | `String`    | `hobby \| startup \| enterprise`                          |
| `oidcConfig` | `Json?`     | Encrypted — org-level OIDC config (ORG-05)                |
| `samlConfig` | `Json?`     | Encrypted — org-level SAML 2.0 config (ORG-05)            |
| `scimConfig` | `Json?`     | Encrypted — org-level SCIM token hash + settings (ORG-07) |
| `createdAt`  | `DateTime`  |                                                           |
| `deletedAt`  | `DateTime?` | Soft-delete                                               |

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

### `OrgApiKey`

| Column           | Type        | Notes                         |
| ---------------- | ----------- | ----------------------------- |
| `id`             | `CUID`      | Primary key                   |
| `organizationId` | `CUID`      | FK → Organization             |
| `keyHash`        | `String`    | argon2id hash of the raw key  |
| `name`           | `String`    | Human-readable label          |
| `workspaceScope` | `String[]`  | Empty = all workspaces in org |
| `moduleScope`    | `String[]`  | Empty = all modules           |
| `createdAt`      | `DateTime`  |                               |
| `revokedAt`      | `DateTime?` | Null = active                 |

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

| Column                | Type        | Notes                                                                         |
| --------------------- | ----------- | ----------------------------------------------------------------------------- |
| `id`                  | `CUID`      | Primary key                                                                   |
| `workspaceId`         | `CUID`      | FK → Workspace (RLS key)                                                      |
| `moduleId`            | `CUID`      | FK → RemoteModule                                                             |
| `environmentId`       | `CUID`      | FK → Environment                                                              |
| `type`                | `String`    | `deploy \| rollback \| promote \| canary`                                     |
| `requestedBy`         | `CUID`      | FK → WorkspaceMember                                                          |
| `payload`             | `Json`      | Original operation parameters (serialised)                                    |
| `status`              | `String`    | `pending_approval \| approved \| rejected \| executed \| expired \| bypassed` |
| `changeTicketId`      | `String?`   | e.g., `PROJ-1234` (APR-13)                                                    |
| `changeTicketUrl`     | `String?`   | Resolved URL from pattern                                                     |
| `expiresAt`           | `DateTime`  | Computed from `ApprovalPolicy.expiryHours` at creation                        |
| `resolvedAt`          | `DateTime?` | When status transitioned out of `pending_approval`                            |
| `resolvedBy`          | `CUID?`     | FK → WorkspaceMember (bypasser or final approver)                             |
| `bypassJustification` | `String?`   | Required on emergency bypass (APR-10)                                         |
| `createdAt`           | `DateTime`  |                                                                               |

**Index**: `(workspaceId, status, expiresAt)`  
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

| Column      | Type       | Notes                                                                           |
| ----------- | ---------- | ------------------------------------------------------------------------------- |
| `id`        | `CUID`     | Primary key                                                                     |
| `key`       | `String`   | Unique identifier (e.g., `storage.adapter`, `smtp.host`, `auth.github.enabled`) |
| `value`     | `Json`     | Encrypted at rest. Plaintext type varies by key.                                |
| `updatedAt` | `DateTime` | Last write timestamp                                                            |
| `updatedBy` | `CUID?`    | FK → User (the InstanceAdmin who last changed it)                               |

**Unique**: `key`  
**Note**: NOT RLS-scoped. This table is instance-wide, not tenant-scoped. Only `InstanceAdmin` sessions may read/write.

---

### `InstanceAdmin`

Grants `InstanceAdmin` privileges to a `User`. Entirely separate from workspace roles.

| Column      | Type        | Notes                                                             |
| ----------- | ----------- | ----------------------------------------------------------------- |
| `id`        | `CUID`      | Primary key                                                       |
| `userId`    | `CUID`      | Unique FK → User                                                  |
| `grantedBy` | `CUID?`     | FK → User (the admin who granted this role; null for first setup) |
| `createdAt` | `DateTime`  |                                                                   |
| `revokedAt` | `DateTime?` | Null = active; set to now() on revocation                         |

**Unique**: `userId`  
**Note**: NOT RLS-scoped. Instance-wide table.

---

### `WorkspaceStorageConfig`

Per-workspace BYOB storage adapter override (§18). When present, the registry routes all deploy I/O for that workspace to this adapter instead of the instance default.

| Column                 | Type        | Notes                                                                                       |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `id`                   | `CUID`      | Primary key                                                                                 |
| `workspaceId`          | `CUID`      | Unique FK → Workspace                                                                       |
| `provider`             | `String`    | `s3 \| gcs \| azure-blob` (BYOB-02)                                                         |
| `bucket`               | `String`    | Bucket or container name                                                                    |
| `region`               | `String`    | Cloud region (e.g., `us-east-1`, `eu-west-1`)                                               |
| `credentialsEncrypted` | `Json`      | Encrypted at rest: IAM role ARN (S3), service account JSON (GCS), connection string (Azure) |
| `cdnPrefix`            | `String?`   | Optional CDN URL prefix (e.g., `https://cdn.acme.com/mfe`)                                  |
| `pathPrefix`           | `String?`   | Optional path prefix within the bucket (e.g., `harmoniq/`)                                  |
| `lastVerifiedAt`       | `DateTime?` | Timestamp of last successful canary write-read-delete cycle (BYOB-04)                       |
| `createdAt`            | `DateTime`  |                                                                                             |
| `updatedAt`            | `DateTime`  |                                                                                             |

**Unique**: `workspaceId` (one BYOB config per workspace)  
**RLS**: enabled, policy on `workspaceId`

> **Storage resolution at deploy-time:**  
> `WorkspaceStorageConfig` present → use workspace adapter  
> No `WorkspaceStorageConfig` → use `InstanceConfig["storage.adapter"]`  
> No `InstanceConfig` entry → use `STORAGE_ADAPTER` env var (bootstrap default)
