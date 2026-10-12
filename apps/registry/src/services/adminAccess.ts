// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * INST-31..33: what each instance admin role (and instance API key) may do on `/api/admin`.
 *
 * Reading is open to every role. A write needs the capability listed for its route below;
 * a write that isn't listed is for instance owners only, so a new route is safe by default.
 * Destructive writes also need a recent re-authentication (INST-32).
 */

export const ADMIN_ROLES = [
  'instance_owner',
  'instance_operator',
  'instance_support',
  'instance_billing',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type Capability =
  | 'read'
  /** Suspend, unsuspend and restore workspaces and organizations. */
  | 'tenants'
  | 'plans'
  /** End a user's sessions. */
  | 'sessions'
  /** Suspend users, reset their MFA. */
  | 'users'
  /** Run maintenance jobs (9.10). */
  | 'jobs'
  /** INST-20: open and end read-only support access to a tenant. */
  | 'support'
  /** Everything else: settings, deletion, admins, instance keys. */
  | 'owner';

const ROLE_CAPABILITIES: Record<AdminRole, Capability[]> = {
  instance_owner: ['read', 'tenants', 'plans', 'sessions', 'users', 'jobs', 'support', 'owner'],
  instance_operator: ['read', 'tenants', 'plans', 'sessions', 'users', 'jobs', 'support'],
  instance_support: ['read', 'sessions', 'support'],
  instance_billing: ['read', 'plans'],
};

export const asAdminRole = (role: string | null | undefined): AdminRole =>
  (ADMIN_ROLES as readonly string[]).includes(role ?? '') ? (role as AdminRole) : 'instance_owner';

export const roleAllows = (role: AdminRole, capability: Capability) =>
  ROLE_CAPABILITIES[role].includes(capability);

export const capabilitiesOf = (role: AdminRole) => ROLE_CAPABILITIES[role];

type Rule = { capability: Capability; destructive?: boolean };

/** Writes that aren't owner-only, and owner writes that are destructive. Key: `METHOD url`. */
const RULES: Record<string, Rule> = {
  'POST /api/admin/workspaces/:slug/suspend': { capability: 'tenants' },
  'POST /api/admin/workspaces/:slug/unsuspend': { capability: 'tenants' },
  'POST /api/admin/workspaces/:slug/restore': { capability: 'tenants' },
  'POST /api/admin/orgs/:slug/suspend': { capability: 'tenants' },
  'POST /api/admin/orgs/:slug/unsuspend': { capability: 'tenants' },
  'POST /api/admin/orgs/:slug/restore': { capability: 'tenants' },
  'PUT /api/admin/workspaces/:slug/plan': { capability: 'plans' },
  'PUT /api/admin/orgs/:slug/plan': { capability: 'plans' },
  'POST /api/admin/users/:id/revoke-sessions': { capability: 'sessions' },
  'POST /api/admin/jobs/:id/retry': { capability: 'jobs' },
  'POST /api/admin/support-grants': { capability: 'support' },
  'DELETE /api/admin/support-grants/:id': { capability: 'support' },
  'POST /api/admin/jobs/:queue/run': { capability: 'jobs' },
  'POST /api/admin/users/:id/suspend': { capability: 'users' },
  'POST /api/admin/users/:id/unsuspend': { capability: 'users' },
  'DELETE /api/admin/users/:id/mfa': { capability: 'users', destructive: true },
  // Destructive, owners only (INST-32).
  'DELETE /api/admin/workspaces/:slug': { capability: 'owner', destructive: true },
  'DELETE /api/admin/users/:id': { capability: 'owner', destructive: true },
  'POST /api/admin/admins': { capability: 'owner', destructive: true },
  'PATCH /api/admin/admins/:userId': { capability: 'owner', destructive: true },
  'DELETE /api/admin/admins/:userId': { capability: 'owner', destructive: true },
  'DELETE /api/admin/admin-invitations/:id': { capability: 'owner' },
  'POST /api/admin/api-keys': { capability: 'owner', destructive: true },
  'DELETE /api/admin/api-keys/:id': { capability: 'owner' },
  'POST /api/admin/encryption/reseal': { capability: 'owner' },
};

/** Settings whose change is destructive (INST-32). */
const DESTRUCTIVE_SETTINGS = new Set(['auth', 'storage']);

/** What a request to an admin route needs. */
export function requirementOf(
  method: string,
  url: string,
  params: Record<string, string> = {}
): Rule & { keyManagement: boolean } {
  const rule: Rule =
    RULES[`${method} ${url}`] ??
    (method === 'GET' || method === 'HEAD' ? { capability: 'read' } : { capability: 'owner' });
  const settingsWrite =
    (url === '/api/admin/settings/:key' && method !== 'GET') ||
    url === '/api/admin/settings/:key/history/:version/restore' ||
    url === '/api/admin/settings/import';
  const destructive =
    !!rule.destructive ||
    (settingsWrite &&
      (url === '/api/admin/settings/import' || DESTRUCTIVE_SETTINGS.has(params.key)));
  return {
    ...rule,
    destructive,
    // Instance keys never manage admins or keys (no escalation through automation).
    keyManagement:
      url.startsWith('/api/admin/admins') ||
      url.startsWith('/api/admin/api-keys') ||
      url.startsWith('/api/admin/admin-invitations'),
  };
}

/** INST-32: how recent a re-authentication must be for destructive actions. */
export const REAUTH_WINDOW_MS = 10 * 60_000;
