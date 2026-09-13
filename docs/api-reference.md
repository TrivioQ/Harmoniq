# Harmoniq — REST API Reference

> **Version**: 1.0.0  
> **Base URL**: `https://your-registry.example.com`  
> **Auth**: API key via `Authorization: Bearer hq_<key>` header (write endpoints only)  
> **Format**: All requests and responses are `application/json`

---

## Authentication

Write endpoints require an API key with the appropriate scope. Read endpoints (manifest fetch) are public.

**Header format**:

```
Authorization: Bearer hq_<base62-encoded-32-bytes>
```

**Scopes**:

| Scope           | Description                                 |
| --------------- | ------------------------------------------- |
| `manifest:read` | Read manifests (also public without a key)  |
| `deploy:write`  | Deploy, rollback, canary operations         |
| `admin`         | Key management, member management, settings |

**Error response (401)**:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid API key",
    "requestId": "req_abc123"
  }
}
```

---

## Manifest Endpoints (Public Read)

### GET /api/manifest/:workspaceSlug/:env

Fetch the active manifest for a workspace environment.

**Auth**: None (public)

**Headers (optional)**:

```
If-None-Match: "sha256-abc123"
X-Harmoniq-User-Id: user-123        # for canary sticky assignment
```

**Response 200**:

```json
{
  "schemaVersion": 1,
  "workspaceSlug": "acme-corp",
  "environment": "production",
  "generatedAt": "2026-09-13T00:00:00Z",
  "etag": "sha256-abc123",
  "modules": [
    {
      "name": "checkout",
      "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
      "integrity": "sha256-xyz789",
      "version": "1.2.3",
      "metadata": {
        "deployedBy": "ci-bot",
        "deployedAt": "2026-09-12T22:00:00Z",
        "commitSha": "a1b2c3d4"
      }
    }
  ]
}
```

**Response headers**:

```
ETag: "sha256-abc123"
Cache-Control: no-cache
X-Harmoniq-Stale: true   # only present when serving stale cache due to DB failure
```

**Response 304**: Empty body; ETag matches `If-None-Match`.

**Response 404**:

```json
{ "error": { "code": "WORKSPACE_NOT_FOUND", "message": "Workspace 'acme-corp' not found" } }
```

---

### GET /api/manifest/:workspaceSlug/:env/canary

Fetch the canary manifest for a workspace environment. Returns the canary variant manifest if the requester is in the canary cohort; otherwise returns the standard manifest.

**Auth**: None (public)

**Headers**:

```
X-Harmoniq-User-Id: user-123    # Used for deterministic canary assignment
```

**Response**: Same schema as standard manifest. Canary modules will have `"status": "canary"` in the `metadata` field.

**Cookie set on response** (if no `X-Harmoniq-User-Id` provided):

```
Set-Cookie: harmoniq_canary=<uuid>; Path=/; Max-Age=2592000; SameSite=Lax
```

---

## Deploy & Version Management

### POST /api/workspaces/:workspaceSlug/modules/:moduleId/deploy

Deploy a new version of a module to an environment.

**Auth**: `deploy:write`

**Request body**:

```json
{
  "environmentSlug": "production",
  "version": "1.2.3",
  "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
  "integrity": "sha256-xyz789",
  "commitSha": "a1b2c3d4",
  "metadata": {
    "buildId": "ci-1234"
  }
}
```

**Response 201**:

```json
{
  "id": "clx123",
  "version": "1.2.3",
  "status": "active",
  "url": "https://cdn.example.com/checkout/1.2.3/remoteEntry.js",
  "deployedAt": "2026-09-13T00:00:00Z",
  "deployedBy": "key_abc"
}
```

---

### POST /api/workspaces/:workspaceSlug/modules/:moduleId/rollback

Roll back a module to a specific previous version.

**Auth**: `deploy:write`

**Request body**:

```json
{
  "versionId": "clx001",
  "environmentSlug": "production"
}
```

**Response 200**:

```json
{
  "rolledBackTo": { "id": "clx001", "version": "1.1.0" },
  "previousActive": { "id": "clx123", "version": "1.2.3" }
}
```

---

### PUT /api/workspaces/:workspaceSlug/modules/:moduleId/canary

Configure a canary release.

**Auth**: `deploy:write`

**Request body**:

```json
{
  "versionId": "clx123",
  "environmentSlug": "production",
  "trafficPercent": 10
}
```

**Response 200**:

```json
{
  "id": "clx123",
  "status": "canary",
  "trafficPercent": 10
}
```

---

### POST /api/workspaces/:workspaceSlug/modules/:moduleId/canary/promote

Promote the current canary version to `active`.

**Auth**: `deploy:write`

**Request body**:

```json
{
  "environmentSlug": "production"
}
```

**Response 200**:

```json
{
  "promoted": { "id": "clx123", "version": "1.2.3", "status": "active" }
}
```

---

## Module Management

### GET /api/workspaces/:workspaceSlug/modules

List all remote modules in a workspace.

**Auth**: `manifest:read`

**Response 200**:

```json
{
  "modules": [
    {
      "id": "mod_abc",
      "name": "checkout",
      "slug": "checkout",
      "hostApp": { "id": "app_xyz", "name": "Main Shell" },
      "activeVersions": {
        "production": { "version": "1.2.3", "url": "..." },
        "staging": { "version": "1.3.0-beta", "url": "..." }
      }
    }
  ]
}
```

---

### GET /api/workspaces/:workspaceSlug/modules/:moduleId/versions

List all versions of a module (deployment history).

**Auth**: `manifest:read`

**Query params**:

- `environment`: filter by environment slug
- `status`: filter by `active | inactive | canary`
- `limit`: default 50, max 200
- `cursor`: pagination cursor

**Response 200**:

```json
{
  "versions": [
    {
      "id": "clx123",
      "version": "1.2.3",
      "status": "active",
      "url": "...",
      "integrity": "sha256-...",
      "deployedBy": "user_abc",
      "deployedAt": "2026-09-13T00:00:00Z",
      "commitSha": "a1b2c3d4"
    }
  ],
  "nextCursor": "clx100"
}
```

---

## Health & Observability

### GET /health

Liveness check. Always returns 200 if the process is running.

**Auth**: None

**Response 200**:

```json
{ "status": "ok", "timestamp": "2026-09-13T00:00:00Z" }
```

---

### GET /ready

Readiness check. Verifies DB and cache connectivity.

**Auth**: None

**Response 200**:

```json
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "cache": "ok"
  }
}
```

**Response 503**:

```json
{
  "status": "unavailable",
  "checks": {
    "database": "error",
    "cache": "ok"
  }
}
```

---

### GET /metrics

Prometheus-compatible metrics.

**Auth**: None (consider restricting to internal network in production)

**Response 200**: Prometheus text format

```
# HELP harmoniq_manifest_requests_total Total manifest requests
# TYPE harmoniq_manifest_requests_total counter
harmoniq_manifest_requests_total{workspace="acme-corp",env="production",cache="hit"} 1042
...
```

---

## Error Codes Reference

| Code                    | HTTP Status | Description                                |
| ----------------------- | ----------- | ------------------------------------------ |
| `UNAUTHORIZED`          | 401         | Missing or invalid API key                 |
| `FORBIDDEN`             | 403         | Valid key, insufficient scope              |
| `WORKSPACE_NOT_FOUND`   | 404         | Workspace slug not found                   |
| `MODULE_NOT_FOUND`      | 404         | Module ID not found                        |
| `VERSION_NOT_FOUND`     | 404         | Version ID not found                       |
| `ENVIRONMENT_NOT_FOUND` | 404         | Environment slug not found                 |
| `VALIDATION_ERROR`      | 422         | Request body failed Zod validation         |
| `CONFLICT`              | 409         | Duplicate version already exists           |
| `RATE_LIMITED`          | 429         | Too many requests (auth endpoints: 10/min) |
| `INTERNAL_ERROR`        | 500         | Unexpected server error                    |
| `SERVICE_UNAVAILABLE`   | 503         | Registry degraded (DB/cache down)          |
