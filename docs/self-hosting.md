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

Create them once as a superuser (see `docker/init.sql`, with your own passwords):

```sql
CREATE USER harmoniq WITH PASSWORD '…' CREATEDB;
CREATE USER harmoniq_app WITH PASSWORD '…';
CREATE DATABASE harmoniq OWNER harmoniq;
```

Then run migrations as the owner (the registry image includes the Prisma CLI):

```bash
docker run --rm -e DATABASE_URL=… -e SYSTEM_DATABASE_URL=… \
  -w /repo/packages/db harmoniq/registry npx prisma migrate deploy
```

### 2. Configuration

Put these in `docker/.env` for Compose, or in your orchestrator's secret store:

| Variable                                   | Service   | Description                                                                                                                                            |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                 | both      | `production` (the registry refuses default secrets in production)                                                                                      |
| `DATABASE_URL`                             | registry  | `postgresql://harmoniq_app:…@host:5432/harmoniq`                                                                                                       |
| `SYSTEM_DATABASE_URL`                      | registry  | `postgresql://harmoniq:…@host:5432/harmoniq`                                                                                                           |
| `JWT_SECRET`                               | both      | Same value on registry and dashboard; ≥ 32 random chars (`openssl rand -base64 48`)                                                                    |
| `HARMONIQ_ENCRYPTION_KEY`                  | registry  | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts stored credentials and webhook secrets. Keep a backup — losing it makes them unreadable. |
| `APP_URL`                                  | dashboard | Public dashboard URL; also set the registry's `WEB_ORIGIN` to it                                                                                       |
| `WEB_ORIGIN`                               | registry  | Dashboard origin (CORS, allowed sign-in redirects)                                                                                                     |
| `REGISTRY_URL`                             | dashboard | URL the dashboard uses to reach the registry (can be internal)                                                                                         |
| `CACHE_ADAPTER`, `REDIS_URL`               | registry  | `redis` + URL for multiple replicas                                                                                                                    |
| `HARMONIQ_SETUP_TOKEN`                     | registry  | One-time token for the first-boot wizard at `/admin/setup`                                                                                             |
| `SMTP_URL`, `MAIL_FROM`                    | registry  | Email sign-in (magic link + code)                                                                                                                      |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | registry  | GitHub sign-in; callback `${APP_URL}/api/auth/callback/github`                                                                                         |
| `HARMONIQ_VALIDATE_BUNDLES`                | registry  | `1` to fetch and verify every bundle on deploy                                                                                                         |
| `HARMONIQ_GC_KEEP_VERSIONS`                | registry  | Versions always kept per module and environment for rollback (default 10)                                                                              |

Never set `HARMONIQ_DEV_LOGIN` in production; the registry refuses to start with it.

### 3. First boot

1. Start the registry; it logs a hint while no instance admin exists.
2. Open `${APP_URL}/admin/setup`, enter `HARMONIQ_SETUP_TOKEN` and the admin's email. The token works once.
3. Sign in with that email (email link or GitHub with the same verified address).
4. Create a workspace from the dashboard and an API key for CI under **Settings → API keys**.

### 4. Images

```bash
docker build -f apps/registry/Dockerfile -t harmoniq/registry .
docker build -f apps/web/Dockerfile -t harmoniq/web .
```

Both expose `/health`-style checks used by the Docker `HEALTHCHECK`. The registry also serves `GET /ready` (database and cache) for orchestrators.

## Upgrading a development database

Databases created before the owner/app role split need a one-time, non-destructive ownership change before `pnpm run db:deploy`:

```bash
docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql
```
