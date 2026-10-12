// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Role, Workspace } from '@prisma/client';
import { isApiKeyFormat, parseApiKey, parseOrgApiKey } from '../auth/apiKeys';
import { Permission, higherRole, roleAllows, scopesAllow } from '../auth/permissions';
import { verifyAccessToken } from '../auth/tokens';
import { SsoSubject, effectiveSso, parseSsoProviderId, sameSubject } from '../services/ssoIds';

export type Principal =
  | {
      type: 'apiKey';
      id: string;
      /** For an organization key: the workspace of this request, once authorized. */
      workspaceId: string;
      scopes: string[];
      moduleIds: string[];
      /** ORG-13: set for organization keys, valid in that org's (listed) workspaces. */
      organizationId?: string;
      workspaceIds?: string[];
    }
  | {
      type: 'user';
      id: string;
      email: string;
      isInstanceAdmin: boolean;
      /** How the session signed in, e.g. 'oidc:acme' (forced SSO, SSO-26). */
      provider?: string;
    };

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Set by `requireWorkspace` once access has been verified. */
    workspace?: Workspace;
    /** The user's role in `workspace` (undefined for API keys and instance-admin access). */
    workspaceRole?: Role;
    /** The user administers `workspace` as an admin of its organization (ORG-08, TLC-05). */
    viaOrgAdmin?: boolean;
    /** Set when the request came from this process (`internalHeaders`), never the network. */
    internal?: boolean;
  }

  interface FastifyInstance {
    /** Requires a valid API key or session. */
    authenticate: Handler;
    /**
     * Requires access to the workspace in `:workspaceSlug` with `permission`. API keys must
     * belong to that workspace; users must be joined members (non-members get 404).
     */
    requireWorkspace: (permission: Permission, opts?: { allowInstanceAdmin?: boolean }) => Handler;
    requireInstanceAdmin: Handler;
    /** Drop cached verifications for a key, e.g. after revocation. */
    forgetApiKey: (keyId: string) => void;
    /**
     * Headers for an in-process call (`fastify.inject`) made on behalf of a user or API
     * key, e.g. a scheduled operation. The principal is reloaded from the database, so
     * memberships, scopes and revocations apply as for a direct call.
     */
    internalHeaders: (runAs: { type: 'user' | 'apiKey'; id: string }) => Record<string, string>;
  }
}

interface CachedKey {
  keyId: string;
  workspaceId: string;
  organizationId?: string;
  workspaceIds?: string[];
  scopes: string[];
  moduleIds: string[];
  expiresAt: Date | null;
  gracePeriodEnd: Date | null;
  lastUsedWrite: number;
  cachedUntil: number;
}

const KEY_CACHE_TTL_MS = 60_000;
const KEY_CACHE_MAX = 1_000;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function keyIsUsable(key: { expiresAt: Date | null; gracePeriodEnd: Date | null }, now: number) {
  if (key.expiresAt && key.expiresAt.getTime() <= now) return false;
  // Set on the old key during rotation: valid only until the grace period ends (KEY-05).
  if (key.gracePeriodEnd && key.gracePeriodEnd.getTime() <= now) return false;
  return true;
}

const authenticatePlugin: FastifyPluginAsync = async (fastify) => {
  const { systemDb, logger } = fastify.container;
  const { jwtSecret } = fastify.config;

  // Verified keys, keyed by sha256(raw token): avoids an argon2 hash on every CI request.
  const keyCache = new Map<string, CachedKey>();

  function forgetApiKey(keyId: string) {
    for (const [hash, entry] of keyCache) {
      if (entry.keyId === keyId) keyCache.delete(hash);
    }
  }

  function touchLastUsed(entry: CachedKey, now: number) {
    if (now - entry.lastUsedWrite < LAST_USED_WRITE_INTERVAL_MS) return;
    entry.lastUsedWrite = now;
    const data = { lastUsedAt: new Date(now) };
    (entry.organizationId
      ? systemDb.orgApiKey.update({ where: { id: entry.keyId }, data })
      : systemDb.apiKey.update({ where: { id: entry.keyId }, data })
    ).catch((err: unknown) => logger.error('Failed to update API key lastUsedAt', err as Error));
  }

  /** ORG-13: an organization key as a cache entry (null when unknown or revoked). */
  async function loadOrgKey(keyId: string, secret: string | null, now: number) {
    const record = await systemDb.orgApiKey.findUnique({
      where: { id: keyId },
      include: { organization: { select: { deletedAt: true } } },
    });
    if (!record || record.revokedAt || record.organization.deletedAt) return null;
    if (secret !== null && !(await argon2.verify(record.keyHash, secret))) return null;
    return {
      keyId: record.id,
      workspaceId: '',
      organizationId: record.organizationId,
      workspaceIds: record.workspaceScope,
      scopes: record.scopes,
      moduleIds: record.moduleScope,
      expiresAt: record.expiresAt,
      gracePeriodEnd: null,
      lastUsedWrite: record.lastUsedAt?.getTime() ?? 0,
      cachedUntil: now + KEY_CACHE_TTL_MS,
    } satisfies CachedKey;
  }

  /** A workspace key as a cache entry (null when unknown or revoked). */
  async function loadWorkspaceKey(keyId: string, secret: string | null, now: number) {
    const record = await systemDb.apiKey.findUnique({ where: { id: keyId } });
    if (!record || record.revokedAt) return null;
    if (secret !== null && !(await argon2.verify(record.keyHash, secret))) return null;
    return {
      keyId: record.id,
      workspaceId: record.workspaceId,
      scopes: record.scopes,
      moduleIds: record.moduleIds,
      expiresAt: record.expiresAt,
      gracePeriodEnd: record.gracePeriodEnd,
      lastUsedWrite: record.lastUsedAt?.getTime() ?? 0,
      cachedUntil: now + KEY_CACHE_TTL_MS,
    } satisfies CachedKey;
  }

  const toPrincipal = (entry: CachedKey): Principal => ({
    type: 'apiKey',
    id: entry.keyId,
    workspaceId: entry.workspaceId,
    scopes: entry.scopes,
    moduleIds: entry.moduleIds,
    ...(entry.organizationId && {
      organizationId: entry.organizationId,
      workspaceIds: entry.workspaceIds ?? [],
    }),
  });

  async function resolveApiKey(raw: string): Promise<Principal | null> {
    const now = Date.now();
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const cached = keyCache.get(tokenHash);

    let entry: CachedKey | null;
    if (cached && cached.cachedUntil > now) {
      // The cache only saves the argon2 hash. The key row is re-read on every request, so
      // a revocation (dashboard, rotation, SCIM deprovisioning, on any replica), a new
      // expiry or a scope change applies to the very next request.
      entry = cached.organizationId
        ? await loadOrgKey(cached.keyId, null, now)
        : await loadWorkspaceKey(cached.keyId, null, now);
      if (entry) {
        entry.cachedUntil = cached.cachedUntil;
        entry.lastUsedWrite = Math.max(entry.lastUsedWrite, cached.lastUsedWrite);
      }
    } else {
      const orgKey = parseOrgApiKey(raw);
      const parsed = orgKey ?? parseApiKey(raw);
      entry = !parsed
        ? null
        : orgKey
          ? await loadOrgKey(orgKey.keyId, orgKey.secret, now)
          : await loadWorkspaceKey(parsed.keyId, parsed.secret, now);
    }

    if (!entry) {
      keyCache.delete(tokenHash);
      return null;
    }
    if (!cached || cached.cachedUntil <= now) {
      if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
    }
    keyCache.set(tokenHash, entry);

    if (!keyIsUsable(entry, now)) return null;
    touchLastUsed(entry, now);
    return toPrincipal(entry);
  }

  async function resolveSession(token: string): Promise<Principal | null> {
    let claims;
    try {
      claims = await verifyAccessToken(token, jwtSecret);
    } catch {
      return null;
    }
    // The sign-in method was turned off (HARMONIQ_AUTH_METHODS or the admin panel): its
    // sessions stop now, not when the access token expires.
    if (claims.provider && !fastify.container.settings.sessionProviderEnabled(claims.provider)) {
      return null;
    }
    const user = await systemDb.user.findUnique({
      where: { id: claims.userId },
      include: { InstanceAdmin: true },
    });
    if (!user) return null;
    return {
      type: 'user',
      id: user.id,
      email: user.email,
      isInstanceAdmin: !!user.InstanceAdmin && !user.InstanceAdmin.revokedAt,
      ...(claims.provider && { provider: claims.provider }),
    };
  }

  // Proves a request came from this process (inject), never from the network.
  const internalSecret = randomBytes(32).toString('base64url');
  const INTERNAL = 'x-harmoniq-internal';
  const RUN_AS = 'x-harmoniq-run-as';

  async function resolveInternal(request: FastifyRequest): Promise<Principal | null> {
    const secret = request.headers[INTERNAL];
    if (typeof secret !== 'string') return null;
    const given = Buffer.from(secret);
    const expected = Buffer.from(internalSecret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const [type, id] = String(request.headers[RUN_AS] ?? '').split(':');
    if (type === 'user' && id) {
      const user = await systemDb.user.findUnique({
        where: { id },
        include: { InstanceAdmin: true },
      });
      return user
        ? {
            type: 'user',
            id: user.id,
            email: user.email,
            isInstanceAdmin: !!user.InstanceAdmin && !user.InstanceAdmin.revokedAt,
          }
        : null;
    }
    if (type === 'apiKey' && id) {
      const key = await systemDb.apiKey.findUnique({ where: { id } });
      if (!key) {
        // An organization key (e.g. its deploy was held for approval).
        const orgKey = await loadOrgKey(id, null, Date.now());
        return orgKey && keyIsUsable(orgKey, Date.now()) ? toPrincipal(orgKey) : null;
      }
      if (key.revokedAt || !keyIsUsable(key, Date.now())) return null;
      return {
        type: 'apiKey',
        id: key.id,
        workspaceId: key.workspaceId,
        scopes: key.scopes,
        moduleIds: key.moduleIds,
      };
    }
    return null;
  }

  /** Resolves and memoizes the caller. Returns null when credentials are missing or invalid. */
  async function resolvePrincipal(request: FastifyRequest): Promise<Principal | null> {
    if (request.principal) return request.principal;
    if (request.headers[INTERNAL]) {
      const principal = await resolveInternal(request);
      if (principal) {
        request.principal = principal;
        request.internal = true;
      }
      return principal;
    }
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    const principal = isApiKeyFormat(token)
      ? await resolveApiKey(token)
      : await resolveSession(token);
    if (principal) request.principal = principal;
    return principal;
  }

  const authenticate: Handler = async (request, reply) => {
    if (!(await resolvePrincipal(request))) {
      return deny(reply, 401, 'UNAUTHORIZED', 'Missing, invalid, expired or revoked credentials');
    }
  };

  const requireInstanceAdmin: Handler = async (request, reply) => {
    const principal = await resolvePrincipal(request);
    if (!principal) return deny(reply, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');
    if (principal.type !== 'user' || !principal.isInstanceAdmin || ssoScope(principal)) {
      return deny(reply, 403, 'FORBIDDEN', 'Not an active Instance Admin');
    }
  };

  // INST-09: a suspended workspace stays readable (and its manifests served) but refuses
  // every change, including scheduled and approved ones (they run through these routes).
  const suspended = (workspace: Workspace, permission: Permission) =>
    !!workspace.suspendedAt && permission !== 'workspace:read';
  const SUSPENDED = [
    403,
    'WORKSPACE_SUSPENDED',
    'This workspace is suspended by the instance administrator; changes are disabled',
  ] as const;

  function requireWorkspace(
    permission: Permission,
    opts: { allowInstanceAdmin?: boolean } = {}
  ): Handler {
    return async (request, reply) => {
      const principal = await resolvePrincipal(request);
      if (!principal) return deny(reply, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');

      const { workspaceSlug } = request.params as { workspaceSlug?: string };
      const workspace = workspaceSlug
        ? await systemDb.workspace.findUnique({ where: { slug: workspaceSlug } })
        : null;

      if (principal.type === 'apiKey') {
        if (principal.organizationId) {
          // ORG-13: any workspace of the key's organization, or only the listed ones.
          const allowed =
            !!workspace &&
            workspace.organizationId === principal.organizationId &&
            (!principal.workspaceIds?.length || principal.workspaceIds.includes(workspace.id));
          if (!allowed) {
            return deny(reply, 403, 'FORBIDDEN', 'API key is not valid for this workspace');
          }
          principal.workspaceId = workspace!.id;
        }
        // A key is only ever valid for the workspace that issued it.
        if (!workspace || workspace.id !== principal.workspaceId) {
          return deny(reply, 403, 'FORBIDDEN', 'API key is not valid for this workspace');
        }
        if (!scopesAllow(principal.scopes, permission)) {
          return deny(reply, 403, 'FORBIDDEN', `API key lacks a scope granting ${permission}`);
        }
        if (suspended(workspace, permission)) return deny(reply, ...SUSPENDED);
        request.workspace = workspace;
        return;
      }

      // Users: non-members get 404 so workspace slugs can't be probed.
      if (!workspace) return deny(reply, 404, 'NOT_FOUND', 'Workspace not found');

      // A session from a workspace's own IdP only reaches that workspace: its admins
      // control what the IdP asserts, so it can't vouch for anyone elsewhere. One from an
      // organization's IdP reaches the org's workspaces that use it (ORG-05).
      const scope = ssoScope(principal);
      let sso: Awaited<ReturnType<typeof effectiveSso>> | undefined;
      const ssoOf = async () => (sso ??= await effectiveSso(systemDb, workspace));
      if (scope) {
        const reaches =
          scope.kind === 'workspace'
            ? scope.slug === workspace.slug
            : sameSubject(scope, (await ssoOf()).subject);
        if (!reaches) {
          return deny(
            reply,
            403,
            'SSO_SCOPED',
            `This session comes from the single sign-on of ${scope.kind} "${scope.slug}" and only works there`
          );
        }
      }

      if (opts.allowInstanceAdmin && principal.isInstanceAdmin) {
        if (suspended(workspace, permission)) return deny(reply, ...SUSPENDED);
        request.workspace = workspace;
        return;
      }

      const joined = await systemDb.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: principal.id } },
      });
      // ORG-08: organization admins administer the org's workspaces (at least `admin`).
      const orgAdmin =
        !!workspace.organizationId &&
        scope?.kind !== 'workspace' &&
        (await systemDb.organizationMember.count({
          where: {
            organizationId: workspace.organizationId,
            userId: principal.id,
            role: 'org_admin',
            organization: { deletedAt: null },
          },
        })) > 0;
      const memberRole = joined?.joinedAt ? joined.role : null;
      // TLC-05: org admins act as owners of a workspace that has no joined owner (e.g. one
      // an org key created), so owner-only actions stay possible; otherwise as admins.
      const orgAdminRole: Role | null = !orgAdmin
        ? null
        : (await systemDb.workspaceMember.count({
              where: { workspaceId: workspace.id, role: 'owner', joinedAt: { not: null } },
            })) === 0
          ? 'owner'
          : 'admin';
      const role = higherRole(memberRole, orgAdminRole);
      if (!role) return deny(reply, 404, 'NOT_FOUND', 'Workspace not found');
      const membership = { role };
      if (!roleAllows(membership.role, permission)) {
        return deny(reply, 403, 'FORBIDDEN', `Your role does not grant ${permission}`);
      }
      // SSO-26: forced SSO. Owners are exempt (break-glass if the IdP breaks); in-process
      // calls (scheduled, approved) were checked when they were created.
      // ORG-05: the organization's SSO (and its forced SSO) when the workspace inherits it.
      // Only joined owners: an org admin acting as owner (TLC-05) still signs in with SSO.
      if (memberRole !== 'owner' && !request.internal) {
        const { forceSso, subject } = await ssoOf();
        if (forceSso && !sameSubject(scope, subject)) {
          return deny(
            reply,
            403,
            'SSO_REQUIRED',
            `This workspace requires signing in with its single sign-on`
          );
        }
      }
      if (suspended(workspace, permission)) return deny(reply, ...SUSPENDED);
      request.workspace = workspace;
      request.workspaceRole = membership.role;
      request.viaOrgAdmin = !!orgAdminRole;
    };
  }

  fastify.decorate('authenticate', authenticate);
  fastify.decorate('requireWorkspace', requireWorkspace);
  fastify.decorate('requireInstanceAdmin', requireInstanceAdmin);
  fastify.decorate('forgetApiKey', forgetApiKey);
  fastify.decorate('internalHeaders', (runAs: { type: 'user' | 'apiKey'; id: string }) => ({
    [INTERNAL]: internalSecret,
    [RUN_AS]: `${runAs.type}:${runAs.id}`,
  }));
};

/** API keys may be restricted to specific modules (RBAC-04). Users are checked by role. */
/**
 * The workspace or organization a session is limited to, when it came from that
 * workspace's or organization's own IdP (`oidc:<workspace>`, `saml:<workspace>`,
 * `org-oidc:<org>`, `org-saml:<org>`); null for other sign-ins and API keys.
 */
export function ssoScope(principal: Principal | undefined): SsoSubject | null {
  if (principal?.type !== 'user') return null;
  return parseSsoProviderId(principal.provider)?.subject ?? null;
}

export function canAccessModule(principal: Principal | undefined, moduleId: string): boolean {
  if (principal?.type !== 'apiKey' || principal.moduleIds.length === 0) return true;
  return principal.moduleIds.includes(moduleId);
}

export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['app-container'],
});
