import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ICache } from '@harmoniq/core/dist/ports/ICache';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { PinoLogger } from '../adapters/PinoLogger';
import { RedisCache } from '../adapters/RedisCache';
import { InMemoryLRUCache } from '../adapters/InMemoryLRUCache';
import { PrismaClient } from '@prisma/client';
import { PgBoss } from 'pg-boss';

export interface AppContainer {
  cache: ICache;
  logger: ILogger;
  db: PrismaClient;
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
  if (process.env.CACHE_ADAPTER === 'redis' && process.env.REDIS_URL) {
    cache = new RedisCache(process.env.REDIS_URL);
    logger.info('Using RedisCache adapter');
  } else {
    cache = new InMemoryLRUCache();
    logger.info('Using InMemoryLRUCache adapter');
  }

  // Database
  const db = new PrismaClient();

  // PgBoss
  let boss: PgBoss | null = null;
  if (process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
    boss = new PgBoss(process.env.DATABASE_URL);
    boss.on('error', (err: unknown) => logger.error('pg-boss error', err as Error));
    await boss.start();
    logger.info('pg-boss started');
  }

  fastify.decorate('container', {
    cache,
    logger,
    db,
    boss,
  });

  fastify.addHook('onClose', async (instance) => {
    if (instance.container.boss) {
      await instance.container.boss.stop();
    }
    await instance.container.db.$disconnect();
  });
};

export default fp(containerPlugin, {
  name: 'app-container',
});
