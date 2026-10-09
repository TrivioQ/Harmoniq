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
import { WebhookDispatcher, createWebhookDispatcher } from '../services/webhookDispatcher';
import { ManifestMutations } from '../services/manifestMutation';
import { ManifestPublisher } from '../services/manifestPublisher';
import { StorageTarget, instanceStorageTarget } from '../adapters/storage/createStorage';
import { IMailer } from '@harmoniq/core/dist/ports/IMailer';
import { SmtpMailer } from '../adapters/mail/SmtpMailer';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';

export interface AppContainer {
  cache: ICache;
  logger: ILogger;
  /** Tenant role, subject to RLS. Use through `withTenant`; bare queries return no rows. */
  db: PrismaClient;
  /** Schema owner, bypasses RLS. Tenant resolution, jobs and instance admin only. */
  systemDb: PrismaClient;
  withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  boss: PgBoss | null;
  webhooks: WebhookDispatcher;
  /** The single path for manifest-changing operations. */
  mutations: ManifestMutations;
  /** null when no SMTP is configured in production (email sign-in is then disabled). */
  mailer: IMailer | null;
  /** Instance default storage (null when STORAGE_ADAPTER=none). */
  instanceStorage: StorageTarget | null;
  publisher: ManifestPublisher;
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

  const tenant: AppContainer['withTenant'] = (workspaceId, fn) => withTenant(db, workspaceId, fn);
  const webhooks = createWebhookDispatcher({ boss, logger, withTenant: tenant });

  const { mail, isProduction } = fastify.config;
  const mailer: IMailer | null = mail.smtpUrl
    ? new SmtpMailer(mail.smtpUrl, mail.from)
    : isProduction
      ? null
      : new ConsoleMailer(logger);

  const instanceStorage = instanceStorageTarget(fastify.config);
  const publisher = new ManifestPublisher({
    systemDb,
    withTenant: tenant,
    instance: instanceStorage,
    encryptionKey: fastify.config.encryptionKey,
    webhooks,
    logger,
  });

  // Publish after every manifest change: queued (retried) when the job queue runs, inline
  // otherwise (tests, queue unavailable). `singletonKey` keeps at most one *queued* publish
  // per environment — it reads the latest state when it runs, so bursts collapse — while
  // a change made during a running publish still queues a new one. (No singletonSeconds:
  // that would drop the second publish of a burst and leave the CDN copy stale.)
  const onCommitted = async ({ environment }: { environment: { id: string } }) => {
    if (boss) {
      await boss.send(
        'manifest.publish',
        { environmentId: environment.id },
        { singletonKey: environment.id, retryLimit: 5, retryBackoff: true }
      );
    } else {
      await publisher.publish(environment.id).catch(() => undefined); // recorded on the environment
    }
  };

  fastify.decorate('container', {
    cache,
    logger,
    db,
    systemDb,
    withTenant: tenant,
    boss,
    webhooks,
    mutations: new ManifestMutations({ withTenant: tenant, cache, webhooks, logger, onCommitted }),
    instanceStorage,
    publisher,
    mailer,
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
