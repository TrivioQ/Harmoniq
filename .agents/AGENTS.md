# Harmoniq — Agent & Contributor Rules

> These rules apply to **all contributors**: human engineers, AI agents, and automated tooling.
> Rules are enforced by CI checks and code review.

---

## 1. Package Manager Rule

**ALWAYS use `pnpm`. Never use `npm` or `yarn`.**

```bash
# ✅ Correct
pnpm install
pnpm add <package>
pnpm run <script>

# ❌ Forbidden
npm install
yarn add
```

- The root `package.json` contains a `preinstall` script that exits with an error if `npm` or `yarn` is detected.
- All scripts in `package.json` files across the monorepo MUST use `pnpm` syntax.

---

## 2. Change Documentation Rule (MANDATORY)

This project uses **two complementary documentation systems**. They are NOT interchangeable:

| System | Location | Purpose | Audience |
|--------|----------|---------|----------|
| **Feature Docs** | `docs/features/<slug>.md` | Narrative context: why a feature exists, design decisions, requirement traceability, change history | Team + AI agents |
| **Changesets** | `.changeset/` | Semver versioning and package release notes | Package consumers / npm |

### Feature Docs (`docs/features/`)

**Every substantive change to a feature MUST be recorded in its feature doc before merging.**

> [!NOTE]
> Feature doc updates are required when preparing a change **for merging into the codebase**. They are NOT required for local edits, draft work, or intermediate task work.

#### What counts as "substantive"?
- Any new feature, bug fix, refactor, performance improvement, or security fix
- Any change to a public API (SDK, CLI, REST endpoints, manifest schema)
- Any database migration
- Any change to Docker configuration, environment variables, or deployment scripts
- Any change to a port interface (`ICache`, `IStorage`, `ILogger`, `OAuthPlugin`)

#### What does NOT require a feature doc update?
- Fixing a typo in a comment
- Reformatting code (Prettier run)
- Updating `pnpm-lock.yaml` only (e.g., from a `pnpm install`)
- Updating README for a grammar fix

#### How to update / create a feature doc

**Updating an existing feature (most common):**
1. Open `docs/features/<relevant-slug>.md`
2. Prepend a new dated section to the **Change History** block (newest entry at the top):
   ```markdown
   ### YYYY-MM-DD — <Short Description>
   **Type:** feature | bugfix | refactor | performance | security | docs
   **PR / Branch:** <link>
   **Refs:** <requirement IDs, e.g. MAN-04, ADR-006>
   #### What changed
   - ...
   #### Why
   ...
   #### Testing
   ...
   ```
3. Update the **Requirements** table status column if applicable
4. Commit the feature doc update alongside your code changes

**Creating a new feature doc:**
1. Copy `docs/features/_template.md`
2. Name it `docs/features/<short-kebab-slug>.md`
3. Fill in all sections: Overview, Requirements, Architecture Notes, Breaking Changes
4. Add the first Change History entry
5. Add the file to the table in `docs/features/README.md`

#### Requirement ID References

Always reference requirement IDs in the **Refs** field of each Change History entry:

```markdown
**Refs:** MAN-04, ADR-006
```

Requirement IDs follow the pattern: `<AREA>-<NUMBER>` (e.g., `MAN-04`, `VER-01`, `GC-03`, `CAN-02`).

### CI Enforcement

The `changelog:check` CI script verifies that any PR touching files outside `docs/`, `*.md`, and lock files also includes an update to a file in `docs/features/`. PRs failing this check will not be merged.

---

## 3. Commit Message Rule

All commits MUST follow **Conventional Commits**:

```
<type>(<scope>): <short description>

[optional body]

[optional footer: Refs: MAN-04, ADR-006]
```

### Types
| Type | Use for |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code restructure, no behavior change |
| `security` | Security fix or hardening |
| `docs` | Documentation only |
| `chore` | Tooling, dependencies, config |
| `test` | Adding or fixing tests |
| `ci` | CI/CD changes |

### Scopes
Use the package or app name: `registry`, `web`, `client`, `cli`, `db`, `core`, `docker`, `docs`

### Examples
```
feat(registry): add ETag support on manifest endpoint (MAN-04)
fix(db): correct RLS policy for ModuleVersion table
perf(client): implement stale-while-revalidate manifest caching
security(registry): switch API key hashing from bcrypt to argon2id (KEY-01)
docs(docs): add database schema reference
chore(root): configure Turborepo pipeline for test task
```

---

## 4. Code Standards

### TypeScript
- `strict: true` in all `tsconfig.json` files — no exceptions.
- No `any` types. Use `unknown` and narrow it, or use proper generics.
- All public functions and class methods MUST have JSDoc comments.
- All exported types MUST be explicitly declared (no implicit `any` exports).

### API Design
- All request bodies MUST be validated with a `zod` schema before processing.
- All error responses MUST follow the standard error envelope:
  ```json
  { "error": { "code": "MANIFEST_NOT_FOUND", "message": "...", "requestId": "..." } }
  ```
- HTTP status codes MUST be semantically correct (no 200 for errors).

### Database
- Never use `prisma db push` in any environment.
- All schema changes require a Prisma migration file.
- Every new table that is tenant-scoped MUST have:
  - A `workspaceId` column with a FK to `Workspace`
  - An `@@index([workspaceId])` in the Prisma model
  - RLS enabled (add to the RLS SQL migration hook)
- GC-eligible tables MUST have a `deletedAt DateTime?` column.

### Port Interfaces
- New adapters MUST implement the full port interface — no partial implementations.
- Adapters MUST be independently testable with mock data.
- Adapters MUST be registered in the service container (`apps/registry/src/container.ts`).

---

## 5. Testing Rule

- **Mandatory Feature Test Coverage**: Every feature implemented or modified MUST include comprehensive test cases (unit, integration, or E2E tests as appropriate) covering happy paths, failure conditions, edge cases, and security boundaries. Code changes for features without accompanying tests MUST NOT be merged.
- **Unit tests**: required for all business logic in `packages/core` and all adapters.
- **Integration tests**: required for all registry API routes (use a real test DB).
- **E2E tests**: required for the deploy → manifest → rollback flow.
- Minimum coverage: **80%** on `packages/core` and `apps/registry`.
- Tests run via `pnpm test` (Vitest workspace).
- All tests MUST pass before a PR is merged.

---

## 6. Security Rules

- **Never commit secrets, API keys, or credentials** to the repository.
- Use `.env.local` (git-ignored) for local credentials. Use `.env.example` for documentation.
- All user inputs that reach the database MUST pass through a Zod schema first.
- Never disable RLS policies in application code.
- Never use `prisma.$queryRawUnsafe` with user-provided input.

---

## 7. AI Agent Specific Rules

When an AI agent (Antigravity, Copilot, etc.) makes code changes to this repository:

1. **Read relevant docs first**: Before implementing a feature, read the corresponding requirement IDs in `docs/requirements.md` and any relevant ADRs in `docs/architecture.md`.
2. **Update the feature doc before merging**: When preparing a pull request or branch for merging, update the relevant `docs/features/<slug>.md` file (or create one if the feature is new) by prepending a dated section to its Change History. This is NOT required for local edits or intermediate task work.
3. **Reference requirements**: In commit messages and changelog entries, reference the requirement IDs that motivated the change.
4. **Do not bypass RLS**: Never generate code that disables or bypasses RLS.
5. **Use pnpm**: All shell commands for package management MUST use `pnpm`.
6. **Follow port interfaces**: When implementing new adapters, implement the full `ICache`, `IStorage`, `ILogger`, or `OAuthPlugin` interface from `@harmoniq/core`.
7. **Update implementation plan**: When completing a task from `docs/implementation-plan.md`, mark the corresponding checkbox as done (`[x]`).
8. **Write test cases for all features**: Every new feature or feature modification MUST include comprehensive test cases (unit, integration, or E2E as applicable) before completing the task.

