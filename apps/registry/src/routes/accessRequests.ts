// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AccessRequest, Role } from '@prisma/client';
import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import type { TenantTx } from '@harmoniq/db';
import { ssoScope } from '../plugins/authenticate';
import { audit } from '../services/audit';

const RequestSchema = z.object({
  role: z.enum(['viewer', 'developer', 'admin']).default('viewer'),
  message: z.string().trim().max(500).optional(),
});
const DecisionSchema = z.object({ role: z.enum(['viewer', 'developer', 'admin']).optional() });

/**
 * PPL-07: an organization member who isn't in one of its workspaces asks to join; the
 * workspace's admins approve (with the requested or another role, never owner) or deny.
 */
const accessRequestRoutes: FastifyPluginAsync = async (fastify) => {
  // eslint-disable-next-line no-restricted-syntax -- MT-09: the requester isn't a member yet, so the workspace is resolved by slug (tenant resolution)
  const { systemDb, withTenant } = fastify.container;
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };

  fastify.post<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/access-requests',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const principal = request.principal!;
      if (principal.type !== 'user') throw new ForbiddenError('Access is requested by people');
      const body = RequestSchema.parse(request.body ?? {});
      // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
      const workspace = await systemDb.workspace.findUnique({
        where: { slug: request.params.workspaceSlug },
        include: { organization: { select: { slug: true, deletedAt: true } } },
      });
      // Only the organization's members may ask; anyone else gets 404, as for workspaces.
      const orgMember =
        workspace?.organizationId &&
        // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
        (await systemDb.organizationMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: workspace.organizationId,
              userId: principal.id,
            },
          },
        }));
      if (!workspace || !orgMember || workspace.organization?.deletedAt) {
        throw new NotFoundError('Workspace not found');
      }
      if (workspace.deletedAt) throw new GoneError('This workspace was deleted');
      const scope = ssoScope(principal);
      if (
        scope &&
        !(scope.kind === 'organization' && scope.slug === workspace.organization?.slug)
      ) {
        throw new ForbiddenError('Sign in another way to request access');
      }
      const created = await withTenant(workspace.id, async (tx) => {
        const member = await tx.workspaceMember.findFirst({
          where: { workspaceId: workspace.id, userId: principal.id, joinedAt: { not: null } },
        });
        if (member) throw new ConflictError('You are already a member of this workspace');
        const pending = await tx.accessRequest.findFirst({
          where: { workspaceId: workspace.id, userId: principal.id, status: 'pending' },
        });
        if (pending) throw new ConflictError('You already asked; an admin will decide');
        const created = await tx.accessRequest.create({
          data: {
            workspaceId: workspace.id,
            userId: principal.id,
            role: body.role,
            message: body.message,
          },
        });
        await audit(
          tx,
          workspace.id,
          { principal, ip: request.ip },
          {
            action: 'access_request.create',
            resourceType: 'access_request',
            resourceId: created.id,
            metadata: { role: body.role },
          }
        );
        return created;
      });
      return reply.code(201).send({ id: created.id, status: created.status, role: created.role });
    }
  );

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/access-requests',
    admin,
    async (request) => {
      const requests = await withTenant(request.workspace!.id, (tx) =>
        tx.accessRequest.findMany({
          where: { workspaceId: request.workspace!.id, status: 'pending' },
          orderBy: { createdAt: 'asc' },
        })
      );
      // eslint-disable-next-line no-restricted-syntax -- MT-09: users are global
      const users = await systemDb.user.findMany({
        where: { id: { in: requests.map((r) => r.userId) } },
        select: { id: true, email: true, name: true },
      });
      const userOf = new Map(users.map((u) => [u.id, u]));
      return {
        requests: requests.map((r) => ({
          id: r.id,
          role: r.role,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
          user: userOf.get(r.userId) ?? null,
        })),
      };
    }
  );

  async function pending(tx: TenantTx, workspaceId: string, id: string): Promise<AccessRequest> {
    const found = await tx.accessRequest.findFirst({
      where: { id, workspaceId, status: 'pending' },
    });
    if (!found) throw new NotFoundError('Access request not found');
    return found;
  }

  fastify.post<{ Params: { workspaceSlug: string; requestId: string } }>(
    '/api/workspaces/:workspaceSlug/access-requests/:requestId/approve',
    admin,
    async (request) => {
      const { role } = DecisionSchema.parse(request.body ?? {});
      const workspace = request.workspace!;
      await fastify.container.quotas.require({ workspaceId: workspace.id }, 'members'); // PLN-04
      return withTenant(workspace.id, async (tx) => {
        const found = await pending(tx, workspace.id, request.params.requestId);
        const granted = (role ?? found.role) as Role;
        const member = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: found.userId } },
        });
        if (!member) {
          await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              userId: found.userId,
              role: granted,
              joinedAt: new Date(),
            },
          });
        }
        await tx.accessRequest.update({
          where: { id: found.id },
          data: { status: 'approved', decidedBy: request.principal!.id, decidedAt: new Date() },
        });
        await audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          {
            action: 'access_request.approve',
            resourceType: 'access_request',
            resourceId: found.id,
            metadata: { userId: found.userId, role: granted },
          }
        );
        return { id: found.id, status: 'approved', role: granted };
      });
    }
  );

  fastify.post<{ Params: { workspaceSlug: string; requestId: string } }>(
    '/api/workspaces/:workspaceSlug/access-requests/:requestId/deny',
    admin,
    async (request) => {
      const workspace = request.workspace!;
      return withTenant(workspace.id, async (tx) => {
        const found = await pending(tx, workspace.id, request.params.requestId);
        await tx.accessRequest.update({
          where: { id: found.id },
          data: { status: 'denied', decidedBy: request.principal!.id, decidedAt: new Date() },
        });
        await audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          {
            action: 'access_request.deny',
            resourceType: 'access_request',
            resourceId: found.id,
            metadata: { userId: found.userId },
          }
        );
        return { id: found.id, status: 'denied' };
      });
    }
  );
};

export default accessRequestRoutes;
