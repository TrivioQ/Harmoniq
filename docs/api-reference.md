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

| Endpoint                                                                       | Permission | Description                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:ws/modules`                                              | read       | Modules with the active version per environment                                                                                                                                                                                                                                             |
| `GET /api/workspaces/:ws/modules/:moduleRef`                                   | read       | Module and its environments                                                                                                                                                                                                                                                                 |
| `GET /api/workspaces/:ws/modules/:moduleRef/versions?environment&cursor&limit` | read       | Deployment history, newest first                                                                                                                                                                                                                                                            |
| `POST /api/workspaces/:ws/modules`                                             | admin      | `{ hostApp, name, slug, description? }`                                                                                                                                                                                                                                                     |
| `POST /api/workspaces/:ws/modules/:moduleRef/upload-url`                       | deploy     | `{ uploadUrl, key, url, headers? }`: a pre-signed upload in the workspace bucket (else the instance storage); `url` is where it is served (CDN prefix). Deploy with `storagePath: key` to serve it from there. `503 STORAGE_UNAVAILABLE` when the workspace bucket fails (never a fallback) |
| `GET /api/workspaces/:ws/modules/:moduleRef/owners`                            | read       | Module owners (RBAC-01)                                                                                                                                                                                                                                                                     |
| `PUT /api/workspaces/:ws/modules/:moduleRef/owners`                            | admin      | `{ memberIds }` replaces the owners; `[]` makes the module ownerless                                                                                                                                                                                                                        |

All changes to a frozen environment return `423`. Manifest reads are never blocked. A workspace owner (with a session, never an API key) can also push a single request through with the header `X-Harmoniq-Freeze-Override: <reason>`; it is audited as `env.freeze_override`. For CI hotfixes, open an override window instead.

**Module ownership** (RBAC-02/03): when a module has owners, only they and workspace admins/owners can deploy, roll back, promote, run canaries, use the kill switch or schedule those for it; other developers get `403` (audited as `module.unauthorized_attempt`). Modules without owners are open to every developer. `GET …/modules/:moduleRef` returns `owners` and `canWrite` for the caller.

---

## Workspaces, host apps, environments

| Endpoint                                                                    | Permission                | Description                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces`                                                      | signed-in user            | `{ name, slug }`; creator becomes owner; creates host app `default` with `staging` + `production`                                                                                                                                                                                                                                                                                   |
| `GET /api/workspaces/:ws`                                                   | read                      | Workspace, your role, host apps and environments (with freeze state)                                                                                                                                                                                                                                                                                                                |
| `POST /api/workspaces/:ws/host-apps`                                        | admin                     | `{ name, slug, environments? }`                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/workspaces/:ws/host-apps/:hostApp/environments`                  | admin                     | `{ name, slug }`                                                                                                                                                                                                                                                                                                                                                                    |
| `PATCH /api/workspaces/:ws/host-apps/:hostApp`                              | admin                     | `{ name?, description?, previewUrlTemplate?, sharedDependencies?, strictExposes? }` (M3.7: host-shared semver ranges; reject deploys that drop exposes)                                                                                                                                                                                                                             |
| `GET /api/workspaces/:ws/host-apps/:hostApp/environments/:env/dependencies` | read                      | Dependency matrix (DEP-04): `packages`, `sources` (host + active modules) and `conflicts`                                                                                                                                                                                                                                                                                           |
| `PUT /api/workspaces/:ws/host-apps/:hostApp/environments/:env/freeze`       | admin                     | `{ reason, from?, until? }`; `from` schedules the window (ENV-FRZ-04); emits `env.frozen`                                                                                                                                                                                                                                                                                           |
| `POST …/freeze/override`                                                    | owner                     | `{ reason (≥10 chars), minutes (5–240, default 60) }`: changes pass the freeze until then, each recording the override (ENV-FRZ-03); `DELETE` ends it                                                                                                                                                                                                                               |
| `DELETE …/freeze`                                                           | admin                     | Unfreeze; emits `env.unfrozen`                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/workspaces/:ws/audit?actor&action&resourceId&from&to&cursor`      | read                      | Audit log; `action=module.` matches a prefix                                                                                                                                                                                                                                                                                                                                        |
| `GET/POST /api/workspaces/:ws/storage`                                      | admin (or instance admin) | BYOB: `{ provider: S3 \| GCS \| AZURE, bucket, region, endpoint? (S3), cdnPrefix?, pathPrefix?, credentials? }`. Credentials are write-only (masked when read): S3 `accessKeyId` + `secretAccessKey` or `roleArn` (+ `externalId`); GCS `serviceAccountJson`; Azure `connectionString`. Saving writes, reads back and deletes a probe object first (`400` with the error otherwise) |
| `POST /api/workspaces/:ws/storage/test`                                     | admin (or instance admin) | Test Connection: the body's config (omitted credentials: the stored ones), or the saved one without a body; nothing is saved                                                                                                                                                                                                                                                        |
| `DELETE /api/workspaces/:ws/storage`                                        | admin (or instance admin) | Back to the instance storage for new deploys; deployed modules keep their URLs                                                                                                                                                                                                                                                                                                      |

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

Events: `deploy.approval_requested`, `deploy.approved`, `deploy.rejected`, `deploy.approval_expired`, `deploy.emergency_bypass`, `manifest.updated`, `manifest.publish_failed`, `deploy.success`, `rollback.executed`, `module.promoted`, `module.disabled`, `module.enabled`, `canary.started`, `canary.updated`, `canary.promoted`, `canary.rolled_back`, `canary.auto_rolled_back`, `module.auto_rolled_back`, `alert.triggered`, `alert.resolved`, `schedule.executed`, `schedule.failed`, `env.frozen`, `env.unfrozen` (and later `deploy.failed`), or `*`. Deliveries are signed: `X-Harmoniq-Signature: hex(HMAC-SHA256(secret, body))`, with `X-Harmoniq-Event`. Webhook URLs must be public HTTPS.

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

## Single sign-on (OIDC)

M4.4, SSO-01..08, 21..28. Any OpenID Connect provider (Okta, Entra ID, Google Workspace, Keycloak, Auth0, Cognito …).

| Endpoint                              | Permission | Description                                                                                                                                                                                                                 |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:ws/sso/oidc`    | admin      | Settings; the client secret masked                                                                                                                                                                                          |
| `PUT /api/workspaces/:ws/sso/oidc`    | admin      | `{ issuer, clientId, clientSecret (write-only; omit to keep), scopes, groupsClaim, roleMapping: { group: role }, trustedDomains, defaultRole, forceSso }`; checks the issuer's discovery document first (`400` if it fails) |
| `DELETE /api/workspaces/:ws/sso/oidc` | admin      | Removes it (and forced SSO)                                                                                                                                                                                                 |
| `GET /api/auth/sso/discover?email=`   | public     | `{ provider: "oidc:<workspace>", workspace }` for the workspace that trusts the email's domain, else `{ provider: "org-oidc:<org>", organization }` for an organization that does, else `404`                               |

Sign-in uses the usual `POST /api/auth/:provider/start` and `/callback` with provider `oidc:<workspace>` (redirect URI on the dashboard: `…/api/auth/callback/oidc%3A<workspace>`). The registry discovers the provider's metadata (cached 1 h), uses authorization code + PKCE with a nonce derived from the PKCE challenge, and validates the ID token's signature (JWKS), issuer, audience, expiry, age and nonce. First sign-in creates the user; users join the workspace when an IdP group maps to a role (the most permissive mapping wins, and is re-applied at every login; owners are never demoted) or when their email domain is trusted (`defaultRole`). Emails from trusted domains count as verified. Logins are audited as `auth.sso_login`.

**Forced SSO**: with `forceSso`, members signed in any other way get `403 SSO_REQUIRED` in this workspace (owners are exempt, as a fallback if the IdP fails). **Session lifetime**: when the IdP issues a refresh token, the registry keeps it (sealed) and re-checks it hourly on session refresh; if the IdP refuses, the Harmoniq session ends.

Self-hosters can also set one instance-wide provider (`oidc`) with `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_DISPLAY_NAME`. Workspace issuers must be public HTTPS in production unless `HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS=1` (IdPs on internal networks).

## Single sign-on (SAML 2.0)

M4.5, SSO-09..20. Any SAML 2.0 identity provider (Okta, Entra ID, ADFS, OneLogin, PingFederate …). Harmoniq is the service provider; its endpoints live under `/auth/saml/:ws` on the registry's public URL.

| Endpoint                                    | Permission | Notes                                                                                                                                                                                                                            |
| ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/saml/:ws/metadata`               | public     | SP metadata XML (`application/samlmetadata+xml`): entity ID, ACS, SLO and the signing certificate                                                                                                                                |
| `POST /auth/saml/:ws/acs`                   | public     | Assertion consumer service (HTTP-POST). Redirects (`303`) to the dashboard callback with a one-time code, or to the login page with `?error=`                                                                                    |
| `GET /auth/saml/:ws/login`                  | public     | Starts an SP-initiated sign-in through the dashboard                                                                                                                                                                             |
| `GET /auth/saml/:ws/logout`                 | public     | Redirects to the IdP's single logout URL                                                                                                                                                                                         |
| `POST /auth/saml/:ws/slo`                   | public     | IdP-initiated single logout: ends the user's sessions from this IdP and answers with a signed `LogoutResponse`                                                                                                                   |
| `GET /api/workspaces/:ws/sso/saml`          | admin      | `{ serviceProvider: { entityId, metadata, acs, login, logout, slo, cert }, saml }`; never the SP private key                                                                                                                     |
| `PUT /api/workspaces/:ws/sso/saml`          | admin      | `{ idpEntityId, idpSsoUrl, idpSloUrl?, idpCert, nameIdFormat?, attributeMapping: { email?, name?, groups? }, roleMapping, trustedDomains, defaultRole, forceSso, allowIdpInitiated }`; the SP keypair is generated on first save |
| `DELETE /api/workspaces/:ws/sso/saml`       | admin      | Removes it                                                                                                                                                                                                                       |
| `POST /api/workspaces/:ws/sso/saml/import`  | admin      | `{ metadataXml }` → `{ idpEntityId, idpSsoUrl, idpSloUrl, idpCert }` (not saved)                                                                                                                                                 |
| `POST /api/workspaces/:ws/sso/saml/test`    | admin      | `{ id, url }`: open `url` to sign in at the IdP; the ACS stores the assertion's attributes and returns to Settings without creating a session                                                                                    |
| `GET /api/workspaces/:ws/sso/saml/test/:id` | admin      | `{ attributes, mapped }` for 10 minutes                                                                                                                                                                                          |
| `POST /api/auth/saml/redeem`                | public     | `{ code, provider }` → session, for IdP-initiated sign-ins (only when `allowIdpInitiated`)                                                                                                                                       |

SP-initiated sign-in uses `POST /api/auth/:provider/start` and `/callback` with provider `saml:<workspace>`, like OIDC: `start` returns a signed AuthnRequest redirect; the ACS validates the response (signature against the IdP certificate, issuer, audience, recipient/destination, time conditions, `InResponseTo` against the request it issued) and redirects to the dashboard callback with a one-time code bound to the PKCE challenge, which `callback` exchanges. The email comes from the mapped attribute or an email-format Name ID; groups map to roles as with OIDC (JIT, trusted domains, owners never demoted, `auth.sso_login` audit). Forced SSO accepts SAML sessions too. `GET /api/auth/sso/discover` returns `saml:<workspace>` when only SAML trusts the domain.

**Session scope**: a session started with a workspace's OIDC or SAML only reaches that workspace (`403 SSO_SCOPED` elsewhere); `/api/me` lists only that workspace, and such sessions can't create workspaces or use instance-admin powers. A session from an organization's SSO (`org-oidc:<org>`, `org-saml:<org>`) reaches that organization's routes and the workspaces of the organization that use its SSO (not workspaces with their own); it can't create organizations or standalone workspaces, attach workspaces, or use instance-admin powers.

## Organizations

M4.7, ORG-01..04, 08..15. An organization groups workspaces. **Org admins** manage the organization (members, workspaces, keys, audit) and administer every workspace in it: they act as `admin` there without a membership (owners stay owners; owner-only actions stay with workspace owners). **Org members** see the organization and its catalog; their workspace access comes from each workspace. Sessions from a workspace's own SSO can't use organization routes; sessions from an organization's SSO only use their own organization's. Organization slugs follow workspace slug rules. No slug is reserved: the dashboard serves workspaces at `/w/:workspaceSlug` and organizations at `/orgs/:orgSlug`.

| Endpoint                                                            | Permission       | Notes                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/orgs`                                                    | signed-in user   | `{ name, slug }`; the creator becomes `org_admin`                                                                                                                                              |
| `GET /api/orgs`                                                     | signed-in user   | Your organizations and roles (also in `GET /api/me` as `organizations`; workspaces there carry `organization`)                                                                                 |
| `GET /api/orgs/:org`                                                | org member       | Home: workspaces (members, modules, last deploy, 24 h error rate from health rollups), 10 most recent deploys                                                                                  |
| `PATCH /api/orgs/:org`, `DELETE /api/orgs/:org`                     | org admin        | Rename; delete (only without workspaces: `409` otherwise; revokes the org keys)                                                                                                                |
| `GET /api/orgs/:org/members`                                        | org member       |                                                                                                                                                                                                |
| `POST /api/orgs/:org/members`                                       | org admin        | `{ email, role: org_admin \| org_member }`; unknown emails get an account their first sign-in links to                                                                                         |
| `PATCH`, `DELETE /api/orgs/:org/members/:id`                        | org admin        | The last `org_admin` can't be demoted or removed (`409`)                                                                                                                                       |
| `POST /api/orgs/:org/workspaces`                                    | org admin        | Creates a workspace in the org (you become its owner)                                                                                                                                          |
| `POST /api/orgs/:org/workspaces/:ws/attach`                         | org admin, owner | Moves a standalone workspace you own into the org (`409` if it belongs to another one)                                                                                                         |
| `DELETE /api/orgs/:org/workspaces/:ws`                              | org admin        | Detaches it (standalone again; its modules stop being shared). With `?delete=true&confirm=<ws>`: deletes the workspace and everything in it                                                    |
| `GET /api/orgs/:org/audit`                                          | org admin        | ORG-09: workspace events of every workspace plus org events (`workspace: null`), newest first; `workspace`, `actor`, `action` (prefix), `from`, `to`, `limit` (≤ 200), `cursor` (`nextCursor`) |
| `GET /api/orgs/:org/modules`                                        | org member       | ORG-12 catalog: every module with its workspace, owners, `shared` and active version per environment                                                                                           |
| `PUT /api/workspaces/:ws/modules/:module/shared`                    | workspace owner  | ORG-10: `{ shared: boolean }` (workspaces in an organization only)                                                                                                                             |
| `GET`, `POST /api/orgs/:org/keys`, `DELETE /api/orgs/:org/keys/:id` | org admin        | ORG-13: `{ name, scopes, workspaces?: [slug], moduleIds?, expiresAt? }` → `{ key }` once (`hq_org_<id>_<secret>`)                                                                              |

**Shared modules** (ORG-11): a shared module appears in the manifests of the organization's other workspaces, for the environment with the same name, at the owner workspace's active (stable) version, with `"shared": true` and `"ownerWorkspace": "<slug>"`. A workspace's own module of the same name wins. Kill switches apply; canaries don't (only the stable version is shared). Deploys, rollbacks and kill switches of a shared module refresh the other workspaces' cached and published manifests.

**Org API keys** (ORG-13) work like workspace keys (`Authorization: Bearer hq_org_…`, same scopes) in any workspace of the organization, or only the listed workspaces / modules; elsewhere they get `403`. Audit events record the key id as the actor.

### Organization single sign-on and provisioning

M4.7b, ORG-05..07. OIDC and SAML can be set up once for the organization: every workspace of the organization **without its own SSO** uses it (a workspace's own OIDC or SAML overrides it, ORG-05), including its forced SSO (`forceSso` on the organization; workspace owners stay exempt). Instead of a group → role mapping, the organization has **group rules** (ORG-07): `rules: [{ group, workspace, role }]` grant workspace roles (viewer, developer, admin; the most permissive matching rule wins) and `adminGroups` make organization admins.

| Endpoint                                                                                         | Permission | Notes                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/orgs/:org/sso`                                                                         | org admin  | `{ forceSso, trustedDomains, workspaces: [{ slug, name, own: "oidc" \| "saml" \| null }] }`: which workspaces use the organization's SSO                                   |
| `GET`, `PUT`, `DELETE /api/orgs/:org/sso/oidc`                                                   | org admin  | As the workspace endpoints, without `roleMapping` / `defaultRole`; provider `org-oidc:<org>` (redirect URI `…/api/auth/callback/org-oidc%3A<org>`)                         |
| `GET`, `PUT`, `DELETE /api/orgs/:org/sso/saml`, `POST …/import`, `POST …/test`, `GET …/test/:id` | org admin  | As the workspace endpoints, without `roleMapping` / `defaultRole`; provider `org-saml:<org>`; Test Connection returns to `/orgs/:org/sso`                                  |
| `GET /auth/org-saml/:org/metadata`, `POST …/acs`, `GET …/login`, `GET …/logout`, `POST …/slo`    | public     | ORG-06: the organization's SAML service provider (the workspace endpoints' counterparts; under `/auth/org-saml` so organization and workspace slugs never clash)           |
| `GET`, `PUT /api/orgs/:org/provisioning`                                                         | org admin  | `{ rules: [{ group, workspace, role }], adminGroups: [group] }`; rules must name the organization's workspaces (`400`). Applies at each user's next sign-in or SCIM change |
| `GET /api/orgs/:org/scim`, `POST …/scim/token`, `DELETE …/scim`, `GET …/scim/events`             | org admin  | The organization's SCIM token, as for workspaces; base URL `/scim/v2/orgs/:org`                                                                                            |

**Sign-in** (no org SCIM): users join the organization (`org_member`) when their email domain is trusted or one of their groups matches a rule or admin group; members of an admin group become `org_admin` (the IdP never demotes an org admin). Rules grant workspace memberships, marked as granted by the organization: they follow the rules at every sign-in and are removed when no rule matches any more. Memberships people were invited to are never changed by rules. Workspaces with their own SSO are left out. Audit: `auth.sso_login` (organization), `org.member_provisioned`, `org.member_role_synced`, `org.member_unprovisioned` (organization and workspace).

**SCIM at `/scim/v2/orgs/:org`** (ORG-07) takes the organization's token (another organization's slug, or a workspace token, gets `401`) and supports the same resources as workspace SCIM. Users created over SCIM join the organization; the rules turn their SCIM groups into workspace roles (workspaces with their own SCIM are left to it). While org SCIM is on, it alone decides access: SSO sign-in proves identity without changing memberships, and refuses deprovisioned users (`401 ACCESS_DENIED`). Deactivating or deleting a user removes them from the organization and from its workspaces, revokes their API keys there (and their org keys) and ends the sessions they started through the organization's SSO; the last organization admin and each workspace's last owner are kept (`org.deprovision_skipped`). SCIM writes are kept as `ScimAuditEvent`s of the organization; organization SCIM rows are never visible to workspace tenants.

## Provisioning (SCIM 2.0)

M4.6, SSO-24/25/28. The registry is a SCIM 2.0 service provider (RFC 7643/7644) at `/scim/v2`, for Okta, Entra ID, OneLogin and others. Requests authenticate with the workspace's SCIM token (`Authorization: Bearer hq_scim_…`), which also identifies the workspace; bodies and responses use `application/scim+json` (plain JSON is accepted), errors use the SCIM error schema.

| Endpoint                                                                    | Notes                                                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /scim/v2/ServiceProviderConfig`, `GET /scim/v2/ResourceTypes`          | Discovery                                                                                                                                    |
| `GET /scim/v2/Users`                                                        | `filter=userName eq "…"` (case-insensitive), `externalId eq`, `emails.value eq`; `startIndex`, `count` (≤ 200)                               |
| `POST /scim/v2/Users`                                                       | `201`; the email comes from `emails` (primary) or `userName`; `409` if the user exists; a deleted user comes back as the same resource       |
| `GET`, `PUT`, `PATCH`, `DELETE /scim/v2/Users/:id`                          | `PATCH` takes add/replace/remove on `active`, `userName`, `externalId`, `displayName`, `name.*`, `emails` (Entra ID's `"False"` strings too) |
| `GET /scim/v2/Groups`                                                       | `filter=displayName eq "…"` or `externalId eq`                                                                                               |
| `POST /scim/v2/Groups`, `GET`, `PUT`, `PATCH`, `DELETE /scim/v2/Groups/:id` | Members are SCIM user ids; `PATCH` adds/removes/replaces `members` (including `members[value eq "…"]`) and renames                           |

A provisioned, active user is a joined member. Group names map to roles through the workspace's SSO group → role mapping (OIDC and SAML): when the IdP pushes groups that map to roles, the role follows them (most permissive wins, the SSO default role otherwise); new users without one get the default role. Deactivating (`active: false`) or deleting a user removes the membership, revokes API keys they created in the workspace and ends the sessions they started through the workspace's SSO; SSO then refuses them (`access_denied`) until the IdP reactivates them. Owners are never demoted, and the last owner is never removed (`scim.deprovision_skipped`). Audit events: `scim.user_provisioned`, `scim.user_deprovisioned`, `scim.role_synced`, `scim.group_created|updated|deleted`; every SCIM write is also kept as a `ScimAuditEvent` with its status code (passwords dropped).

| Endpoint                                     | Permission | Notes                                                                                             |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:ws/scim`               | admin      | `{ enabled, baseUrl, tokenCreatedAt, users, groups }`                                             |
| `POST /api/workspaces/:ws/scim/token`        | admin      | `{ token, baseUrl }`: turns SCIM on, or rotates the token (shown once; the old one stops working) |
| `DELETE /api/workspaces/:ws/scim`            | admin      | Turns SCIM off (members stay)                                                                     |
| `GET /api/workspaces/:ws/scim/events?limit=` | admin      | Recent SCIM requests                                                                              |

## Approvals

APR-01..18. An environment with an approval policy holds back deploys, rollbacks, promotions (into it) and canary changes: the call returns **`202`** with `{ status: "pending_approval", requestId, requiredApprovers, expiresAt, changeTicket }` instead of applying the change (dry runs and the kill switch are not held back). Send `X-Harmoniq-Change-Ticket: <id>` when the policy requires a ticket (`400` without it).

| Endpoint                                                                       | Permission    | Description                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:ws/approval-policies`                                    | read          | Policies with their environment                                                                                                  |
| `PUT /api/workspaces/:ws/host-apps/:hostApp/environments/:env/approval-policy` | admin         | `{ requiredApprovers (1–10), eligibleRoles: ["admin","owner"], requireChangeTicket, ticketUrlPattern (with {id}), expiryHours }` |
| `DELETE …/approval-policy`                                                     | admin         | Changes no longer need approval                                                                                                  |
| `GET /api/workspaces/:ws/approvals?status`                                     | read          | Requests (newest 100) with decisions, requester and approver emails, and `canDecide` / `cannotDecideBecause` for you             |
| `GET /api/workspaces/:ws/approvals/:requestId`                                 | read          | One request                                                                                                                      |
| `POST …/approvals/:requestId/approve`                                          | eligible role | `{ comment? }`; the last required approval runs the change as the requester                                                      |
| `POST …/approvals/:requestId/reject`                                           | eligible role | `{ comment? }`; one rejection ends the request                                                                                   |
| `POST …/approvals/:requestId/bypass`                                           | owner         | `{ bypassJustification (≥20 chars) }`: runs it now, flagged `bypassed`; audited `deploy.emergency_bypass`                        |

Approvers must be signed-in users (never API keys), hold a role the policy lists, and not be the requester (`403` otherwise). Approval is atomic: whichever approval completes the count runs the change exactly once, through the same route as a direct call, so freezes and every other check apply then. Undecided requests expire after `expiryHours` (job every 5 minutes). Webhooks: `deploy.approval_requested`, `deploy.approved`, `deploy.rejected`, `deploy.approval_expired`, `deploy.emergency_bypass`. Versions created through an approval carry `approval` (requester, decisions, ticket, `bypassed`) in `GET …/versions`, and the change's audit event has `approval` in its metadata.

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

## Workspace as code

M4.10, IaC-09..12. See [workspace as code](./features/gitops.md) for the file format and semantics.

| Endpoint                         | Permission | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces/:ws/apply` | admin      | `{ config, dryRun?, prune? }` → `{ dryRun, prune, changes: [{ action: create \| update \| delete, type, key, fields?, blocked? }], summary: { create, update, delete, blocked }, secrets? }`. `config` is the parsed `harmoniq.yaml`; invalid files get `400` with `details.issues`, unknown owners or references `422` with `details.problems`, a file for another workspace `400`. `secrets`: webhook signing secrets the registry generated, shown once |
| `GET /api/workspaces/:ws/config` | admin      | The workspace as a `harmoniq.yaml` document (without webhook secrets)                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/schema/harmoniq.json`  | public     | JSON Schema of `harmoniq.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Instance administration

M4.8, INST-01..10, 18. Instance admins run the installation; the role grants nothing inside workspaces (INST-05). Every `/api/admin/*` route except the setup wizard requires a signed-in instance admin (workspace owners get `403`; sessions from a workspace's or organization's SSO never count).

| Endpoint                                    | Auth           | Notes                                                                                                                                                                                                           |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/setup`                      | public         | `{ needed, tokenConfigured }`                                                                                                                                                                                   |
| `POST /api/admin/setup/check`               | setup token    | Wizard step 2: `{ database, cache }` checks (`{ ok, latencyMs, error? }`)                                                                                                                                       |
| `POST /api/admin/setup/storage`             | setup token    | Wizard step 3: writes, reads back and deletes a probe object in the default storage                                                                                                                             |
| `POST /api/admin/setup`                     | setup token    | `{ setupToken, email, name? }`: creates the first admin and consumes the token (INST-04); `400` when no sign-in method is configured. Once consumed, every setup call gets `403` (INST-02)                      |
| `GET /api/admin/health`                     | instance admin | INST-08: `status` (`ok` / `degraded`), `checks.database`, `checks.cache`, `checks.storage` (probe), `checks.queue` (pg-boss `queued` / `active` totals and per queue), plus `stats`                             |
| `GET /api/admin/workspaces?query=&cursor=`  | instance admin | INST-09: every workspace with organization, modules, members, deploys, suspension; 50 per page (`nextCursor`)                                                                                                   |
| `POST /api/admin/workspaces/:ws/suspend`    | instance admin | `{ reason? }`. While suspended, every workspace call except reads gets `403 WORKSPACE_SUSPENDED` (API keys, members, scheduled and approved changes alike); manifests, import maps and health ingest still work |
| `POST /api/admin/workspaces/:ws/unsuspend`  | instance admin |                                                                                                                                                                                                                 |
| `DELETE /api/admin/workspaces/:ws?confirm=` | instance admin | Deletes the workspace and everything in it (`confirm` = its slug)                                                                                                                                               |
| `GET /api/admin/users?query=&cursor=`       | instance admin | INST-10: users with memberships, last sign-in, active sessions, admin flag                                                                                                                                      |
| `POST /api/admin/users/:id/revoke-sessions` | instance admin | Ends every session (refresh tokens now; access tokens expire within 15 minutes)                                                                                                                                 |
| `DELETE /api/admin/users/:id?confirm=`      | instance admin | Erases the account (`confirm` = its email): identities, sessions, memberships, the API keys they created. `409` while they're a workspace's last owner or an organization's last admin; not yourself            |
| `GET`, `POST /api/admin/admins`             | instance admin | INST-07: list; `{ email }` grants (the user must have signed in once)                                                                                                                                           |
| `DELETE /api/admin/admins/:userId`          | instance admin | Revokes; `409` for the last instance admin                                                                                                                                                                      |
| `GET /api/admin/settings`                   | instance admin | INST-11..16: `{ storage, email, auth, branding }`, each `{ source: "database" \| "environment", value }` with secrets masked                                                                                    |
| `PUT /api/admin/settings/:key`              | instance admin | Saves a setting (below); omitted secrets keep the stored ones. Storage is tested first (write, read back, delete; `400` if it fails). Audited as `instance.config_updated` with the changed field names only    |
| `DELETE /api/admin/settings/:key`           | instance admin | Back to the environment's value                                                                                                                                                                                 |
| `POST /api/admin/settings/storage/test`     | instance admin | Tests the storage in use                                                                                                                                                                                        |
| `POST /api/admin/settings/email/test`       | instance admin | INST-12: sends a test email to you; `400` with the SMTP error                                                                                                                                                   |
| `GET /api/instance`                         | public         | INST-14: `{ branding: { name, logoUrl?, supportUrl?, accentColor? } }`                                                                                                                                          |
| `GET /api/admin/audit?cursor=`              | instance admin | INST-18: instance changes (`instance.*`), newest first; never config values or secrets, and user deletions record the id only                                                                                   |

**Instance settings** (M4.8b, INST-11..17) live in the database (secrets sealed) and override the environment, which only provides defaults; every registry reloads them every 60 seconds, and the one that saved a change applies it at once, without a restart.

- `storage`: `{ adapter: "none" }`, `{ adapter: "local" }` (`LOCAL_STORAGE_DIR`), `{ adapter: "s3", bucket, region, endpoint?, accessKeyId?, secretAccessKey?, publicUrl? }` `{ adapter: "gcs", bucket, projectId, clientEmail, privateKey?, publicUrl? }` or `{ adapter: "azure", container, connectionString?, publicUrl? }`: the default storage for published manifests and bundles.
- `email`: `{ host, port, security: "tls" | "starttls" | "none", username?, password?, from }`.
- `auth`: `{ email: { enabled }, github: { enabled, clientId?, clientSecret? }, oidc: { enabled }, saml: { enabled } }`. A disabled method is gone for everyone (INST-13): it leaves `GET /api/auth/providers`, its sign-in endpoints answer `404`, and workspaces and organizations can neither use nor save OIDC / SAML settings (`403`). Existing sessions continue until they expire.
- `branding`: `{ name, logoUrl?, supportUrl?, accentColor? }`, used by the dashboard header and tab title and in emails.

## Health

| Endpoint       | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `GET /health`  | Always `{ "status": "ok" }`                                                    |
| `GET /ready`   | Checks both database roles and the cache; `503` if not ready                   |
| `GET /metrics` | Prometheus: cache hits/misses, deploys, `harmoniq.manifest.rate_limited_total` |

---

## Planned

| Endpoint                       | Milestone |
| ------------------------------ | --------- |
| Plans and limits, audit export | M4.11     |
