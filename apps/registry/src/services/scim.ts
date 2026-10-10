// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Role, ScimGroup, ScimUser } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { audit } from './audit';

// SSO-24/25: SCIM 2.0 (RFC 7643/7644) resources, filters and PATCH semantics, and how a
// SCIM user's state becomes a workspace membership.

export const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string
  ) {
    super(message);
  }
}

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

// ─── Resources ────────────────────────────────────────────────────────────────

export function userResource(
  baseUrl: string,
  user: ScimUser & { email: string },
  groups: Pick<ScimGroup, 'id' | 'displayName'>[] = []
) {
  const formatted = [user.givenName, user.familyName].filter(Boolean).join(' ') || undefined;
  return {
    schemas: [SCHEMA.user],
    id: user.id,
    ...(user.externalId && { externalId: user.externalId }),
    userName: user.userName,
    ...((user.givenName || user.familyName) && {
      name: {
        givenName: user.givenName ?? undefined,
        familyName: user.familyName ?? undefined,
        formatted,
      },
    }),
    ...(user.displayName && { displayName: user.displayName }),
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: user.active,
    groups: groups.map((g) => ({ value: g.id, display: g.displayName })),
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}

export function groupResource(
  baseUrl: string,
  group: ScimGroup,
  members: Pick<ScimUser, 'id' | 'userName'>[]
) {
  return {
    schemas: [SCHEMA.group],
    id: group.id,
    ...(group.externalId && { externalId: group.externalId }),
    displayName: group.displayName,
    members: members.map((m) => ({ value: m.id, display: m.userName })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

export const listResponse = <T>(resources: T[], total: number, startIndex: number) => ({
  schemas: [SCHEMA.list],
  totalResults: total,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

// ─── Filters ──────────────────────────────────────────────────────────────────

/** The filters IdPs send for lookups: `attribute eq "value"` (RFC 7644 §3.4.2.2). */
export function parseFilter(filter: string | undefined, allowed: string[]) {
  if (!filter) return null;
  const match = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!match) throw new ScimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  const attribute = allowed.find((a) => a.toLowerCase() === match[1].toLowerCase());
  if (!attribute)
    throw new ScimError(400, `Unsupported filter attribute: ${match[1]}`, 'invalidFilter');
  return { attribute, value: match[2].replace(/\\(.)/g, '$1') };
}

export function paging(query: { startIndex?: string; count?: string }) {
  const startIndex = Math.max(1, Number.parseInt(query.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(0, Number.parseInt(query.count ?? '100', 10) || 0));
  return { startIndex, skip: startIndex - 1, take: count };
}

// ─── Attributes ───────────────────────────────────────────────────────────────

/** Entra ID sends booleans as "True"/"False". */
export const toBool = (value: unknown) =>
  typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value);

export interface UserAttributes {
  userName?: string;
  externalId?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string;
  active?: boolean;
}

type Json = Record<string, unknown>;

function primaryEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const list = emails as Json[];
  const pick =
    list.find((e) => toBool(e.primary)) ?? list.find((e) => e.type === 'work') ?? list[0];
  return typeof pick?.value === 'string' ? pick.value : undefined;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? null : String(v));

/** A full User representation (POST/PUT). */
export function userAttributes(body: Json): UserAttributes {
  const name = (body.name ?? {}) as Json;
  return {
    userName: typeof body.userName === 'string' ? body.userName.trim() : undefined,
    externalId: str(body.externalId),
    displayName: str(body.displayName),
    givenName: str(name.givenName),
    familyName: str(name.familyName),
    email: primaryEmail(body.emails),
    active: body.active === undefined ? true : toBool(body.active),
  };
}

/** One PATCH value for `path` applied to the attributes (Okta and Entra ID shapes). */
function setUserPath(attrs: UserAttributes, path: string, value: unknown) {
  const p = path.toLowerCase();
  if (p === 'active') attrs.active = toBool(value);
  else if (p === 'username') attrs.userName = String(value);
  else if (p === 'externalid') attrs.externalId = str(value);
  else if (p === 'displayname') attrs.displayName = str(value);
  else if (p === 'name.givenname') attrs.givenName = str(value);
  else if (p === 'name.familyname') attrs.familyName = str(value);
  else if (p === 'name' && value && typeof value === 'object') {
    const name = value as Json;
    if ('givenName' in name) attrs.givenName = str(name.givenName);
    if ('familyName' in name) attrs.familyName = str(name.familyName);
  } else if (p === 'emails') attrs.email = primaryEmail(value) ?? attrs.email;
  else if (/^emails\[.*\]\.value$/.test(p)) attrs.email = String(value);
  // Other attributes (title, phoneNumbers, enterprise extension …) aren't stored.
}

interface PatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

function operations(body: Json): PatchOperation[] {
  const ops = body.Operations ?? body.operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'PATCH needs Operations', 'invalidSyntax');
  return ops.map((o: Json) => ({
    op: String(o.op ?? '').toLowerCase(),
    path: typeof o.path === 'string' ? o.path : undefined,
    value: o.value,
  }));
}

export function patchUser(current: UserAttributes, body: Json): UserAttributes {
  const attrs = { ...current };
  for (const op of operations(body)) {
    if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') {
      throw new ScimError(400, `Unsupported op: ${op.op}`, 'invalidSyntax');
    }
    const value = op.op === 'remove' ? null : op.value;
    if (op.path) setUserPath(attrs, op.path, value);
    else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Json)) setUserPath(attrs, key, v);
    }
  }
  return attrs;
}

export interface GroupChange {
  displayName?: string;
  externalId?: string | null;
  members: Set<string>;
}

const memberValues = (value: unknown) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((m) => (m && typeof m === 'object' ? (m as Json).value : m))
    .filter((v): v is string => typeof v === 'string');

export function patchGroup(current: GroupChange, body: Json): GroupChange {
  const next: GroupChange = { ...current, members: new Set(current.members) };
  for (const op of operations(body)) {
    const path = op.path?.toLowerCase();
    // members[value eq "id"] (Entra ID's remove).
    const filtered = op.path && /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(op.path);
    if (filtered) {
      if (op.op === 'remove') next.members.delete(filtered[1]);
      else next.members.add(filtered[1]);
    } else if (path === 'members') {
      const values = memberValues(op.value);
      if (op.op === 'add') values.forEach((v) => next.members.add(v));
      else if (op.op === 'remove') {
        if (values.length) values.forEach((v) => next.members.delete(v));
        else next.members.clear();
      } else if (op.op === 'replace') next.members = new Set(values);
    } else if (path === 'displayname') {
      if (op.op !== 'remove') next.displayName = String(op.value);
    } else if (path === 'externalid') {
      next.externalId = op.op === 'remove' ? null : str(op.value);
    } else if (!op.path && op.value && typeof op.value === 'object') {
      const value = op.value as Json;
      if (typeof value.displayName === 'string') next.displayName = value.displayName;
      if ('externalId' in value) next.externalId = str(value.externalId);
      if ('members' in value) {
        const values = memberValues(value.members);
        if (op.op === 'replace') next.members = new Set(values);
        else values.forEach((v) => next.members.add(v));
      }
    } else {
      throw new ScimError(400, `Unsupported PATCH path: ${op.path ?? '(none)'}`, 'invalidPath');
    }
  }
  return next;
}

// ─── Membership ───────────────────────────────────────────────────────────────

export interface ScimPolicy {
  roleMapping: Record<string, Role>;
  defaultRole: Role;
  /**
   * Users deprovisioned in this transaction: their workspace SSO sessions are revoked
   * after it commits (sessions are system tables, outside the tenant's reach).
   */
  deprovisioned: Set<string>;
}

/** Group → role mapping from the workspace's SSO settings (OIDC and SAML). */
export function scimPolicy(
  config: {
    oidcConfig: unknown;
    samlConfig: unknown;
    defaultSsoRole: string;
  } | null
): ScimPolicy {
  const mapping = (c: unknown) =>
    (c as { roleMapping?: Record<string, Role> } | null)?.roleMapping ?? {};
  return {
    roleMapping: { ...mapping(config?.oidcConfig), ...mapping(config?.samlConfig) },
    defaultRole: (config?.defaultSsoRole as Role) ?? 'viewer',
    deprovisioned: new Set(),
  };
}

const ACTOR = { principal: { type: 'system' as const, id: 'scim' } };

/**
 * Makes the membership match the SCIM user: active users are members, with the role
 * of their groups when the IdP pushes groups that map to roles (or after a group change),
 * else the current role (or the default for newcomers). Inactive or deleted users lose
 * the membership, their API keys in the workspace and the sessions they started through
 * this workspace's IdP. Owners are never demoted, and the last owner is never removed.
 */
export async function syncMembership(
  tx: TenantTx,
  workspace: { id: string; slug: string },
  policy: ScimPolicy,
  user: ScimUser,
  { fromGroups = false }: { fromGroups?: boolean } = {}
) {
  const member = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.userId } },
  });
  const event = (action: string, metadata: Record<string, unknown> = {}) =>
    audit(tx, workspace.id, ACTOR, {
      action,
      resourceType: 'user',
      resourceId: user.userId,
      metadata: { userName: user.userName, scimId: user.id, ...metadata },
    });

  if (!user.active || user.deletedAt) {
    if (!member) return;
    if (member.role === 'owner') {
      const owners = await tx.workspaceMember.count({
        where: { workspaceId: workspace.id, role: 'owner' },
      });
      if (owners <= 1) {
        await event('scim.deprovision_skipped', { reason: 'last_owner' });
        return;
      }
    }
    const now = new Date();
    await tx.workspaceMember.delete({ where: { id: member.id } });
    const keys = await tx.apiKey.updateMany({
      where: { workspaceId: workspace.id, createdBy: user.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    policy.deprovisioned.add(user.userId);
    await event('scim.user_deprovisioned', {
      role: member.role,
      deleted: !!user.deletedAt,
      apiKeysRevoked: keys.count,
    });
    return;
  }

  const groups = await tx.scimGroup.findMany({ where: { workspaceId: workspace.id } });
  const mappedGroupsExist = groups.some((g) => policy.roleMapping[g.displayName]);
  const mapped = groups
    .filter((g) => g.memberIds.includes(user.id))
    .map((g) => policy.roleMapping[g.displayName])
    .filter((role): role is Role => !!role)
    .sort((a, b) => RANK[b] - RANK[a])[0];
  // Roles follow the IdP only when it speaks about them through groups.
  const role =
    mapped ?? (fromGroups || mappedGroupsExist || !member ? policy.defaultRole : member.role);

  if (!member) {
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.userId, role, joinedAt: new Date() },
    });
    await event('scim.user_provisioned', { role });
  } else if (member.role !== 'owner' && (member.role !== role || !member.joinedAt)) {
    await tx.workspaceMember.update({
      where: { id: member.id },
      data: { role, joinedAt: member.joinedAt ?? new Date() },
    });
    if (member.role !== role) await event('scim.role_synced', { from: member.role, role });
  }
}

/** SSO must not re-add someone the IdP deprovisioned (SSO-25). */
export async function isDeprovisioned(tx: TenantTx, workspaceId: string, userId: string) {
  const user = await tx.scimUser.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return !!user && (!user.active || !!user.deletedAt);
}
