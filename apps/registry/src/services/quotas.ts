// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Prisma, PrismaClient } from '@prisma/client';
import { QuotaExceededError } from '@harmoniq/core/dist/errors/AppError';
import type { Quota } from '@harmoniq/core/dist/schemas/AdminSchemas';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { Plans } from './plans';
import type { WebhookDispatcher } from './webhookDispatcher';

const GB = 1024 ** 3;
/** USG-04: `quota.warning` when a create brings usage to this share of the limit. */
export const WARN_AT = 0.8;

const LABEL: Record<Quota, string> = {
  workspaces: 'workspaces in the organization',
  members: 'members (including pending invitations)',
  modules: 'modules',
  environmentsPerHostApp: 'environments in this host app',
  storageGb: 'GB of bundle storage',
  deploysPerMonth: 'deploys this month',
  webhooks: 'webhook endpoints',
};

export const startOfMonth = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

type Target =
  { workspaceId: string; hostAppId?: string } | { organizationId: string; workspaceId?: undefined };

/**
 * PLN-04/05, USG-04: usage against plan quotas. `require` counts the current usage, refuses
 * a create that would go past the limit (`402 QUOTA_EXCEEDED`, with `quota.exceeded`) and
 * reports crossing 80% (`quota.warning`). Counting then creating is not atomic: two
 * concurrent creates can overshoot a limit by one, which quotas tolerate.
 */
export class Quotas {
  constructor(
    private deps: {
      systemDb: PrismaClient;
      plans: Plans;
      webhooks: WebhookDispatcher;
      logger: ILogger;
    }
  ) {}

  /** Current usage of one quota (storage in bytes). */
  async used(target: Target, quota: Quota): Promise<number> {
    const db = this.deps.systemDb;
    if ('organizationId' in target && target.organizationId) {
      return db.workspace.count({
        where: { organizationId: target.organizationId, deletedAt: null },
      });
    }
    const workspaceId = target.workspaceId!;
    switch (quota) {
      case 'members': {
        const [members, invited] = await Promise.all([
          db.workspaceMember.count({ where: { workspaceId, joinedAt: { not: null } } }),
          db.invitation.count({
            where: {
              workspaceId,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);
        return members + invited;
      }
      case 'modules':
        return db.remoteModule.count({ where: { workspaceId } });
      case 'environmentsPerHostApp':
        return 'hostAppId' in target && target.hostAppId
          ? db.environment.count({ where: { hostAppId: target.hostAppId } })
          : 0;
      case 'webhooks':
        return db.webhookEndpoint.count({ where: { workspaceId } });
      case 'deploysPerMonth':
        return db.moduleVersion.count({
          where: { workspaceId, deployedAt: { gte: startOfMonth() } },
        });
      case 'storageGb':
        return Number(
          (
            await db.moduleVersion.aggregate({
              where: { workspaceId, deletedAt: null },
              _sum: { sizeBytes: true },
            })
          )._sum.sizeBytes ?? 0
        );
      default:
        return 0;
    }
  }

  /** The limit of a quota for the target (null: unlimited). */
  async limit(target: Target, quota: Quota) {
    const e =
      'organizationId' in target && target.organizationId
        ? await this.deps.plans.forOrg(target.organizationId)
        : await this.deps.plans.forWorkspace({ id: target.workspaceId! });
    return { plan: e.plan, limit: e.limits[quota] };
  }

  /**
   * PLN-05: refuses the create when `delta` more would exceed the quota. `delta` is a count,
   * or bytes for storage.
   */
  async require(target: Target, quota: Quota, delta = 1) {
    const { plan, limit } = await this.limit(target, quota);
    if (limit === null) return;
    const used = await this.used(target, quota);
    const scale = quota === 'storageGb' ? GB : 1;
    const capacity = limit * scale;
    const details = {
      quota,
      limit,
      used: quota === 'storageGb' ? Number((used / GB).toFixed(3)) : used,
      plan,
    };
    if (used + delta > capacity) {
      await this.record(target, 'quota.exceeded', details);
      throw new QuotaExceededError(
        `The ${plan} plan allows ${limit} ${LABEL[quota]}; ${details.used} used`,
        details
      );
    }
    if (capacity > 0 && used < WARN_AT * capacity && used + delta >= WARN_AT * capacity) {
      await this.record(target, 'quota.warning', { ...details, threshold: WARN_AT });
    }
  }

  /** USG-04: audited, and sent to the workspace's webhooks (org webhooks come with TAD-10). */
  private async record(
    target: Target,
    event: 'quota.warning' | 'quota.exceeded',
    details: Record<string, unknown>
  ) {
    const db = this.deps.systemDb;
    const data = {
      actorType: 'system' as const,
      actorId: 'quota',
      action: event,
      resourceType: 'quota',
      resourceId: String(details.quota),
      metadata: details as Prisma.InputJsonValue,
    };
    try {
      if ('organizationId' in target && target.organizationId) {
        await db.organizationAuditEvent.create({
          data: { organizationId: target.organizationId, ...data },
        });
      } else {
        await db.auditEvent.create({ data: { workspaceId: target.workspaceId!, ...data } });
        await this.deps.webhooks.dispatch(target.workspaceId!, event, details);
      }
    } catch (err) {
      this.deps.logger.warn(`Recording ${event} failed: ${(err as Error).message}`);
    }
  }
}
