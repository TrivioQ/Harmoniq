# Feature: Progressive Delivery

> **Requirement IDs:** `CAN-01` – `CAN-10`, `HLT-*`, `ALT-*`, `STG-*`, `DEP-*`
> **Status:** `in-progress`
> **Phase:** M3

Ship a new module version to a share of users first, watch it, then widen or stop it, without touching the host app. M3 builds this up in steps: canary releases (M3.1), health reporting, alerts and auto-rollback, staged rollouts, targeting and kill switches, and a dependency gate before deploys.

---

## Overview

A canary is a module version that runs next to the active (stable) one in an environment, for a percentage of users. Each user gets a stable cohort; the registry decides per module whether that cohort is in the canary, so a user keeps seeing the same variant and raising the percentage only adds users. Promote makes the canary the active version for everyone; abort sends everyone back.

## Requirements

| ID       | Requirement                                                     | Status                                |
| -------- | --------------------------------------------------------------- | ------------------------------------- |
| `CAN-01` | Canary status with `trafficPercent` 1–99                        | ✅ Done                               |
| `CAN-02` | Sticky server-side assignment from `X-Harmoniq-User-Id`, cookie | ✅ Done (cookie read only; see notes) |
| `CAN-03` | Separate cache key for canary variants                          | ✅ Done (one key per set of canaries) |
| `CAN-04` | Promote / roll back via dashboard or CLI                        | ✅ Done                               |
| `CAN-05` | Change traffic without redeploying                              | ✅ Done                               |
| `CAN-06` | `variant` in every manifest                                     | ✅ Done                               |
| `CAN-07` | `cohortId`: opaque, derived from a hash, not the user id        | ✅ Done                               |
| `CAN-08` | `X-Harmoniq-Variant` and `X-Harmoniq-Cohort-Id` headers         | ✅ Done                               |
| `CAN-09` | SDK exposes `variant` and `cohortId`                            | ✅ Done                               |
| `CAN-10` | SDK emits `variantAssigned` on first assignment and on change   | ✅ Done                               |
| `HLT-*`  | Health ingest and aggregation                                   | 📋 Planned (M3.2)                     |
| `ALT-*`  | Alerts and auto-rollback                                        | 📋 Planned (M3.4)                     |
| `STG-*`  | Staged rollouts                                                 | 📋 Planned (M3.5)                     |
| `DEP-*`  | Dependency and contract gate                                    | 📋 Planned (M3.7)                     |

See [`docs/requirements.md §5.4`](../requirements.md).

## Architecture Notes

- **Data.** A canary is a `ModuleVersion` with `status = canary` and `trafficPercent`. At most one per module and environment; it needs an active version. A normal deploy ends it; rollback leaves it alone; GC never touches it.
- **Assignment.** `cohortId = sha256(workspaceId:userKey)[0..16]`; a user is in a module's canary when `sha256(cohortId:moduleId) mod 100 < trafficPercent`. Hashing per module keeps canaries of different modules independent. The user key is `X-Harmoniq-User-Id`, else a `harmoniq_canary` cookie.
- **Caching.** The cached stable manifest carries the running canaries (not part of the public body), so assignment needs no database on a cache hit. Each set of canary modules a user can get is built once and cached under `manifest:{ws}:{host}:{env}:canary-<hash of version ids>`, at most 2^n per environment; invalidation already clears every variant. The per-user `cohortId` is set on the response, and canary responses are `Cache-Control: private`.
- **Pipeline.** Canary start, traffic changes, promote and abort run through `ManifestMutations` like every other change: freeze check (423), audit event, snapshot of the stable manifest, cache refresh, webhooks, CDN publish.
- **CDN and import maps** stay stable-only: a CDN can't vary by user, and browsers load import maps without custom headers. The SDK therefore asks the registry first whenever it has a user id, and falls back to the CDN.

### Deviation: `harmoniq_canary` cookie (CAN-02)

CAN-02 asks the registry to fall back to a `harmoniq_canary` cookie. Hosts fetch manifests cross-origin without credentials (public, `Access-Control-Allow-Origin: *`), so browsers don't send such a cookie, and third-party cookies are increasingly blocked anyway. The registry reads the cookie when a request carries it (same-site deployments behind a reverse proxy) but does not set it. For everyone else the SDK's `anonymousCanary` option keeps a random id in `localStorage` and sends it as `X-Harmoniq-User-Id`, which gives the same stickiness.

## Breaking Changes

YES (pre-1.0): `CanaryConfigSchema` was removed from `@harmoniq/core` in favour of `SetCanaryRequestSchema` and `CanaryActionRequestSchema`; it was not used by any API.

---

## Change History

### 2026-10-09 — Canary releases (M3.1)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** CAN-01 – CAN-10

#### What changed

- Registry: `deploy` with `canary: { trafficPercent }`; `PUT …/canary` (traffic, or restart an earlier version as the canary), `POST …/canary/promote`, `POST …/canary/abort`; webhooks `canary.started`, `canary.updated`, `canary.promoted`, `canary.rolled_back`. Module list shows each environment's canary.
- Manifest route: sticky per-user, per-module assignment with variant caching; `Vary`, `Cache-Control: private` for canary responses. Public reads now expose `ETag` and the variant headers to cross-origin hosts. Before this, browsers hid `ETag`, so the SDK never revalidated with a 304.
- SDK: `userId`, `anonymousCanary`, `setUserId()`; the user id goes only to registry URLs, and the registry is asked before the CDN while one is set.
- CLI: `deploy --canary <percent>`, `canary set-traffic | promote | abort`. `run()` resets subcommand options between calls (commander kept them on the singleton commands).
- Dashboard: canary panel on the module page (traffic, promote, abort), "Start canary" on earlier versions, canary badge in the module list.

#### Testing

`canary.test.ts` (registry): ±3% split over 10k users at 1/10/50/90%, stickiness when traffic rises, independent modules, variant cache keys, header/cookie keys; API flow covering the 409 without an active version, per-user variants and headers, ETags per variant, CORS exposure, traffic change, listing, abort, restart and promote, a normal deploy ending the canary, audit events and the 423 under a freeze. SDK and CLI unit tests. The dashboard panel was exercised in headless Chrome against a local registry: list badge, traffic update, abort, start from a version row, promote.
