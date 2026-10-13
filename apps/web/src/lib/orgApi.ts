// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import type { PlanLimits, UsageTotals, WorkspaceUsage } from './usage';
import { RegistryError, authedFetch as registryAuthedFetch } from './registry';
import type {
  OidcSettings,
  SamlSettingsResponse,
  SamlTestResult,
  ScimEvent,
  ScimSettings,
} from './workspaceApi';

/** PPL-08: org_billing and org_auditor are read-only roles. */
export type OrgRole = 'org_admin' | 'org_member' | 'org_billing' | 'org_auditor';

export interface OrgHome {
  slug: string;
  name: string;
  plan: string;
  role: OrgRole | null;
  /** TLC-04: suspended by the instance admin (read-only). */
  suspended?: boolean;
  /** INST-20: instance admins with read-only support access right now. */
  supportAccess?: Array<{ id: string; admin: string; reason: string; expiresAt: string }>;
  /** TAD-06: workspaces matching the search, and the cursor of the next page. */
  total?: number;
  nextCursor?: string | null;
  workspaces: Array<{
    id?: string;
    slug: string;
    name: string;
    members: number;
    modules: number;
    lastDeployAt: string | null;
    /** TLC-02: deleted, restorable until `purgeAfter`. */
    deletedAt?: string | null;
    purgeAfter?: string | null;
    /** PPL-07: your role there (org admins: admin), and whether you asked to join. */
    yourRole?: string | null;
    accessRequested?: boolean;
    /** TAD-06: INST-09 suspension, environments frozen now (`host/env`), approvals waiting. */
    suspended?: boolean;
    frozenEnvironments?: string[];
    pendingApprovals?: number;
    health: { samples: number; errorRate: number } | null;
  }>;
  /** TAD-06: the latest deployment requests waiting for approval, across the organization. */
  pendingApprovals?: Array<{
    id: string;
    workspace: string;
    type: string;
    requiredApprovers: number;
    expiresAt: string;
    createdAt: string;
  }>;
  recentDeploys: Array<{
    workspace: string;
    module: string;
    environment: string;
    version: string;
    status: string;
    deployedAt: string;
    deployedBy: string;
  }>;
}

/** AUD-07: a readable actor: an email, a key's name and prefix, or `deleted user #…`. */
export interface AuditActor {
  type: 'user' | 'apiKey' | 'system';
  id: string;
  label: string;
  deleted: boolean;
}

export interface OrgAuditEvent {
  id: string;
  workspace: string | null;
  actorType: string;
  actorId: string;
  actor?: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CatalogModule {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  workspace: string;
  workspaceName: string;
  hostApp: string;
  shared: boolean;
  owners: string[];
  versions: Record<string, string>;
}

export interface OrgMember {
  id: string;
  role: OrgRole;
  createdAt: string;
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
}

export interface OrgKey {
  id: string;
  name: string;
  prefix: string;
  /** TAD-05: `rotating` keys work until `gracePeriodEnd`. */
  status?: 'active' | 'rotating' | 'expired' | 'revoked';
  gracePeriodEnd?: string | null;
  createdBy?: { id: string; email: string | null } | null;
  /** Not used for 90 days. */
  unused?: boolean;
  /** POL-03: how the key breaks the organization's key policy (it keeps working). */
  policyViolations?: string[];
  scopes: string[];
  workspaces: string[];
  moduleIds: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** ORG-05: which workspaces use the organization's SSO (`own`: they override it). */
export interface OrgSsoOverview {
  forceSso: boolean;
  trustedDomains: string[];
  workspaces: Array<{ slug: string; name: string; own: 'oidc' | 'saml' | null }>;
}

/** ORG-07: IdP groups → workspace roles; admin groups → org admins. */
export interface OrgProvisioning {
  rules: Array<{ group: string; workspace: string; role: 'viewer' | 'developer' | 'admin' }>;
  adminGroups: string[];
}

/** PPL-03: someone with access to the organization or its workspaces. */
export interface OrgPerson {
  user: { id: string; email: string; name: string | null; lastLoginAt: string | null };
  orgRole: OrgRole | null;
  workspaces: Array<{ slug: string; role: string; source: 'member' | 'org_rules' }>;
  implicitAdmin: boolean;
  scim: { active: boolean } | null;
  apiKeys: number;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  workspace?: string | null;
}

/** POL-02: an approval rule, and the environments (slug pattern) it applies to. */
export interface ApprovalDefault {
  environmentPattern: string;
  requiredApprovers: number;
  eligibleRoles: string[];
  requireChangeTicket: boolean;
  ticketUrlPattern: string | null;
  expiryHours: number;
}

/** POL-05: an org-wide freeze; `override` while an org admin lets changes through. */
export interface OrgFreezeWindow {
  id: string;
  environmentPattern: string;
  from: string | null;
  until: string | null;
  reason: string;
  override: { until: string; reason: string; by: string } | null;
}

/** POL-01..08 */
export interface OrgPolicy {
  approvalDefaults: ApprovalDefault[];
  maxApiKeyDays: number | null;
  allowedKeyScopes: string[];
  minRetentionDays: number | null;
  freezeWindows: OrgFreezeWindow[];
  lockSso: boolean;
  /** SES-03 */
  requireMfa: boolean;
  sessionMaxHours: number | null;
  idleTimeoutMinutes: number | null;
  ipAllowlist: string[];
  ipAllowlistManifests: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** TAD-10 */
export interface OrgWebhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  paused: boolean;
  lastDelivery: { success: boolean; statusCode: number | null; createdAt: string } | null;
}

/** TAD-09 */
export interface NotificationChannelView {
  id: string;
  kind: 'email' | 'slack' | 'teams';
  name: string;
  target: string | null;
  events: string[];
  active: boolean;
  lastSentAt: string | null;
  lastError: string | null;
}

/** AUD-06 */
export interface AuditSinkView {
  id: string;
  kind: 'https' | 's3';
  name: string;
  enabled: boolean;
  target: string;
  cursorAt: string | null;
  lastDeliveredAt: string | null;
  failures: number;
  lastError: string | null;
  deadLetters: number;
}

/** AUD-09: one audit chain's check. */
export interface ChainReport {
  ok: boolean;
  rows: number;
  head: { chainSeq: string; hash: string } | null;
  problem: { chainSeq: string; id: string; kind: string } | null;
}

export interface CatalogQuery {
  query?: string;
  workspace?: string;
  environment?: string;
  shared?: string;
  cursor?: string;
  limit?: string;
}

/**
 * Pages a role can't use (e.g. API keys for an org member) are not found, as the registry
 * refuses them: a 404 page rather than an error. Server components only.
 */
async function authedFetch<T>(path: string): Promise<T> {
  try {
    return await registryAuthedFetch<T>(path);
  } catch (err) {
    if (err instanceof RegistryError && err.status === 403) notFound();
    throw err;
  }
}

const enc = encodeURIComponent;
const org = (slug: string) => `/api/orgs/${enc(slug)}`;
/** Query string of the set values only. */
const params = (query: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1]));

/** ORG-14/15: the organization pages read through the registry, like everything else. */
export const orgApi = {
  home: (slug: string, query: { query?: string; cursor?: string; limit?: string } = {}) =>
    authedFetch<OrgHome>(`${org(slug)}?${params(query)}`),
  audit: (slug: string, query: Record<string, string | undefined>) =>
    authedFetch<{ events: OrgAuditEvent[]; nextCursor: string | null }>(
      `${org(slug)}/audit?${params(query)}`
    ),
  catalog: (slug: string, query: CatalogQuery = {}) =>
    authedFetch<{ modules: CatalogModule[]; total?: number; nextCursor?: string | null }>(
      `${org(slug)}/modules?${params({ ...query })}`
    ),
  /** TAD-07: the workspaces whose manifests load a shared module. */
  consumers: (slug: string, moduleId: string) =>
    authedFetch<{
      id: string;
      shared: boolean;
      consumers: Array<{ workspace: string; environments: string[] }>;
    }>(`${org(slug)}/modules/${enc(moduleId)}/consumers`),
  members: (slug: string) => authedFetch<{ members: OrgMember[] }>(`${org(slug)}/members`),
  people: (slug: string, query: { query?: string; cursor?: string }) =>
    authedFetch<{
      people: OrgPerson[];
      nextCursor: string | null;
      invitations: OrgInvitation[];
    }>(`${org(slug)}/people?${params(query)}`),
  policy: (slug: string) => authedFetch<OrgPolicy>(`${org(slug)}/policy`),
  /** USG-03, TAD-02 */
  usage: (slug: string, days: number) =>
    authedFetch<{
      days: number;
      plan: string;
      planExpiresAt: string | null;
      limits: Pick<PlanLimits, 'workspaces'>;
      totals: UsageTotals;
      workspaces: WorkspaceUsage[];
    }>(`${org(slug)}/usage?days=${days}`),
  webhooks: (slug: string) => authedFetch<{ endpoints: OrgWebhook[] }>(`${org(slug)}/webhooks`),
  notifications: (slug: string) =>
    authedFetch<{ channels: NotificationChannelView[] }>(`${org(slug)}/notifications`),
  auditSinks: (slug: string) => authedFetch<{ sinks: AuditSinkView[] }>(`${org(slug)}/audit-sinks`),
  verifyAudit: (slug: string) =>
    authedFetch<{
      ok: boolean;
      organization: ChainReport;
      workspaces: Array<ChainReport & { slug: string }>;
    }>(`${org(slug)}/audit/verify`),
  keys: (slug: string) => authedFetch<{ keys: OrgKey[] }>(`${org(slug)}/keys`),
  sso: (slug: string) => authedFetch<OrgSsoOverview>(`${org(slug)}/sso`),
  oidc: (slug: string) => authedFetch<{ oidc: OidcSettings | null }>(`${org(slug)}/sso/oidc`),
  saml: (slug: string) => authedFetch<SamlSettingsResponse>(`${org(slug)}/sso/saml`),
  samlTest: (slug: string, id: string) =>
    authedFetch<SamlTestResult>(`${org(slug)}/sso/saml/test/${enc(id)}`),
  provisioning: (slug: string) => authedFetch<OrgProvisioning>(`${org(slug)}/provisioning`),
  scim: (slug: string) => authedFetch<ScimSettings>(`${org(slug)}/scim`),
  scimEvents: (slug: string) =>
    authedFetch<{ events: ScimEvent[] }>(`${org(slug)}/scim/events?limit=50`),
};
