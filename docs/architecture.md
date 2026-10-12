# Harmoniq — Architecture Decision Records

> **Version**: 1.0.0  
> **Last Updated**: 2026-10-11

This document records the key architectural decisions made for the Harmoniq project, the options considered, and the rationale for each choice.

---

## ADR-001: Monorepo with Turborepo

**Status**: Accepted

**Context**: Harmoniq ships multiple related packages (`web`, `registry`, `client`, `cli`, `db`, `core`). These packages share types, configuration, and business logic.

**Decision**: Use a pnpm workspaces monorepo managed by Turborepo.

**Rationale**:

- Shared TypeScript types (`@harmoniq/core`) are consumed by all apps without publishing.
- Turborepo enables incremental builds and remote caching.
- pnpm workspace protocol (`workspace:*`) keeps internal dependencies explicit.
- A single repository enables atomic commits spanning multiple packages.

**Consequences**:

- All contributors must use `pnpm` (enforced by `engines` in `package.json` and `preinstall` script).
- Turbo pipeline is the single source of truth for build order.

---

## ADR-002: Separate Registry App vs. Next.js API Routes

**Status**: Accepted

**Context**: The manifest endpoint is on the hot path of every host application page load. Next.js API routes add framework overhead (middleware, RSC runtime) that is unnecessary for a pure JSON-serving endpoint.

**Decision**: The registry (`apps/registry`) is a **standalone Node.js/Fastify server**, separate from the Next.js dashboard (`apps/web`).

**Rationale**:

- Allows the registry to be horizontally scaled independently from the dashboard.
- Eliminates Next.js cold-start overhead on the manifest endpoint.
- Fastify's JSON serialization is significantly faster than Next.js API routes for high-throughput JSON responses.
- The two apps share business logic via `@harmoniq/core` but are independently deployable.

**Consequences**:

- Two separate Docker images: `harmoniq-web` and `harmoniq-registry`.
- The registry exposes its own port (default `3001`); the web dashboard runs on port `3000`.
- CORS must be configured on the registry to allow the dashboard origin.

---

## ADR-003: PostgreSQL Row-Level Security for Multi-Tenancy

**Status**: Accepted

**Context**: Harmoniq is a multi-tenant SaaS. A data leak between tenants would be catastrophic. Application-layer filtering (`WHERE workspaceId = ?`) is necessary but insufficient as a sole guardrail.

**Decision**: Enable PostgreSQL **Row-Level Security (RLS)** on all tenant-scoped tables as a defense-in-depth layer.

**Implementation** (as built; updated 2026-10-11):

- Two database roles. `harmoniq` owns the schema and runs migrations. `harmoniq_app` is the runtime role with DML grants only, so RLS always applies to it. Policies are created inside the Prisma migrations (`packages/db/prisma/migrations/*`); there is no separate post-migration hook.
- `@harmoniq/db` exposes two clients: `db` (`DATABASE_URL`, the `harmoniq_app` role) and `systemDb` (`SYSTEM_DATABASE_URL`, the owner, which bypasses RLS).
- Tenant work runs in `withTenant(db, workspaceId, fn)`: a transaction that first runs `SELECT set_config('app.current_workspace_id', $1, true)`. The setting is transaction-local, so pooled connections never carry one tenant's context into another request.
- Policies compare `"workspaceId"` with `current_setting('app.current_workspace_id', TRUE)`. Child tables without a `workspaceId` (`Environment`, `DeploymentApproval`) are protected through their RLS-protected parent.
- `systemDb` is used for tenant resolution (workspace by slug, API key by id), creating tenants, authentication, background jobs and instance-admin routes. Organizations have their own scope, `withOrg` (ADR-010).
- Audit tables are append-only for `harmoniq_app` (`REVOKE UPDATE, DELETE`).

**Rationale**:

- Even if application code has a bug (missing `workspaceId` filter), the database will reject cross-tenant reads.
- Provides a security audit trail at the PostgreSQL level.

**Consequences**:

- Slightly higher complexity in Prisma setup (two clients, transaction-scoped tenant context).
- Every new tenant-scoped table needs its policy in the same migration (see `.agents/AGENTS.md` §4); `packages/db/src/__tests__/rls.test.ts` verifies isolation.
- Code using `systemDb` is outside this guarantee and must filter by tenant itself. In routes, every use is marked with its reason (ESLint, MT-09).

---

## ADR-004: pg-boss for Background Jobs

**Status**: Accepted

**Context**: Garbage collection, webhook delivery, and audit event archiving require scheduled background jobs.

**Options Considered**:

1. **BullMQ + Redis** — battle-tested, requires Redis as an additional dependency.
2. **pg-boss** — PostgreSQL-native job queue, no additional infrastructure.
3. **Node.js cron within the app** — simple but not distributed, no retry/visibility.

**Decision**: Use **pg-boss** for all background job scheduling.

**Rationale**:

- Self-hosters already have Postgres; adding Redis solely for job scheduling increases operational complexity.
- `pg-boss` provides job deduplication, retries, exponential backoff, and visibility — all needed features.
- GC operations are infrequent (daily/weekly); Postgres throughput is more than sufficient.
- Redis is still included as the `ICache` adapter for manifest serving; pg-boss avoids making it a **required** dependency for job scheduling.

**Consequences**:

- The registry process runs a `pg-boss` worker alongside the HTTP server.
- Job definitions are co-located in `apps/registry/src/jobs/`.

---

## ADR-005: OpenTelemetry as the ILogger/IAPM Abstraction

**Status**: Accepted

**Context**: The original spec proposed Sentry and DataDog as direct `ILogger` adapter targets.

**Decision**: Adopt **OpenTelemetry (OTel)** as the `ILogger` and metrics abstraction layer. Sentry, DataDog, Grafana, and others are OTel **exporters**, not primary adapters.

**Rationale**:

- One OTel instrumentation → any compatible backend (Sentry, DataDog, Jaeger, Grafana, etc.).
- Self-hosters can use Prometheus + Grafana without any vendor dependency.
- OTel is the industry standard; training new contributors is easier.
- Avoids vendor-specific SDK lock-in in the core codebase.

**Adapters**:

- `ConsoleLogger`: development; human-readable stdout.
- `OTelLogger`: production; emits OTel traces/metrics. Configured via standard OTel env vars (`OTEL_EXPORTER_*`).

---

## ADR-006: ETag + Stale-While-Revalidate Cache Strategy

**Status**: Accepted

**Context**: The manifest endpoint must have minimal latency and support CDN caching, while ensuring clients always receive up-to-date manifests after a deploy.

**Decision**: Use **ETag + `Cache-Control: no-cache`** on manifest responses, combined with a server-side invalidation-on-write pattern.

**Flow**:

1. Registry computes manifest ETag as `SHA-256(JSON.stringify(manifest))`.
2. ETag is stored alongside the manifest in `ICache`.
3. Client sends `If-None-Match: "<etag>"` on subsequent requests.
4. Registry returns `304 Not Modified` if ETag matches — zero body transfer.
5. On any manifest mutation (deploy/rollback/canary), the cache key is synchronously invalidated **before** returning 200 to the writer.

**Rationale**:

- `Cache-Control: no-cache` (not `no-store`) allows clients to cache and revalidate — minimizing network bytes.
- Synchronous cache invalidation ensures no stale manifests are served after a deploy.
- Avoids push/WebSocket complexity for most use cases; optional polling in `@harmoniq/client` covers the live-reload use case.

---

## ADR-007: Argon2id for API Key Hashing

**Status**: Accepted

**Context**: API keys are long-lived credentials used in CI/CD pipelines. If the database is compromised, hashed keys must not be reversible.

**Decision**: Store API keys as **argon2id** hashes (via the `argon2` npm package).

**Rationale**:

- Argon2id is the OWASP-recommended password hashing algorithm as of 2024.
- Memory-hard by design — GPU brute-force attacks are impractical even for high-entropy keys.
- Keys are 32 cryptographically random bytes (256 bits) — brute force is computationally infeasible regardless of algorithm; argon2id is an additional safety layer.

**Key format**: `hq_<base62(32 random bytes)>` — prefix enables easy identification in logs and secret scanning.

---

## ADR-008: Canary Assignment Strategy

**Status**: Accepted

**Context**: Canary releases require deterministic, per-user assignment to ensure consistent UX (a user doesn't flip between canary and stable on every request).

**Decision**: Server-side sticky canary assignment using a **deterministic hash** of the `X-Harmoniq-User-Id` request header.

**Flow**:

1. Client sends `X-Harmoniq-User-Id: <user-id>` header (set by the host shell).
2. Registry computes `hash(workspaceSlug + env + moduleName + userId) % 100`.
3. If `hash % 100 < trafficPercent`, the user is in the canary cohort.
4. If the header is absent, a random UUID is assigned and returned as a `harmoniq_canary` cookie (30-day TTL, `SameSite=Lax`).
5. On subsequent requests, the cookie value is used as the user ID for hashing.

**Rationale**:

- Pure client-side `Math.random()` is not repeatable — the same user gets different versions on different requests.
- Deterministic hash assignment is consistent across multiple registry instances without shared state.
- Cookie fallback handles unauthenticated host applications.

---

## ADR-009: jose for JWT Verification

**Status**: Accepted

**Context**: JWT verification must work in both Node.js (registry API) and the Next.js Edge Runtime (dashboard middleware).

**Decision**: Use **`jose`** for all JWT operations.

**Rationale**:

- `jose` is a Web Crypto API-based library — fully compatible with the Edge Runtime.
- Native Node.js `crypto` module is not available in the Edge Runtime.
- `jose` is actively maintained and audited.
- `jsonwebtoken` (the common alternative) uses Node.js `crypto` and cannot run in Edge contexts.

---

## ADR-010: Organization-Scoped Row-Level Security

**Status**: Accepted, implemented 2026-10-11 (Phase 9.1, MT-07–MT-10; migration `20261011130000_org_rls`)

**Context**: Organizations sit above workspace isolation. Organization routes and services read with `systemDb` and authorize against `OrganizationMember` themselves, and cross-workspace views (org home, catalog, org audit) query many workspaces at once. A single missing `organizationId` filter would leak another organization's data, and the database would not stop it. `routes/orgs.ts` alone uses the system client in 46 places.

**Options Considered**:

1. **Keep application filters only**: no change, so the risk remains.
2. **Org RLS with a per-row lookup function** (`workspace_in_current_org(workspaceId)`): flexible, but runs a subquery per row on large tables.
3. **Org RLS with transaction-local settings**: `app.current_org_id` for org tables, plus `app.current_org_workspace_ids` (the org's workspace ids) admitted by workspace-scoped policies.

**Decision**: Option 3. A `withOrg(orgId, fn)` helper sets `app.current_org_id`, then resolves the org's workspace ids inside the same transaction (the `Workspace` policy admits rows whose `organizationId` is the current organization) and sets `app.current_org_workspace_ids`, both with `set_config(..., true)`. Organization routes run as `harmoniq_app` inside `withOrg`. A lint rule restricts `systemDb` in route handlers to an allow-list.

**Rationale**:

- It gives the same guarantee as ADR-003 for organization data: a forgotten filter returns nothing extra.
- An array membership check is cheap and works with the existing `workspaceId` indexes. Organizations have tens to hundreds of workspaces, which fits easily in a setting.

**Consequences**:

- Every workspace-scoped policy is rewritten once (one migration).
- The org's workspace list is resolved at the start of each org transaction. A workspace attached or detached during that transaction becomes visible on the next request.
- An isolation test suite with two organizations covers every org and workspace read endpoint (MT-10).

---

## ADR-011: Tenant Soft Delete, Purge and Audit Retention

**Status**: Accepted, implemented 2026-10-11 (Phase 9.2): soft delete and restore for workspaces and organizations, the hourly `tenant.purge` job, audit trails without foreign keys, retention GC and the instance-admin export.

**Context**: Deleting a workspace is a hard delete today. Audit, SCIM audit and approval rows cascade away with it, which breaks compliance retention. Bundles (instance storage and the workspace's own bucket) and published manifest copies stay in storage, and the purge GC can't find them once the version rows are gone. Deletion also can't be undone.

**Decision**:

- Deleting a workspace or organization sets `deletedAt` and `purgeAfter` (`HARMONIQ_TENANT_RESTORE_DAYS`, default 30). Writes answer `410`, manifests answer `410 Gone`, the slug stays reserved, and restore is possible until purge.
- A `tenant.purge` pg-boss job deletes objects first (from version `storagePath` + `storageBackend` and environment published paths), then rows. It is idempotent.
- Audit tables keep tenant ids without cascading foreign keys. Audit rows outlive the tenant for `HARMONIQ_AUDIT_RETENTION_DAYS` (default 400).

**Rationale**:

- Deleting objects before rows means a failed purge is simply retried; nothing becomes unreachable.
- Keeping audit rows by id needs no copy or archive store, and RLS keys on the column, so isolation is unchanged.

**Consequences**:

- Every query that lists workspaces must exclude `deletedAt` (or rely on a view or a Prisma extension).
- Hosted operators that need immediate erasure set `HARMONIQ_TENANT_RESTORE_DAYS=0`.
- The purge collects the object keys, deletes the rows, then the objects (best effort, from the workspace's bucket and the instance storage). Failures are counted in the `instance.workspace_purged` event and logged; they are not retried, because the rows that named the objects are gone.

---

## ADR-012: Usage Metering with Buffered Counters

**Status**: Proposed (Phase 9.6, USG-01–USG-04, PLN-04/05)

**Context**: Quotas and usage pages need per-workspace counts of manifest requests, deploys, health events and storage. The manifest endpoint is the hot path (cache hits, 304s, NFR p99 targets) and can't wait on a database write per request.

**Options Considered**:

1. **One row per request**: exact, but write amplification on the hot path.
2. **Redis counters (`INCRBY`) flushed by a job**: shared across replicas, but needs Redis, and Redis is optional (`ICache` can be in-memory).
3. **Per-replica in-memory counters flushed every 60 s** with an additive upsert into `UsageDaily`.

**Decision**: Option 3 for request-path counters. Deploys are counted in their transaction. Storage, members and keys come from a nightly snapshot plus `ModuleVersion.sizeBytes` recorded at deploy.

**Rationale**: No new infrastructure and no work on the hot path. Additive upserts are safe across replicas.

**Consequences**: A crashed replica loses up to a minute of request counts. That is acceptable for usage display and soft quotas; hard quotas apply only to counts kept in the database (resources, deploys).

---

## ADR-013: Encryption Keyring for Sealed Secrets

**Status**: Proposed (Phase 9.9, INST-26)

**Context**: `HARMONIQ_ENCRYPTION_KEY` seals SSO client secrets, workspace bucket credentials, IdP refresh tokens and instance-setting secrets (AES-256-GCM, `services/crypto.ts`). Envelopes don't record which key sealed them, so the key can't be rotated: changing it makes every sealed value unreadable. Security policies usually require rotation and immediate replacement after a suspected leak.

**Options Considered**:

1. **A KMS envelope per value** (AWS KMS, GCP KMS, Azure Key Vault): strongest, but adds a cloud dependency the self-hosted default can't assume.
2. **A local keyring with key ids**: `HARMONIQ_ENCRYPTION_KEYS=id:key,…`, where the first key seals and any listed key opens.

**Decision**: Option 2, with the key source behind a small interface so a KMS-backed keyring can be added later.

**Rationale**: Works for every deployment today. Rotation becomes: add a key in front, deploy, run `secrets.reseal`, remove the old key.

**Consequences**: Envelopes gain a `kid` field; values without one are read with the legacy key. Health reports how many values are still sealed with a non-active key.
