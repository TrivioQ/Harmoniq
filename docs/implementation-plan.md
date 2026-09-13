# Harmoniq — Implementation Plan

> **Version**: 1.0.0  
> **Last Updated**: 2026-09-13  
> **Package Manager**: pnpm v9+

---

## Overview

This document breaks the Harmoniq build into six sequential phases. Each phase delivers a shippable, testable increment. Every single feature implemented in any phase MUST include corresponding automated test cases (unit, integration, or E2E) covering happy paths, edge cases, and security boundaries. Phases 1–3 form the **Minimum Viable Product (MVP)**; Phases 4–6 deliver production-grade features.

---

## Phase 0 — Repository & Tooling Bootstrap

**Goal**: Establish the monorepo skeleton, tooling standards, and shared configuration so all subsequent phases have a consistent foundation.

### Tasks

- [ ] Initialize git repository with `.gitignore`, `LICENSE` (Apache 2.0), `README.md`
- [ ] Set up pnpm workspace: `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`
- [ ] Configure root `package.json` with `engines: { pnpm: ">=9", node: ">=20" }` and `preinstall` guard script
- [ ] Install and configure **Turborepo**: `turbo.json` with `build`, `dev`, `test`, `lint` pipeline
- [ ] Create `packages/tsconfig/` with shared `base.json`, `nextjs.json`, `node.json`
- [ ] Set up **ESLint** (flat config) and **Prettier** at root; extend per-package
- [ ] Set up **Vitest** as the test runner (workspace config)
- [ ] Create `docker/docker-compose.yml` with services: `postgres`, `redis`, `registry`, `web`
- [ ] Create `.env.example` with all required variables
- [ ] Set up **Changesets** for changelog management
- [ ] Create `docs/` directory with initial documentation files
- [ ] Create `.agents/AGENTS.md` with change-documentation rules (see Rules section)
- [ ] Create `docs/features/` directory for per-feature docs (with change history)

### Deliverables

- Runnable monorepo: `pnpm install` succeeds
- `pnpm run docker:up` starts Postgres + Redis
- Linting and type-check pass

---

## Phase 1 — Database & Core Package

**Goal**: Establish the Prisma schema, RLS policies, and all shared port interfaces.

### Package: `packages/db` (`@harmoniq/db`)

- [ ] Install: `prisma`, `@prisma/client`
- [ ] Define Prisma schema with all models:
  - `User`, `Workspace`, `WorkspaceMember`
  - `HostApp`, `Environment`
  - `RemoteModule`, `ModuleVersion`
  - `ApiKey`, `RefreshToken`
  - `WebhookEndpoint`, `WebhookDelivery`, `WebhookDeadLetter` (WHK-07)
  - `AuditEvent`
  - `WorkspaceConfig` (JSON blob per plugin type + OIDC/SAML/SCIM config)
  - `ModuleOwnership` (RBAC-01)
  - `AlertRule` (ALT-01)
  - `ManifestSnapshot` (SNAP-01)
  - `ModuleHealthEvent` (HLT-01)
  - `ScimAuditEvent` (SSO-28)
  - `Organization`, `OrganizationMember` (ORG-01)
  - `ApprovalPolicy` (APR-01)
  - `DeploymentRequest`, `DeploymentApproval` (APR-04)
  - `InstanceConfig`, `InstanceAdmin` (INST-05, INST-15)
  - `WorkspaceStorageConfig` (BYOB-03)
- [ ] Add `workspaceId` FK and `@@index([workspaceId])` to all tenant-scoped models
- [ ] Write Prisma migration: base schema
- [ ] Write post-migration SQL hook to enable RLS on all tenant tables
- [ ] Write RLS policies (USING clause reads `current_setting('app.current_workspace_id')`)
- [ ] Create dedicated DB role `harmoniq_app` with BYPASSRLS denied
- [ ] Write Prisma middleware to inject `SET LOCAL app.current_workspace_id` on each query
- [ ] Write `seed.ts`: demo workspace, two environments (staging/production), sample modules
- [ ] Add scripts: `db:migrate`, `db:studio`, `db:seed`, `db:reset`

### Package: `packages/core` (`@harmoniq/core`)

- [ ] Define port interfaces: `ICache`, `IStorage`, `ILogger`, `OAuthPlugin`
- [ ] Define all shared DTOs and Zod schemas:
  - `ManifestSchema` (v1)
  - `DeployRequestSchema`
  - `RollbackRequestSchema`
  - `CanaryConfigSchema`
  - `ApiKeyCreateSchema`
  - `WebhookEventSchema`
- [ ] Define `AppError` hierarchy (typed error classes)
- [ ] Export shared TypeScript types for manifest, module version, audit event, etc.
- [ ] Write unit test suite for all `@harmoniq/core` Zod schemas, DTOs, and AppErrors (>90% coverage)
- [ ] Write unit test suite for `@harmoniq/db` Prisma middleware and RLS policy hooks

### Deliverables

- `pnpm db:migrate` applies schema with RLS enabled
- `pnpm db:seed` populates demo data
- All port interfaces exported from `@harmoniq/core`
- Unit tests for Zod schemas, DTOs, middleware, and RLS policies (>90% coverage)

---

## Phase 2 — Registry Core (Manifest API)

**Goal**: Ship the manifest-serving endpoint — the heart of Harmoniq.

### App: `apps/registry`

#### Infrastructure Setup

- [ ] Initialize Fastify app with `fastify-plugin` architecture
- [ ] Register plugins: `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`
- [ ] Set up OTel instrumentation: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
- [ ] Implement `ICache` adapters:
  - `RedisCache` using `ioredis`
  - `InMemoryLRUCache` using `lru-cache`
- [ ] Implement `ILogger` adapters:
  - `ConsoleLogger` (pino-based, pretty in dev)
  - `OTelLogger` (production, exports via OTLP)
- [ ] Wire dependency injection: service container that resolves adapters from env config

#### Manifest Endpoint

- [ ] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env` (HST-01 — canonical)
  - Validate workspace slug, hostApp slug, env exist
  - Check `ICache` for cached manifest
  - On cache miss: query DB, build manifest JSON (schemaVersion 2, hostApp field), compute ETag, write to cache
  - Support `If-None-Match` → `304 Not Modified`
  - On DB failure: return stale cache with `X-Harmoniq-Stale: true` header
  - Return manifest with `ETag`, `Cache-Control: no-cache`, `X-Harmoniq-Variant`, `X-Harmoniq-Cohort-Id` headers (CAN-08)
- [ ] `GET /api/manifest/:workspaceSlug/:env` (HST-02 — legacy, resolves to isDefault HostApp)
- [ ] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env` — canary variant
  - Implement sticky assignment (hash `X-Harmoniq-User-Id` or set `harmoniq_canary` cookie)
  - Return canary manifest (variant: "canary") or stable manifest (variant: "stable")
- [ ] `GET /api/importmap/:workspaceSlug/:hostAppSlug/:env` (IMP-01)
  - Build Import Map JSON from active module versions
  - ETag + If-None-Match support
- [ ] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots` (SNAP-02)
- [ ] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots/:id` (SNAP-03)
- [ ] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/diff` (DIFF-01)
- [ ] Rate limiting: token-bucket on all manifest + importmap endpoints (RL-01)
- [ ] `GET /api/modules/:moduleId/health` — 5-min rolling aggregation (HLT-02)

#### Auth Middleware

- [ ] API key extraction from `Authorization: Bearer hq_...` header
- [ ] Argon2id hash verification against DB
- [ ] Scope enforcement middleware (decorates route with required scope)
- [ ] Rate limiting on auth routes: 10 req/min per IP

#### Deploy & Version Management Routes

- [ ] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/deploy`
  - Support `dryRun: true` mode — validate only, no commit (VAL-02)
  - Validate `DeployRequestSchema` (includes `dependencies`, `exposes`)
  - Dependency compatibility check against active modules (DEP-02)
  - Insert new `ModuleVersion` (status: `active`)
  - Atomically set all other versions for module+env to `inactive`
  - Invalidate cache keys: manifest + importmap (IMP-06)
  - Create `ManifestSnapshot` (SNAP-01)
  - Create `AuditEvent`
  - Return new version record
- [ ] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/rollback`
  - Transaction: set target version to `active`, current `active` to `inactive`
  - Invalidate cache + importmap
  - Create `ManifestSnapshot` + `AuditEvent`
- [ ] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/promote` (PRO-01)
  - Check target env freeze (PRO-03)
  - Copy version to target env atomically
  - Invalidate target-env cache + importmap
  - Create `ManifestSnapshot` + `AuditEvent` with `action: 'module.promote'`
- [ ] `PUT /api/workspaces/:workspaceSlug/modules/:moduleId/canary`
  - Support `rolloutSchedule` (STG-01)
  - Invalidate canary cache key
  - Create `ManifestSnapshot` + `AuditEvent`
- [ ] Env freeze enforcement middleware: reject mutating ops with `423` on frozen envs (ENV-FRZ-02)
- [ ] Module RBAC middleware: enforce module ownership on deploy/rollback/promote/canary (RBAC-02)

#### Health & Metrics

- [ ] `GET /health` — always 200
- [ ] `GET /ready` — check DB connection + cache connection; 503 on failure
- [ ] `GET /metrics` — Prometheus text format

#### Test Suite

- [ ] Integration test suite for manifest endpoints (`GET /api/manifest/...`), ETag caching (304), stale fallback, and canary assignments
- [ ] Integration test suite for deploy, rollback, promote, and canary management API endpoints
- [ ] Unit & integration test suite for auth middleware (API key argon2id validation, scopes, rate limiting) and env freeze / RBAC middleware

### Deliverables

- Registry serving manifests with ETag support
- Cache hit path under 50ms (benchmark with `autocannon`)
- All routes returning correct 304 on unchanged manifests
- Integration tests for deploy → manifest → rollback flow (>80% coverage)

---

## Phase 3 — Dashboard (Next.js Web App)

**Goal**: Ship the developer control plane UI.

### App: `apps/web`

#### Foundation

- [ ] Initialize Next.js app (App Router, TypeScript strict mode)
- [ ] Install: `tailwindcss`, `@shadcn/ui`, `lucide-react`
- [ ] Configure Tailwind with custom Harmoniq design tokens
- [ ] Set up Next.js middleware for Edge-compatible JWT verification (`jose`)
- [ ] Configure `HttpOnly` + `Secure` + `SameSite=Lax` session cookies
- [ ] Set up route groups: `(auth)`, `(dashboard)`

#### Authentication Flow

- [ ] `GET /auth/login` — OAuth provider selection page
- [ ] `GET /auth/[provider]/callback` — exchange code, create session
  - Plug in `OAuthPlugin` adapter (GitHub or Google based on env config)
  - Create or update `User` record
  - Issue JWT access token (15min) + opaque refresh token
  - Set cookies
- [ ] `POST /auth/refresh` — verify refresh token, rotate, issue new access token
- [ ] `POST /auth/logout` — revoke refresh token, clear cookies
- [ ] Edge middleware: verify JWT on all `(dashboard)` routes; redirect to `/auth/login` on failure

#### Dashboard Pages

- [ ] **Workspace Selector** (`/`) — list user's workspaces, create new workspace
- [ ] **Overview** (`/[workspaceSlug]/`) — active modules count, recent deploys, environment status
- [ ] **Modules** (`/[workspaceSlug]/modules`) — list all modules with active versions per env + health sparklines (HLT-04)
- [ ] **Module Detail** (`/[workspaceSlug]/modules/[moduleId]`)
  - Deployment history table (all versions, statuses, deployed by, timestamps)
  - One-click rollback
  - One-click **Promote to Production** (PRO-05)
  - Canary setup UI (version selector, traffic % slider, rollout schedule editor)
  - Module Owners tab (RBAC-05)
  - Side-by-side manifest diff view (DIFF-03)
- [ ] **Environments** (`/[workspaceSlug]/environments`) — CRUD environments, freeze/unfreeze (ENV-FRZ-05), scheduled freeze windows
- [ ] **Dependency Matrix** (`/[workspaceSlug]/environments/[envId]/deps`) — per-env dependency grid (DEP-04)
- [ ] **API Keys** (`/[workspaceSlug]/settings/keys`) — create, revoke, rotate, module-scope restriction (RBAC-04)
- [ ] **Members** (`/[workspaceSlug]/settings/members`) — invite, role assignment, module ownership
- [ ] **Webhooks** (`/[workspaceSlug]/settings/webhooks`) — create, delivery log, **Dead Letter Queue** with Retry Now (WHK-08)
- [ ] **Audit Log** (`/[workspaceSlug]/settings/audit`) — filterable table (actor, action, date range)
- [ ] **SSO Settings** (`/[workspaceSlug]/settings/sso`) — OIDC config, SAML Setup Wizard (SSO-19), Test Connection (SSO-20), domain allowlist, forced SSO toggle
- [ ] **Alert Rules** (`/[workspaceSlug]/settings/alerts`) — create/edit alert rules (ALT-01)
- [ ] **API Explorer** (`/docs/api`) — embedded Scalar UI (OAS-04)
- [ ] **Quickstart Wizard** — first-time workspace onboarding (DX-04)
- [ ] **Workspace Settings** (`/[workspaceSlug]/settings`) — storage config, retention policy, danger zone

#### Test Suite

- [ ] Unit & component test suite for authentication hooks, Edge middleware, and JWT validation
- [ ] Integration test suite for dashboard UI components, forms, and API route handlers

### Deliverables

- Fully navigable dashboard
- Auth flow with GitHub OAuth (Google optional at this phase)
- All CRUD operations functional
- Responsive layout (mobile-friendly)
- Component & integration test coverage for all dashboard pages

---

## Phase 4 — SDK & CLI

**Goal**: Ship the developer tools for consuming Harmoniq in host shells and CI/CD pipelines.

### Package: `packages/client` (`@harmoniq/client`)

- [ ] `HarmoniqClient` class (options: `registryUrl`, `workspaceSlug`, `hostApp`, `environment`)
- [ ] Manifest fetch v2 with `If-None-Match` ETag support
- [ ] Stale-while-revalidate caching
- [ ] Fallback to last-known-good manifest on network failure
- [ ] Exponential backoff retry
- [ ] Optional polling (`pollIntervalMs`)
- [ ] `onManifestUpdate(callback)` event emitter
- [ ] `manifest.getModuleUrl(name)` helper (existing)
- [ ] `manifest.getModuleEntry(name)` → `{ url, integrity }` (SRI-01)
- [ ] `manifest.getScriptTag(name)` → HTML `<script>` string (SRI-02)
- [ ] `manifest.variant` + `manifest.cohortId` fields (CAN-09)
- [ ] `client.on('variantAssigned', ...)` event (CAN-10)
- [ ] `client.reportModuleLoad(name, { success, loadMs, variant })` (HLT-01)
- [ ] `client.reportModuleError(name, { error, variant })` (HLT-01)
- [ ] Framework adapters: `@harmoniq/client/react`, `/angular`, `/vue` (ADP-01-04)
- [ ] **Zero runtime dependencies**
- [ ] Full JSDoc + TypeDoc documentation
- [ ] Unit tests (Vitest + `msw` for mock server)
- [ ] Build: ESM + CJS + type declarations (via `tsup`)

### Package: `packages/cli` (`@harmoniq/cli`)

> CI/CD-only interface. Dashboard handles all management operations.

- [ ] CLI framework: `commander` + `ora` (spinners) + `chalk` (colors)
- [ ] `harmoniq login` — prompt API key, validate, store in `~/.harmoniq/config.json`
- [ ] `harmoniq whoami` — display current auth context
- [ ] `harmoniq deploy` — POST to registry deploy endpoint (with `--force` flag for dep bypass, DEP-03)
- [ ] `harmoniq rollback` — POST rollback with version selection
- [ ] `harmoniq promote` — POST promote (PRO-04)
- [ ] `harmoniq validate` — validate bundle URL + integrity + deps before deploying (VAL-01)
- [ ] `harmoniq canary promote` — promote canary to active
- [ ] `harmoniq canary set-traffic` — update traffic percentage
- [ ] `harmoniq manifest get --json` — fetch manifest (machine-readable output)
- [ ] Support `--json` flag on all commands for CI/CD machine-readable output
- [ ] Support `--profile` flag for multiple workspace configs
- [ ] Unit & integration test suite covering all CLI commands (login, deploy, rollback, promote, validate, canary)
- [ ] Build: distributed as `npx harmoniq`

### Deliverables

- `npm install @harmoniq/client` works
- `npx harmoniq deploy ...` works end-to-end against a running registry
- 100% of client public API and CLI commands covered by unit & integration tests

---

## Phase 5 — Garbage Collection & Webhooks

**Goal**: Implement background data lifecycle management and webhook delivery.

### Background Jobs (in `apps/registry`)

- [ ] Initialize `pg-boss` client, connect to Postgres
- [ ] Define job types: `gc.softDelete`, `gc.hardDelete`, `gc.orphanScan`, `webhook.deliver`

#### GC Jobs

- [ ] `gc.softDelete` (daily cron) — soft-delete `inactive` `ModuleVersion` + `ManifestSnapshot` records older than `retentionDays`
- [ ] `gc.hardDelete` (weekly cron) — hard-delete soft-deleted records, purge `IStorage`
- [ ] `gc.orphanScan` (weekly cron) — flag storage objects with no DB record
- [ ] `gc.healthEventPurge` (daily cron) — hard-delete `ModuleHealthEvent` records older than 24h

#### Webhook Delivery

- [ ] `webhook.deliver` job: configurable retries (WHK-03), exponential backoff up to `backoffCeilingMs` (WHK-06)
- [ ] On retry exhaustion: write `WebhookDeadLetter` record (WHK-07)
- [ ] `POST /api/webhooks/deliveries/:deliveryId/retry` — re-enqueue dead-lettered delivery (WHK-09)

#### Alert & Staged Rollout Jobs

- [ ] `alert.evaluate` (60s cron) — evaluate all enabled `AlertRule` conditions against health metrics (ALT-05)
- [ ] `rollout.advance` (scheduled) — advance staged rollout bands automatically (STG-02)
- [ ] `alert.auto_rollback` — triggered by failed alert condition during staged rollout (STG-04)

### Deliverables

- GC jobs registered and running on schedule
- Webhook delivery with signing and retry logging
- GC integration tests (with test DB, verify soft-delete and hard-delete)

---

## Phase 6 — Hardening, Observability & Documentation

**Goal**: Production readiness — security, performance, and documentation.

### Security Hardening

- [ ] Dependency audit: `pnpm audit` — resolve all high/critical
- [ ] Add `helmet` CSP headers to both apps
- [ ] Add `@fastify/rate-limit` to all write endpoints
- [ ] Validate all request bodies with Zod on every route
- [ ] Add CSRF protection to Next.js dashboard mutations (double-submit cookie pattern)
- [ ] Pen-test: verify RLS prevents cross-tenant access with integration tests

### SSO — OIDC Plugin

- [ ] Implement `OIDCPlugin`: auth code + PKCE flow, JWKS token validation, silent refresh (SSO-01 to SSO-08)
- [ ] Dashboard: OIDC configuration UI, domain allowlist, claim-to-role mapping (SSO-03, SSO-07)

### SSO — SAML 2.0 Plugin

- [ ] Implement `SAMLPlugin` using `node-saml`: SP-initiated + IdP-initiated flows (SSO-09)
- [ ] ACS endpoint `POST /auth/saml/:workspaceSlug/acs` (SSO-10)
- [ ] SP Metadata endpoint `GET /auth/saml/:workspaceSlug/metadata` (SSO-11)
- [ ] SP-Initiated redirect `GET /auth/saml/:workspaceSlug/login` (SSO-12)
- [ ] SLO endpoints (SSO-13)
- [ ] SAML Response full validation (SSO-14)
- [ ] Per-workspace SP signing key pair generation + encrypted storage (SSO-18)
- [ ] Dashboard: SAML Setup Wizard for Okta, Azure AD, ADFS (SSO-19)
- [ ] Dashboard: Test Connection button (SSO-20)
- [ ] SCIM 2.0 endpoint `/scim/v2` for Okta/Azure AD push provisioning (SSO-24)
- [ ] Forced SSO enforcement (SSO-26)
- [ ] JIT provisioning + domain auto-join (SSO-21, SSO-22)
- [ ] Group-to-role mapping (SSO-23)

### Performance

- [ ] Benchmark manifest endpoint with `autocannon`: verify p99 < 50ms on cache hit
- [ ] Profile and optimize DB queries (add indexes if needed)
- [ ] Enable HTTP/2 on registry

### Observability

- [ ] OTel traces on all critical paths: manifest fetch, deploy, rollback, GC jobs
- [ ] Add custom metrics: `harmoniq.manifest.cache_hits`, `harmoniq.manifest.cache_misses`, `harmoniq.deploy.count`
- [ ] Wire Prometheus `/metrics` to Grafana dashboard (example `docker/grafana/`)
- [ ] Structured logging: all logs include `workspaceId`, `requestId`, `duration`

### Documentation

- [ ] `README.md`: quick-start guide with Docker Compose (5-minute setup)
- [ ] `docs/self-hosting.md`: full self-hosting guide (env vars, Docker, reverse proxy)
- [ ] `docs/sdk.md`: `@harmoniq/client` usage guide
- [ ] `docs/cli.md`: `@harmoniq/cli` command reference
- [ ] `docs/api-reference.md`: full REST API reference (auto-generated from Fastify + `@fastify/swagger`)
- [ ] `docs/contributing.md`: contribution guide (Conventional Commits, PR checklist, change-doc rule)
- [ ] OpenAPI spec: auto-generated and committed to `docs/openapi.json`

### Final Checklist

- [ ] All phases' integration tests passing in CI
- [ ] `pnpm run docker:up` → 5-minute demo working end-to-end
- [ ] Apache 2.0 license headers on all source files
- [ ] GitHub Actions CI: lint + type-check + test on every PR
- [ ] GitHub Actions release: changesets → npm publish on merge to main

---

## Phase 7 — Scale, Polish & Community

**Goal**: Cross-stack adoption, community enablement, and operational polish.

### Framework Adapters

- [ ] `@harmoniq/client/react` — `<HarmoniqProvider>` + `useRemoteModule()` hook (ADP-02)
- [ ] `@harmoniq/client/angular` — `HarmoniqService` injectable (ADP-03)
- [ ] `@harmoniq/client/vue` — `useHarmoniq()` composable (ADP-04)

### OpenAPI & Community Clients

- [ ] Auto-generate `docs/openapi.json` from `@fastify/swagger` (OAS-01)
- [ ] Embed Scalar API Explorer at `/docs/api` (OAS-04)
- [ ] Community-track: `harmoniq-go` + `harmoniq-python` thin clients from OpenAPI spec (OAS-03)

### Local Dev Mode

- [ ] `pnpm run dev:local` — in-memory registry, no Docker, no Postgres (DX-02)
- [ ] `?pretty=true` on manifest endpoint for development (DX-03)

### Kubernetes Helm Chart (community target)

- [ ] `charts/harmoniq/` — Helm chart with configurable replica count, ingress, secrets

### Deliverables

- Framework adapters published and documented
- OpenAPI spec committed and Scalar UI live
- `pnpm run dev:local` works end-to-end

### 7.4 Instance Admin UI (INST-01–18)

#### Database

- [ ] Add `InstanceConfig` model: `key` (unique), `value` (Json, encrypted at rest), `updatedAt`, `updatedBy`
- [ ] Add `InstanceAdmin` model: `userId` (unique FK), `grantedBy`, `createdAt`, `revokedAt`
- [ ] Prisma migration: instance tables (NOT RLS-scoped — instance-wide)

#### Registry — Admin API

- [ ] Admin auth middleware: extract session, verify `InstanceAdmin` record is active. Reject all `/admin/*` routes for non-admin sessions — even workspace `owner` (INST-06)
- [ ] `GET /admin/api/health` — DB ping, Redis ping, storage adapter ping, `pg-boss` queue depth, active job count (INST-08)
- [ ] `GET /admin/api/workspaces` — all workspaces with usage metrics
- [ ] `POST /admin/api/workspaces/:id/suspend` and `/unsuspend` (INST-09)
- [ ] `DELETE /admin/api/workspaces/:id` — hard delete
- [ ] `GET /admin/api/users` — all users with workspace memberships + last login
- [ ] `POST /admin/api/users/:id/revoke-sessions` (INST-10)
- [ ] `DELETE /admin/api/users/:id` — hard delete
- [ ] `GET /admin/api/config` — return all `InstanceConfig` keys with values **redacted** for sensitive keys
- [ ] `PUT /admin/api/config/:key` — update a config value (encrypt sensitive keys before storing)
- [ ] `POST /admin/api/config/storage/test` — connectivity test for the configured default storage adapter
- [ ] `POST /admin/api/config/smtp/test` — send test email to authenticated admin (INST-12)
- [ ] Hot-reload: `pg-boss` cron `config.reload` (60s interval) refreshes registry's in-memory config snapshot from `InstanceConfig` (INST-17)
- [ ] `GET /admin/setup` — serve setup wizard (only when no active `InstanceAdmin` exists)
- [ ] `POST /admin/setup` — consume `HARMONIQ_SETUP_TOKEN`, create first admin user, set initial `InstanceConfig` values (INST-01–INST-04)
- [ ] Emit `AuditEvent` (`action: 'instance.config_updated'`, key only, no plaintext value) on every config change (INST-18)

#### Dashboard — Admin Panel Pages

- [ ] `/admin/setup` — 4-step first-boot wizard: account → connectivity → storage → OAuth (INST-03)
- [ ] `/admin/health` — system health indicators with live-refresh
- [ ] `/admin/workspaces` — workspace list with usage, suspend/unsuspend/delete actions
- [ ] `/admin/users` — user directory, revoke sessions, delete user
- [ ] `/admin/storage` — adapter selector + credential form + Test Connection button (INST-11)
- [ ] `/admin/email` — SMTP config form + Send Test Email button (INST-12)
- [ ] `/admin/auth` — enable/disable OAuth providers globally (INST-13)
- [ ] `/admin/branding` — name, logo, support URL, accent colour (INST-14)
- [ ] `/admin/admins` — grant/revoke `InstanceAdmin` role (INST-07)
- [ ] Admin nav sidebar: entirely separate from workspace nav; appears only for `InstanceAdmin` sessions

#### Test Suite

- [ ] Unit tests: admin auth middleware (verify non-admin workspace sessions are rejected, including `owner` role)
- [ ] Unit tests: config hot-reload (mock `InstanceConfig` update, verify in-memory snapshot refreshes)
- [ ] Integration tests: setup wizard flow (token consumption, duplicate call rejected, first admin created)
- [ ] Integration tests: all `/admin/api/*` endpoints with admin session and with non-admin session (must return 403)

---

### 7.5 Bring-Your-Own-Bucket Storage (BYOB-01–14)

#### Database

- [ ] Add `WorkspaceStorageConfig` model: `workspaceId` (unique FK), `provider`, `bucket`, `region`, `credentialsEncrypted` (Json), `cdnPrefix?`, `pathPrefix?`, `lastVerifiedAt?`, `createdAt`, `updatedAt`
- [ ] Prisma migration: `WorkspaceStorageConfig` table with RLS

#### Registry — Storage Adapter Resolution

- [ ] Implement storage adapter resolver: check `WorkspaceStorageConfig` first → fall back to `InstanceConfig["storage.adapter"]` → fall back to `STORAGE_ADAPTER` env var (BYOB-07 + INST-16)
- [ ] Implement `S3StorageAdapter`, `GCSStorageAdapter`, `AzureBlobStorageAdapter` implementing the `IStorage` port interface
- [ ] Canary verification utility: write a 1-byte probe object, read it back, delete it. Return `{ success, latencyMs, error? }` (BYOB-04)
- [ ] At deploy-time: if BYOB adapter fails, return `503` and DO NOT fall back to instance storage (BYOB-09)
- [ ] `POST /api/workspaces/:slug/storage` — save BYOB config: run canary cycle before committing, return `400` with diagnostic on failure (BYOB-04)
- [ ] `DELETE /api/workspaces/:slug/storage` — remove BYOB config (revert to instance default)
- [ ] `POST /api/workspaces/:slug/storage/test` — on-demand canary cycle without saving (BYOB-05)
- [ ] `GET /api/workspaces/:slug/storage` — return config with credentials **redacted** (provider, bucket, region, cdnPrefix, lastVerifiedAt only)
- [ ] Deploy route: resolve workspace storage adapter; log `storageRegion` in `AuditEvent` metadata (BYOB-14)
- [ ] CLI warning: compare `--url` against `WorkspaceStorageConfig.cdnPrefix`; emit `warning` to stderr if prefix mismatch (BYOB-10)

#### Dashboard — Workspace Storage Settings Page

- [ ] `Workspace Settings → Storage` page: BYOB provider selector, credential form (S3/GCS/Azure fields), CDN prefix, path prefix
- [ ] Test Connection button (BYOB-05): calls `/storage/test`, displays latency or error message
- [ ] Migration advisory banner shown when BYOB is first enabled (BYOB-12)
- [ ] Plan gate: storage page shows upgrade prompt for `hobby` plan (BYOB-01)

#### Test Suite

- [ ] Unit tests: storage adapter resolver (BYOB config present, absent, instance config fallback, env var fallback)
- [ ] Unit tests: canary verification utility (success path, write failure, read failure, delete failure)
- [ ] Unit tests: fail-closed behavior — BYOB adapter 503, verify NO fallback to instance storage (BYOB-09)
- [ ] Integration tests: BYOB config save → canary cycle → deploy writes to workspace bucket → manifest reflects workspace CDN prefix
- [ ] Integration tests: credentials-invalid save returns 400 with diagnostic

---

## Technology Decisions Summary

| Concern                | Choice                   | Rationale                                 |
| ---------------------- | ------------------------ | ----------------------------------------- |
| Package manager        | pnpm v9+                 | Workspace support, speed, strictness      |
| Monorepo orchestration | Turborepo                | Incremental builds, remote cache          |
| Dashboard framework    | Next.js (App Router)     | RSC, Edge middleware, Vercel-deployable   |
| Registry framework     | Fastify                  | High throughput, JSON serialization speed |
| UI components          | Shadcn UI + Tailwind CSS | Unstyled primitives, full ownership       |
| Database               | PostgreSQL               | Relational integrity, RLS, pg-boss        |
| ORM                    | Prisma                   | Type-safe, migration management           |
| Job queue              | pg-boss                  | No extra infrastructure (uses Postgres)   |
| Cache                  | Redis (ICache)           | High-throughput manifest serving          |
| JWT                    | jose                     | Edge Runtime compatible                   |
| API key hashing        | argon2id                 | OWASP recommended, memory-hard            |
| Observability          | OpenTelemetry            | Vendor-neutral, standard                  |
| Testing                | Vitest                   | Fast, ESM-native, workspace-aware         |
| Build                  | tsup                     | Fast, dual ESM/CJS output                 |
| Changelog              | Changesets               | Multi-package, automated                  |

---

## Milestone Timeline (Estimate)

| Phase                           | Estimated Duration | Cumulative |
| ------------------------------- | ------------------ | ---------- |
| Phase 0 — Bootstrap             | 1 week             | Week 1     |
| Phase 1 — DB & Core             | 1.5 weeks          | Week 2–3   |
| Phase 2 — Registry Core         | 2 weeks            | Week 5     |
| Phase 3 — Dashboard             | 3 weeks            | Week 8     |
| Phase 4 — SDK & CLI             | 2 weeks            | Week 10    |
| Phase 5 — GC & Webhooks         | 1.5 weeks          | Week 12    |
| Phase 6 — Hardening + SSO       | 3 weeks            | Week 15    |
| Phase 7 — Scale & Community     | 2 weeks            | Week 17    |
| Phase 8 — Enterprise Governance | 3 weeks            | Week 20    |

---

## Phase 8 — Enterprise Governance

**Goal**: Satisfy the three procurement blockers that prevent regulated-industry and large-enterprise adoption.

### 8.1 Change Approval Workflows (APR-01–18)

#### Database

- [ ] Add `ApprovalPolicy` model: `workspaceId`, `environmentId`, `requiredApprovers`, `eligibleRoles`, `requireChangeTicket`, `ticketUrlPattern`, `expiryHours`
- [ ] Add `DeploymentRequest` model: `workspaceId`, `moduleId`, `environmentId`, `type`, `requestedBy`, `payload` (Json), `status`, `changeTicketId`, `changeTicketUrl`, `expiresAt`, `resolvedAt`, `resolvedBy`, `bypassJustification`
- [ ] Add `DeploymentApproval` model: `deploymentRequestId`, `approverId`, `decision`, `comment`, `decidedAt`
- [ ] Add `@@index([workspaceId])` and RLS to all three new tables
- [ ] Prisma migration: approval tables

#### Registry — Approval Gate Middleware

- [ ] Approval gate middleware: check `ApprovalPolicy` for the target environment on every deploy/rollback/promote/canary route
- [ ] If policy exists: create `DeploymentRequest` (`pending_approval`), return `202 Accepted` with `{ requestId, approvalUrl }`
- [ ] If no policy: proceed as before (immediate execution)
- [ ] `POST /api/workspaces/:slug/approvals/:requestId/approve` — validate eligibility (not self, eligible role), create `DeploymentApproval`, check if threshold met
- [ ] `POST /api/workspaces/:slug/approvals/:requestId/reject` — create `DeploymentApproval` (`rejected`), set request `rejected`
- [ ] `POST /api/workspaces/:slug/approvals/:requestId/bypass` — emergency bypass with justification, require `owner` role
- [ ] `pg-boss` cron job: `approval.expiry` (runs every 15 min) — expire `pending_approval` requests older than their `expiresAt`
- [ ] Emit webhook event `deploy.approval_requested` to all configured endpoints on request creation

#### Registry — Approval Policy CRUD

- [ ] `POST /api/workspaces/:slug/environments/:envId/approval-policy` — create/update policy
- [ ] `DELETE /api/workspaces/:slug/environments/:envId/approval-policy` — remove policy (immediate deploys restored)
- [ ] `GET /api/workspaces/:slug/approvals?status=pending` — list pending requests for the authenticated user

#### Dashboard

- [ ] **Pending Approvals** page (`/[workspaceSlug]/approvals`) — queue of all requests awaiting the current user's decision, with Approve / Reject buttons and comment field (APR-16)
- [ ] Approval policy editor in `Workspace Settings → Deployments` — required approvers, eligible roles, change ticket toggle, expiry window (APR-02)
- [ ] Deployment history: display full approval chain (requestor, approvers, timestamps, bypass flag) (APR-18)
- [ ] `⚠️ BYPASSED` visual indicator in audit log and deployment history (APR-12)

#### Test Suite

- [ ] Unit tests: approval gate middleware (policy detection, self-approval rejection, threshold logic)
- [ ] Integration tests: full approval lifecycle (request → approve → execute), rejection flow, emergency bypass, expiry
- [ ] Integration tests: change ticket enforcement, APR-15 eligibility enforcement

---

### 8.2 Organization Hierarchy (ORG-01–15)

#### Database

- [ ] Add `Organization` model: `id`, `slug`, `name`, `plan`, `oidcConfig` (encrypted Json), `samlConfig` (encrypted Json), `createdAt`, `deletedAt`
- [ ] Add `OrganizationMember` model: `organizationId`, `userId`, `role` (`org_admin | org_member`), `createdAt`
- [ ] Add `organizationId` nullable FK to `Workspace` model
- [ ] Add `OrgApiKey` model: `organizationId`, `keyHash`, `name`, `workspaceScope` (String[]), `moduleScope` (String[]), `createdAt`, `revokedAt`
- [ ] Prisma migration: organization tables

#### Registry — Organization Endpoints

- [ ] `POST /api/orgs` — create organization
- [ ] `GET /api/orgs/:orgSlug` — org details
- [ ] `GET /api/orgs/:orgSlug/workspaces` — list all workspaces
- [ ] `GET /api/orgs/:orgSlug/audit` — cross-workspace audit log (paginated, filterable) (ORG-09)
- [ ] `GET /api/orgs/:orgSlug/catalog` — org module catalog across all workspaces (ORG-12)
- [ ] Org-level SAML endpoints: `POST /auth/saml/:orgSlug/acs`, `GET /auth/saml/:orgSlug/metadata` (ORG-06)
- [ ] Org-level SCIM: `/scim/v2/orgs/:orgSlug` (ORG-07)
- [ ] `WorkspaceConfig` SSO resolution: check workspace-level SSO first; fall back to org-level SSO if workspace has no override

#### Registry — Cross-Workspace Module Sharing

- [ ] `POST /api/workspaces/:slug/modules/:moduleId/publish-org` — publish module as org-shared (ORG-10)
- [ ] Manifest builder: include org-shared modules from other workspaces in the org, tagged with `shared: true` (ORG-11)

#### Dashboard

- [ ] **Organization home** page (`/orgs/:orgSlug`) — all workspaces with aggregate health, recent deploys, cross-workspace audit log (ORG-14)
- [ ] **Org Module Catalog** (`/orgs/:orgSlug/catalog`) — searchable, filterable by team, module, env (ORG-12)
- [ ] **Org SSO Settings** — configure SAML/OIDC once, applies to all workspaces (ORG-05)
- [ ] **Org Members** — directory of all users across all workspaces
- [ ] Existing `/:workspaceSlug` routes remain fully backward-compatible (ORG-15)

#### Test Suite

- [ ] Unit tests: org SSO fallback resolution logic, org module catalog query
- [ ] Integration tests: org creation, workspace-to-org association, cross-workspace audit log, org-shared module manifest inclusion
- [ ] Integration tests: org-level SAML flow end-to-end

---

### 8.3 GitOps / Infrastructure as Code (IaC-01–14)

#### Terraform Provider (`harmoniq-terraform-provider` — separate Go repo)

- [ ] Scaffold provider using `hashicorp/terraform-plugin-framework`
- [ ] Implement resource: `harmoniq_workspace` (CRUD + import)
- [ ] Implement resource: `harmoniq_environment` (CRUD + import + `approval_policy` nested block)
- [ ] Implement resource: `harmoniq_host_app` (CRUD + import)
- [ ] Implement resource: `harmoniq_remote_module` (CRUD + import)
- [ ] Implement resource: `harmoniq_api_key` (create + delete; read uses hash comparison)
- [ ] Implement resource: `harmoniq_webhook_endpoint` (CRUD + import)
- [ ] Implement resource: `harmoniq_alert_rule` (CRUD + import)
- [ ] Implement resource: `harmoniq_approval_policy` (CRUD + import)
- [ ] Data sources: `harmoniq_workspace`, `harmoniq_environment`, `harmoniq_manifest`
- [ ] `tfplugindocs` generated docs, published to `registry.terraform.io` (IaC-04)
- [ ] Unit tests: each resource CRUD using `hashicorp/terraform-plugin-testing`

#### GitHub Actions (`harmoniq-deploy-action` — separate repo)

- [ ] Composite action `harmoniq-dev/deploy-action@v1`: wraps `harmoniq deploy` CLI (IaC-05)
- [ ] Inputs: `api-key`, `registry-url`, `workspace`, `module`, `environment`, `url`, `version`, `integrity`, `dry-run` (IaC-06)
- [ ] Outputs: `version-id`, `manifest-url`, `deployed-at` (IaC-07)
- [ ] GitHub Actions job summary annotation: deployment card with approval status, diff link (IaC-08)
- [ ] Published to GitHub Marketplace

#### CLI — Harmoniq-as-Code Commands

- [ ] `harmoniq plan` — parse `harmoniq.yaml`, diff against registry API, output structured change plan (IaC-10)
- [ ] `harmoniq apply` — execute plan: create/update/delete registry resources to match `harmoniq.yaml` (IaC-11)
- [ ] `harmoniq import` — call registry API, generate `harmoniq.yaml` from current state (IaC-12)
- [ ] `harmoniq.yaml` JSON Schema published to `schemastore.org` for IDE autocompletion

#### GitLab CI (`harmoniq-ci` — separate repo)

- [ ] GitLab CI component wrapping the CLI (IaC-13)
- [ ] Published to GitLab CI Catalog

#### Test Suite

- [ ] Unit tests: `harmoniq plan` diff logic (additions, modifications, deletions, no-ops)
- [ ] Integration tests: `harmoniq apply` idempotency (apply twice = no changes on second run)
- [ ] Integration tests: `harmoniq import` round-trip (import → plan → no changes)

### Deliverables

- Approval workflows blocking production deploys in regulated envs
- Organization hierarchy live with cross-workspace audit and SSO inheritance
- Terraform provider published to registry.terraform.io
- GitHub Actions action published to Marketplace
- `harmoniq plan` / `harmoniq apply` / `harmoniq import` CLI commands working end-to-end
