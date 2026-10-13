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
  /** INST-21 */
  organizations?: Array<{ slug: string; role: string }>;
  /** SES-03/04 */
  mfaEnabled?: boolean;
  suspendedAt?: string | null;
  suspendedReason?: string | null;
}

export const ADMIN_ROLES = [
  'instance_owner',
  'instance_operator',
  'instance_support',
  'instance_billing',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface InstanceAdminEntry {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
  /** INST-31/32 */
  mfa?: boolean;
  role?: AdminRole;
  capabilities?: string[];
  grantedBy: string;
  since: string;
}

/** INST-31: an email invited to administer the instance, accepted at its next sign-in. */
export interface AdminInvitation {
  id: string;
  email: string;
  role: AdminRole;
  expiresAt: string;
  createdAt: string;
}

/** INST-33 */
export interface InstanceApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  scopes: Array<'instance:read' | 'instance:admin'>;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

/** INST-35: one saved version of a setting (secrets never shown). */
export interface SettingVersion {
  version: number;
  source: 'save' | 'restore' | 'import' | 'reset';
  createdAt: string;
  createdBy: string;
  value: Record<string, unknown>;
  changed: string[];
  secretsChanged: boolean;
}

/** INST-26: sealed values per encryption key. */
export interface EncryptionReport {
  active: string;
  keys: Array<{ id: string; label: string; active: boolean; values: number }>;
  legacy: number;
  unknownKeys: Array<{ id: string; values: number }>;
  stale: number;
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
  /** INST-34: plans, rate limits, retention and bundle validation. */
  plans?: SettingView;
  rateLimits?: SettingView;
  gc?: SettingView<{
    keepVersions?: number;
    defaultRetentionDays?: number;
    healthEventRetentionHours?: number;
    healthRollupRetentionDays?: number;
  }>;
  bundles?: SettingView<{ validate?: boolean }>;
  /** INST-22, INST-37, INST-38 */
  announcement?: SettingView<{
    message?: string;
    level?: 'info' | 'warning' | 'maintenance';
    startsAt?: string;
    endsAt?: string;
  }>;
  maintenance?: SettingView<{ from?: string; until?: string; message?: string }>;
  emailTemplates?: SettingView<Record<string, { subject?: string; intro?: string }>>;
}

export const SETTING_KEYS = [
  'storage',
  'email',
  'auth',
  'branding',
  'tenancy',
  'plans',
  'rateLimits',
  'gc',
  'bundles',
  'announcement',
  'maintenance',
  'emailTemplates',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings with a page of their own; the others are edited as JSON at /admin/settings/:key. */
export const SETTING_PAGES: Partial<Record<SettingKey, string>> = {
  storage: '/admin/storage',
  email: '/admin/email',
  auth: '/admin/auth',
  tenancy: '/admin/auth',
  branding: '/admin/branding',
  announcement: '/admin/announcements',
  maintenance: '/admin/announcements',
  emailTemplates: '/admin/email',
};

// ─── Phase 9.10: operations, tenants and security ───────────────────────────

/** INST-27 */
export interface AttentionItem {
  kind:
    | 'publish_failed'
    | 'webhook_dead_letters'
    | 'failed_jobs'
    | 'storage_unverified'
    | 'saml_certificate_expiring'
    | 'alert_rule_error'
    | 'quota_exceeded'
    | 'domain_failing';
  tenant: { type: 'workspace' | 'organization'; slug: string } | null;
  subject: string;
  detail: string | null;
  since: string | null;
}

export interface TrendDay {
  day: string;
  deploys: number;
  manifestRequests: number;
  activeUsers: number;
  newWorkspaces: number;
  newOrganizations: number;
}

export interface AuditActorLabel {
  type: string;
  id: string;
  label: string;
  deleted: boolean;
}

export interface TenantAuditEvent {
  id: string;
  action: string;
  actor: AuditActorLabel;
  resourceType: string;
  resourceId: string;
  metadata?: unknown;
  createdAt: string;
}

export interface AdminOverview {
  counts: { workspaces: number; organizations: number; users: number; modules: number };
  trends: TrendDay[];
  attention: AttentionItem[];
  recentAudit: TenantAuditEvent[];
}

/** INST-28 */
export interface SystemInfo {
  build: { version: string; commit: string | null; node: string; startedAt: string };
  replica: string;
  migrations: {
    applied: number;
    latest: string | null;
    pending: string[] | null;
    failed: string[];
  };
  replicas: Array<{
    id: string;
    hostname: string | null;
    version: string;
    commit: string | null;
    startedAt: string;
    lastSeenAt: string;
    uptimeSeconds: number;
    configAgeSeconds: number | null;
    live: boolean;
    self: boolean;
  }>;
}

export interface JobQueue {
  name: string;
  schedule: string | null;
  lastRun: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  failed: number;
  queued: number;
  active: number;
  runnable: boolean;
}

export interface FailedJob {
  id: string;
  queue: string;
  error: string | null;
  retries: number;
  createdAt: string;
  failedAt: string | null;
}

/** INST-20 */
export interface SupportAccess {
  id: string;
  admin: string;
  reason: string;
  scope: 'workspace' | 'organization';
  expiresAt: string;
}

export interface SupportGrantEntry {
  id: string;
  admin: string;
  adminUserId: string;
  workspace: string | null;
  organization: string | null;
  reason: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

/** INST-29 */
export interface AdminWorkspaceDetail {
  id: string;
  slug: string;
  name: string;
  organization: { slug: string; name: string } | null;
  createdAt: string;
  retentionDays: number;
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  plan: {
    plan: 'hobby' | 'startup' | 'enterprise';
    effective: string;
    expiresAt: string | null;
    basePlan: string | null;
    overrides: Record<string, unknown> | null;
    limits: Record<string, number | null>;
  };
  usage: WorkspaceUsage | null;
  members: Array<{
    userId: string;
    email: string;
    role: string;
    joinedAt: string | null;
    lastLoginAt: string | null;
  }>;
  hostApps: Array<{
    slug: string;
    name: string;
    environments: Array<{
      slug: string;
      name: string;
      lastPublishedAt: string | null;
      lastPublishError: string | null;
      frozen: boolean;
      ephemeral: boolean;
    }>;
  }>;
  apiKeys: { active: number; lastUsedAt: string | null };
  sso: {
    own: { oidc: boolean; saml: boolean };
    from: 'workspace' | 'organization' | null;
    forceSso: boolean;
    scim: boolean;
  };
  storage: {
    provider: string;
    bucket: string;
    region: string;
    lastVerifiedAt: string | null;
  } | null;
  supportAccess: SupportAccess[];
  recentAudit: TenantAuditEvent[];
}

/** INST-19 */
export interface AdminOrgSummary {
  slug: string;
  name: string;
  plan: 'hobby' | 'startup' | 'enterprise';
  planExpiresAt?: string | null;
  basePlan?: string | null;
  planOverrides?: Record<string, unknown> | null;
  workspaces: number;
  members: number;
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  createdAt?: string;
}

export interface AdminOrgDetail {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  plan: {
    plan: 'hobby' | 'startup' | 'enterprise';
    expiresAt: string | null;
    basePlan: string | null;
    overrides: Record<string, unknown> | null;
    limits: Record<string, number | null>;
  };
  usage: UsageTotals;
  members: Array<{ userId: string; email: string; role: string; lastLoginAt: string | null }>;
  workspaces: Array<{
    slug: string;
    name: string;
    members: number;
    modules: number;
    suspended: boolean;
    deletedAt: string | null;
  }>;
  sso: { oidc: boolean; saml: boolean; forceSso: boolean; scim: boolean };
  domains: Array<{
    domain: string;
    verifiedAt: string | null;
    lastCheckedAt: string | null;
    failingSince: string | null;
  }>;
  supportAccess: SupportAccess[];
  recentAudit: TenantAuditEvent[];
}

/** INST-30 */
export interface AdminUserDetail {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  pendingEmail: string | null;
  instanceAdmin: { role: string } | null;
  identities: Array<{
    provider: string;
    email: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  workspaces: Array<{
    slug: string;
    name: string;
    role: string;
    joinedAt: string | null;
    deleted: boolean;
  }>;
  organizations: Array<{ slug: string; name: string; role: string }>;
  sessions: Array<{
    id: string;
    provider: string | null;
    createdAt: string;
    lastActiveAt: string;
    expiresAt: string;
    ip: string | null;
    userAgent: string | null;
    mfa: boolean;
  }>;
  apiKeys: Array<{
    id: string;
    scope: 'workspace' | 'organization';
    tenant: string;
    name: string;
    prefix: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  activity: Array<{
    scope: 'workspace' | 'organization' | 'instance';
    tenant: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    createdAt: string;
  }>;
  signIns: Array<{
    method: string;
    success: boolean;
    reason: string | null;
    ip: string | null;
    createdAt: string;
  }>;
}

/** INST-36 */
export interface AuditSearchEvent extends TenantAuditEvent {
  scope: 'workspace' | 'organization' | 'instance';
  tenant: string | null;
  ip: string | null;
}

/** INST-39 */
export interface SecurityReport {
  days: number;
  signIns: { succeeded: number; failed: number };
  failedByIp: Array<{ ip: string | null; failures: number; lastAt: string | null }>;
  failedByEmail: Array<{ email: string | null; failures: number; lastAt: string | null }>;
  recentFailures: Array<{
    email: string | null;
    method: string;
    reason: string | null;
    ip: string | null;
    createdAt: string;
  }>;
  rejectedKeys: Array<{
    prefix: string | null;
    reason: string | null;
    attempts: number;
    lastAt: string | null;
  }>;
  rateLimitedWorkspaces: Array<{ workspace: string; requests: number }>;
  scimErrors: Array<{
    tenant: { type: string; slug: string | null };
    operation: string;
    statusCode: number;
    createdAt: string;
  }>;
}

/** INST-38 */
export interface EmailDeliveryEntry {
  id: string;
  to: string;
  template: string;
  status: 'sent' | 'failed';
  error: string | null;
  createdAt: string;
}

export const EMAIL_TEMPLATES = [
  'sign_in',
  'invitation',
  'notification',
  'email_change',
  'test',
] as const;

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
  workspaces: (params: {
    query?: string;
    cursor?: string;
    status?: string;
    plan?: string;
    org?: string;
    inactiveDays?: string;
    sort?: string;
  }) =>
    authedFetch<{ workspaces: AdminWorkspace[]; total?: number; nextCursor: string | null }>(
      `/api/admin/workspaces${query(params)}`
    ),
  users: (params: { query?: string; cursor?: string; filter?: string; inactiveDays?: string }) =>
    authedFetch<{ users: AdminUser[]; total?: number; nextCursor: string | null }>(
      `/api/admin/users${query(params)}`
    ),
  workspace: (slug: string) =>
    authedFetch<AdminWorkspaceDetail>(`/api/admin/workspaces/${encodeURIComponent(slug)}`),
  org: (slug: string) => authedFetch<AdminOrgDetail>(`/api/admin/orgs/${encodeURIComponent(slug)}`),
  user: (id: string) => authedFetch<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
  overview: () => authedFetch<AdminOverview>('/api/admin/overview'),
  system: () => authedFetch<SystemInfo>('/api/admin/system'),
  jobs: () => authedFetch<{ queueRunning: boolean; queues: JobQueue[] }>('/api/admin/jobs'),
  failedJobs: (queueName?: string) =>
    authedFetch<{ jobs: FailedJob[] }>(`/api/admin/jobs/failed${query({ queue: queueName })}`),
  supportGrants: () => authedFetch<{ grants: SupportGrantEntry[] }>('/api/admin/support-grants'),
  security: (days?: string) => authedFetch<SecurityReport>(`/api/admin/security${query({ days })}`),
  auditSearch: (params: { actor: string; from?: string; to?: string }) =>
    authedFetch<{ events: AuditSearchEvent[] }>(`/api/admin/audit/search${query(params)}`),
  emailDeliveries: (params: { to?: string; status?: string; cursor?: string }) =>
    authedFetch<{ deliveries: EmailDeliveryEntry[]; total: number; nextCursor: string | null }>(
      `/api/admin/email/deliveries${query(params)}`
    ),
  admins: () =>
    authedFetch<{ admins: InstanceAdminEntry[]; invitations?: AdminInvitation[] }>(
      '/api/admin/admins'
    ),
  apiKeys: () => authedFetch<{ keys: InstanceApiKeyEntry[] }>('/api/admin/api-keys'),
  settingHistory: (key: SettingKey) =>
    authedFetch<{ versions: SettingVersion[] }>(
      `/api/admin/settings/${encodeURIComponent(key)}/history`
    ),
  encryption: () => authedFetch<EncryptionReport>('/api/admin/encryption'),
  orgs: (params: { query?: string; cursor?: string; status?: string } = {}) =>
    authedFetch<{ organizations: AdminOrgSummary[]; total?: number; nextCursor?: string | null }>(
      `/api/admin/orgs${query(params)}`
    ),
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
    resourceType?: string;
    from?: string;
    to?: string;
  }) =>
    authedFetch<{ events: InstanceAuditEvent[]; nextCursor: string | null }>(
      `/api/admin/audit${query(params)}`
    ),
};
