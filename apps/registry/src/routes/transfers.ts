// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OwnershipTransfer } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import type { TenantTx } from '@harmoniq/db';
import { audit } from '../services/audit';

/** TLC-06: how long a transfer waits for the recipient. */
export const TRANSFER_DAYS = 7;
const TransferRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export const transferDto = (t: OwnershipTransfer) => ({
  id: t.id,
  expiresAt: t.expiresAt.toISOString(),
  createdAt: t.createdAt.toISOString(),
});

/**
 * Proposes a handover in the current scope: earlier pending transfers from the same sender
 * are cancelled, so only one waits at a time.
 */
export async function proposeTransfer(
  tx: TenantTx,
  scope: { workspaceId: string } | { organizationId: string },
  fromUserId: string,
  toUserId: string
) {
  const now = new Date();
  await tx.ownershipTransfer.updateMany({
    where: { ...scope, fromUserId, acceptedAt: null, cancelledAt: null },
    data: { cancelledAt: now },
  });
  return tx.ownershipTransfer.create({
    data: {
      ...scope,
      fromUserId,
      toUserId,
      expiresAt: new Date(now.getTime() + TRANSFER_DAYS * 86_400_000),
    },
  });
}

/**
 * TLC-06: ownership transfers. A workspace owner hands the workspace to a member, an org
 * admin hands the admin seat to an org member (in the organization routes); the recipient
 * accepts, and the sender steps down to admin (workspace) or org_member (organization).
 */
const transferRoutes: FastifyPluginAsync = async (fastify) => {
  // eslint-disable-next-line no-restricted-syntax -- MT-09: transfers are resolved by id (tenant resolution) and listed per user across tenants
  const { systemDb, withTenant, withOrg } = fastify.container;

  const requireUser = (request: FastifyRequest) => {
    const principal = request.principal!;
    if (principal.type !== 'user') throw new ForbiddenError('Transfers are made by people');
    return principal;
  };

  fastify.post<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/transfer',
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    async (request, reply) => {
      const principal = requireUser(request);
      const { email } = TransferRequestSchema.parse(request.body);
      const workspace = request.workspace!;
      const transfer = await withTenant(workspace.id, async (tx) => {
        const member = await tx.workspaceMember.findFirst({
          where: { workspaceId: workspace.id, joinedAt: { not: null }, user: { email } },
        });
        if (!member) throw new BadRequestError(`${email} is not a member of this workspace`);
        if (member.userId === principal.id) throw new BadRequestError('You already own it');
        const transfer = await proposeTransfer(
          tx,
          { workspaceId: workspace.id },
          principal.id,
          member.userId
        );
        await audit(
          tx,
          workspace.id,
          { principal, ip: request.ip },
          {
            action: 'workspace.transfer_request',
            resourceType: 'transfer',
            resourceId: transfer.id,
            metadata: { to: email },
          }
        );
        return transfer;
      });
      return reply.code(201).send({ ...transferDto(transfer), to: email });
    }
  );

  /** Pending transfers you were offered (incoming) and made (outgoing). */
  fastify.get('/api/transfers', { preHandler: fastify.authenticate }, async (request) => {
    const principal = requireUser(request);
    // eslint-disable-next-line no-restricted-syntax -- MT-09: the user's own transfers across tenants
    const transfers = await systemDb.ownershipTransfer.findMany({
      where: {
        OR: [{ toUserId: principal.id }, { fromUserId: principal.id }],
        acceptedAt: null,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    const ids = (pick: (t: OwnershipTransfer) => string | null) => [
      ...new Set(transfers.map(pick).filter((v): v is string => !!v)),
    ];
    const [workspaces, orgs, users] = await Promise.all([
      // eslint-disable-next-line no-restricted-syntax -- MT-09: names for the user's own transfers
      systemDb.workspace.findMany({
        where: { id: { in: ids((t) => t.workspaceId) } },
        select: { id: true, slug: true, name: true },
      }),
      // eslint-disable-next-line no-restricted-syntax -- MT-09: names for the user's own transfers
      systemDb.organization.findMany({
        where: { id: { in: ids((t) => t.organizationId) } },
        select: { id: true, slug: true, name: true },
      }),
      // eslint-disable-next-line no-restricted-syntax -- MT-09: users are global
      systemDb.user.findMany({
        where: { id: { in: [...ids((t) => t.fromUserId), ...ids((t) => t.toUserId)] } },
        select: { id: true, email: true },
      }),
    ]);
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const [wsOf, orgOf, userOf] = [byId(workspaces), byId(orgs), byId(users)];
    const view = (t: OwnershipTransfer) => ({
      ...transferDto(t),
      ...(t.workspaceId && { workspace: wsOf.get(t.workspaceId) ?? null }),
      ...(t.organizationId && { organization: orgOf.get(t.organizationId) ?? null }),
      from: userOf.get(t.fromUserId)?.email ?? null,
      to: userOf.get(t.toUserId)?.email ?? null,
    });
    return {
      incoming: transfers.filter((t) => t.toUserId === principal.id).map(view),
      outgoing: transfers.filter((t) => t.fromUserId === principal.id).map(view),
    };
  });

  /** Loads a pending transfer the caller takes part in (tenant resolution by id). */
  async function pending(id: string, userId: string, role: 'recipient' | 'party') {
    // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
    const transfer = await systemDb.ownershipTransfer.findUnique({ where: { id } });
    const party =
      transfer &&
      (transfer.toUserId === userId || (role === 'party' && transfer.fromUserId === userId));
    if (!transfer || !party || transfer.acceptedAt || transfer.cancelledAt) {
      throw new NotFoundError('Transfer not found');
    }
    if (transfer.expiresAt.getTime() <= Date.now()) throw new GoneError('This transfer expired');
    return transfer;
  }

  fastify.post<{ Params: { id: string } }>(
    '/api/transfers/:id/accept',
    { preHandler: fastify.authenticate },
    async (request) => {
      const principal = requireUser(request);
      const transfer = await pending(request.params.id, principal.id, 'recipient');
      const now = new Date();
      if (transfer.workspaceId) {
        const workspaceId = transfer.workspaceId;
        // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
        const workspace = await systemDb.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || workspace.deletedAt) throw new GoneError('This workspace was deleted');
        await withTenant(workspaceId, async (tx) => {
          const recipient = await tx.workspaceMember.findFirst({
            where: { workspaceId, userId: principal.id, joinedAt: { not: null } },
          });
          if (!recipient) throw new ConflictError('You are no longer a member of this workspace');
          await tx.workspaceMember.update({ where: { id: recipient.id }, data: { role: 'owner' } });
          // The sender steps down, if still an owner.
          await tx.workspaceMember.updateMany({
            where: { workspaceId, userId: transfer.fromUserId, role: 'owner' },
            data: { role: 'admin' },
          });
          await tx.ownershipTransfer.update({
            where: { id: transfer.id },
            data: { acceptedAt: now },
          });
          await audit(
            tx,
            workspaceId,
            { principal, ip: request.ip },
            {
              action: 'workspace.transfer_accept',
              resourceType: 'transfer',
              resourceId: transfer.id,
              metadata: { from: transfer.fromUserId, to: principal.id },
            }
          );
        });
        return { id: transfer.id, workspace: workspace.slug, role: 'owner' };
      }
      const organizationId = transfer.organizationId!;
      // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
      const org = await systemDb.organization.findFirst({
        where: { id: organizationId, deletedAt: null },
      });
      if (!org) throw new GoneError('This organization was deleted');
      await withOrg(organizationId, async (tx) => {
        const recipient = await tx.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId, userId: principal.id } },
        });
        if (!recipient) throw new ConflictError('You are no longer a member of this organization');
        await tx.organizationMember.update({
          where: { id: recipient.id },
          data: { role: 'org_admin' },
        });
        await tx.organizationMember.updateMany({
          where: { organizationId, userId: transfer.fromUserId, role: 'org_admin' },
          data: { role: 'org_member' },
        });
        await tx.ownershipTransfer.update({
          where: { id: transfer.id },
          data: { acceptedAt: now },
        });
        await tx.organizationAuditEvent.create({
          data: {
            organizationId,
            actorType: 'user',
            actorId: principal.id,
            ip: request.ip,
            action: 'org.transfer_accept',
            resourceType: 'transfer',
            resourceId: transfer.id,
            metadata: { from: transfer.fromUserId, to: principal.id },
          },
        });
      });
      return { id: transfer.id, organization: org.slug, role: 'org_admin' };
    }
  );

  /** The sender withdraws, or the recipient declines. */
  fastify.post<{ Params: { id: string } }>(
    '/api/transfers/:id/cancel',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const principal = requireUser(request);
      const transfer = await pending(request.params.id, principal.id, 'party');
      const cancel = (tx: TenantTx) =>
        tx.ownershipTransfer.update({
          where: { id: transfer.id },
          data: { cancelledAt: new Date() },
        });
      const event = {
        action: transfer.toUserId === principal.id ? 'transfer.decline' : 'transfer.cancel',
        resourceType: 'transfer',
        resourceId: transfer.id,
      };
      if (transfer.workspaceId) {
        await withTenant(transfer.workspaceId, async (tx) => {
          await cancel(tx);
          await audit(tx, transfer.workspaceId!, { principal, ip: request.ip }, event);
        });
      } else {
        await withOrg(transfer.organizationId!, async (tx) => {
          await cancel(tx);
          await tx.organizationAuditEvent.create({
            data: {
              organizationId: transfer.organizationId!,
              actorType: 'user',
              actorId: principal.id,
              ip: request.ip,
              ...event,
            },
          });
        });
      }
      return reply.code(204).send();
    }
  );
};

export default transferRoutes;
