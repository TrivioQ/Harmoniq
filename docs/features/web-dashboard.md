# Web Dashboard (`apps/web`)

## Overview

The Web Dashboard is a Next.js App Router application that provides the primary UI for developers and administrators to manage Harmoniq workspaces, modules, deployments, and settings. It is built with Tailwind CSS, Shadcn UI, and Lucide React.

## Requirements

| Requirement ID | Description                          | Status |
| -------------- | ------------------------------------ | ------ |
| DASH-01        | Scaffold Next.js application         | Done   |
| DASH-02        | GitHub OAuth Authentication Flow     | Done   |
| DASH-03        | Edge middleware for JWT Verification | Done   |
| DASH-04        | Workspace Selector                   | Done   |
| DASH-05        | Dashboard Overview Page              | Done   |
| DASH-06        | Modules Management Page              | Done   |
| DASH-07        | Environments Configuration Page      | Done   |
| DASH-08        | Dashboard Integration Tests          | Done   |

## Architecture Notes

- Next.js 16 (App Router). `src/proxy.ts` (formerly middleware) does an optimistic session check and transparent refresh; see [authentication](./authentication.md).
- **All data comes from the registry API** (`src/lib/registry.ts`, typed reads in `src/lib/workspaceApi.ts`). The dashboard has no database access; authorization, audit and tenant isolation live in the registry.
- Mutations are server actions (`[workspaceSlug]/actions.ts`) rendered through `components/ActionForm.tsx`, which shows results, confirmations and one-time secrets.
- Role checks in the UI only hide controls; the registry enforces permissions on every call.
- Copy lives in `messages/en.json` and `messages/es.json` (next-intl); both locales must have the same keys.

## Breaking Changes

- N/A (Initial implementation)

## Change History

### 2026-10-09 — Dashboard on the registry API: module history, rollback, promote, freezes, settings

**Type:** feature
**PR / Branch:** feat/m1-core-loop
**Refs:** VER-05, PRO-05, DIFF-03, ENV-FRZ-01/05, AUD-03, KEY-01/05, MT-03, WHK-08, DX-04 (partial); product-analysis §3.3, §4.20

#### What changed

- Removed every direct Prisma query and the `@harmoniq/db` dependency.
- Pages: workspace selector with create; overview (real counts and recent activity — the hard-coded "Healthy" is gone); modules with the active version per environment and create; **module detail** with per-environment history, rollback and promote (admins/owners); environments with freeze/unfreeze and 🔒 FROZEN badges; per-environment **history with diffs**; filterable **audit log**; settings for storage, API keys (create/rotate/revoke, shown once), members (invite, roles, remove) and webhooks (secrets shown once, pause, dead letters with retry).
- Audit events are rendered as sentences in both locales.

#### Testing

Manual end-to-end run against a live registry: all 13 pages return 200 with the expected content in English and Spanish. Server actions call registry endpoints covered by the registry's integration tests; the actions themselves have no automated test yet.

### 2026-09-13 — Initial Dashboard Implementation

**Type:** feature
**Refs:** DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08

#### What changed

- Scaffolded `apps/web` with Next.js, Tailwind v4, and Shadcn UI.
- Implemented OAuth authentication flow in `/api/auth/login/github` and `/api/auth/callback/github` using `jose` JWTs.
- Created Edge Middleware for route protection.
- Built Workspace Selector (`/`), Overview (`/[workspaceSlug]/`), Modules (`/[workspaceSlug]/modules`), Environments (`/[workspaceSlug]/environments`), and Settings (`/[workspaceSlug]/settings`).
- Added basic test suite for Auth API route using Vitest.

#### Why

To provide the initial UI skeleton for developers managing remote modules and environments.

#### Testing

- Auth API integration tests added in `src/__tests__/auth.test.ts`
- Verified successful Next.js Turbopack build
