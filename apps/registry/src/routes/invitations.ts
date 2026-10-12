// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-restricted-syntax -- MT-09: an invitation is resolved by its token (tenant resolution); the grant itself runs in withTenant / withOrg */

import { FastifyPluginAsync } from 'fastify';
import { ForbiddenError, GoneError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { invitationReachable } from '../services/authService';
import { grantInvitation, hashInvitationToken, invitationDto } from '../services/invitations';

/**
 * PPL-01/02: the invitation link. Anyone holding it can see what it is for; accepting
 * needs a session with the invited (verified) email that can reach the workspace or
 * organization.
 */
const invitationRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb, withTenant, withOrg } = fastify.container;

  async function resolve(token: string) {
    const invitation = await systemDb.invitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
    });
    if (!invitation) throw new NotFoundError('Invitation not found');
    const target = invitation.workspaceId
      ? await systemDb.workspace.findUnique({
          where: { id: invitation.workspaceId },
          select: { slug: true, name: true, deletedAt: true },
        })
      : await systemDb.organization.findUnique({
          where: { id: invitation.organizationId! },
          select: { slug: true, name: true, deletedAt: true },
        });
    return { invitation, target };
  }

  fastify.get<{ Params: { token: string } }>(
    '/api/invitations/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { invitation, target } = await resolve(request.params.token);
      return {
        ...invitationDto(invitation),
        kind: invitation.workspaceId ? 'workspace' : 'organization',
        target: target && !target.deletedAt ? { slug: target.slug, name: target.name } : null,
      };
    }
  );

  fastify.post<{ Params: { token: string } }>(
    '/api/invitations/:token/accept',
    {
      preHandler: fastify.authenticate,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const principal = request.principal!;
      if (principal.type !== 'user') throw new ForbiddenError('Invitations are accepted by people');
      const { invitation, target } = await resolve(request.params.token);
      if (invitation.acceptedAt || invitation.revokedAt) {
        throw new GoneError('This invitation was already used or revoked');
      }
      if (invitation.expiresAt.getTime() <= Date.now()) {
        throw new GoneError('This invitation expired; ask for a new one');
      }
      if (!target || target.deletedAt)
        throw new GoneError('This workspace or organization is gone');
      if (principal.email.toLowerCase() !== invitation.email) {
        throw new ForbiddenError(
          `This invitation is for ${invitation.email}; sign in with that address to accept it`
        );
      }
      // A session from a workspace's or organization's own IdP only reaches its own tenant.
      const reachable = await systemDb.$transaction((tx) =>
        invitationReachable(tx, principal.provider ?? '', invitation)
      );
      if (!reachable) {
        throw new ForbiddenError('Sign in another way to accept this invitation');
      }
      const role = invitation.workspaceId
        ? await withTenant(invitation.workspaceId, (tx) =>
            grantInvitation(tx, invitation, principal.id)
          )
        : await withOrg(invitation.organizationId!, (tx) =>
            grantInvitation(tx, invitation, principal.id)
          );
      if (invitation.organizationId) {
        await fastify.container.orgEvents.emit(invitation.organizationId, 'org.member.added', {
          email: invitation.email,
          role,
        });
      }
      return {
        kind: invitation.workspaceId ? 'workspace' : 'organization',
        slug: target.slug,
        role,
      };
    }
  );
};

export default invitationRoutes;
