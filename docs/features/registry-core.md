# Registry Core

## Overview
The Registry Core implements the Fastify-based backend application responsible for module manifest generation, deployment, and version management. This acts as the control plane for Harmoniq.

## Requirements

| Requirement ID | Status | Description |
|----------------|--------|-------------|
| MAN-01 | Implemented | Manifest endpoint (`GET /api/manifest/:workspaceSlug/:hostAppSlug/:env`) |
| MAN-02 | Implemented | Module deployment endpoint (`POST .../deploy`) |
| MAN-03 | Implemented | API key authentication with `argon2id` and scopes |
| MAN-04 | Implemented | Redis/LRU Cache implementations for Manifest responses |

## Change History

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
