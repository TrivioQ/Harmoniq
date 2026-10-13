# Feature: Authentication

> **Requirement IDs:** `SSO-01`–`SSO-08`, `SSO-21`, `SSO-22`, `INST-01`–`INST-06`, `KEY-01`–`KEY-05`
> **Status:** `implemented`
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

| ID            | Requirement                                             | Status                                                                 |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SSO-06`      | JIT user provisioning on first sign-in                  | ✅ Done                                                                |
| `SSO-22`      | Pending invitations accepted on sign-in                 | ✅ Done (auto-accept)                                                  |
| `INST-01`     | First-boot setup wizard                                 | ✅ Done                                                                |
| `INST-04`     | Setup token single use                                  | ✅ Done                                                                |
| `INST-05/06`  | Admin panel only for instance admins                    | ✅ Done                                                                |
| —             | GitHub OAuth (PKCE, verified primary email only)        | ✅ Done                                                                |
| —             | Passwordless email (magic link + code)                  | ✅ Done (M1.3)                                                         |
| `SSO-01`–`08` | OIDC                                                    | ✅ Done (M4.4; see [governance](./enterprise-governance.md))           |
| `SSO-09`–`20` | SAML                                                    | ✅ Done (M4.5; see [governance](./enterprise-governance.md))           |
| `SES-01`–`04` | Session limits, session list, TOTP MFA, user suspension | ✅ Done (9.7; see [tenant administration](./tenant-administration.md)) |

See [`docs/requirements.md §5.21`](../requirements.md).

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

**Session limits (SES-01).** The instance setting `auth.session` (`maxDays`, default 30, and `idleMinutes`, default none) bounds every session; organization policy only shortens it for its members. A refresh token expires at the earlier of the session's start plus the maximum and now plus the idle timeout, and each refresh checks both against the current limits.

**Sessions (SES-02).** A session is a refresh-token family. Access tokens carry its id (`sid`), and the registry rejects tokens of an ended session (checked at most every 15 seconds per replica). Users see their sessions (provider, IP, browser, MFA) and end one or all others on `/account`.

**Multi-factor authentication (SES-03).** TOTP (RFC 6238, 30-second steps, one step of drift each way, a used step never accepted again) with ten single-use recovery codes stored as sha256. A sign-in by a user with MFA that doesn't go through tenant SSO returns a 5-minute challenge (a JWT with `aud: harmoniq-mfa`) instead of tokens; the dashboard keeps it in an HttpOnly cookie, shows `/auth/mfa`, and exchanges it with the code at `POST /api/auth/mfa/verify`. Such sessions carry `amr: ["mfa"]`. An organization's `requireMfa` refuses (`403 MFA_REQUIRED`) sessions of its members that signed in without SSO and without a second factor; enrolling upgrades the current session. Instance admins can reset a lost factor.

**Suspension (SES-04).** A suspended user's sign-ins are refused after the identity check, refreshes end the session, access tokens are rejected on their next request, and API keys they created stop (the key cache is cleared on suspend).

**Instance admin.** `/admin/setup` creates the first admin for an email; that person then signs in normally. The admin panel lives under the `(panel)` route group, which requires an instance-admin session (others get 404).

**Dev login.** `HARMONIQ_DEV_LOGIN=1` exposes `POST /api/auth/dev/login` (sign in as any email). The registry refuses to start with it in production.

**Data.** `Identity` (provider + subject → user), `RefreshToken` (`tokenHash` unique, `familyId`), `EmailLoginToken` (for M1.3). The tenant DB role has no access to these tables.

## Breaking Changes

YES — see the change history entry below.

---

## Change History

### 2026-10-12 — Session limits, sessions, MFA and suspension (Phase 9.7)

**Type:** feature  
**PR / Branch:** `feat/tenant-admin-phase-9`  
**Refs:** SES-01, SES-02, SES-03, SES-04

See the architecture notes above and [tenant administration](./tenant-administration.md). Sign-in responses may now be an MFA challenge: clients of `POST /api/auth/:provider/callback`, `/api/auth/email/verify` and `/api/auth/dev/login` must handle `mfaRequired` (the dashboard does). Tests: `identitySecurity.test.ts`.

### 2026-10-10 — Sign-in methods controlled by the environment

**Type:** feature, security
**PR / Branch:** feat/m4-enterprise
**Refs:** INST-13, SSO-26

#### What changed

- `HARMONIQ_AUTH_METHODS`: a comma-separated allowlist of sign-in methods, `github`, `email`, `oidc` (the instance IdP from `OIDC_*`), `sso-oidc` and `sso-saml` (configured by workspaces and organizations) and `dev`. Unset or blank keeps the previous behavior: every configured method, plus `dev` with `HARMONIQ_DEV_LOGIN`.
- A method needs the environment's permission and the admin panel's switch. The admin API refuses to turn on a switch the environment forbids (400), and the admin page shows it locked with the reason.
- Sessions from a method that is no longer allowed end at their next request: access tokens are refused and refresh revokes the session family. Previously they lasted until the refresh token expired.
- SSO discovery by email domain only returns protocols that are enabled.
- Startup refuses unknown methods, an empty list, `dev` in production and `HARMONIQ_DEV_LOGIN` without `dev` in a set list. It logs the allowed methods and warns about listed methods without credentials.
- `.env.example`, Docker Compose and the Helm values document the variable and the instance `OIDC_*` variables, which were missing.

#### Why

Enterprises need to pin sign-in to their IdP from configuration they control (Helm values, a secret store), not from a database setting that any instance admin can change, and to know that removing a method actually ends its sessions.

#### Testing

`config.test.ts` covers parsing and startup refusals. `authMethods.test.ts` starts the registry with `email,sso-oidc` and checks the provider list, the locked admin switches, refused access tokens per provider and refused, revoked refresh.

### 2026-10-09 — Rate limits per user, not per dashboard

**Type:** fix
**PR / Branch:** feat/m3-progressive
**Refs:** report §3.x follow-up (M0.3 rate limits)

#### What changed

Every dashboard request reaches the registry from the dashboard's server, so the per-IP auth limits were shared by all users: 60 refreshes per minute for the whole instance (busy minutes signed everyone out) and 20 email sign-ins per 15 minutes. Behind a load balancer the manifest limit had the same problem.

- `/api/auth/refresh` and `/api/auth/logout` are limited per session (hash of the refresh token, 30/min).
- The dashboard forwards the browser's `X-Forwarded-For`; the registry trusts it from private networks by default (`TRUST_PROXY`), so per-IP limits and audit IPs use the user's address.
- Terraform: the dashboard reaches the registry over ECS Service Connect instead of the public load balancer, so requests don't arrive from the NAT gateway's address.

#### Testing

`auth.test.ts`: a session's refreshes are limited without affecting another session from the same IP; per-IP sign-in limits follow the forwarded address (fails with `TRUST_PROXY=false`). `config.test.ts` covers `TRUST_PROXY` parsing. `terraform validate` passes.

### 2026-10-09 — Email sign-in: magic link and one-time code

**Type:** feature
**PR / Branch:** feat/m1-core-loop
**Refs:** product-analysis §5.11 (M1.3)

#### What changed

- `EmailIdentityProvider` and an `IMailer` port (`SmtpMailer` via `SMTP_URL`, `ConsoleMailer` in development). Without SMTP in production, email sign-in is not offered.
- `POST /api/auth/email/request` always answers 202 (no account enumeration); at most 5 emails per address per 15 minutes, 20 requests per IP per 15 minutes. `POST /api/auth/email/verify` accepts `{ token, nonce }` or `{ email, code }`.
- Tokens and codes are stored only as sha256 hashes, expire after 15 minutes, are single use (atomic claim) and codes lock after 5 wrong attempts.
- The link is bound to the requesting browser through an HttpOnly nonce cookie (login CSRF); another device uses the code.
- Dashboard: email form and code form on `/auth/login`; `/auth/verify` signs in only on an explicit POST, so mail scanners that prefetch links cannot consume the token.

#### Testing

Registry `emailAuth.test.ts` (7) and web `emailAuth.test.ts` (5). End to end against running servers: link in the requesting browser signs in; the same link in another browser is refused; the code works there; a used link fails.

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
