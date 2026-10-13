# Harmoniq — Implementation Plan

> **Version**: 1.0.0  
> **Last Updated**: 2026-10-11  
> **Package Manager**: pnpm v9+

---

## Overview

This document breaks the Harmoniq build into sequential phases (0–9). Each phase delivers a shippable, testable increment. Every single feature implemented in any phase MUST include corresponding automated test cases (unit, integration, or E2E) covering happy paths, edge cases, and security boundaries. Phases 1–3 form the **Minimum Viable Product (MVP)**; Phases 4–6 deliver production-grade features; Phases 7–8 add self-hosting and enterprise governance; Phase 9 completes tenant lifecycle and tenant administration ([gap analysis](./multi-tenancy-gap-analysis.md)).

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
- [x] Write unit test suite for all `@harmoniq/core` Zod schemas, DTOs, and AppErrors (>90% coverage; enforced by thresholds in `packages/core/vitest.config.ts`)
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
- [x] Full JSDoc + TypeDoc documentation (`pnpm --filter @harmoniq/client docs:api`, checked in CI)
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

- [x] Benchmark manifest endpoint with `autocannon`: verify p99 < 50ms on cache hit (`pnpm --filter @harmoniq/registry bench`, in CI)
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
- [x] `docs/contributing.md`: contribution guide (Conventional Commits, PR checklist, change-doc rule) (at the root, `CONTRIBUTING.md`, where GitHub shows it)
- [x] OpenAPI spec: auto-generated and committed to `docs/openapi.json`

### Final Checklist

- [x] All phases' integration tests passing in CI
- [x] `pnpm run docker:up` → 5-minute demo working end-to-end
- [x] Apache 2.0 license headers on all source files (SPDX; `pnpm run license:check` in CI)
- [x] GitHub Actions CI: lint + type-check + test on every PR
- [x] GitHub Actions release: changesets → npm publish on merge to main (`.github/workflows/release.yml`; needs the `NPM_TOKEN` secret)

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
- [x] Community-track: `harmoniq-go` + `harmoniq-python` thin clients from OpenAPI spec (OAS-03) (`integrations/clients`, generated by `pnpm run clients:generate`, checked in CI)

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
- [x] `GET /api/admin/health` — DB ping, Redis ping, storage adapter ping, `pg-boss` queue depth, active job count (INST-08)
- [x] `GET /api/admin/workspaces` — all workspaces with usage metrics (modules, members, deploys; storage bytes are USG-02, Phase 9.6)
- [x] `POST /api/admin/workspaces/:slug/suspend` and `/unsuspend` (INST-09)
- [x] `DELETE /api/admin/workspaces/:slug?confirm=<slug>` — hard delete (soft delete and purge: TLC-02/03, Phase 9.2)
- [x] `GET /api/admin/users` — all users with workspace memberships + last login
- [x] `POST /api/admin/users/:id/revoke-sessions` (INST-10)
- [x] `DELETE /api/admin/users/:id?confirm=<email>` — hard delete
- [x] `GET /api/admin/settings` — every setting with secrets **redacted** and its source (database or environment)
- [x] `PUT /api/admin/settings/:key` (and `DELETE` to reset to the environment) — update a setting (secrets sealed before storing)
- [x] `POST /api/admin/settings/storage/test` — connectivity test for the configured default storage adapter
- [x] `POST /api/admin/settings/email/test` — send test email to authenticated admin (INST-12)
- [x] Hot-reload (a 60 s timer per registry rather than a pg-boss cron): `config.reload` (60s interval) refreshes registry's in-memory config snapshot from `InstanceConfig` (INST-17)
- [x] `GET /api/admin/setup` — whether setup is needed (the wizard is served at `/admin/setup` by the dashboard)
- [x] `POST /api/admin/setup` (with `/check` and `/storage` steps) — consume `HARMONIQ_SETUP_TOKEN`, create first admin user, set initial `InstanceConfig` values (INST-01–INST-04)
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
- [x] Integration tests: all `/api/admin/*` endpoints with admin session and with non-admin session (must return 403)

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
| Phase 9 — Tenant & System Admin | 17–20 weeks        | Week 40    |

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

- [x] `PUT /api/workspaces/:ws/host-apps/:hostApp/environments/:env/approval-policy` — create/update policy
- [x] `DELETE /api/workspaces/:ws/host-apps/:hostApp/environments/:env/approval-policy` — remove policy (immediate deploys restored)
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
- [ ] Org-wide approval policy defaults (ORG-08; specified as POL-02, Phase 9.5)
- [x] Org-level SAML endpoints: `POST /auth/org-saml/:orgSlug/acs`, `GET /auth/org-saml/:orgSlug/metadata` (ORG-06)
- [x] Org-level SCIM: `/scim/v2/orgs/:orgSlug` (ORG-07)
- [x] `WorkspaceConfig` SSO resolution: check workspace-level SSO first; fall back to org-level SSO if workspace has no override

#### Registry — Cross-Workspace Module Sharing

- [x] `PUT /api/workspaces/:slug/modules/:moduleId/shared` — publish module as org-shared (ORG-10)
- [x] Manifest builder: include org-shared modules from other workspaces in the org, tagged with `shared: true` (ORG-11)

#### Dashboard

- [x] **Organization home** page (`/orgs/:orgSlug`) — all workspaces with aggregate health, recent deploys, cross-workspace audit log (ORG-14)
- [x] **Org Module Catalog** (`/orgs/:orgSlug/catalog`) — every module with its team, owners and version per env (ORG-12)
- [x] Catalog search, filters and pagination (TAD-07, Phase 9.4)
- [x] **Org SSO Settings** — configure SAML/OIDC once, applies to all workspaces (ORG-05)
- [x] **Org Members** — org members and roles (ORG-04)
- [x] Directory of all users across the org's workspaces with effective access (PPL-03, Phase 9.3)
- [x] Workspace pages move to `/w/:workspaceSlug`; old `/:workspaceSlug/…` URLs redirect there (ORG-15)

#### Test Suite

- [x] Unit tests: org SSO fallback resolution logic, org module catalog query
- [x] Integration tests: org creation, workspace-to-org association, cross-workspace audit log, org-shared module manifest inclusion
- [x] Integration tests: org-level SAML flow end-to-end

---

### 8.3 GitOps / Infrastructure as Code (IaC-01–14)

#### Terraform Provider (`integrations/terraform-provider-harmoniq`; copied to its own repo to publish)

- [x] Scaffold provider using `hashicorp/terraform-plugin-framework`
- [x] Implement resource: `harmoniq_workspace` (CRUD + import) (with an org key with the admin scope)
- [x] Implement resource: `harmoniq_environment` (CRUD + import + `approval_policy` nested block)
- [x] Implement resource: `harmoniq_host_app` (CRUD + import)
- [x] Implement resource: `harmoniq_remote_module` (CRUD + import)
- [x] Implement resource: `harmoniq_api_key` (create + delete; read by id, revoked keys are recreated)
- [x] Implement resource: `harmoniq_webhook_endpoint` (CRUD + import)
- [x] Implement resource: `harmoniq_alert_rule` (CRUD + import)
- [x] Implement resource: `harmoniq_approval_policy` (CRUD + import)
- [x] Data sources: `harmoniq_workspace`, `harmoniq_environment`, `harmoniq_manifest`
- [x] `tfplugindocs` generated docs, published to `registry.terraform.io` (IaC-04) (generated and checked in CI; GoReleaser config and steps for the registry ready, publishing is a maintainer action)
- [x] Unit tests: each resource CRUD using `hashicorp/terraform-plugin-testing` (acceptance test: create, update, no-op plan, import of every resource, destroy; in CI)

#### GitHub Actions (`harmoniq-deploy-action` — separate repo)

- [x] Composite action `harmoniq-dev/deploy-action@v1`: wraps `harmoniq deploy` CLI (IaC-05) (in `actions/deploy`; copied to its own repository to publish)
- [x] Inputs: `api-key`, `registry-url`, `workspace`, `module`, `environment`, `url`, `version`, `integrity`, `dry-run` (IaC-06)
- [x] Outputs: `version-id`, `manifest-url`, `deployed-at` (IaC-07)
- [x] GitHub Actions job summary annotation: deployment card with approval status, diff link (IaC-08)
- [ ] Published to GitHub Marketplace (prepared: branding, README with the publishing steps; publishing is a maintainer action)

#### CLI — Harmoniq-as-Code Commands

- [x] `harmoniq plan` — parse `harmoniq.yaml`, diff against registry API, output structured change plan (IaC-10)
- [x] `harmoniq apply` — execute plan: create/update/delete registry resources to match `harmoniq.yaml` (IaC-11)
- [x] `harmoniq import` — call registry API, generate `harmoniq.yaml` from current state (IaC-12)
- [ ] `harmoniq.yaml` JSON Schema published to `schemastore.org` for IDE autocompletion (served at `/api/schema/harmoniq.json` and in `docs/schema/harmoniq.v1.json`; submission prepared in `integrations/schemastore` — opening the SchemaStore pull request is a maintainer action)

#### GitLab CI (`harmoniq-ci` — separate repo)

- [x] GitLab CI component wrapping the CLI (IaC-13) (`integrations/gitlab`; same inputs and outputs as the GitHub action, IaC-14)
- [ ] Published to GitLab CI Catalog (prepared: catalog layout and the publishing steps in its README; publishing is a maintainer action)

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

---

## Phase 9 — Tenant Lifecycle, Tenant & System Administration

**Goal**: Make organizations and workspaces enterprise-ready across their whole lifecycle: integrity and isolation first, then onboarding and offboarding, the tenant admin dashboard, organization policy, usage and quotas, identity hardening, audit streaming, and the system (instance) administration needed to run a production instance.

**Specification**: [`requirements.md §19`](./requirements.md) · **Design and status**: [`features/tenant-administration.md`](./features/tenant-administration.md) · **Findings**: [`multi-tenancy-gap-analysis.md`](./multi-tenancy-gap-analysis.md)

**Sequencing**: 9.1 ships first (it fixes defects). 9.2 and 9.3 follow and can run in parallel. 9.4 builds on 9.3. 9.5 needs `withOrg` from 9.1. 9.6–9.10 are independent of each other once 9.1 lands, except that 9.10 uses the lifecycle actions of 9.2 and the usage data of 9.6. Each sub-phase is one or more pull requests with its migration, tests, feature doc entry and changeset.

| Sub-phase                                        | Requirements                                                        | Estimate  | Depends on |
| ------------------------------------------------ | ------------------------------------------------------------------- | --------- | ---------- |
| 9.1 Integrity & isolation (M5.1)                 | MT-07–MT-11, TLC-05, DOM-01–DOM-05, PPL-04, PPL-05, INST-23–INST-25 | 3.5 weeks | —          |
| 9.2 Tenant lifecycle (M5.2)                      | TLC-01–TLC-04, TLC-06–TLC-08, AUD-05                                | 2 weeks   | 9.1        |
| 9.3 People & invitations (M5.3)                  | PPL-01–PPL-03, PPL-06–PPL-08                                        | 2 weeks   | 9.1        |
| 9.4 Tenant admin dashboard (M5.4)                | TAD-01, TAD-04–TAD-08, AUD-07, AUD-08                               | 2 weeks   | 9.3        |
| 9.5 Organization policy (M5.5)                   | POL-01–POL-09, TAD-03 (completes ORG-08)                            | 2.5 weeks | 9.1        |
| 9.6 Usage, quotas & plans (M5.6)                 | PLN-04–PLN-06, USG-01–USG-04, MT-12, TAD-02 (completes INST-09)     | 2 weeks   | 9.1        |
| 9.7 Identity & session security (M5.7)           | SES-01–SES-04                                                       | 1.5 weeks | 9.1        |
| 9.8 Audit streaming & notifications (M5.8)       | AUD-06, AUD-09, TAD-09, TAD-10                                      | 1.5 weeks | 9.1        |
| 9.9 Operator security & automation (M5.9)        | INST-26, INST-31–INST-35                                            | 2 weeks   | 9.1, 9.7   |
| 9.10 System admin dashboard & operations (M5.10) | INST-19–INST-22, INST-27–INST-30, INST-36–INST-39                   | 3 weeks   | 9.2, 9.6   |

### 9.1 Integrity & Isolation (M5.1)

#### Database

- [x] Migration `20261011130000_org_rls`: RLS on `Organization` (by `id`), `OrganizationMember`, `OrgApiKey`, `OrganizationAuditEvent` (by `app.current_org_id`); `ScimUser`, `ScimGroup`, `ScimAuditEvent` and `VerifiedDomain` also admit the current organization's rows (MT-07)
- [x] Workspace-scoped policies also admit `"workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', true), ','))`, so an org transaction reads exactly its own workspaces (MT-08, ADR-010)
- [x] `VerifiedDomain` model: `domain`, `organizationId?` / `workspaceId?` (exactly one, CHECK), `token` (public: it's in DNS), `verifiedAt?`, `verifiedDomain?` (unique: one verified owner per domain), `lastCheckedAt?`, `failingSince?`, `createdBy`; RLS on `workspaceId` (migration `20261011120000_verified_domains`) (DOM-01/02)
- [x] MT-11: the production registry refuses to start while the app role accepts the placeholder password (`services/dbRoleCheck.ts`). The applied migration stays unchanged: editing it would make `prisma migrate dev` reset existing databases

#### Registry

- [x] `withOrg(client, orgId, fn)` in `@harmoniq/db` (and `container.withOrg`): sets `app.current_org_id`, then resolves `app.current_org_workspace_ids` inside the same transaction (the `Workspace` policy admits the org's rows) (MT-07/08)
- [x] `routes/orgs.ts`, `routes/orgSso.ts`, `services/orgShared.ts`, org SCIM (`routes/scim.ts`) and org SSO provisioning run in `withOrg`; attach runs in the workspace's `withTenant`; `systemDb` stays for tenant resolution, creating tenants, the user's own memberships and sessions (MT-09)
- [x] ESLint `no-restricted-syntax` on `systemDb` in `apps/registry/src/routes`: files that span tenants (`admin`, `auth`, `saml`, `scim`) disable it at the top with the reason, other uses are marked per line; `gitops` moved to `withTenant` (MT-09)
- [x] TLC-05: org admins may assign `owner` in their org's workspaces (`assertCanAssign`); `requireWorkspace` treats org admins as owners while a workspace has no joined owner; `POST /api/orgs/:org/workspaces` accepts `owners: string[]` (invitations)
- [x] Terraform `harmoniq_workspace.owners` attribute, applied at creation (TLC-05; acceptance test with Terraform 1.16)
- [x] PPL-04: `DELETE /api/orgs/:org/members/:id` shares the SCIM deprovisioning routine (`removeFromWorkspaces`, covering every workspace of the org) (workspace memberships, keys created in the org's workspaces unless `?keepKeys=true`, org-SSO sessions); the response lists what was removed
- [x] PPL-05: `DELETE /api/workspaces/:ws/members/:id?keepKeys=true|false` (default revoke)
- [x] Domains: `GET/POST /api/orgs/:org/domains`, `POST …/domains/:domain/verify`, `DELETE …/domains/:domain` (and the same under `/api/workspaces/:ws/domains` for standalone workspaces); DNS TXT lookup of `_harmoniq-challenge.<domain>`; instance admins list and release claims (`/api/admin/domains`) (DOM-01/02)
- [x] SSO discovery by `VerifiedDomain` lookup (during the grace period also an unverified domain exactly one tenant lists); OIDC and SAML configs load only the trusted domains the tenant may use (`Domains.usableTrustedDomains`), which also stops another tenant's domain from making emails "verified" (DOM-03/04)
- [x] pg-boss `domains.recheck` (daily; checks domains last checked six days ago and failing ones): re-resolve TXT, set `failingSince`, unverify after 14 days, audit in the instance and owner logs (DOM-05; notifications come with TAD-09)
- [x] Lockout guard (`InstanceSettings.adminSignInAfter`, checked by `PUT /api/admin/settings/auth`): refuse a value with which no instance admin, or the caller, could sign in; name other admins it locks out (INST-23)
- [x] Recovery CLI `apps/registry/scripts/harmoniq-admin.ts` (`pnpm --filter @harmoniq/registry admin …`; in the image `npx tsx scripts/harmoniq-admin.ts`): `grant-admin`, `reset-setting`, `revoke-sessions`, `list-admins`; system-actor audit events (INST-24)
- [x] `/metrics`: `HARMONIQ_METRICS_TOKEN` bearer check, workspace label only with `HARMONIQ_METRICS_TENANT_LABELS=1`, production warning without a token (INST-25)
- [x] `/metrics` on a separate port (`HARMONIQ_METRICS_PORT`); Helm `registry.metricsPort` (chart 0.3.0), token through `registry.extraEnvFrom`

#### Dashboard

- [x] Org and workspace SSO pages: verified domains list with the TXT record to add, Verify button, grace-period warning for unverified trusted domains
- [x] Org member removal: confirmation says workspaces, keys and sessions go too, "keep their API keys" option, result lists what was removed
- [x] Workspace member removal: "keep their API keys" checkbox (keys are revoked by default)
- [x] Members page offers the `owner` role to org admins (TLC-05); admin settings warn about admins a sign-in change locks out (INST-23)

#### Test Suite

- [x] `rls.test.ts`: organization scope (own rows, own workspaces, no writes into another organization, nothing in workspace or unscoped queries, no context left on the pool, detaching)
- [x] `tenantIsolation.test.ts`: two organizations; every GET route of the OpenAPI document as org A's admin and org key, no org B identifier in any response, no 5xx, B's routes `403`/`404`, B's shared module not in A's manifests (MT-10)
- [x] Ownerless workspace (`ownerlessWorkspace.test.ts`): org admin assigns an owner, freeze override and module sharing work afterwards
- [x] Org member removal (`offboarding.test.ts`): memberships, keys and sessions gone; `keepKeys`; last owner kept; workspace member removal revokes keys
- [x] Domain verification (`domains.test.ts`): TXT match and mismatch, uniqueness across tenants, discovery ignores unverified domains, grace period, recheck failure path
- [x] Placeholder role password detected (`dbRoleCheck.test.ts`)
- [x] Lockout guard (`adminLockout.test.ts`) and recovery commands (`adminRecovery.test.ts`)
- [x] `/metrics` with and without the token, empty and short tokens, no workspace label by default (`metricsAccess.test.ts`)

### 9.2 Tenant Lifecycle (M5.2)

#### Database

- [x] `Workspace`: `deletedAt`, `purgeAfter`, `deletedBy`; `Organization`: `purgeAfter`, `suspendedAt`, `suspendedReason`; `OrganizationAuditEvent` and `ScimAuditEvent` lose their org FK (migration `20261011150000_tenant_lifecycle`)
- [x] `AuditEvent`, `ScimAuditEvent`: cascading foreign keys to `Workspace` dropped (migration `20261011140000_audit_outlives_workspace`; organizations are soft-deleted, so `OrganizationAuditEvent` keeps its key) (AUD-05, ADR-011)
- [x] ~~`ModuleVersion.storageBackend`~~ not needed: the purge deletes bundle keys from the workspace's bucket and the instance storage
- [x] ~~`TenantExport` model~~ not needed: exports stream as JSON Lines (no job, no stored file)
- [x] `OwnershipTransfer` model (workspace or organization, CHECK one scope, RLS like SCIM rows; migration `20261011160000_ownership_transfers`)

#### Registry

- [x] `DELETE /api/workspaces/:ws?confirm=<slug>` for workspace owners (TLC-01)
- [x] Soft delete (`services/tenantLifecycle.ts`) for every delete path (owner, org admin or org key, instance admin): `deletedAt`/`purgeAfter`, `410 WORKSPACE_DELETED` from `requireWorkspace`, manifests `410 Gone` (no last-known-good), published copies removed, shared modules unshared, slug reserved; `HARMONIQ_TENANT_RESTORE_DAYS=0` purges at once (TLC-02)
- [x] `POST /api/workspaces/:ws/restore` (owners, org admins), `POST /api/admin/workspaces/:slug/restore`, `POST /api/admin/orgs/:slug/restore` (an organization's admins lose access when it is deleted, so instance admins restore it) (TLC-02)
- [x] pg-boss `tenant.purge` (hourly, `purgeDueTenants`): workspaces past `purgeAfter` through `deleteWorkspace` (bundles, published copies, rows; audit kept), audited as `instance.workspace_purged` (TLC-03)
- [x] Organization soft delete (`purgeAfter`) and purge once it has no workspaces; slug released (`instance.org_purged`) (TLC-03)
- [x] `POST /api/admin/orgs/:slug/suspend` / `unsuspend`; `requireWorkspace` refuses changes in a suspended organization's workspaces (users and org keys, `403 ORGANIZATION_SUSPENDED`) and `requireOrg` refuses non-GET org routes (TLC-04)
- [x] Ownership transfer: `POST /api/workspaces/:ws/transfer`, `POST /api/orgs/:org/transfer`, `GET /api/transfers`, `POST /api/transfers/:id/accept|cancel`; the sender steps down to admin / org_member; 7-day expiry (TLC-06)
- [x] Exports: `GET /api/workspaces/:ws/export` (admins), `GET /api/orgs/:org/export` (org admins): streamed JSON Lines (header, workspace, config, members, modules, versions, audit; organization, org members, key metadata, org audit, then each live workspace), each export audited (TLC-07)
- [x] Instance setting `tenancy` (`creation: anyone | verified_domains | instance_admins`, `allowedDomains`) enforced in `POST /api/orgs` and `POST /api/workspaces`; org admins still create workspaces in their organization (TLC-08)
- [x] GC `gc.auditRetention` (daily): events of deleted workspaces older than `HARMONIQ_AUDIT_RETENTION_DAYS` are removed (AUD-05)
- [x] `GET /api/admin/workspace-audit/:workspaceId/export`: a deleted workspace's audit log for instance admins (AUD-05)
- [x] Until soft delete: `deleteWorkspace` collects bundle keys and published paths, deletes the rows, then the objects in the workspace's bucket and the instance storage (best effort, counted in the deletion's audit event) (TLC-03, gap analysis P0-3)
- [x] `@harmoniq/client`: a `410` manifest already falls back like `404` with backoff; covered by a test, no release needed

#### Dashboard

- [x] Workspace settings danger zone: delete (type the slug) for owners
- [x] Transfer ownership (workspace danger zone, org members page); incoming transfers with accept and decline on the home page; export downloads (workspace settings, org audit page)
- [x] Deleted workspaces you own on the home page (`/api/me` `deletedWorkspaces`), with restore and the purge date; org home shows deleted workspaces with restore, and delete (type the slug)
- [ ] Org settings danger zone (with 9.4): delete, restore, transfer, exports in one place
- [x] Admin panel: org suspend/unsuspend and restore, workspace restore and deletion status; `/admin/auth` creation policy

#### Test Suite

- [x] Soft delete, restore, 410s for users, keys and (cached) manifests, `/api/me` (`tenantLifecycle.test.ts`)
- [x] Purge and immediate purge (`tenantLifecycle.test.ts`, `workspaceDeletion.test.ts`)
- [x] Org suspension (`tenantLifecycle.test.ts`)
- [x] Transfer: accept, cancel, decline, expiry, replacement, recipient only (`transfersExports.test.ts`)
- [x] Export: contents, permissions, no key secrets, deleted workspaces left out (`transfersExports.test.ts`)
- [x] Creation policy, every mode (`tenancyPolicy.test.ts`)

### 9.3 People & Invitations (M5.3)

#### Database

- [x] `Invitation` model: `workspaceId?` / `organizationId?` (CHECK one), `email`, `role`, `tokenHash` (unique), `invitedBy`, `expiresAt`, `acceptedAt?`, `acceptedBy?`, `revokedAt?`, `lastSentAt?`; RLS like SCIM rows (migration `20261011170000_invitations_access_requests`)
- [x] Data migration: pending `WorkspaceMember` rows become invitations (lowercased email, same role, 7-day expiry, accepted by signing in) and are deleted; verified in a rolled-back transaction
- [x] `AccessRequest` model (workspace RLS, also the org's workspaces)
- [x] `OrgRole` adds `org_billing`, `org_auditor` (PPL-08)

#### Registry

- [x] `POST /api/workspaces/:ws/invitations` (and `POST …/members`, same behaviour), `GET`, `POST …/:id/resend`, `DELETE …/:id`; `POST /api/orgs/:org/invitations` likewise (`POST /api/orgs/:org/members` still adds existing users at once); owners invited at org workspace creation become invitations (PPL-01)
- [x] Invitation email through `IMailer` with the instance name and the accept link (`acceptUrl` also returned to the inviter); `GET /api/invitations/:token` (public, rate-limited), `POST /api/invitations/:token/accept` (same verified email, session must reach the tenant); signing in with the invited email also accepts (PPL-02)
- [x] `authService.login` accepts only invitations the new session can reach (`invitationScope.test.ts`): an SSO-scoped sign-in accepts invitations to its own workspace (or its organization's workspaces), not every pending one (PPL-02, gap analysis P1-9)
- [x] `GET /api/orgs/:org/people?query=&workspace=&cursor=&limit=`: org role, workspace roles with source, implicit org-admin access, SCIM state, last sign-in, keys created; pending invitations (PPL-03)
- [x] Workspace members response adds implicit org admins (`id: null`, `source: "org_admin"`) and lists invitations separately (`invitations`) (PPL-06)
- [x] `POST /api/workspaces/:ws/access-requests` (org members only, one pending), `GET`, `POST …/:id/approve|deny` (never owner); org home reports `yourRole` and `accessRequested` per workspace (PPL-07; webhook event and admin notification come with TAD-09/10)
- [x] `requireOrg('auditor')`: org audit and export, People, SSO, provisioning and SCIM reads open to `org_auditor`; `org_billing` reads like a member until usage lands (9.6) (PPL-08)

#### Dashboard

- [x] Invitations on the workspace members page and the org People page: pending list, resend (shows the new link), revoke, expiry; invite forms show the link
- [x] `/invite/:token` page (public): what the invitation is for, accept when signed in with that email, otherwise how to
- [x] "Request access" on the org home for workspaces you're not in; access-request queue with approve (role) / deny on the workspace members page; org People page; new roles in the org members page; Audit and People in the nav for auditors
- [ ] "Request access" from the org catalog (with the catalog work in TAD-07)

#### Test Suite

- [x] Invitation lifecycle (`people.test.ts`): email sent, link accepted by the invited email only, once; resend replaces the link; expiry; revoke; owner invitations limited
- [x] Data migration of pending memberships (SQL run against seeded rows in a rolled-back transaction)
- [x] People directory: roles and sources, implicit admins, invitations, search, paging, `org_member` refused
- [x] Access requests: org members only, duplicates refused, approve with another role, deny audited
- [x] Org auditor: audit, SSO, provisioning, People readable; keys and changes refused

### 9.4 Tenant Admin Dashboard (M5.4)

#### Registry

- [x] Audit responses add `actor` (`{ type, id, label }`: email, or key name and prefix, or `deleted user #<hash>`) for workspace, org and instance logs (AUD-07)
- [x] Org audit filter by actor email; workspace audit gains the same filters as the org audit (AUD-08)
- [x] Org keys: `POST /api/orgs/:org/keys/:id/rotate` with grace period (`OrgApiKey.gracePeriodEnd`), `createdBy` in the list, `unused` flag (90 days) (TAD-05)
- [x] `GET /api/orgs/:org` paginated (`cursor`, `query`) with `suspended`, `frozenEnvironments` and `pendingApprovals` per workspace (TAD-06)
- [x] `GET /api/orgs/:org/modules?query=&workspace=&environment=&shared=&cursor=` and `GET …/modules/:id/consumers` (TAD-07)

#### Dashboard

- [x] `/orgs/:org/settings` — rename, plan and features, verified domains, danger zone (TAD-01)
- [x] `/orgs/:org/people` — directory, invitations, access requests (TAD-04)
- [x] Org keys page: expiry, module scope picker, rotate, creator, unused warning (TAD-05)
- [x] Org home: search, pagination, delete workspace (slug confirmation), suspended and frozen badges, pending approvals panel (TAD-06)
- [x] Catalog: search, filters, pagination, consumers drawer (TAD-07)
- [x] Audit pages (org, workspace, instance): actor labels, actor and date filters, metadata drawer (AUD-07/08)
- [x] Shared app shell: org/workspace switcher, breadcrumbs, user menu (sessions, sign-out) in org, workspace and admin layouts (TAD-08) (sessions entry: the account page, 9.7)
- [x] `messages/en.json` and `messages/es.json` for every new string

#### Test Suite

- [x] Registry: actor labels including erased users and keys; org key rotation grace period; paginated org home and catalog filters
- [x] Dashboard: pages render for `org_admin`, `org_member`, `org_auditor`, `org_billing` with the right controls (against a dev registry, as for M4.7): admins get every page, auditors audit, people, SSO and provisioning, other roles 404 on admin pages

### 9.5 Organization Policy (M5.5)

#### Database

- [x] `OrgPolicy` model (one per organization): `approvalDefaults` (Json: `[{ environmentPattern, requiredApprovers, eligibleRoles, requireChangeTicket, ticketUrlPattern, expiryHours }]`), `maxApiKeyDays?`, `allowedKeyScopes[]`, `minRetentionDays?`, `freezeWindows` (Json), `lockSso`, `sessionMaxHours?`, `idleTimeoutMinutes?`, `ipAllowlist[]`, `ipAllowlistManifests`, `updatedAt`, `updatedBy`; org RLS (readable from the org's workspaces). `requireMfa` moves to SES-03 (9.7), with MFA itself

#### Registry

- [x] `GET/PUT /api/orgs/:org/policy` with field-level before/after audit (`org.policy_updated`) (POL-01)
- [x] `services/policy.ts`: effective policy (instance → org → workspace, strictest wins) with sources; `GET /api/workspaces/:ws/policy` (POL-09)
- [x] Approval gate: when no stricter workspace policy exists, apply the org default matching the environment slug; workspace `PUT …/approval-policy` rejects weaker policies (`409 POLICY_VIOLATION`) (POL-02, ORG-08)
- [x] Key creation and rotation (workspace and org): enforce `maxApiKeyDays` and `allowedKeyScopes`; `policyViolations` on key lists (POL-03)
- [x] `PATCH /api/workspaces/:ws` and `harmoniq.yaml` apply: refuse `retentionDays` below the floor (POL-04)
- [x] `isFrozen` includes org freeze windows by environment pattern; org admin override endpoint with ENV-FRZ-03 audit metadata (POL-05)
- [x] Workspace SSO save refused while `lockSso`; `effectiveSso` ignores workspace SSO when locked (POL-06)
- [x] Refresh: enforce `sessionMaxHours` / `idleTimeoutMinutes` for users whose memberships are in the org (most restrictive) (POL-07)
- [x] IP allowlist check in `requireWorkspace` / `requireOrg` (users and keys); manifest and health routes only when `ipAllowlistManifests`; honours `trustProxy`; saving a list that excludes the caller is refused; manifests checked from memory, refreshed every 30 s (POL-08)
- [x] GitOps: `harmoniq.yaml` plan shows policy violations before apply

#### Dashboard

- [x] `/orgs/:org/policies`: sections per policy, effective values, workspaces stricter than the org (TAD-03)
- [x] Workspace settings show inherited values with their source and lock icons

#### Test Suite

- [x] Policy resolution matrix (instance, org, workspace) for every field
- [x] Approval defaults applied to a workspace with no policy; weaker workspace policy refused; GitOps path
- [x] Key policy on create and rotate for workspace and org keys
- [x] Org freeze on matching environments only; override audited
- [x] Locked SSO; session lifetime and idle timeout at refresh; IP allowlist with and without proxies

### 9.6 Usage, Quotas & Plans (M5.6)

#### Database

- [x] `UsageDaily` model: `workspaceId`, `day`, `manifestRequests` (BigInt), `deploys`, `healthEvents`, `storageBytes` (BigInt), `members`, `apiKeys`; `@@id([workspaceId, day])`; RLS (USG-01)
- [x] `ModuleVersion.sizeBytes BigInt?` (USG-02)
- [x] `WorkspaceConfig` / `Organization`: `planOverrides Json?`, `planExpiresAt DateTime?`, `basePlan String?` (PLN-06)

#### Registry

- [x] `services/usage.ts`: per-replica counters flushed every 60 s with `INSERT … ON CONFLICT DO UPDATE SET x = x + excluded.x` (ADR-012); manifest route counts every request including 304s and cache hits (USG-01)
- [x] Deploy records `sizeBytes`: measured by server-side validation when it runs, else as the uploader reports it (`sizeBytes` in the deploy body; no `HEAD` of arbitrary URLs, which would be an SSRF path); nightly `usage.snapshot` job sums storage, members and keys and drops rows after 13 months (USG-02)
- [x] `Quotas` service next to `Plans`: `HARMONIQ_PLAN_LIMITS`, overrides, `require(workspace, quota, delta)`; called by org workspace creation and attach, invitations and access approvals (seats: members plus pending invitations; SSO, SCIM and group-rule provisioning are not refused), module, environment (preview environments excluded) and webhook creation, deploy and promote (monthly), and GitOps plans; `402 QUOTA_EXCEEDED` (PLN-04/05)
- [x] `GET /api/orgs/:org/usage`, `GET /api/workspaces/:ws/usage`, `GET /api/admin/usage` (JSON and CSV) (USG-03)
- [x] Instance admin: `PUT /api/admin/{workspaces,orgs}/:slug/plan` accepts `overrides` and `expiresAt`; pg-boss `plans.expire` (hourly) (PLN-06)
- [x] `plan.changed`, `quota.warning` (80%), `quota.exceeded`: audited and sent to the workspace's webhooks; org-level webhook delivery comes with TAD-10 (9.8) (USG-04)
- [x] Management, deploy and health-ingest rate limits keyed by workspace (or organization, for org routes) with plan tiers (`HARMONIQ_API_RATE_LIMIT*`, `HARMONIQ_DEPLOY_RATE_LIMIT*`, `HARMONIQ_HEALTH_RATE_LIMIT*`); writes outside a tenant stay per credential (MT-12)
- [x] `/api/admin/workspaces` returns `storageBytes` (INST-09)

#### Dashboard

- [x] `/orgs/:org/usage` and workspace settings usage card: usage vs quota bars, 30/90-day trends, CSV (TAD-02)
- [x] Quota warnings in the shell at 80%; `QUOTA_EXCEEDED` errors explain the limit
- [x] Admin panel: usage page, storage column, plan overrides and expiry form

#### Test Suite

- [x] Counter flush correctness under concurrency; manifest 304s counted
- [x] Every quota on its route, with enforcement off (unlimited) and on; overrides; expiry downgrade job
- [x] Usage API permissions (`org_billing` can read; `org_member` can't)
- [x] Per-tenant rate limits keyed correctly for workspace and org keys

### 9.7 Identity & Session Security (M5.7)

#### Database

- [x] `User`: `suspendedAt?`, `suspendedReason?`, `mfaSecretSealed?`, `mfaEnabledAt?`, `mfaRecoveryCodes String[]` (hashed)
- [x] `RefreshToken`: `userAgent?`, `ip?`, `mfaVerified` (session list; last use is the newest token of the session); `OrgPolicy.requireMfa`

#### Registry

- [x] Instance setting `auth.session` (`maxDays`, `idleMinutes`) replacing `REFRESH_TOKEN_TTL_MS` (SES-01)
- [x] `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `DELETE /api/me/sessions` (others; `?includeCurrent=true`); access tokens carry the session id and stop within 15 s of the session ending (SES-02)
- [x] TOTP: `POST /api/me/mfa/setup`, `POST /api/me/mfa/enable` (upgrades the current session), `DELETE /api/me/mfa`, `POST /api/me/mfa/recovery-codes`; a challenge and `POST /api/auth/mfa/verify` after sign-ins without tenant SSO; `requireMfa` from org policy refuses unverified non-SSO sessions in the org's workspaces and org routes (`403 MFA_REQUIRED`); `DELETE /api/admin/users/:id/mfa` resets a lost factor (SES-03)
- [x] `POST /api/admin/users/:id/suspend` / `unsuspend`: refuse sign-in and refresh, reject access tokens (checked in `resolveSession`, which already loads the user), keys created by the user refused (SES-04)

#### Dashboard

- [x] Account page: sessions, MFA setup with QR code and recovery codes
- [x] Admin users page: suspend and unsuspend, suspended badge

#### Test Suite

- [x] Session lifetime and idle timeout; org policy shortens only
- [x] Session list and revocation scoped to the user
- [x] TOTP enrolment, verification window, recovery code single use, `requireMfa` enforcement, SSO sign-ins exempt
- [x] Suspension: sign-in, refresh, live access token and created keys all refused; unsuspend restores

### 9.8 Audit Streaming & Notifications (M5.8)

#### Database

- [x] `AuditSink` model: `organizationId`, `kind` (`https` | `s3`), `name`, `config` (sealed), `cursorAt`, `cursorId`, `failures`, `lastError?`, `lastDeliveredAt`, `enabled`; `AuditSinkDeadLetter`
- [x] `AuditEvent`, `OrganizationAuditEvent`, `InstanceAuditEvent`: `chainSeq`, `prevHash`, `hash`, set by the `harmoniq_audit_chain` trigger; existing rows backfilled (AUD-09)
- [x] `OrgWebhookEndpoint`, `OrgWebhookDelivery`, `OrgWebhookDeadLetter` (org RLS; delivered by the WHK engine through a table adapter); `NotificationChannel`: `organizationId`, `kind` (`email` | `slack` | `teams`), `name`, `target` (incoming-webhook URLs sealed), `events[]`, `lastSentAt`, `lastError`

#### Registry

- [x] `GET/POST/PATCH/DELETE /api/orgs/:org/audit-sinks`, `POST …/:id/test`, dead letters and resend; pg-boss `audit.stream` (every minute) reading by keyset cursor, batches of 500 (HMAC-signed for HTTPS), S3 objects per hour named by their first event, resent until accepted, dead-lettered after 10 failures; new sinks start from now unless `backfill` (AUD-06)
- [x] Hash chain computed on insert per scope in a database trigger (advisory lock per scope, so every insert path is covered); `GET …/audit/verify` for workspaces, organizations and the instance; chain fields in exports; `services/auditChain.ts` recomputes hashes outside the database (AUD-09)
- [x] Org webhooks with the WHK delivery engine (`org-webhook.deliver`) and events `org.member.*`, `org.workspace.*`, `org.key.*`, `org.policy.updated`, `quota.*`, `plan.changed`; org route events are sent only once the request succeeds (TAD-10)
- [x] Notification dispatcher (`notify.send`, retried): email via `IMailer`, Slack and Teams incoming webhooks through the outbound guard; also `deploy.approval_requested` and `domain.verification_lost`; a test message per channel (TAD-09)

#### Dashboard

- [x] `/orgs/:org/integrations`: audit sinks (status, last delivery, test), webhooks, notification channels; audit trail verification on the audit pages

#### Test Suite

- [x] Streaming: at-least-once with a failing sink, cursor resume, S3 object layout, HMAC
- [x] Hash chain: tamper detection in verify, concurrent inserts keep a single chain
- [x] Org webhooks and notifications for each event type

### 9.9 Operator Security & Automation (M5.9)

#### Database

- [x] `InstanceAdmin.role` (`instance_owner` | `instance_operator` | `instance_support` | `instance_billing`; existing grants become `instance_owner`); `InstanceAdminInvitation` (email, role, expiry; accepted by the next sign-in with that email that isn't a tenant's SSO) (INST-31)
- [x] `InstanceApiKey`: `name`, `keyHash`, `prefix`, `scopes[]`, `expiresAt?`, `lastUsedAt?`, `createdBy`, `revokedAt?` (INST-33)
- [x] `InstanceConfigVersion`: `key`, `version`, `value` (sealed), `createdAt`, `createdBy`, `source` (INST-35)
- [x] Sealed envelopes gain `kid` (the first 8 hex of the key's sha256); values without one are opened by whichever configured key authenticates them (INST-26)

#### Registry

- [x] Keyring: `HARMONIQ_ENCRYPTION_KEYS=label:base64,…` (first is active; `HARMONIQ_ENCRYPTION_KEY` stays as the single-key form and, next to the list, as an extra old key); `encryptJson` / `sealSecret` write `kid`; decryption picks the key by `kid`, an unknown `kid` fails closed (INST-26)
- [x] pg-boss `secrets.reseal` (on demand: `POST /api/admin/encryption/reseal`, `harmoniq-admin reseal-secrets`): re-seals `WorkspaceConfig`, `Organization`, `WorkspaceStorageConfig`, `InstanceConfig`, `RefreshToken.ssoRefreshToken`, webhook and org webhook secrets, notification channels, audit sinks and MFA secrets; `GET /api/admin/encryption` and health report values on non-active or unknown keys (INST-26)
- [x] `requireInstanceAdmin` with a role → capability map (`services/adminAccess.ts`): every role reads, listed writes need their capability, any other write is owner-only; `POST /api/admin/admins` accepts `role` and invites unknown emails; `PATCH …/admins/:userId` changes a role; one active instance owner always remains (INST-31)
- [x] Step-up: `POST /api/auth/reauth` (a TOTP or recovery code) and every sign-in set the `rat` claim; destructive admin routes require it within 10 minutes (`403 REAUTH_REQUIRED`); admin session cap (`auth.session.adminMaxHours`, default 12); admins need MFA or instance OIDC (`HARMONIQ_ADMIN_REQUIRE_MFA`, default on in production); optional `HARMONIQ_ADMIN_IP_ALLOWLIST` (INST-32)
- [x] Instance API keys: `GET/POST/DELETE /api/admin/api-keys`; `hq_inst_` parsing in `authenticate.ts`; `instance:read` for GET admin routes, `instance:admin` for the rest (but not admins or keys); refused on every route outside `/api/admin`; changes made with them are audited as the key (INST-33)
- [x] Settings keys `plans`, `rateLimits`, `gc` (versions kept, default retention, health-event and rollup retention), `bundles` in `InstanceSettingsSchemas` (`tenancy` and `auth.session` already were), read through `InstanceSettings` on each use by `Plans`, the rate limiter, deploys, health ingest, workspace creation and GC jobs, with env fallback (INST-34)
- [x] Settings versions on every save, restore, import and reset; `GET /api/admin/settings/:key/history` (changed fields, secrets never shown), `POST …/history/:version/restore`; `GET /api/admin/settings/export` and `PUT /api/admin/settings/import` (YAML, secrets excluded, dry-run diff by default) (INST-35)
- [x] Terraform provider: `harmoniq_instance_setting`, `harmoniq_workspace_plan` and `harmoniq_organization_plan` (with instance keys; `GET /api/admin/{workspaces,orgs}/:slug/plan` added for them). No `harmoniq_instance_admin`: instance keys can never manage admins or keys (INST-33), so admins stay in the panel

#### Dashboard

- [x] `/admin/admins`: role picker, pending invitations, role badges; navigation hides what the role can't do (`/api/me` returns `instanceAdmin: { role, capabilities }`; owner-only pages leave the nav)
- [x] Re-authentication dialog before destructive actions (a `REAUTH_REQUIRED` refusal makes `ActionForm` ask for a TOTP or recovery code, then the action is submitted again; without MFA, sign in again)
- [x] `/admin/api-keys` page; `/admin/settings` pages for the new keys with source badges (database or environment); history drawer with diff and restore; export and import (`/admin/settings/:key`: JSON editor for `plans`, `rateLimits`, `gc`, `bundles`; versions with changed fields and restore for every key)
- [x] Encryption page: active key id, values per key, "re-seal now"

#### Test Suite

- [x] Keyring: decrypt legacy and new envelopes, rotate, re-seal job idempotent, unknown `kid` fails closed
- [x] Role → capability matrix over every `/api/admin` route
- [x] Step-up window, admin session cap, IP allowlist with `trustProxy`
- [x] Instance keys: scopes, expiry, revocation, refused on workspace and org routes
- [x] Terraform acceptance test for settings and plans with an instance key (drift from the panel shows as a diff; CI completes the first-boot setup to get one)
- [x] New settings take effect without restart and on other replicas (as `instanceSettings.test.ts`); history, restore and import dry-run

### 9.10 System Admin Dashboard & Operations (M5.10)

#### Database

- [x] `SupportGrant`: `adminUserId`, `organizationId?` / `workspaceId?`, `reason`, `expiresAt`, `revokedAt?` (INST-20)
- [x] `ReplicaHeartbeat`: `replicaId`, `version`, `commit`, `startedAt`, `lastSeenAt`, `configLoadedAt` (INST-28)
- [x] `SignInEvent`: `userId?`, `email`, `method`, `success`, `reason?`, `ip`, `createdAt` (90-day GC) (INST-39)
- [x] `EmailDelivery`: `to`, `template`, `status`, `error?`, `createdAt` (30-day GC); `InstanceConfig` keys `announcement`, `maintenance`, `emailTemplates` (INST-22, INST-37, INST-38)

#### Registry

- [x] `GET /api/admin/orgs?query=&cursor=`, `GET /api/admin/orgs/:slug` (workspaces, members, plan, usage, SSO and domains), with the 9.2 actions (INST-19) (`routes/adminDirectory.ts`; offset cursors so every sort pages)
- [x] `POST /api/admin/support-grants`, `DELETE …/:id`; `requireWorkspace` / `requireOrg` admit an active grant read-only; events in both audit logs; `GET /api/workspaces/:ws` reports active grants (INST-20) (`GET /api/orgs/:org` too; a new `support` capability for owners, operators and support; `403 SUPPORT_READ_ONLY` for changes)
- [x] `/api/admin/users` adds org memberships and suspension; CSV export for users and workspaces (INST-21)
- [x] `PUT /api/admin/settings/announcement`; `GET /api/instance` returns the active announcement (INST-22) (`level`, `startsAt`, `endsAt`)
- [x] `GET /api/admin/overview`: 30-day trends from `UsageDaily` and counts, and the attention list (publish errors, dead letters, failed jobs, `WorkspaceStorageConfig` verification failures, SAML certificates expiring, alert rules with `lastError`, quota breaches, failing domains) (INST-27) (a daily `storage.verify` job and the BYOB test record `lastVerifyError`; active users are distinct users whose session was refreshed that day)
- [x] Replica heartbeat every 30 s; `GET /api/admin/health` adds version, commit, pending migrations (`_prisma_migrations` vs. the bundled list), replicas; `GET /api/admin/jobs` (schedules, last run, last success and failure per queue), `GET /api/admin/jobs/failed`, `POST /api/admin/jobs/:id/retry`, `POST /api/admin/jobs/:queue/run` for maintenance queues (INST-28) (build, migrations and replicas at `GET /api/admin/system`; the daily `ops.retention` job purges the email and sign-in logs)
- [x] `GET /api/admin/workspaces/:slug` detail; list `status`, `plan`, `org`, `inactiveDays`, `sort` parameters (INST-29)
- [x] `GET /api/admin/users/:id` detail with identities, memberships, sessions (`DELETE …/sessions/:id`), keys and activity; list filters; `POST /api/admin/users/:id/email` (verification email) and `POST /api/admin/users/:id/merge` (moves identities, memberships, keys; audited) (INST-30) (the email change waits for the new address to confirm: `POST /api/auth/email-change`)
- [x] `GET /api/admin/audit` filters (`action`, `actor`, `resource`, `from`, `to`) and actor labels; `GET /api/admin/audit/search?actor=` across workspace, org and instance logs, audited (INST-36) (`resource`, `resourceType`; instance keys get readable labels)
- [x] Maintenance mode: `PUT /api/admin/settings/maintenance` (`from`, `until`, `message`); writes `503 MAINTENANCE` with `Retry-After`, manifests and health served (INST-37) (`/api/admin`, `/api/auth`, `/api/me`, health reports and `/api/instance` stay writable)
- [x] Mailer decorator recording `EmailDelivery`; per-template subject and intro overrides (INST-38)
- [x] `SignInEvent` written by every sign-in path; `GET /api/admin/security` (failed sign-ins by IP and email, rate-limited tenants from the limiter, revoked/expired key attempts, SCIM errors) (INST-39) (rejected keys are `api_key` events with the key prefix; 429s are counted per workspace in `UsageDaily.rateLimited`)

#### Dashboard

- [ ] `/admin` overview: trend charts, attention list, recent instance audit (INST-27)
- [ ] `/admin/health`: system info, replicas, migrations; `/admin/jobs`: schedules, failed jobs with retry, run now (INST-28)
- [ ] `/admin/workspaces/:slug` and `/admin/users/:id` detail pages; filters and sorting on both lists; delete and merge move to the detail pages (INST-29, INST-30)
- [ ] `/admin/orgs` list with search and pagination, `/admin/orgs/:slug` detail with suspend, delete and restore (INST-19)
- [ ] Support-grant dialog; tenant banner while a grant is active (INST-20)
- [ ] Audit page filters, actor labels, metadata drawer, cross-tenant actor search (INST-36)
- [ ] Announcement and maintenance editor; global banner (INST-22, INST-37)
- [ ] `/admin/email`: delivery log and template overrides (INST-38); `/admin/security` (INST-39)
- [ ] `messages/en.json` and `messages/es.json` for every new string

#### Test Suite

- [x] Org admin pages and API permissions per admin role
- [x] Support grant: read-only, expiry, revocation, visible to tenant, audited in both logs
- [x] Overview attention items, one fixture per item type
- [x] Jobs: failed job listed and retried, run-now limited to maintenance queues
- [x] Replica heartbeats and pending-migration detection
- [x] User email change and merge (identities, memberships, keys, sessions), audited
- [x] Audit filters and cross-tenant search permissions
- [x] Maintenance mode: writes 503, reads and manifests served, scheduled start and end
- [x] Email delivery log and template overrides; sign-in events and security page aggregates
- [x] CSV exports; announcement scheduling

### Deliverables

- No known cross-tenant, offboarding or data-retention defects (9.1, 9.2)
- Organizations administered end to end from `/orgs/:org` without instance-admin help
- Organization policies enforced across every workspace, including approval defaults (ORG-08)
- Usage metering and numeric plan quotas for hosted offerings
- MFA, session policies and audit streaming for security reviews
- A system admin panel that shows what needs attention, runs and retries jobs, rotates secrets, delegates by role, supports automation, and can't lock its admins out
- Feature doc [`tenant-administration.md`](./features/tenant-administration.md) updated per sub-phase; `docs/openapi.json`, `api-reference.md`, `database-schema.md`, Terraform provider docs and `self-hosting.md` (new environment variables) updated with each PR
