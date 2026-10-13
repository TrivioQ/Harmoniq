# Harmoniq — Product Requirements Document

> **Version**: 1.0.0  
> **License**: Apache 2.0  
> **Last Updated**: 2026-10-11  
> **Status**: Draft

---

## 1. Executive Summary

Harmoniq is an open-source, self-hostable **Micro Frontend Control Plane** that eliminates build-time deployment bottlenecks in distributed frontend architectures. It acts as a centralized registry that delivers dynamic, runtime JSON manifests to host application shells, enabling engineering teams to independently deploy, roll back, and canary-test federated modules without rebuilding or redeploying parent containers.

---

## 2. Problem Statement

Modern micro frontend architectures (Webpack Module Federation, Native Federation, etc.) hardcode remote module URLs at **build time**. This creates tight coupling between the host shell and every remote team's release cycle:

- Deploying a new version of a remote requires rebuilding and redeploying the host.
- Rolling back a bad remote release requires another full host deployment.
- There is no native mechanism for canary releases or A/B testing of remote modules.
- No centralized visibility into which version of which module is running in which environment.

---

## 3. Goals & Non-Goals

### 3.1 Goals

- Serve runtime JSON manifests so host shells load remote modules without a rebuild.
- Provide a multi-tenant developer dashboard for managing modules, environments, and versions.
- Support instant rollback to any previously deployed bundle version.
- Enable canary releases with configurable, server-side traffic-splitting strategies.
- Remain completely vendor-agnostic via a ports-and-adapters (hexagonal) architecture.
- Be trivially self-hostable via Docker Compose with a single `pnpm run docker:up`.
- Ship an official `@harmoniq/client` SDK and `@harmoniq/cli` for CI/CD integration.

### 3.2 Non-Goals (v1)

- Harmoniq does **not** build or bundle micro frontend assets — it only manages manifests pointing to externally hosted bundles.
- Harmoniq does **not** provide its own CDN — it integrates with existing storage/CDN providers.
- Full OIDC + SAML 2.0 enterprise SSO ships in **v1** (see §5.21). Supported IdPs: Okta, Azure AD (Entra), Google Workspace, ADFS, Ping Identity, Auth0, Keycloak, AWS Cognito.
- WS-Federation (non-SAML ADFS) is a **v2** target.
- A Kubernetes Helm Chart is a **v2** community target.

---

## 4. System Architecture

### 4.1 High-Level Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Host Application Shell                     │
│   @harmoniq/client SDK ──► manifest fetch ──► module load    │
└───────────────────────────┬──────────────────────────────────┘
                            │ GET /api/manifest/:workspaceSlug/:env
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  Harmoniq Registry Core                       │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│   │ ICache   │  │ IStorage │  │ ILogger  │  │ AuthPlugin│  │
│   │ (Redis / │  │ (S3/GCS/ │  │ (OTel /  │  │ (GitHub / │  │
│   │  Memory) │  │  Local)  │  │  Console)│  │  Google)  │  │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│        └─────────────┴─────────────┴───────────────┘        │
│                              │                               │
│                   ┌──────────▼──────────┐                    │
│                   │   PostgreSQL + RLS   │                    │
│                   │   (Prisma ORM)       │                    │
│                   │   + pg-boss (GC)     │                    │
│                   └─────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
                            │
                ┌───────────▼────────────┐
                │  Next.js Dashboard     │
                │  (Shadcn + Tailwind)   │
                └────────────────────────┘
```

### 4.2 Monorepo Structure

```
harmoniq/
├── apps/
│   ├── web/                  # Next.js dashboard (control plane UI)
│   └── registry/             # Node.js manifest registry API server
├── packages/
│   ├── client/               # @harmoniq/client — host shell SDK
│   ├── cli/                  # @harmoniq/cli — CI/CD command-line tool
│   ├── db/                   # @harmoniq/db — Prisma schema, migrations, seed
│   ├── core/                 # @harmoniq/core — shared ports, DTOs, business logic
│   └── tsconfig/             # Shared TypeScript configurations
├── docs/                     # All project documentation
├── docker/                   # Dockerfiles and docker-compose files
├── .agents/                  # Agent rules and skills (Harmoniq AGENTS.md)
├── pnpm-workspace.yaml
├── package.json
└── turbo.json
```

---

## 5. Functional Requirements

### 5.1 Manifest System (Core)

| ID     | Requirement                                                                                                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAN-01 | The registry MUST serve a manifest JSON payload at the canonical endpoint `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env` within **50ms p99** (cache hit). The legacy endpoint `GET /api/manifest/:workspaceSlug/:env` MUST remain functional, resolving to the `isDefault = true` HostApp. See §5.11 for HostApp scoping details. |
| MAN-02 | The manifest schema MUST include a `schemaVersion` integer field. Current version: **2** (adds `hostApp`, `variant`, `cohortId`).                                                                                                                                                                                                       |
| MAN-03 | The manifest MUST list all active remote modules for the given environment, each containing: `name`, `url`, `integrity` (SHA-256), `version`, `dependencies` (optional semver map), `exposes` (optional MF exposes map), and `metadata`.                                                                                                |
| MAN-04 | The registry MUST respond with HTTP `304 Not Modified` when the client sends an `If-None-Match` header matching the current manifest ETag.                                                                                                                                                                                              |
| MAN-05 | The manifest endpoint is publicly readable (no auth). API key auth is required for all write operations only.                                                                                                                                                                                                                           |
| MAN-06 | On database read failure, the registry MUST serve the last-known-good manifest from cache rather than a 5xx error.                                                                                                                                                                                                                      |

**Manifest JSON Schema (v2):**

```json
{
  "schemaVersion": 2,
  "workspaceSlug": "acme-corp",
  "hostApp": { "slug": "consumer-portal", "name": "Consumer Portal" },
  "environment": "production",
  "variant": "stable",
  "cohortId": "a7f3c2b1",
  "generatedAt": "2026-09-13T00:00:00Z",
  "etag": "sha256-abc123",
  "modules": [
    {
      "name": "checkout",
      "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
      "integrity": "sha256-xyz789",
      "version": "1.2.3",
      "dependencies": {
        "react": "^18.0.0",
        "@acme/design-system": "^4.2.0"
      },
      "exposes": {
        "./CheckoutApp": "./src/CheckoutApp"
      },
      "metadata": {
        "deployedAt": "2026-09-12T22:00:00Z",
        "commitSha": "a1b2c3d4"
      }
    }
  ]
}
```

> **`variant`**: `"stable"` or `"canary"` — which manifest cohort this response represents.  
> **`cohortId`**: stable opaque identifier for the user's canary assignment (safe to log; not the raw user ID).  
> **`dependencies`**: optional semver map for shared dependency validation (see §5.12).  
> **`exposes`**: optional Module Federation exposes map for validation tooling (see §5.13).

### 5.2 Cache Invalidation Strategy

- Default production cache: **Redis** (via `ICache` → `RedisCache` adapter).
- Development/single-node fallback: **in-memory LRU** (via `InMemoryLRUCache` adapter).
- On any manifest mutation (deploy, rollback, canary change), the cache key `manifest:{workspaceSlug}:{env}` MUST be invalidated synchronously before returning 200.
- Canary manifests use a separate cache key: `manifest:{workspaceSlug}:{env}:canary`.
- All manifest responses carry `ETag` and `Cache-Control: no-cache` headers to support client-side validation.

### 5.3 Versioning & Deployment

| ID     | Requirement                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VER-01 | All bundle deployments MUST be append-only. Existing version records are immutable.                                                                                                                   |
| VER-02 | Each module version MUST store: `version`, `url`, `integrity`, `storagePath`, `deployedBy` (user or API key ID), `deployedAt`, `commitSha` (optional), `status` (`active` \| `inactive` \| `canary`). |
| VER-03 | Activating a version MUST atomically deactivate all other non-canary versions for that module+environment within a single DB transaction.                                                             |
| VER-04 | Rollback MUST be a single API call: `POST /api/modules/:moduleId/rollback` with a `versionId` body, executed as a DB transaction.                                                                     |
| VER-05 | The dashboard MUST display the full deployment history per module per environment.                                                                                                                    |

### 5.4 Canary Releases

| ID     | Requirement                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CAN-01 | A module version MAY be set to `canary` status with a `trafficPercent` (1–99).                                                                                                                         |
| CAN-02 | The registry MUST implement **server-side sticky canary assignment**: deterministic hash of `X-Harmoniq-User-Id` request header, falling back to a `harmoniq_canary` cookie (random UUID, 30-day TTL). |
| CAN-03 | The canary manifest variant is served from a separate cache key.                                                                                                                                       |
| CAN-04 | Canary versions MUST be promotable to `active` or rolled back to `inactive` via dashboard or CLI.                                                                                                      |
| CAN-05 | Canary traffic percentage MUST be adjustable without redeployment.                                                                                                                                     |
| CAN-06 | Every manifest response MUST include a `variant` field: `"stable"` or `"canary"`.                                                                                                                      |
| CAN-07 | Every manifest response MUST include a `cohortId` field: a stable, opaque identifier derived from the hash — NOT the raw user ID.                                                                      |
| CAN-08 | The registry MUST set response headers: `X-Harmoniq-Variant: stable\|canary` and `X-Harmoniq-Cohort-Id: <cohortId>`.                                                                                   |
| CAN-09 | The `@harmoniq/client` SDK MUST expose `manifest.variant` and `manifest.cohortId` on the resolved manifest object.                                                                                     |
| CAN-10 | The SDK MUST emit a `variantAssigned` event on first cohort assignment, enabling host apps to forward it to analytics pipelines.                                                                       |

### 5.5 Multi-Tenancy

| ID    | Requirement                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| MT-01 | All data MUST be isolated at the row level using a `workspaceId` foreign key on every tenant-scoped table.                           |
| MT-02 | PostgreSQL Row-Level Security (RLS) policies MUST be enabled on all tenant-scoped tables as a defense-in-depth layer.                |
| MT-03 | A workspace admin MUST be able to invite members and assign roles: `owner`, `admin`, `developer`, `viewer`.                          |
| MT-04 | A workspace admin MUST be able to create and revoke API keys scoped to their workspace.                                              |
| MT-05 | Cross-workspace data access MUST be impossible at both the application query layer (Prisma middleware) and the database layer (RLS). |
| MT-06 | Each workspace MUST be independently configurable for OAuth provider, storage adapter, and logger adapter.                           |

### 5.6 API Key Management

| ID     | Requirement                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KEY-01 | API keys MUST be prefixed with `hq_`, consist of 32 cryptographically random bytes, and stored as an `argon2id` hash. The raw key is displayed **once** at creation. |
| KEY-02 | Keys MUST support scopes: `deploy:write`, `manifest:read`, `admin`.                                                                                                  |
| KEY-03 | Keys MUST support optional expiry timestamps.                                                                                                                        |
| KEY-04 | Every API key usage MUST be recorded in the `AuditEvent` log.                                                                                                        |
| KEY-05 | Key rotation: a new key can be generated while the old one remains valid for a configurable grace period (default: 24h).                                             |

### 5.7 Audit Log

| ID     | Requirement                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUD-01 | An `AuditEvent` MUST be created for every state-mutating action: deploy, rollback, canary change, key create/revoke, member invite/remove, settings change.                |
| AUD-02 | Audit events MUST include: `id`, `workspaceId`, `actorId`, `actorType` (`user` \| `apiKey`), `action`, `resourceType`, `resourceId`, `metadata` (JSON), `ip`, `createdAt`. |
| AUD-03 | Audit logs MUST be queryable in the dashboard with filters for actor, action type, and date range.                                                                         |
| AUD-04 | Audit logs are append-only and MUST NOT be deletable by any role including `owner`.                                                                                        |

### 5.8 Garbage Collection & Data Lifecycle

| ID    | Requirement                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| GC-01 | Background GC jobs MUST be implemented using `pg-boss` (PostgreSQL-native job queue). No Redis dependency for job scheduling. |
| GC-02 | Each workspace MUST have a configurable `retentionDays` policy (default: 90).                                                 |
| GC-03 | First-pass GC (daily): soft-delete `inactive` versions older than `retentionDays` by setting `deletedAt`.                     |
| GC-04 | Second-pass GC (weekly): hard-delete soft-deleted DB records and purge their physical files from `IStorage`.                  |
| GC-05 | Orphan detection: flag storage objects with no DB record and DB records whose `storagePath` is absent in storage.             |
| GC-06 | GC MUST never process a version with status `active` or `canary`, regardless of age.                                          |
| GC-07 | All GC operations MUST be idempotent — safe to re-run after failure.                                                          |

### 5.9 Webhook Events

| ID     | Requirement                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| WHK-01 | Workspaces MAY configure HTTP webhook endpoints to receive event notifications.                                                                       |
| WHK-02 | Triggering events: `manifest.updated`, `deploy.success`, `deploy.failed`, `rollback.executed`, `canary.promoted`, `canary.rolled_back`.               |
| WHK-03 | Delivery MUST retry with exponential backoff. Retry count is configurable per endpoint (default: 5, max: 25).                                         |
| WHK-04 | Each delivery attempt MUST be logged (URL, event, status code, duration, attempt).                                                                    |
| WHK-05 | Payloads MUST be signed with `HMAC-SHA256` using a workspace-scoped secret, sent in the `X-Harmoniq-Signature` header.                                |
| WHK-06 | `WebhookEndpoint` MUST support a configurable `backoffCeilingMs` field (default: 300,000ms / 5 min).                                                  |
| WHK-07 | Failed deliveries that exhaust all retries MUST be written to a `WebhookDeadLetter` record with the final error, response body, and all attempt logs. |
| WHK-08 | The dashboard MUST display a **Dead Letter Queue** view per webhook endpoint with a "Retry Now" button for each failed delivery.                      |
| WHK-09 | `POST /api/webhooks/deliveries/:deliveryId/retry` MUST re-enqueue a dead-lettered delivery immediately, bypassing the backoff schedule.               |
| WHK-10 | Webhook endpoints MUST support a `paused` state: events are enqueued but delivery is suspended until the endpoint is un-paused.                       |
| WHK-11 | Webhook endpoints MUST also support triggering events for: `module.promoted`, `env.frozen`, `env.unfrozen`, `canary.auto_rolled_back`.                |

---

## 6. Non-Functional Requirements

### 6.1 Performance

| Metric                              | Target                 |
| ----------------------------------- | ---------------------- |
| Manifest endpoint (cache hit)       | p50 < 10ms, p99 < 50ms |
| Manifest endpoint (cache miss)      | p99 < 200ms            |
| Dashboard API reads (authenticated) | p99 < 500ms            |

### 6.2 Reliability

- Registry MUST degrade gracefully: serve stale cache on DB unavailability (MAN-06).
- GC jobs MUST be idempotent (GC-07).
- Webhook failures MUST NOT affect manifest serving.

### 6.3 Security

- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`.
- JWT access tokens: 15-minute TTL, verified via `jose` at the Edge.
- Refresh tokens: opaque, stored as bcrypt hash in DB, rotated on use.
- CORS: configurable allowlist via `ALLOWED_ORIGINS` env var.
- Input validation: `zod` on all API routes.
- Rate limiting: 10 req/min per IP on all auth endpoints.
- RLS: defense-in-depth on all tenant-scoped tables.

### 6.4 Observability

- All services emit **OpenTelemetry**-compatible traces and metrics.
- `ILogger` uses OTel as the abstraction; adapters export to Console (dev), Sentry, DataDog.
- Health endpoints: `GET /health` (liveness) and `GET /ready` (readiness) on all services.
- Prometheus metrics on `GET /metrics` in the registry.
- Structured JSON logging in production.

### 6.5 Developer Experience

- `pnpm run docker:up` starts the full stack (Postgres, Redis, Registry, Web).
- `.env.example` documents all required and optional environment variables.
- `pnpm db:seed` creates a demo workspace with sample modules.
- All packages support hot-reload in development mode.
- Package manager: **pnpm v9+** exclusively. `npm` and `yarn` are unsupported.

---

## 7. Pluggable Port Interfaces

### `ICache`

```typescript
interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;
}
// Adapters: RedisCache, InMemoryLRUCache
```

### `IStorage`

```typescript
interface IStorage {
  upload(path: string, data: Buffer, contentType: string): Promise<string>; // returns public URL
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}
// Adapters: S3Storage, GCSStorage, LocalDiskStorage
```

### `ILogger`

```typescript
interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}
// Adapters: OTelLogger (production), ConsoleLogger (development)
```

### `OAuthPlugin`

```typescript
interface OAuthPlugin {
  getAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}
// Adapters: GitHubOAuth, GoogleOAuth — (v2: SAMLPlugin, OIDCPlugin)
```

---

## 8. Database Schema (Conceptual)

```
Workspace         → members, hostApps, apiKeys, webhooks, auditEvents, config
WorkspaceMember   → role: owner | admin | developer | viewer
HostApp           → environments[]
RemoteModule      → hostApp, versions[]
ModuleVersion     → status: active | inactive | canary | deleted
                    fields: version, url, integrity, storagePath, deployedBy, deletedAt
ApiKey            → hash, scopes[], expiresAt, lastUsedAt, rotatedAt, gracePeriodEnd
WebhookEndpoint   → url, events[], secret, active
WebhookDelivery   → endpoint, event, statusCode, attempt, duration, createdAt
AuditEvent        → actorId, actorType, action, resourceType, resourceId, metadata, ip
```

---

## 9. SDK — `@harmoniq/client`

### Features

- `HarmoniqClient` class: initialized with `registryUrl`, `workspaceSlug`, `hostApp`, `environment`.
- ETag-based `If-None-Match` support on all fetches.
- Stale-while-revalidate: return cached manifest instantly, refresh in background.
- Fallback to last-known-good manifest on network failure.
- Automatic retry with exponential backoff (`maxRetries`, `retryDelayMs`).
- Optional polling via `pollIntervalMs`.
- Canary variant and cohort ID exposed on manifest object (CAN-09).
- SRI-aware module entry helpers for Subresource Integrity enforcement (SRI-01–04).
- Module health reporting: `reportModuleLoad()` / `reportModuleError()` (HLT-01).
- Framework adapters as optional sub-paths: `@harmoniq/client/react`, `/angular`, `/vue` (ADP-01).
- Zero runtime dependencies.
- TypeScript-first with fully typed manifest schema (v2).

### API Surface

```typescript
const client = new HarmoniqClient({
  registryUrl: 'https://registry.example.com',
  workspaceSlug: 'acme-corp',
  hostApp: 'consumer-portal',
  environment: 'production',
  pollIntervalMs: 30_000,
});

// Core manifest
const manifest = await client.getManifest();
const url = manifest.getModuleUrl('checkout'); // existing
client.onManifestUpdate((manifest) => {
  /* hot-swap */
}); // existing

// Canary visibility (CAN-09)
manifest.variant; // "stable" | "canary"
manifest.cohortId; // "a7f3c2..." — stable, safe to log
client.on('variantAssigned', ({ variant, cohortId }) => {
  analytics.track('harmoniq_variant', { variant, cohortId });
});

// SRI-aware helpers (SRI-01)
const { url, integrity } = manifest.getModuleEntry('checkout');
const scriptTag = manifest.getScriptTag('checkout');
// → '<script type="module" src="..." integrity="sha256-..." crossorigin="anonymous"></script>'

// Health reporting (HLT-01)
client.reportModuleLoad('checkout', { success: true, loadMs: 142, variant: 'canary' });
client.reportModuleError('checkout', { error: new Error('...'), variant: 'stable' });
```

---

## 10. CLI — `@harmoniq/cli`

> **Design principle**: The CLI exists exclusively for **CI/CD pipelines** (GitHub Actions, GitLab CI, Jenkins, Bitbucket Pipelines). All operational and management actions are **dashboard-first**. See §5.11, §5.18 for dashboard-equivalent features.

| Command                        | CI/CD Trigger     | Purpose                                               |
| ------------------------------ | ----------------- | ----------------------------------------------------- |
| `harmoniq login`               | Pipeline setup    | Store API key for pipeline steps                      |
| `harmoniq whoami`              | Debug step        | Validate auth context in CI logs                      |
| `harmoniq deploy`              | Post-build CD     | Deploy artifact after CDN publish                     |
| `harmoniq rollback`            | Failure handler   | Roll back on smoke test failure                       |
| `harmoniq promote`             | CD pipeline gate  | Promote `staging → production` after acceptance tests |
| `harmoniq canary promote`      | Rollout script    | Promote canary → active after health gate             |
| `harmoniq canary set-traffic`  | Rollout scheduler | Ramp traffic % in staged rollout                      |
| `harmoniq validate`            | Pre-deploy gate   | Validate URL reachability, integrity, dep conflicts   |
| `harmoniq manifest get --json` | Smoke test        | Read live manifest in post-deploy validation          |

```bash
harmoniq deploy \
  --module checkout \
  --env production \
  --url https://cdn.example.com/checkout@1.2.3.js \
  --version 1.2.3 \
  --commit-sha a1b2c3d4
```

---

## 11. Health & Observability Endpoints

| Endpoint       | Service       | Description                                            |
| -------------- | ------------- | ------------------------------------------------------ |
| `GET /health`  | registry, web | Liveness — 200 if process is running                   |
| `GET /ready`   | registry, web | Readiness — 200 if DB + cache reachable; 503 otherwise |
| `GET /metrics` | registry      | Prometheus-compatible metrics                          |

---

## 12. Deployment

- **Docker Compose**: `docker/docker-compose.yml` — Postgres, Redis, Registry, Web.
- **12-factor compliant**: all config via environment variables.
- **Environment variables**: documented in `.env.example` at the repo root.
- **v2 target**: Kubernetes Helm chart (community contribution).

---

## 13. Open Source

- **License**: Apache 2.0
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **Changelog**: `changesets` with automated release notes
- **Change documentation rule**: all PRs MUST update `docs/features/` — enforced by `AGENTS.md`

---

## 14. Extended Functional Requirements (v1.1)

The following sections document requirements added after the initial v1.0 spec. All are targeted for v1 GA unless noted.

---

### 5.10 Environment Promotion Pipeline

| ID     | Requirement                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRO-01 | The registry MUST support `POST /api/workspaces/:workspaceSlug/modules/:moduleId/promote` to copy an `active` or `canary` version from one environment to another atomically.    |
| PRO-02 | A promote MUST: (a) create a new `ModuleVersion` in the target env, (b) set it `active`, (c) deactivate all other target-env versions, (d) invalidate target-env manifest cache. |
| PRO-03 | A promote MUST fail with `409 Conflict` if the target environment has a deployment freeze active (ENV-FRZ-01).                                                                   |
| PRO-04 | The CLI MUST support: `harmoniq promote --module <name> --from <env> --to <env>`.                                                                                                |
| PRO-05 | The dashboard MUST provide a one-click "Promote to Production" button on the module detail page, visible to `admin` and `owner` roles only.                                      |
| PRO-06 | An `AuditEvent` of `action: 'module.promote'` MUST be created, including `fromEnvironmentId` and `toEnvironmentId` in `metadata`.                                                |

---

### 5.11 Host App Scoping

| ID     | Requirement                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| HST-01 | The canonical manifest endpoint is `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env`.                                                           |
| HST-02 | The legacy endpoint `GET /api/manifest/:workspaceSlug/:env` MUST remain functional, resolving to the `isDefault = true` HostApp (backward compat). |
| HST-03 | The manifest response MUST include `"hostApp": { "slug": "...", "name": "..." }`.                                                                  |
| HST-04 | Cache keys MUST be scoped to host app: `manifest:{workspaceSlug}:{hostAppSlug}:{env}`.                                                             |
| HST-05 | The dashboard MUST allow managing multiple HostApps per workspace, each with its own modules and environments.                                     |
| HST-06 | A `RemoteModule` MUST belong to exactly one `HostApp`. Cross-host module sharing is not supported in v1.                                           |

---

### 5.12 Module Dependency Declaration

| ID     | Requirement                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEP-01 | The manifest module object MUST support an optional `dependencies` map: `Record<string, string>` (package name → semver range).                                                                                         |
| DEP-02 | The registry MUST perform dependency compatibility validation at deploy time: conflicting semver ranges across `active` modules in the same env MUST return `422 Unprocessable Entity` with a detailed conflict report. |
| DEP-03 | Dependency validation MAY be bypassed with a `--force` CLI flag, recording an `AuditEvent` of `action: 'module.deploy_forced'`.                                                                                         |
| DEP-04 | The dashboard MUST display a **Dependency Matrix** view per environment: shared deps vs. modules, conflicts highlighted in red.                                                                                         |
| DEP-05 | `harmoniq deploy` MUST output dependency conflict warnings to stderr before failing.                                                                                                                                    |

---

### 5.13 Manifest Validation (Pre-Deploy Gates)

| ID     | Requirement                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-01 | `harmoniq validate` MUST check: (a) URL reachable (HTTP 200), (b) SHA-256 matches `--integrity`, (c) declared `--exposes` keys present in bundle.          |
| VAL-02 | The registry MUST support a dry-run deploy mode: `POST .../deploy` with `{ "dryRun": true }` — runs all validation checks but does NOT commit the version. |
| VAL-03 | Dry-run response: `{ "dryRun": true, "validation": { "urlReachable": bool, "integrityMatch": bool, "dependencyConflicts": [], "warnings": [] } }`.         |
| VAL-04 | The dashboard MUST show a "Validate Bundle" step before confirming a deploy.                                                                               |
| VAL-05 | Validation results MUST be included in the `AuditEvent` metadata for all deploys.                                                                          |

---

### 5.14 Manifest Rate Limiting

| ID    | Requirement                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------- |
| RL-01 | The manifest endpoint MUST be rate-limited via token-bucket: 600 req/min per `(workspaceSlug, clientIP)`. |
| RL-02 | Exceeded rate limit MUST return `429 Too Many Requests` with a `Retry-After` header.                      |
| RL-03 | Rate limit state MUST be stored in `ICache` (shared across registry replicas).                            |
| RL-04 | Workspace plan (PLN-01) MAY configure higher rate limit tiers.                                            |
| RL-05 | `GET /metrics` MUST expose `harmoniq.manifest.rate_limited_total` counter by workspace slug.              |

---

### 5.15 Alert Rules Engine

| ID     | Requirement                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALT-01 | Workspaces MAY configure alert rules via dashboard or API: `POST /api/workspaces/:slug/alerts`.                                                                  |
| ALT-02 | Alert conditions: `canary_error_rate > threshold`, `manifest_fetch_error_rate > threshold`, `webhook_failure_rate > threshold`, `canary_load_p95ms > threshold`. |
| ALT-03 | Alert actions: `webhook` (POST to any URL) or `auto_rollback` (promote the previous stable version).                                                             |
| ALT-04 | `auto_rollback` MUST create `AuditEvent` of `action: 'module.auto_rollback'` with alert rule ID and triggering metric value.                                     |
| ALT-05 | Alert rule evaluation MUST run as a `pg-boss` job every 60 seconds.                                                                                              |

---

### 5.16 Manifest Diff

| ID      | Requirement                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DIFF-01 | `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/diff?fromSnapshotId=<id>&toSnapshotId=<id>` MUST return: `{ added, removed, changed }` module lists. |
| DIFF-02 | Diff is computed from `ManifestSnapshot` records (SNAP-01).                                                                                              |
| DIFF-03 | The dashboard MUST display a side-by-side manifest diff on the deployment history page.                                                                  |
| DIFF-04 | `harmoniq validate` output MUST include a projected diff as part of its dry-run result.                                                                  |

---

### 5.17 Manifest Snapshot Archive

| ID      | Requirement                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SNAP-01 | Every manifest mutation (deploy, rollback, canary change, promote) MUST create a `ManifestSnapshot` record with the full manifest JSON, triggering `AuditEvent` ID, and timestamp. |
| SNAP-02 | `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots` MUST return a paginated list, most recent first.                                                                    |
| SNAP-03 | `GET .../snapshots/:snapshotId` MUST return the exact manifest JSON at that point in time.                                                                                         |
| SNAP-04 | Snapshots are subject to the workspace `retentionDays` GC policy.                                                                                                                  |
| SNAP-05 | Snapshots are usable as source/target for the diff endpoint (DIFF-01).                                                                                                             |

---

### 5.18 Environment Freeze

| ID         | Requirement                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV-FRZ-01 | Workspace `admin` and `owner` roles MUST be able to freeze an environment via the dashboard, blocking all deploy, rollback, canary, and promote operations. |
| ENV-FRZ-02 | Mutating operations on a frozen env MUST return `423 Locked` with the freeze reason.                                                                        |
| ENV-FRZ-03 | Only `owner` role can force-override a freeze; override creates `AuditEvent` of `action: 'env.freeze_override'`.                                            |
| ENV-FRZ-04 | Environments MUST support scheduled freeze windows: `{ "freezeFrom": "...", "freezeUntil": "..." }`.                                                        |
| ENV-FRZ-05 | The dashboard MUST display a prominent "🔒 FROZEN" badge on frozen environments across all views.                                                           |
| ENV-FRZ-06 | Manifest reads (`GET /api/manifest/...`) are never blocked by a freeze.                                                                                     |

---

### 5.19 Module Health Scoring

| ID     | Requirement                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| HLT-01 | The `@harmoniq/client` SDK MUST support reporting module load outcomes to the registry (success, failure, load time).                                |
| HLT-02 | The registry MUST aggregate health signals per module/env/variant over a 5-minute rolling window via `GET /api/modules/:moduleId/health?env=<slug>`. |
| HLT-03 | Health response: `{ loadSuccessRate, p50LoadMs, p95LoadMs, errorCount, sampleCount, trend }`.                                                        |
| HLT-04 | The dashboard MUST display a health sparkline per module on the modules list page.                                                                   |
| HLT-05 | Alert rules (ALT-02) MUST be able to reference `loadSuccessRate` and `p95LoadMs`.                                                                    |

---

### 5.20 Staged Rollout (Progressive Traffic Bands)

| ID     | Requirement                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| STG-01 | A `canary` version MUST support a `rolloutSchedule`: ordered list of traffic bands with optional auto-promote conditions. |
| STG-02 | Auto-promotion is triggered by a `pg-boss` job evaluating health/alert conditions against the canary cohort.              |
| STG-03 | The final band at `trafficPercent: 100` automatically triggers promote (canary → active).                                 |
| STG-04 | Failed auto-promote condition at any band triggers automatic canary rollback and creates an `AuditEvent`.                 |
| STG-05 | Manual override (advance band or roll back) MUST be available in the dashboard at any time.                               |

---

### 5.21 Full SSO — OIDC + SAML 2.0 (v1)

> Both OIDC and SAML 2.0 ship in v1. WS-Federation remains a v2 target.

#### OIDC (Authorization Code + PKCE)

| ID     | Requirement                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSO-01 | An `OIDCPlugin` adapter MUST cover OIDC Authorization Code + PKCE. Verified with: Okta, Azure AD (Entra), Auth0, Ping Identity, Google Workspace, Keycloak, AWS Cognito. |
| SSO-02 | `WorkspaceConfig.oauthProvider` MUST support `oidc` alongside `github` and `google`.                                                                                     |
| SSO-03 | OIDC config settable via dashboard (issuer URL, client ID, secret, scopes) and env vars for self-hosters.                                                                |
| SSO-04 | Registry MUST auto-discover OIDC metadata from `/.well-known/openid-configuration` with configurable TTL caching.                                                        |
| SSO-05 | `OIDCPlugin` MUST validate ID tokens: signature (JWKS), `iss`, `aud`, `exp`, `iat`, `nonce` using `jose`.                                                                |
| SSO-06 | First OIDC login: `User` record created (JIT provisioning); auto-joined to workspace if email domain matches the configured domain allowlist.                            |
| SSO-07 | OIDC claim-to-role mapping MUST be configurable per workspace (IdP group/role claim → Harmoniq role).                                                                    |
| SSO-08 | OIDC refresh token MUST be used to silently re-authenticate sessions before expiry.                                                                                      |

#### SAML 2.0

| ID     | Requirement                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SSO-09 | A `SAMLPlugin` adapter MUST support SP-initiated and IdP-initiated SSO flows.                                                                 |
| SSO-10 | Registry MUST expose ACS endpoint: `POST /auth/saml/:workspaceSlug/acs`.                                                                      |
| SSO-11 | Registry MUST expose SP Metadata endpoint: `GET /auth/saml/:workspaceSlug/metadata` (XML).                                                    |
| SSO-12 | Registry MUST expose SP-Initiated redirect: `GET /auth/saml/:workspaceSlug/login`.                                                            |
| SSO-13 | Registry MUST expose SLO endpoints: `GET /auth/saml/:workspaceSlug/logout` and `POST /auth/saml/:workspaceSlug/slo`.                          |
| SSO-14 | SAML Responses MUST be validated: XML signature, `Issuer`, `Destination`, `NotBefore`, `NotOnOrAfter`, `InResponseTo`, `AudienceRestriction`. |
| SSO-15 | SAML config: IdP Entity ID, SSO URL, SLO URL, IdP X.509 cert (PEM), NameID format, SP signing key pair.                                       |
| SSO-16 | SAML attribute mapping MUST be configurable per workspace (assertion attribute → Harmoniq user field).                                        |
| SSO-17 | SAML config MUST be importable from an IdP metadata XML file in the dashboard.                                                                |
| SSO-18 | SP signing certificate and private key MUST be generated per workspace and stored encrypted at rest.                                          |
| SSO-19 | Dashboard MUST provide a SAML Setup Wizard with step-by-step instructions for Okta, Azure AD, and ADFS.                                       |
| SSO-20 | "Test Connection" button MUST initiate a test SP-initiated flow showing raw assertion attributes without creating a session.                  |

#### Shared Identity Features (OIDC + SAML)

| ID     | Requirement                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| SSO-21 | **JIT Provisioning**: `User` record created automatically on first SSO login. No pre-provisioning required.                     |
| SSO-22 | **Domain auto-join**: Workspace admins configure trusted email domains; matching users are auto-added with a default role.      |
| SSO-23 | **Group-to-role mapping**: IdP group membership mapped to Harmoniq roles. Most permissive matching role wins.                   |
| SSO-24 | **SCIM 2.0** _(enterprise tier)_: Registry exposes `/scim/v2` for push-based provisioning/deprovisioning from Okta, Azure AD.   |
| SSO-25 | SCIM operations: `GET`, `POST`, `PUT`, `PATCH`, `DELETE /Users/:id`. DELETE sets `revokedAt` on all workspace memberships.      |
| SSO-26 | **Forced SSO**: Workspace admins MAY block direct GitHub/Google login once SSO is configured.                                   |
| SSO-27 | **Session management**: SSO sessions MUST respect the IdP's session lifetime. Expired IdP sessions redirect to re-authenticate. |
| SSO-28 | `AuditEvent` MUST be created for every SSO login, logout, SCIM provision, and SCIM deprovision.                                 |

---

### 5.22 Module-Level RBAC (Team Ownership)

| ID      | Requirement                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RBAC-01 | A `ModuleOwnership` table MUST associate `RemoteModule` with `WorkspaceMember` IDs as owners.                                                            |
| RBAC-02 | Deploy, rollback, canary, promote on a module MUST be authorized against: (a) workspace `admin`/`owner` (always allowed), OR (b) module-level ownership. |
| RBAC-03 | A module with no owners is accessible to all workspace `developer` role members.                                                                         |
| RBAC-04 | API keys MUST support optional `moduleIds` scope restriction.                                                                                            |
| RBAC-05 | Dashboard MUST provide a "Module Owners" tab on the module detail page.                                                                                  |
| RBAC-06 | Unauthorized attempts MUST return `403 Forbidden` and create `AuditEvent` of `action: 'module.unauthorized_attempt'`.                                    |

---

### 5.23 SRI Enforcement in the SDK

| ID     | Requirement                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SRI-01 | SDK MUST expose `manifest.getModuleEntry(name)` returning `{ url, integrity }`.                                                          |
| SRI-02 | SDK MUST provide `manifest.getScriptTag(name)` returning a `<script>` HTML string with `src`, `integrity`, and `crossorigin` attributes. |
| SRI-03 | SDK MUST document how to pass `integrity` to `<script type="module-shim">` and the host's module loader.                                 |
| SRI-04 | SDK MUST emit `console.warn` if a module is loaded without SRI verification when an `integrity` field is present in the manifest.        |

---

## 15. Tech-Stack Agnosticism

### 15.1 Native Browser Import Map Generation

| ID     | Requirement                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| IMP-01 | Registry MUST serve `GET /api/importmap/:workspaceSlug/:hostAppSlug/:env` returning a standards-compliant Import Map JSON. |
| IMP-02 | Response: `{ "imports": { "@scope/module": "https://..." } }`.                                                             |
| IMP-03 | Module `name` field maps to Import Map specifier (e.g., `@acme/checkout`).                                                 |
| IMP-04 | Import Map endpoint MUST support ETag + `If-None-Match` (same caching strategy as manifest).                               |
| IMP-05 | Import Map endpoint is publicly readable with the same rate limiting as the manifest endpoint.                             |
| IMP-06 | Deploy and promote operations MUST invalidate the Import Map cache key alongside the manifest cache key.                   |

### 15.2 Framework Adapters

| ID     | Requirement                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| ADP-01 | `@harmoniq/client` SDK MUST export adapters as optional sub-paths: `/react`, `/angular`, `/vue`.                              |
| ADP-02 | React adapter: `<HarmoniqProvider>` + `useRemoteModule(name)` hook with loading/error states and hot-swap on manifest update. |
| ADP-03 | Angular adapter: `HarmoniqService` injectable returning `Observable<Manifest>`.                                               |
| ADP-04 | Vue adapter: `useHarmoniq(name)` composable.                                                                                  |
| ADP-05 | Dashboard Quickstart Wizard (DX-04) MUST generate framework-specific integration snippets for each adapter.                   |

### 15.3 OpenAPI Export

| ID     | Requirement                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------- |
| OAS-01 | Registry MUST auto-generate and serve OpenAPI 3.1 spec at `GET /api/openapi.json` via `@fastify/swagger`. |
| OAS-02 | Spec MUST be committed to `docs/openapi.json` on every release via CI.                                    |
| OAS-03 | Community `harmoniq-go` and `harmoniq-python` clients generated from the spec are v1.1 targets.           |
| OAS-04 | Dashboard MUST embed an interactive API explorer (Scalar) at `/docs/api`.                                 |

### 15.4 SystemJS Support

| ID     | Requirement                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| SYS-01 | Registry MUST serve SystemJS-compatible format at `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env?format=systemjs`. |
| SYS-02 | SystemJS format MUST follow SystemJS import-map conventions.                                                            |
| SYS-03 | `@harmoniq/client` MUST support `loaderMode: 'esm'                                                                      | 'systemjs' | 'amd'` option. |

### 15.5 Workspace Plans

| ID     | Requirement                                                                              |
| ------ | ---------------------------------------------------------------------------------------- |
| PLN-01 | Each `Workspace` MUST have a `plan` field: `hobby                                        | startup | enterprise`. Self-hosters configure limits via env vars. |
| PLN-02 | Plan limits MUST be env-var configurable so self-hosters can set all tiers to unlimited. |
| PLN-03 | Cloud-hosted SaaS MUST enforce plan limits at the application layer (NOT via RLS).       |

### 15.6 Developer DX

| ID    | Requirement                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| DX-01 | `pnpm run docker:up` MUST start a fully functional demo in under 60 seconds with seed data.                                   |
| DX-02 | `pnpm run dev:local` MUST start an in-memory registry with no Docker or Postgres required.                                    |
| DX-03 | Manifest endpoint MUST support `?pretty=true` for human-readable JSON in development (disabled in production).                |
| DX-04 | Dashboard MUST include an embedded Quickstart Wizard for new workspaces: create HostApp → add module → copy snippet → deploy. |
| DX-05 | `@harmoniq/client` package MUST be zero-dependency (no runtime dependencies).                                                 |
| DX-06 | `.env.example` MUST document all required and optional env vars with inline explanatory comments.                             |

---

## 16. Enterprise-Grade Governance

> These three areas are the identified procurement blockers for regulated industries and large enterprises. All targeted for Phase 8.

---

### 16.1 Change Approval Workflows (4-Eyes Principle)

> Without this, SOX, PCI-DSS, and HIPAA-regulated organisations cannot legally adopt Harmoniq for production deployments.

#### Approval Policy Configuration

| ID     | Requirement                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APR-01 | Workspace `admin` and `owner` MUST be able to define an `ApprovalPolicy` per environment: required approver count (1–N), eligible roles, change ticket requirement, and expiry window. |
| APR-02 | Approval policies MUST be configurable at `Workspace Settings → Deployments → Approval Rules`.                                                                                         |
| APR-03 | Policies MUST be enforceable independently per environment (e.g., staging = none, production = 2 approvers).                                                                           |

#### Deployment Request Lifecycle

| ID     | Requirement                                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APR-04 | When a deploy, rollback, promote, or canary operation targets an environment with an active `ApprovalPolicy`, the registry MUST create a `DeploymentRequest` in `pending_approval` status instead of immediately executing. |
| APR-05 | The requestor MUST NOT be eligible to approve their own request (self-approval is forbidden at the application layer).                                                                                                      |
| APR-06 | Each decision MUST be recorded as a `DeploymentApproval` record: approver ID, `approved \| rejected`, timestamp, comment.                                                                                                   |
| APR-07 | When required approvals are reached, the registry MUST atomically execute the original operation and transition the request to `executed`.                                                                                  |
| APR-08 | A single `rejected` decision MUST immediately transition the request to `rejected`; the operation is not executed.                                                                                                          |
| APR-09 | Requests MUST expire after the configured window (default: 24h), set to `expired` via a `pg-boss` cron. Requestor is notified on expiry.                                                                                    |

#### Emergency Override

| ID     | Requirement                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| APR-10 | Workspace `owner` MUST be able to emergency-bypass a pending request with a mandatory written justification (minimum 20 characters).                 |
| APR-11 | Emergency bypass MUST create `AuditEvent` of `action: 'deploy.emergency_bypass'` containing justification, bypassing actor, and original request ID. |
| APR-12 | Bypassed deployments MUST be visually flagged in audit log and deployment history with a `⚠️ BYPASSED` indicator.                                    |

#### Change Ticket Integration

| ID     | Requirement                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APR-13 | `ApprovalPolicy` MAY require a change ticket ID before submission: `{ "requireChangeTicket": true, "ticketUrlPattern": "https://acme.atlassian.net/browse/{id}" }`. |
| APR-14 | Change ticket ID and URL MUST be stored on `DeploymentRequest` and displayed in the audit log.                                                                      |
| APR-15 | `POST /api/workspaces/:slug/approvals/:requestId/approve` and `/reject` MUST verify the approver is eligible and not the requestor.                                 |

#### Dashboard & Notifications

| ID     | Requirement                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| APR-16 | Dashboard MUST show a **Pending Approvals** queue per user: all requests awaiting their review across all eligible environments.    |
| APR-17 | Eligible approvers MUST be notified via webhook event `deploy.approval_requested` (and optionally email) when a request is pending. |
| APR-18 | Deployment history MUST display the full approval chain per deployment: requestor, each approver, timestamps, comments.             |

---

### 16.2 Organization Hierarchy

> A 5,000-person engineering org has 50+ product teams. Without a container above "workspace," large enterprises cannot model their team structure, enforce SSO globally, or get a cross-team audit view.

#### Organization Entity

| ID     | Requirement                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| ORG-01 | A new `Organization` entity MUST be the top-level container: `Organization → [Workspaces]`.                                     |
| ORG-02 | `Organization` MUST have: `id`, `slug`, `name`, `plan`, SSO config (encrypted), `createdAt`, `deletedAt`.                       |
| ORG-03 | `Workspace` MUST have an optional FK `organizationId`. Workspaces without an org remain standalone (fully backward-compatible). |
| ORG-04 | `OrganizationMember` table MUST associate `User` with `Organization` at roles: `org_admin \| org_member`.                       |

#### Organization-Level SSO (Configure Once, Apply Everywhere)

| ID     | Requirement                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| ORG-05 | SAML 2.0 and OIDC MUST be configurable at org level. Workspace-level SSO overrides org-level for that workspace.           |
| ORG-06 | Organization SAML endpoints: `POST /auth/saml/:orgSlug/acs`, `GET /auth/saml/:orgSlug/metadata`.                           |
| ORG-07 | SCIM 2.0 at org level MUST provision users into the org and auto-assign them to child workspaces based on IdP group rules. |

#### Organization Administration

| ID     | Requirement                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORG-08 | `org_admin` MUST be able to: create/delete workspaces, manage org-level SSO, view the org audit log, manage org members, set org-wide approval policy defaults. |
| ORG-09 | `GET /api/orgs/:orgSlug/audit` MUST return a paginated audit log spanning all workspaces in the org, filterable by workspace, actor, action, and date range.    |

#### Cross-Workspace Module Sharing

| ID     | Requirement                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORG-10 | A workspace `owner` MUST be able to publish a module as **org-shared**: visible and deployable (read-only) by all workspaces in the org.            |
| ORG-11 | Org-shared modules appear in a child workspace's manifest with `{ "shared": true, "ownerWorkspace": "design-system-team" }`.                        |
| ORG-12 | The org dashboard MUST display an **Org Module Catalog**: all modules published across workspaces, with team ownership and current version per env. |

#### Organization-Level API Keys & Dashboard

| ID     | Requirement                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORG-13 | Org-level API keys MUST be scopable to: all workspaces, specific workspace IDs, specific module IDs — for org-wide CI/CD pipelines shared across teams. |
| ORG-14 | Dashboard MUST have an **Organization home** page: all workspaces, aggregate health, recent deploys, and cross-workspace audit log.                     |
| ORG-15 | URL structure: `/orgs/:orgSlug/workspaces` and `/orgs/:orgSlug/audit`. Existing `/:workspaceSlug` routes remain backward-compatible.                    |

---

### 16.3 GitOps / Infrastructure as Code

> Mature DevOps teams manage infrastructure as code. Without Terraform or declarative YAML support, platform engineering teams will build their own solution.

#### Terraform Provider

| ID     | Requirement                                                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IaC-01 | A `harmoniq-dev/harmoniq` Terraform provider MUST be published to the Terraform Registry supporting resources: `harmoniq_workspace`, `harmoniq_environment`, `harmoniq_host_app`, `harmoniq_remote_module`, `harmoniq_api_key`, `harmoniq_webhook_endpoint`, `harmoniq_alert_rule`, `harmoniq_approval_policy`. |
| IaC-02 | All resources MUST support standard Terraform lifecycle: create, read, update, delete, import.                                                                                                                                                                                                                  |
| IaC-03 | Provider MUST be implemented in Go using `hashicorp/terraform-plugin-framework`.                                                                                                                                                                                                                                |
| IaC-04 | Provider docs MUST be auto-generated via `tfplugindocs` and published to `registry.terraform.io`.                                                                                                                                                                                                               |

```hcl
resource "harmoniq_environment" "production" {
  workspace_id = harmoniq_workspace.checkout_team.id
  name         = "production"
  slug         = "production"
  approval_policy {
    required_approvers    = 2
    eligible_roles        = ["admin", "owner"]
    require_change_ticket = true
    expiry_hours          = 24
  }
}
```

#### GitHub Actions Native Integration

| ID     | Requirement                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| IaC-05 | A GitHub Actions composite action `harmoniq-dev/deploy-action@v1` MUST be published to the GitHub Marketplace.                                      |
| IaC-06 | Inputs: `api-key`, `registry-url`, `workspace`, `module`, `environment`, `url`, `version`, `integrity` (optional, computed if omitted), `dry-run`.  |
| IaC-07 | Outputs: `version-id`, `manifest-url`, `deployed-at`.                                                                                               |
| IaC-08 | Action MUST annotate the GitHub Actions job summary with a deployment card: module, version, environment, manifest URL, approval status, diff link. |

```yaml
- uses: harmoniq-dev/deploy-action@v1
  with:
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme-corp
    module: checkout
    environment: production
    url: https://cdn.example.com/checkout@${{ steps.build.outputs.version }}.js
    version: ${{ steps.build.outputs.version }}
```

#### Harmoniq-as-Code (Declarative State)

| ID     | Requirement                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IaC-09 | The CLI MUST support a `harmoniq.yaml` file declaring the desired state of a workspace: environments, host apps, modules, alert rules, approval policies, freeze windows. |
| IaC-10 | `harmoniq plan` MUST compare `harmoniq.yaml` against current registry state and output a structured diff without making changes.                                          |
| IaC-11 | `harmoniq apply` MUST reconcile the registry to match `harmoniq.yaml`, creating/updating/deleting resources as needed.                                                    |
| IaC-12 | `harmoniq import` MUST generate a `harmoniq.yaml` from the current registry state (migration path for existing workspaces).                                               |

```yaml
# harmoniq.yaml
apiVersion: harmoniq/v1
workspace: acme-corp
environments:
  - slug: staging
  - slug: production
    approval:
      required_approvers: 2
      eligible_roles: [admin, owner]
      require_change_ticket: true
    freeze_windows:
      - cron: '0 22 * * 5' # Friday 10pm UTC
        duration_hours: 56 # through Monday 10am
```

#### GitLab CI Integration

| ID     | Requirement                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------- |
| IaC-13 | A GitLab CI component `harmoniq-dev/harmoniq-ci/deploy` MUST be published to the GitLab CI Catalog. |
| IaC-14 | The component MUST support the same inputs/outputs as the GitHub Actions action.                    |

---

## 17. Instance Admin UI

> Self-hosters need a first-class admin panel to configure the instance without touching `.env` files on every change. This is a requirement for any on-premise enterprise deployment where the operator and the workspace admin are different people.

### 17.1 First-Boot Setup Wizard

| ID      | Requirement                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-01 | A first-boot setup wizard MUST be served at `/admin/setup` when no `InstanceAdmin` record exists in the database.                                                                                                       |
| INST-02 | The setup route MUST be protected by a one-time token set via env var `HARMONIQ_SETUP_TOKEN`. If the token is missing or already consumed, the route returns `403 Forbidden`.                                           |
| INST-03 | The wizard MUST guide the operator through four steps: (1) create the first admin account, (2) verify DB + cache connectivity, (3) select and test the default storage adapter, (4) enable at least one OAuth provider. |
| INST-04 | On completion, the `HARMONIQ_SETUP_TOKEN` MUST be marked consumed (stored in `InstanceConfig`) so the wizard cannot be re-triggered.                                                                                    |

### 17.2 Instance Admin Role

| ID      | Requirement                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-05 | An `InstanceAdmin` role MUST exist, entirely separate from any workspace role. `InstanceAdmin` grants access to `/admin/*` routes only.             |
| INST-06 | All `/admin/*` routes MUST require `InstanceAdmin` authentication. Workspace-level sessions MUST NOT grant access, even for workspace `owner` role. |
| INST-07 | Instance admins MUST be manageable from the admin panel: grant/revoke `InstanceAdmin` to/from any existing `User`.                                  |

### 17.3 Admin Panel Pages

| ID      | Requirement                                                                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-08 | **System Health** (`/admin/health`): DB connection status, Redis/cache connection status, storage adapter ping, `pg-boss` job queue depth, active background job count.                                                                            |
| INST-09 | **Workspaces** (`/admin/workspaces`): list all workspaces with usage metrics (module count, deploy count, member count, storage bytes used). `InstanceAdmin` MUST be able to suspend, unsuspend, or hard-delete a workspace.                       |
| INST-10 | **Users** (`/admin/users`): list all registered users, their workspace memberships, last login timestamp. `InstanceAdmin` MUST be able to force-revoke all active sessions for a user and hard-delete a user account.                              |
| INST-11 | **Storage Settings** (`/admin/storage`): select adapter type (`local \| s3 \| gcs \| azure-blob`), configure credentials, set default CDN prefix URL, test connectivity. Changes take effect immediately without restarting the process (INST-14). |
| INST-12 | **Email / SMTP** (`/admin/email`): configure SMTP host, port, TLS mode, username, password, sender address. A "Send Test Email" button MUST dispatch a test message to the admin's own address.                                                    |
| INST-13 | **OAuth Providers** (`/admin/auth`): enable/disable GitHub, Google, OIDC, SAML globally. A provider disabled at the instance level MUST NOT be selectable by any workspace, regardless of workspace-level config.                                  |
| INST-14 | **Branding** (`/admin/branding`): instance display name, logo URL, support contact URL, primary accent colour (used in dashboard header and email templates).                                                                                      |

### 17.4 Runtime Configuration

| ID      | Requirement                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-15 | All sensitive instance config (storage credentials, SMTP credentials, OAuth secrets) MUST be stored **encrypted at rest** in the `InstanceConfig` table — not only in `.env`.                       |
| INST-16 | Instance config stored in the database MUST take precedence over the equivalent `.env` variable at runtime. `.env` values serve as bootstrap defaults only (used before the database is reachable). |
| INST-17 | The registry MUST hot-reload instance config from the database every 60 seconds without a process restart. A `pg-boss` job or polling loop handles this.                                            |
| INST-18 | An `AuditEvent` of `action: 'instance.config_updated'` MUST be created on every admin panel config change, with the config key and the actor ID (but NOT the plaintext value).                      |

---

## 18. Bring-Your-Own-Bucket (BYOB) Storage per Workspace

> Enterprise customers in regulated industries (HIPAA, FedRAMP, EU GDPR with data residency requirements) cannot store module bundles on shared infrastructure. BYOB allows each workspace to route all storage I/O to their own cloud storage account under their own IAM policy.

### 18.1 Storage Adapter Override

| ID      | Requirement                                                                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BYOB-01 | Workspaces on `startup` or `enterprise` plan MAY configure a custom storage adapter via `Workspace Settings → Storage`, overriding the instance default for all future deploy operations in that workspace.                                                |
| BYOB-02 | Supported BYOB providers: **AWS S3**, **Google Cloud Storage**, **Azure Blob Storage**. The `local` filesystem adapter MUST NOT be allowed as a BYOB target (not tenant-isolatable).                                                                       |
| BYOB-03 | BYOB configuration MUST store (encrypted at rest): provider, bucket/container name, region, credentials (IAM role ARN for S3, service account JSON for GCS, connection string for Azure), optional CDN prefix URL, optional path prefix within the bucket. |

### 18.2 Validation & Testing

| ID      | Requirement                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BYOB-04 | When BYOB config is saved, the registry MUST perform a canary write-read-delete cycle on the workspace's configured bucket to verify credentials and permissions before committing to the database. Return `400 Bad Request` with a diagnostic message on failure. |
| BYOB-05 | A **"Test Connection"** button on the Storage Settings page MUST trigger the canary cycle on demand without saving any configuration changes.                                                                                                                      |
| BYOB-06 | If BYOB credentials rotate (e.g., IAM key rotation), the workspace admin MUST be able to update credentials via the dashboard. A re-validation cycle MUST run before the new credentials are committed.                                                            |

### 18.3 Deploy-Time Behaviour

| ID      | Requirement                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BYOB-07 | When BYOB is configured for a workspace, ALL module bundle deploys for that workspace MUST write to the workspace's own storage adapter. The instance default storage MUST NOT be used.                                                                            |
| BYOB-08 | The `url` field in the manifest MUST reflect the workspace's CDN prefix when BYOB is configured (e.g., `https://cdn.acme.com/mfe/checkout@1.2.3.js` instead of the instance CDN).                                                                                  |
| BYOB-09 | If the BYOB adapter fails at deploy time (credentials expired, bucket unreachable), the registry MUST return `503 Service Unavailable` and MUST NOT fall back to instance default storage. Falling back would silently mix tenant data with shared infrastructure. |
| BYOB-10 | `harmoniq deploy` CLI MUST emit a `warning` to stderr if the workspace has BYOB + a CDN prefix configured but `--url` does not begin with that prefix (likely pointing to the wrong bucket).                                                                       |

### 18.4 Data Residency & Migration

| ID      | Requirement                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BYOB-11 | Module versions deployed to instance storage **before** BYOB was configured MUST remain at their original URLs and are **not** automatically migrated to the workspace bucket.                                                     |
| BYOB-12 | The Storage Settings page MUST display a migration advisory when BYOB is first enabled, explaining that existing modules continue serving from instance storage until re-deployed.                                                 |
| BYOB-13 | `WorkspaceStorageConfig` records are subject to the workspace `deletedAt` lifecycle — deleted when the workspace is hard-deleted.                                                                                                  |
| BYOB-14 | For data residency compliance, the registry MUST log the BYOB provider and region in the `AuditEvent` for every deploy that writes to a workspace-owned bucket (`action: 'module.deploy'`, `metadata.storageRegion: 'eu-west-1'`). |

---

## 19. Tenant Lifecycle & Tenant Administration

> Organizations (§16.2) and the instance admin panel (§17) give Harmoniq a three-level tenant model (Instance → Organization → Workspace). This section covers what an enterprise tenant needs around that model: a complete lifecycle from creation to purge, onboarding and offboarding people, organization-wide policy, usage and quotas, identity hardening, and a tenant admin dashboard. The findings that motivated it are in [multi-tenancy-gap-analysis.md](./multi-tenancy-gap-analysis.md). The design and status are tracked in [features/tenant-administration.md](./features/tenant-administration.md).

### 19.1 Tenant Isolation (continued from §5.5)

| ID    | Requirement                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MT-07 | Organization-scoped tables (`Organization`, `OrganizationMember`, `OrgApiKey`, `OrganizationAuditEvent`, org-scoped `ScimUser` / `ScimGroup` / `ScimAuditEvent`, and the new org tables of §19) MUST be protected by RLS keyed by `app.current_org_id`, and accessed through a `withOrg` helper.                    |
| MT-08 | Cross-workspace reads for an organization (home, catalog, audit, usage) MUST run in an org-scoped transaction in which workspace-scoped RLS also admits the organization's own workspaces, and nothing else.                                                                                                        |
| MT-09 | Route handlers MUST NOT use the system (RLS-bypassing) client, except on an explicit allow-list: tenant resolution, authentication, background jobs and instance-admin routes. A lint rule MUST enforce the allow-list.                                                                                             |
| MT-10 | An isolation test suite MUST cover every organization and workspace read endpoint with two organizations, and prove that no rows of the other organization are returned.                                                                                                                                            |
| MT-11 | In production, the registry MUST refuse to start while the runtime role (`DATABASE_URL`) accepts the placeholder password an early migration gives it when the role doesn't exist yet, pointing to `scripts/bootstrap-db.ts`. (Already-applied migrations are not edited: changing them breaks existing databases.) |
| MT-12 | Management API, deploy and health-ingest rate limits MUST be keyed per workspace (or per organization for org keys) and MAY vary by plan, like the manifest tiers (RL-04).                                                                                                                                          |

### 19.2 Tenant Lifecycle

| ID     | Requirement                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TLC-01 | A workspace owner MUST be able to delete a standalone workspace (`DELETE /api/workspaces/:ws?confirm=<slug>`).                                                                                                                                                                                                                       |
| TLC-02 | Deleting a workspace or organization MUST be a soft delete (`deletedAt`, `purgeAfter`). While pending purge, writes are refused, manifests answer `410 Gone`, and the tenant can be restored by its owner, an org admin or an instance admin for `HARMONIQ_TENANT_RESTORE_DAYS` (default 30, 0 = immediate purge).                   |
| TLC-03 | A purge job MUST remove all of a purged workspace's stored objects: bundles in instance storage and in its own bucket, published manifest and import-map copies, and cached manifests. It MUST be idempotent and audited at instance level. An organization's slug MUST be released after purge.                                     |
| TLC-04 | Instance admins MUST be able to suspend and unsuspend an organization (`POST /api/admin/orgs/:org/suspend`). Suspension applies INST-09 semantics to every workspace of the organization (reads and manifests served, writes refused) and to its org keys.                                                                           |
| TLC-05 | Every workspace MUST be able to have an owner: org admins MUST be able to assign `owner` in their organization's workspaces, and org-key workspace creation MUST accept an `owners` list (emails). While a workspace has no joined owner, org admins act as its owners.                                                              |
| TLC-06 | Ownership transfer: an owner (or org admin) MUST be able to transfer workspace ownership to a member, and an org admin MUST be able to transfer the last org admin seat, with the recipient accepting the transfer.                                                                                                                  |
| TLC-07 | Tenant export: org admins and workspace admins MUST be able to download their data as JSON Lines (workspace config as `harmoniq.yaml`, members, module and version metadata, audit log; for organizations also members, key metadata, the org audit log and every live workspace), streamed in batches. Each export MUST be audited. |
| TLC-08 | An instance setting `tenancy.creation` MUST control who may create organizations and standalone workspaces: `anyone` (default), `verified_domains` (users whose email domain is verified by an organization or listed by the instance) or `instance_admins`.                                                                         |

### 19.3 People & Invitations

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PPL-01 | Invitations to an organization or a workspace MUST be `Invitation` records with a role, inviter, expiry (default 7 days), and resend and revoke actions. Pending invitations MUST NOT grant access.                                                                                                                                                                                                         |
| PPL-02 | When a mailer is configured, invitations MUST be emailed with an accept link; the inviter also gets the link. Accepting requires signing in with a verified email equal to the invited one. Signing in with that email also accepts pending invitations, but a sign-in through a workspace's or organization's own SSO only accepts invitations to workspaces (or the organization) that session can reach. |
| PPL-03 | Org admins MUST have a People directory listing every org member and every member of the org's workspaces, with org role, workspace roles, source (invitation, SSO, SCIM, implicit org admin), last sign-in, API keys created and pending invitations. It MUST support search and pagination.                                                                                                               |
| PPL-04 | Removing an org member MUST also remove their memberships in the org's workspaces, revoke the API keys they created there (default; `keepKeys=true` keeps them), and end their org-SSO sessions. Each effect MUST be audited. The response MUST report what was removed.                                                                                                                                    |
| PPL-05 | Removing a workspace member MUST offer to revoke the API keys they created in that workspace (default: revoke).                                                                                                                                                                                                                                                                                             |
| PPL-06 | A workspace's members view MUST show effective access, including org admins who administer it implicitly (ORG-08), marked as such.                                                                                                                                                                                                                                                                          |
| PPL-07 | An org member who is not in a workspace MUST be able to request access from the org home and catalog. The workspace's admins approve or deny the request, and both outcomes are audited.                                                                                                                                                                                                                    |
| PPL-08 | Organizations MUST support two more roles: `org_billing` (plan and usage, read-only) and `org_auditor` (audit log and export, SSO and policy settings read-only, People read-only).                                                                                                                                                                                                                         |

### 19.4 Organization Policy

| ID     | Requirement                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POL-01 | An `OrgPolicy` MUST hold organization-wide policies, edited by org admins. Every change MUST be audited with the fields before and after.                                                                                                                        |
| POL-02 | Approval defaults (completes ORG-08): an approval policy for environments whose slug matches a pattern (e.g. `production`) MUST apply to every workspace of the org. A workspace policy may be stricter (more approvers, fewer eligible roles) but never weaker. |
| POL-03 | API key policy: maximum lifetime in days and allowed scopes, enforced when workspace and org keys are created or rotated. Existing keys that violate the policy MUST be flagged in the dashboard.                                                                |
| POL-04 | A retention floor: workspaces of the organization cannot set `retentionDays` below the organization's minimum.                                                                                                                                                   |
| POL-05 | Organization freeze windows MUST apply to environments matching a slug pattern across all workspaces, with an org admin override that has the same audit semantics as ENV-FRZ-03.                                                                                |
| POL-06 | Locked SSO: when set, workspaces of the organization cannot configure their own SSO and always inherit the organization's SSO, including forced SSO.                                                                                                             |
| POL-07 | Session policy: a maximum session lifetime and an idle timeout for users of the organization, enforced at token refresh.                                                                                                                                         |
| POL-08 | An IP allowlist (CIDR) for dashboard and management API access to the organization's workspaces, for users and API keys. Manifest and health endpoints are excluded unless explicitly included.                                                                  |
| POL-09 | `GET /api/workspaces/:ws/policy` MUST return the effective policy (the strictest of instance, organization and workspace) with the source of each value.                                                                                                         |

### 19.5 Verified Domains

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM-01 | A domain MUST be verified with a DNS TXT record (`_harmoniq-challenge.<domain>` = `harmoniq-verification=<token>`) before it is used for SSO discovery, trusting the IdP's emails, JIT provisioning or domain join.                                                                                                                                                                       |
| DOM-02 | A verified domain belongs to exactly one organization or one standalone workspace (unique). Instance admins can revoke or reassign it.                                                                                                                                                                                                                                                    |
| DOM-03 | SSO discovery MUST consider only verified domains, through an indexed lookup instead of scanning every SSO configuration.                                                                                                                                                                                                                                                                 |
| DOM-04 | Migration: for `HARMONIQ_DOMAIN_GRACE_DAYS` (default 30) after the first start with domain verification, unverified `trustedDomains` keep working for sign-in, and discovery still routes a domain that exactly one workspace or organization lists (never an ambiguous one). A domain verified by another tenant never counts. The dashboard shows which trusted domains are unverified. |
| DOM-05 | Verified domains MUST be re-checked weekly. A domain that fails for 14 days is unverified, and the organization's admins are notified.                                                                                                                                                                                                                                                    |

### 19.6 Usage, Quotas & Plans (continued from §15.5)

| ID     | Requirement                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PLN-04 | Plans MUST define numeric quotas: workspaces per organization, members (seats), modules, environments per host app, storage (GB), deploys per month and webhook endpoints. Quotas are configurable with `HARMONIQ_PLAN_LIMITS` (JSON) and unlimited when plan enforcement is off (PLN-02). |
| PLN-05 | A create that would exceed a quota MUST return `402 QUOTA_EXCEEDED` with the limit and current usage. The dashboard warns at 80% of a quota.                                                                                                                                               |
| PLN-06 | Instance admins MUST be able to override features and limits per organization or workspace, and set a plan expiry (`planExpiresAt`, for trials). At expiry the tenant falls back to its base plan, and this is audited.                                                                    |
| USG-01 | Usage MUST be metered daily per workspace: manifest requests, deploys, health events, storage bytes, members and API keys. Daily rows are kept for 13 months.                                                                                                                              |
| USG-02 | Storage bytes MUST be measured per version at deploy time (`ModuleVersion.sizeBytes`) and summed per workspace, completing INST-09.                                                                                                                                                        |
| USG-03 | `GET /api/orgs/:org/usage` and `GET /api/admin/usage` MUST return usage against quotas per workspace and in total, with CSV export.                                                                                                                                                        |
| USG-04 | `plan.changed`, `quota.warning` and `quota.exceeded` MUST be emitted as org webhook events and recorded in the audit log.                                                                                                                                                                  |

### 19.7 Identity & Session Security

| ID     | Requirement                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES-01 | The session (refresh token) lifetime and idle timeout MUST be instance settings (`auth.session`), replacing the hard-coded 30 days. Organization policy (POL-07) may only shorten them.                                |
| SES-02 | Users MUST be able to list their own active sessions and end them, one at a time or all at once.                                                                                                                       |
| SES-03 | TOTP multi-factor authentication MUST be available for sign-ins that don't go through SSO (email, GitHub). An organization policy `requireMfa` MUST require it for the organization's members who sign in without SSO. |
| SES-04 | Instance admins MUST be able to suspend a user: sign-in and refresh are refused, existing access tokens are rejected, and API keys the user created stop working until the user is unsuspended.                        |

### 19.8 Audit (continued from §5.7)

| ID     | Requirement                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUD-05 | Audit history MUST survive workspace and organization deletion. Audit rows keep the tenant id without a cascading foreign key and are kept until they are older than `HARMONIQ_AUDIT_RETENTION_DAYS` (default 400). Instance admins MUST be able to export a deleted workspace's audit log by workspace id. |
| AUD-06 | Organizations MUST be able to stream audit events (workspace and org) to sinks: an HTTPS endpoint (HMAC-signed, batched) or an S3-compatible bucket (hourly JSON Lines). Delivery is at least once, with retries and a dead-letter view.                                                                    |
| AUD-07 | Audit APIs and pages MUST show a readable actor (email, or API key name and prefix). An erased user is shown pseudonymously (`deleted user #<hash>`).                                                                                                                                                       |
| AUD-08 | The organization and workspace audit pages MUST filter by actor, action, workspace and date range, and show an event's metadata.                                                                                                                                                                            |
| AUD-09 | Tamper evidence: each audit row MUST store a hash chained to the previous row of its scope, and exports MUST include what is needed to verify the chain.                                                                                                                                                    |

### 19.9 Instance Administration (continued from §17)

| ID      | Requirement                                                                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-19 | `/admin/orgs` MUST list organizations with search and pagination, and an organization page MUST show its workspaces, members, plan, usage, SSO and domain status, with suspend, delete and restore actions.                                                                |
| INST-20 | Support access: an instance admin MUST be able to open a time-boxed (at most 4 hours), read-only grant to an organization or workspace with a written reason. It is recorded in both the instance and the tenant audit log, and shown to the tenant's admins while active. |
| INST-21 | The user list MUST show organization memberships and suspension state. Users and workspaces MUST be exportable as CSV.                                                                                                                                                     |
| INST-22 | Instance admins MUST be able to publish an announcement banner (info, warning or maintenance; optional end time) shown on every dashboard page.                                                                                                                            |

#### System administration: safety

| ID      | Requirement                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INST-23 | Saving the `auth` setting MUST be refused when no active instance admin could still sign in (instance-wide methods only: email and dev for any account, GitHub and instance OIDC for admins who have used them), or when the admin saving it could not. When it only locks out other admins, it is saved and the response names them. |
| INST-24 | The registry image MUST include a recovery CLI (`harmoniq-admin`) using `SYSTEM_DATABASE_URL`: `grant-admin <email>`, `reset-setting <key>`, `revoke-sessions <email>`, `list-admins`. Each command writes an `InstanceAuditEvent` with `actorType: system`.                                                                          |
| INST-25 | `/metrics` MUST be protectable with `HARMONIQ_METRICS_TOKEN` (bearer) or served on a separate port (`HARMONIQ_METRICS_PORT`). Metrics labelled with tenant slugs MUST be opt-in (`HARMONIQ_METRICS_TENANT_LABELS`).                                                                                                                   |
| INST-26 | Sealed values MUST record a key id. `HARMONIQ_ENCRYPTION_KEYS` (`id:key` list; the first is used for new values) MUST allow rotation, a `secrets.reseal` job MUST re-seal every sealed column with the active key, and health MUST report how many values still use an old key.                                                       |

#### System administration: dashboard and operations

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INST-27 | The admin home MUST show 30-day trends (deploys, manifest requests, active users, new organizations and workspaces) and a "needs attention" list linking to each item: failed manifest publishes, webhook dead letters, failed jobs, tenant buckets that fail verification, SAML certificates expiring within 30 days, alert rules in error, quota breaches and domains failing re-verification. |
| INST-28 | `/admin/health` MUST show the version and commit, pending migrations, each replica's uptime and config-reload age (replica heartbeats), and for each job queue its schedule, last run, last success and last failure. Admins MUST be able to list and retry failed jobs and run maintenance jobs (GC, health rollup, purge, domain re-check) on demand.                                          |
| INST-29 | `/admin/workspaces/:slug` MUST show members, host apps and environments with publish status, API keys (count, last used), SSO and SCIM status, storage, plan and usage, and recent audit events. The list MUST filter by status, plan, organization and inactivity, sort by name, creation date, last deploy and usage, and confirm deletion on the detail page.                                 |
| INST-30 | `/admin/users/:id` MUST show the user's sign-in methods, org and workspace memberships, individual sessions (each can be ended), API keys created and recent activity across tenants. The list MUST filter by instance admins, suspended, never signed in and inactive for N days. Admins MUST be able to change a user's email (with verification) and merge two accounts.                      |
| INST-31 | Instance admin roles: `instance_owner` (everything), `instance_operator` (health, jobs, tenant suspension and plans; no settings or admin grants), `instance_support` (read-only, support grants) and `instance_billing` (plans and usage). Admins MUST be grantable by email before the person's first sign-in (an invitation).                                                                 |
| INST-32 | Destructive admin actions (deleting tenants or users, granting admins, changing `auth` or `storage` settings) MUST require re-authentication within the last 10 minutes. Instance admins MUST use MFA or SSO once SES-03 is available. Admin sessions MUST have a separate, shorter maximum lifetime, and `/api/admin` MAY be restricted to an IP allowlist (`HARMONIQ_ADMIN_IP_ALLOWLIST`).     |
| INST-33 | Instance API keys (`hq_inst_…`, scopes `instance:read` and `instance:admin`, optional expiry) MUST be creatable by `instance_owner`s for monitoring and automation. Their use MUST be audited, and they MUST never grant workspace access.                                                                                                                                                       |
| INST-34 | These environment-only settings MUST also be settable in the admin panel, with database values taking precedence (INST-16): plan features and limits, manifest and write rate limits, GC versions kept, default retention, bundle validation, tenancy creation (TLC-08), sessions (SES-01) and health-event retention.                                                                           |
| INST-35 | Every settings save MUST keep a version (secrets sealed). The panel MUST show the history with a diff of non-secret fields and allow rollback. Settings MUST be exportable and importable as YAML without secrets.                                                                                                                                                                               |
| INST-36 | The instance audit log MUST filter by action, actor, resource and date range in both the API and the UI, show readable actors (AUD-07) and formatted metadata. Instance admins MUST be able to search one actor across workspace, organization and instance logs; each search is itself audited.                                                                                                 |
| INST-37 | Maintenance mode: an instance-wide read-only mode in which writes answer `503` with `Retry-After` and manifests are still served. It can be scheduled, and an announcement is shown beforehand (INST-22).                                                                                                                                                                                        |
| INST-38 | The admin panel MUST show an email delivery log (recipient, template, time, result; no bodies) for 30 days, and allow the subject and intro text of each email template to be customised.                                                                                                                                                                                                        |
| INST-39 | Sign-in attempts (success and failure, method, IP) MUST be recorded for 90 days. A security page MUST show failed sign-ins by IP and email, rate-limited tenants, attempts with revoked or expired keys, and SCIM errors.                                                                                                                                                                        |

### 19.10 Tenant Admin Dashboard

| ID     | Requirement                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TAD-01 | `/orgs/:org/settings`: rename, plan and enabled features, verified domains, and a danger zone (transfer, delete, restore).                                                                           |
| TAD-02 | `/orgs/:org/usage`: usage against quotas, trends per workspace, CSV export (USG-03).                                                                                                                 |
| TAD-03 | `/orgs/:org/policies`: every POL requirement, with effective values and the workspaces that are stricter.                                                                                            |
| TAD-04 | `/orgs/:org/people`: the People directory (PPL-03), invitations (PPL-01) and access requests (PPL-07).                                                                                               |
| TAD-05 | Org API keys reach parity with workspace keys: expiry, module scope, rotation with a grace period, creator shown, and a warning for keys unused for 90 days.                                         |
| TAD-06 | The org home MUST add: delete workspace, pending approvals across the organization, suspended and frozen indicators, search and pagination.                                                          |
| TAD-07 | The org catalog MUST support search, filters (workspace, environment, shared) and pagination, and show which workspaces' manifests load a shared module.                                             |
| TAD-08 | The org, workspace and admin layouts MUST share navigation: an org and workspace switcher, breadcrumbs, and a user menu with sessions (SES-02) and sign-out.                                         |
| TAD-09 | Org notification channels (email, Slack or Microsoft Teams incoming webhook) for member changes, key creation, pending approvals, quota warnings and domain verification loss.                       |
| TAD-10 | Org webhooks for organization events (`org.member.*`, `org.workspace.*`, `org.key.*`, `org.policy.updated`, `quota.*`), with the same signing, retries and dead letters as workspace webhooks (WHK). |
