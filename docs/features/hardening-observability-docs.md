# Feature: Hardening, Observability & Documentation

## Overview

This feature completes the MVP phase of the Harmoniq Registry by ensuring it is production-ready. It encompasses security hardening (rate limiting, CSP), performance profiling, observability (OpenTelemetry metrics, structured logging), and comprehensive system documentation.

## Requirements

| ID      | Requirement                                    | Status    |
| ------- | ---------------------------------------------- | --------- |
| SEC-01  | Rate limiting on write/mutation endpoints      | Completed |
| SEC-02  | Strict CSP headers via helmet                  | Completed |
| SEC-03  | Structured logging payload                     | Completed |
| OBS-01  | OTel Metrics for manifest requests and deploys | Completed |
| PERF-01 | Database Index optimizations                   | Completed |
| PERF-02 | Manifest endpoint p99 latency guarantees       | Completed |
| DOC-01  | OpenAPI spec generation                        | Completed |
| DOC-02  | Self-hosting guides                            | Completed |
| DOC-03  | CLI and SDK usage docs                         | Completed |
| CI-01   | Automated CI workflow                          | Completed |

## Architecture Notes

- We deferred Enterprise SSO (OIDC/SAML) and SCIM provisioning to a future enterprise phase.
- Structured logging now utilizes `pino` under the hood, retaining the `ILogger` port interface for inversion of control.
- OpenTelemetry metrics are collected via `@opentelemetry/sdk-metrics` and exposed on the `/metrics` endpoint for Prometheus scraping.
- The manifest benchmark (`apps/registry/scripts/bench-manifest.ts`, `pnpm --filter @harmoniq/registry bench`) runs `autocannon` against an in-process registry with three deployed modules and fails when p99 on a cache hit (200 or 304) exceeds 50 ms. CI runs it for 5 seconds per case.

## Breaking Changes

- The `ConsoleLogger` and `OTelLogger` were consolidated and replaced with `PinoLogger` in the dependency injection container.
- Deployment endpoints and webhook retries now enforce a strict rate limit (`@fastify/rate-limit`).

## Change History

### 2026-10-10 — Manifest benchmark, SDK API reference, core coverage gate

**Type:** chore
**PR / Branch:** feat/m4-enterprise
**Refs:** Phase 6 performance and documentation; Phase 1 core tests

#### What changed

- `pnpm --filter @harmoniq/registry bench`: autocannon on the manifest endpoint (full responses and ETag revalidations), exits 1 when p99 ≥ 50 ms; runs in CI. The earlier entries below describe a Vitest autocannon test that was never added; this replaces it.
- `pnpm --filter @harmoniq/client docs:api`: TypeDoc reference for every SDK entry point (core, React, Vue, Angular, Sentry, Datadog), warnings as errors, in CI. `EventMap`, `EventName` and `Listener` are now exported. The package publishes only `dist` without compiled tests or the generated docs.
- `@harmoniq/core`: tests for every schema with logic, the errors and the manifest formats; coverage thresholds of 90% (statements, branches, functions, lines) in `vitest.config.ts`, checked on every `pnpm test`.

#### Testing

Benchmark locally (Redis cache, 50 connections): p99 9 ms for 200 responses, 6 ms for 304. Core: 69 tests, 95.5% statements, 98% branches, 100% functions.

### 2026-10-10 — Security hardening: dependency upgrades, CSP, write limits, HTTP/2

**Type:** security
**PR / Branch:** feat/m4-enterprise
**Refs:** Phase 6 security hardening, RL-03

#### What changed

- `pnpm audit`: no high or critical advisories in production dependencies (CI now checks `pnpm audit --audit-level high --prod`). Upgrades: Next.js 16.3.8, Fastify 5 (with `@fastify/cors` 11, `helmet` 13, `rate-limit` 11, `swagger` 9, `swagger-ui` 6), nodemailer 10, selfsigned 5, OpenTelemetry SDK 2 / 0.222, Vitest 4, Vite 7 in the example; pnpm overrides for vulnerable transitive packages (`@modelcontextprotocol/sdk`, `proxy-addr`, `brace-expansion`, `@grpc/grpc-js`, `basic-ftp`, `source-map-js`, `sharp`). `shadcn` moved to dev dependencies. Left: `braces` (via changesets) and `extract-zip` (via the example's puppeteer), dev-only with no fixed release.
- Dashboard: per-request nonce Content-Security-Policy from `src/proxy.ts` (`strict-dynamic`, `frame-ancestors 'none'`, `connect-src 'self'`; `upgrade-insecure-requests` only over HTTPS) and `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` on every response. The API reference reads the spec through `/api/openapi` (same origin) without CDN fonts or telemetry.
- Registry: every POST/PUT/PATCH/DELETE route without its own limit gets `HARMONIQ_WRITE_RATE_LIMIT` (300/min per credential, or IP). With Redis, all rate limits (manifests too) are shared across replicas (RL-03).
- Registry: HTTP/2 over TLS with `TLS_CERT_FILE` / `TLS_KEY_FILE` (HTTP/1.1 still accepted).
- CSRF: documented (SameSite=Lax cookies, Origin checks in server actions and POST routes, bearer-only registry).
- Vitest runs only `src` (it no longer ignores compiled tests in `dist`).

#### Testing

`transport.test.ts`: write limit per credential (429 with `Retry-After`), shared limit across two app instances with Redis, HTTP/2 and HTTP/1.1 over TLS. `csp.test.ts` for the policy. Headless Chrome over the login, overview, modules, API keys, quickstart and API reference pages: every script carries the nonce, and the only violations are Scalar's blocked calls to api.scalar.com.

### 2026-10-09 — Working self-hosting: Dockerfiles, demo Compose, image CI

**Type:** feature
**PR / Branch:** feat/m1-core-loop
**Refs:** DX-01, DX-06; product-analysis §5.9 (M1.7)

#### What changed

- `apps/registry/Dockerfile` (also runs migrations) and `apps/web/Dockerfile` (Next.js standalone server with `outputFileTracingRoot` at the repo root).
- `docker/docker-compose.yml`: Postgres/Redis by default; profile `app` adds a one-shot `migrate` (migrations + optional seed), the registry and the dashboard with health-gated startup. `pnpm run docker:demo` / `docker:demo:down`.
- Dashboard reads its public URL at runtime (`APP_URL`; `NEXT_PUBLIC_*` is inlined at build) and its security posture from `HARMONIQ_ENV`, so the production Next server can run the development demo.
- Registry logs a first-boot hint pointing to `/admin/setup`.
- CI builds both images on every push/PR and publishes to GHCR on `v*` tags.
- `docs/self-hosting.md` rewritten for the actual setup (two DB roles, every env var, first boot).

#### Testing

Built both images and ran the demo: migrations, seed, pg-boss and jobs started; all dashboard pages rendered; `scripts/e2e-core-loop.sh` passed against the containerized registry.

#### Known limitations

The registry image (~1.3 GB) ships the full workspace including dev dependencies (needed for migrations and seeding); a slimmer runtime image is a follow-up.

### 2026-09-13 — Build and Lint Remediation

**Type:** bugfix
**Refs:** CI-01, SEC-03, DOC-03

#### What changed

- Standardized TypeScript configuration and resolved TypeScript-ESLint parser compatibility across all monorepo packages.
- Fixed Fastify JWT version mismatch and typed adapters, routes, and background jobs without `any` types.
- Resolved all ESLint rule violations across web, client, registry, cli, db, and core packages.
- Validated clean passes for `pnpm run lint`, `pnpm run build`, and `pnpm test`.

#### Why

Ensure precommit checks and CI pipeline run cleanly with zero lint errors and successful builds.

#### Testing

Executed `pnpm run lint`, `pnpm run build`, `pnpm test`, and `pnpm run format` across the monorepo workspace.

### 2026-09-13 — Phase 6 Completion

**Type:** feature
**Refs:** SEC-01, SEC-02, SEC-03, OBS-01, PERF-01, PERF-02, DOC-01, DOC-02, DOC-03, CI-01

#### What changed

- Added `pino` and `pino-pretty` for structured logging.
- Registered `@fastify/rate-limit` on the deploy and webhook retry routes.
- Configured strict CSP via `@fastify/helmet`.
- Created `metrics.ts` plugin to expose OTel counters (`harmoniq_manifest_cache_hits`, `harmoniq_manifest_cache_misses`, `harmoniq_deploy_count`) to Prometheus on `/metrics`.
- Generated `docs/openapi.json` from the Fastify configuration using `@fastify/swagger`.
- Added a `RemoteModule(workspaceId, slug)` index to Prisma and generated a migration.
- Authored `docs/self-hosting.md`, `docs/sdk.md`, and `docs/cli.md`.
- Authored GitHub Actions `.github/workflows/ci.yml`.
- Added `autocannon` performance test for the manifest endpoint.

#### Why

Before a 1.0 release, it's critical that the server can withstand basic abuse (rate limiting), operators can monitor system health (Prometheus metrics), logs are machine-readable, and new developers have a clear onboarding path (docs).

#### Testing

- Ran the full test suite in the local workspace.
- Added `autocannon` tests mapped to `vitest` to enforce the p99 SLA bounds.
