import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ICache } from '@harmoniq/core/dist/ports/ICache';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { PinoLogger } from '../adapters/PinoLogger';
import { RedisCache } from '../adapters/RedisCache';
import { InMemoryLRUCache } from '../adapters/InMemoryLRUCache';
import { PrismaClient } from '@prisma/client';
import { createDbClients, withTenant, TenantTx } from '@harmoniq/db';
import { PgBoss } from 'pg-boss';

export interface AppContainer {
  cache: ICache;
  logger: ILogger;
  /** Tenant role, subject to RLS. Use through `withTenant`; bare queries return no rows. */
  db: PrismaClient;
  /** Schema owner, bypasses RLS. Tenant resolution, jobs and instance admin only. */
  systemDb: PrismaClient;
  withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  boss: PgBoss | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    container: AppContainer;
  }
}

const containerPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const logger = new PinoLogger({ service: 'registry' });

  // Resolve Cache
  let cache: ICache;
  if (fastify.config.cacheAdapter === 'redis' && fastify.config.redisUrl) {
    cache = new RedisCache(fastify.config.redisUrl);
    logger.info('Using RedisCache adapter');
  } else {
    cache = new InMemoryLRUCache();
    logger.info('Using InMemoryLRUCache adapter');
  }

  // Database
  const { db, systemDb } = createDbClients();

  // PgBoss
  let boss: PgBoss | null = null;
  // pg-boss manages its own schema, so it needs the owner role rather than the tenant role.
  if (process.env.SYSTEM_DATABASE_URL && process.env.NODE_ENV !== 'test') {
    boss = new PgBoss(process.env.SYSTEM_DATABASE_URL);
    boss.on('error', (err: unknown) => logger.error('pg-boss error', err as Error));
    await boss.start();
    logger.info('pg-boss started');
  }

  fastify.decorate('container', {
    cache,
    logger,
    db,
    systemDb,
    withTenant: (workspaceId, fn) => withTenant(db, workspaceId, fn),
    boss,
  });

  fastify.addHook('onClose', async (instance) => {
    if (instance.container.boss) {
      await instance.container.boss.stop();
    }
    await Promise.all([
      instance.container.db.$disconnect(),
      instance.container.systemDb.$disconnect(),
      instance.container.cache.close?.(),
    ]);
  });
};

export default fp(containerPlugin, {
  name: 'app-container',
});
