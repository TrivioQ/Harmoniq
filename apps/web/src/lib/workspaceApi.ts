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
  /** ENV-FRZ-04: a freeze window that starts later. */
  scheduledFreeze: { from: string; until: string | null; reason: string | null } | null;
  /** ENV-FRZ-03: an owner's open override window. */
  freezeOverride: { until: string; reason: string | null; by: string | null } | null;
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
  /** INST-09: set while the instance admin has suspended the workspace. */
  suspendedAt?: string | null;
  suspendedReason?: string | null;
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
  /** Share of users on this version while it is the canary (1–99). */
  trafficPercent: number | null;
  /** Canary targeting: matching users always get this version. */
  targeting: Array<{ attribute: string; values: string[] }> | null;
  /** APR-18: the approval chain, for versions created by an approved request. */
  approval?: {
    requestId: string;
    bypassed: boolean;
    bypassJustification: string | null;
    changeTicket: { id: string; url: string | null } | null;
    decisions: Array<{ approverId: string; decision: string; comment: string | null }>;
  } | null;
  /** Staged rollout progress while the version is a canary following a schedule. */
  rollout: {
    bands: Array<{ percent: number; holdMinutes: number }>;
    gate: {
      maxErrorRate?: number;
      maxErrorRateDelta?: number;
      maxP95Ms?: number;
      minSamples: number;
    };
    bandStartedAt: string;
    currentBandIndex: number;
  } | null;
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
  environments: Array<{
    slug: string;
    name: string;
    frozen: boolean;
    active: Version | null;
    canary: Version | null;
    disabled: { reason: string | null; by: string; at: string } | null;
  }>;
}

export interface ModuleDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** RBAC-01: module owners (empty: every developer may change it). */
  owners: Array<{ memberId: string; userId: string; email: string; name: string | null }>;
  /** Whether you may deploy, roll back or otherwise change this module. */
  canWrite: boolean;
  /** ORG-10: listed in the organization's other workspaces' manifests. */
  orgShared: boolean;
  /** Owners of workspaces in an organization may share modules. */
  canShare: boolean;
  hostApp: { slug: string; name: string };
  environments: Array<{
    id: string;
    slug: string;
    name: string;
    frozen: boolean;
    freezeReason: string | null;
    /** Kill switch state. */
    disabled: { reason: string | null; at: string } | null;
  }>;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorId: string;
  actorType: 'user' | 'apiKey' | 'system';
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

export interface HourlyHealth {
  hour: string;
  sampleCount: number;
  errorCount: number;
}

export interface HealthStats {
  sampleCount: number;
  errorCount: number;
  loadSuccessRate: number | null;
  p50LoadMs: number | null;
  p95LoadMs: number | null;
}

export interface ModuleHealth extends HealthStats {
  windowMinutes: number;
  trend: 'improving' | 'degrading' | 'steady' | 'insufficient_data';
  variants: { stable: HealthStats; canary: HealthStats };
  topErrors: Array<{ message: string; variant: string; count: number }>;
  hourlySince: string;
  hourly: HourlyHealth[];
}

export interface AlertRuleSummary {
  id: string;
  name: string;
  condition: string;
  threshold: number;
  action: 'webhook' | 'auto_rollback';
  module: { id: string; slug: string } | null;
  environment: string | null;
  windowMinutes: number;
  minSamples: number;
  cooldownMinutes: number;
  enabled: boolean;
  state: 'ok' | 'firing';
  lastValue: number | null;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  lastError: string | null;
}

export interface ScheduledOperationSummary {
  id: string;
  type: string;
  module: string | null;
  environment: string | null;
  description: string | null;
  runAt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  createdBy: { type: string; id: string };
  finishedAt: string | null;
  error: string | null;
}

export interface DependencyMatrix {
  hostApp: string;
  environment: string;
  packages: string[];
  sources: Array<{ name: string; dependencies: Record<string, string> }>;
  conflicts: Array<{
    package: string;
    between: Array<{ source: string; range: string }>;
    reason: 'no_common_version' | 'invalid_range';
  }>;
}

export interface ApprovalRequest {
  id: string;
  type: string;
  module: string;
  environment: string;
  status: 'pending_approval' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired';
  requestedBy: { type: string; id: string; email: string | null };
  request: Record<string, unknown>;
  requiredApprovers: number;
  approvals: Array<{
    approverId: string;
    approverEmail: string | null;
    decision: 'approved' | 'rejected';
    comment: string | null;
    decidedAt: string;
  }>;
  changeTicket: { id: string; url: string | null } | null;
  bypassed: boolean;
  bypassJustification: string | null;
  expiresAt: string;
  createdAt: string;
  canDecide: boolean;
  cannotDecideBecause?: string;
}

export interface ApprovalPolicySummary {
  id: string;
  environment?: string;
  hostApp?: string;
  requiredApprovers: number;
  eligibleRoles: Role[];
  requireChangeTicket: boolean;
  ticketUrlPattern: string | null;
  expiryHours: number;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  /** Masked. */
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
  /** Workspaces only (organizations use group rules). */
  roleMapping?: Record<string, Role>;
  trustedDomains: string[];
  defaultRole?: Role;
  forceSso: boolean;
  providerId: string;
}

export interface SamlSettings {
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl?: string;
  idpCert: string;
  nameIdFormat: string;
  attributeMapping: { email?: string; name?: string; groups?: string };
  /** Workspaces only (organizations use group rules). */
  roleMapping?: Record<string, Role>;
  trustedDomains: string[];
  defaultRole?: Role;
  forceSso: boolean;
  allowIdpInitiated: boolean;
  providerId: string;
}

export interface SamlSettingsResponse {
  /** What to register at the IdP. */
  serviceProvider: {
    entityId: string;
    metadata: string;
    acs: string;
    login: string;
    logout: string;
    slo: string;
    cert: string | null;
  };
  saml: SamlSettings | null;
}

export interface SamlTestResult {
  attributes: Record<string, unknown>;
  mapped: { email?: string; name?: string; groups?: string[]; error?: string };
}

export interface ScimSettings {
  enabled: boolean;
  baseUrl: string;
  tokenCreatedAt: string | null;
  users: number;
  groups: number;
}

export interface ScimEvent {
  id: string;
  operation: string;
  scimUserId: string;
  payload: unknown;
  statusCode: number;
  createdAt: string;
}

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
  health: (slug: string) =>
    authedFetch<{
      since: string;
      hours: number;
      series: Array<{ moduleId: string; environment: string; hourly: HourlyHealth[] }>;
    }>(`${ws(slug)}/health?hours=24`),
  scheduled: (slug: string) =>
    authedFetch<{ operations: ScheduledOperationSummary[] }>(`${ws(slug)}/scheduled-operations`),
  dependencies: (slug: string, host: string, env: string) =>
    authedFetch<DependencyMatrix>(
      `${ws(slug)}/host-apps/${enc(host)}/environments/${enc(env)}/dependencies`
    ),
  approvals: (slug: string) =>
    authedFetch<{ requests: ApprovalRequest[] }>(`${ws(slug)}/approvals`),
  approvalPolicies: (slug: string) =>
    authedFetch<{ policies: ApprovalPolicySummary[] }>(`${ws(slug)}/approval-policies`),
  sso: (slug: string) => authedFetch<{ oidc: OidcSettings | null }>(`${ws(slug)}/sso/oidc`),
  scim: (slug: string) => authedFetch<ScimSettings>(`${ws(slug)}/scim`),
  scimEvents: (slug: string) =>
    authedFetch<{ events: ScimEvent[] }>(`${ws(slug)}/scim/events?limit=50`),
  saml: (slug: string) => authedFetch<SamlSettingsResponse>(`${ws(slug)}/sso/saml`),
  samlTest: (slug: string, id: string) =>
    authedFetch<SamlTestResult>(`${ws(slug)}/sso/saml/test/${enc(id)}`),
  alerts: (slug: string) => authedFetch<{ rules: AlertRuleSummary[] }>(`${ws(slug)}/alerts`),
  moduleHealth: (slug: string, ref: string, env: string) =>
    authedFetch<ModuleHealth>(`${ws(slug)}/modules/${enc(ref)}/health?environment=${enc(env)}`),
};

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

/** UI hint only; the registry enforces permissions on every call. */
export const roleAtLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];
