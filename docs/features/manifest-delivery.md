# Feature: Manifest Delivery

> **Requirement IDs:** `IMP-01`–`IMP-06`, `BYOB-07`, `BYOB-08`, `SNAP-01`; product-analysis §5.1, §5.3
> **Status:** `in-progress`
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
