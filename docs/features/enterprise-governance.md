# Feature: Enterprise-Grade Governance

> **Requirement IDs:** `RBAC-01`–`RBAC-06`, `ENV-FRZ-03`–`04`, `APR-01`–`APR-18`, `SSO-*`, `ORG-01`–`ORG-15`, `INST-*`, `BYOB-*`, `IaC-01`–`IaC-14`  
> **Status:** `in-progress`  
> **Phase:** M4

Covers the three enterprise procurement blockers identified in gap analysis: Change Approval Workflows, Organization Hierarchy, and GitOps / Infrastructure as Code. Targets regulated industries (SOX, PCI-DSS, HIPAA) and large enterprises with complex team structures.

---

## Overview

Large enterprises operating in regulated industries require three capabilities that Harmoniq currently lacks:

1. **Change Approval Workflows** — SOX, PCI-DSS, and HIPAA-regulated orgs cannot legally deploy to production without a documented 4-eyes approval trail.
2. **Organization Hierarchy** — Enterprises with 50+ product teams cannot model their structure without a container entity above "workspace."
3. **GitOps / IaC** — Mature DevOps teams manage all infrastructure as code. Without a Terraform provider and declarative YAML support, platform engineering teams are forced to build their own tooling.

## Requirements

| ID                                                      | Requirement                                                                                                             | Status          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| `RBAC-01`–`RBAC-06`                                     | Module ownership and module-scoped access                                                                               | ✅ Done (M4.1)  |
| `SSO-01`–`SSO-08`, `SSO-21`–`SSO-23`, `SSO-26`–`SSO-28` | OIDC single sign-on, JIT, domain join, group mapping, forced SSO, IdP session lifetime                                  | ✅ Done (M4.4)  |
| `SSO-09`–`SSO-20`                                       | SAML 2.0 single sign-on: SP/IdP-initiated, metadata, SLO, signing keypair, setup notes, test connection                 | ✅ Done (M4.5)  |
| `SSO-24`, `SSO-25`                                      | SCIM 2.0 provisioning and deprovisioning (workspace level; org level comes with organizations)                          | ✅ Done (M4.6)  |
| `ENV-FRZ-03`–`04`                                       | Owner freeze override, scheduled freeze windows                                                                         | ✅ Done (M4.2)  |
| `APR-01`–`APR-18`                                       | Change Approval Workflows                                                                                               | ✅ Done (M4.3)  |
| `ORG-01`–`ORG-04`, `ORG-08`–`ORG-15`                    | Organizations: members, workspaces, org admins, cross-workspace audit, shared modules, catalog, org API keys, dashboard | ✅ Done (M4.7)  |
| `ORG-05`–`ORG-07`                                       | Org-level SSO (OIDC, SAML) inherited by workspaces, group rules, org SCIM                                               | ✅ Done (M4.7b) |
| `IaC-01`–`IaC-14`                                       | GitOps / Infrastructure as Code                                                                                         | 📋 Planned      |

See [`docs/requirements.md §16`](../requirements.md) for the full specification.

## Architecture Notes

### Single sign-on (OIDC)

Workspace providers (`oidc:<workspace>`) are built from `WorkspaceConfig.oidcConfig` (client secret sealed) and cached for five minutes; saving the settings invalidates the cache. The nonce is derived from the PKCE challenge, so it needs no server-side storage and binds the ID token to the browser holding the verifier. The login's provider is carried in the access token (`prv`) and on the refresh-token family, which is what forced SSO checks; in-process calls (scheduled operations, approved requests) are exempt because their creator was checked at creation. A workspace admin picks the issuer, so the registry refuses private and non-HTTPS issuer, token and JWKS URLs in production unless the instance allows private issuers.

### Single sign-on (SAML 2.0)

`saml:<workspace>` providers are built from `WorkspaceConfig.samlConfig` with `@node-saml/node-saml`. The SP signing key is generated with the first save (self-signed, 10 years) and sealed at rest; AuthnRequests are signed and responses must carry a signed assertion. SAML has no PKCE, so the ACS binds the login to the browser itself: `start` stores the dashboard's state and code challenge under the request's RelayState, the ACS checks `InResponseTo` against the request ids it issued (kept in the cache for ten minutes) and hands the dashboard a one-time code that only the holder of the PKCE verifier can exchange. IdP-initiated responses have nothing to bind to, so they are refused unless the workspace opts in; the code then goes straight to the dashboard's redeem route.

Every session started through a workspace's IdP (OIDC or SAML) is confined to that workspace: that IdP vouches for its own members, not for what the same person can do elsewhere.

### Provisioning (SCIM)

The SCIM token identifies the workspace (its sha256 is unique), so the endpoint is the same `/scim/v2` for every workspace. A SCIM user links the IdP account to a global `User` by email, and the membership is derived from it after every change: active → member with a role from the SCIM groups (through the SSO role mapping), inactive or deleted → no membership. The `ScimUser` row outlives deprovisioning on purpose: it is what stops a trusted-domain SSO login from silently re-adding someone the IdP removed. Session revocation happens after the tenant transaction, through the system client, because sessions are not tenant data.

### Organizations

Organizations are system tables (no tenant RLS): they sit above workspace isolation, so organization routes read with the system client and authorize against `OrganizationMember` themselves. Org-level events go to `OrganizationAuditEvent` (append-only for the app role); the org audit log merges it with the workspaces' `AuditEvent` rows by `(createdAt, id)`.

Org admins get `admin` in the org's workspaces inside `requireWorkspace`, so every workspace route applies to them unchanged. Org keys reuse the API key principal: `requireWorkspace` checks the workspace belongs to the key's organization (and scope) and binds it as the key's workspace for that request, so module scoping, audit and held-back approvals work as for workspace keys (approved requests re-resolve org keys by id).

Organization SSO (ORG-05) is resolved per workspace by `effectiveSso`: the workspace's own OIDC/SAML if it has one, else its organization's, else none; `requireWorkspace` uses the result for both the session scope of an org-SSO session and forced SSO. Provider ids carry the subject (`oidc:`/`saml:` for workspaces, `org-oidc:`/`org-saml:` for organizations), so sessions, refresh-time IdP checks and revocation work the same for both. `syncOrgMember` is the one place group rules become access, called from SSO sign-in (groups from the assertion) and org SCIM (groups from SCIM); it runs with the system client because it spans the organization's workspaces. The SCIM routes are one implementation over a context (`workspaceScim` / `orgScim`) that scopes rows, runs the transaction, syncs users and records audit events.

Shared modules cross tenants, so they are read with the system client outside the tenant transaction and passed to the manifest builder; every manifest path (route, snapshot, CDN publish) includes them. After a change in a workspace that shares modules, the other workspaces' environments of the same name are invalidated and republished (no snapshot is written for them).

### Change approvals (APR-01..18)

A held-back change is stored as the API call itself, exactly like a scheduled operation, and executed the same way: in-process through the original route, as the requester, marked with an internal-only header (honoured only for requests authenticated by the per-process secret) that skips the approval check and carries the approval chain into the change's audit metadata. Because execution goes through the route, ownership, freezes, the dependency gate and validation all apply at execution time, not just at request time. Completing the approval count claims the request with a conditional `pending_approval → executing` update, so concurrent approvals run it once. The executed deploy's version id is kept on the request (`resultVersionId`) to show the approval chain in the version history.

### Freezes (ENV-FRZ-03/04)

A freeze has an optional start (`freezeFrom`) and end; `isFrozen` evaluates the window at check time, so no job is needed to start or end one. Owners override in two ways: per request with the `X-Harmoniq-Freeze-Override` header (sessions only), or by opening a time-boxed window (`POST …/freeze/override`, at most 4 hours) during which changes from any authorized caller pass. That second form is the practical one for a CI hotfix, since API keys can never override. Every change made in a window records `freezeOverride` (reason, owner, end) in its audit event.

### Module ownership (RBAC)

One check, `canWriteModule`, guards every module-changing route (deploy, upload URL, rollback, promote, canary, kill switch) and the scheduling of such operations: workspace admins and owners always pass; API keys within their `moduleIds`; developers when the module has no owners or they own it. A refusal is a `403` plus a `module.unauthorized_attempt` audit event written in its own transaction (the request's own transaction rolls back with the error). Module detail responses carry `owners` and `canWrite` so the dashboard only offers what the registry would accept. Scheduled operations run as their creator, so ownership is checked again when they run.

### §16.1 Change Approval Workflows

- Approval policy configuration per environment (required approvers, eligible roles, expiry window)
- Deployment request lifecycle: `pending → approved/rejected → executed`
- Self-approval prevention enforced at the application layer
- Emergency bypass with mandatory written justification + `⚠️ BYPASSED` audit flag
- Change ticket integration (Jira, ServiceNow URL pattern)
- Pending Approvals dashboard queue per user; full approval chain in deployment history

### §16.2 Organization Hierarchy

- `Organization` top-level container (`Organization → [Workspaces]`)
- `Workspace.organizationId` nullable FK — standalone workspaces fully unaffected
- Org-level SAML 2.0 and OIDC (configure once, all child workspaces inherit)
- Org-level SCIM 2.0 with group-rule auto-assignment to workspaces
- Cross-workspace audit log at `GET /api/orgs/:orgSlug/audit`
- Org-shared module publishing + Org Module Catalog
- Org-level API keys scoped to specific workspaces/modules

### §16.3 GitOps / IaC

- Terraform provider `harmoniq-dev/harmoniq` — 9 resources, 3 data sources
- GitHub Actions composite action `harmoniq-dev/deploy-action@v1`
- `harmoniq.yaml` declarative workspace state file
- `harmoniq plan` / `harmoniq apply` / `harmoniq import` CLI commands
- GitLab CI component

### New DB Tables

| Table                | Notes                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `Organization`       | Root entity, NOT RLS-scoped (above workspace isolation)                 |
| `OrganizationMember` | User ↔ org with `org_admin \| org_member` roles                         |
| `OrgApiKey`          | Org-scoped API keys with workspace/module scope arrays                  |
| `ApprovalPolicy`     | Per-environment approval rules (unique per workspaceId + environmentId) |
| `DeploymentRequest`  | pending/executed/rejected/expired/bypassed deploy requests              |
| `DeploymentApproval` | Individual approver decisions (unique per request + approver)           |

**Column addition:** `Workspace.organizationId` (nullable FK, ORG-03)

See [`docs/database-schema.md`](../database-schema.md) for full schema.

## Breaking Changes

None. `Workspace.organizationId` is nullable — all existing standalone workspaces remain fully functional with no migration required.

---

## Change History

### 2026-10-09 — Organization SSO and SCIM (M4.7b)

**Type:** Feature
**Author:** Shashi Kumar Dhandapani
**Refs:** ORG-05, ORG-06, ORG-07

**Summary:**

- Organizations configure OIDC and SAML once (`/api/orgs/:org/sso/oidc|saml`, providers `org-oidc:<org>` / `org-saml:<org>`); workspaces without their own SSO inherit it, including forced SSO. A workspace's own SSO overrides the organization's.
- ORG-06: the organization's SAML service provider at `/auth/org-saml/:org/{metadata,acs,login,logout,slo}` (a separate prefix, so organization and workspace slugs never clash).
- ORG-07: group rules (`rules: [{ group, workspace, role }]`, `adminGroups`) turn IdP groups (from SCIM or the SSO assertion) into organization admins and workspace roles. Memberships the rules grant (`WorkspaceMember.orgProvisioned`) follow them; invited memberships are left alone. Org admins are never demoted by the IdP.
- Org SCIM at `/scim/v2/orgs/:org`, sharing the SCIM implementation with workspaces (SCIM rows now belong to a workspace or an organization). Deprovisioning removes the user from the organization and its workspaces, revokes their keys there and ends their org-SSO sessions; the last org admin and each workspace's last owner are kept. While org SCIM is on, SSO sign-in doesn't change access.
- Org-SSO sessions reach their organization and its inheriting workspaces only (`SSO_SCOPED` elsewhere); `/api/me` is limited accordingly. SSO discovery falls back to organizations.
- Dashboard: Organization → Single sign-on (inheritance per workspace, OIDC and SAML forms shared with workspace settings) and Provisioning (group rules, SCIM token and requests).
- Migration `20261009160000_org_sso_scim`.

**Tests:** `orgSso.test.ts`: org OIDC config and rules (org admins only, rules limited to the org's workspaces), discovery, provisioning from SSO groups (most permissive rule, role and membership follow groups, admin groups promote and never demote, untrusted users don't join), session scope (inheriting workspaces only, not overriding or outside ones; org routes; `/api/me`), forced org SSO (owners exempt, overriding workspaces unaffected), org SAML (metadata, SP-initiated sign-in, Test Connection URL), org SCIM (token per org path, provisioning by rules including group renames, SSO doesn't change access under SCIM, rows invisible to tenants, deprovisioning of memberships, keys and sessions with SSO refused, last org admin kept, disabling). The OIDC and SAML mock IdPs moved to test helpers.

### 2026-10-09 — Workspace pages under `/w` (ORG-15)

**Type:** Change
**Author:** Shashi Kumar Dhandapani
**Refs:** ORG-15

**Summary:**

- Dashboard workspace pages moved from `/:workspaceSlug` to `/w/:workspaceSlug`, so workspace slugs never clash with dashboard paths (`/orgs`, `/admin`, `/auth`, `/docs`). The reserved-slug list is gone.
- Old `/:workspaceSlug/…` URLs redirect permanently to `/w/:workspaceSlug/…`, query string included.
- The SAML Test Connection result URL points at `/w/:workspaceSlug/settings/sso`.

### 2026-10-09 — Organizations (M4.7)

**Type:** Feature
**Author:** Shashi Kumar Dhandapani
**Refs:** ORG-01 – ORG-04, ORG-08 – ORG-15

**Summary:**

- `/api/orgs`: create, members (`org_admin` / `org_member`, last admin protected), workspaces (create inside, attach, detach, delete with confirmation), cross-workspace audit with filters and keyset pagination, module catalog, org API keys scoped to workspaces and modules.
- Org admins administer the org's workspaces; org keys (`hq_org_…`) authenticate in the org's workspaces.
- Org-shared modules in sibling manifests (`shared`, `ownerWorkspace`), refreshed when the owner changes them; workspace owners share from the module page.
- Dashboard: organizations on the home page, `/orgs/:orgSlug` (overview, catalog, audit, members, keys). Workspace pages moved to `/w/:workspaceSlug`, so no workspace slug clashes with a dashboard path; old `/:workspaceSlug/…` links redirect.

**Tests:**

`orgs.test.ts`: creation, attach rules, `/api/me`, org admin vs member access, last admin, shared modules across manifests (updates, unshare, owner precedence, outside the org), catalog, org keys (scopes, workspace limits, revocation), org audit (filters, pagination matches the full list), detach and delete. Dashboard pages rendered against a dev registry, including an org admin opening a workspace without a membership.

### 2026-10-09 — SCIM provisioning (M4.6)

**Type:** Feature
**Author:** Shashi Kumar Dhandapani
**Refs:** SSO-24, SSO-25, SSO-28

**Summary:**

- `/scim/v2` Users and Groups (filters, paging, PATCH in Okta and Entra ID shapes) with a per-workspace bearer token, rotated from Settings → Provisioning.
- Memberships follow SCIM users; group → role mapping shared with SSO; deprovisioning removes the membership, the user's API keys in the workspace and their workspace SSO sessions, and blocks SSO re-entry. Last owner protected.
- Audit events for provisioning, deprovisioning and role sync; `ScimAuditEvent` per SCIM write.

**Tests:**

`scim.test.ts`: token issue/rotation/disable, SCIM errors, provisioning and filters, groups → roles through Okta and Entra ID PATCH shapes, deactivate/reactivate/delete/re-create with keys and sessions revoked and SSO refused, last owner, tenant isolation.

### 2026-10-09 — SAML 2.0 single sign-on (M4.5)

**Type:** Feature
**Author:** Shashi Kumar Dhandapani
**Refs:** SSO-09 – SSO-20

**Summary:**

- SAML service provider per workspace: metadata, ACS, SP-initiated login with signed AuthnRequests, IdP-initiated login (opt-in), single logout; SP keypair generated and sealed; IdP metadata import; test connection that shows the assertion without signing in.
- Same provisioning as OIDC (JIT, trusted domains, group → role mapping, forced SSO); SSO discovery returns SAML when only SAML trusts the domain.
- Workspace-IdP sessions are scoped to their workspace (`403 SSO_SCOPED`).
- Dashboard: SAML section in Settings → Single sign-on with the SP details, Okta / Entra ID / ADFS notes, metadata paste, test results; `/api/auth/saml/idp` for IdP-initiated sign-ins.

**Tests:**

`saml.test.ts` signs responses with `xml-crypto` and a generated IdP certificate: metadata import and SP metadata, SP-initiated sign-in with the PKCE-bound code (wrong verifier, reuse), tampered / unsolicited / wrong-audience responses, IdP-initiated opt-in, test connection, and session scoping.

### 2026-10-09 — OIDC single sign-on (M4.4)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** SSO-01 – SSO-08, SSO-21 – SSO-23, SSO-26 – SSO-28

#### What changed

- `OidcIdentityProvider` (discovery cache, PKCE + nonce, `jose` ID-token validation, userinfo fallback, refresh check); per-workspace config API with the secret sealed; instance-wide provider from env vars; SSO discovery by email domain.
- JIT users, trusted-domain auto-join, group → role mapping resynced at login, `auth.sso_login` audit; forced SSO (owners exempt); IdP refresh token re-checked hourly to end sessions the IdP ended.
- Dashboard: "Sign in with SSO" on the login page (replacing the disabled SAML button), Settings → Single sign-on.

#### Testing

`oidc.test.ts` runs against an in-process OIDC provider (RS256 JWKS, PKCE-checking token endpoint, refresh): config validation and secret handling, discovery, login with JIT and group mapping, resync, trusted-domain default and owner protection, PKCE and nonce tampering, forced SSO, IdP session end. In headless Chrome with a standalone mock IdP: the owner configured SSO in Settings and a new user signed in through “Sign in with SSO”, landing in the workspace as admin via group mapping.

### 2026-10-09 — Change approvals (M4.3)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** APR-01 – APR-18

#### What changed

- Approval policies per environment; deploys, rollbacks, promotes and canary changes into them return `202` with a request; approve (eligible roles, not the requester, users only), reject (one is enough), owner emergency bypass; atomic execution as the requester; expiry job; change tickets; webhooks; approval chain on versions and audit events.
- CLI: exit code 6 for pending, global `--wait` and `--change-ticket`. Build plugin: reports `pendingApproval`, sends the change ticket.
- Dashboard: Approvals queue (approve with comment, reject, bypass), Settings → Approval rules, approval/BYPASSED marks in version history, audit lines.

#### Testing

`approvals.test.ts` (7 cases: policies, pending with webhook and ticket, eligibility and two-approver execution with the chain on the version and audit event, self-approval and rejection, bypass, expiry, other operations, dry runs and the kill switch exempt, policy removal); CLI and build-plugin tests. End to end in headless Chrome: rules set in the UI, a CLI deploy pending (exit 6), approvals by two users applying it, an owner bypass flagged in history.

### 2026-10-09 — Freeze windows and owner overrides (M4.2)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** ENV-FRZ-03, ENV-FRZ-04

#### What changed

- `freeze` accepts `from` (scheduled windows); environments show `scheduledFreeze`.
- Owner overrides: the `X-Harmoniq-Freeze-Override` header, and time-boxed override windows (`POST/DELETE …/freeze/override`) that let CI hotfixes through; audited as `env.freeze_override`, with the override recorded on each change.
- Dashboard: "from" on the freeze form, scheduled-freeze and override notices, owner controls; audit lines.

#### Testing

`freezeWindows.test.ts`: window evaluation, a scheduled freeze that only blocks once started, header override limited to owners with a reason, an override window letting an API-key deploy through with the override in its audit, closing it, unfreezing clearing everything. Checked in headless Chrome.

### 2026-10-09 — Module ownership (M4.1)

**Type:** feature
**PR / Branch:** feat/m4-enterprise
**Refs:** RBAC-01 – RBAC-06

#### What changed

- `GET/PUT /api/workspaces/:ws/modules/:ref/owners` (admin to change); module writes restricted to owners and admins when a module has owners; refusals audited as `module.unauthorized_attempt`; `owners` and `canWrite` on module detail.
- Dashboard: Module owners section (admins edit), actions shown according to `canWrite`; audit lines.

#### Testing

`moduleRbac.test.ts`: ownerless modules open to developers, admin-only owner changes, owners/admins/other developers on deploy, rollback, kill switch and scheduling, audited refusals, API-key scopes and `canWrite`. Checked in headless Chrome with an admin, an owner and a non-owner developer.

### 2026-09-13 — Implemented Phase 8 database models and Zod schemas

**Type:** `feat`
**Refs:** `ORG-03`, `APR-01`

#### What changed

- Added `Organization`, `OrganizationMember`, `OrgApiKey`, `ApprovalPolicy`, `DeploymentRequest`, `DeploymentApproval`, `InstanceConfig`, `InstanceAdmin`, and `WorkspaceStorageConfig` models to `schema.prisma`.
- Added `organizationId` foreign key to `Workspace` model.
- Created Zod schemas for the new Phase 8 operations (`ApprovalPolicySchema`, `CreateOrganizationSchema`, etc.).
- Wrote unit tests for new Zod schemas.
- Generated and applied Prisma migration `phase8`.
- Reconfigured RLS (Row Level Security) and seeding script for `WorkspaceMember`.

#### Why

Executing Phase 1 of the implementation plan, bringing the DB schema up to parity with all phases including the newly planned Phase 8 Enterprise Governance.

#### Testing

Zod schema unit tests passed. Database migration reset and seed script succeeded.

### 2026-09-13 — Requirements, DB schema, and implementation plan added (Phase 8)

**Type:** `docs`  
**Refs:** `APR-01`–`APR-18`, `ORG-01`–`ORG-15`, `IaC-01`–`IaC-14`

#### What changed

- Added **§16 Enterprise-Grade Governance** (47 requirements) to `docs/requirements.md`
- Added 5 new DB tables and `Workspace.organizationId` column to `docs/database-schema.md`
- Added **Phase 8** to `docs/implementation-plan.md` with three sub-sections (approval workflows, org hierarchy, GitOps), each with DB, registry endpoint, dashboard, and test suite tasks
- Phase 1 DB checklist updated with 5 new models
- Milestone timeline updated: 17 weeks → 20 weeks

#### Why

Gap analysis identified these three features as procurement blockers for regulated industries and large enterprise customers.

#### Testing

Documentation only. All implementing PRs MUST include test suites as documented in the Phase 8 test suite checklists and per AGENTS.md §5.
