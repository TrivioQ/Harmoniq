import { authedFetch } from './registry';

export type OrgRole = 'org_admin' | 'org_member';

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
  keys: (slug: string) => authedFetch<{ keys: OrgKey[] }>(`${org(slug)}/keys`),
};
