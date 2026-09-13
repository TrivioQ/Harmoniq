import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';

export async function handleSoftDelete(db: PrismaClient, logger: ILogger) {
  logger.info('Running gc.softDelete job');
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Soft delete inactive module versions
    const versions = await db.moduleVersion.updateMany({
      where: {
        status: 'inactive',
        deletedAt: null,
        deployedAt: { lt: thirtyDaysAgo },
      },
      data: {
        deletedAt: new Date(),
      },
    });
    logger.info(`Soft deleted ${versions.count} module versions`);

    // Soft delete old manifest snapshots
    const snapshots = await db.manifestSnapshot.updateMany({
      where: {
        deletedAt: null,
        createdAt: { lt: thirtyDaysAgo },
      },
      data: {
        deletedAt: new Date(),
      },
    });
    logger.info(`Soft deleted ${snapshots.count} manifest snapshots`);
  } catch (err) {
    logger.error('Failed to run gc.softDelete', err as Error);
    throw err;
  }
}

export async function handleHardDelete(db: PrismaClient, logger: ILogger) {
  logger.info('Running gc.hardDelete job');
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const versions = await db.moduleVersion.deleteMany({
      where: {
        deletedAt: { not: null, lt: sevenDaysAgo },
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
  const db = fastify.container.db;
  const logger = fastify.container.logger;

  if (!boss) return;

  // 1. Soft Delete Job - Daily
  await boss.schedule('gc.softDelete', '0 0 * * *');
  boss.work('gc.softDelete', () => handleSoftDelete(db, logger));

  // 2. Hard Delete Job - Weekly
  await boss.schedule('gc.hardDelete', '0 0 * * 0'); // Every Sunday
  boss.work('gc.hardDelete', () => handleHardDelete(db, logger));

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
