# Registry Core

## Overview

The Registry Core implements the Fastify-based backend application responsible for module manifest generation, deployment, and version management. This acts as the control plane for Harmoniq.

## Requirements

| Requirement ID | Status      | Description                                                              |
| -------------- | ----------- | ------------------------------------------------------------------------ |
| MAN-01         | Implemented | Manifest endpoint (`GET /api/manifest/:workspaceSlug/:hostAppSlug/:env`) |
| MAN-02         | Implemented | Module deployment endpoint (`POST .../deploy`)                           |
| MAN-03         | Implemented | API key authentication with `argon2id` and scopes                        |
| MAN-04         | Implemented | Redis/LRU Cache implementations for Manifest responses                   |

## Change History

### 2026-10-10 — SSRF guard rewrite; API key revocation applies at once

**Type:** security
**PR / Branch:** feat/m4-enterprise
**Refs:** VAL-02, KEY-02, KEY-05, SSO-25

#### What changed

- The SSRF guard (`services/outbound.ts`) classifies addresses with `ipaddr.js` and allows only public unicast. The previous check let IPv4-mapped IPv6 literals through in the hex form `new URL()` produces (`http://[::ffff:169.254.169.254]/` reached cloud metadata), and missed NAT64, 6to4, Teredo, IPv4-compatible, reserved, benchmarking and multicast ranges.
- Outbound requests to caller-chosen URLs re-check every resolved address at connect time (undici agent and Node agents with a guarded `lookup`): bundle validation, webhooks, workspace and organization OIDC discovery, token, userinfo and JWKS calls, and in production the custom S3 endpoint of a workspace bucket. Redirects are never followed.
- API keys: the cache now only skips the argon2 check. The key row is re-read on every request, so revocation (dashboard, rotation, SCIM deprovisioning, any replica), expiry and scope changes apply to the next request. SCIM deprovisioning didn't clear the cache at all, so revoked keys kept working for up to a minute.

#### Testing

`bundleValidator.test.ts`: the bypass addresses, other embedded-IPv4 forms and reserved ranges; the guarded lookup and fetch refuse internal targets. `tenancy.test.ts`: a cached key revoked directly in the database is refused on the next request.

### 2026-10-09 — M1 core loop: env-aware deploy, rollback, promote, history

**Type:** feature
**PR / Branch:** feat/m1-core-loop
**Refs:** MAN-01–MAN-06, HST-01–HST-04, VER-01–VER-05, PRO-01–PRO-06, SNAP-01–SNAP-05, DIFF-01, AUD-01–AUD-03, ENV-FRZ-01/02/06, KEY-01–KEY-05, MT-03, WHK-01–WHK-10, VAL-02/03/05, RL-01/02/05; product-analysis §4.1–§4.9

#### What changed

- **Manifest contract**: responses match `ManifestSchema` (modules array, `workspaceSlug`, `hostApp` object, `etag`, `variant`, `cohortId`). Strong content-hash ETag identical across replicas; proper `If-None-Match` (weak and lists). Cache-first by URL slugs; last-known-good fallback on database failure (`X-Harmoniq-Stale`). Legacy `/api/manifest/:ws/:env` via `HostApp.isDefault`. `?pretty=true` outside production. Rate limit 600/min per workspace + IP (configurable via `HARMONIQ_MANIFEST_RATE_LIMIT`).
- **One mutation pipeline** (`services/manifestMutation.ts`): freeze check in-transaction → operation → audit event → manifest snapshot → cache refresh → webhooks.
- **Deploy** honours `environment` and persists commit, metadata, dependencies, exposes and storage path. **Rollback** to previous / version / id. **Promote** copies the exact artifact. **Freeze/unfreeze** environments (423 on changes, reads unaffected).
- **Dry-run validation** (reachability, SRI, CORS, content type, projected diff) with an SSRF guard: public HTTPS only, no redirects. Optional on real deploys (`HARMONIQ_VALIDATE_BUNDLES`).
- **History APIs**: audit log with filters, snapshots, snapshot diff.
- **Workspace admin APIs**: workspace creation, host apps, environments, API keys (create/revoke/rotate with grace), members (invite, roles, last-owner protection), webhook endpoints (SSRF-checked URLs, encrypted signing secrets, deliveries, dead letters).
- Errors are thrown as `AppError`s and mapped in one handler.

#### Testing

`coreLoop.test.ts` (13), `workspaceAdmin.test.ts` (11), `bundleValidator.test.ts`, core `bundle.test.ts` / `diff.test.ts`. Cached manifest p99 measured at ~11ms over 2,000 requests (`performance.test.ts` asserts < 50ms).

#### Breaking changes

- Manifest `modules` is an array of `{ name, url, integrity, version, … }` (was an object keyed by name); `timestamp` → `generatedAt`; `hostApp` is an object.
- `POST …/deploy` requires `environment`; module path segment accepts id or slug.
- Webhook event `module.deployed` is now `deploy.success`; every change also emits `manifest.updated`.

### 2026-10-08 — M0 safety: tenant isolation, unified auth, encrypted credentials

**Type:** security fix
**PR / Branch:** feat/m0-safety-foundations
**Refs:** MT-01–MT-05, KEY-01–KEY-05, AUD-04, INST-02, INST-04, BYOB-02, BYOB-03; product-analysis §3.1, §3.3–§3.6, §3.9

#### What changed

- **Cross-tenant access closed.** New `plugins/authenticate.ts` replaces `plugins/auth.ts` and `plugins/adminAuth.ts`. `requireWorkspace(permission)` rejects API keys from other workspaces (403) and non-member users (404); roles and key scopes map to permissions in `auth/permissions.ts`. Module-scoped keys (`ApiKey.moduleIds`) are enforced.
- **API keys** use the `hq_<keyId>_<secret>` format; scopes renamed to `manifest:read`, `deploy:write`, `admin`. Expiry, revocation and rotation grace periods are enforced; verified keys are cached for 60s and `lastUsedAt` is updated at most once a minute.
- **Sessions** are `jose` HS256 access tokens with audience `harmoniq-session`, shared with the dashboard.
- **RLS is now effective.** Schema owner (`harmoniq`, `systemDb`) and tenant role (`harmoniq_app`, `db`) are split; tenant queries run through `withTenant()` in `@harmoniq/db`. RLS added to `Workspace`, `WorkspaceConfig`, `Environment`, `DeploymentApproval`; the audit log is append-only for the tenant role.
- **Fixed migration order:** `add_remote_module_index` ran before `init`, breaking `migrate deploy` on fresh databases.
- **Storage credentials** are validated, encrypted with AES-256-GCM (`HARMONIQ_ENCRYPTION_KEY`) and only ever returned masked. `local` is rejected as a workspace bucket.
- **Config** (`src/config.ts`) refuses to start in production with missing/default `JWT_SECRET` or `HARMONIQ_ENCRYPTION_KEY`. Registry port is 4000 everywhere.
- **CORS** is `*` only for public reads (manifest, health, docs); everything else is limited to `WEB_ORIGIN`.
- **Setup** compares the token in constant time and is single-use via an `InstanceConfig` marker.
- Redis connections are closed on shutdown.

#### Why

Any valid API key could deploy to any workspace, RLS was bypassed (the app role owned the tables), and storage credentials were stored and returned in plaintext.

#### Testing

- `tenancy.test.ts` (18 tests): cross-workspace deploy/upload/DLQ, module-scoped, read-only, revoked/expired/grace-expired keys, non-member and under-privileged users. Verified to fail when the workspace check is removed.
- `rls.test.ts` (7 tests), `storageConfig.test.ts`, `config.test.ts`.
- Fresh-database `prisma migrate deploy` verified end to end.

#### Breaking changes

- Existing dev databases: run `docker/upgrade-roles.sql` once, then `pnpm run db:deploy`. New env var `SYSTEM_DATABASE_URL`.
- API keys must use the new format; `module:write` scope is now `deploy:write`.
- Storage config payload is `{ provider, bucket, region, credentials }`; responses return `maskedCredentials`.
- Until the dashboard moves to the registry API (M1.4), dashboard pages that query Postgres directly as `harmoniq_app` see no workspace data.

### 2026-09-13 — Initial Registry Core Implementation

**Type:** feature
**PR / Branch:** batch-2-registry
**Refs:** MAN-01, MAN-02, MAN-03, MAN-04

#### What changed

- Scaffolded `apps/registry` with Fastify, `@fastify/cors`, `@fastify/helmet`, and `@fastify/rate-limit`.
- Implemented `ICache` and `ILogger` adapters (`InMemoryLRUCache`, `RedisCache`, `ConsoleLogger`, `OTelLogger`).
- Created `/api/manifest/:workspaceSlug/:hostAppSlug/:env` for fetching manifest payload.
- Created `/api/workspaces/:workspaceSlug/modules/:moduleId/deploy` for deploying new versions.
- Added `/health`, `/ready`, and `/metrics` endpoints.
- Integrated `argon2id` API key verification middleware.

#### Why

To build the foundation of the Registry control plane necessary to serve Module Federation manifests and receive module deployments as outlined in Phase 2 of the implementation plan.

#### Testing

- Integration tests in `apps/registry/src/__tests__/registry.test.ts` to verify health checks, manifest fetching, and auth enforcement.

## Architecture Notes

- The application uses `fastify-plugin` for robust dependency injection (DI) attached to `app.container`.
- Caching strategy uses `RedisCache` when `REDIS_URL` and `CACHE_ADAPTER=redis` are configured, falling back to `InMemoryLRUCache`.

## Security Considerations

- API keys are hashed in the database using `argon2id`. The raw keys are not retrievable.
- Endpoints are protected with required scopes (e.g., `module:write`).

## Breaking Changes

None. Initial implementation.
