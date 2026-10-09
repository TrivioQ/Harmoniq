# Feature: Progressive Delivery

> **Requirement IDs:** `CAN-01` – `CAN-10`, `HLT-*`, `ALT-*`, `STG-*`, `DEP-*`
> **Status:** `implemented`
> **Phase:** M3

Ship a new module version to a share of users first, watch it, then widen or stop it, without touching the host app. M3 builds this up in steps: canary releases (M3.1), health reporting, alerts and auto-rollback, staged rollouts, targeting and kill switches, and a dependency gate before deploys.

---

## Overview

A canary is a module version that runs next to the active (stable) one in an environment, for a percentage of users. Each user gets a stable cohort; the registry decides per module whether that cohort is in the canary, so a user keeps seeing the same variant and raising the percentage only adds users. Promote makes the canary the active version for everyone; abort sends everyone back.

## Requirements

| ID       | Requirement                                                     | Status                                                  |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `CAN-01` | Canary status with `trafficPercent` 1–99                        | ✅ Done                                                 |
| `CAN-02` | Sticky server-side assignment from `X-Harmoniq-User-Id`, cookie | ✅ Done (cookie read only; see notes)                   |
| `CAN-03` | Separate cache key for canary variants                          | ✅ Done (one key per set of canaries)                   |
| `CAN-04` | Promote / roll back via dashboard or CLI                        | ✅ Done                                                 |
| `CAN-05` | Change traffic without redeploying                              | ✅ Done                                                 |
| `CAN-06` | `variant` in every manifest                                     | ✅ Done                                                 |
| `CAN-07` | `cohortId`: opaque, derived from a hash, not the user id        | ✅ Done                                                 |
| `CAN-08` | `X-Harmoniq-Variant` and `X-Harmoniq-Cohort-Id` headers         | ✅ Done                                                 |
| `CAN-09` | SDK exposes `variant` and `cohortId`                            | ✅ Done                                                 |
| `CAN-10` | SDK emits `variantAssigned` on first assignment and on change   | ✅ Done                                                 |
| `HLT-*`  | Health ingest and aggregation                                   | 📋 Planned (M3.2)                                       |
| `ALT-*`  | Alerts and auto-rollback                                        | 📋 Planned (M3.4)                                       |
| `STG-*`  | Staged rollouts                                                 | 📋 Planned (M3.5)                                       |
| `DEP-01` | `dependencies` map on manifest modules                          | ✅ Done (sent by the build plugin from MF `shared`)     |
| `DEP-02` | 422 with a conflict report on incompatible ranges               | ✅ Done (also on promote, and against host shared deps) |
| `DEP-03` | `--force` bypass audited as `module.deploy_forced`              | ✅ Done                                                 |
| `DEP-04` | Dependency matrix per environment in the dashboard              | ✅ Done                                                 |
| `DEP-05` | CLI prints conflicts to stderr before failing                   | ✅ Done                                                 |

See [`docs/requirements.md §5.4`](../requirements.md).

## Architecture Notes

- **Data.** A canary is a `ModuleVersion` with `status = canary` and `trafficPercent`. At most one per module and environment; it needs an active version. A normal deploy ends it; rollback leaves it alone; GC never touches it.
- **Assignment.** `cohortId = sha256(workspaceId:userKey)[0..16]`; a user is in a module's canary when `sha256(cohortId:moduleId) mod 100 < trafficPercent`. Hashing per module keeps canaries of different modules independent. The user key is `X-Harmoniq-User-Id`, else a `harmoniq_canary` cookie.
- **Caching.** The cached stable manifest carries the running canaries (not part of the public body), so assignment needs no database on a cache hit. Each set of canary modules a user can get is built once and cached under `manifest:{ws}:{host}:{env}:canary-<hash of version ids>`, at most 2^n per environment; invalidation already clears every variant. The per-user `cohortId` is set on the response, and canary responses are `Cache-Control: private`.
- **Pipeline.** Canary start, traffic changes, promote and abort run through `ManifestMutations` like every other change: freeze check (423), audit event, snapshot of the stable manifest, cache refresh, webhooks, CDN publish.
- **Health.** Host apps post load outcomes to a public, rate-limited endpoint; only versions live in the environment are accepted, and the variant is derived from the version (a client can't mislabel canary data). Raw events (24 h) answer the 5-minute window queries; a job rolls them up hourly every 5 minutes (30 days) for sparklines. The live-version lookup is cached for 30 s per replica and re-read when a report names an unknown version, so a fresh canary's first reports aren't dropped.
- **Alerts.** `alert.evaluate` runs every minute (pg-boss runs a schedule once across replicas). A rule needs `minSamples` in its window to decide; it fires on the `ok` → `firing` change only, respects a cooldown, and resolves when the metric recovers or the data runs out. Auto-rollback goes through `ManifestMutations` as actor `system`, so it is frozen-environment-aware, audited, snapshotted and published like any change.
- **Staged rollouts.** The schedule lives on the canary (`rolloutSchedule`, `currentBandIndex`, `bandStartedAt`). `rollout.advance` scans every minute rather than scheduling one delayed job per band, so a restart or a lost job never strands a rollout and a freeze simply pauses it. Each gate check covers the loads of the band that just ran. A band-index check inside the transaction keeps a manual advance and the job from both acting on the same band.
- **Targeting.** Rules live on the canary version (`targeting`) and are cached with the running canaries, so matching needs no database. A match puts the user in the canary before the percentage is considered; without a user key only targeting applies. `X-Harmoniq-Context` is parsed defensively (size and key limits; bad input is ignored, never an error) and is part of `Vary`.
- **Kill switch.** `ModuleEnvState` per module and environment; the manifest keeps the module (so hosts can tell "disabled" from "missing") with `disabled` and a reason, and the derived import-map and federation formats drop it. It runs through the mutation pipeline (audit, snapshot, CDN publish) with `ignoreFreeze`, the one change allowed in a frozen environment.
- **Scheduled operations.** A schedule stores the exact API call (validated with the route's schema) and runs it with `fastify.inject` as its creator: the request carries a per-process random secret and the creator's id, and the authenticate plugin reloads that user or key from the database, so membership, scopes, module scoping, revocation, freezes, audit and webhooks behave exactly as for a manual call. Claiming uses `FOR UPDATE SKIP LOCKED`, so each operation runs once across replicas.
- **Dependency gate.** `findDependencyConflicts` (core, `semver.intersects`) compares only the incoming module against the rest, so an existing conflict between two other modules never blocks an unrelated deploy; the check runs inside the mutation transaction, against the state it will change. Canaries are left out of the matrix: a user gets a module's canary or its active version, never both.
- **CDN and import maps** stay stable-only: a CDN can't vary by user, and browsers load import maps without custom headers. The SDK therefore asks the registry first whenever it has a user id, and falls back to the CDN.

### Deviation: `harmoniq_canary` cookie (CAN-02)

CAN-02 asks the registry to fall back to a `harmoniq_canary` cookie. Hosts fetch manifests cross-origin without credentials (public, `Access-Control-Allow-Origin: *`), so browsers don't send such a cookie, and third-party cookies are increasingly blocked anyway. The registry reads the cookie when a request carries it (same-site deployments behind a reverse proxy) but does not set it. For everyone else the SDK's `anonymousCanary` option keeps a random id in `localStorage` and sends it as `X-Harmoniq-User-Id`, which gives the same stickiness.

## Breaking Changes

YES (pre-1.0): `CanaryConfigSchema` was removed from `@harmoniq/core` in favour of `SetCanaryRequestSchema` and `CanaryActionRequestSchema`; it was not used by any API.

---

## Change History

### 2026-10-09 — Dependency and contract gate (M3.7)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** DEP-01 – DEP-05

#### What changed

- Deploys and promotes are checked against the environment's active modules and the host app's `sharedDependencies` (new); conflicts return 422 with a report, `force` deploys anyway (`module.deploy_forced`). Removed exposes warn, or block with `HostApp.strictExposes` (new). Dry runs report the gate.
- `GET …/environments/:env/dependencies` and a dashboard Dependency Matrix page (conflicts in red).
- CLI `--force` and conflict lines on stderr; the build plugin sends `dependencies` from `mf-manifest.json` `shared`.

#### Testing

`dependencies.test.ts` (core: compatible and conflicting ranges, invalid ranges, matrix de-duplication, removed exposes); `dependencyGate.test.ts` (422 report, dry run, forced deploy audit, host shared deps and their validation, the matrix, removed exposes with and without `strictExposes`, promote). CLI and build-plugin tests. The matrix page was rendered in headless Chrome with a forced conflict.

### 2026-10-09 — Scheduled operations (M3.6)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** report §5.7

#### What changed

- `ScheduledOperation` table (RLS); `GET/POST/DELETE …/scheduled-operations`; the `schedule.run` job (every minute); audit and webhooks `schedule.executed` / `schedule.failed`.
- Internal run-as authentication for in-process calls (random per-process secret; principal reloaded from the database).
- CLI `--at` on deploy, promote, rollback, canary and kill-switch commands; `harmoniq schedule list|cancel`.
- Dashboard "Scheduled" page with cancel; audit lines.

#### Testing

`scheduled.test.ts`: validation, a deploy run once at its time as its creator, cancel and the cancel/claim race, a frozen environment failing a deploy but not a kill switch, access re-checked at run time (removed member, module-scoped and revoked API keys), forged internal headers rejected. CLI tests. On a running registry: a CLI deploy scheduled 5 s ahead ran through the real pg-boss job; the dashboard listed and cancelled operations. That run also caught a CommonJS crash (a top-level `module` constant) that unit tests don't see.

### 2026-10-09 — Kill switch (M3.6)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** report §5.7

#### What changed

- `PUT …/modules/:ref/kill-switch` (reason required, works when frozen), `ModuleEnvState` table (RLS), `disabled` / `disabledReason` in the manifest and JSON Schema, disabled modules dropped from import maps and federation manifests; webhooks `module.disabled` / `module.enabled`.
- SDK: `getModuleEntry` returns null for disabled modules, `isModuleDisabled`, `moduleDisabled` event; React/Vue/Angular expose `disabled`; disabled modules aren't health-reported. `@harmoniq/mf-plugin` refuses disabled remotes.
- CLI `harmoniq disable` / `enable`; dashboard kill-switch control, banner and list badge.

#### Testing

`killSwitch.test.ts` (reason and role checks, every manifest format, freeze bypass, audit and webhook, re-enable), SDK, adapter, plugin and CLI tests. The `examples/vite-mf` e2e disables a remote and checks the host renders without it. Dashboard controls exercised in headless Chrome.

### 2026-10-09 — Canary targeting (M3.6)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** report §5.7

#### What changed

- Canary targeting rules (`{ attribute, values }`, attribute `userId` or a context key) on deploy and `PUT …/canary`; a 0% canary is allowed with rules. Targeting is cleared when the canary ends or is promoted.
- Manifest route reads `X-Harmoniq-Context`; SDK `context` option and `setContext()`; CLI `--target`; the canary panel lists the rules.

#### Testing

`canary.test.ts`: rule matching with and without a cohort, defensive context parsing, an end-to-end 0% canary served by context and by user id, rule replacement, rejection of a 0% canary without rules, cleared targeting after promote. SDK and CLI tests.

### 2026-10-09 — Staged rollouts (M3.5)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** STG-01 – STG-05

#### What changed

- `deploy` accepts `canary: { rollout: { bands, gate } }`; `POST …/canary/advance`; the `rollout.advance` job (replacing the stub) advances, promotes at 100% or aborts on a failed gate, as `system`. Manual traffic changes take over from the schedule; promote and abort clear it.
- CLI: `deploy --rollout 1,10,50,100 --hold 30m` with gate flags; `canary advance`.
- Dashboard: band progress, next check time and "Advance now" in the canary panel; audit lines for rollout events.

#### Testing

`rollout.test.ts`: schedule validation and gate logic; hold, waiting for samples, advance with a `system` audit and a fresh band clock; manual advance through the 100% band to promotion; abort on a failed gate with webhook; manual traffic taking over; a freeze pausing the rollout. CLI tests for the flags. Dashboard panel exercised in headless Chrome.

### 2026-10-09 — Alerts and auto-rollback (M3.4)

**Type:** feature + fix
**PR / Branch:** feat/m3-progressive
**Refs:** ALT-01 – ALT-05, HLT-05

#### What changed

- Alert rules API and dashboard page (Settings → Alerts); the `alert.evaluate` job replaces the stub. Conditions on canary error rate, canary-vs-stable delta, canary p95, overall success rate and p95, and webhook failure rate.
- `auto_rollback` aborts the canary or rolls the module back, as `ActorType.system` (new enum value), with `module.auto_rollback` audits and `canary.auto_rolled_back` / `module.auto_rolled_back` webhooks; `alert.triggered` / `alert.resolved` events. The webhook settings page lists every event, including canary and alert events.
- Fix: "roll back to the previous version" (manual `previous: true` and auto-rollback) could pick an aborted canary, which had never served everyone. `ModuleVersion.activatedAt` records activations; previous-version lookups require it.

#### Testing

`alerts.test.ts`: validation and admin-only writes; a failing canary aborted exactly once with a `system` audit, then resolved, cooldown honoured; a module-wide rollback to the last version that was active; a freeze blocking the rollback while the alert still fires. `canary.test.ts`: manual rollback never lands on an aborted canary (fails without the fix). Alerts page exercised in headless Chrome (create, list, disable, audit line).

### 2026-10-09 — Error-tracker tagging (M3.3)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** report §5.5

#### What changed

`client.getTelemetryTags()` (variant, cohort, environment, manifest, source, `mf.<module>` versions; OTel-compatible keys within Sentry's 32-character limit). New entry points `@harmoniq/client/sentry` (`harmoniqSentry`: tags and a `harmoniq` context, blanking modules that leave the manifest) and `@harmoniq/client/datadog` (`harmoniqDatadog`: RUM global context, v5 and v4 APIs). Both take the vendor SDK as an argument, so the client stays dependency-free.

#### Testing

`telemetry.test.ts`: tag contents and key lengths, Sentry sync across a manifest change and after unsubscribing, Datadog v5/v4 and unsupported SDKs.

### 2026-10-09 — Module health (M3.2)

**Type:** feature
**PR / Branch:** feat/m3-progressive
**Refs:** HLT-01 – HLT-04

#### What changed

- Registry: `POST /api/health/:ws/:host/:env` (public, `text/plain` or JSON, ≤50 events), `GET …/modules/:ref/health?environment=` (5-minute stats per variant, trend, top errors, 24 h hourly), `GET …/health` (sparkline series). `ModuleHealthEvent.version` and the `ModuleHealthRollup` table (RLS), rollup job every 5 minutes, 30-day retention.
- SDK: `reportHealth` (sampling, batching, `sendBeacon`, flush on page hide), `reportModuleLoad`, `reportModuleError`, `flushHealth`.
- `@harmoniq/mf-plugin`: reports each remote's first load time or error.
- Dashboard: health sparklines on the modules list; health panel (stable vs canary, top errors) on the module page.
- `rls.test.ts` now fails if any table with a `workspaceId` lacks RLS or a policy.

#### Testing

`health.test.ts`: acceptance of live versions only and server-side variants, malformed reports, a version deployed after the cache filled, exact window stats and percentiles, trend, rollup idempotency and series. SDK and mf-plugin unit tests. The `examples/vite-mf` e2e now checks that real load reports from Chrome reach the registry. Dashboard pages rendered in headless Chrome with seeded reports.

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
