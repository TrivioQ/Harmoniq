# Harmoniq

> Open-source Micro Frontend Control Plane — Apache 2.0

Harmoniq is an open-source, self-hostable **Micro Frontend Control Plane** that eliminates build-time deployment bottlenecks in distributed frontend architectures. It acts as a centralized registry that delivers dynamic, runtime JSON manifests to host application shells, enabling engineering teams to independently deploy, roll back, and canary-test federated modules without rebuilding or redeploying parent containers.

## 🚀 Features

- **Runtime Manifest Delivery:** Serve dynamic JSON manifests so host shells load remote modules without a rebuild.
- **Developer Dashboard:** Multi-tenant control plane UI (built with Next.js) for managing modules, environments, and versions.
- **Instant Rollbacks:** Roll back to any previously deployed bundle version instantly.
- **Canary Releases:** Perform canary testing with configurable, server-side traffic-splitting strategies.
- **Vendor-Agnostic:** Built on a ports-and-adapters (hexagonal) architecture, compatible with any CDN/Storage and IdP.
- **Self-Hostable:** Trivially self-hostable via Docker Compose.
- **First-Class Tooling:** Includes an official `@harmoniq/client` SDK and `@harmoniq/cli` for seamless CI/CD integration.

## 📦 How to Use

### Prerequisites

- [Node.js](https://nodejs.org/) (>= 20)
- [pnpm](https://pnpm.io/) (>= 9)
- [Docker](https://www.docker.com/) (optional: `pnpm run dev:local` runs without it)

### Try it with Docker

```bash
pnpm run docker:demo
```

Builds and starts everything (Postgres, Redis, registry on `:4000`, dashboard on `:3000`) with a demo workspace. Sign in at http://localhost:3000 with **Development sign-in** as `demo@harmoniq.dev`. See [Self-Hosting](./docs/self-hosting.md) for production.

Examples: [`examples/vite-mf`](./examples/vite-mf) (Vite + Module Federation 2.0, with an end-to-end test) and [`examples/import-map`](./examples/import-map) (no bundler).

### Quick Start (development)

1. **Clone the repository:**

   ```bash
   git clone https://github.com/your-org/harmoniq.git
   cd harmoniq
   ```

2. **Install dependencies:**

   > **Note:** This project strictly uses `pnpm`.

   ```bash
   pnpm install
   ```

3. **Quickest: no Docker, no Postgres install.**

   ```bash
   pnpm run dev:local
   ```

   Runs an embedded Postgres (data in `.harmoniq/dev-local`, `--reset` to start over), applies migrations, adds demo data and starts the registry (`http://localhost:4000`) and the dashboard (`http://localhost:3000`) with an in-memory cache and **Development login**. Ctrl+C stops everything.

   The steps below set up the same stack on Docker's Postgres and Redis instead.

4. **Configure environment and start local infrastructure (Database, Redis, etc.):**

   ```bash
   cp .env.example .env
   cp .env.example packages/db/.env
   pnpm run docker:up
   ```

   > **Upgrading an existing dev database?** Volumes created before the owner/app role
   > split need a one-time, non-destructive ownership change:
   > `docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql`

5. **Run database migrations and seed data:**

   ```bash
   pnpm run db:deploy
   pnpm run db:seed
   ```

6. **Start the development servers:**
   ```bash
   pnpm run dev
   ```
   The Next.js dashboard will be accessible at `http://localhost:3000` and the Registry API at `http://localhost:4000`.

## 📚 Documentation

Detailed documentation is available in the [`docs/`](./docs) directory:

- **[Product Requirements](./docs/requirements.md)**: Full product requirements (functional & non-functional).
- **[Architecture Decision Records (ADRs)](./docs/architecture.md)**: Why we made each technical choice.
- **[API Reference](./docs/api-reference.md)**: REST API endpoint documentation.
- **[Database Schema](./docs/database-schema.md)**: Complete Prisma/PostgreSQL schema reference with RLS details.
- **[Self-Hosting Guide](./docs/self-hosting.md)**: Instructions for deploying Harmoniq.
- **[SDK Reference](./docs/sdk.md)**: `@harmoniq/client` SDK usage.
- **[CLI Reference](./docs/cli.md)**: `@harmoniq/cli` documentation.

### For Contributors

Please refer to the following guides before contributing:

- **[Contributing](./CONTRIBUTING.md)**: Setup, checks, conventions and releases.
- **[Implementation Plan](./docs/implementation-plan.md)**: Phased build plan with task checklists.
- **[Agent & Contributor Rules](./.agents/AGENTS.md)**: Mandatory rules for code standards, documentation, and tooling.
- **[Feature Docs](./docs/features/)**: Per-feature documentation with design context and change history.

## 📄 License

This project is licensed under the [Apache 2.0 License](./LICENSE).
