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

- Uses Next.js 16 (App Router)
- Edge Middleware (`middleware.ts`) protects all routes except `/auth/*`
- Uses `jose` for lightweight Edge-compatible JWT signing and verification
- Connects directly to `@harmoniq/db` via Prisma Client for data access in React Server Components
- Uses Shadcn UI for accessible, unstyled-by-default, customizable components

## Breaking Changes

- N/A (Initial implementation)

## Change History

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
