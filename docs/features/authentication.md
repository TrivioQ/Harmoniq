# Feature: Authentication

> **Requirement IDs:** `SSO-01`–`SSO-08`, `SSO-21`, `SSO-22`, `INST-01`–`INST-06`, `KEY-01`–`KEY-05`
> **Status:** `in-progress`
> **Phase:** M0.4 (GitHub, dev login), M1.3 (email), M4.4–M4.6 (OIDC, SAML, SCIM)

How people and CI systems prove who they are to Harmoniq. Identity providers only prove identity; the registry links it to its own `User` and issues Harmoniq sessions, so no provider sits on the request path after sign-in.

---

## Overview

| Caller           | Credential                                                                      | Verified by                                                        |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Dashboard user   | 15-min access JWT (`hq_session` cookie) + rotating refresh token (`hq_refresh`) | `plugins/authenticate.ts` (registry), `proxy.ts` (web, optimistic) |
| CI / CLI         | API key `hq_<keyId>_<secret>`                                                   | `plugins/authenticate.ts`                                          |
| First-boot setup | `HARMONIQ_SETUP_TOKEN` (single use)                                             | `routes/admin.ts`                                                  |

## Requirements

| ID            | Requirement                                      | Status                |
| ------------- | ------------------------------------------------ | --------------------- |
| `SSO-06`      | JIT user provisioning on first sign-in           | ✅ Done               |
| `SSO-22`      | Pending invitations accepted on sign-in          | ✅ Done (auto-accept) |
| `INST-01`     | First-boot setup wizard                          | ✅ Done               |
| `INST-04`     | Setup token single use                           | ✅ Done               |
| `INST-05/06`  | Admin panel only for instance admins             | ✅ Done               |
| —             | GitHub OAuth (PKCE, verified primary email only) | ✅ Done               |
| —             | Passwordless email (magic link + code)           | 📋 Planned (M1.3)     |
| `SSO-01`–`08` | OIDC                                             | 📋 Planned (M4.4)     |
| `SSO-09`–`20` | SAML                                             | 📋 Planned (M4.5)     |

See [`docs/requirements.md §5.21`](../requirements.md) and [`docs/product-analysis.md §5.11`](../product-analysis.md).

## Architecture Notes

**Port.** `IdentityProvider` in `packages/core/src/ports/IdentityProvider.ts` (replaces `OAuthPlugin`) has three kinds: `redirect` (GitHub, OIDC, SAML), `token` (Firebase, Supabase, Clerk — optional adapters) and `email`. Redirect providers receive the PKCE `codeChallenge` at start and the `codeVerifier` only at the code exchange.

**Sign-in flow (redirect).**

1. Dashboard `GET /api/auth/login/:provider` creates `state` + PKCE verifier, stores them in 10-minute HttpOnly cookies, and asks the registry (`POST /api/auth/:provider/start`) for the authorization URL.
2. The provider redirects to `GET /api/auth/callback/:provider` on the dashboard, which checks `state` against the cookie and sends `code` + verifier to the registry (`POST /api/auth/:provider/callback`).
3. The registry exchanges the code, then `AuthService.completeLogin()` links the identity and returns an access + refresh token pair, which the dashboard stores as HttpOnly, `SameSite=Lax` cookies.

The registry only accepts `redirectUri` values on `WEB_ORIGIN`, so codes cannot be redirected elsewhere.

**Account linking.** Accounts are created or linked by email **only when the provider verified the email**. Otherwise an attacker could register an unverified address with some provider and take over the account when its owner signs in. GitHub's profile email is ignored; only the verified primary email from `/user/emails` counts. Emails are normalized to lowercase.

**Sessions.** Access tokens are HS256 JWTs (`aud: harmoniq-session`, 15 minutes) signed with `JWT_SECRET`, shared by registry and dashboard. Refresh tokens are random, stored as sha256 hashes, rotated on every use and grouped in a family. Replaying a rotated token revokes the whole family, except within a 10-second grace window that tolerates two tabs refreshing at once. Logout revokes the family.

**Dashboard.** `src/proxy.ts` (Next.js 16 Proxy) does an optimistic JWT check and refreshes expired sessions transparently. It writes the new tokens onto the incoming request so pages and server actions render with them in the same round trip. It never clears cookies when a refresh fails, because a parallel request may have won the rotation race. All data comes from the registry through `src/lib/registry.ts`. Logout is POST-only and same-origin.

**Instance admin.** `/admin/setup` creates the first admin for an email; that person then signs in normally. The admin panel lives under the `(panel)` route group, which requires an instance-admin session (others get 404).

**Dev login.** `HARMONIQ_DEV_LOGIN=1` exposes `POST /api/auth/dev/login` (sign in as any email). The registry refuses to start with it in production.

**Data.** `Identity` (provider + subject → user), `RefreshToken` (`tokenHash` unique, `familyId`), `EmailLoginToken` (for M1.3). The tenant DB role has no access to these tables.

## Breaking Changes

YES — see the change history entry below.

---

## Change History

### 2026-10-08 — Real sign-in: GitHub OAuth, sessions, admin panel

**Type:** security fix
**PR / Branch:** feat/m0-safety-foundations
**Refs:** INST-01, INST-04–INST-06, SSO-06, SSO-22; product-analysis §3.2, §4.18

#### What changed

- Replaced the mocked GitHub callback (any code signed you in as `realuser@example.com`) with real OAuth + PKCE via the registry.
- New registry routes: `GET /api/auth/providers`, `POST /api/auth/:provider/start`, `POST /api/auth/:provider/callback`, `POST /api/auth/dev/login` (dev only), `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/me`.
- Rotating refresh tokens with reuse detection; logout revokes server-side.
- Dashboard: `middleware.ts` → `proxy.ts` with transparent refresh; logout is POST + same-origin (was a GET); admin pages are server-rendered and no longer keep an admin token in `localStorage`; the storage form sends the API's schema and never receives secrets.
- `POST /api/admin/setup` no longer returns a token; the admin signs in with the same email.
- Workspace selector and workspace layout read memberships from `/api/me`; non-members get 404.
- Fixed: the registry could not start outside tests because pg-boss 10+ requires `createQueue()` before `schedule()`/`work()`.

#### Why

Anyone could sign in to the dashboard as a hard-coded user, logout was CSRF-able, and the admin token was readable by any script on the page.

#### Testing

- Registry `auth.test.ts` (13 tests) with a mocked GitHub: PKCE start, foreign redirect URI rejected, verified-email-only linking, invite acceptance, refresh rotation, family revocation on replay (verified to fail when reuse detection is disabled), concurrent-tab grace, logout.
- Web `auth.test.ts` (12 tests): state mismatch, cookie flags, registry error mapping, cross-site logout, proxy refresh and header forwarding.
- Manual end-to-end against running registry + dashboard: dev sign-in, workspace access and 404 for non-members, transparent refresh, logout invalidates copied cookies, admin panel for instance admins only.

#### Breaking changes

- New env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `HARMONIQ_DEV_LOGIN`; the dashboard needs `JWT_SECRET` and `REGISTRY_URL`. `NEXT_PUBLIC_REGISTRY_URL` is no longer used.
- GitHub OAuth app callback URL is `${NEXT_PUBLIC_APP_URL}/api/auth/callback/github`.
- Session cookies renamed to `hq_session` / `hq_refresh`; existing sessions are signed out.
