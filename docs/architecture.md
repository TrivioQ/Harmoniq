# Harmoniq — Architecture Decision Records

> **Version**: 1.0.0  
> **Last Updated**: 2026-09-13

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

**Implementation**:
- Prisma uses a dedicated connection role (`harmoniq_app`) with RLS enforced.
- At the start of each request, a `SET LOCAL app.current_workspace_id = $1` statement sets the session variable.
- RLS policies read `current_setting('app.current_workspace_id')` to filter rows automatically.
- Prisma migrations include `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and policy creation SQL (via `prisma.schema` `///` annotations and a post-migration hook).

**Rationale**:
- Even if application code has a bug (missing `workspaceId` filter), the database will reject cross-tenant reads.
- Provides a security audit trail at the PostgreSQL level.

**Consequences**:
- Slightly higher complexity in Prisma setup (custom connection management).
- RLS policies must be kept in sync with schema migrations. This is enforced by the `db:migrate` script.

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
