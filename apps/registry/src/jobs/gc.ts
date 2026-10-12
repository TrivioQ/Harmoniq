// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { purgeOperationalLogs } from '../services/operations';
import { rollUpHealth } from '../services/health';
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { createWorkspaceStorage } from '../adapters/storage/createStorage';
import { invalidateManifest } from '../services/cacheKeys';
import { publishedPaths } from '../services/manifestPublisher';
import { purgeDueTenants } from '../services/tenantLifecycle';
import { expirePlans } from '../services/planChanges';
import { RESEAL_QUEUE, resealAll } from '../services/reseal';
import { streamAll, streamDeps } from '../services/auditStream';

/** Deletes bundle objects for one workspace. Throws if they could not be removed. */
export type PurgeObjects = (workspaceId: string, storagePaths: string[]) => Promise<void>;

/**
 * GC-03/06: soft-deletes `inactive` versions older than the workspace's `retentionDays`,
 * but always keeps the newest `keepVersions` per module+environment so there is always
 * something to roll back to. `active` and `canary` versions are never touched.
 */
export async function handleSoftDelete(
  db: PrismaClient,
  logger: ILogger,
  { keepVersions = 10 }: { keepVersions?: number } = {}
) {
  logger.info('Running gc.softDelete job');
  try {
    const versions = await db.$executeRaw`
      UPDATE "ModuleVersion" AS mv
      SET "deletedAt" = now()
      FROM (
        SELECT v."id",
               v."deployedAt",
               -- POL-04: never below the organization's floor.
               GREATEST(w."retentionDays", COALESCE(op."minRetentionDays", 0)) AS "retentionDays",
               row_number() OVER (
                 PARTITION BY v."remoteModuleId", v."environmentId"
                 ORDER BY v."deployedAt" DESC
               ) AS rank
        FROM "ModuleVersion" v
        JOIN "Workspace" w ON w."id" = v."workspaceId"
        LEFT JOIN "OrgPolicy" op ON op."organizationId" = w."organizationId"
        WHERE v."deletedAt" IS NULL
      ) AS ranked
      WHERE mv."id" = ranked."id"
        AND mv."status" = 'inactive'
        AND ranked.rank > ${keepVersions}
        AND ranked."deployedAt" < now() - make_interval(days => ranked."retentionDays")`;
    logger.info(`Soft deleted ${versions} module versions`);

    // SNAP-04: snapshots follow the same per-workspace retention.
    const snapshots = await db.$executeRaw`
      UPDATE "ManifestSnapshot" AS s
      SET "deletedAt" = now()
      FROM "Workspace" w
      LEFT JOIN "OrgPolicy" op ON op."organizationId" = w."organizationId"
      WHERE w."id" = s."workspaceId"
        AND s."deletedAt" IS NULL
        AND s."createdAt" < now() - make_interval(
          days => GREATEST(w."retentionDays", COALESCE(op."minRetentionDays", 0)))`;
    logger.info(`Soft deleted ${snapshots} manifest snapshots`);
  } catch (err) {
    logger.error('Failed to run gc.softDelete', err as Error);
    throw err;
  }
}

/**
 * GC-04/07: hard-deletes versions soft-deleted more than 7 days ago and purges their
 * bundle objects. If purging fails for a workspace its rows are kept, so the next run
 * retries — re-running after a failure is always safe.
 */
export async function handleHardDelete(db: PrismaClient, logger: ILogger, purge?: PurgeObjects) {
  logger.info('Running gc.hardDelete job');
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const doomed = await db.moduleVersion.findMany({
      where: {
        deletedAt: { not: null, lt: sevenDaysAgo },
        status: { notIn: ['active', 'canary'] },
      },
      select: { id: true, workspaceId: true, storagePath: true },
    });

    // A promotion (or a redeploy of the same upload) gives several versions one storage
    // object. Only purge objects no surviving version uses: the expired staging row of a
    // promoted version must not take production's bundle with it.
    const doomedIds = new Set(doomed.map((v) => v.id));
    const doomedPaths = [
      ...new Set(doomed.map((v) => v.storagePath).filter((p): p is string => !!p)),
    ];
    const sharers = doomedPaths.length
      ? await db.moduleVersion.findMany({
          where: { storagePath: { in: doomedPaths } },
          select: { id: true, workspaceId: true, storagePath: true },
        })
      : [];
    const pathKey = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`;
    const stillUsed = new Set(
      sharers.filter((v) => !doomedIds.has(v.id)).map((v) => pathKey(v.workspaceId, v.storagePath!))
    );

    const failedWorkspaces = new Set<string>();
    if (purge) {
      const pathsByWorkspace = new Map<string, string[]>();
      for (const v of doomed) {
        if (!v.storagePath || stillUsed.has(pathKey(v.workspaceId, v.storagePath))) continue;
        if (pathsByWorkspace.get(v.workspaceId)?.includes(v.storagePath)) continue;
        pathsByWorkspace.set(v.workspaceId, [
          ...(pathsByWorkspace.get(v.workspaceId) ?? []),
          v.storagePath,
        ]);
      }
      for (const [workspaceId, paths] of pathsByWorkspace) {
        try {
          await purge(workspaceId, paths);
        } catch (err) {
          failedWorkspaces.add(workspaceId);
          logger.error(`Failed to purge bundles for workspace ${workspaceId}`, err as Error);
        }
      }
    }

    const versions = await db.moduleVersion.deleteMany({
      where: {
        id: { in: doomed.filter((v) => !failedWorkspaces.has(v.workspaceId)).map((v) => v.id) },
      },
    });
    logger.info(`Hard deleted ${versions.count} module versions`);

    const snapshots = await db.manifestSnapshot.deleteMany({
      where: {
        deletedAt: { not: null, lt: sevenDaysAgo },
      },
    });
    logger.info(`Hard deleted ${snapshots.count} manifest snapshots`);
  } catch (err) {
    logger.error('Failed to run gc.hardDelete', err as Error);
    throw err;
  }
}

export async function handleHealthEventPurge(
  db: PrismaClient,
  logger: ILogger,
  retention: { healthEventRetentionHours: number; healthRollupRetentionDays: number } = {
    healthEventRetentionHours: 24,
    healthRollupRetentionDays: 30,
  }
) {
  logger.info('Running gc.healthEventPurge job');
  try {
    const events = await db.moduleHealthEvent.deleteMany({
      where: {
        reportedAt: { lt: new Date(Date.now() - retention.healthEventRetentionHours * 3_600_000) },
      },
    });
    // Hourly rollups (sparklines).
    const rollups = await db.moduleHealthRollup.deleteMany({
      where: {
        hour: { lt: new Date(Date.now() - retention.healthRollupRetentionDays * 86_400_000) },
      },
    });
    logger.info(`Purged ${events.count} health events and ${rollups.count} hourly rollups`);
  } catch (err) {
    logger.error('Failed to run gc.healthEventPurge', err as Error);
    throw err;
  }
}

/**
 * AUD-05: audit events of deleted workspaces stay for compliance until they are older than
 * `retentionDays`. Events of existing workspaces are never touched here.
 */
export async function handleAuditRetention(
  db: PrismaClient,
  logger: ILogger,
  retentionDays: number
) {
  const events = await db.$executeRaw`
    DELETE FROM "AuditEvent" a
     WHERE a."createdAt" < now() - make_interval(days => ${retentionDays}::int)
       AND NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w."id" = a."workspaceId")`;
  const scim = await db.$executeRaw`
    DELETE FROM "ScimAuditEvent" s
     WHERE s."workspaceId" IS NOT NULL
       AND s."createdAt" < now() - make_interval(days => ${retentionDays}::int)
       AND NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w."id" = s."workspaceId")`;
  if (events || scim) {
    logger.info(`Purged ${events} audit and ${scim} SCIM audit events of deleted workspaces`);
  }
  return { events, scim };
}

/** Called for each deleted environment, to drop caches and published copies. */
export type OnEnvironmentDeleted = (env: {
  id: string;
  slug: string;
  hostApp: { slug: string; workspaceId: string; workspace: { slug: string } };
}) => Promise<void>;

/** M2.6: deletes preview environments whose expiry has passed (cascades to versions). */
export async function handleExpireEnvironments(
  db: PrismaClient,
  logger: ILogger,
  onDeleted?: OnEnvironmentDeleted
) {
  const expired = await db.environment.findMany({
    where: { ephemeral: true, expiresAt: { lt: new Date() } },
    include: { hostApp: { include: { workspace: { select: { slug: true } } } } },
  });
  for (const env of expired) {
    await db.environment.delete({ where: { id: env.id } });
    await onDeleted?.(env).catch((err) =>
      logger.error(`Cleanup after deleting environment ${env.slug} failed`, err as Error)
    );
  }
  if (expired.length) logger.info(`Deleted ${expired.length} expired preview environments`);
  return expired.length;
}

export async function registerGcJobs(fastify: FastifyInstance) {
  const boss = fastify.container.boss;
  const db = fastify.container.systemDb; // cross-tenant background work
  const logger = fastify.container.logger;

  if (!boss) return;

  // pg-boss 10+ requires queues to exist before schedule()/work(). Idempotent.
  for (const queue of [
    'gc.softDelete',
    'gc.hardDelete',
    'gc.healthEventPurge',
    'gc.orphanScan',
    'gc.expireEnvironments',
    'health.rollup',
  ]) {
    await boss.createQueue(queue);
  }

  // Bundles in a workspace's own bucket are removed with their version. Without one, the
  // instance default storage owns the objects (orphan scan, M2.1).
  const purge: PurgeObjects = async (workspaceId, paths) => {
    const config = await db.workspaceStorageConfig.findUnique({ where: { workspaceId } });
    if (!config) return;
    const storage = createWorkspaceStorage(config, fastify.config.encryptionKey);
    for (const path of paths) {
      await storage.delete(path);
    }
  };

  // 1. Soft Delete Job - Daily
  await boss.schedule('gc.softDelete', '0 0 * * *');
  boss.work('gc.softDelete', () =>
    handleSoftDelete(db, logger, {
      keepVersions: fastify.container.settings.gc().keepVersions,
    })
  );

  // 2. Hard Delete Job - Weekly
  await boss.schedule('gc.hardDelete', '0 0 * * 0'); // Every Sunday
  boss.work('gc.hardDelete', () => handleHardDelete(db, logger, purge));

  // 3. Health Event Purge - Daily
  await boss.schedule('gc.healthEventPurge', '0 0 * * *');
  boss.work('gc.healthEventPurge', () =>
    handleHealthEventPurge(db, logger, fastify.container.settings.gc())
  );

  // 4. Expired preview environments - Hourly
  const onDeleted: OnEnvironmentDeleted = async (env) => {
    const ws = env.hostApp.workspace.slug;
    await invalidateManifest(fastify.container.cache, ws, env.hostApp.slug, env.slug);
    const target = await fastify.container.publisher.targetFor(env.hostApp.workspaceId);
    if (target) {
      const paths = publishedPaths(ws, env.hostApp.slug, env.slug);
      await target.storage.delete(target.prefix + paths.manifest);
      await target.storage.delete(target.prefix + paths.importMap);
    }
  };
  // HLT-04: refresh the current and previous hour's rollups every 5 minutes.
  await boss.schedule('health.rollup', '*/5 * * * *');
  boss.work('health.rollup', async () => {
    const rows = await rollUpHealth(db, new Date(Date.now() - 3_600_000));
    logger.info(`Rolled up health into ${rows} hourly rows`);
  });

  await boss.schedule('gc.expireEnvironments', '0 * * * *');
  boss.work('gc.expireEnvironments', () => handleExpireEnvironments(db, logger, onDeleted));

  // AUD-05: audit events of deleted workspaces past retention - Daily
  await boss.createQueue('gc.auditRetention');
  await boss.schedule('gc.auditRetention', '15 1 * * *');
  boss.work('gc.auditRetention', () =>
    handleAuditRetention(db, logger, fastify.config.auditRetentionDays)
  );

  // TLC-03: workspaces and organizations past their restore window - Hourly
  await boss.createQueue('tenant.purge');
  await boss.schedule('tenant.purge', '20 * * * *');
  boss.work('tenant.purge', () => purgeDueTenants(fastify.container));

  // USG-01/02: the day's storage, members and keys; 13 months kept - Nightly
  await boss.createQueue('usage.snapshot');
  await boss.schedule('usage.snapshot', '45 23 * * *');
  boss.work('usage.snapshot', async () => {
    await fastify.container.usage.snapshot();
  });

  // AUD-06: audit events to the organizations' sinks - Every minute
  await boss.createQueue('audit.stream');
  await boss.schedule('audit.stream', '* * * * *');
  boss.work('audit.stream', async () => {
    await streamAll(streamDeps(fastify));
  });

  // INST-26: re-seal every value with the active key - On demand
  await boss.createQueue(RESEAL_QUEUE);
  boss.work(RESEAL_QUEUE, async () => {
    const result = await resealAll(db, fastify.config.encryptionKey);
    logger.info(`secrets.reseal: ${result.resealed} value(s) re-sealed`);
  });

  // PLN-06: trials past their expiry fall back to the base plan - Hourly
  await boss.createQueue('plans.expire');
  await boss.schedule('plans.expire', '5 * * * *');
  boss.work('plans.expire', async () => {
    await expirePlans(fastify.container);
  });

  // INST-38/39: the email log after 30 days, sign-in events after 90 - Daily
  await boss.createQueue('ops.retention');
  await boss.schedule('ops.retention', '40 2 * * *');
  boss.work('ops.retention', async () => {
    const purged = await purgeOperationalLogs(db);
    logger.info(
      `ops.retention: ${purged.emails} email(s), ${purged.signIns} sign-in event(s) purged`
    );
  });

  // 5. Orphan Scan - Weekly
  await boss.schedule('gc.orphanScan', '0 0 * * 0');
  boss.work('gc.orphanScan', async () => {
    logger.info('Running gc.orphanScan job - stub');
    // Implement IStorage scanning later
  });
}
