# Feature: Manifest Delivery

> **Requirement IDs:** `IMP-01`–`IMP-06`, `BYOB-07`, `BYOB-08`, `SNAP-01`; product-analysis §5.1, §5.3
> **Status:** `implemented`
> **Phase:** M2

How host apps get their manifest without depending on the registry being up.

---

## Overview

Every manifest change (deploy, rollback, promote, module update) is **published to storage**: `manifests/{workspace}/{hostApp}/{env}.json` and `importmaps/{workspace}/{hostApp}/{env}.json`, with `Cache-Control: public, max-age=30, stale-while-revalidate=300`. Host apps can read those copies from a CDN, so a registry outage no longer takes production down.

The registry also serves the same content in three formats: the Harmoniq manifest, a standard **import map** and a **Native Federation** manifest.

## Requirements

| ID       | Requirement                                   | Status  |
| -------- | --------------------------------------------- | ------- |
| `IMP-01` | `GET /api/importmap/:ws/:hostApp/:env`        | ✅ Done |
| `IMP-02` | `{ imports }` (plus `integrity`)              | ✅ Done |
| `IMP-03` | Module `specifier` maps to the import-map key | ✅ Done |
| `IMP-04` | ETag + `If-None-Match`                        | ✅ Done |
| `IMP-05` | Public, rate limited like manifests           | ✅ Done |
| `IMP-06` | Invalidated with the manifest                 | ✅ Done |
| —        | Published copies in storage/CDN               | ✅ Done |
| —        | SDK reads CDN copy with registry fallback     | 📋 M2.2 |

## Architecture Notes

- `services/manifestPublisher.ts` builds and writes both files. The mutation pipeline enqueues a `manifest.publish` pg-boss job after every committed change (one per environment per 2s burst, 5 retries with backoff); without a job queue it publishes inline.
- **Where:** the workspace's own bucket when configured (prefixed by `pathPrefix`, public URL from `cdnPrefix`), otherwise the instance default: `STORAGE_ADAPTER=local` (development default, served by the registry at `/static/*`), `s3` (`S3_BUCKET`, `S3_REGION`, credentials, optional `S3_ENDPOINT`/`S3_PUBLIC_URL`) or `none`.
- **Status:** `Environment.lastPublishedEtag/At/Error`, shown in `GET /api/workspaces/:ws` with the public URLs. Failures emit the `manifest.publish_failed` webhook and never fail the change itself; `POST …/environments/:env/publish` re-publishes on demand.
- Import-map and federation ETags derive from the manifest ETag, and both formats share the manifest's cache and last-known-good fallback.
- Changing a module's `specifier` (`PATCH /api/workspaces/:ws/modules/:module`) re-snapshots and republishes every environment of its host app.

## Breaking Changes

None.

---

## Change History

### 2026-10-10 — Manifest endpoint robustness

**Type:** bug fix, performance, security
**PR / Branch:** feat/m4-enterprise
**Refs:** MAN-05, MAN-06, HST-02, CAN-02, RL-01

#### What changed

- A malformed `harmoniq_canary` cookie (bad percent-encoding) is treated as no user key. It returned 500.
- The legacy endpoint (`/api/manifest/:ws/:env`) caches which host app it serves and then takes the canonical path, so it is served from the cache and has the last-known-good fallback. It rebuilt from the database on every request and returned 500 during an outage.
- Concurrent cache misses for the same manifest or canary variant share one build per replica.
- "Not found" is cached for 10 seconds under the manifest key, so deploys, new environments, host apps and workspaces clear it.
- Not-found answers are limited per client IP across all workspaces (`HARMONIQ_MANIFEST_MISS_LIMIT`, default 120 per minute, then 429 with `Retry-After`). The per-workspace limit gave every made-up slug a fresh quota. Requests from a limited IP skip the plan lookup, and the plan cache is now a bounded LRU.
- **Breaking (manifest content):** module `metadata` no longer carries `deployedBy`, an internal user or API key id on a public endpoint. History and audit APIs still have it. Every manifest's ETag changes once.

#### Testing

`manifestLimits.test.ts`: per-IP miss limit without database lookups, cached not-found cleared by a new environment, one build for eight concurrent misses (fails without the deduplication), malformed cookie. `coreLoop.test.ts`: legacy endpoint served from the cache and stale during an outage. `canary.test.ts`: malformed cookies.

### 2026-10-09 — Example and e2e: Vite + Module Federation 2.0

**Type:** test/example
**PR / Branch:** feat/m2-delivery
**Refs:** report §5.1, §5.3; plan M2 verification

#### What changed

- `examples/vite-mf`: two `@module-federation/vite` remotes deployed by `@harmoniq/build-plugin`, a host using `@harmoniq/mf-plugin`, and a CDN stand-in. `e2e.mjs` (puppeteer-core, headless Chrome) checks deploy, live upgrade and rollback, registry and CDN outages (CDN copy → persisted copy → bundled fallback) and `?harmoniq-override=`. Runs in CI.
- `@harmoniq/mf-plugin` fix: re-registered remotes keep their configured settings. They were re-registered as `{ name, entry }`, which dropped `type: 'module'`. Because the client's first manifest load also emits `manifestUpdate`, ES module remotes (e.g. `@module-federation/vite` builds) failed to load at all, not only after a deploy.

#### Testing

`pnpm --filter @harmoniq-example/vite-mf e2e` against a local registry: 12/12 checks pass. New mf-plugin unit test for the preserved remote type.

### 2026-10-09 — Multi-replica guard and AWS deployment

**Type:** infra
**PR / Branch:** feat/m2-delivery
**Refs:** report §5.9, DX-01

#### What changed

- The registry warns at startup when it runs in production with the in-memory cache, which is only correct with one replica.
- S3 storage works without static keys (AWS default credential chain, e.g. an ECS task role); setting only one of the key pair is a config error.
- `scripts/bootstrap-db.ts` (`pnpm --filter @harmoniq/registry db:bootstrap`) creates or re-passwords the app role from `DATABASE_URL` using the owner connection, for managed databases. It refuses to run when both URLs use the same role.
- `deploy/terraform/aws`: ECS Fargate (registry, dashboard, one-off migrate task), ALB with host-based routing, RDS Postgres, ElastiCache Redis (TLS), private S3 bucket behind CloudFront (OAC) for published manifests, Secrets Manager.

#### Testing

`config.test.ts` covers keyless S3 and half key pairs. `bootstrap-db.ts` was run against the local database (create, re-password, refusal with the owner role). `terraform validate` passes (hashicorp/terraform 1.9); the module has not been applied to a live AWS account.

### 2026-10-09 — Example: import maps without a bundler

**Type:** docs/example
**PR / Branch:** feat/m2-delivery
**Refs:** IMP-01, SRI-01

#### What changed

`examples/import-map`: a static HTML host that inlines Harmoniq's import map (browsers don't load external import maps) and imports `@example/greeting`; a tiny CORS static server as the CDN; `demo.sh setup | deploy <v> | rollback`.

#### Testing

Run in headless Chrome against a live registry: the host showed 1.0.0, then 2.0.0 after a deploy, then 1.0.0 after a rollback, all without changing the host; a tampered remote was refused by the browser's SRI check.

### 2026-10-09 — Module Federation 2.0 runtime plugin (M2.4)

**Type:** feature
**PR / Branch:** feat/m2-delivery
**Refs:** SRI-04; product-analysis §5.3

#### What changed

New package `@harmoniq/mf-plugin`: a Module Federation runtime plugin that rewrites remote entries from the Harmoniq manifest in `beforeRequest`, hot-swaps remotes on manifest updates, and creates remote entry scripts with `integrity`/`crossorigin`. Attaches to the MF instance from `beforeRequest` as well as `beforeInit` (the latter can run before plugins are registered).

#### Testing

`plugin.test.ts` (6) runs the real `@module-federation/runtime` 2.9 hook chain: static and Harmoniq-only remotes, name mapping, strict mode, hot swap and SRI script creation.

### 2026-10-09 — SDK survives registry outages (M2.2)

**Type:** feature
**PR / Branch:** feat/m2-delivery
**Refs:** product-analysis §5.1

#### What changed

`@harmoniq/client` tries `sources` in order (`cdnBaseUrl` → CDN copy, then registry) with per-source ETags, persists the last good manifest (`localStorage` by default), and on a cold start with every source down uses the persisted copy or a bundled `fallbackManifest`, emitting `manifestStale`. Polling keeps retrying and switches back to the network copy when a source recovers.

#### Testing

5 new client tests (CDN first, registry fallback, persisted boot and recovery, bundled fallback, wrong-environment copy ignored). Verified against a running registry reading the `/static` copy.

### 2026-10-09 — Published manifests, import maps, Native Federation (M2.1, M2.3)

**Type:** feature
**PR / Branch:** feat/m2-delivery
**Refs:** IMP-01–IMP-06, BYOB-07/08

#### What changed

Everything described above, plus `LocalStorageAdapter` (atomic writes, path-traversal protection) and `put()` on the S3/GCS adapters. Migration adds publish status to `Environment` and `specifier` to `RemoteModule`.

#### Testing

`delivery.test.ts` (10): files written on deploy and on specifier change, `/static` headers and traversal protection, publish status, import map/federation content and ETags, failed publishes recorded without failing the deploy. Verified the pg-boss path against a running registry.
