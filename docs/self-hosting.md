# Self-Hosting Harmoniq

Harmoniq runs as two services — the **registry** (API, port 4000) and the **dashboard** (Next.js, port 3000) — backed by **PostgreSQL 15+** (data and background jobs) and optionally **Redis** (shared manifest cache; required with more than one registry replica).

## Try it locally

```bash
pnpm run docker:demo
```

This builds both images, starts Postgres and Redis, applies migrations, seeds a demo workspace and starts the registry and dashboard. Open http://localhost:3000 and use **Development sign-in** with `demo@harmoniq.dev` (owner of the `acme-corp` demo workspace). Stop with `pnpm run docker:demo:down`.

The demo runs in development mode (development secrets, "sign in as any email"). Do not expose it to the internet.

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

It is idempotent and re-applies the password, so it also rotates it. Then run migrations as the owner (the registry image includes the Prisma CLI):

```bash
docker run --rm -e DATABASE_URL=… -e SYSTEM_DATABASE_URL=… \
  -w /repo/packages/db harmoniq/registry npx prisma migrate deploy
```

### 2. Configuration

Put these in `docker/.env` for Compose, or in your orchestrator's secret store:

| Variable                                                                   | Service   | Description                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                 | both      | `production` (the registry refuses default secrets in production)                                                                                                                                                                            |
| `DATABASE_URL`                                                             | registry  | `postgresql://harmoniq_app:…@host:5432/harmoniq`                                                                                                                                                                                             |
| `SYSTEM_DATABASE_URL`                                                      | registry  | `postgresql://harmoniq:…@host:5432/harmoniq`                                                                                                                                                                                                 |
| `JWT_SECRET`                                                               | both      | Same value on registry and dashboard; ≥ 32 random chars (`openssl rand -base64 48`)                                                                                                                                                          |
| `HARMONIQ_ENCRYPTION_KEY`                                                  | registry  | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts stored credentials and webhook secrets. Keep a backup — losing it makes them unreadable.                                                                                       |
| `APP_URL`                                                                  | dashboard | Public dashboard URL; also set the registry's `WEB_ORIGIN` to it                                                                                                                                                                             |
| `WEB_ORIGIN`                                                               | registry  | Dashboard origin (CORS, allowed sign-in redirects)                                                                                                                                                                                           |
| `REGISTRY_URL`                                                             | dashboard | URL the dashboard uses to reach the registry (can be internal)                                                                                                                                                                               |
| `CACHE_ADAPTER`, `REDIS_URL`                                               | registry  | `redis` + URL; **required with more than one replica** (the in-memory cache isn't shared, and the registry warns at startup)                                                                                                                 |
| `STORAGE_ADAPTER`                                                          | registry  | Where published manifests go: `s3`, `local` (dev default) or `none` (production default)                                                                                                                                                     |
| `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_URL`                                  | registry  | Bucket for published manifests and its public (CDN) base URL; `S3_ENDPOINT` for S3-compatible stores                                                                                                                                         |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                 | registry  | Optional; omit both to use the AWS default credential chain (ECS task role, instance profile)                                                                                                                                                |
| `PUBLIC_URL`                                                               | registry  | Public registry URL (links in emails, `/static` URLs, SAML endpoints: browsers post to its ACS)                                                                                                                                              |
| `HARMONIQ_SETUP_TOKEN`                                                     | registry  | One-time token for the first-boot wizard at `/admin/setup`                                                                                                                                                                                   |
| `SMTP_URL`, `MAIL_FROM`                                                    | registry  | Email sign-in (magic link + code)                                                                                                                                                                                                            |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                 | registry  | GitHub sign-in; callback `${APP_URL}/api/auth/callback/github`                                                                                                                                                                               |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISPLAY_NAME` | registry  | Instance-wide OpenID Connect sign-in (workspaces can also configure their own in Settings → Single sign-on); callback `${APP_URL}/api/auth/callback/oidc`                                                                                    |
| `HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS`                                       | registry  | `1` to allow workspace OIDC issuers on private networks or plain HTTP in production                                                                                                                                                          |
| `TRUST_PROXY`                                                              | registry  | Peers allowed to set `X-Forwarded-For` (default `loopback,linklocal,uniquelocal`: the dashboard and load balancers on private networks). Per-IP rate limits and audit IPs use the client address. `false` to disable, or a list of IPs/CIDRs |
| `HARMONIQ_VALIDATE_BUNDLES`                                                | registry  | `1` to fetch and verify every bundle on deploy                                                                                                                                                                                               |
| `HARMONIQ_GC_KEEP_VERSIONS`                                                | registry  | Versions always kept per module and environment for rollback (default 10)                                                                                                                                                                    |
| `HARMONIQ_MANIFEST_RATE_LIMIT`, `_STARTUP`, `_ENTERPRISE`                  | registry  | Manifest requests per minute per workspace and client IP, by the workspace's plan (defaults 600, 3000, 10000)                                                                                                                                |
| `HARMONIQ_PLAN_ENFORCEMENT`                                                | registry  | `1` to gate features by plan (hosted offerings). Off by default: every workspace has every feature, whatever its plan                                                                                                                        |
| `HARMONIQ_PLAN_FEATURES`                                                   | registry  | JSON replacing the features of plans, e.g. `{"hobby":["approvals"]}`. Defaults: startup has `byob` and `approvals`; enterprise also `saml` and `scim`                                                                                        |

Never set `HARMONIQ_DEV_LOGIN` in production; the registry refuses to start with it.

### 3. First boot

1. Start the registry; it logs a hint while no instance admin exists.
2. Open `${APP_URL}/admin/setup`. The wizard asks for `HARMONIQ_SETUP_TOKEN` and the admin's email, checks the database and cache, writes and deletes a test object in the default storage, and lists the sign-in methods you configured. Finishing creates the admin; the token then stops working.
3. Sign in with that email (email link or GitHub with the same verified address).
4. Create a workspace from the dashboard and an API key for CI under **Settings → API keys**.
5. The admin panel (`/admin`) shows system health and lets you manage workspaces (suspend, delete), users (end sessions, erase accounts), other instance admins and the instance audit log.
6. Storage, email (SMTP), sign-in methods and branding can also be set in the admin panel. Those settings are stored encrypted in the database, take precedence over the environment variables above (which remain the defaults) and reach every registry replica within a minute, without a restart.

### 4. Images

```bash
docker build -f apps/registry/Dockerfile -t harmoniq/registry .
docker build -f apps/web/Dockerfile -t harmoniq/web .
```

Both expose `/health`-style checks used by the Docker `HEALTHCHECK`. The registry also serves `GET /ready` (database and cache) for orchestrators.

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

Or keep the secrets in your own Secret (`secrets.existingSecret`, keys `DATABASE_URL`, `SYSTEM_DATABASE_URL`, `JWT_SECRET`, `HARMONIQ_ENCRYPTION_KEY`, optionally `HARMONIQ_SETUP_TOKEN`). The registry runs two replicas by default, which needs Redis (`env.CACHE_ADAPTER=redis`, the default). Further registry settings go in `registry.extraEnv` / `registry.extraEnvFrom` (e.g. `SMTP_URL`), or in the admin panel once running.

## AWS with Terraform

[`deploy/terraform/aws`](../deploy/terraform/aws) deploys the registry and dashboard on ECS Fargate behind one ALB, with RDS Postgres, ElastiCache Redis, S3 + CloudFront for published manifests and generated secrets in Secrets Manager. See its README.

## Upgrading a development database

Databases created before the owner/app role split need a one-time, non-destructive ownership change before `pnpm run db:deploy`:

```bash
docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql
```
