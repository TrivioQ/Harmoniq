// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { authedFetch } from './registry';
import type { UsageTotals, WorkspaceUsage } from './usage';
import type { ChainReport } from './orgApi';

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
  plan: 'hobby' | 'startup' | 'enterprise';
  organizationPlan: string | null;
  modules: number;
  members: number;
  deploys: number;
  /** INST-09, USG-02: bundle bytes of the versions kept. */
  storageBytes?: number;
  /** PLN-06: a trial's end, and per-workspace exceptions. */
  planExpiresAt?: string | null;
  planOverrides?: Record<string, unknown> | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  /** TLC-02: deleted, restorable until `purgeAfter`. */
  deletedAt: string | null;
  purgeAfter: string | null;
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
  /** SES-03/04 */
  mfaEnabled?: boolean;
  suspendedAt?: string | null;
  suspendedReason?: string | null;
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
  /** AUD-07: email, key name and prefix, or `deleted user #…`. */
  actor?: { type: string; id: string; label: string; deleted: boolean };
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** INST-11..16: a setting from the database (or the environment's defaults); secrets masked. */
export interface SettingView<T = Record<string, unknown>> {
  source: 'database' | 'environment';
  value: T;
}

export interface InstanceSettingsView {
  storage: SettingView<{
    adapter: 'none' | 'local' | 's3' | 'gcs' | 'azure';
    container?: string;
    connectionString?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    projectId?: string;
    clientEmail?: string;
    privateKey?: string;
    publicUrl?: string;
  }>;
  email: SettingView<{
    host?: string;
    port?: number;
    security?: 'tls' | 'starttls' | 'none';
    username?: string;
    password?: string;
    from?: string;
    smtpUrl?: string;
  }>;
  auth: SettingView<{
    email?: { enabled: boolean };
    github?: { enabled: boolean; clientId?: string; clientSecret?: string };
    oidc?: { enabled: boolean };
    saml?: { enabled: boolean };
    /** SES-01 */
    session?: { maxDays: number; idleMinutes: number | null };
  }> & {
    /** Switches HARMONIQ_AUTH_METHODS keeps off; the panel can't turn them on. */
    locked: Array<'email' | 'github' | 'oidc' | 'saml'>;
    allowedMethods: string[];
    methodsFromEnvironment: boolean;
  };
  branding: SettingView<{
    name: string;
    logoUrl?: string;
    supportUrl?: string;
    accentColor?: string;
  }>;
  /** TLC-08: who may create organizations and standalone workspaces. */
  tenancy?: SettingView<{
    creation?: 'anyone' | 'verified_domains' | 'instance_admins';
    allowedDomains?: string[];
  }>;
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
  settings: () => authedFetch<InstanceSettingsView>('/api/admin/settings'),
  workspaces: (params: { query?: string; cursor?: string }) =>
    authedFetch<{ workspaces: AdminWorkspace[]; nextCursor: string | null }>(
      `/api/admin/workspaces${query(params)}`
    ),
  users: (params: { query?: string; cursor?: string }) =>
    authedFetch<{ users: AdminUser[]; nextCursor: string | null }>(
      `/api/admin/users${query(params)}`
    ),
  admins: () => authedFetch<{ admins: InstanceAdminEntry[] }>('/api/admin/admins'),
  orgs: () =>
    authedFetch<{
      organizations: Array<{
        slug: string;
        name: string;
        plan: 'hobby' | 'startup' | 'enterprise';
        /** PLN-06 */
        planExpiresAt?: string | null;
        basePlan?: string | null;
        planOverrides?: Record<string, unknown> | null;
        workspaces: number;
        members: number;
        suspendedAt: string | null;
        suspendedReason: string | null;
        deletedAt: string | null;
        purgeAfter: string | null;
      }>;
    }>('/api/admin/orgs'),
  /** AUD-09 */
  verifyAudit: () => authedFetch<ChainReport>('/api/admin/audit/verify'),
  /** USG-03: every live workspace's usage, a page at a time. */
  usage: (params: { days?: string; cursor?: string }) =>
    authedFetch<{
      days: number;
      totals: UsageTotals;
      workspaces: WorkspaceUsage[];
      nextCursor: string | null;
    }>(`/api/admin/usage${query(params)}`),
  audit: (params: {
    cursor?: string;
    actor?: string;
    action?: string;
    resourceId?: string;
    from?: string;
    to?: string;
  }) =>
    authedFetch<{ events: InstanceAuditEvent[]; nextCursor: string | null }>(
      `/api/admin/audit${query(params)}`
    ),
};
