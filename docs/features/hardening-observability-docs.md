# Feature: Hardening, Observability & Documentation

## Overview
This feature completes the MVP phase of the Harmoniq Registry by ensuring it is production-ready. It encompasses security hardening (rate limiting, CSP), performance profiling, observability (OpenTelemetry metrics, structured logging), and comprehensive system documentation.

## Requirements
| ID | Requirement | Status |
|---|---|---|
| SEC-01 | Rate limiting on write/mutation endpoints | Completed |
| SEC-02 | Strict CSP headers via helmet | Completed |
| SEC-03 | Structured logging payload | Completed |
| OBS-01 | OTel Metrics for manifest requests and deploys | Completed |
| PERF-01 | Database Index optimizations | Completed |
| PERF-02 | Manifest endpoint p99 latency guarantees | Completed |
| DOC-01 | OpenAPI spec generation | Completed |
| DOC-02 | Self-hosting guides | Completed |
| DOC-03 | CLI and SDK usage docs | Completed |
| CI-01 | Automated CI workflow | Completed |

## Architecture Notes
- We deferred Enterprise SSO (OIDC/SAML) and SCIM provisioning to a future enterprise phase.
- Structured logging now utilizes `pino` under the hood, retaining the `ILogger` port interface for inversion of control.
- OpenTelemetry metrics are collected via `@opentelemetry/sdk-metrics` and exposed on the `/metrics` endpoint for Prometheus scraping.
- Performance tests use `autocannon` programmatically in the Vitest suite to ensure that local cache-hit latency remains under our p99 SLA.

## Breaking Changes
- The `ConsoleLogger` and `OTelLogger` were consolidated and replaced with `PinoLogger` in the dependency injection container.
- Deployment endpoints and webhook retries now enforce a strict rate limit (`@fastify/rate-limit`).

## Change History

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
