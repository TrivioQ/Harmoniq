// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiKey, Invitation, Role } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import { ApiKeyCreateSchema } from '@harmoniq/core/dist/schemas/ApiKeyCreateSchema';
import { displayPrefix, formatApiKey, generateApiKeySecret } from '../auth/apiKeys';
import { audit } from '../services/audit';
import {
  acceptUrl,
  createInvitation,
  invitationDto,
  renewInvitation,
  sendInvitationEmail,
} from '../services/invitations';

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
  const { withTenant, withOrg } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };

  /** Memberships are managed by people, not by keys. */
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
    // People issue keys. So can an org key with the admin scope (IaC-01: Terraform runs as
    // the org's automation), without handing out more than it has. Workspace keys can't,
    // so a leaked CI key can't mint lasting access.
    const principal = request.principal!;
    if (principal.type === 'apiKey') {
      if (!principal.organizationId || !principal.scopes.includes('admin')) {
        throw new ForbiddenError('Keys are issued by users or by an org key with the admin scope');
      }
      if (
        principal.moduleIds.length > 0 &&
        (!data.moduleIds.length || data.moduleIds.some((id) => !principal.moduleIds.includes(id)))
      ) {
        throw new ForbiddenError('A key cannot issue a key with more access than itself');
      }
    } else {
      requireUser(request);
    }
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
          ...(principal.type === 'apiKey'
            ? { createdByKeyId: principal.id }
            : { createdBy: principal.id }),
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
      const workspace = request.workspace!;
      const { members, invitations } = await withTenant(workspace.id, async (tx) => ({
        members: await tx.workspaceMember.findMany({
          where: { joinedAt: { not: null } },
          include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
          orderBy: { invitedAt: 'asc' },
        }),
        invitations: await tx.invitation.findMany({
          where: { workspaceId: workspace.id, acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
      }));
      // PPL-06: org admins administer the workspace without a membership; show them too.
      const memberIds = new Set(members.map((m) => m.userId));
      const orgAdmins = workspace.organizationId
        ? (
            await withOrg(workspace.organizationId, (tx) =>
              tx.organizationMember.findMany({
                where: { organizationId: workspace.organizationId!, role: 'org_admin' },
                include: {
                  user: { select: { id: true, email: true, name: true, avatarUrl: true } },
                },
              })
            )
          ).filter((m) => !memberIds.has(m.userId))
        : [];
      const ownerless = !members.some((m) => m.role === 'owner');
      return {
        members: [
          ...members.map((m) => ({
            id: m.id,
            role: m.role,
            status: 'active' as const,
            source: m.orgProvisioned ? ('org_rules' as const) : ('member' as const),
            invitedAt: m.invitedAt.toISOString(),
            joinedAt: m.joinedAt?.toISOString() ?? null,
            user: m.user,
          })),
          ...orgAdmins.map((m) => ({
            id: null,
            role: ownerless ? ('owner' as const) : ('admin' as const),
            status: 'active' as const,
            source: 'org_admin' as const,
            invitedAt: null,
            joinedAt: null,
            user: m.user,
          })),
        ],
        invitations: invitations.map(invitationDto),
      };
    }
  );

  /**
   * Only owners can create, change or remove owners, and admins of the workspace's
   * organization (TLC-05): otherwise a workspace without a joined owner could never get one.
   */
  function assertCanAssign(request: FastifyRequest, role: Role) {
    const canManageOwners =
      request.principal?.type === 'user' &&
      (request.workspaceRole === 'owner' || !!request.viaOrgAdmin);
    if (role === 'owner' && !canManageOwners) {
      throw new ForbiddenError('Only owners and organization admins can manage owners');
    }
  }

  /** PPL-02: emails the invitation when possible; the link goes back to the inviter too. */
  async function deliver(request: FastifyRequest, invitation: Invitation, token: string) {
    const workspace = request.workspace!;
    const url = acceptUrl(fastify.config.webOrigin, token);
    const emailed = await sendInvitationEmail(
      {
        mailer: fastify.container.mailer,
        instanceName: fastify.container.settings.branding().name,
        logger: fastify.container.logger,
      },
      {
        email: invitation.email,
        url,
        kind: 'workspace',
        name: workspace.name,
        role: invitation.role,
        inviter: request.principal?.type === 'user' ? request.principal.email : null,
      }
    );
    if (emailed) {
      await withTenant(workspace.id, (tx) =>
        tx.invitation.update({ where: { id: invitation.id }, data: { lastSentAt: new Date() } })
      );
    }
    return { acceptUrl: url, emailed };
  }

  /**
   * PPL-01: invites someone by email. Nothing is granted until they accept (the emailed
   * link, or signing in with that email). `POST …/members` is the original path.
   */
  const invite = async (request: FastifyRequest<{ Params: WsParams }>, reply: FastifyReply) => {
    const principal = requireUser(request);
    const body = InviteSchema.parse(request.body);
    assertCanAssign(request, body.role);
    const workspace = request.workspace!;
    const email = body.email.trim().toLowerCase();
    const { invitation, token } = await withTenant(workspace.id, async (tx) => {
      const existing = await tx.workspaceMember.findFirst({
        where: { joinedAt: { not: null }, user: { email: { equals: email, mode: 'insensitive' } } },
      });
      if (existing) throw new ConflictError(`${email} is already a member`);
      const created = await createInvitation(
        tx,
        { workspaceId: workspace.id },
        { email, role: body.role, invitedBy: `user:${principal.id}` }
      );
      await audit(tx, workspace.id, actor(request), {
        action: 'member.invite',
        resourceType: 'invitation',
        resourceId: created.invitation.id,
        metadata: { email, role: body.role },
      });
      return created;
    });
    const delivery = await deliver(request, invitation, token);
    return reply.code(201).send({ ...invitationDto(invitation), status: 'invited', ...delivery });
  };
  fastify.post<{ Params: WsParams }>('/api/workspaces/:workspaceSlug/members', admin, invite);
  fastify.post<{ Params: WsParams }>('/api/workspaces/:workspaceSlug/invitations', admin, invite);

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/invitations',
    admin,
    async (request) => {
      const invitations = await withTenant(request.workspace!.id, (tx) =>
        tx.invitation.findMany({
          where: { workspaceId: request.workspace!.id },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      );
      return { invitations: invitations.map(invitationDto) };
    }
  );

  const findInvitation = async (tx: TenantTx, request: FastifyRequest, id: string) => {
    const invitation = await tx.invitation.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!invitation) throw new NotFoundError('Invitation not found');
    return invitation;
  };

  /** PPL-01: a new link and expiry, emailed again. */
  fastify.post<{ Params: WsParams & { invitationId: string } }>(
    '/api/workspaces/:workspaceSlug/invitations/:invitationId/resend',
    admin,
    async (request) => {
      requireUser(request);
      const workspace = request.workspace!;
      const { invitation, token } = await withTenant(workspace.id, async (tx) => {
        const current = await findInvitation(tx, request, request.params.invitationId);
        assertCanAssign(request, current.role as Role);
        const renewed = await renewInvitation(tx, current);
        await audit(tx, workspace.id, actor(request), {
          action: 'member.invite_resend',
          resourceType: 'invitation',
          resourceId: current.id,
          metadata: { email: current.email },
        });
        return renewed;
      });
      return { ...invitationDto(invitation), ...(await deliver(request, invitation, token)) };
    }
  );

  fastify.delete<{ Params: WsParams & { invitationId: string } }>(
    '/api/workspaces/:workspaceSlug/invitations/:invitationId',
    admin,
    async (request, reply) => {
      requireUser(request);
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const current = await findInvitation(tx, request, request.params.invitationId);
        assertCanAssign(request, current.role as Role);
        if (current.acceptedAt) throw new ConflictError('This invitation was already accepted');
        await tx.invitation.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
        await audit(tx, workspace.id, actor(request), {
          action: 'member.invite_revoke',
          resourceType: 'invitation',
          resourceId: current.id,
          metadata: { email: current.email },
        });
      });
      return reply.code(204).send();
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

  /** PPL-05: the API keys the member created here are revoked too, unless `?keepKeys=true`. */
  fastify.delete<{ Params: WsParams & { memberId: string }; Querystring: { keepKeys?: string } }>(
    '/api/workspaces/:workspaceSlug/members/:memberId',
    admin,
    async (request, reply) => {
      requireUser(request);
      const workspace = request.workspace!;
      const revokeKeys = request.query.keepKeys !== 'true';
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
        const keys = revokeKeys
          ? await tx.apiKey.updateMany({
              where: { createdBy: member.userId, revokedAt: null },
              data: { revokedAt: new Date() },
            })
          : { count: 0 };
        await audit(tx, workspace.id, actor(request), {
          action: 'member.remove',
          resourceType: 'member',
          resourceId: member.id,
          metadata: { userId: member.userId, role: member.role, apiKeysRevoked: keys.count },
        });
      });
      return reply.code(204).send();
    }
  );
};

export default accessRoutes;
