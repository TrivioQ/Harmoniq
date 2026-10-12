// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'crypto';
import type { Invitation, Prisma, Role } from '@prisma/client';
import { ConflictError } from '@harmoniq/core/dist/errors/AppError';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { IMailer } from '@harmoniq/core/dist/ports/IMailer';

/** PPL-01: how long an invitation can be accepted. */
export const INVITATION_DAYS = 7;
const DAY_MS = 24 * 3_600_000;
const RANK: Record<string, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
  org_member: 0,
  org_billing: 1,
  org_auditor: 1,
  org_admin: 3,
};

type Tx = Prisma.TransactionClient;
export type InvitationScope = { workspaceId: string } | { organizationId: string };

export const hashInvitationToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const acceptUrl = (webOrigin: string, token: string) =>
  `${webOrigin.replace(/\/$/, '')}/invite/${token}`;

export const isPending = (i: Invitation, now = Date.now()) =>
  !i.acceptedAt && !i.revokedAt && i.expiresAt.getTime() > now;

export function invitationDto(i: Invitation) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.acceptedAt
      ? 'accepted'
      : i.revokedAt
        ? 'revoked'
        : i.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'pending',
    expiresAt: i.expiresAt.toISOString(),
    lastSentAt: i.lastSentAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

/** A new pending invitation and its token (shown in the link only). One per email. */
export async function createInvitation(
  tx: Tx,
  scope: InvitationScope,
  input: { email: string; role: string; invitedBy: string }
) {
  const email = input.email.trim().toLowerCase();
  const existing = await tx.invitation.findMany({
    where: { ...scope, email, acceptedAt: null, revokedAt: null },
  });
  if (existing.some((i) => isPending(i))) {
    throw new ConflictError(`${email} is already invited; resend the invitation instead`);
  }
  const token = randomBytes(32).toString('base64url');
  const invitation = await tx.invitation.create({
    data: {
      ...scope,
      email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      invitedBy: input.invitedBy,
      expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY_MS),
    },
  });
  return { invitation, token };
}

/** Resend: a new token and a new expiry (the old link stops working). */
export async function renewInvitation(tx: Tx, invitation: Invitation) {
  if (invitation.acceptedAt || invitation.revokedAt) {
    throw new ConflictError('This invitation was already accepted or revoked');
  }
  const token = randomBytes(32).toString('base64url');
  const renewed = await tx.invitation.update({
    where: { id: invitation.id },
    data: {
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY_MS),
    },
  });
  return { invitation: renewed, token };
}

/**
 * PPL-02: the invitation email, when outbound email is configured. Best effort: returns
 * whether it was sent (the inviter still gets the link to share).
 */
export async function sendInvitationEmail(
  deps: { mailer: IMailer | null; instanceName: string; logger: ILogger },
  input: {
    email: string;
    url: string;
    kind: 'workspace' | 'organization';
    name: string;
    role: string;
    inviter?: string | null;
  }
) {
  if (!deps.mailer) return false;
  const what = input.kind === 'workspace' ? 'workspace' : 'organization';
  try {
    await deps.mailer.send({
      to: input.email,
      subject: `${deps.instanceName}: you're invited to the ${what} ${input.name}`,
      text: [
        `${input.inviter ?? 'An administrator'} invited you to the ${what} "${input.name}" on ${deps.instanceName} as ${input.role}.`,
        '',
        `Accept the invitation: ${input.url}`,
        '',
        `It expires in ${INVITATION_DAYS} days. Sign in with ${input.email} to accept it.`,
      ].join('\n'),
    });
    return true;
  } catch (err) {
    deps.logger.warn(`Sending the invitation to ${input.email} failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Turns an accepted invitation into a membership (the higher role wins when the user is
 * already a member) and marks it accepted. Runs in the invitation's tenant scope, or in a
 * system transaction at sign-in.
 */
export async function grantInvitation(tx: Tx, invitation: Invitation, userId: string) {
  const now = new Date();
  let role = invitation.role;
  if (invitation.workspaceId) {
    const workspaceId = invitation.workspaceId;
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) {
      await tx.workspaceMember.create({
        data: { workspaceId, userId, role: invitation.role as Role, joinedAt: now },
      });
    } else if ((RANK[invitation.role] ?? 0) > (RANK[member.role] ?? 0)) {
      await tx.workspaceMember.update({
        where: { id: member.id },
        data: { role: invitation.role as Role, joinedAt: member.joinedAt ?? now },
      });
    } else {
      role = member.role;
    }
  } else {
    const organizationId = invitation.organizationId!;
    const member = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!member) {
      await tx.organizationMember.create({
        data: { organizationId, userId, role: invitation.role },
      });
    } else if ((RANK[invitation.role] ?? 0) > (RANK[member.role] ?? 0)) {
      await tx.organizationMember.update({
        where: { id: member.id },
        data: { role: invitation.role },
      });
    } else {
      role = member.role;
    }
  }
  await tx.invitation.update({
    where: { id: invitation.id },
    data: { acceptedAt: now, acceptedBy: userId },
  });
  const event = {
    actorType: 'user' as const,
    actorId: userId,
    action: invitation.workspaceId ? 'member.join' : 'org.member_join',
    resourceType: 'invitation',
    resourceId: invitation.id,
    metadata: { email: invitation.email, role },
  };
  if (invitation.workspaceId) {
    await tx.auditEvent.create({ data: { workspaceId: invitation.workspaceId, ...event } });
  } else {
    await tx.organizationAuditEvent.create({
      data: { organizationId: invitation.organizationId!, ...event },
    });
  }
  return role;
}
