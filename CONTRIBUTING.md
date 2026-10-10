# Contributing to Harmoniq

Thanks for helping. This guide covers setting up, the checks a pull request must pass and the conventions reviewers look for. The full rules (also followed by AI agents) are in [`.agents/AGENTS.md`](.agents/AGENTS.md).

## Set up

You need Node.js 20+ and pnpm 9 (`corepack enable`). npm and yarn are refused.

```bash
pnpm install
pnpm run dev:local     # registry :4000 + dashboard :3000, embedded Postgres, no Docker
```

Open http://localhost:3000 and use **Development login** with any email. `pnpm run dev:local --reset` starts from an empty database.

The integration tests need the Docker database and Redis instead:

```bash
pnpm run docker:up     # Postgres on 5433, Redis on 6380
pnpm run db:migrate
pnpm test
```

## Repository layout

| Path                                                  | What                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| `apps/registry`                                       | Fastify API: manifests, deploys, auth, jobs        |
| `apps/web`                                            | Next.js dashboard; talks to the registry API only  |
| `packages/core`                                       | Zod schemas, ports and shared logic (the contract) |
| `packages/db`                                         | Prisma schema, migrations, row-level security      |
| `packages/client`, `cli`, `mf-plugin`, `build-plugin` | Published packages                                 |
| `docs/`                                               | Requirements, feature docs, API reference, guides  |

## Before you open a pull request

```bash
pnpm run build && pnpm run lint && pnpm test
pnpm exec prettier --check "**/*.{ts,tsx,md,json}"
pnpm run license:check
```

CI runs these, plus a production dependency audit, the OpenAPI staleness test, the manifest benchmark and the end-to-end example.

- **Tests.** Every feature or fix comes with tests: unit tests for `packages/core` and adapters, integration tests against a real database for registry routes. Tests create their own data with the fixtures in `apps/registry/src/__tests__/helpers/fixtures.ts` and clean up only what they created. `@harmoniq/core` must stay above 90% coverage.
- **Feature docs.** A change outside `docs/` and Markdown must add a dated entry to the Change History of the relevant `docs/features/<slug>.md` (`pnpm run changelog:check` enforces it).
- **Changesets.** A change to a published package (`client`, `cli`, `mf-plugin`, `build-plugin`) needs `pnpm changeset`, describing it for users of the package. Call out breaking changes.
- **Plan.** If your change completes an item in `docs/implementation-plan.md`, tick it.
- **API changes.** Registry routes: run `pnpm --filter @harmoniq/registry openapi:generate` and commit `docs/openapi.json`; update `docs/api-reference.md`.
- **Database.** Schema changes need a Prisma migration (never `db push`). Tenant tables have `workspaceId`, an index on it and row-level security.
- **License headers.** New source files start with:

  ```ts
  // Copyright The Harmoniq Authors
  // SPDX-License-Identifier: Apache-2.0
  ```

  `pnpm run license:check --fix` adds it.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <summary>`, with requirement IDs where they apply.

```
feat(registry): add ETag support on manifest endpoint (MAN-04)
fix(db): correct RLS policy for ModuleVersion table
```

Types: `feat`, `fix`, `perf`, `refactor`, `security`, `docs`, `chore`, `test`, `ci`. Scopes: the package or app (`registry`, `web`, `client`, `cli`, `db`, `core`, `docker`, `docs`).

## Releases

Maintainers merge the "Version Packages" pull request that the release workflow keeps up to date from the changesets on `main`; merging it publishes to npm with provenance. Docker images are published from `v*` tags.

## Security

Don't open a public issue for a vulnerability. Report it privately through GitHub's **Report a vulnerability** (Security tab of the repository).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
