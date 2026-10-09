import fp from 'fastify-plugin';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Role, Workspace } from '@prisma/client';
import { isApiKeyFormat, parseApiKey } from '../auth/apiKeys';
import { Permission, roleAllows, scopesAllow } from '../auth/permissions';
import { verifyAccessToken } from '../auth/tokens';

export type Principal =
  | { type: 'apiKey'; id: string; workspaceId: string; scopes: string[]; moduleIds: string[] }
  | { type: 'user'; id: string; email: string; isInstanceAdmin: boolean };

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Set by `requireWorkspace` once access has been verified. */
    workspace?: Workspace;
    /** The user's role in `workspace` (undefined for API keys and instance-admin access). */
    workspaceRole?: Role;
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
    systemDb.apiKey
      .update({ where: { id: entry.keyId }, data: { lastUsedAt: new Date(now) } })
      .catch((err: unknown) => logger.error('Failed to update API key lastUsedAt', err as Error));
  }

  async function resolveApiKey(raw: string): Promise<Principal | null> {
    const now = Date.now();
    const tokenHash = createHash('sha256').update(raw).digest('hex');

    let entry = keyCache.get(tokenHash);
    if (!entry || entry.cachedUntil <= now) {
      keyCache.delete(tokenHash);
      const parsed = parseApiKey(raw);
      if (!parsed) return null;

      const record = await systemDb.apiKey.findUnique({ where: { id: parsed.keyId } });
      if (!record || record.revokedAt) return null;
      if (!(await argon2.verify(record.keyHash, parsed.secret))) return null;

      entry = {
        keyId: record.id,
        workspaceId: record.workspaceId,
        scopes: record.scopes,
        moduleIds: record.moduleIds,
        expiresAt: record.expiresAt,
        gracePeriodEnd: record.gracePeriodEnd,
        lastUsedWrite: record.lastUsedAt?.getTime() ?? 0,
        cachedUntil: now + KEY_CACHE_TTL_MS,
      };
      if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
      keyCache.set(tokenHash, entry);
    }

    // Re-checked on every request so a cached key still stops working on time.
    if (!keyIsUsable(entry, now)) return null;
    touchLastUsed(entry, now);

    return {
      type: 'apiKey',
      id: entry.keyId,
      workspaceId: entry.workspaceId,
      scopes: entry.scopes,
      moduleIds: entry.moduleIds,
    };
  }

  async function resolveSession(token: string): Promise<Principal | null> {
    let claims;
    try {
      claims = await verifyAccessToken(token, jwtSecret);
    } catch {
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
      if (!key || key.revokedAt || !keyIsUsable(key, Date.now())) return null;
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
    if (principal.type !== 'user' || !principal.isInstanceAdmin) {
      return deny(reply, 403, 'FORBIDDEN', 'Not an active Instance Admin');
    }
  };

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
        // A key is only ever valid for the workspace that issued it.
        if (!workspace || workspace.id !== principal.workspaceId) {
          return deny(reply, 403, 'FORBIDDEN', 'API key is not valid for this workspace');
        }
        if (!scopesAllow(principal.scopes, permission)) {
          return deny(reply, 403, 'FORBIDDEN', `API key lacks a scope granting ${permission}`);
        }
        request.workspace = workspace;
        return;
      }

      // Users: non-members get 404 so workspace slugs can't be probed.
      if (!workspace) return deny(reply, 404, 'NOT_FOUND', 'Workspace not found');

      if (opts.allowInstanceAdmin && principal.isInstanceAdmin) {
        request.workspace = workspace;
        return;
      }

      const membership = await systemDb.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: principal.id } },
      });
      if (!membership?.joinedAt) return deny(reply, 404, 'NOT_FOUND', 'Workspace not found');
      if (!roleAllows(membership.role, permission)) {
        return deny(reply, 403, 'FORBIDDEN', `Your role does not grant ${permission}`);
      }
      request.workspace = workspace;
      request.workspaceRole = membership.role;
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
export function canAccessModule(principal: Principal | undefined, moduleId: string): boolean {
  if (principal?.type !== 'apiKey' || principal.moduleIds.length === 0) return true;
  return principal.moduleIds.includes(moduleId);
}

export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['app-container'],
});
