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
- Headers `X-Harmoniq-Variant` / `X-Harmoniq-Cohort-Id` (always `stable` until canary releases land).

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

`dryRun: true` validates without deploying and returns the bundle checks (reachable, SRI match, CORS, content type) and the projected manifest diff. With `HARMONIQ_VALIDATE_BUNDLES=1`, real deploys are validated too and rejected with `422` on failure. The registry only fetches public HTTPS URLs and never follows redirects.

### `POST /api/workspaces/:ws/modules/:moduleRef/rollback` — `module:deploy`

```json
{ "environment": "production", "previous": true }
```

Exactly one of `previous: true`, `version: "1.2.2"` or `versionId`. Emits `rollback.executed`.

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

| Endpoint                                                               | Permission                | Description                                                                                       |
| ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces`                                                 | signed-in user            | `{ name, slug }`; creator becomes owner; creates host app `default` with `staging` + `production` |
| `GET /api/workspaces/:ws`                                              | read                      | Workspace, your role, host apps and environments (with freeze state)                              |
| `POST /api/workspaces/:ws/host-apps`                                   | admin                     | `{ name, slug, environments? }`                                                                   |
| `POST /api/workspaces/:ws/host-apps/:hostApp/environments`             | admin                     | `{ name, slug }`                                                                                  |
| `PUT /api/workspaces/:ws/host-apps/:hostApp/environments/:env/freeze`  | admin                     | `{ reason, until? }`; emits `env.frozen`                                                          |
| `DELETE …/freeze`                                                      | admin                     | Unfreeze; emits `env.unfrozen`                                                                    |
| `GET /api/workspaces/:ws/audit?actor&action&resourceId&from&to&cursor` | read                      | Audit log; `action=module.` matches a prefix                                                      |
| `GET/POST /api/workspaces/:ws/storage`                                 | admin (or instance admin) | Workspace bucket; credentials are write-only and returned masked                                  |

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

Events: `manifest.updated`, `deploy.success`, `rollback.executed`, `module.promoted`, `env.frozen`, `env.unfrozen` (and later `canary.*`, `deploy.failed`), or `*`. Deliveries are signed: `X-Harmoniq-Signature: hex(HMAC-SHA256(secret, body))`, with `X-Harmoniq-Event`. Webhook URLs must be public HTTPS.

## Sign-in (used by the dashboard)

`GET /api/auth/providers`, `POST /api/auth/:provider/start`, `POST /api/auth/:provider/callback`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/me`. See [`features/authentication.md`](./features/authentication.md).

## Health

| Endpoint       | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `GET /health`  | Always `{ "status": "ok" }`                                                    |
| `GET /ready`   | Checks both database roles and the cache; `503` if not ready                   |
| `GET /metrics` | Prometheus: cache hits/misses, deploys, `harmoniq.manifest.rate_limited_total` |

---

## Planned

| Endpoint                                                                        | Milestone |
| ------------------------------------------------------------------------------- | --------- |
| `GET /api/importmap/:ws/:hostApp/:env`, Native Federation manifest              | M2.3      |
| Canary: `PUT …/modules/:moduleRef/canary`, `…/canary/promote`, `…/canary/abort` | M3.1      |
| Health ingest and aggregation                                                   | M3.2      |
| Alert rules                                                                     | M3.4      |
| Approvals, organizations, SSO, SCIM, GitOps `apply`                             | M4        |
