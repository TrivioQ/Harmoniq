// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient, SupportGrant } from '@prisma/client';

/**
 * INST-20: support access. An instance admin opens a grant with a written reason for at
 * most 4 hours; while it is active they may read (never change) the organization, or the
 * workspace, as its admins would. The grant is recorded in the instance log and in the
 * tenant's own log, and shown to the tenant's admins.
 */
export const SUPPORT_GRANT_MAX_HOURS = 4;

const active = (now: Date) => ({ revokedAt: null, expiresAt: { gt: now } });

/** The admin's active grant covering this workspace (directly or through its organization). */
export function grantForWorkspace(
  db: PrismaClient,
  adminUserId: string,
  workspace: { id: string; organizationId: string | null },
  now = new Date()
) {
  return db.supportGrant.findFirst({
    where: {
      adminUserId,
      ...active(now),
      OR: [
        { workspaceId: workspace.id },
        ...(workspace.organizationId ? [{ organizationId: workspace.organizationId }] : []),
      ],
    },
  });
}

export function grantForOrg(
  db: PrismaClient,
  adminUserId: string,
  organizationId: string,
  now = new Date()
) {
  return db.supportGrant.findFirst({ where: { adminUserId, organizationId, ...active(now) } });
}

/** What a tenant's admins see: who has support access now, why and until when. */
export async function activeGrantsOn(
  db: PrismaClient,
  tenant: { workspaceId?: string; organizationId?: string | null },
  now = new Date()
) {
  const or = [
    ...(tenant.workspaceId ? [{ workspaceId: tenant.workspaceId }] : []),
    ...(tenant.organizationId ? [{ organizationId: tenant.organizationId }] : []),
  ];
  if (!or.length) return [];
  const grants = await db.supportGrant.findMany({
    where: { ...active(now), OR: or },
    orderBy: { createdAt: 'asc' },
  });
  const admins = await db.user.findMany({
    where: { id: { in: grants.map((g) => g.adminUserId) } },
    select: { id: true, email: true },
  });
  const email = new Map(admins.map((a) => [a.id, a.email]));
  return grants.map((g) => ({
    id: g.id,
    admin: email.get(g.adminUserId) ?? 'deleted user',
    reason: g.reason,
    scope: g.workspaceId ? ('workspace' as const) : ('organization' as const),
    expiresAt: g.expiresAt.toISOString(),
  }));
}

/** The tenant's side of the record (INST-20: in both logs). */
export async function auditInTenant(
  db: PrismaClient,
  grant: SupportGrant,
  action: 'support.access_granted' | 'support.access_revoked',
  actor: { id: string; ip?: string }
) {
  const event = {
    actorType: 'user' as const,
    actorId: actor.id,
    action,
    resourceType: 'support_grant',
    resourceId: grant.id,
    ip: actor.ip,
    metadata: { reason: grant.reason, expiresAt: grant.expiresAt.toISOString() },
  };
  if (grant.workspaceId) {
    await db.auditEvent.create({ data: { workspaceId: grant.workspaceId, ...event } });
  } else if (grant.organizationId) {
    await db.organizationAuditEvent.create({
      data: { organizationId: grant.organizationId, ...event },
    });
  }
}
