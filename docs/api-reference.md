# Harmoniq — REST API Reference

> **Base URL**: `http://localhost:4000` (registry)
> **Format**: JSON requests and responses
> **Interactive docs**: `GET /docs` (Swagger UI), `GET /docs/json` (OpenAPI)

This page documents the endpoints that are implemented. Planned endpoints are listed at the end with their milestone.

---

## Authentication

Every endpoint except manifest reads, `/health`, `/ready` and sign-in requires a bearer token:

```
Authorization: Bearer <token>
```

| Caller         | Token                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| CI / CLI       | API key `hq_<keyId>_<secret>`, created in workspace settings. Only valid for its own workspace. |
| Dashboard user | 15-minute access token issued by the sign-in endpoints (the dashboard handles this).            |

**API key scopes**

| Scope           | Grants                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------- |
| `manifest:read` | Read workspace data (modules, versions, audit, snapshots)                                 |
| `deploy:write`  | The above, plus deploy / rollback / promote / upload                                      |
| `admin`         | The above, plus environments, keys, members, webhooks, storage (never owner-only actions) |

Keys may be restricted to specific modules (`moduleIds`). Creating keys and managing members requires a signed-in user.

**User roles**: `viewer` (read) < `developer` (deploy/rollback/promote) < `admin` (settings) < `owner` (manage owners). Non-members get `404` for a workspace.

## Errors

```json
{
  "error": {
    "code": "LOCKED",
    "message": "Environment \"production\" is frozen: Black Friday",
    "details": {}
  }
}
```

| Status | Code               | When                                                                      |
| ------ | ------------------ | ------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`      | Invalid body (`details` has field errors)                                 |
| 401    | `UNAUTHORIZED`     | Missing, invalid, expired or revoked credentials                          |
| 403    | `FORBIDDEN`        | Valid caller, insufficient role/scope, or key for another workspace       |
| 404    | `NOT_FOUND`        | Unknown resource, or workspace you are not a member of                    |
| 409    | `CONFLICT`         | Duplicate slug, already-active version, ambiguous module slug, last owner |
| 422    | `VALIDATION_ERROR` | Bundle failed validation (`details.validation`)                           |
| 423    | `LOCKED`           | Target environment is frozen                                              |
| 429    | —                  | Rate limited (`Retry-After` header)                                       |

---

## Manifests (public)

### `GET /api/manifest/:workspaceSlug/:hostAppSlug/:env`

Returns the manifest for one host app environment. No authentication. Rate limited to 600 requests/minute per workspace and client IP.

```json
{
  "schemaVersion": 2,
  "workspaceSlug": "acme-corp",
  "hostApp": { "slug": "consumer-portal", "name": "Consumer Portal" },
  "environment": "production",
  "variant": "stable",
  "cohortId": "stable",
  "generatedAt": "2026-10-09T10:00:00.000Z",
  "etag": "sha256-…",
  "modules": [
    {
      "name": "checkout",
      "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
      "integrity": "sha384-…",
      "version": "1.2.3",
      "metadata": { "deployedBy": "…", "deployedAt": "…", "commitSha": "a1b2c3d" }
    }
  ]
}
```

- `ETag` header and `If-None-Match` → `304 Not Modified`. The ETag depends only on content, so it is identical across registry replicas.
- If the database is unavailable, the last-known-good manifest is served with `X-Harmoniq-Stale: true`.
- `?pretty=true` pretty-prints outside production.
- Headers `X-Harmoniq-Variant` and `X-Harmoniq-Cohort-Id`. Cross-origin reads can see them and `ETag` (`Access-Control-Expose-Headers`).
- **Canary assignment** (CAN-02): send `X-Harmoniq-User-Id: <opaque user id>` (or a `harmoniq_canary` cookie on same-site setups). The registry hashes it into a `cohortId` and, for each module with a running canary, puts the user in the canary when their bucket for that module is below its traffic percentage. Assignment is sticky, and raising the traffic keeps existing canary users there. Canary responses have `variant: "canary"`, `metadata.canary: true` on the canary modules, `Cache-Control: private, no-cache`, and `Vary: X-Harmoniq-User-Id, Cookie`. Without a user id the response is the stable variant, unless targeting matches.
- **Targeting** (M3.6): a canary may have rules `[{ "attribute": "plan", "values": ["beta"] }]`; a user matching any rule always gets it, whatever the percentage (which may then be `0`). Attributes are `userId` (the user key) or keys of the `X-Harmoniq-Context` header, a JSON object of strings (≤2 KB, ≤20 keys; malformed headers are ignored). Published (CDN) copies and import maps are always stable.

### `GET /api/importmap/:workspaceSlug/:hostAppSlug/:env`

A standard import map (`application/importmap+json`; `?format=systemjs` for SystemJS), public and cached like manifests:

```json
{
  "imports": { "@acme/checkout": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js" },
  "integrity": { "https://cdn.example.com/checkout/1.2.3/remoteEntry.js": "sha384-…" }
}
```

Keys are the module `specifier` (set with `PATCH /api/workspaces/:ws/modules/:module`), defaulting to its slug.

### `GET /api/federation-manifest/:workspaceSlug/:hostAppSlug/:env`

Native Federation format: `{ "checkout": "https://…/remoteEntry.js" }`.

### `GET /api/schema/manifest.json`

JSON Schema for manifest `schemaVersion` 2 (also committed as [`docs/schema/manifest.v2.json`](./schema/manifest.v2.json); regenerate with `pnpm --filter @harmoniq/registry schema:generate`). Generated from the registry's own Zod schema; unknown properties are allowed so validators accept manifests from newer registries.

### Published copies

After every change the registry writes the manifest and import map to storage, readable without the registry (see [manifest delivery](./features/manifest-delivery.md)). `GET /api/workspaces/:ws` lists their URLs and publish status per environment; `POST /api/workspaces/:ws/host-apps/:hostApp/environments/:env/publish` re-publishes (admin).

### `GET /api/manifest/:workspaceSlug/:env`

Legacy form: resolves to the workspace's default host app.

### History (auth: `workspace:read`)

| Endpoint                                                     | Returns                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /api/manifest/:ws/:hostApp/:env/snapshots?cursor&limit` | Every manifest change, newest first, with the audit action that caused it |
| `GET /api/manifest/:ws/:hostApp/:env/snapshots/:snapshotId`  | The exact manifest at that point                                          |
| `GET /api/manifest/:ws/:hostApp/:env/diff?from=<id>&to=<id>` | `{ added, removed, changed }`; `to` defaults to the latest snapshot       |

---

## Modules and versions

Modules are addressed by id **or** slug (`:moduleRef`). A slug used in several host apps returns `409`; use the id.

### `POST /api/workspaces/:ws/modules/:moduleRef/deploy` — `module:deploy`

```json
{
  "environment": "staging",
  "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
  "version": "1.2.3",
  "integrity": "sha384-…",
  "commitSha": "a1b2c3d",
  "metadata": { "pr": 42 },
  "dependencies": { "react": "^18.0.0" },
  "exposes": { "./Checkout": "./src/Checkout" },
  "dryRun": false
}
```

Creates an active version in that environment (the previous one becomes inactive), writes an audit event and a manifest snapshot, refreshes caches and emits `deploy.success` + `manifest.updated` webhooks. Returns `201` with the version, `manifestEtag` and `snapshotId`.

`ephemeral: { ttlHours }` creates `environment` as a preview environment on first deploy (if the workspace allows it) and extends its expiry on later deploys; expired preview environments are deleted hourly. The response includes `previewUrl` when the host app has a template.

`dryRun: true` validates without deploying and returns the bundle checks (reachable, SRI match, CORS, content type) and the projected manifest diff. With `HARMONIQ_VALIDATE_BUNDLES=1`, real deploys are validated too and rejected with `422` on failure. The registry only fetches public HTTPS URLs and never follows redirects.

### `POST /api/workspaces/:ws/modules/:moduleRef/rollback` — `module:deploy`

```json
{ "environment": "production", "previous": true }
```

Exactly one of `previous: true`, `version: "1.2.2"` or `versionId`. `previous` is the most recent earlier version that was active once (never an aborted canary). Emits `rollback.executed`. A running canary is left alone.

### Canary releases — `module:deploy`

Start one by deploying with `"canary": { "trafficPercent": 10 }` (optionally with `"targeting"`), or as a **staged rollout** (STG-01):

```json
"canary": {
  "rollout": {
    "bands": [
      { "percent": 1, "holdMinutes": 30 },
      { "percent": 10, "holdMinutes": 60 },
      { "percent": 50, "holdMinutes": 60 },
      { "percent": 100, "holdMinutes": 0 }
    ],
    "gate": { "maxErrorRate": 0.02, "maxErrorRateDelta": 0.01, "maxP95Ms": 1500, "minSamples": 50 }
  }
}
```

Bands must increase and end at 100. Every minute, the registry checks canaries whose band has run its `holdMinutes`: with at least `minSamples` canary loads during the band and every gate limit met it moves to the next band (audited `canary.rollout_advance`), and reaching 100 promotes; a failed limit aborts the canary (`canary.rollout_failed`, webhook `canary.auto_rolled_back`); with too few loads it waits. Setting traffic by hand (`PUT …/canary`) stops following the schedule; a frozen environment pauses it. Versions carry `rollout` (`bands`, `gate`, `bandStartedAt`, `currentBandIndex`) while a schedule runs.

A plain canary: the new version runs next to the active one (which must exist, else `409`) and replaces any running canary. A deploy without `canary` ends a running canary (recorded as `endedCanary` in the audit event).

| Endpoint                                            | Body                                                       | Effect                                                                                        | Webhook                              |
| --------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| `PUT /api/workspaces/:ws/modules/:moduleRef/canary` | `{ environment, trafficPercent?, versionId?, targeting? }` | Change the traffic (1–99); with `versionId`, make that earlier version the canary instead     | `canary.updated` / `canary.started`  |
| `POST …/canary/advance`                             | `{ environment }`                                          | Staged rollout: move to the next band now, skipping the gate (STG-05); the 100% band promotes | `canary.updated` / `canary.promoted` |
| `POST …/canary/promote`                             | `{ environment, reason? }`                                 | The canary becomes the active version for everyone                                            | `canary.promoted`                    |
| `POST …/canary/abort`                               | `{ environment, reason? }`                                 | Everyone goes back to the active version; the canary becomes inactive                         | `canary.rolled_back`                 |

All three return the version, `manifestEtag` and `snapshotId`, are audited (`canary.update`, `canary.start`, `canary.promote`, `canary.abort`) and return `423` in a frozen environment. `GET /api/workspaces/:ws/modules` lists each environment's `canary` next to `active`.

### Dependency and contract gate

DEP-01..05. A deploy (and a promote, against the target environment) is checked before it changes anything:

- **Dependencies**: each range in the version's `dependencies` must intersect the same package's range in every other active module of the environment and in the host app's `sharedDependencies`. Conflicts among modules already deployed don't block an unrelated deploy.
- **Exposes**: dropping an exposed module that the active version had is a warning (`warnings` in the response), or a conflict when the host app has `strictExposes`.

A blocked change returns `422` with `error.details.dependencyConflicts` (`[{ package, between: [{ source, range }], reason }]`) and `removedExposes`. `"force": true` goes ahead, audited as `module.deploy_forced` (or `module.promote` with `forced: true`). Dry runs report `dependencyConflicts`, `removedExposes` and `blockedByGate` in `validation`. The build plugin sends `dependencies` from the `shared` section of `mf-manifest.json`.

### Kill switch — `module:deploy`

`PUT /api/workspaces/:ws/modules/:moduleRef/kill-switch` with `{ "environment": "production", "disabled": true, "reason": "checkout errors" }` (a reason of at least 3 characters is required to disable; `{ "disabled": false }` re-enables). The module stays in the manifest with `"disabled": true` and `disabledReason`, and is left out of import maps and federation manifests. Works in frozen environments (an emergency control). Audited `module.disable` / `module.enable`; webhooks `module.disabled` / `module.enabled`. Module listings show each environment's `disabled` state.

### `POST /api/workspaces/:ws/modules/:moduleRef/promote` — `module:deploy`

```json
{ "fromEnvironment": "staging", "toEnvironment": "production" }
```

Copies the exact artifact (URL, integrity, metadata) active in `fromEnvironment` (or `versionId`). Emits `module.promoted`.

### Other module endpoints

| Endpoint                                                                       | Permission | Description                                     |
| ------------------------------------------------------------------------------ | ---------- | ----------------------------------------------- |
| `GET /api/workspaces/:ws/modules`                                              | read       | Modules with the active version per environment |
| `GET /api/workspaces/:ws/modules/:moduleRef`                                   | read       | Module and its environments                     |
| `GET /api/workspaces/:ws/modules/:moduleRef/versions?environment&cursor&limit` | read       | Deployment history, newest first                |
| `POST /api/workspaces/:ws/modules`                                             | admin      | `{ hostApp, name, slug, description? }`         |
| `POST /api/workspaces/:ws/modules/:moduleRef/upload-url`                       | deploy     | Pre-signed upload URL in the workspace bucket   |

All changes to a frozen environment return `423`. Manifest reads are never blocked.

---

## Workspaces, host apps, environments

| Endpoint                                                                    | Permission                | Description                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces`                                                      | signed-in user            | `{ name, slug }`; creator becomes owner; creates host app `default` with `staging` + `production`                                                       |
| `GET /api/workspaces/:ws`                                                   | read                      | Workspace, your role, host apps and environments (with freeze state)                                                                                    |
| `POST /api/workspaces/:ws/host-apps`                                        | admin                     | `{ name, slug, environments? }`                                                                                                                         |
| `POST /api/workspaces/:ws/host-apps/:hostApp/environments`                  | admin                     | `{ name, slug }`                                                                                                                                        |
| `PATCH /api/workspaces/:ws/host-apps/:hostApp`                              | admin                     | `{ name?, description?, previewUrlTemplate?, sharedDependencies?, strictExposes? }` (M3.7: host-shared semver ranges; reject deploys that drop exposes) |
| `GET /api/workspaces/:ws/host-apps/:hostApp/environments/:env/dependencies` | read                      | Dependency matrix (DEP-04): `packages`, `sources` (host + active modules) and `conflicts`                                                               |
| `PUT /api/workspaces/:ws/host-apps/:hostApp/environments/:env/freeze`       | admin                     | `{ reason, until? }`; emits `env.frozen`                                                                                                                |
| `DELETE …/freeze`                                                           | admin                     | Unfreeze; emits `env.unfrozen`                                                                                                                          |
| `GET /api/workspaces/:ws/audit?actor&action&resourceId&from&to&cursor`      | read                      | Audit log; `action=module.` matches a prefix                                                                                                            |
| `GET/POST /api/workspaces/:ws/storage`                                      | admin (or instance admin) | Workspace bucket; credentials are write-only and returned masked                                                                                        |

Slugs: lowercase letters, digits and inner hyphens.

## API keys and members (signed-in admins)

| Endpoint                                          | Description                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/workspaces/:ws/api-keys`                | List (never includes secrets)                                             |
| `POST /api/workspaces/:ws/api-keys`               | `{ name, scopes?, moduleIds?, expiresAt? }`; response `key` is shown once |
| `DELETE /api/workspaces/:ws/api-keys/:keyId`      | Revoke (effective immediately)                                            |
| `POST /api/workspaces/:ws/api-keys/:keyId/rotate` | `{ gracePeriodHours = 24 }`; old key keeps working until then             |
| `GET /api/workspaces/:ws/members`                 | Members and pending invitations                                           |
| `POST /api/workspaces/:ws/members`                | `{ email, role }`; accepted on the invitee's first verified sign-in       |
| `PATCH /api/workspaces/:ws/members/:memberId`     | `{ role }`                                                                |
| `DELETE /api/workspaces/:ws/members/:memberId`    | Remove. Only owners manage owners; the last owner cannot be removed.      |

## Webhooks (admin)

| Endpoint                                                   | Description                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/workspaces/:ws/webhooks`                         | Endpoints (secrets never returned)                                       |
| `POST /api/workspaces/:ws/webhooks`                        | `{ url, events, maxRetries?, backoffCeilingMs? }`; returns `secret` once |
| `PATCH /api/workspaces/:ws/webhooks/:id`                   | `{ url?, events?, active?, paused? }`                                    |
| `DELETE /api/workspaces/:ws/webhooks/:id`                  | Delete                                                                   |
| `GET /api/workspaces/:ws/webhooks/:id/deliveries`          | Delivery attempts                                                        |
| `GET /api/workspaces/:ws/webhooks/dead-letters`            | Exhausted deliveries                                                     |
| `POST /api/workspaces/:ws/webhooks/dead-letters/:id/retry` | Re-enqueue                                                               |

Events: `manifest.updated`, `manifest.publish_failed`, `deploy.success`, `rollback.executed`, `module.promoted`, `module.disabled`, `module.enabled`, `canary.started`, `canary.updated`, `canary.promoted`, `canary.rolled_back`, `canary.auto_rolled_back`, `module.auto_rolled_back`, `alert.triggered`, `alert.resolved`, `schedule.executed`, `schedule.failed`, `env.frozen`, `env.unfrozen` (and later `deploy.failed`), or `*`. Deliveries are signed: `X-Harmoniq-Signature: hex(HMAC-SHA256(secret, body))`, with `X-Harmoniq-Event`. Webhook URLs must be public HTTPS.

## Sign-in (used by the dashboard)

`GET /api/auth/providers`, `POST /api/auth/:provider/start`, `POST /api/auth/:provider/callback`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/me`. See [`features/authentication.md`](./features/authentication.md).

## Module health

### `POST /api/health/:workspaceSlug/:hostAppSlug/:env` (public)

Load outcomes from host apps (the SDK sends these when `reportHealth` is on). JSON or `text/plain` body (so `navigator.sendBeacon` works cross-origin without a preflight), at most 50 events, 64 KB; 120 requests/minute per workspace and client IP.

```json
{
  "events": [
    { "module": "checkout", "version": "1.2.3", "success": true, "loadMs": 142 },
    { "module": "checkout", "version": "1.3.0", "success": false, "error": "ChunkLoadError: …" }
  ],
  "client": "harmoniq-js/1.0.0"
}
```

Returns `202 { accepted, rejected }`. Only modules and versions that are live (active or canary) in the environment are stored; the registry sets `variant` from the version. Unknown environment → `404`.

### `GET /api/workspaces/:ws/modules/:moduleRef/health?environment=` — read

HLT-02/03: the last 5 minutes. `loadSuccessRate` (0–1), `p50LoadMs`, `p95LoadMs` (successful loads), `errorCount`, `sampleCount` and `trend` (`improving`, `degrading`, `steady` or `insufficient_data`, against the previous 5 minutes), plus `variants.stable` / `variants.canary` with the same fields, `topErrors` and `hourly` (last 24 hours).

### `GET /api/workspaces/:ws/health?hours=24` — read

Hourly `{ hour, sampleCount, errorCount }` series per module and environment, for sparklines.

## Scheduled operations

M3.6. Any of these calls can be scheduled; it runs at `runAt` through the same route, as the user or API key that scheduled it, with its access checked again at that time (a removed member's or revoked key's operations fail).

| Endpoint                                              | Permission | Description                                            |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `GET /api/workspaces/:ws/scheduled-operations?status` | read       | Newest first (100)                                     |
| `POST /api/workspaces/:ws/scheduled-operations`       | deploy     | `{ runAt, description?, operation }` → `201`           |
| `DELETE /api/workspaces/:ws/scheduled-operations/:id` | deploy     | Cancel a pending operation (`409` once it has started) |

```json
{
  "runAt": "2026-10-12T09:00:00Z",
  "operation": {
    "type": "promote",
    "module": "checkout",
    "request": { "fromEnvironment": "staging", "toEnvironment": "production" }
  }
}
```

`type` is `deploy`, `promote`, `rollback`, `canary_traffic`, `canary_promote`, `canary_abort` or `kill_switch`; `request` is the body of that endpoint, validated when scheduling. `runAt` may be at most a year ahead. A job checks every minute; each operation runs once (`FOR UPDATE SKIP LOCKED` across replicas) and records `status` (`done`/`failed`), `result` (`{ statusCode, body }`) and `error`, audited as `schedule.executed` / `schedule.failed` with webhooks of the same names. Operations interrupted by a restart are marked failed after 10 minutes.

## Alerts

ALT-01..05. Rules are evaluated every minute; a rule fires when its metric crosses the threshold (below it for `load_success_rate`) with at least `minSamples` samples in the window, only on the change from `ok` to `firing` and not within `cooldownMinutes` of the last firing.

| Endpoint                                    | Permission | Description                                                                                |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `GET /api/workspaces/:ws/alerts`            | read       | Rules with their state and last value                                                      |
| `POST /api/workspaces/:ws/alerts`           | admin      | Create a rule                                                                              |
| `PATCH /api/workspaces/:ws/alerts/:ruleId`  | admin      | `name`, `threshold`, `windowMinutes`, `minSamples`, `cooldownMinutes`, `enabled`, `action` |
| `DELETE /api/workspaces/:ws/alerts/:ruleId` | admin      |                                                                                            |

```json
{
  "name": "Checkout canary errors",
  "condition": "canary_error_rate",
  "threshold": 0.05,
  "action": "auto_rollback",
  "module": "checkout",
  "environment": "production",
  "windowMinutes": 5,
  "minSamples": 20
}
```

Conditions: `canary_error_rate`, `canary_error_rate_delta` (canary minus stable), `canary_load_p95ms`, `load_success_rate`, `load_p95ms` (module and environment required) and `webhook_failure_rate` (workspace-wide). Rates are fractions.

Actions: `webhook` sends `alert.triggered` / `alert.resolved` to webhook endpoints subscribed to them. `auto_rollback` does that too, and first aborts the module's canary, or, for a module-wide condition without a canary, rolls it back to the previous version that was once active. It is audited as `module.auto_rollback` by actor `system:alert:<ruleId>` with the metric value (ALT-04) and emits `canary.auto_rolled_back` or `module.auto_rolled_back`. A frozen environment blocks the rollback; the alert still fires with `autoRollbackError` and the rule's `lastError` says why.

`manifest_fetch_error_rate` (ALT-02) is not available: hosts don't report failed manifest fetches yet.

## Health

| Endpoint       | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `GET /health`  | Always `{ "status": "ok" }`                                                    |
| `GET /ready`   | Checks both database roles and the cache; `503` if not ready                   |
| `GET /metrics` | Prometheus: cache hits/misses, deploys, `harmoniq.manifest.rate_limited_total` |

---

## Planned

| Endpoint                                            | Milestone |
| --------------------------------------------------- | --------- |
| Approvals, organizations, SSO, SCIM, GitOps `apply` | M4        |
