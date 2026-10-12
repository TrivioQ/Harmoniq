// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Role, Workspace } from '@prisma/client';
import { isApiKeyFormat, parseApiKey, parseInstanceApiKey, parseOrgApiKey } from '../auth/apiKeys';
import { Permission, higherRole, roleAllows, scopesAllow } from '../auth/permissions';
import { verifyAccessToken } from '../auth/tokens';
import { SsoSubject, effectiveSso, parseSsoProviderId, sameSubject } from '../services/ssoIds';
import { ipAllowed, parseAllowlist } from '../services/policy';
import {
  type AdminRole,
  REAUTH_WINDOW_MS,
  asAdminRole,
  requirementOf,
  roleAllows as adminRoleAllows,
} from '../services/adminAccess';
import { isTenantSso } from '../services/authService';

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
      /** INST-33: an instance key: `/api/admin` only, never a workspace or organization. */
      instance?: boolean;
    }
  | {
      type: 'user';
      id: string;
      email: string;
      isInstanceAdmin: boolean;
      /** How the session signed in, e.g. 'oidc:acme' (forced SSO, SSO-26). */
      provider?: string;
      /** SES-02: the session (refresh-token family). */
      sessionId?: string;
      /** SES-03: the session passed a second factor. */
      mfa?: boolean;
      /** INST-32: when the user last proved who they are (epoch ms). */
      reauthAt?: number;
      /** INST-31: the instance admin role, for instance admins. */
      instanceRole?: AdminRole;
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
    requireWorkspace: (
      permission: Permission,
      opts?: { allowInstanceAdmin?: boolean; allowDeleted?: boolean }
    ) => Handler;
    requireInstanceAdmin: Handler;
    /** Drop cached verifications for a key, e.g. after revocation. */
    forgetApiKey: (keyId: string) => void;
    /**
     * Headers for an in-process call (`fastify.inject`) made on behalf of a user or API
     * key, e.g. a scheduled operation. The principal is reloaded from the database, so
     * memberships, scopes and revocations apply as for a direct call.
     */
    internalHeaders: (runAs: { type: 'user' | 'apiKey'; id: string }) => Record<string, string>;
    /**
     * POL-08: whether `ip` may reach the organization (`management`: dashboard and API;
     * `delivery`: manifests and health, only when the policy includes them).
     */
    ipAllowedForOrg: (
      organizationId: string,
      ip: string,
      kind: 'management' | 'delivery'
    ) => Promise<boolean>;
    /** POL-08: a preHandler for public delivery routes with `:workspaceSlug`. */
    requireDeliveryIp: Handler;
    /** Drop cached org network policies (after the policy changes). */
    forgetOrgPolicy: (organizationId: string) => void;
    /** SES-04: drop every cached key verification (e.g. after a user is suspended). */
    forgetApiKeys: () => void;
    /** SES-02: drop the cached state of a session (after it is ended). */
    forgetSession: (sessionId: string) => void;
    /** SES-03: whether the organization refuses this principal for want of MFA. */
    mfaRequiredBy: (organizationId: string, principal: Principal) => Promise<boolean>;
  }
}

const IP_POLICY_TTL_MS = 30_000;

interface CachedKey {
  keyId: string;
  /** INST-33 */
  instance?: boolean;
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

  // POL-08: org network policies and workspace → organization, briefly cached (every
  // workspace request and, when opted in, every manifest request checks them).
  const ipPolicies = new Map<
    string,
    { list: string[]; manifests: boolean; requireMfa: boolean; expires: number }
  >();

  /** The organization's access policy (POL-08, SES-03), cached for 30 s. */
  async function accessPolicy(organizationId: string) {
    const now = Date.now();
    let policy = ipPolicies.get(organizationId);
    if (!policy || policy.expires <= now) {
      const row = await systemDb.orgPolicy.findUnique({
        where: { organizationId },
        select: { ipAllowlist: true, ipAllowlistManifests: true, requireMfa: true },
      });
      policy = {
        list: row?.ipAllowlist ?? [],
        manifests: row?.ipAllowlistManifests ?? false,
        requireMfa: row?.requireMfa ?? false,
        expires: now + IP_POLICY_TTL_MS,
      };
      if (ipPolicies.size > 5_000) ipPolicies.clear();
      ipPolicies.set(organizationId, policy);
    }
    return policy;
  }

  /**
   * SES-03: whether the organization refuses this session for want of MFA: members who
   * signed in without its (or a workspace's) SSO and without a second factor.
   */
  async function mfaRequiredBy(organizationId: string, principal: Principal) {
    if (principal.type !== 'user' || principal.mfa || isTenantSso(principal.provider)) {
      return false;
    }
    return (await accessPolicy(organizationId)).requireMfa;
  }

  async function ipAllowedForOrg(
    organizationId: string,
    ip: string,
    kind: 'management' | 'delivery'
  ) {
    const policy = await accessPolicy(organizationId);
    if (kind === 'delivery' && !policy.manifests) return true;
    try {
      return ipAllowed(policy.list, ip);
    } catch {
      // A list saved before validation tightened: fail closed.
      return false;
    }
  }

  const ipDenied = (reply: FastifyReply, ip: string) =>
    deny(reply, 403, 'IP_NOT_ALLOWED', `Access from ${ip} is not allowed by the organization`);

  const mfaDenied = (reply: FastifyReply) =>
    deny(
      reply,
      403,
      'MFA_REQUIRED',
      'The organization requires multi-factor authentication: set it up in your account, then sign in again'
    );

  /**
   * POL-08 and SES-03 for a workspace request (none for in-process calls, checked when they
   * were created).
   */
  async function ipRefusal(
    request: FastifyRequest,
    reply: FastifyReply,
    workspace: { organizationId: string | null }
  ) {
    if (!workspace.organizationId || request.internal) return null;
    if (!(await ipAllowedForOrg(workspace.organizationId, request.ip, 'management'))) {
      return ipDenied(reply, request.ip);
    }
    if (await mfaRequiredBy(workspace.organizationId, request.principal!)) return mfaDenied(reply);
    return null;
  }

  /**
   * Manifests and health take no database query per request: the workspaces whose
   * organization extends its allowlist to them are loaded together, every 30 s at most
   * (and at once after a policy change on this replica).
   */
  let delivery: { bySlug: Map<string, string[]>; expires: number } = {
    bySlug: new Map(),
    expires: 0,
  };
  let deliveryLoading: Promise<void> | null = null;
  async function deliveryLists() {
    if (delivery.expires > Date.now()) return delivery.bySlug;
    deliveryLoading ??= (async () => {
      const policies = await systemDb.orgPolicy.findMany({
        where: { ipAllowlistManifests: true, NOT: { ipAllowlist: { isEmpty: true } } },
        select: { organizationId: true, ipAllowlist: true },
      });
      const workspaces = policies.length
        ? await systemDb.workspace.findMany({
            where: { organizationId: { in: policies.map((p) => p.organizationId) } },
            select: { slug: true, organizationId: true },
          })
        : [];
      const listOf = new Map(policies.map((p) => [p.organizationId, p.ipAllowlist]));
      delivery = {
        bySlug: new Map(workspaces.map((w) => [w.slug, listOf.get(w.organizationId!)!])),
        expires: Date.now() + IP_POLICY_TTL_MS,
      };
    })().finally(() => {
      deliveryLoading = null;
    });
    await deliveryLoading;
    return delivery.bySlug;
  }

  async function requireDeliveryIp(request: FastifyRequest, reply: FastifyReply) {
    const { workspaceSlug } = request.params as { workspaceSlug?: string };
    if (!workspaceSlug) return;
    const list = (await deliveryLists()).get(workspaceSlug);
    if (!list) return;
    let allowed = false;
    try {
      allowed = ipAllowed(list, request.ip);
    } catch {
      allowed = false;
    }
    if (!allowed) return ipDenied(reply, request.ip);
  }

  function forgetApiKey(keyId: string) {
    for (const [hash, entry] of keyCache) {
      if (entry.keyId === keyId) keyCache.delete(hash);
    }
  }

  function touchLastUsed(entry: CachedKey, now: number) {
    if (now - entry.lastUsedWrite < LAST_USED_WRITE_INTERVAL_MS) return;
    entry.lastUsedWrite = now;
    const data = { lastUsedAt: new Date(now) };
    (entry.instance
      ? systemDb.instanceApiKey.update({ where: { id: entry.keyId }, data })
      : entry.organizationId
        ? systemDb.orgApiKey.update({ where: { id: entry.keyId }, data })
        : systemDb.apiKey.update({ where: { id: entry.keyId }, data })
    ).catch((err: unknown) => logger.error('Failed to update API key lastUsedAt', err as Error));
  }

  /** INST-33: an instance key as a cache entry (null when unknown, revoked or its creator
   * is suspended). */
  async function loadInstanceKey(keyId: string, secret: string | null, now: number) {
    const record = await systemDb.instanceApiKey.findUnique({ where: { id: keyId } });
    if (!record || record.revokedAt) return null;
    if (secret !== null && !(await argon2.verify(record.keyHash, secret))) return null;
    const creator = await systemDb.user.findUnique({
      where: { id: record.createdBy },
      select: { suspendedAt: true },
    });
    if (creator?.suspendedAt) return null;
    return {
      keyId: record.id,
      instance: true,
      workspaceId: '',
      scopes: record.scopes,
      moduleIds: [],
      expiresAt: record.expiresAt,
      gracePeriodEnd: null,
      lastUsedWrite: record.lastUsedAt?.getTime() ?? 0,
      cachedUntil: now + KEY_CACHE_TTL_MS,
    } satisfies CachedKey;
  }

  /** ORG-13: an organization key as a cache entry (null when unknown or revoked). */
  async function loadOrgKey(keyId: string, secret: string | null, now: number) {
    const record = await systemDb.orgApiKey.findUnique({
      where: { id: keyId },
      include: { organization: { select: { deletedAt: true } } },
    });
    if (!record || record.revokedAt || record.organization.deletedAt) return null;
    if (
      record.createdBy &&
      (await systemDb.user.count({
        where: { id: record.createdBy, suspendedAt: { not: null } },
      }))
    ) {
      return null; // SES-04
    }
    if (secret !== null && !(await argon2.verify(record.keyHash, secret))) return null;
    return {
      keyId: record.id,
      workspaceId: '',
      organizationId: record.organizationId,
      workspaceIds: record.workspaceScope,
      scopes: record.scopes,
      moduleIds: record.moduleScope,
      expiresAt: record.expiresAt,
      gracePeriodEnd: record.gracePeriodEnd,
      lastUsedWrite: record.lastUsedAt?.getTime() ?? 0,
      cachedUntil: now + KEY_CACHE_TTL_MS,
    } satisfies CachedKey;
  }

  /** A workspace key as a cache entry (null when unknown or revoked). */
  async function loadWorkspaceKey(keyId: string, secret: string | null, now: number) {
    const record = await systemDb.apiKey.findUnique({
      where: { id: keyId },
      include: { creator: { select: { suspendedAt: true } } },
    });
    // SES-04: keys of a suspended creator stop until they are unsuspended.
    if (!record || record.revokedAt || record.creator?.suspendedAt) return null;
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
    ...(entry.instance && { instance: true }),
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
      entry = cached.instance
        ? await loadInstanceKey(cached.keyId, null, now)
        : cached.organizationId
          ? await loadOrgKey(cached.keyId, null, now)
          : await loadWorkspaceKey(cached.keyId, null, now);
      if (entry) {
        entry.cachedUntil = cached.cachedUntil;
        entry.lastUsedWrite = Math.max(entry.lastUsedWrite, cached.lastUsedWrite);
      }
    } else {
      const instanceKey = parseInstanceApiKey(raw);
      const orgKey = instanceKey ? null : parseOrgApiKey(raw);
      const parsed = instanceKey ?? orgKey ?? parseApiKey(raw);
      entry = !parsed
        ? null
        : instanceKey
          ? await loadInstanceKey(instanceKey.keyId, instanceKey.secret, now)
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
    // SES-04: a suspended user's tokens stop working at once.
    if (!user || user.suspendedAt) return null;
    // SES-02: an ended session's access tokens stop too (checked every few seconds).
    if (claims.sessionId && !(await sessionAlive(claims.sessionId))) return null;
    return {
      type: 'user',
      id: user.id,
      email: user.email,
      isInstanceAdmin: !!user.InstanceAdmin && !user.InstanceAdmin.revokedAt,
      ...(claims.provider && { provider: claims.provider }),
      ...(claims.sessionId && { sessionId: claims.sessionId }),
      ...(claims.mfa && { mfa: true }),
      ...(claims.reauthAt && { reauthAt: claims.reauthAt }),
      ...(user.InstanceAdmin &&
        !user.InstanceAdmin.revokedAt && { instanceRole: asAdminRole(user.InstanceAdmin.role) }),
    };
  }

  const sessions = new Map<string, { alive: boolean; until: number }>();
  const SESSION_CHECK_MS = 15_000;
  async function sessionAlive(sessionId: string) {
    const now = Date.now();
    const hit = sessions.get(sessionId);
    if (hit && hit.until > now) return hit.alive;
    const alive = !!(await systemDb.refreshToken.findFirst({
      where: { familyId: sessionId, revokedAt: null },
      select: { id: true },
    }));
    if (sessions.size > 20_000) sessions.clear();
    sessions.set(sessionId, { alive, until: now + SESSION_CHECK_MS });
    return alive;
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
      return user && !user.suspendedAt
        ? {
            type: 'user',
            id: user.id,
            email: user.email,
            isInstanceAdmin: !!user.InstanceAdmin && !user.InstanceAdmin.revokedAt,
            ...(user.InstanceAdmin &&
              !user.InstanceAdmin.revokedAt && {
                instanceRole: asAdminRole(user.InstanceAdmin.role),
              }),
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
      if (key.createdBy) {
        const creator = await systemDb.user.findUnique({
          where: { id: key.createdBy },
          select: { suspendedAt: true },
        });
        if (creator?.suspendedAt) return null; // SES-04
      }
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
    const principal = await resolvePrincipal(request);
    if (!principal) {
      return deny(reply, 401, 'UNAUTHORIZED', 'Missing, invalid, expired or revoked credentials');
    }
    // INST-33: instance keys are for `/api/admin` only.
    if (principal.type === 'apiKey' && principal.instance) {
      return deny(reply, 403, 'FORBIDDEN', 'Instance keys only work on /api/admin');
    }
  };

  // INST-32: the admin network allowlist (validated at startup).
  const adminAllowlist = fastify.config.adminIpAllowlist;
  parseAllowlist(adminAllowlist);

  /**
   * INST-31..33: instance admins and instance keys on `/api/admin`. The route's capability
   * comes from `requirementOf` (reads for every role, writes as listed, others owners only);
   * destructive actions need a re-authentication in the last 10 minutes.
   */
  const requireInstanceAdmin: Handler = async (request, reply) => {
    const principal = await resolvePrincipal(request);
    if (!principal) return deny(reply, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');
    if (adminAllowlist.length && !ipAllowed(adminAllowlist, request.ip)) {
      return deny(reply, 403, 'IP_NOT_ALLOWED', `Access from ${request.ip} is not allowed here`);
    }
    const need = requirementOf(
      request.method,
      request.routeOptions.url ?? request.url,
      request.params as Record<string, string>
    );
    if (principal.type === 'apiKey') {
      if (!principal.instance) {
        return deny(reply, 403, 'FORBIDDEN', 'Not an active Instance Admin');
      }
      const scope = need.capability === 'read' ? 'instance:read' : 'instance:admin';
      if (need.keyManagement && need.capability !== 'read') {
        return deny(reply, 403, 'FORBIDDEN', 'Instance keys cannot manage admins or keys');
      }
      if (!principal.scopes.includes(scope) && !principal.scopes.includes('instance:admin')) {
        return deny(reply, 403, 'FORBIDDEN', `This key lacks the ${scope} scope`);
      }
      return;
    }
    if (!principal.isInstanceAdmin || ssoScope(principal)) {
      return deny(reply, 403, 'FORBIDDEN', 'Not an active Instance Admin');
    }
    // INST-32: admins prove a second factor (or use the instance's own SSO).
    if (
      fastify.config.adminRequireMfa &&
      !principal.mfa &&
      !request.internal &&
      principal.provider !== 'oidc'
    ) {
      return deny(
        reply,
        403,
        'ADMIN_MFA_REQUIRED',
        'Instance administration needs multi-factor authentication: set it up in your account, then sign in again'
      );
    }
    const role = principal.instanceRole ?? 'instance_owner';
    if (!adminRoleAllows(role, need.capability)) {
      return deny(reply, 403, 'FORBIDDEN', `The ${role} role can't do this`);
    }
    if (
      need.destructive &&
      !request.internal &&
      (!principal.reauthAt || Date.now() - principal.reauthAt > REAUTH_WINDOW_MS)
    ) {
      return deny(
        reply,
        403,
        'REAUTH_REQUIRED',
        'Confirm it is you (re-authenticate) before this action'
      );
    }
  };

  type LoadedWorkspace = Workspace & { organization: { suspendedAt: Date | null } | null };

  /**
   * INST-09 / TLC-04: a suspended workspace, or a workspace of a suspended organization,
   * stays readable (and its manifests served) but refuses every change, including scheduled
   * and approved ones (they run through these routes). TLC-02: a deleted workspace answers
   * 410 to everything except the routes that restore it.
   */
  function lifecycleRefusal(
    workspace: LoadedWorkspace,
    permission: Permission,
    opts: { allowDeleted?: boolean }
  ): [number, string, string] | null {
    if (workspace.deletedAt && !opts.allowDeleted) {
      return [
        410,
        'WORKSPACE_DELETED',
        `This workspace was deleted; it can be restored until ${workspace.purgeAfter?.toISOString() ?? 'it is purged'}`,
      ];
    }
    if (permission === 'workspace:read') return null;
    if (workspace.suspendedAt) {
      return [
        403,
        'WORKSPACE_SUSPENDED',
        'This workspace is suspended by the instance administrator; changes are disabled',
      ];
    }
    if (workspace.organization?.suspendedAt) {
      return [
        403,
        'ORGANIZATION_SUSPENDED',
        "This workspace's organization is suspended by the instance administrator; changes are disabled",
      ];
    }
    return null;
  }

  function requireWorkspace(
    permission: Permission,
    opts: { allowInstanceAdmin?: boolean; allowDeleted?: boolean } = {}
  ): Handler {
    return async (request, reply) => {
      const principal = await resolvePrincipal(request);
      if (!principal) return deny(reply, 401, 'UNAUTHORIZED', 'Missing or invalid credentials');

      const { workspaceSlug } = request.params as { workspaceSlug?: string };
      const workspace: LoadedWorkspace | null = workspaceSlug
        ? await systemDb.workspace.findUnique({
            where: { slug: workspaceSlug },
            include: { organization: { select: { suspendedAt: true } } },
          })
        : null;

      if (principal.type === 'apiKey') {
        if (principal.instance) {
          return deny(reply, 403, 'FORBIDDEN', 'Instance keys never reach workspaces');
        }
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
        const refusal = lifecycleRefusal(workspace, permission, opts);
        if (refusal) return deny(reply, ...refusal);
        if (await ipRefusal(request, reply, workspace)) return reply;
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

      // INST-31: through `/api/workspaces`, other admin roles only read.
      if (
        opts.allowInstanceAdmin &&
        principal.isInstanceAdmin &&
        (request.method === 'GET' ||
          (principal.instanceRole ?? 'instance_owner') === 'instance_owner')
      ) {
        const refusal = lifecycleRefusal(workspace, permission, opts);
        if (refusal) return deny(reply, ...refusal);
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
      const refusal = lifecycleRefusal(workspace, permission, opts);
      if (refusal) return deny(reply, ...refusal);
      if (await ipRefusal(request, reply, workspace)) return reply;
      request.workspace = workspace;
      request.workspaceRole = membership.role;
      request.viaOrgAdmin = !!orgAdminRole;
    };
  }

  fastify.decorate('authenticate', authenticate);
  fastify.decorate('requireWorkspace', requireWorkspace);
  fastify.decorate('requireInstanceAdmin', requireInstanceAdmin);
  fastify.decorate('forgetApiKey', forgetApiKey);
  fastify.decorate('ipAllowedForOrg', ipAllowedForOrg);
  fastify.decorate('requireDeliveryIp', requireDeliveryIp);
  fastify.decorate('forgetApiKeys', () => keyCache.clear());
  fastify.decorate('forgetSession', (sessionId: string) => sessions.delete(sessionId));
  fastify.decorate('mfaRequiredBy', mfaRequiredBy);
  fastify.decorate('forgetOrgPolicy', (organizationId: string) => {
    ipPolicies.delete(organizationId);
    delivery.expires = 0;
  });
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
