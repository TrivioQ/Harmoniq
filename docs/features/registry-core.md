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
