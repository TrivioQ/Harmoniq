import type { Role } from '@prisma/client';

/**
 * Workspace-level permissions. Routes declare the permission they need; users get them
 * through their workspace role, API keys through their scopes.
 */
export type Permission =
  | 'workspace:read' // view modules, versions, environments, audit log
  | 'module:deploy' // deploy, rollback, promote
  | 'workspace:admin' // environments, keys, members, webhooks, storage
  | 'workspace:owner'; // delete workspace, override freezes

const ROLE_RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

const MIN_ROLE: Record<Permission, Role> = {
  'workspace:read': 'viewer',
  'module:deploy': 'developer',
  'workspace:admin': 'admin',
  'workspace:owner': 'owner',
};

export const API_KEY_SCOPES = ['manifest:read', 'deploy:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// Owner-only operations are never available to API keys.
const SCOPE_GRANTS: Record<ApiKeyScope, Permission[]> = {
  'manifest:read': ['workspace:read'],
  'deploy:write': ['workspace:read', 'module:deploy'],
  admin: ['workspace:read', 'module:deploy', 'workspace:admin'],
};

export function roleAllows(role: Role, permission: Permission): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[permission]];
}

export function scopesAllow(scopes: readonly string[], permission: Permission): boolean {
  return scopes.some((scope) => SCOPE_GRANTS[scope as ApiKeyScope]?.includes(permission));
}
