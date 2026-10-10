# Harmoniq

> Open-source Micro Frontend Control Plane — Apache 2.0

Harmoniq is an open-source, self-hostable **Micro Frontend Control Plane**. It removes the build-time coupling between a host application and its micro frontends: a central registry delivers runtime JSON manifests to host shells, so each team can deploy, roll back, canary-test and switch off its own federated modules without rebuilding or redeploying the parent container.

---

## Table of contents

- [The problem](#the-problem)
- [Pain points](#pain-points)
- [How Harmoniq solves it](#how-harmoniq-solves-it)
- [What Harmoniq provides](#what-harmoniq-provides)
- [Architecture](#architecture)
- [Core concepts](#core-concepts)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Option 1 — Docker demo](#option-1--docker-demo-fastest-way-to-look-around)
  - [Option 2 — Local development without Docker](#option-2--local-development-without-docker)
  - [Quick start (development)](#quick-start-development)
  - [Verify the installation](#verify-the-installation)
  - [Troubleshooting](#troubleshooting)
- [Tutorial: your first release, canary and rollback](#tutorial-your-first-release-canary-and-rollback)
- [Integrating a host application](#integrating-a-host-application)
- [CI/CD and infrastructure as code](#cicd-and-infrastructure-as-code)
- [Running in production](#running-in-production)
- [Configuration reference](#configuration-reference)
- [Repository layout](#repository-layout)
- [Useful scripts](#useful-scripts)
- [Documentation](#documentation)
- [License](#license)

---

## The problem

Micro frontend architectures (Webpack Module Federation, Module Federation 2.0, Native Federation, import maps, SystemJS) let many teams build separate parts of one web application. In most setups, though, the host shell learns the **URL of every remote module at build time**:

```js
// webpack.config.js of the host — the remote's location is baked into the build
remotes: {
  checkout: 'checkout@https://cdn.acme.com/checkout/1.2.3/remoteEntry.js',
}
```

That one line ties every remote team's release cycle to the host's. The architecture is meant to let teams ship independently, but the deployment pipeline still runs through a single bottleneck.

## Pain points

| Pain point                          | What happens today                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every release rebuilds the host** | Shipping `checkout 1.2.4` means changing, rebuilding, testing and redeploying the host shell, which is often owned by a different team.     |
| **Slow, risky rollbacks**           | Reverting a bad remote takes another full host build and deploy, usually during an incident, while users keep hitting the broken version.   |
| **No progressive delivery**         | There is no built-in way to give 5% of users a new version, target beta customers, or roll out in stages based on error rates.              |
| **No emergency off switch**         | When a module breaks production, the only fix is a rollback deploy. Nothing can simply stop loading it.                                     |
| **No single view of what runs**     | Nobody can easily say which version of which module runs in which environment, who deployed it, or what changed between two points in time. |
| **Shared-dependency drift**         | One remote moves to `react@19` while another stays on `^18`; the conflict surfaces in production, not at deploy time.                       |
| **Fragile delivery**                | If the server that hands out remote URLs goes down, the whole application fails to boot.                                                    |
| **Governance gaps**                 | No approvals, freezes, audit trail, SSO or per-module ownership around who may ship what to production.                                     |
| **Vendor lock-in**                  | Hosted solutions tie you to one CDN, storage provider or identity provider, and to their pricing.                                           |

## How Harmoniq solves it

Harmoniq moves the "which URL does each module load from" decision from **build time** to **runtime**.

```
            BEFORE                                         WITH HARMONIQ
 ┌──────────────────────────┐                ┌──────────────────────────┐
 │ Host build               │                │ Host build (once)        │
 │  checkout → …/1.2.3/…     │                │  checkout → ?            │
 │  cart     → …/4.0.1/…     │                │  cart     → ?            │
 └────────────┬─────────────┘                └────────────┬─────────────┘
              │ new remote version?                       │ at page load
              ▼                                           ▼
   rebuild + redeploy the host               GET /api/manifest/acme/shop/production
                                                         │
                                             { checkout: …/1.2.4/…, cart: …/4.0.1/… }
```

1. **Remote teams deploy to the registry, not to the host.** CI uploads the bundle to your own CDN or bucket, then registers the new version with Harmoniq (CLI, build plugin, GitHub Action or REST API). Harmoniq records the URL, the SRI integrity hash, the commit and any metadata.
2. **The host is built once.** It ships with the small `@harmoniq/client` SDK (or the Module Federation plugin, or a plain import map). At runtime it fetches a manifest listing each module's current URL and hash.
3. **Changes take effect immediately.** Deploying, rolling back, starting a canary or flipping the kill switch is a single atomic database change. The registry invalidates its cache and publishes a fresh manifest, and hosts pick it up on their next fetch, or while the page is open when polling is on.
4. **Delivery stays up when Harmoniq is down.** Manifests are also published to your CDN, persisted in the browser, and can be bundled into the host as a fallback. A registry outage never stops your application from booting.

## What Harmoniq provides

### Runtime delivery

- **Runtime manifests:** `GET /api/manifest/:workspace/:hostApp/:env`, with ETag / `304` support, a 50 ms p99 cache-hit target, and last-known-good fallback when the database is unavailable.
- **Several delivery formats:** the Harmoniq manifest (schema v2), standard **import maps** (including SystemJS), and **Native Federation** manifests.
- **Published copies:** after every change the manifest and import map are written to storage (local, S3 or S3-compatible, or a workspace's own bucket) so they can be served from a CDN.
- **Subresource Integrity:** every version carries an SRI hash, which the SDK and plugins pass to the browser.

### Release management

- **Append-only version history** for every module in every environment.
- **Instant rollback** to the previous version, a named version, or any version id.
- **Promotion** of the exact artifact (URL and hash) from staging to production.
- **Canary releases** with sticky, server-side user assignment, adjustable traffic, **targeting rules** (e.g. `plan = beta`) and **staged rollouts** that advance or abort automatically from real load health.
- **Kill switch** that turns a module off for every host in seconds, even in a frozen environment.
- **Dependency and contract gate** that blocks deploys whose shared-dependency ranges conflict, or that drop exposed modules hosts rely on.
- **Preview environments** per pull request, with expiry and generated preview links.
- **Scheduled operations:** deploy, promote, roll back or disable at a given time.
- **Local overrides:** point a deployed staging host at a module running on your laptop.

### Observability

- **Module health:** load success rate and timings per module, split by stable and canary.
- **Alerts and auto-rollback** rules on module health.
- **Manifest snapshots and diffs:** what ran at any point in time, and what changed.
- **Prometheus metrics, OpenTelemetry traces and structured JSON logs**, plus a ready-made Grafana dashboard.
- **Sentry, Datadog and OpenTelemetry** tagging helpers in the SDK, so errors can be filtered by variant and module version.
- **Webhooks** for deploys, rollbacks, canary events and manifest updates.

### Governance and security

- **Multi-tenant workspaces** isolated in the application layer and by PostgreSQL **Row-Level Security**.
- **Roles** (`owner`, `admin`, `developer`, `viewer`), **module ownership** and scoped, rotatable **API keys**.
- **Approval policies, change tickets and environment freezes.**
- **Sign-in** with GitHub, email magic link, OIDC, and workspace or organization **SSO (OIDC and SAML 2.0)** with **SCIM** provisioning.
- **Organizations** that share modules across workspaces.
- **Audit log** for every change, at workspace and instance level.
- **Instance admin panel** with a first-boot setup wizard, system health, and storage, SMTP, sign-in and branding settings.

### Tooling

| Tool                      | Purpose                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@harmoniq/client`        | Zero-dependency browser SDK with React, Vue and Angular bindings, polling, fallbacks, canary and health reporting |
| `@harmoniq/mf-plugin`     | Module Federation 2.0 runtime plugin: `loadRemote()` resolves remotes from the manifest and hot-swaps on deploy   |
| `@harmoniq/cli`           | `deploy`, `promote`, `rollback`, `canary`, `disable`, `doctor`, `validate`, `manifest pull`, `plan`/`apply`       |
| `@harmoniq/build-plugin`  | Vite, Rollup, webpack, Rspack and esbuild plugin that hashes and registers each build from CI                     |
| GitHub Action             | [`actions/deploy`](./actions/deploy/README.md): deploy or promote, with a deployment summary card                 |
| GitLab CI                 | [`integrations/gitlab`](./integrations/gitlab/README.md)                                                          |
| Terraform provider        | [`integrations/terraform-provider-harmoniq`](./integrations/terraform-provider-harmoniq/README.md)                |
| `harmoniq.yaml`           | Workspace as code with `harmoniq plan` / `apply` / `import`; JSON Schema on SchemaStore                           |
| Go and Python clients     | Generated from the OpenAPI document: [`integrations/clients`](./integrations/clients/README.md)                   |
| Helm chart, AWS Terraform | [`charts/harmoniq`](./charts/harmoniq), [`deploy/terraform/aws`](./deploy/terraform/aws)                          |

### What Harmoniq is not

- It does **not build or bundle** your micro frontends. Keep your bundler.
- It does **not host your bundles or act as a CDN.** Bundles live in your storage; Harmoniq tells hosts where they are.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Host Application Shell                    │
│   @harmoniq/client SDK ──► manifest fetch ──► module load    │
└───────────────┬──────────────────────────────┬───────────────┘
                │ GET /api/manifest/…          │ (fallback) published copy
                ▼                              ▼
┌───────────────────────────────────┐   ┌───────────────────────┐
│   Registry  (Fastify, :4000)      │──►│ Storage / CDN          │
│   ICache   IStorage  ILogger  Auth│   │ local · S3 · BYO bucket│
└───────────────┬───────────────────┘   └───────────────────────┘
                │
      ┌─────────┴─────────┐
      ▼                   ▼
┌──────────────┐   ┌──────────────┐        ┌────────────────────────┐
│ PostgreSQL   │   │ Redis        │        │ Dashboard (Next.js,    │
│ + RLS        │   │ (or memory)  │◄───────│ :3000) — calls the     │
│ + pg-boss    │   │ cache        │        │ registry API           │
└──────────────┘   └──────────────┘        └────────────────────────┘
```

| Component     | Technology                      | Role                                                                                      |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| **Registry**  | Node.js, Fastify, Prisma        | REST API, manifest resolution, canary assignment, background jobs (GC, schedules, alerts) |
| **Dashboard** | Next.js, Tailwind, shadcn/ui    | Control-plane UI for workspaces, modules, environments, releases and settings             |
| **Database**  | PostgreSQL 15+ with RLS         | System of record; `pg-boss` job queue                                                     |
| **Cache**     | Redis, or in-memory LRU         | Manifest cache and rate-limit counters (Redis required with more than one replica)        |
| **Storage**   | Local disk, S3-compatible, BYOB | Published manifests and import maps, optional pre-signed bundle uploads                   |

Harmoniq uses a **ports-and-adapters (hexagonal)** design: cache, storage, logger and identity providers are interfaces in `@harmoniq/core`, so you can swap vendors without changing business logic. The reasoning behind each choice is in the [Architecture Decision Records](./docs/architecture.md).

---

## Core concepts

| Concept         | Description                                                                                                                | Demo data                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Workspace**   | A tenant: a team or company. All data is isolated per workspace.                                                           | `acme-corp`                    |
| **Host app**    | A shell application that loads remote modules. A workspace can have several.                                               | `consumer-portal`              |
| **Environment** | A deployment target of a host app (`staging`, `production`, `pr-123`…). Each has its own manifest.                         | `production`, `staging`        |
| **Module**      | A remote micro frontend the host loads.                                                                                    | `checkout`                     |
| **Version**     | An immutable record: URL, integrity hash, version string, commit and metadata. Status is `active`, `canary` or `inactive`. | `checkout 1.2.3` in production |
| **Manifest**    | The JSON a host fetches: the modules active in one environment, for this user's variant (`stable` or `canary`).            | —                              |
| **API key**     | A credential for CI and the CLI (`hq_<id>_<secret>`) with a scope: `manifest:read`, `deploy:write` or `admin`.             | —                              |

A manifest looks like this:

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
      "metadata": { "deployedAt": "…", "commitSha": "a1b2c3d" }
    }
  ]
}
```

---

## Getting started

### Prerequisites

| Tool                              | Version | Needed for                                                    |
| --------------------------------- | ------- | ------------------------------------------------------------- |
| [Node.js](https://nodejs.org/)    | ≥ 20    | Everything                                                    |
| [pnpm](https://pnpm.io/)          | ≥ 9     | Everything. The repository refuses `npm` and `yarn` installs. |
| [Docker](https://www.docker.com/) | recent  | Options 1 and 3 only                                          |
| Git                               | any     | Cloning                                                       |

Install pnpm if you don't have it:

```bash
corepack enable && corepack prepare pnpm@9 --activate
# or: npm install -g pnpm@9
```

Clone the repository and install dependencies (needed for every option):

```bash
git clone https://github.com/TrivioQ/Harmoniq.git
cd Harmoniq
pnpm install
```

Pick **one** of the three options below.

| Option                                                              | Needs Docker | Runs from source  | Best for                             |
| ------------------------------------------------------------------- | ------------ | ----------------- | ------------------------------------ |
| [1. Docker demo](#option-1--docker-demo-fastest-way-to-look-around) | yes          | no (built images) | Evaluating Harmoniq                  |
| [2. `dev:local`](#option-2--local-development-without-docker)       | no           | yes               | Quickest development setup           |
| [3. Docker infrastructure + `pnpm dev`](#quick-start-development)   | yes          | yes               | Development against Postgres + Redis |

### Option 1 — Docker demo (fastest way to look around)

```bash
pnpm run docker:demo
```

This builds the registry and dashboard images, starts PostgreSQL and Redis, applies migrations, seeds a demo workspace and starts:

| Service   | URL                        |
| --------- | -------------------------- |
| Dashboard | http://localhost:3000      |
| Registry  | http://localhost:4000      |
| API docs  | http://localhost:4000/docs |

Open http://localhost:3000, choose **Development sign-in**, and enter `demo@harmoniq.dev`. You are the owner of the **Acme Corporation** (`acme-corp`) workspace.

Stop it with:

```bash
pnpm run docker:demo:down
```

> The demo uses development secrets and "sign in as any email". Never expose it to the internet. See [Running in production](#running-in-production).

### Option 2 — Local development without Docker

```bash
pnpm run dev:local
```

This single command:

1. Starts an **embedded PostgreSQL** (downloaded as an npm package; data in `.harmoniq/dev-local`).
2. Applies all migrations and seeds the demo data.
3. Starts the **registry** on http://localhost:4000 and the **dashboard** on http://localhost:3000, with an in-memory cache and **Development sign-in** enabled.

Press `Ctrl+C` to stop everything. To start again from an empty database:

```bash
pnpm run dev:local -- --reset
```

### Quick start (development)

Option 3 runs the same stack from source against Docker's PostgreSQL and Redis, which is closer to production.

1. **Create the environment files.**

   ```bash
   cp .env.example .env
   cp .env.example packages/db/.env
   ```

   The defaults work as-is for local development: Postgres on `127.0.0.1:5433`, Redis on `localhost:6380`, local storage, and `HARMONIQ_DEV_LOGIN=1`.

2. **Start the infrastructure** (PostgreSQL and Redis):

   ```bash
   pnpm run docker:up
   ```

   > **Upgrading an existing dev database?** Volumes created before the owner/app role split need a one-time, non-destructive ownership change:
   > `docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql`

3. **Apply migrations and seed demo data:**

   ```bash
   pnpm run db:deploy
   pnpm run db:seed
   ```

4. **Start the development servers** (registry and dashboard, with hot reload):

   ```bash
   pnpm run dev
   ```

   Dashboard: http://localhost:3000 · Registry: http://localhost:4000

5. **When you are done:**

   ```bash
   pnpm run docker:down
   ```

Optional extras:

```bash
pnpm run db:studio   # browse the database in Prisma Studio
docker compose -f docker/docker-compose.yml --profile observability up -d   # Prometheus + Grafana on :3001
```

### Verify the installation

```bash
# Registry is up
curl http://localhost:4000/health
curl http://localhost:4000/ready          # database and cache

# The demo manifest resolves (public, no auth needed)
curl "http://localhost:4000/api/manifest/acme-corp/consumer-portal/production?pretty=true"
```

The last command should return a manifest containing `checkout` at version `1.2.3`. Then sign in to the dashboard at http://localhost:3000 with **Development sign-in** as `demo@harmoniq.dev`.

### Troubleshooting

| Symptom                                                 | Fix                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Use "pnpm install" for installation in this project`   | Install with pnpm, not npm or yarn.                                                                              |
| Port `3000`, `4000`, `5433` or `6380` already in use    | Stop the other process, or change `PORT` / `DATABASE_URL` / `REDIS_URL` in `.env`.                               |
| Migrations fail with permission errors on an old volume | Run `docker/upgrade-roles.sql` as shown in step 2, or `pnpm run docker:down` and remove the volume.              |
| No **Development sign-in** button                       | Set `HARMONIQ_DEV_LOGIN=1`; if `HARMONIQ_AUTH_METHODS` is set, it must include `dev`.                            |
| Email sign-in doesn't send mail locally                 | Without `SMTP_URL`, development prints the email (link and code) in the registry console.                        |
| Registry refuses to start in production                 | It rejects default secrets and `HARMONIQ_DEV_LOGIN`; set `JWT_SECRET` and `HARMONIQ_ENCRYPTION_KEY` (see below). |
| A module isn't loading in a host                        | Run `harmoniq doctor --module <name> --env <env>`. It checks the manifest, SRI hash, CORS and exposes.           |

---

## Tutorial: your first release, canary and rollback

This walkthrough uses the seeded `acme-corp` workspace and any of the setups above. It takes about ten minutes and shows the core loop: **deploy → canary → promote → rollback → kill switch**, with the host never rebuilt.

### Step 1 — Create an API key

1. Open http://localhost:3000 and sign in as `demo@harmoniq.dev`.
2. Open the **Acme Corporation** workspace → **Settings → API keys**.
3. Create a key named `local-cli` with the **`deploy:write`** scope.
4. Copy the key (`hq_…`). It is shown only once.

### Step 2 — Build and configure the CLI

Install the CLI from npm:

```bash
npm install -g @harmoniq/cli   # or run it without installing: npx @harmoniq/cli <command>

export HARMONIQ_REGISTRY_URL=http://localhost:4000
export HARMONIQ_WORKSPACE=acme-corp
export HARMONIQ_API_KEY=hq_…            # the key from step 1

harmoniq --version
harmoniq whoami
```

> `harmoniq login` can save these settings as a profile in `~/.harmoniq/config.json` instead of environment variables.
>
> Working on Harmoniq itself? Build the CLI from the repository instead: `pnpm --filter @harmoniq/cli build`, then run `node packages/cli/dist/index.mjs <command>`.

### Step 3 — Look at the current manifest

```bash
harmoniq manifest get --env production --host consumer-portal
```

`checkout` is active at `1.2.3`. This is exactly what a host application receives.

### Step 4 — Deploy a new version

In a real pipeline your CI uploads the bundle to a CDN first. Here a local file stands in for the build output, and `--file` lets the CLI compute its SRI hash:

```bash
mkdir -p /tmp/checkout-1.3.0
echo "export function mount(el) { el.textContent = 'checkout 1.3.0'; }" > /tmp/checkout-1.3.0/remoteEntry.js

harmoniq deploy \
  --module checkout \
  --env staging \
  --release 1.3.0 \
  --url https://cdn.example.com/checkout/1.3.0/remoteEntry.js \
  --file /tmp/checkout-1.3.0/remoteEntry.js \
  --meta pr=42
```

Check the staging manifest. It now lists `checkout 1.3.0`, and nothing was rebuilt:

```bash
curl "http://localhost:4000/api/manifest/acme-corp/consumer-portal/staging?pretty=true"
```

Add `--dry-run` to any deploy to see the projected manifest change without applying it.

### Step 5 — Release to 10% of production users (canary)

Promote the tested artifact as a canary, or deploy it with `--canary`:

```bash
harmoniq deploy \
  --module checkout --env production --release 1.3.0 \
  --url https://cdn.example.com/checkout/1.3.0/remoteEntry.js \
  --file /tmp/checkout-1.3.0/remoteEntry.js \
  --canary 10
```

Each user's assignment is sticky and decided on the server from an opaque user id. Ask for the manifest as different users and compare `variant` and the `checkout` version:

```bash
for u in user-1 user-2 user-3 user-4 user-5 user-6 user-7 user-8; do
  curl -s -H "X-Harmoniq-User-Id: $u" \
    http://localhost:4000/api/manifest/acme-corp/consumer-portal/production \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(process.argv[1],m.variant,m.modules.find(x=>x.name==="checkout").version)})' "$u"
done
```

Ramp up, then promote to everyone (or abort):

```bash
harmoniq canary set-traffic 50 --module checkout --env production
harmoniq canary promote        --module checkout --env production
# or: harmoniq canary abort --module checkout --env production --reason "error rate up"
```

> **Staged rollouts:** `--rollout 1,10,50,100 --hold 30m --max-error-rate 0.02 --min-samples 50` advances the canary through each band automatically while module health stays within limits, and aborts it when it doesn't.
>
> **Targeting:** `--canary 0 --target plan=beta` serves the canary only to users whose SDK context has `plan: 'beta'`.

### Step 6 — Roll back instantly

```bash
harmoniq rollback --module checkout --env production            # previous version (1.2.3)
# harmoniq rollback --module checkout --env production --to 1.2.3
```

The production manifest is back on `1.2.3`, again without touching the host.

### Step 7 — Use the kill switch

```bash
harmoniq disable --module checkout --env production --reason "payment errors since 14:02"
harmoniq enable  --module checkout --env production
```

While disabled, the module stays in the manifest with `"disabled": true`. SDKs report it as disabled, so your error boundary renders a fallback instead of loading broken code.

### Step 8 — Review the history

In the dashboard, open **consumer-portal → production** to see every change with who made it, when, and the manifest diff. The same data is available from the API:

```bash
curl -H "Authorization: Bearer $HARMONIQ_API_KEY" \
  "http://localhost:4000/api/manifest/acme-corp/consumer-portal/production/snapshots?limit=5"
```

### Other useful commands

```bash
harmoniq promote  --module checkout --from staging --to production   # ship exactly what was tested
harmoniq doctor   --module checkout --env production                 # why isn't it loading?
harmoniq validate --url https://cdn.acme.com/checkout/1.3.0/remoteEntry.js --file dist/remoteEntry.js
harmoniq manifest pull --env production --out src/harmoniq-fallback.json   # bundle a fallback
harmoniq promote  --module checkout --from staging --to production --at 2026-10-12T09:00:00Z   # schedule
```

The full command list, flags and exit codes are in the [CLI reference](./docs/cli.md).

---

## Integrating a host application

Install the SDK in the host shell:

```bash
pnpm add @harmoniq/client
```

### Plain TypeScript / JavaScript

```ts
import { HarmoniqClient, EVENTS } from '@harmoniq/client';

const client = new HarmoniqClient({
  registryUrl: 'https://registry.acme.dev',
  workspaceSlug: 'acme-corp',
  hostApp: 'consumer-portal',
  environment: 'production',
  pollIntervalMs: 30_000, // pick up deploys and rollbacks without a page reload
  userId: currentUser?.id, // opaque id, used for sticky canary assignment
  reportHealth: true, // feed module health, alerts and staged rollouts
});

await client.init();

// Load a module (ESM by default; 'systemjs', 'amd' or a custom loader also work)
const { mount } = await client.loadModule<{ mount: (el: Element) => void }>('checkout');
mount(document.getElementById('checkout')!);

client.on(EVENTS.manifestUpdate, () => console.log('a new version was deployed'));
client.on(EVENTS.variantAssigned, ({ variant, cohortId }) =>
  analytics.track('variant', { variant, cohortId })
);
```

### React

```tsx
import { HarmoniqProvider, useRemoteModule } from '@harmoniq/client/react';

<HarmoniqProvider options={options} fallback={<Spinner />}>
  <App />
</HarmoniqProvider>;

function CheckoutSlot() {
  const { url, integrity, loading, error, disabled } = useRemoteModule('checkout');
  // load `url` with your module loader; the component re-renders when a new version lands
}
```

Vue (`@harmoniq/client/vue`) and Angular (`@harmoniq/client/angular`) bindings work the same way. See the [SDK reference](./docs/sdk.md).

### Module Federation 2.0

Keep using `loadRemote()`. The plugin resolves each remote from the manifest and hot-swaps it on deploy or rollback:

```ts
import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { HarmoniqClient } from '@harmoniq/client';
import { harmoniqPlugin } from '@harmoniq/mf-plugin';

const client = new HarmoniqClient({ ...options, pollIntervalMs: 30_000 });
init({ name: 'host', remotes: [], plugins: [harmoniqPlugin(client)] });

const { CheckoutPage } = await loadRemote('checkout/CheckoutPage');
```

### Import maps (no bundler)

```html
<script type="module">
  const res = await fetch(
    'https://registry.acme.dev/api/importmap/acme-corp/consumer-portal/production'
  );
  const map = document.createElement('script');
  map.type = 'importmap';
  map.textContent = await res.text();
  document.head.append(map);
  await import('@acme/checkout');
</script>
```

### Making the host resilient

```ts
import fallbackManifest from './harmoniq-fallback.json'; // harmoniq manifest pull --env production --out …

new HarmoniqClient({
  ...options,
  cdnBaseUrl: 'https://cdn.acme.dev', // published copy first, registry second
  fallbackManifest, // used when nothing is reachable and nothing is persisted
});
```

Order of fallbacks: network (CDN copy, then registry) → copy persisted in `localStorage` → bundled `fallbackManifest`.

### Developing against a deployed host

Enable overrides on non-production builds, then point the staging host at a module running locally:

```ts
new HarmoniqClient({ ...options, allowOverrides: process.env.NODE_ENV !== 'production' });
```

```
https://staging.acme.com/?harmoniq-override=checkout@http://localhost:5001/remoteEntry.js
```

### Runnable examples

| Example                                        | Shows                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/vite-mf`](./examples/vite-mf)       | Vite + Module Federation 2.0 host with two remotes, the build plugin, live deploy and rollback, outage fallbacks, overrides. Includes an end-to-end test. |
| [`examples/import-map`](./examples/import-map) | A static HTML host using import maps and SRI, with `./demo.sh setup`, `deploy 2.0.0` and `rollback`.                                                      |

Running the import-map example against your local registry:

```bash
HARMONIQ_DEV_LOGIN=1 pnpm --filter @harmoniq/registry dev &
pnpm --filter @harmoniq/cli build

cd examples/import-map
node serve.mjs &          # serves host/ and remotes/ on :5050 (stands in for your CDN)
./demo.sh setup           # prints the host URL; open it → "Hello from greeting 1.0.0"
./demo.sh deploy 2.0.0    # reload → 2.0.0
./demo.sh rollback        # reload → 1.0.0
```

---

## CI/CD and infrastructure as code

### GitHub Actions

```yaml
- name: Upload bundle to CDN
  run: aws s3 sync dist/ s3://acme-cdn/checkout/${{ github.sha }}/

- uses: harmoniq-dev/deploy-action@v1 # inside this repository: ./actions/deploy
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme-corp
    module: checkout
    environment: staging
    version: ${{ github.sha }}
    url: https://cdn.acme.dev/checkout/${{ github.sha }}/remoteEntry.js
    file: dist/remoteEntry.js
```

The action also promotes between environments (`promote-from`), waits for approvals (`wait-for-approval`) and creates per-PR preview environments. See [`actions/deploy`](./actions/deploy/README.md).

### Any CI, with the CLI

```bash
npx @harmoniq/cli deploy \
  --module checkout --env staging --release "$CI_COMMIT_SHA" \
  --url "https://cdn.acme.dev/checkout/$CI_COMMIT_SHA/remoteEntry.js" \
  --file dist/remoteEntry.js
```

With `HARMONIQ_REGISTRY_URL`, `HARMONIQ_WORKSPACE` and `HARMONIQ_API_KEY` set as CI secrets. A GitLab CI component is in [`integrations/gitlab`](./integrations/gitlab/README.md).

### From the bundler

```ts
// vite.config.ts of a remote
import { harmoniq } from '@harmoniq/build-plugin';

export default defineConfig({
  plugins: [
    federation({
      name: 'checkout',
      filename: 'remoteEntry.js',
      exposes: { './CheckoutPage': './src/CheckoutPage' },
    }),
    harmoniq.vite({
      module: 'checkout',
      environment: 'staging',
      version: process.env.GITHUB_SHA ?? 'dev',
      outDir: 'dist',
      url: `https://cdn.acme.com/checkout/${process.env.GITHUB_SHA}/remoteEntry.js`,
    }),
  ],
});
```

In CI (`CI=true`) the plugin registers each build, including `exposes` and shared dependencies for the dependency gate. Locally it only prints the hash. webpack, Rspack, Rollup and esbuild are supported too.

### Workspace as code (`harmoniq.yaml`)

Keep host apps, environments, approval policies, freezes, module owners, webhooks and alert rules in your repository, and review changes in pull requests:

```yaml
# yaml-language-server: $schema=https://registry.acme.dev/api/schema/harmoniq.json
version: 1
workspace: acme-corp
hostApps:
  - slug: consumer-portal
    name: Consumer Portal
    sharedDependencies: { react: ^18.0.0 }
    environments:
      - slug: staging
      - slug: production
        default: true
        approvalPolicy: { requiredApprovers: 2, eligibleRoles: [admin, owner] }
    modules:
      - slug: checkout
        owners: [jane@acme.com]
alertRules:
  - name: checkout-errors
    condition: load_success_rate
    threshold: 0.95
    action: auto_rollback
    module: consumer-portal/checkout
    environment: production
```

```bash
harmoniq import                       # write the current workspace to harmoniq.yaml
harmoniq plan                         # show what would change
harmoniq plan --detailed-exitcode     # exit 7 on drift (for scheduled CI checks)
harmoniq apply                        # make the workspace match the file
```

Applying requires an `admin` API key. Prefer Terraform? See the [Terraform provider](./integrations/terraform-provider-harmoniq/README.md).

---

## Running in production

The short version (the full guide is [docs/self-hosting.md](./docs/self-hosting.md)):

1. **Provision PostgreSQL 15+** and create two roles: `harmoniq` (schema owner) and `harmoniq_app` (tenant queries, always subject to RLS). See [`docker/init.sql`](./docker/init.sql).
2. **Provision Redis** if you run more than one registry replica.
3. **Generate secrets:**

   ```bash
   openssl rand -base64 48   # JWT_SECRET (same value on registry and dashboard)
   openssl rand -base64 32   # HARMONIQ_ENCRYPTION_KEY (back it up)
   openssl rand -hex 16      # HARMONIQ_SETUP_TOKEN
   ```

4. **Build the images** and run migrations:

   ```bash
   docker build -f apps/registry/Dockerfile -t harmoniq/registry .
   docker build -f apps/web/Dockerfile      -t harmoniq/web .

   docker run --rm -e DATABASE_URL=… -e SYSTEM_DATABASE_URL=… \
     -w /repo/packages/db harmoniq/registry npx prisma migrate deploy
   ```

5. **Start both services** with `NODE_ENV=production` and the configuration below, behind TLS.
6. **Open `${APP_URL}/admin/setup`**, enter the setup token and the first admin's email, and finish the wizard.
7. **Sign in, create a workspace** and an API key for CI under **Settings → API keys**.

Deployment targets included in this repository:

- **Docker Compose**: [`docker/docker-compose.yml`](./docker/docker-compose.yml)
- **Kubernetes**: Helm chart in [`charts/harmoniq`](./charts/harmoniq)
- **AWS**: ECS Fargate, RDS, ElastiCache, S3 + CloudFront with Terraform in [`deploy/terraform/aws`](./deploy/terraform/aws)

---

## Configuration reference

The most important settings. Every variable is documented in [`.env.example`](./.env.example) and the [self-hosting guide](./docs/self-hosting.md#2-configuration).

| Variable                                                 | Service   | Description                                                                       |
| -------------------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                                           | registry  | App role connection (`harmoniq_app`), subject to RLS                              |
| `SYSTEM_DATABASE_URL`                                    | registry  | Owner role connection (`harmoniq`): migrations, jobs, admin                       |
| `CACHE_ADAPTER`, `REDIS_URL`                             | registry  | `redis` or `memory`; Redis is required with more than one replica                 |
| `STORAGE_ADAPTER`                                        | registry  | `local` (dev default), `s3` or `none` (production default)                        |
| `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_URL`, `S3_ENDPOINT` | registry  | Bucket for published manifests and its CDN URL; `S3_ENDPOINT` for MinIO or R2     |
| `PUBLIC_URL`                                             | registry  | Public URL of the registry                                                        |
| `WEB_ORIGIN`                                             | registry  | Dashboard origin (CORS, sign-in redirects); same as `APP_URL`                     |
| `JWT_SECRET`                                             | both      | Session signing secret, ≥ 32 chars, identical on registry and dashboard           |
| `HARMONIQ_ENCRYPTION_KEY`                                | registry  | 32 bytes, base64; encrypts stored credentials                                     |
| `HARMONIQ_SETUP_TOKEN`                                   | registry  | One-time token for the first-boot wizard                                          |
| `HARMONIQ_AUTH_METHODS`                                  | registry  | Allowed sign-in methods: `github`, `email`, `oidc`, `sso-oidc`, `sso-saml`, `dev` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`               | registry  | GitHub sign-in                                                                    |
| `SMTP_URL`, `MAIL_FROM`                                  | registry  | Email sign-in                                                                     |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`    | registry  | Instance-wide OpenID Connect sign-in                                              |
| `HARMONIQ_DEV_LOGIN`                                     | registry  | `1` enables "sign in as any email". **Development only**                          |
| `REGISTRY_URL`                                           | dashboard | How the dashboard reaches the registry (can be internal)                          |
| `APP_URL`                                                | dashboard | Public URL of the dashboard                                                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                            | registry  | Export OpenTelemetry traces                                                       |

---

## Repository layout

```
harmoniq/
├── apps/
│   ├── registry/              # Registry API server (Fastify) — manifests, deploys, auth, jobs
│   └── web/                   # Next.js dashboard
├── packages/
│   ├── client/                # @harmoniq/client — browser SDK (+ React, Vue, Angular)
│   ├── mf-plugin/             # @harmoniq/mf-plugin — Module Federation 2.0 runtime plugin
│   ├── cli/                   # @harmoniq/cli — CI/CD command-line tool
│   ├── build-plugin/          # @harmoniq/build-plugin — Vite/webpack/Rspack/Rollup/esbuild
│   ├── core/                  # @harmoniq/core — ports, schemas, shared business logic
│   ├── db/                    # @harmoniq/db — Prisma schema, migrations, seed
│   └── tsconfig/              # Shared TypeScript configs
├── actions/deploy/            # GitHub Action
├── integrations/              # GitLab, Terraform provider, Go/Python clients, SchemaStore
├── examples/                  # vite-mf and import-map examples
├── charts/harmoniq/           # Helm chart
├── deploy/terraform/aws/      # AWS reference deployment
├── docker/                    # docker-compose, DB init scripts, Prometheus/Grafana
├── docs/                      # Product, architecture, API and feature docs
└── scripts/                   # dev-local, client generation, license and changelog checks
```

## Useful scripts

| Command                              | Description                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| `pnpm run dev:local`                 | Full stack with embedded Postgres, no Docker (`-- --reset` to wipe) |
| `pnpm run dev`                       | Registry and dashboard in watch mode                                |
| `pnpm run docker:demo`               | Build images and run the complete demo                              |
| `pnpm run docker:up` / `docker:down` | Start or stop Postgres and Redis                                    |
| `pnpm run db:deploy`                 | Apply migrations                                                    |
| `pnpm run db:migrate`                | Create a new migration (development)                                |
| `pnpm run db:seed`                   | Reset demo data                                                     |
| `pnpm run db:studio`                 | Open Prisma Studio                                                  |
| `pnpm run build`                     | Build every package and app                                         |
| `pnpm run test`                      | Run all tests                                                       |
| `pnpm run lint` / `format`           | Lint, or format with Prettier                                       |
| `pnpm run clients:generate`          | Regenerate the Go and Python API clients                            |
| `pnpm changeset`                     | Record a change for the next release                                |

---

## Documentation

Detailed documentation is in [`docs/`](./docs):

- **[Product Requirements](./docs/requirements.md)**: functional and non-functional requirements.
- **[Architecture Decision Records](./docs/architecture.md)**: why each technical choice was made.
- **[API Reference](./docs/api-reference.md)**: REST endpoints (also browsable at `/docs` on the registry; OpenAPI in [`docs/openapi.json`](./docs/openapi.json)).
- **[Database Schema](./docs/database-schema.md)**: Prisma/PostgreSQL schema with RLS details.
- **[Self-Hosting Guide](./docs/self-hosting.md)**: production deployment, security and observability.
- **[SDK Reference](./docs/sdk.md)**: `@harmoniq/client`, framework bindings and the Module Federation plugin.
- **[CLI Reference](./docs/cli.md)**: every `@harmoniq/cli` command, the build plugin and CI examples.
- **[Feature Docs](./docs/features/)**: per-feature design notes and change history (canary, manifest delivery, governance, workspace as code…).

### For contributors

- **[Contributing](./CONTRIBUTING.md)**: setup, checks, conventions and releases.
- **[Implementation Plan](./docs/implementation-plan.md)**: phased build plan with task checklists.
- **[Agent & Contributor Rules](./.agents/AGENTS.md)**: mandatory rules for code standards, documentation and tooling.

## License

This project is licensed under the [Apache 2.0 License](./LICENSE).
