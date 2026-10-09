# Harmoniq — Product & Codebase Analysis

> **Date**: 2026-10-08
> **Scope**: Full repository review (requirements, architecture docs, registry, dashboard, SDK, CLI, DB schema, infra)
> **Verdict**: Strong, well-timed use case with an unusually thorough spec. The implementation covers roughly 15–20% of that spec. Several security defects block any real deployment. Focus first on finishing the core loop (deploy → manifest → load → rollback). Add enterprise breadth after that.

---

## 1. Is the use case helpful?

**Yes. It addresses a real gap with little competition.**

### The problem is real

Teams using Module Federation, Native Federation or import maps usually hardcode remote URLs at build time, or keep them in a hand-maintained JSON file on a CDN. In practice this causes:

- Host redeploys for every remote release. This removes the main benefit of micro frontends, which is independent deployment.
- Slow rollback, because a rollback is a full CI/CD run.
- No answer to "what version of `checkout` is live in prod right now?"
- No safe progressive delivery for frontend modules.

### Market position

| Alternative                                        | What it lacks that Harmoniq targets                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hand-rolled `remotes.json` on S3/CDN               | No history, rollback, canary, audit, or RBAC                                                       |
| Module Federation 2.0 runtime + `mf-manifest.json` | Defines a manifest _format_, not a control plane (no environments, promotion, or rollback UI)      |
| Zephyr Cloud                                       | SaaS, tied to its build plugins; not self-hostable or vendor-neutral                               |
| single-spa `import-map-deployer`                   | Import maps only, minimal UI/governance, no canary                                                 |
| Feature-flag tools (LaunchDarkly, Unleash)         | Can toggle URLs with workarounds, but don't understand modules, integrity, dependencies or bundles |

**Harmoniq's differentiators:** self-hostable, bundler-agnostic (MF, Native Federation, import maps, SystemJS), and Apache 2.0. The enterprise governance features (approvals, freezes, SSO, audit) are what large organisations buy. That combination is a good open-core position.

### Risks to the use case

1. **Scope vs. adoption.** The PRD has about 300 requirements, including SAML, SCIM, org hierarchy, 4-eyes approvals and GitOps. Early adopters mainly want: _deploy a remote, see it live, roll it back in one click, canary it._ Building enterprise breadth before that loop works delays adoption.
2. **Manifest delivery is now a runtime dependency.** If the registry is down when a host boots and the client has no cached manifest, the app breaks. Resilience (CDN-published manifests, embedded fallbacks) must be a first-class feature, not an afterthought (see §5.1).
3. **Competition from bundler vendors.** Module Federation 2.0 and Zephyr are moving into this space. Harmoniq's advantage is neutrality, so that needs to show in the product (e.g. a generic `remotes` adapter for each bundler).

---

## 2. Current state: spec vs. implementation

`docs/implementation-plan.md` has **0 of 308 tasks checked**. The codebase confirms that most of the spec is not implemented yet.

| Area                                    | Spec                 | Implemented        | Notes                                                                                            |
| --------------------------------------- | -------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| Manifest endpoint (canonical)           | MAN-01..06           | 🟡 Partial         | Shape doesn't match `ManifestSchema`; ETag broken on cache hit; no stale fallback                |
| Legacy manifest endpoint                | HST-02               | ❌                 |                                                                                                  |
| Deploy                                  | VER-01..03           | 🟡 Partial         | Always deploys to `production`; ignores `commitSha`/`dependencies`/`exposes`/`metadata`          |
| Rollback / Promote / Canary APIs        | VER-04, PRO-_, CAN-_ | ❌                 | No routes exist                                                                                  |
| Canary sticky assignment                | CAN-02..08           | ❌                 | Header hard-coded to `stable`                                                                    |
| Import maps / SystemJS                  | IMP-01, §15.4        | ❌                 |                                                                                                  |
| Snapshots / Diff                        | SNAP-_, DIFF-_       | ❌                 | Tables exist, never written                                                                      |
| Audit log                               | AUD-01..04           | ❌                 | `AuditEvent` never written anywhere                                                              |
| API key management                      | KEY-01..05           | 🟡 Verify only     | No create/rotate/revoke endpoint; expiry and `lastUsedAt` ignored                                |
| RLS / tenant isolation                  | MT-01..05            | ❌ in practice     | `getTenantClient` exists but is never used                                                       |
| Webhooks                                | WHK-*                | 🟡                 | Delivery, HMAC and dead-letter queue (DLQ) exist; only `module.deployed` fires; no endpoint CRUD |
| GC jobs                                 | GC-*                 | 🟡                 | Implemented, but conflicts with rollback promise (see §3)                                        |
| Alerts / staged rollout / auto-rollback | ALT-*, §5.20         | ❌ Stubs           | Jobs log "stub"                                                                                  |
| Health reporting                        | HLT-*                | ❌                 | SDK posts to `/api/modules/:id/health`, which doesn't exist                                      |
| Dashboard                               | §Phase 3             | 🟡 Read-only shell | 4 list pages; no module detail, deploy history, rollback button, keys, members, audit, webhooks  |
| Auth (dashboard)                        | OAuth/SSO            | ❌ Mock            | See §3                                                                                           |
| SDK                                     | §9                   | 🟡                 | Core fetch/ETag/poll; several bugs (see §4)                                                      |
| CLI                                     | §10                  | 🟡 Mostly stubs    | `promote`, `rollback`, `validate`, `login`, `whoami` print success without doing anything        |
| Self-hosting                            | Docker Compose       | ❌                 | Compose has only Postgres + Redis; no Dockerfiles                                                |
| Helm chart                              | v2 non-goal          | 🟡                 | Present (contradicts PRD), registry only                                                         |

---

## 3. Critical issues (fix before anything else)

These are security or correctness defects. Any one of them would cause an incident in a real deployment.

### 3.1 Cross-tenant deploy: the API key's workspace is never checked

[apps/registry/src/routes/deploy.ts](../apps/registry/src/routes/deploy.ts) looks up the workspace by URL slug and never compares it to `request.apiKey.workspaceId`. **Any valid API key from any workspace can deploy to any other workspace's production.** The same applies to `upload-url` and the webhook DLQ retry route.
**Fix:** in `verifyApiKey` (or a shared preHandler), resolve the workspace and reject with 403 if `apiKey.workspaceId !== workspace.id`. Also enforce `moduleIds` (module-scoped keys) and `expiresAt`.

### 3.2 Dashboard login accepts any OAuth code

[apps/web/src/app/api/auth/callback/github/route.ts](../apps/web/src/app/api/auth/callback/github/route.ts): any `code` other than `mock_code` logs the caller in as `realuser@example.com`, and no OAuth exchange happens. The `state` parameter is not validated (CSRF).

### 3.3 No authorization on workspace pages

Dashboard pages query `db.workspace.findUnique({ where: { slug } })` with no membership check. Any logged-in user can view any workspace by changing the URL.

### 3.4 Storage credentials stored and returned in plaintext

`credentialsEncrypted` is stored exactly as received (no encryption). `GET /api/workspaces/:slug/storage` returns it in full, including `secretAccessKey`/`privateKey`. Encrypt at rest (envelope encryption with a `HARMONIQ_ENCRYPTION_KEY`/KMS) and never return secrets; return `"••••1234"` plus `lastVerifiedAt`.

### 3.5 Insecure secret defaults

`JWT_SECRET || 'changeme'` (registry) and `|| 'super-secret-key-for-development-only'` (web). Fail fast at boot when `NODE_ENV=production` and the secret is missing or is a default. The Helm `values.yaml` also ships `JWT_SECRET: "changeme"`.

### 3.6 RLS is not active

The registry and dashboard instantiate a raw `PrismaClient`. `getTenantClient` is never called, so the RLS defense-in-depth layer the PRD relies on is not in effect. If the DB role _does_ enforce RLS, every query returns nothing. Choose one approach and add an integration test that proves cross-tenant reads fail.

### 3.7 GC contradicts "instant rollback to any previous version"

`gc.softDelete` marks **all** inactive versions older than 30 days, and `gc.hardDelete` removes them 7 days later. It ignores `Workspace.retentionDays` (default 90) and has no "keep last N versions" floor. A module that hasn't been deployed for 5 weeks loses its whole rollback history.
**Fix:** retain at least the last N (e.g. 10) versions per module+environment regardless of age, and respect `retentionDays`.

### 3.8 Rollback/promote CLI commands report false success

`harmoniq rollback` and `harmoniq promote` print "Successfully rolled back…" and exit 0 without making any request. In CI or during an incident, this is worse than an unimplemented command. Until they're real, they should exit non-zero with "not implemented".

### 3.9 Storage settings UI and API disagree

The admin storage page POSTs `{ provider, config }`. The route (changed in commit `44eaf46`) expects `{ provider, bucket, region, credentialsEncrypted, … }` with no validation, so saving from the UI writes `undefined` fields. Validate with `WorkspaceStorageConfigSchema` (it already exists in `@harmoniq/core`) and update the UI.

---

## 4. Functional bugs and inconsistencies

| #   | Location              | Problem                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `routes/manifest.ts`  | On cache hit, the ETag is `manifestObj.integrity` (always undefined), so the value is `W/"cached"`. Conditional requests break, and the cached body leaks the internal `_etag` field.                                                                                                                                           |
| 2   | `routes/manifest.ts`  | ETag is truncated base64 of the body, not a hash. Two manifests sharing a 20-byte prefix get the **same ETag**, so clients never see the update. Use `sha256` of the body.                                                                                                                                                      |
| 3   | `routes/manifest.ts`  | Response shape (`modules` as an object, `timestamp`, `hostApp` as a string) doesn't match `ManifestSchema` in `@harmoniq/core` (array of modules, `generatedAt`, `workspaceSlug`, `variant`, `cohortId`, `etag`). Pick one shape and validate the response against it in tests.                                                 |
| 4   | `routes/manifest.ts`  | MAN-06 stale fallback not implemented: a DB error returns 500 even when a last-good manifest could be served. Keep a long-TTL `manifest:lkg:*` key.                                                                                                                                                                             |
| 5   | `routes/manifest.ts`  | Excludes `canary` versions entirely. Also, `deletedAt` isn't filtered.                                                                                                                                                                                                                                                          |
| 6   | `routes/deploy.ts`    | Hard-codes the `production` environment. The CLI sends `environment`, but `DeployRequestSchema` has no such field, so it is silently dropped.                                                                                                                                                                                   |
| 7   | `routes/deploy.ts`    | Doesn't persist `commitSha`, `metadata`, `dependencies`, `exposes`; doesn't write an `AuditEvent` or `ManifestSnapshot`; doesn't check environment freeze or approval policy; `dryRun` returns before the version is validated.                                                                                                 |
| 8   | `routes/deploy.ts`    | Cache invalidation uses `invalidatePattern` but the legacy `/manifest/:ws/:env` key (when added) won't be covered. Centralise cache key construction.                                                                                                                                                                           |
| 9   | `plugins/auth.ts`     | Token format is `<keyId>.<secret>`, but the spec says `hq_` + 32 random bytes. Scope name is `module:write`; the spec says `deploy:write`. No `expiresAt` check, `lastUsedAt` update, or rotation grace period. Argon2 runs on every request, so expect noticeable CPU on CI bursts; consider a short-lived verified-key cache. |
| 10  | `client/src/index.ts` | `init()` starts a **new `setInterval` every call**. `useRemoteModule` calls `init()` per hook instance, so N modules give N pollers. The interval handle is never cleared (`stopPolling` only flips a flag).                                                                                                                    |
| 11  | `client/src/react`    | Listens for `manifestUpdated`, but the client emits `manifestUpdate`, so React components never react to updates.                                                                                                                                                                                                               |
| 12  | `client/src/react`    | `HarmoniqProvider` renders `null` until mounted. That gives a blank screen during SSR and on first paint, and there is no fallback prop.                                                                                                                                                                                        |
| 13  | `client/src/index.ts` | `variantAssigned` is emitted on _every_ poll that returns canary, not "on first assignment". `cohortId` is never read.                                                                                                                                                                                                          |
| 14  | `client/src/index.ts` | `reportModuleLoad` posts to a nonexistent endpoint and sends the API key from the browser. Browser SDKs must never hold write keys; use a public ingest token or an unauthenticated, rate-limited endpoint.                                                                                                                     |
| 15  | `client`              | `getScriptTag` interpolates URL/integrity into HTML without escaping. No retry/backoff. Doesn't actually _load_ modules (no MF `init`/`loadRemote` integration).                                                                                                                                                                |
| 16  | Ports                 | Registry: `.env.example`/code = 4000, README = 3001, dashboard fetch default = 3002, Helm = 3002, CLI default = 3000 (the dashboard). Settle on one.                                                                                                                                                                            |
| 17  | `cors: origin '*'`    | Fine for the public manifest GET, not for write/admin routes. Scope CORS per route.                                                                                                                                                                                                                                             |
| 18  | Admin auth            | Admin JWT stored in `localStorage` (XSS-exposed). The registry signs JWTs with no expiry.                                                                                                                                                                                                                                       |
| 19  | CI                    | Uses pnpm 8, but `engines` requires ≥ 9. The `changelog:check` rule in `AGENTS.md` isn't wired in CI. No build step, so Docker images are never produced.                                                                                                                                                                       |
| 20  | Dashboard             | Overview always shows "Healthy" (hard-coded); a `new PrismaClient()` per page file risks exhausting the connection pool in dev; the web app talks to the DB directly _and_ to the registry. Pick one path (prefer the registry API so authorization lives in one place).                                                        |

---

## 5. Gaps and suggestions to make Harmoniq especially useful

These are ordered by value to a first-time adopter.

### 5.1 Make manifest delivery resilient (highest leverage)

The registry becomes part of every page load, so this is what decides production adoption.

- **Publish manifests to the CDN/bucket on every change** (`/manifests/{ws}/{host}/{env}.json`), with the registry API as the source of truth. Hosts can read from the CDN, so the registry can go down without taking production with it. This also delivers global low latency without scaling the registry.
- **Build-time fallback manifest**: `harmoniq manifest pull > fallback.json` in the host's CI, so the SDK can boot when both CDN and registry are unreachable.
- **SDK persistent cache** (localStorage/IndexedDB) of the last-good manifest, plus configurable timeout and then fallback.
- **Edge resolution recipe** (Cloudflare Worker / Lambda@Edge / Next.js middleware) that resolves canary cohorts at the edge and inlines the manifest into the HTML. This removes a round-trip before first render.

### 5.2 Complete the core loop end to end

Build this before any enterprise feature:

1. `harmoniq deploy --env staging` (environment respected, metadata stored, audit written, snapshot written).
2. Module detail page: per-environment version timeline, current active version, and a **one-click Rollback** button with confirmation.
3. `harmoniq promote staging → production` that copies the exact artifact (same URL + integrity), so production can only run what was tested.
4. Manifest diff between any two snapshots ("what changed at 14:02?").
5. Real GitHub OAuth, membership checks, and API key creation in the UI.

This is the minimum loveable product. Ship it, gather users, then move to canary and governance.

### 5.3 Native bundler integration (main DX advantage)

Currently the SDK returns a URL and leaves loading to the host. Ship first-class integrations:

- **Module Federation 2.0 runtime plugin**: `@harmoniq/mf-plugin` that uses MF's `beforeRequest`/`loadRemote` hooks to resolve remotes from the Harmoniq manifest. Zero code change in components.
- **Native Federation** (`@angular-architects/native-federation`): a `federation.manifest.json` endpoint in its exact format.
- **Import maps**: `GET /api/importmap/...` (already in the spec), plus `es-module-shims` guidance.
- **Vite / Rspack / Webpack build plugins** that compute SRI and call `harmoniq deploy` after build: `harmoniqPlugin({ module: 'checkout' })`.
- **GitHub Action**: `uses: harmoniq/deploy-action@v1`, which most teams will adopt before the CLI.

### 5.4 Shared-dependency compatibility checks

This is a common source of runtime failures in federated apps (two React copies, mismatched design-system majors). The schema already stores `dependencies`; act on it:

- Pre-deploy gate: reject (or warn) when a remote's `react: ^19` conflicts with the host's shared `react: 18.x`.
- Environment **dependency matrix** view (module × shared dep), with conflicts highlighted.
- Detection of `exposes` contract changes: warn when a module removes an exposed path that a host imports.

### 5.5 Close the loop with observability

Canary releases only help if they connect to signals.

- Implement `/health` ingest (batched with `navigator.sendBeacon`, sampled, rate-limited, no API key) and show load-success rate and p95 load time per version and variant.
- **Error-tracker integrations**: tag Sentry/Datadog RUM events with `harmoniq.module`, `harmoniq.version`, `harmoniq.variant` automatically from the SDK. That makes "is the canary worse?" easy to answer.
- Then implement **auto-rollback** (jobs are stubbed): if canary error rate exceeds the stable rate by X% over N minutes, roll back and notify.
- Use OpenTelemetry trace attributes on the host page load.

### 5.6 Developer experience

- **Local override / dev mode**: a browser extension or `?harmoniq-override=checkout@http://localhost:3001/remoteEntry.js` query param (signed or dev-only), so a developer can test a local remote against a deployed host. This is likely to be one of the most-used features.
- **Preview environments per PR**: `harmoniq deploy --env pr-123 --ephemeral` with auto-cleanup on PR close, plus a "preview link" comment on the PR.
- **Manifest schema as a public, versioned JSON Schema** published to a URL, so other tools can consume it.
- **`harmoniq doctor`**: checks that the URL is reachable, CORS headers are correct, SRI matches, and `remoteEntry` exposes what it claims.
- Validate bundles server-side on deploy: fetch the URL, verify SRI, check `Access-Control-Allow-Origin`. CLI `validate` is currently a stub.

### 5.7 Delivery strategies beyond percent canary

- **Targeted rollouts**: route by header, cookie, tenant ID, region, or internal-employee flag ("dogfood" cohort). Enterprise B2B apps often need "customer X gets the new checkout first".
- **Scheduled releases** and **time-based staged rollout** (1% → 10% → 50% → 100%, gated by health). The schema has `rolloutSchedule` but nothing reads it.
- **Kill switch**: disable a module (serve a host-defined fallback) without rolling back.

### 5.8 Governance: build it small and correct

Rather than building SAML/SCIM/org hierarchy/4-eyes all at once:

- Phase A: RBAC (owner/admin/developer/viewer) enforced in one middleware, audit log written on every mutation, environment freeze.
- Phase B: approval policies for production, Slack/Teams approvals via webhooks.
- Phase C: OIDC (covers Okta, Entra and Google in one integration), then SAML/SCIM for the paid tier.
- **GitOps**: a `harmoniq.yaml` declaring host apps, environments, modules and policies, applied with `harmoniq apply`. Platform teams will prefer this over a UI.

### 5.9 Self-hosting must be real

"Trivially self-hostable" is currently untrue:

- Add `Dockerfile`s for `registry` and `web`, and add both to `docker-compose.yml` with healthchecks.
- A single `docker compose up` must yield a working instance, including migrations and a first-boot setup token printed to logs.
- Publish images to GHCR in CI; add a Terraform module for AWS (ECS + RDS + ElastiCache).
- Document backup/restore and HA (multiple registry replicas, Redis required for cross-node invalidation; InMemoryLRU is single-node only and invalidation won't propagate).

### 5.10 Product positioning and docs

- A **5-minute quickstart** with a working example repo (host + two remotes on Vite + MF 2.0) is worth more than any additional feature.
- A comparison page (vs. Zephyr, `import-map-deployer`, hand-rolled JSON).
- Reduce `requirements.md` to v1/v1.1/v2 tiers that reflect reality; mark the Helm chart status consistently.

### 5.11 Email sign-up and authentication strategy

**Question:** Can users sign up with email via Firebase Authentication?

**Short answer:** Yes, but only as an **optional adapter**, never as the default or a required dependency.

#### Why Firebase shouldn't be the default

| Concern           | Impact                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosting      | Every self-hoster would need a Google Cloud project. Air-gapped and on-prem installs (often the enterprise buyers) couldn't use Harmoniq.                                                                                   |
| Vendor neutrality | Conflicts with the hexagonal, vendor-agnostic positioning in the README and PRD.                                                                                                                                            |
| Data ownership    | Identities would live in Google, while `User`, `WorkspaceMember`, `AuditEvent` and `ApiKey` live in Postgres. That causes sync problems and complicates GDPR exports/deletes.                                               |
| Port mismatch     | The current `OAuthPlugin` port assumes a redirect/code-exchange flow. Firebase is client-SDK based (`signInWithEmailLink` in the browser → ID token → server verifies), so it doesn't fit without changing the abstraction. |

#### Recommended approach

1. **Built-in passwordless email (magic link / OTP) as the default.**
   - The user enters an email; Harmoniq stores a **hashed, single-use, 15-minute** token in Postgres and sends a link or 6-digit code via the instance SMTP config (INST-12).
   - No passwords to store or reset, and no third-party dependency. It works with domain auto-join (SSO-22) and JIT provisioning (SSO-06).
   - Required safeguards: per-email and per-IP rate limiting, constant-time token comparison, and a generic "if that address exists, we sent a link" response to prevent email enumeration. Bind the link to the requesting browser (state cookie) to prevent login CSRF.
   - Libraries such as Better Auth or Auth.js (with a Postgres adapter) provide this already.
2. **Optional email + password** (Argon2id, already the project standard), only if users ask for it. It adds reset flows, breach checks and credential-stuffing defences, so defer it.
3. **Pluggable external identity providers** (Firebase, Supabase Auth, Clerk, Auth0, Keycloak, Authentik) through one generalised port. External IdPs only _prove identity_. Harmoniq always creates the `User` row in its own Postgres and issues **its own session cookie**, so the IdP is never on the request path after login.

#### Proposed port: generalise `OAuthPlugin` → `IdentityProvider`

Replace `packages/core/src/ports/OAuthPlugin.ts` with a discriminated union that covers the three login flows:

```ts
// packages/core/src/ports/IdentityProvider.ts

export interface IdentityUserInfo {
  /** Stable subject ID at the provider (e.g. GitHub user id, Firebase uid). */
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

interface IdentityProviderBase {
  /** Unique key, e.g. 'github', 'google', 'oidc', 'email', 'firebase'. */
  id: string;
  displayName: string;
}

/** Redirect-based providers: GitHub, Google, generic OIDC, SAML. */
export interface RedirectIdentityProvider extends IdentityProviderBase {
  kind: 'redirect';
  // Receives the PKCE challenge; the verifier only travels at the code exchange.
  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  handleCallback(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdentityUserInfo>;
}

/** Client-SDK providers that hand the server a signed token: Firebase, Supabase, Clerk. */
export interface TokenIdentityProvider extends IdentityProviderBase {
  kind: 'token';
  /** Verify signature, issuer, audience and expiry; throw on any failure. */
  verifyToken(idToken: string): Promise<IdentityUserInfo>;
  /** Public config the dashboard needs to initialise the client SDK (no secrets). */
  getClientConfig(): Record<string, string>;
}

/** Built-in passwordless email (magic link / OTP). */
export interface EmailIdentityProvider extends IdentityProviderBase {
  kind: 'email';
  /** Always resolves (no user enumeration); rate-limited by the caller. */
  requestLogin(params: { email: string; redirectUri: string }): Promise<void>;
  verifyLogin(params: { token: string }): Promise<IdentityUserInfo>;
}

export type IdentityProvider =
  RedirectIdentityProvider | TokenIdentityProvider | EmailIdentityProvider;
```

#### Supporting changes

- **Schema:** add an `Identity` table so one `User` can link several providers, and so an IdP's email change doesn't silently create a duplicate user:
  ```prisma
  model Identity {
    id             String   @id @default(cuid())
    userId         String
    provider       String   // 'github' | 'email' | 'firebase' | ...
    providerUserId String
    createdAt      DateTime @default(now())
    user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
    @@unique([provider, providerUserId])
  }

  model EmailLoginToken {
    id        String    @id @default(cuid())
    email     String
    tokenHash String    @unique
    expiresAt DateTime
    usedAt    DateTime?
    createdAt DateTime  @default(now())
    @@index([email, createdAt])
  }
  ```
- **Account linking rule:** link a new identity to an existing `User` by email **only if `emailVerified === true`**. Otherwise an attacker could register an unverified email at one provider and take over the matching Harmoniq account.
- **Single login service:** all providers go through one `completeLogin(userInfo)` function that upserts `User` + `Identity`, applies domain auto-join, writes an `AuditEvent` (`auth.login`), and issues the Harmoniq session plus a DB-backed refresh token. The GitHub callback in [route.ts](../apps/web/src/app/api/auth/callback/github/route.ts) (§3.2) becomes a thin wrapper around it.
- **Configuration:** enabled providers are configured per instance (`InstanceConfig`), and optionally restricted per workspace (`WorkspaceConfig.forceSso` already exists). Firebase settings (`projectId`, web API key) go in instance config; the service-account key is encrypted at rest (same mechanism as §3.4).
- **Firebase adapter specifics:** verify with `firebase-admin`'s `verifyIdToken(token, /* checkRevoked */ true)`, require `email_verified`, and keep `firebase-admin` in a separate optional package (`@harmoniq/auth-firebase`), so the core install stays dependency-free.

#### Rollout

| Step                                                                                  | Milestone                         |
| ------------------------------------------------------------------------------------- | --------------------------------- |
| `IdentityProvider` port, `Identity` table, `completeLogin` service, real GitHub OAuth | M0 (replaces the mocked callback) |
| Built-in email magic link / OTP                                                       | M1                                |
| Google + generic OIDC (covers Okta / Entra / Keycloak)                                | M2–M4                             |
| Optional token adapters: Firebase, Supabase, Clerk                                    | Community / on demand             |
| SAML + SCIM                                                                           | M4 (enterprise tier)              |

---

## 6. Recommended roadmap

| Milestone                                    | Goal                           | Key items                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M0 — Make it safe (1–2 wks)**              | No exploitable defects         | §3.1–3.9; tenant check on all API-key routes; `IdentityProvider` port + real GitHub OAuth (§5.11); membership checks; encrypt credentials; fail-fast secrets; fix CLI false-success                                                        |
| **M1 — Core loop (3–4 wks)**                 | Deploy → see → roll back works | Email magic-link sign-up, env-aware deploy, rollback/promote APIs + CLI, audit + snapshots, manifest shape fixed to schema, correct ETag, LKG fallback, module detail page with history + rollback button, API key UI, real Docker Compose |
| **M2 — Production-grade delivery (3–4 wks)** | Safe for production            | CDN-published manifests, SDK persistent cache + fallback, MF 2.0 runtime plugin, Vite/Rspack plugins, GitHub Action, local override, deploy-time bundle validation                                                                         |
| **M3 — Progressive delivery (4 wks)**        | Releases with less risk        | Sticky canary, health ingest, Sentry/Datadog tagging, staged rollout, auto-rollback, targeted cohorts, kill switch, dependency gate                                                                                                        |
| **M4 — Enterprise (ongoing)**                | Monetizable tier               | RBAC + module ownership, freezes, approvals, OIDC→SAML/SCIM, GitOps `harmoniq.yaml`, org hierarchy                                                                                                                                         |

---

## 7. Test coverage observations

- Tests exist for schemas, webhooks, GC, storage, and an RLS test, but **no test exercises cross-tenant access through the API**. That test would have caught §3.1.
- `performance.test.ts` exists, but the p99 < 50 ms target can't be meaningful until the cache-hit path is correct.
- CLI tests assert on stub output, so they pass while the commands do nothing. Test against a mock registry (msw) instead.
- Add a contract test: the manifest endpoint response must parse with `ManifestSchema`. That catches the drift in §4.3.

---

## 8. Summary

Harmoniq targets a real need that few tools serve: an **open, self-hosted, bundler-neutral control plane for micro frontends**. The architecture choices (hexagonal ports, Postgres + pg-boss, Redis cache, ETag manifests, append-only versions) are sound, and the requirements document is more mature than most commercial products' specs.

The main risk is **breadth before depth**. The schema models SSO, SCIM, approvals and organizations, but deploy ignores the environment, rollback doesn't exist, and any API key can deploy to any tenant. Narrow the focus to a secure, resilient deploy → manifest → load → rollback loop with native Module Federation integration and CDN-backed manifests. With that in place, Harmoniq has a credible path to becoming the default tool in this category.
