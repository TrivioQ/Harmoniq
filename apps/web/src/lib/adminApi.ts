import { authedFetch } from './registry';

export interface Check {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** INST-08. */
export interface AdminHealth {
  status: 'ok' | 'degraded';
  checks: {
    database: Check;
    cache: Check & { adapter: string };
    storage: Check & { adapter: string };
    queue: {
      ok: boolean;
      running: boolean;
      queued: number;
      active: number;
      queues: Array<{ name: string; queued: number; active: number }>;
      error?: string;
    };
  };
  stats: { workspaces: number; modules: number; users: number };
}

export interface AdminWorkspace {
  id: string;
  slug: string;
  name: string;
  organization: string | null;
  modules: number;
  members: number;
  deploys: number;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  isInstanceAdmin: boolean;
  activeSessions: number;
  workspaces: Array<{ slug: string; role: string }>;
}

export interface InstanceAdminEntry {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
  grantedBy: string;
  since: string;
}

export interface InstanceAuditEvent {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const query = (params: Record<string, string | undefined>) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1])
  );
  return qs.size ? `?${qs}` : '';
};

/** INST-05..10, 18: the admin panel reads through the registry's admin API. */
export const adminApi = {
  health: () => authedFetch<AdminHealth>('/api/admin/health'),
  workspaces: (params: { query?: string; cursor?: string }) =>
    authedFetch<{ workspaces: AdminWorkspace[]; nextCursor: string | null }>(
      `/api/admin/workspaces${query(params)}`
    ),
  users: (params: { query?: string; cursor?: string }) =>
    authedFetch<{ users: AdminUser[]; nextCursor: string | null }>(
      `/api/admin/users${query(params)}`
    ),
  admins: () => authedFetch<{ admins: InstanceAdminEntry[] }>('/api/admin/admins'),
  audit: (params: { cursor?: string }) =>
    authedFetch<{ events: InstanceAuditEvent[]; nextCursor: string | null }>(
      `/api/admin/audit${query(params)}`
    ),
};
