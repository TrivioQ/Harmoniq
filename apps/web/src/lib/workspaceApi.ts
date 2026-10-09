import type { Manifest } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { authedFetch } from './registry';

// Typed reads for dashboard pages. Shapes mirror the registry responses
// (docs/api-reference.md); every call runs as the signed-in user.

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export interface EnvironmentSummary {
  slug: string;
  name: string;
  isDefault: boolean;
  frozen: boolean;
  freezeReason: string | null;
  freezeUntil: string | null;
  frozenBy: string | null;
  ephemeral: boolean;
  expiresAt: string | null;
  /** Published (CDN) copy; null when no storage is configured. */
  published: {
    manifestUrl: string | null;
    importMapUrl: string | null;
    etag: string | null;
    at: string | null;
    error: string | null;
  } | null;
}

export interface WorkspaceDetail {
  slug: string;
  name: string;
  retentionDays: number;
  role: Role | null;
  hostApps: Array<{
    slug: string;
    name: string;
    description: string | null;
    isDefault: boolean;
    moduleCount: number;
    environments: EnvironmentSummary[];
  }>;
}

export interface Version {
  id: string;
  environment?: string;
  version: string;
  url: string;
  integrity: string;
  status: 'active' | 'inactive' | 'canary' | 'orphaned';
  deployedBy: string;
  deployedByType: 'user' | 'apiKey';
  deployedAt: string;
  commitSha: string | null;
  promotedFromEnv: string | null;
}

export interface ModuleSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  hostApp: { slug: string; name: string };
  environments: Array<{ slug: string; name: string; frozen: boolean; active: Version | null }>;
}

export interface ModuleDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  hostApp: { slug: string; name: string };
  environments: Array<{
    id: string;
    slug: string;
    name: string;
    frozen: boolean;
    freezeReason: string | null;
  }>;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorId: string;
  actorType: 'user' | 'apiKey';
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  etag: string;
  createdAt: string;
  cause?: { action: string; actorId: string; metadata: Record<string, unknown> | null };
}

export interface ManifestDiffResult {
  added: Manifest['modules'];
  removed: Manifest['modules'];
  changed: Array<{
    name: string;
    from: Manifest['modules'][number];
    to: Manifest['modules'][number];
    fields: string[];
  }>;
}

export interface ApiKeySummary {
  id: string;
  status: 'active' | 'rotating' | 'expired' | 'revoked';
  name: string;
  prefix: string;
  scopes: string[];
  moduleIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  gracePeriodEnd: string | null;
}

export interface Member {
  id: string;
  role: Role;
  status: 'active' | 'invited';
  user: { id: string; email: string; name: string | null };
}

export interface WebhookEndpointSummary {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  paused: boolean;
}

export interface DeadLetter {
  id: string;
  event: string;
  finalStatusCode: number | null;
  totalAttempts: number;
  exhaustedAt: string;
  webhookEndpointId: string;
}

const enc = encodeURIComponent;
const ws = (slug: string) => `/api/workspaces/${enc(slug)}`;

export const workspaceApi = {
  get: (slug: string) => authedFetch<WorkspaceDetail>(ws(slug)),
  modules: (slug: string) => authedFetch<{ modules: ModuleSummary[] }>(`${ws(slug)}/modules`),
  module: (slug: string, ref: string) =>
    authedFetch<ModuleDetail>(`${ws(slug)}/modules/${enc(ref)}`),
  versions: (slug: string, ref: string, env: string) =>
    authedFetch<{ versions: Version[] }>(
      `${ws(slug)}/modules/${enc(ref)}/versions?environment=${enc(env)}&limit=50`
    ),
  audit: (slug: string, params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]
    );
    return authedFetch<{ events: AuditEvent[]; nextCursor: string | null }>(
      `${ws(slug)}/audit?${qs}`
    );
  },
  snapshots: (slug: string, host: string, env: string) =>
    authedFetch<{ snapshots: Snapshot[] }>(
      `/api/manifest/${enc(slug)}/${enc(host)}/${enc(env)}/snapshots?limit=50`
    ),
  diff: (slug: string, host: string, env: string, from: string, to: string) =>
    authedFetch<ManifestDiffResult>(
      `/api/manifest/${enc(slug)}/${enc(host)}/${enc(env)}/diff?from=${enc(from)}&to=${enc(to)}`
    ),
  apiKeys: (slug: string) => authedFetch<{ keys: ApiKeySummary[] }>(`${ws(slug)}/api-keys`),
  members: (slug: string) => authedFetch<{ members: Member[] }>(`${ws(slug)}/members`),
  webhooks: (slug: string) =>
    authedFetch<{ endpoints: WebhookEndpointSummary[] }>(`${ws(slug)}/webhooks`),
  deadLetters: (slug: string) =>
    authedFetch<{ deadLetters: DeadLetter[] }>(`${ws(slug)}/webhooks/dead-letters`),
};

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

/** UI hint only; the registry enforces permissions on every call. */
export const roleAtLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];
