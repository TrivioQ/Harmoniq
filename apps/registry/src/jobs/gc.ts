import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { createWorkspaceStorage } from '../adapters/storage/createStorage';

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
               w."retentionDays",
               row_number() OVER (
                 PARTITION BY v."remoteModuleId", v."environmentId"
                 ORDER BY v."deployedAt" DESC
               ) AS rank
        FROM "ModuleVersion" v
        JOIN "Workspace" w ON w."id" = v."workspaceId"
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
      WHERE w."id" = s."workspaceId"
        AND s."deletedAt" IS NULL
        AND s."createdAt" < now() - make_interval(days => w."retentionDays")`;
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

    const failedWorkspaces = new Set<string>();
    if (purge) {
      const pathsByWorkspace = new Map<string, string[]>();
      for (const v of doomed) {
        if (!v.storagePath) continue;
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

export async function handleHealthEventPurge(db: PrismaClient, logger: ILogger) {
  logger.info('Running gc.healthEventPurge job');
  try {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const events = await db.moduleHealthEvent.deleteMany({
      where: {
        reportedAt: { lt: oneDayAgo },
      },
    });
    logger.info(`Purged ${events.count} health events`);
  } catch (err) {
    logger.error('Failed to run gc.healthEventPurge', err as Error);
    throw err;
  }
}

export async function registerGcJobs(fastify: FastifyInstance) {
  const boss = fastify.container.boss;
  const db = fastify.container.systemDb; // cross-tenant background work
  const logger = fastify.container.logger;

  if (!boss) return;

  // pg-boss 10+ requires queues to exist before schedule()/work(). Idempotent.
  for (const queue of ['gc.softDelete', 'gc.hardDelete', 'gc.healthEventPurge', 'gc.orphanScan']) {
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
    handleSoftDelete(db, logger, { keepVersions: fastify.config.gcKeepVersions })
  );

  // 2. Hard Delete Job - Weekly
  await boss.schedule('gc.hardDelete', '0 0 * * 0'); // Every Sunday
  boss.work('gc.hardDelete', () => handleHardDelete(db, logger, purge));

  // 3. Health Event Purge - Daily
  await boss.schedule('gc.healthEventPurge', '0 0 * * *');
  boss.work('gc.healthEventPurge', () => handleHealthEventPurge(db, logger));

  // 4. Orphan Scan - Weekly
  await boss.schedule('gc.orphanScan', '0 0 * * 0');
  boss.work('gc.orphanScan', async () => {
    logger.info('Running gc.orphanScan job - stub');
    // Implement IStorage scanning later
  });
}
