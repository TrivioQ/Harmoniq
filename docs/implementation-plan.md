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

- [x] Initialize git repository with `.gitignore`, `LICENSE` (Apache 2.0), `README.md`
- [x] Set up pnpm workspace: `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`
- [x] Configure root `package.json` with `engines: { pnpm: ">=9", node: ">=20" }` and `preinstall` guard script
- [x] Install and configure **Turborepo**: `turbo.json` with `build`, `dev`, `test`, `lint` pipeline
- [x] Create `packages/tsconfig/` with shared `base.json`, `nextjs.json`, `node.json`
- [x] Set up **ESLint** (flat config) and **Prettier** at root; extend per-package
- [x] Set up **Vitest** as the test runner (workspace config)
- [x] Create `docker/docker-compose.yml` with services: `postgres`, `redis`, `registry`, `web`
- [x] Create `.env.example` with all required variables
- [x] Set up **Changesets** for changelog management
- [x] Create `docs/` directory with initial documentation files
- [x] Create `.agents/AGENTS.md` with change-documentation rules (see Rules section)
- [x] Create `docs/features/` directory for per-feature docs (with change history)

### Deliverables

- Runnable monorepo: `pnpm install` succeeds
- `pnpm run docker:up` starts Postgres + Redis
- Linting and type-check pass

---

## Phase 1 — Database & Core Package

**Goal**: Establish the Prisma schema, RLS policies, and all shared port interfaces.

### Package: `packages/db` (`@harmoniq/db`)

- [x] Install: `prisma`, `@prisma/client`
- [x] Define Prisma schema with all models:
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
- [x] Add `workspaceId` FK and `@@index([workspaceId])` to all tenant-scoped models
- [x] Write Prisma migration: base schema
- [x] Write post-migration SQL hook to enable RLS on all tenant tables
- [x] Write RLS policies (USING clause reads `current_setting('app.current_workspace_id')`)
- [x] Create dedicated DB role `harmoniq_app` with BYPASSRLS denied
- [x] Write Prisma middleware to inject `SET LOCAL app.current_workspace_id` on each query (built as `withTenant`: an interactive transaction that sets it first)
- [x] Write `seed.ts`: demo workspace, two environments (staging/production), sample modules
- [x] Add scripts: `db:migrate`, `db:studio`, `db:seed`, `db:reset`

### Package: `packages/core` (`@harmoniq/core`)

- [x] Define port interfaces: `ICache`, `IStorage`, `ILogger`, `OAuthPlugin` (`OAuthPlugin` became the `IdentityProvider` port)
- [x] Define all shared DTOs and Zod schemas:
  - `ManifestSchema` (v1)
  - `DeployRequestSchema`
  - `RollbackRequestSchema`
  - `CanaryConfigSchema`
  - `ApiKeyCreateSchema`
  - `WebhookEventSchema`
- [x] Define `AppError` hierarchy (typed error classes)
- [x] Export shared TypeScript types for manifest, module version, audit event, etc.
- [ ] Write unit test suite for all `@harmoniq/core` Zod schemas, DTOs, and AppErrors (>90% coverage)
- [x] Write unit test suite for `@harmoniq/db` Prisma middleware and RLS policy hooks

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

- [x] Initialize Fastify app with `fastify-plugin` architecture
- [x] Register plugins: `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`
- [x] Set up OTel instrumentation: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
- [x] Implement `ICache` adapters:
  - `RedisCache` using `ioredis`
  - `InMemoryLRUCache` using `lru-cache`
- [x] Implement `ILogger` adapters:
  - `ConsoleLogger` (pino-based, pretty in dev)
  - `OTelLogger` (production, exports via OTLP)
- [x] Wire dependency injection: service container that resolves adapters from env config

#### Manifest Endpoint

- [x] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env` (HST-01 — canonical)
  - Validate workspace slug, hostApp slug, env exist
  - Check `ICache` for cached manifest
  - On cache miss: query DB, build manifest JSON (schemaVersion 2, hostApp field), compute ETag, write to cache
  - Support `If-None-Match` → `304 Not Modified`
  - On DB failure: return stale cache with `X-Harmoniq-Stale: true` header
  - Return manifest with `ETag`, `Cache-Control: no-cache`, `X-Harmoniq-Variant`, `X-Harmoniq-Cohort-Id` headers (CAN-08)
- [x] `GET /api/manifest/:workspaceSlug/:env` (HST-02 — legacy, resolves to isDefault HostApp)
- [x] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env` — canary variant
  - Implement sticky assignment (hash `X-Harmoniq-User-Id` or set `harmoniq_canary` cookie)
  - Return canary manifest (variant: "canary") or stable manifest (variant: "stable")
- [x] `GET /api/importmap/:workspaceSlug/:hostAppSlug/:env` (IMP-01)
  - Build Import Map JSON from active module versions
  - ETag + If-None-Match support
- [x] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots` (SNAP-02)
- [x] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots/:id` (SNAP-03)
- [x] `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env/diff` (DIFF-01)
- [x] Rate limiting: token-bucket on all manifest + importmap endpoints (RL-01)
- [x] `GET /api/modules/:moduleId/health` — 5-min rolling aggregation (HLT-02) (at `/api/workspaces/:ws/modules/:module/health`)

#### Auth Middleware

- [x] API key extraction from `Authorization: Bearer hq_...` header
- [x] Argon2id hash verification against DB
- [x] Scope enforcement middleware (decorates route with required scope)
- [x] Rate limiting on auth routes: 10 req/min per IP

#### Deploy & Version Management Routes

- [x] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/deploy`
  - Support `dryRun: true` mode — validate only, no commit (VAL-02)
  - Validate `DeployRequestSchema` (includes `dependencies`, `exposes`)
  - Dependency compatibility check against active modules (DEP-02)
  - Insert new `ModuleVersion` (status: `active`)
  - Atomically set all other versions for module+env to `inactive`
  - Invalidate cache keys: manifest + importmap (IMP-06)
  - Create `ManifestSnapshot` (SNAP-01)
  - Create `AuditEvent`
  - Return new version record
- [x] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/rollback`
  - Transaction: set target version to `active`, current `active` to `inactive`
  - Invalidate cache + importmap
  - Create `ManifestSnapshot` + `AuditEvent`
- [x] `POST /api/workspaces/:workspaceSlug/modules/:moduleId/promote` (PRO-01)
  - Check target env freeze (PRO-03)
  - Copy version to target env atomically
  - Invalidate target-env cache + importmap
  - Create `ManifestSnapshot` + `AuditEvent` with `action: 'module.promote'`
- [x] `PUT /api/workspaces/:workspaceSlug/modules/:moduleId/canary`
  - Support `rolloutSchedule` (STG-01)
  - Invalidate canary cache key
  - Create `ManifestSnapshot` + `AuditEvent`
- [x] Env freeze enforcement middleware: reject mutating ops with `423` on frozen envs (ENV-FRZ-02)
- [x] Module RBAC middleware: enforce module ownership on deploy/rollback/promote/canary (RBAC-02)

#### Health & Metrics

- [x] `GET /health` — always 200
- [x] `GET /ready` — check DB connection + cache connection; 503 on failure
- [x] `GET /metrics` — Prometheus text format

#### Test Suite

- [x] Integration test suite for manifest endpoints (`GET /api/manifest/...`), ETag caching (304), stale fallback, and canary assignments
- [x] Integration test suite for deploy, rollback, promote, and canary management API endpoints
- [x] Unit & integration test suite for auth middleware (API key argon2id validation, scopes, rate limiting) and env freeze / RBAC middleware

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

- [x] Initialize Next.js app (App Router, TypeScript strict mode)
- [x] Install: `tailwindcss`, `@shadcn/ui`, `lucide-react`
- [x] Configure Tailwind with custom Harmoniq design tokens
- [x] Set up Next.js middleware for Edge-compatible JWT verification (`jose`)
- [x] Configure `HttpOnly` + `Secure` + `SameSite=Lax` session cookies
- [x] Set up route groups: `(auth)`, `(dashboard)` (as `/auth`, `/w/:workspace`, `/orgs/:org` and `/admin` segments)

#### Authentication Flow

- [x] `GET /auth/login` — OAuth provider selection page
- [x] `GET /auth/[provider]/callback` — exchange code, create session
  - Plug in `OAuthPlugin` adapter (GitHub or Google based on env config)
  - Create or update `User` record
  - Issue JWT access token (15min) + opaque refresh token
  - Set cookies
- [x] `POST /auth/refresh` — verify refresh token, rotate, issue new access token
- [x] `POST /auth/logout` — revoke refresh token, clear cookies
- [x] Edge middleware: verify JWT on all `(dashboard)` routes; redirect to `/auth/login` on failure

#### Dashboard Pages

- [x] **Workspace Selector** (`/`) — list user's workspaces, create new workspace
- [x] **Overview** (`/w/[workspaceSlug]/`) — active modules count, recent deploys, environment status
- [x] **Modules** (`/w/[workspaceSlug]/modules`) — list all modules with active versions per env + health sparklines (HLT-04)
- [x] **Module Detail** (`/w/[workspaceSlug]/modules/[moduleId]`)
  - Deployment history table (all versions, statuses, deployed by, timestamps)
  - One-click rollback
  - One-click **Promote to Production** (PRO-05)
  - Canary setup UI (version selector, traffic % slider, rollout schedule editor)
  - Module Owners tab (RBAC-05)
  - Side-by-side manifest diff view (DIFF-03)
- [x] **Environments** (`/w/[workspaceSlug]/environments`) — CRUD environments, freeze/unfreeze (ENV-FRZ-05), scheduled freeze windows
- [x] **Dependency Matrix** (`/w/[workspaceSlug]/environments/[envId]/deps`) — per-env dependency grid (DEP-04)
- [x] **API Keys** (`/w/[workspaceSlug]/settings/keys`) — create, revoke, rotate, module-scope restriction (RBAC-04)
- [x] **Members** (`/w/[workspaceSlug]/settings/members`) — invite, role assignment, module ownership
- [x] **Webhooks** (`/w/[workspaceSlug]/settings/webhooks`) — create, delivery log, **Dead Letter Queue** with Retry Now (WHK-08)
- [x] **Audit Log** (`/w/[workspaceSlug]/audit`) — filterable table (actor, action, date range)
- [x] **SSO Settings** (`/w/[workspaceSlug]/settings/sso`) — OIDC config, SAML Setup Wizard (SSO-19), Test Connection (SSO-20), domain allowlist, forced SSO toggle
- [x] **Alert Rules** (`/w/[workspaceSlug]/settings/alerts`) — create/edit alert rules (ALT-01)
- [x] **API Explorer** (`/docs/api`) — embedded Scalar UI (OAS-04)
- [x] **Quickstart Wizard** — first-time workspace onboarding (DX-04)
- [x] **Workspace Settings** (`/w/[workspaceSlug]/settings`) — storage config, retention policy, danger zone

#### Test Suite

- [x] Unit & component test suite for authentication hooks, Edge middleware, and JWT validation
- [x] Integration test suite for dashboard UI components, forms, and API route handlers

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

- [x] `HarmoniqClient` class (options: `registryUrl`, `workspaceSlug`, `hostApp`, `environment`)
- [x] Manifest fetch v2 with `If-None-Match` ETag support
- [x] Stale-while-revalidate caching
- [x] Fallback to last-known-good manifest on network failure
- [x] Exponential backoff retry
- [x] Optional polling (`pollIntervalMs`)
- [x] `onManifestUpdate(callback)` event emitter
- [x] `manifest.getModuleUrl(name)` helper (existing)
- [x] `manifest.getModuleEntry(name)` → `{ url, integrity }` (SRI-01)
- [x] `manifest.getScriptTag(name)` → HTML `<script>` string (SRI-02)
- [x] `manifest.variant` + `manifest.cohortId` fields (CAN-09)
- [x] `client.on('variantAssigned', ...)` event (CAN-10)
- [x] `client.reportModuleLoad(name, { success, loadMs, variant })` (HLT-01)
- [x] `client.reportModuleError(name, { error, variant })` (HLT-01)
- [x] Framework adapters: `@harmoniq/client/react`, `/angular`, `/vue` (ADP-01-04)
- [x] **Zero runtime dependencies**
- [ ] Full JSDoc + TypeDoc documentation
- [x] Unit tests (Vitest + `msw` for mock server)
- [x] Build: ESM + CJS + type declarations (via `tsup`)

### Package: `packages/cli` (`@harmoniq/cli`)

> CI/CD-only interface. Dashboard handles all management operations.

- [x] CLI framework: `commander` + `ora` (spinners) + `chalk` (colors)
- [x] `harmoniq login` — prompt API key, validate, store in `~/.harmoniq/config.json`
- [x] `harmoniq whoami` — display current auth context
- [x] `harmoniq deploy` — POST to registry deploy endpoint (with `--force` flag for dep bypass, DEP-03)
- [x] `harmoniq rollback` — POST rollback with version selection
- [x] `harmoniq promote` — POST promote (PRO-04)
- [x] `harmoniq validate` — validate bundle URL + integrity + deps before deploying (VAL-01)
- [x] `harmoniq canary promote` — promote canary to active
- [x] `harmoniq canary set-traffic` — update traffic percentage
- [x] `harmoniq manifest get --json` — fetch manifest (machine-readable output)
- [x] Support `--json` flag on all commands for CI/CD machine-readable output
- [x] Support `--profile` flag for multiple workspace configs
- [x] Unit & integration test suite covering all CLI commands (login, deploy, rollback, promote, validate, canary)
- [x] Build: distributed as `npx harmoniq`

### Deliverables

- `npm install @harmoniq/client` works
- `npx harmoniq deploy ...` works end-to-end against a running registry
- 100% of client public API and CLI commands covered by unit & integration tests

---

## Phase 5 — Garbage Collection & Webhooks

**Goal**: Implement background data lifecycle management and webhook delivery.

### Background Jobs (in `apps/registry`)

- [x] Initialize `pg-boss` client, connect to Postgres
- [x] Define job types: `gc.softDelete`, `gc.hardDelete`, `gc.orphanScan`, `webhook.deliver`

#### GC Jobs

- [x] `gc.softDelete` (daily cron) — soft-delete `inactive` `ModuleVersion` + `ManifestSnapshot` records older than `retentionDays`
- [x] `gc.hardDelete` (weekly cron) — hard-delete soft-deleted records, purge `IStorage`
- [x] `gc.orphanScan` (weekly cron) — flag storage objects with no DB record
- [x] `gc.healthEventPurge` (daily cron) — hard-delete `ModuleHealthEvent` records older than 24h

#### Webhook Delivery

- [x] `webhook.deliver` job: configurable retries (WHK-03), exponential backoff up to `backoffCeilingMs` (WHK-06)
- [x] On retry exhaustion: write `WebhookDeadLetter` record (WHK-07)
- [x] `POST /api/webhooks/deliveries/:deliveryId/retry` — re-enqueue dead-lettered delivery (WHK-09)

#### Alert & Staged Rollout Jobs

- [x] `alert.evaluate` (60s cron) — evaluate all enabled `AlertRule` conditions against health metrics (ALT-05)
- [x] `rollout.advance` (scheduled) — advance staged rollout bands automatically (STG-02)
- [x] `alert.auto_rollback` — triggered by failed alert condition during staged rollout (STG-04)

### Deliverables

- GC jobs registered and running on schedule
- Webhook delivery with signing and retry logging
- GC integration tests (with test DB, verify soft-delete and hard-delete)

---

## Phase 6 — Hardening, Observability & Documentation

**Goal**: Production readiness — security, performance, and documentation.

### Security Hardening

- [x] Dependency audit: `pnpm audit` — resolve all high/critical (production dependencies; CI runs `pnpm audit --audit-level high --prod`)
- [x] Add `helmet` CSP headers to both apps (the dashboard: a nonce CSP from `src/proxy.ts`)
- [x] Add `@fastify/rate-limit` to all write endpoints
- [x] Validate all request bodies with Zod on every route
- [x] Add CSRF protection to Next.js dashboard mutations (SameSite=Lax cookies plus `Origin` checks in server actions and POST routes, instead of double-submit tokens; see `docs/self-hosting.md` § Security)
- [x] Pen-test: verify RLS prevents cross-tenant access with integration tests

### SSO — OIDC Plugin

- [x] Implement `OIDCPlugin`: auth code + PKCE flow, JWKS token validation, silent refresh (SSO-01 to SSO-08)
- [x] Dashboard: OIDC configuration UI, domain allowlist, claim-to-role mapping (SSO-03, SSO-07)

### SSO — SAML 2.0 Plugin

- [x] Implement `SAMLPlugin` using `node-saml`: SP-initiated + IdP-initiated flows (SSO-09)
- [x] ACS endpoint `POST /auth/saml/:workspaceSlug/acs` (SSO-10)
- [x] SP Metadata endpoint `GET /auth/saml/:workspaceSlug/metadata` (SSO-11)
- [x] SP-Initiated redirect `GET /auth/saml/:workspaceSlug/login` (SSO-12)
- [x] SLO endpoints (SSO-13)
- [x] SAML Response full validation (SSO-14)
- [x] Per-workspace SP signing key pair generation + encrypted storage (SSO-18)
- [x] Dashboard: SAML Setup Wizard for Okta, Azure AD, ADFS (SSO-19)
- [x] Dashboard: Test Connection button (SSO-20)
- [x] SCIM 2.0 endpoint `/scim/v2` for Okta/Azure AD push provisioning (SSO-24)
- [x] Forced SSO enforcement (SSO-26)
- [x] JIT provisioning + domain auto-join (SSO-21, SSO-22)
- [x] Group-to-role mapping (SSO-23)

### Performance

- [ ] Benchmark manifest endpoint with `autocannon`: verify p99 < 50ms on cache hit
- [x] Profile and optimize DB queries (add indexes if needed)
- [x] Enable HTTP/2 on registry (`TLS_CERT_FILE` / `TLS_KEY_FILE`)

### Observability

- [x] OTel traces on all critical paths: manifest fetch, deploy, rollback, GC jobs
- [x] Add custom metrics: `harmoniq.manifest.cache_hits`, `harmoniq.manifest.cache_misses`, `harmoniq.deploy.count` (exported as `harmoniq_manifest_cache_hits_total` etc., plus `harmoniq_http_request_duration_ms`)
- [x] Wire Prometheus `/metrics` to Grafana dashboard (example `docker/grafana/`)
- [x] Structured logging: all logs include `workspaceId`, `requestId`, `duration`

### Documentation

- [x] `README.md`: quick-start guide with Docker Compose (5-minute setup)
- [x] `docs/self-hosting.md`: full self-hosting guide (env vars, Docker, reverse proxy)
- [x] `docs/sdk.md`: `@harmoniq/client` usage guide
- [x] `docs/cli.md`: `@harmoniq/cli` command reference
- [x] `docs/api-reference.md`: full REST API reference (auto-generated from Fastify + `@fastify/swagger`) (the reference is written by hand; `docs/openapi.json` is the generated one)
- [ ] `docs/contributing.md`: contribution guide (Conventional Commits, PR checklist, change-doc rule)
- [x] OpenAPI spec: auto-generated and committed to `docs/openapi.json`

### Final Checklist

- [x] All phases' integration tests passing in CI
- [x] `pnpm run docker:up` → 5-minute demo working end-to-end
- [ ] Apache 2.0 license headers on all source files
- [x] GitHub Actions CI: lint + type-check + test on every PR
- [ ] GitHub Actions release: changesets → npm publish on merge to main

---

## Phase 7 — Scale, Polish & Community

**Goal**: Cross-stack adoption, community enablement, and operational polish.

### Framework Adapters

- [x] `@harmoniq/client/react` — `<HarmoniqProvider>` + `useRemoteModule()` hook (ADP-02)
- [x] `@harmoniq/client/angular` — `HarmoniqService` injectable (ADP-03)
- [x] `@harmoniq/client/vue` — `useHarmoniq()` composable (ADP-04)

### OpenAPI & Community Clients

- [x] Auto-generate `docs/openapi.json` from `@fastify/swagger` (OAS-01)
- [x] Embed Scalar API Explorer at `/docs/api` (OAS-04)
- [ ] Community-track: `harmoniq-go` + `harmoniq-python` thin clients from OpenAPI spec (OAS-03)

### Local Dev Mode

- [x] `pnpm run dev:local` — in-memory registry, no Docker, no Postgres (DX-02) (an embedded Postgres from npm; in-memory cache)
- [x] `?pretty=true` on manifest endpoint for development (DX-03)

### Kubernetes Helm Chart (community target)

- [x] `charts/harmoniq/` — Helm chart with configurable replica count, ingress, secrets

### Deliverables

- Framework adapters published and documented
- OpenAPI spec committed and Scalar UI live
- `pnpm run dev:local` works end-to-end

### 7.4 Instance Admin UI (INST-01–18)

#### Database

- [x] Add `InstanceConfig` model: `key` (unique), `value` (Json, encrypted at rest), `updatedAt`, `updatedBy`
- [x] Add `InstanceAdmin` model: `userId` (unique FK), `grantedBy`, `createdAt`, `revokedAt`
- [x] Prisma migration: instance tables (NOT RLS-scoped — instance-wide)

#### Registry — Admin API

- [x] Admin auth middleware: extract session, verify `InstanceAdmin` record is active. Reject all `/admin/*` routes for non-admin sessions — even workspace `owner` (INST-06)
- [x] `GET /admin/api/health` — DB ping, Redis ping, storage adapter ping, `pg-boss` queue depth, active job count (INST-08)
- [x] `GET /admin/api/workspaces` — all workspaces with usage metrics
- [x] `POST /admin/api/workspaces/:id/suspend` and `/unsuspend` (INST-09)
- [x] `DELETE /admin/api/workspaces/:id` — hard delete
- [x] `GET /admin/api/users` — all users with workspace memberships + last login
- [x] `POST /admin/api/users/:id/revoke-sessions` (INST-10)
- [x] `DELETE /admin/api/users/:id` — hard delete
- [x] `GET /admin/api/config` — return all `InstanceConfig` keys with values **redacted** for sensitive keys
- [x] `PUT /admin/api/config/:key` — update a config value (encrypt sensitive keys before storing)
- [x] `POST /admin/api/config/storage/test` — connectivity test for the configured default storage adapter
- [x] `POST /admin/api/config/smtp/test` — send test email to authenticated admin (INST-12)
- [x] Hot-reload (a 60 s timer per registry rather than a pg-boss cron): `config.reload` (60s interval) refreshes registry's in-memory config snapshot from `InstanceConfig` (INST-17)
- [x] `GET /admin/setup` — serve setup wizard (only when no active `InstanceAdmin` exists)
- [x] `POST /admin/setup` — consume `HARMONIQ_SETUP_TOKEN`, create first admin user, set initial `InstanceConfig` values (INST-01–INST-04)
- [x] Emit `InstanceAuditEvent` (`action: 'instance.config_updated'`, key only, no plaintext value) on every config change (INST-18)

#### Dashboard — Admin Panel Pages

- [x] `/admin/setup` — 4-step first-boot wizard: account → connectivity → storage → OAuth (INST-03)
- [x] `/admin/health` — system health indicators with live-refresh
- [x] `/admin/workspaces` — workspace list with usage, suspend/unsuspend/delete actions
- [x] `/admin/users` — user directory, revoke sessions, delete user
- [x] `/admin/storage` — adapter selector + credential form + Test Connection button (INST-11)
- [x] `/admin/email` — SMTP config form + Send Test Email button (INST-12)
- [x] `/admin/auth` — enable/disable OAuth providers globally (INST-13)
- [x] `/admin/branding` — name, logo, support URL, accent colour (INST-14)
- [x] `/admin/admins` — grant/revoke `InstanceAdmin` role (INST-07)
- [x] Admin nav sidebar: entirely separate from workspace nav; appears only for `InstanceAdmin` sessions

#### Test Suite

- [x] Unit tests: admin auth middleware (verify non-admin workspace sessions are rejected, including `owner` role)
- [x] Unit tests: config hot-reload (mock `InstanceConfig` update, verify in-memory snapshot refreshes)
- [x] Integration tests: setup wizard flow (token consumption, duplicate call rejected, first admin created)
- [x] Integration tests: all `/admin/api/*` endpoints with admin session and with non-admin session (must return 403)

---

### 7.5 Bring-Your-Own-Bucket Storage (BYOB-01–14)

#### Database

- [x] Add `WorkspaceStorageConfig` model: `workspaceId` (unique FK), `provider`, `bucket`, `region`, `credentialsEncrypted` (Json), `cdnPrefix?`, `pathPrefix?`, `lastVerifiedAt?`, `createdAt`, `updatedAt`
- [x] Prisma migration: `WorkspaceStorageConfig` table with RLS

#### Registry — Storage Adapter Resolution

- [x] Implement storage adapter resolver: check `WorkspaceStorageConfig` first → fall back to `InstanceConfig["storage.adapter"]` → fall back to `STORAGE_ADAPTER` env var (BYOB-07 + INST-16)
- [x] Implement `S3StorageAdapter`, `GCSStorageAdapter`, `AzureBlobStorageAdapter` implementing the `IStorage` port interface
- [x] Canary verification utility: write a 1-byte probe object, read it back, delete it. Return `{ success, latencyMs, error? }` (BYOB-04)
- [x] At deploy-time: if BYOB adapter fails, return `503` and DO NOT fall back to instance storage (BYOB-09)
- [x] `POST /api/workspaces/:slug/storage` — save BYOB config: run canary cycle before committing, return `400` with diagnostic on failure (BYOB-04)
- [x] `DELETE /api/workspaces/:slug/storage` — remove BYOB config (revert to instance default)
- [x] `POST /api/workspaces/:slug/storage/test` — on-demand canary cycle without saving (BYOB-05)
- [x] `GET /api/workspaces/:slug/storage` — return config with credentials **redacted** (provider, bucket, region, cdnPrefix, lastVerifiedAt only)
- [x] Deploy route: resolve workspace storage adapter; log `storageRegion` in `AuditEvent` metadata (BYOB-14)
- [x] CLI warning: compare `--url` against `WorkspaceStorageConfig.cdnPrefix`; emit `warning` to stderr if prefix mismatch (BYOB-10)

#### Dashboard — Workspace Storage Settings Page

- [x] `Workspace Settings → Storage` page: BYOB provider selector, credential form (S3/GCS/Azure fields), CDN prefix, path prefix
- [x] Test Connection button (BYOB-05): calls `/storage/test`, displays latency or error message
- [x] Migration advisory banner shown when BYOB is first enabled (BYOB-12)
- [x] Plan gate: storage page shows upgrade prompt for `hobby` plan (BYOB-01)

#### Test Suite

- [x] Unit tests: storage adapter resolver (BYOB config present, absent, instance config fallback, env var fallback)
- [x] Unit tests: canary verification utility (success path, write failure, read failure, delete failure)
- [x] Unit tests: fail-closed behavior — BYOB adapter 503, verify NO fallback to instance storage (BYOB-09)
- [x] Integration tests: BYOB config save → canary cycle → deploy writes to workspace bucket → manifest reflects workspace CDN prefix
- [x] Integration tests: credentials-invalid save returns 400 with diagnostic

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

- [x] Add `ApprovalPolicy` model: `workspaceId`, `environmentId`, `requiredApprovers`, `eligibleRoles`, `requireChangeTicket`, `ticketUrlPattern`, `expiryHours`
- [x] Add `DeploymentRequest` model: `workspaceId`, `moduleId`, `environmentId`, `type`, `requestedBy`, `payload` (Json), `status`, `changeTicketId`, `changeTicketUrl`, `expiresAt`, `resolvedAt`, `resolvedBy`, `bypassJustification`
- [x] Add `DeploymentApproval` model: `deploymentRequestId`, `approverId`, `decision`, `comment`, `decidedAt`
- [x] Add `@@index([workspaceId])` and RLS to all three new tables
- [x] Prisma migration: approval tables

#### Registry — Approval Gate Middleware

- [x] Approval gate middleware: check `ApprovalPolicy` for the target environment on every deploy/rollback/promote/canary route
- [x] If policy exists: create `DeploymentRequest` (`pending_approval`), return `202 Accepted` with `{ requestId, approvalUrl }`
- [x] If no policy: proceed as before (immediate execution)
- [x] `POST /api/workspaces/:slug/approvals/:requestId/approve` — validate eligibility (not self, eligible role), create `DeploymentApproval`, check if threshold met
- [x] `POST /api/workspaces/:slug/approvals/:requestId/reject` — create `DeploymentApproval` (`rejected`), set request `rejected`
- [x] `POST /api/workspaces/:slug/approvals/:requestId/bypass` — emergency bypass with justification, require `owner` role
- [x] `pg-boss` cron job: `approval.expiry` (runs every 15 min) — expire `pending_approval` requests older than their `expiresAt`
- [x] Emit webhook event `deploy.approval_requested` to all configured endpoints on request creation

#### Registry — Approval Policy CRUD

- [x] `POST /api/workspaces/:slug/environments/:envId/approval-policy` — create/update policy
- [x] `DELETE /api/workspaces/:slug/environments/:envId/approval-policy` — remove policy (immediate deploys restored)
- [x] `GET /api/workspaces/:slug/approvals?status=pending` — list pending requests for the authenticated user

#### Dashboard

- [x] **Pending Approvals** page (`/w/[workspaceSlug]/approvals`) — queue of all requests awaiting the current user's decision, with Approve / Reject buttons and comment field (APR-16)
- [x] Approval policy editor in `Workspace Settings → Deployments` — required approvers, eligible roles, change ticket toggle, expiry window (APR-02)
- [x] Deployment history: display full approval chain (requestor, approvers, timestamps, bypass flag) (APR-18)
- [x] `⚠️ BYPASSED` visual indicator in audit log and deployment history (APR-12)

#### Test Suite

- [x] Unit tests: approval gate middleware (policy detection, self-approval rejection, threshold logic)
- [x] Integration tests: full approval lifecycle (request → approve → execute), rejection flow, emergency bypass, expiry
- [x] Integration tests: change ticket enforcement, APR-15 eligibility enforcement

---

### 8.2 Organization Hierarchy (ORG-01–15)

#### Database

- [x] Add `Organization` model: `id`, `slug`, `name`, `plan`, `oidcConfig` (encrypted Json), `samlConfig` (encrypted Json), `createdAt`, `deletedAt`
- [x] Add `OrganizationMember` model: `organizationId`, `userId`, `role` (`org_admin | org_member`), `createdAt`
- [x] Add `organizationId` nullable FK to `Workspace` model
- [x] Add `OrgApiKey` model: `organizationId`, `keyHash`, `name`, `workspaceScope` (String[]), `moduleScope` (String[]), `createdAt`, `revokedAt`
- [x] Prisma migration: organization tables

#### Registry — Organization Endpoints

- [x] `POST /api/orgs` — create organization
- [x] `GET /api/orgs/:orgSlug` — org details
- [x] `GET /api/orgs/:orgSlug/workspaces` — list all workspaces (part of `GET /api/orgs/:orgSlug`)
- [x] `GET /api/orgs/:orgSlug/audit` — cross-workspace audit log (paginated, filterable) (ORG-09)
- [x] `GET /api/orgs/:orgSlug/modules` — org module catalog across all workspaces (ORG-12)
- [x] Org-level SAML endpoints: `POST /auth/org-saml/:orgSlug/acs`, `GET /auth/org-saml/:orgSlug/metadata` (ORG-06)
- [x] Org-level SCIM: `/scim/v2/orgs/:orgSlug` (ORG-07)
- [x] `WorkspaceConfig` SSO resolution: check workspace-level SSO first; fall back to org-level SSO if workspace has no override

#### Registry — Cross-Workspace Module Sharing

- [x] `PUT /api/workspaces/:slug/modules/:moduleId/shared` — publish module as org-shared (ORG-10)
- [x] Manifest builder: include org-shared modules from other workspaces in the org, tagged with `shared: true` (ORG-11)

#### Dashboard

- [x] **Organization home** page (`/orgs/:orgSlug`) — all workspaces with aggregate health, recent deploys, cross-workspace audit log (ORG-14)
- [x] **Org Module Catalog** (`/orgs/:orgSlug/catalog`) — searchable, filterable by team, module, env (ORG-12)
- [x] **Org SSO Settings** — configure SAML/OIDC once, applies to all workspaces (ORG-05)
- [x] **Org Members** — directory of all users across all workspaces
- [x] Workspace pages move to `/w/:workspaceSlug`; old `/:workspaceSlug/…` URLs redirect there (ORG-15)

#### Test Suite

- [x] Unit tests: org SSO fallback resolution logic, org module catalog query
- [x] Integration tests: org creation, workspace-to-org association, cross-workspace audit log, org-shared module manifest inclusion
- [x] Integration tests: org-level SAML flow end-to-end

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

- [x] `harmoniq plan` — parse `harmoniq.yaml`, diff against registry API, output structured change plan (IaC-10)
- [x] `harmoniq apply` — execute plan: create/update/delete registry resources to match `harmoniq.yaml` (IaC-11)
- [x] `harmoniq import` — call registry API, generate `harmoniq.yaml` from current state (IaC-12)
- [ ] `harmoniq.yaml` JSON Schema published to `schemastore.org` for IDE autocompletion (served at `/api/schema/harmoniq.json` and in `docs/schema/harmoniq.v1.json`; schemastore submission pending)

#### GitLab CI (`harmoniq-ci` — separate repo)

- [ ] GitLab CI component wrapping the CLI (IaC-13)
- [ ] Published to GitLab CI Catalog

#### Test Suite

- [x] Unit tests: `harmoniq plan` diff logic (additions, modifications, deletions, no-ops)
- [x] Integration tests: `harmoniq apply` idempotency (apply twice = no changes on second run)
- [x] Integration tests: `harmoniq import` round-trip (import → plan → no changes)

### Deliverables

- Approval workflows blocking production deploys in regulated envs
- Organization hierarchy live with cross-workspace audit and SSO inheritance
- Terraform provider published to registry.terraform.io
- GitHub Actions action published to Marketplace
- `harmoniq plan` / `harmoniq apply` / `harmoniq import` CLI commands working end-to-end
