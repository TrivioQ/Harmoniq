// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { authedFetch } from './registry';
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
  workspaces: Array<{
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
    health: { samples: number; errorRate: number } | null;
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

export interface OrgAuditEvent {
  id: string;
  workspace: string | null;
  actorType: string;
  actorId: string;
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

const enc = encodeURIComponent;
const org = (slug: string) => `/api/orgs/${enc(slug)}`;

/** ORG-14/15: the organization pages read through the registry, like everything else. */
export const orgApi = {
  home: (slug: string) => authedFetch<OrgHome>(org(slug)),
  audit: (slug: string, query: Record<string, string | undefined>) => {
    const params = new URLSearchParams(
      Object.entries(query).filter((e): e is [string, string] => !!e[1])
    );
    return authedFetch<{ events: OrgAuditEvent[]; nextCursor: string | null }>(
      `${org(slug)}/audit?${params}`
    );
  },
  catalog: (slug: string) => authedFetch<{ modules: CatalogModule[] }>(`${org(slug)}/modules`),
  members: (slug: string) => authedFetch<{ members: OrgMember[] }>(`${org(slug)}/members`),
  people: (slug: string, query: { query?: string; cursor?: string }) => {
    const params = new URLSearchParams(
      Object.entries(query).filter((e): e is [string, string] => !!e[1])
    );
    return authedFetch<{
      people: OrgPerson[];
      nextCursor: string | null;
      invitations: OrgInvitation[];
    }>(`${org(slug)}/people?${params}`);
  },
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
