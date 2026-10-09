import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiKey, Role } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import { ApiKeyCreateSchema } from '@harmoniq/core/dist/schemas/ApiKeyCreateSchema';
import { displayPrefix, formatApiKey, generateApiKeySecret } from '../auth/apiKeys';
import { audit } from '../services/audit';

type WsParams = { workspaceSlug: string };

const RoleSchema = z.enum(['owner', 'admin', 'developer', 'viewer']);
const InviteSchema = z.object({ email: z.string().email(), role: RoleSchema });
const RoleChangeSchema = z.object({ role: RoleSchema });
const RotateSchema = z.object({
  /** KEY-05: how long the old key keeps working. */
  gracePeriodHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(24),
});

/** Whether the key works right now, so clients don't need to compare timestamps. */
function keyStatus(k: ApiKey, now = Date.now()): 'active' | 'rotating' | 'expired' | 'revoked' {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && k.expiresAt.getTime() <= now) return 'expired';
  if (k.gracePeriodEnd) return k.gracePeriodEnd.getTime() <= now ? 'expired' : 'rotating';
  return 'active';
}

function keyDto(k: ApiKey) {
  return {
    status: keyStatus(k),
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    moduleIds: k.moduleIds,
    createdAt: k.createdAt.toISOString(),
    createdBy: k.createdBy,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    gracePeriodEnd: k.gracePeriodEnd?.toISOString() ?? null,
  };
}

const accessRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };

  /** Keys and memberships are managed by people, not by other keys. */
  function requireUser(request: FastifyRequest) {
    if (request.principal?.type !== 'user') {
      throw new ForbiddenError('This action requires a signed-in user');
    }
    return request.principal;
  }

  async function issueKey(
    request: FastifyRequest,
    data: Pick<ApiKey, 'name' | 'scopes' | 'moduleIds' | 'expiresAt'>
  ) {
    const user = requireUser(request);
    const workspace = request.workspace!;
    const { secret, keyHash } = await generateApiKeySecret();
    const record = await withTenant(workspace.id, async (tx) => {
      if (data.moduleIds.length) {
        const found = await tx.remoteModule.count({ where: { id: { in: data.moduleIds } } });
        if (found !== data.moduleIds.length) {
          throw new BadRequestError('moduleIds must be modules in this workspace');
        }
      }
      const created = await tx.apiKey.create({
        data: {
          ...data,
          workspaceId: workspace.id,
          keyHash,
          prefix: 'pending',
          createdBy: user.id,
        },
      });
      return tx.apiKey.update({
        where: { id: created.id },
        data: { prefix: displayPrefix(created.id) },
      });
    });
    return { record, raw: formatApiKey(record.id, secret) };
  }

  // ─── API keys (KEY-01..05) ────────────────────────────────────────────────

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/api-keys',
    admin,
    async (request) => {
      const keys = await withTenant(request.workspace!.id, (tx) =>
        tx.apiKey.findMany({ orderBy: { createdAt: 'desc' } })
      );
      return { keys: keys.map(keyDto) };
    }
  );

  fastify.post<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/api-keys',
    admin,
    async (request, reply) => {
      const body = ApiKeyCreateSchema.parse(request.body);
      const { record, raw } = await issueKey(request, {
        name: body.name,
        scopes: body.scopes,
        moduleIds: body.moduleIds,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      await withTenant(request.workspace!.id, (tx) =>
        audit(tx, request.workspace!.id, actor(request), {
          action: 'apiKey.create',
          resourceType: 'apiKey',
          resourceId: record.id,
          metadata: { name: record.name, scopes: record.scopes, moduleIds: record.moduleIds },
        })
      );
      // The raw key is shown exactly once (KEY-01).
      return reply.code(201).send({ ...keyDto(record), key: raw });
    }
  );

  fastify.delete<{ Params: WsParams & { keyId: string } }>(
    '/api/workspaces/:workspaceSlug/api-keys/:keyId',
    admin,
    async (request) => {
      const workspace = request.workspace!;
      const key = await withTenant(workspace.id, async (tx) => {
        const existing = await tx.apiKey.findUnique({ where: { id: request.params.keyId } });
        if (!existing) throw new NotFoundError('API key not found');
        const revoked = await tx.apiKey.update({
          where: { id: existing.id },
          data: { revokedAt: existing.revokedAt ?? new Date() },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'apiKey.revoke',
          resourceType: 'apiKey',
          resourceId: revoked.id,
          metadata: { name: revoked.name },
        });
        return revoked;
      });
      fastify.forgetApiKey(key.id);
      return keyDto(key);
    }
  );

  fastify.post<{ Params: WsParams & { keyId: string } }>(
    '/api/workspaces/:workspaceSlug/api-keys/:keyId/rotate',
    admin,
    async (request, reply) => {
      const { gracePeriodHours } = RotateSchema.parse(request.body ?? {});
      const workspace = request.workspace!;
      const old = await withTenant(workspace.id, (tx) =>
        tx.apiKey.findUnique({ where: { id: request.params.keyId } })
      );
      if (!old || old.revokedAt) throw new NotFoundError('API key not found');

      const { record, raw } = await issueKey(request, {
        name: old.name,
        scopes: old.scopes,
        moduleIds: old.moduleIds,
        expiresAt: old.expiresAt,
      });
      await withTenant(workspace.id, async (tx) => {
        await tx.apiKey.update({
          where: { id: old.id },
          data: { gracePeriodEnd: new Date(Date.now() + gracePeriodHours * 3600_000) },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'apiKey.rotate',
          resourceType: 'apiKey',
          resourceId: record.id,
          metadata: { replaces: old.id, gracePeriodHours },
        });
      });
      fastify.forgetApiKey(old.id);
      return reply.code(201).send({ ...keyDto(record), key: raw, replaces: old.id });
    }
  );

  // ─── Members (MT-03) ──────────────────────────────────────────────────────

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/members',
    admin,
    async (request) => {
      const members = await withTenant(request.workspace!.id, (tx) =>
        tx.workspaceMember.findMany({
          include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
          orderBy: { invitedAt: 'asc' },
        })
      );
      return {
        members: members.map((m) => ({
          id: m.id,
          role: m.role,
          status: m.joinedAt ? 'active' : 'invited',
          invitedAt: m.invitedAt.toISOString(),
          joinedAt: m.joinedAt?.toISOString() ?? null,
          user: m.user,
        })),
      };
    }
  );

  /** Only owners can create, change or remove owners. */
  function assertCanAssign(request: FastifyRequest, role: Role) {
    const isOwner = request.principal?.type === 'user' && request.workspaceRole === 'owner';
    if (role === 'owner' && !isOwner) throw new ForbiddenError('Only owners can manage owners');
  }

  fastify.post<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/members',
    admin,
    async (request, reply) => {
      requireUser(request);
      const body = InviteSchema.parse(request.body);
      assertCanAssign(request, body.role);
      const workspace = request.workspace!;
      const email = body.email.trim().toLowerCase();

      const member = await withTenant(workspace.id, async (tx) => {
        // The invitee may not have signed in yet: create the user now; their first sign-in
        // with this verified email links to it and accepts the invitation.
        const user =
          (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) ??
          (await tx.user.create({ data: { email } }));
        const existing = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
        });
        if (existing) throw new ConflictError(`${email} is already a member`);
        const created = await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: user.id, role: body.role },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'member.invite',
          resourceType: 'member',
          resourceId: created.id,
          metadata: { email, role: body.role },
        });
        return created;
      });
      return reply.code(201).send({ id: member.id, email, role: member.role, status: 'invited' });
    }
  );

  async function ownerCount(tx: Parameters<Parameters<typeof withTenant>[1]>[0]) {
    return tx.workspaceMember.count({ where: { role: 'owner', joinedAt: { not: null } } });
  }

  fastify.patch<{ Params: WsParams & { memberId: string } }>(
    '/api/workspaces/:workspaceSlug/members/:memberId',
    admin,
    async (request) => {
      requireUser(request);
      const { role } = RoleChangeSchema.parse(request.body);
      const workspace = request.workspace!;
      return withTenant(workspace.id, async (tx) => {
        const member = await tx.workspaceMember.findUnique({
          where: { id: request.params.memberId },
        });
        if (!member) throw new NotFoundError('Member not found');
        assertCanAssign(request, member.role);
        assertCanAssign(request, role);
        if (member.role === 'owner' && role !== 'owner' && (await ownerCount(tx)) <= 1) {
          throw new ConflictError('A workspace must keep at least one owner');
        }
        const updated = await tx.workspaceMember.update({
          where: { id: member.id },
          data: { role },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'member.role_change',
          resourceType: 'member',
          resourceId: member.id,
          metadata: { from: member.role, to: role },
        });
        return { id: updated.id, role: updated.role };
      });
    }
  );

  fastify.delete<{ Params: WsParams & { memberId: string } }>(
    '/api/workspaces/:workspaceSlug/members/:memberId',
    admin,
    async (request, reply) => {
      requireUser(request);
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const member = await tx.workspaceMember.findUnique({
          where: { id: request.params.memberId },
        });
        if (!member) throw new NotFoundError('Member not found');
        assertCanAssign(request, member.role);
        if (member.role === 'owner' && (await ownerCount(tx)) <= 1) {
          throw new ConflictError('A workspace must keep at least one owner');
        }
        await tx.workspaceMember.delete({ where: { id: member.id } });
        await audit(tx, workspace.id, actor(request), {
          action: 'member.remove',
          resourceType: 'member',
          resourceId: member.id,
          metadata: { userId: member.userId, role: member.role },
        });
      });
      return reply.code(204).send();
    }
  );
};

export default accessRoutes;
