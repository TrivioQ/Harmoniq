// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from 'fastify';
import type { Prisma, Role } from '@prisma/client';
import { IdentityError, type IdentityUserInfo } from '@harmoniq/core/dist/ports/IdentityProvider';
import { OrgProvisioning, OrgProvisioningSchema } from '@harmoniq/core/dist/schemas/SsoSchema';
import { audit } from './audit';

type Tx = Prisma.TransactionClient;

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

/** The organization's group rules (ORG-07), empty when unset or unreadable. */
export function orgProvisioning(raw: unknown): OrgProvisioning {
  const parsed = OrgProvisioningSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { rules: [], adminGroups: [] };
}

export interface OrgSyncInput {
  /** False when the IdP deactivated or deleted the user. */
  active: boolean;
  /** The user's IdP groups (SCIM groups, or the SSO assertion's). */
  groups: string[];
  /** Whether a newcomer joins the organization even without a matching group. */
  join: boolean;
  /**
   * Who manages access: workspaces with their own SCIM (for `scim`) or their own SSO
   * (for `sso`) override the organization's and are left alone.
   */
  source: 'scim' | 'sso';
  /** `scim` or the SSO provider id, for audit events. */
  actorId: string;
  ip?: string;
}

/**
 * ORG-07: brings a user's organization membership and the workspace memberships the
 * organization manages in line with their IdP groups. Members of an admin group become
 * org admins (the IdP never demotes one). Rules grant workspace roles; memberships they
 * granted (`orgProvisioned`) follow the rules and are removed when no rule matches, while
 * memberships people were invited to are left alone. A deactivated user loses the
 * organization and every membership in the managed workspaces, with their API keys;
 * the last org admin and a workspace's last owner are kept.
 *
 * Runs with the system client: it spans the organization's workspaces.
 */
export async function syncOrgMember(
  tx: Tx,
  org: { id: string; slug: string; provisioning: unknown },
  userId: string,
  input: OrgSyncInput
): Promise<{ deprovisioned: boolean; member: boolean }> {
  const policy = orgProvisioning(org.provisioning);
  const actor = { principal: { type: 'system' as const, id: input.actorId }, ip: input.ip };
  const orgEvent = (action: string, metadata: Record<string, unknown>) =>
    tx.organizationAuditEvent.create({
      data: {
        organizationId: org.id,
        actorType: 'system',
        actorId: `system:${input.actorId}`,
        action,
        resourceType: 'user',
        resourceId: userId,
        ip: input.ip,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  const wsEvent = (workspaceId: string, action: string, metadata: Record<string, unknown>) =>
    audit(tx, workspaceId, actor, {
      action,
      resourceType: 'user',
      resourceId: userId,
      metadata: { organization: org.slug, ...metadata },
    });

  const workspaces = (
    await tx.workspace.findMany({
      where: { organizationId: org.id },
      include: {
        WorkspaceConfig: { select: { scimEnabled: true, oidcConfig: true, samlConfig: true } },
      },
      orderBy: { slug: 'asc' },
    })
  ).filter((ws) => {
    const own = ws.WorkspaceConfig;
    return input.source === 'scim' ? !own?.scimEnabled : !own?.oidcConfig && !own?.samlConfig;
  });
  const orgMember = await tx.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: org.id, userId } },
  });

  if (!input.active) {
    let orgRemoved = false;
    if (orgMember) {
      const lastAdmin =
        orgMember.role === 'org_admin' &&
        (await tx.organizationMember.count({
          where: { organizationId: org.id, role: 'org_admin' },
        })) <= 1;
      if (lastAdmin) {
        await orgEvent('org.deprovision_skipped', { reason: 'last_org_admin' });
      } else {
        await tx.organizationMember.delete({ where: { id: orgMember.id } });
        orgRemoved = true;
      }
    }
    const removed: string[] = [];
    for (const ws of workspaces) {
      const member = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId } },
      });
      if (!member) continue;
      if (member.role === 'owner') {
        const owners = await tx.workspaceMember.count({
          where: { workspaceId: ws.id, role: 'owner' },
        });
        if (owners <= 1) {
          await wsEvent(ws.id, 'org.deprovision_skipped', { reason: 'last_owner' });
          continue;
        }
      }
      await tx.workspaceMember.delete({ where: { id: member.id } });
      const keys = await tx.apiKey.updateMany({
        where: { workspaceId: ws.id, createdBy: userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await wsEvent(ws.id, 'org.member_deprovisioned', {
        role: member.role,
        apiKeysRevoked: keys.count,
      });
      removed.push(ws.slug);
    }
    const orgKeys = orgRemoved
      ? await tx.orgApiKey.updateMany({
          where: { organizationId: org.id, createdBy: userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      : { count: 0 };
    if (orgMember || removed.length) {
      await orgEvent('org.member_deprovisioned', {
        organizationMembershipRemoved: orgRemoved,
        workspaces: removed,
        orgKeysRevoked: orgKeys.count,
      });
    }
    return { deprovisioned: true, member: false };
  }

  const groups = new Set(input.groups);
  const admin = policy.adminGroups.some((g) => groups.has(g));
  const roles = new Map<string, Role>();
  for (const rule of policy.rules) {
    if (!groups.has(rule.group)) continue;
    const current = roles.get(rule.workspace);
    if (!current || RANK[rule.role] > RANK[current]) roles.set(rule.workspace, rule.role);
  }

  if (!orgMember) {
    if (!input.join && !admin && !roles.size) return { deprovisioned: false, member: false };
    const role = admin ? 'org_admin' : 'org_member';
    await tx.organizationMember.create({ data: { organizationId: org.id, userId, role } });
    await orgEvent('org.member_provisioned', { role, source: input.source });
  } else if (admin && orgMember.role !== 'org_admin') {
    await tx.organizationMember.update({
      where: { id: orgMember.id },
      data: { role: 'org_admin' },
    });
    await orgEvent('org.member_role_synced', { from: orgMember.role, role: 'org_admin' });
  }

  for (const ws of workspaces) {
    const target = roles.get(ws.slug);
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId } },
    });
    if (target && !member) {
      await tx.workspaceMember.create({
        data: {
          workspaceId: ws.id,
          userId,
          role: target,
          joinedAt: new Date(),
          orgProvisioned: true,
        },
      });
      await wsEvent(ws.id, 'org.member_provisioned', { role: target });
    } else if (target && member?.orgProvisioned && member.role !== 'owner') {
      if (member.role !== target) {
        await tx.workspaceMember.update({ where: { id: member.id }, data: { role: target } });
        await wsEvent(ws.id, 'org.member_role_synced', { from: member.role, role: target });
      }
    } else if (!target && member?.orgProvisioned && member.role !== 'owner') {
      await tx.workspaceMember.delete({ where: { id: member.id } });
      await wsEvent(ws.id, 'org.member_unprovisioned', { role: member.role });
    }
  }
  return { deprovisioned: false, member: true };
}

/** SSO must not re-add someone the organization's IdP deprovisioned. */
export async function isOrgDeprovisioned(tx: Tx, organizationId: string, userId: string) {
  const user = await tx.scimUser.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return !!user && (!user.active || !!user.deletedAt);
}

/**
 * ORG-05/07 after an organization SSO login: refuses users the org's SCIM deprovisioned;
 * without org SCIM, syncs memberships from the assertion's groups (users of trusted
 * domains join the organization). With org SCIM, SCIM alone decides who has access.
 */
export async function provisionOrgSsoMember(
  app: FastifyInstance,
  orgSlug: string,
  providerId: string,
  trustedDomains: string[],
  userId: string,
  info: IdentityUserInfo,
  ip?: string
) {
  const { systemDb } = app.container;
  const org = await systemDb.organization.findFirstOrThrow({
    where: { slug: orgSlug, deletedAt: null },
  });
  return systemDb.$transaction(async (tx) => {
    if (await isOrgDeprovisioned(tx, org.id, userId)) {
      throw new IdentityError('access_denied', 'Your access to this organization was removed');
    }
    const result = org.scimEnabled
      ? null
      : await syncOrgMember(tx, org, userId, {
          active: true,
          groups: info.groups ?? [],
          join: trustedDomains.includes(info.email.split('@')[1]),
          source: 'sso',
          actorId: providerId,
          ip,
        });
    await tx.organizationAuditEvent.create({
      data: {
        organizationId: org.id,
        actorType: 'system',
        actorId: `system:${providerId}`,
        action: 'auth.sso_login',
        resourceType: 'user',
        resourceId: userId,
        ip,
        metadata: {
          email: info.email,
          provider: providerId,
          groups: info.groups ?? [],
          ...(result && { member: result.member }),
        },
      },
    });
  });
}
