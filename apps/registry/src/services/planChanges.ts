// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from '@prisma/client';
import type { AppContainer } from '../plugins/container';

type Change = {
  from: string;
  to: string;
  reason: 'admin' | 'expired';
  expiresAt?: Date | null;
  overrides?: unknown;
};

/**
 * USG-04: `plan.changed`, in the tenant's audit log and to its workspaces' webhooks (org
 * webhooks come with TAD-10). Best effort: the change itself is already saved.
 */
export async function recordPlanChange(
  container: Pick<AppContainer, 'systemDb' | 'webhooks' | 'logger'>,
  tenant: { workspaceId: string } | { organizationId: string },
  change: Change,
  actor: { type: 'user' | 'system'; id: string } = { type: 'system', id: 'plans' }
) {
  const { systemDb, webhooks, logger } = container;
  const payload = {
    from: change.from,
    to: change.to,
    reason: change.reason,
    expiresAt: change.expiresAt?.toISOString() ?? null,
    ...(change.overrides !== undefined && { overrides: change.overrides }),
  };
  const event = {
    actorType: actor.type,
    actorId: actor.id,
    action: 'plan.changed',
    resourceType: 'plan',
    resourceId: change.to,
    metadata: payload as Prisma.InputJsonValue,
  };
  try {
    if ('workspaceId' in tenant) {
      await systemDb.auditEvent.create({ data: { workspaceId: tenant.workspaceId, ...event } });
      await webhooks.dispatch(tenant.workspaceId, 'plan.changed', payload);
    } else {
      await systemDb.organizationAuditEvent.create({
        data: { organizationId: tenant.organizationId, ...event },
      });
      const workspaces = await systemDb.workspace.findMany({
        where: { organizationId: tenant.organizationId, deletedAt: null },
        select: { id: true },
      });
      for (const w of workspaces) {
        await webhooks.dispatch(w.id, 'plan.changed', { ...payload, organization: true });
      }
    }
  } catch (err) {
    logger.warn(`Recording plan.changed failed: ${(err as Error).message}`);
  }
}

/**
 * PLN-06 (`plans.expire`, hourly): trials past `planExpiresAt` fall back to their base
 * plan, audited as `plan.changed` and `instance.plan_expired`. Overrides are kept.
 */
export async function expirePlans(
  container: Pick<AppContainer, 'systemDb' | 'webhooks' | 'logger' | 'plans'>,
  now = new Date()
) {
  const { systemDb } = container;
  const due = { planExpiresAt: { lte: now } };
  const [configs, orgs] = await Promise.all([
    systemDb.workspaceConfig.findMany({ where: due }),
    systemDb.organization.findMany({ where: due }),
  ]);
  for (const c of configs) {
    const to = c.basePlan ?? 'hobby';
    await systemDb.workspaceConfig.update({
      where: { id: c.id },
      data: { plan: to, planExpiresAt: null, basePlan: null },
    });
    await systemDb.instanceAuditEvent.create({
      data: {
        actorType: 'system',
        actorId: 'plans',
        action: 'instance.plan_expired',
        resourceType: 'workspace',
        resourceId: c.workspaceId,
        metadata: { from: c.plan, to },
      },
    });
    await recordPlanChange(
      container,
      { workspaceId: c.workspaceId },
      { from: c.plan, to, reason: 'expired' }
    );
  }
  for (const o of orgs) {
    const to = o.basePlan ?? 'hobby';
    await systemDb.organization.update({
      where: { id: o.id },
      data: { plan: to, planExpiresAt: null, basePlan: null },
    });
    await systemDb.instanceAuditEvent.create({
      data: {
        actorType: 'system',
        actorId: 'plans',
        action: 'instance.plan_expired',
        resourceType: 'organization',
        resourceId: o.id,
        metadata: { slug: o.slug, from: o.plan, to },
      },
    });
    await recordPlanChange(
      container,
      { organizationId: o.id },
      { from: o.plan, to, reason: 'expired' }
    );
  }
  if (configs.length || orgs.length) container.plans.forget();
  return { workspaces: configs.length, organizations: orgs.length };
}
