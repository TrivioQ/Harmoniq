# Self-Hosting Harmoniq

Harmoniq runs as two services — the **registry** (API, port 4000) and the **dashboard** (Next.js, port 3000) — backed by **PostgreSQL 15+** (data and background jobs) and optionally **Redis** (shared manifest cache; required with more than one registry replica).

## Try it locally

```bash
pnpm run docker:demo
```

This builds both images, starts Postgres and Redis, applies migrations, seeds a demo workspace and starts the registry and dashboard. Open http://localhost:3000 and use **Development sign-in** with `demo@harmoniq.dev` (owner of the `acme-corp` demo workspace). Stop with `pnpm run docker:demo:down`.

The demo runs in development mode (development secrets, "sign in as any email"). Do not expose it to the internet.

Without Docker, `pnpm run dev:local` runs the same stack from source on an embedded Postgres (downloaded as an npm package) with an in-memory cache; see the [README](../README.md#quick-start-development).

## Production

### 1. Database roles

Harmoniq uses two Postgres roles:

| Role           | Used by                                          | RLS              |
| -------------- | ------------------------------------------------ | ---------------- |
| `harmoniq`     | Schema owner: migrations, background jobs, admin | Bypasses (owner) |
| `harmoniq_app` | All tenant-scoped requests                       | Always applies   |

On a self-managed Postgres, create them once as a superuser (see `docker/init.sql`, with your own passwords):

```sql
CREATE USER harmoniq WITH PASSWORD '…' CREATEDB;
CREATE USER harmoniq_app WITH PASSWORD '…';
CREATE DATABASE harmoniq OWNER harmoniq;
```

On a managed database (RDS, Cloud SQL, Azure) where you only have the master user, make that user the owner and let the registry create the app role from `DATABASE_URL`'s credentials. Run this **before** the first migration — otherwise an early migration creates `harmoniq_app` with a placeholder password:

```bash
docker run --rm -e DATABASE_URL=… -e SYSTEM_DATABASE_URL=… harmoniq/registry npx tsx scripts/bootstrap-db.ts
```

It is idempotent and re-applies the password, so it also rotates it. In production the registry refuses to start while the app role still accepts the placeholder password (MT-11); running this script fixes it. Then run migrations as the owner (the registry image includes the Prisma CLI):

```bash
docker run --rm -e DATABASE_URL=… -e SYSTEM_DATABASE_URL=… \
  -w /repo/packages/db harmoniq/registry npx prisma migrate deploy
```

### 2. Configuration

Put these in `docker/.env` for Compose, or in your orchestrator's secret store:

| Variable                                                                   | Service   | Description                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                 | both      | `production` (the registry refuses default secrets in production)                                                                                                                                                                                                                                                                                                                       |
| `DATABASE_URL`                                                             | registry  | `postgresql://harmoniq_app:…@host:5432/harmoniq`                                                                                                                                                                                                                                                                                                                                        |
| `SYSTEM_DATABASE_URL`                                                      | registry  | `postgresql://harmoniq:…@host:5432/harmoniq`                                                                                                                                                                                                                                                                                                                                            |
| `JWT_SECRET`                                                               | both      | Same value on registry and dashboard; ≥ 32 random chars (`openssl rand -base64 48`)                                                                                                                                                                                                                                                                                                     |
| `HARMONIQ_ENCRYPTION_KEY`                                                  | registry  | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts stored credentials and webhook secrets. Keep a backup — losing it makes them unreadable.                                                                                                                                                                                                                                  |
| `HARMONIQ_ENCRYPTION_KEYS`                                                 | registry  | Instead of `HARMONIQ_ENCRYPTION_KEY`, a keyring for rotation (INST-26): `label:base64,label:base64`, the first one active, the others still opening older values. See [Rotating the encryption key](#rotating-the-encryption-key).                                                                                                                                                      |
| `HARMONIQ_ADMIN_REQUIRE_MFA`                                               | registry  | INST-32: instance admins must sign in with MFA (or the instance's own OIDC) to use the admin API. Default `1` in production, `0` otherwise.                                                                                                                                                                                                                                             |
| `HARMONIQ_ADMIN_IP_ALLOWLIST`                                              | registry  | INST-32: optional comma-separated IPs or CIDRs allowed to reach `/api/admin` (behind a proxy, set `TRUST_PROXY`).                                                                                                                                                                                                                                                                       |
| `HARMONIQ_VERSION`, `HARMONIQ_COMMIT`                                      | registry  | INST-28: shown per replica on **Admin → Health**. The registry image sets them from the build arguments of the same name (`docker build --build-arg HARMONIQ_COMMIT=$(git rev-parse HEAD) …`).                                                                                                                                                                                          |
| `APP_URL`                                                                  | dashboard | Public dashboard URL; also set the registry's `WEB_ORIGIN` to it                                                                                                                                                                                                                                                                                                                        |
| `WEB_ORIGIN`                                                               | registry  | Dashboard origin (CORS, allowed sign-in redirects)                                                                                                                                                                                                                                                                                                                                      |
| `REGISTRY_URL`                                                             | dashboard | URL the dashboard uses to reach the registry (can be internal)                                                                                                                                                                                                                                                                                                                          |
| `CACHE_ADAPTER`, `REDIS_URL`                                               | registry  | `redis` + URL; **required with more than one replica** (the in-memory cache isn't shared, and the registry warns at startup)                                                                                                                                                                                                                                                            |
| `STORAGE_ADAPTER`                                                          | registry  | Where published manifests go: `s3`, `local` (dev default) or `none` (production default)                                                                                                                                                                                                                                                                                                |
| `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_URL`                                  | registry  | Bucket for published manifests and its public (CDN) base URL; `S3_ENDPOINT` for S3-compatible stores                                                                                                                                                                                                                                                                                    |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                 | registry  | Optional; omit both to use the AWS default credential chain (ECS task role, instance profile)                                                                                                                                                                                                                                                                                           |
| `PUBLIC_URL`                                                               | registry  | Public registry URL (links in emails, `/static` URLs, SAML endpoints: browsers post to its ACS)                                                                                                                                                                                                                                                                                         |
| `HARMONIQ_SETUP_TOKEN`                                                     | registry  | One-time token for the first-boot wizard at `/admin/setup`                                                                                                                                                                                                                                                                                                                              |
| `SMTP_URL`, `MAIL_FROM`                                                    | registry  | Email sign-in (magic link + code)                                                                                                                                                                                                                                                                                                                                                       |
| `HARMONIQ_AUTH_METHODS`                                                    | registry  | Comma-separated allowlist of sign-in methods: `github`, `email`, `oidc` (the instance IdP), `sso-oidc` and `sso-saml` (configured by workspaces and organizations), `dev`. Empty: every configured method. The admin panel can turn listed methods off but never on; sessions from other methods end at their next request                                                              |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                 | registry  | GitHub sign-in; callback `${APP_URL}/api/auth/callback/github`                                                                                                                                                                                                                                                                                                                          |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISPLAY_NAME` | registry  | Instance-wide OpenID Connect sign-in (workspaces can also configure their own in Settings → Single sign-on); callback `${APP_URL}/api/auth/callback/oidc`                                                                                                                                                                                                                               |
| `HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS`                                       | registry  | `1` to allow workspace OIDC issuers on private networks or plain HTTP in production                                                                                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                                                              | registry  | Peers allowed to set `X-Forwarded-For` (default `loopback,linklocal,uniquelocal`: the dashboard and load balancers on private networks). Per-IP rate limits and audit IPs use the client address. `false` to disable, or a list of IPs/CIDRs                                                                                                                                            |
| `HARMONIQ_VALIDATE_BUNDLES`                                                | registry  | `1` to fetch and verify every bundle on deploy                                                                                                                                                                                                                                                                                                                                          |
| `HARMONIQ_GC_KEEP_VERSIONS`                                                | registry  | Versions always kept per module and environment for rollback (default 10)                                                                                                                                                                                                                                                                                                               |
| `HARMONIQ_METRICS_TOKEN`                                                   | registry  | Bearer token `/metrics` requires (at least 16 characters); unset: public                                                                                                                                                                                                                                                                                                                |
| `HARMONIQ_METRICS_TENANT_LABELS`                                           | registry  | `1` labels metrics by workspace slug (off by default: labels name tenants)                                                                                                                                                                                                                                                                                                              |
| `HARMONIQ_METRICS_PORT`                                                    | registry  | Serve `/metrics` on this port only (not on the API port); `0` picks a free port                                                                                                                                                                                                                                                                                                         |
| `HARMONIQ_DOMAIN_GRACE_DAYS`                                               | registry  | Days unverified trusted SSO domains keep working after upgrading (default 30; `0` enforces at once)                                                                                                                                                                                                                                                                                     |
| `HARMONIQ_AUDIT_RETENTION_DAYS`                                            | registry  | Days a deleted workspace's audit events are kept, counted from each event (default 400)                                                                                                                                                                                                                                                                                                 |
| `HARMONIQ_TENANT_RESTORE_DAYS`                                             | registry  | Days a deleted workspace or organization can be restored before it is purged (default 30; `0` purges at once)                                                                                                                                                                                                                                                                           |
| `HARMONIQ_MANIFEST_RATE_LIMIT`, `_STARTUP`, `_ENTERPRISE`                  | registry  | Manifest requests per minute per workspace and client IP, by the workspace's plan (defaults 600, 3000, 10000)                                                                                                                                                                                                                                                                           |
| `HARMONIQ_WRITE_RATE_LIMIT`                                                | registry  | Writes (POST, PUT, PATCH, DELETE) per minute per credential, or per client IP without one (default 300), outside workspace and organization routes. Sign-in, setup, deploys and health ingest have their own limits                                                                                                                                                                     |
| `HARMONIQ_API_RATE_LIMIT`, `_STARTUP`, `_ENTERPRISE`                       | registry  | MT-12: writes per minute shared by everyone working in one workspace or organization, by plan (defaults 1200, 6000, 30000)                                                                                                                                                                                                                                                              |
| `HARMONIQ_DEPLOY_RATE_LIMIT`, `_STARTUP`, `_ENTERPRISE`                    | registry  | MT-12: deploys per minute per workspace, by plan (defaults 30, 120, 600)                                                                                                                                                                                                                                                                                                                |
| `HARMONIQ_HEALTH_RATE_LIMIT`, `_STARTUP`, `_ENTERPRISE`                    | registry  | MT-12: health reports per minute per workspace, by plan (defaults 6000, 30000, 120000)                                                                                                                                                                                                                                                                                                  |
| `HARMONIQ_MANIFEST_MISS_LIMIT`                                             | registry  | Not-found manifest answers per minute per client IP, across all workspaces (default 120). Stops requests that invent workspace names from reaching the database                                                                                                                                                                                                                         |
| `TLS_CERT_FILE`, `TLS_KEY_FILE`                                            | registry  | PEM files; serves HTTPS with HTTP/2 (HTTP/1.1 still accepted). Without them the registry speaks plain HTTP/1.1, for a TLS-terminating proxy or load balancer, which can offer HTTP/2 to clients                                                                                                                                                                                         |
| `HARMONIQ_PLAN_ENFORCEMENT`                                                | registry  | `1` to gate features by plan (hosted offerings). Off by default: every workspace has every feature, whatever its plan                                                                                                                                                                                                                                                                   |
| `HARMONIQ_PLAN_FEATURES`                                                   | registry  | JSON replacing the features of plans, e.g. `{"hobby":["approvals"]}`. Defaults: startup has `byob` and `approvals`; enterprise also `saml` and `scim`                                                                                                                                                                                                                                   |
| `HARMONIQ_PLAN_LIMITS`                                                     | registry  | PLN-04: JSON of quotas by plan, merged over the defaults, e.g. `{"hobby":{"members":10,"storageGb":5}}`; `null` is unlimited. Quotas: `workspaces` (per organization), `members`, `modules`, `environmentsPerHostApp`, `storageGb`, `deploysPerMonth`, `webhooks`. Defaults: hobby 3/5/20/5/1/500/5, startup 20/50/200/20/50/10000/25, enterprise unlimited. Only with plan enforcement |

Never set `HARMONIQ_DEV_LOGIN` in production; the registry refuses to start with it.

### 3. First boot

1. Start the registry; it logs a hint while no instance admin exists.
2. Open `${APP_URL}/admin/setup`. The wizard asks for `HARMONIQ_SETUP_TOKEN` and the admin's email, checks the database and cache, writes and deletes a test object in the default storage, and lists the sign-in methods you configured. Finishing creates the admin; the token then stops working.
3. Sign in with that email (email link or GitHub with the same verified address).
4. Create a workspace from the dashboard and an API key for CI under **Settings → API keys**.
5. The admin panel (`/admin`) shows system health and lets you manage workspaces (suspend, delete), users (end sessions, erase accounts), other instance admins and the instance audit log.
6. Storage, email (SMTP), sign-in methods and branding can also be set in the admin panel. Those settings are stored encrypted in the database, take precedence over the environment variables above (which remain the defaults) and reach every registry replica within a minute, without a restart. The panel refuses sign-in settings that would leave no instance admin able to sign in, or that would lock you out (INST-23).
7. Organizations and workspaces that use single sign-on verify their email domains (**Single sign-on → Verified domains**, a DNS TXT record). For `HARMONIQ_DOMAIN_GRACE_DAYS` (default 30) after the first start of a version with domain verification, unverified trusted domains keep working for sign-in; after that, only verified ones do.

### Recovery

When nobody can use the admin panel (every sign-in method off, the last admin gone, a broken IdP), the registry image has a recovery CLI that works directly on the database (INST-24). It needs only `SYSTEM_DATABASE_URL`, and every command is recorded in the instance audit log:

```bash
docker run --rm -e SYSTEM_DATABASE_URL=… harmoniq/registry npx tsx scripts/harmoniq-admin.ts <command>
#   grant-admin <email>       make an account an instance admin (created if needed)
#   reset-setting <key>       drop a setting saved in the admin panel (storage, email, auth, branding, …)
#   encryption-status         sealed values per encryption key
#   reseal-secrets            re-seal stored secrets with the active key
#   revoke-sessions <email>   end every session of an account
#   list-admins               instance admins and the sign-in methods they have used
```

Running registries pick up a reset setting within a minute.

### Rotating the encryption key

Stored secrets (SSO and SMTP credentials, webhook secrets, storage keys, MFA secrets) are sealed with the active key. Each sealed value records the id of its key (INST-26).

1. Generate a key: `openssl rand -base64 32`.
2. Set `HARMONIQ_ENCRYPTION_KEYS=2026b:<new>,2026a:<old>`, with the new key first. A `HARMONIQ_ENCRYPTION_KEY` set alongside counts as one more old key. Restart every replica; new values are sealed with the new key, and old values still open.
3. Re-seal: **Admin → Encryption → Re-seal now**, or `harmoniq-admin reseal-secrets`. It is idempotent and safe while the registry runs.
4. When **Admin → Encryption** (or `harmoniq-admin encryption-status`) shows no values on the old key, remove it and restart.

A value sealed with a key that is no longer configured can't be opened: the registry fails closed and the health report counts it under `unknownKeys`.

### Instance admin roles and automation

The first admin is an instance owner. Owners can add admins with narrower roles (operator, support, billing) under **Admin → Instance admins**, inviting people who haven't signed in yet. Destructive actions ask for a fresh code from the authenticator app. Admins without MFA sign in again instead. For automation (the Terraform provider's `harmoniq_instance_setting` and plan resources, scripts), create an instance API key under **Admin → API keys**. Every setting saved in the panel is versioned. **Admin → All settings** exports them as YAML and imports them (dry run first) into another instance.

### Operating the instance

- **Admin → Overview** lists what needs attention: failed manifest publishes, undelivered webhooks and audit streams, failed jobs, tenant buckets that fail the daily check, SAML certificates expiring within 30 days, alert rules in error, quota breaches and domains failing re-verification.
- **Admin → Health** shows each replica's version, uptime and settings age, and migrations the database hasn't applied yet. Run `prisma migrate deploy` (the `migrate` service) after upgrading.
- **Admin → Jobs** shows each background job's schedule and last runs. Failed jobs can be retried there, and maintenance jobs (GC, health rollup, purge, domain re-check, storage check) can be run on demand.
- **Maintenance mode** (**Admin → Announcements**) makes the instance read-only for a window: writes answer `503` with `Retry-After`, while manifests, health reports, sign-in and the admin panel keep working. Plan the window there, and every dashboard page announces it beforehand.
- **Support access**: an instance admin opens read-only access to a workspace or organization for up to 4 hours, with a reason. The tenant's admins see a banner, and both audit logs record it.
- Sign-in attempts are kept 90 days and the email delivery log 30 days (**Admin → Security**, **Admin → Email**).

### 4. Images

```bash
docker build -f apps/registry/Dockerfile -t harmoniq/registry .
docker build -f apps/web/Dockerfile -t harmoniq/web .
```

Both expose `/health`-style checks used by the Docker `HEALTHCHECK`. The registry also serves `GET /ready` (database and cache) for orchestrators.

## Security

- **Headers**: the dashboard sends a per-request Content-Security-Policy (scripts only with that request's nonce, `frame-ancestors 'none'`, `object-src 'none'`, `connect-src 'self'`; images from any HTTPS origin for branding logos), plus `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and `Permissions-Policy`. `upgrade-insecure-requests` is added only over HTTPS (it reads `X-Forwarded-Proto` from your proxy). The registry sends Helmet's headers with its own CSP.
- **CSRF**: session cookies are `HttpOnly` and `SameSite=Lax`. Dashboard mutations are Next.js server actions, which reject requests whose `Origin` doesn't match the host; the dashboard's own POST routes (sign-in, sign-out) check `Origin` too. The registry takes credentials only from the `Authorization` header, never cookies, so cross-site requests can't carry them. Behind a proxy, forward `Host` (or `X-Forwarded-Host`) unchanged.
- **Rate limits**: manifests (per workspace and IP, by plan), sign-in and setup (per IP), health ingest, and every other write (per credential); `429` responses carry `Retry-After`. With several registry replicas, `CACHE_ADAPTER=redis` shares the counters.
- **Dependencies**: CI runs `pnpm audit --audit-level high --prod` for the packages that ship.

## Observability

- **Metrics**: `GET /metrics` on the registry (Prometheus). Keep it private: serve it on a separate port with `HARMONIQ_METRICS_PORT` (the API port then has no `/metrics`), and/or set `HARMONIQ_METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`. The registry warns in production when neither is set: `harmoniq_http_request_duration_ms` (histogram by method, route, status), `harmoniq_manifest_cache_hits_total` / `_misses_total`, `harmoniq_deploy_count_total`, `harmoniq_manifest_rate_limited_total` (by `workspace` only with `HARMONIQ_METRICS_TENANT_LABELS=1`, since labels name your tenants). [`docker/grafana`](../docker/grafana) has a dashboard (request rate, p95 by route, manifest p99 against the 50 ms target, cache hit ratio, 5xx, deploys, rate limiting): `docker compose -f docker/docker-compose.yml --profile observability up -d`, then http://localhost:3001.
- **Traces**: set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. `http://otel-collector:4318`) and the registry exports OpenTelemetry traces over OTLP/HTTP: HTTP, Fastify, Postgres and Redis automatically, plus spans for manifest resolution (`harmoniq.manifest.resolve`), every change to a manifest (`harmoniq.mutation`, with workspace and environment) and every background job (`harmoniq.job <name>`). The other standard `OTEL_*` variables (service name, sampler, headers) apply.
- **Logs**: JSON in production. Every line of a request carries `requestId` (a caller's `X-Request-Id` is kept and returned on every response), the workspace once resolved (`workspace`, `workspaceId`), and "request completed" its `responseTime` in milliseconds.

## Kubernetes (Helm)

[`charts/harmoniq`](../charts/harmoniq) deploys the registry and the dashboard, each with a Service, health probes and an optional Ingress (one host each, from `urls.web` and `urls.registry`). A pre-install / pre-upgrade hook Job runs `prisma migrate deploy`. Postgres and Redis are yours: create the two roles from [`docker/init.sql`](../docker/init.sql) and pass both connection strings.

```bash
helm install harmoniq charts/harmoniq \
  --set urls.web=https://harmoniq.example.com \
  --set urls.registry=https://registry.harmoniq.example.com \
  --set env.REDIS_URL=redis://redis:6379 \
  --set secrets.databaseUrl=postgresql://harmoniq_app:…@postgres:5432/harmoniq \
  --set secrets.systemDatabaseUrl=postgresql://harmoniq:…@postgres:5432/harmoniq \
  --set secrets.jwtSecret="$(openssl rand -base64 48)" \
  --set secrets.encryptionKey="$(openssl rand -base64 32)" \
  --set secrets.setupToken="$(openssl rand -hex 16)" \
  --set ingress.enabled=true
```

Or keep the secrets in your own Secret (`secrets.existingSecret`, keys `DATABASE_URL`, `SYSTEM_DATABASE_URL`, `JWT_SECRET`, `HARMONIQ_ENCRYPTION_KEY`, optionally `HARMONIQ_SETUP_TOKEN`). The registry runs two replicas by default, which needs Redis (`env.CACHE_ADAPTER=redis`, the default). Further registry settings go in `registry.extraEnv` / `registry.extraEnvFrom` (e.g. `SMTP_URL`), or in the admin panel once running. `registry.metricsPort` (e.g. `9464`) serves `/metrics` on its own container and Service port instead of the API port, so the ingress never exposes it; put `HARMONIQ_METRICS_TOKEN` in a Secret (`registry.extraEnvFrom`) to require a scrape token as well.

## AWS with Terraform

[`deploy/terraform/aws`](../deploy/terraform/aws) deploys the registry and dashboard on ECS Fargate behind one ALB, with RDS Postgres, ElastiCache Redis, S3 + CloudFront for published manifests and generated secrets in Secrets Manager. See its README.

## Upgrading a development database

Databases created before the owner/app role split need a one-time, non-destructive ownership change before `pnpm run db:deploy`:

```bash
docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql
```
