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
import { OrgSharedModules } from '../services/orgShared';
import { ManifestMutations, MutationTarget } from '../services/manifestMutation';
import { ManifestPublisher } from '../services/manifestPublisher';
import { StorageTarget } from '../adapters/storage/createStorage';
import { IMailer } from '@harmoniq/core/dist/ports/IMailer';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { InstanceSettings } from '../services/instanceSettings';

export interface AppContainer {
  cache: ICache;
  logger: ILogger;
  /** Tenant role, subject to RLS. Use through `withTenant`; bare queries return no rows. */
  db: PrismaClient;
  /** Schema owner, bypasses RLS. Tenant resolution, jobs and instance admin only. */
  systemDb: PrismaClient;
  withTenant: <T>(
    workspaceId: string,
    fn: (tx: TenantTx) => Promise<T>,
    options?: { timeout?: number }
  ) => Promise<T>;
  boss: PgBoss | null;
  webhooks: WebhookDispatcher;
  /** The single path for manifest-changing operations. */
  mutations: ManifestMutations;
  /**
   * Outbound email (INST-12, live): null when none is configured in production (email
   * sign-in is then disabled).
   */
  readonly mailer: IMailer | null;
  /** Instance default storage (INST-11, live); null when there is none. */
  readonly instanceStorage: StorageTarget | null;
  /** INST-11..17: instance settings from the database over the environment. */
  settings: InstanceSettings;
  publisher: ManifestPublisher;
  /** ORG-10/11: modules shared across an organization's workspaces. */
  orgShared: OrgSharedModules;
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
    if (fastify.config.isProduction) {
      // Invalidations stay inside this process: other replicas keep serving old manifests
      // until their cache entries expire.
      logger.warn(
        'In-memory cache is only correct with a single registry replica. Set CACHE_ADAPTER=redis and REDIS_URL when running more than one.'
      );
    }
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

  const tenant: AppContainer['withTenant'] = (workspaceId, fn, options) =>
    withTenant(db, workspaceId, fn, options);
  const webhooks = createWebhookDispatcher({ boss, logger, withTenant: tenant });

  const settings = new InstanceSettings({
    systemDb,
    config: fastify.config,
    logger,
    fallbackMailer: fastify.config.isProduction ? null : new ConsoleMailer(logger),
  });
  await settings.start();

  // eslint-disable-next-line prefer-const -- used by the publisher before it is created
  let orgShared: OrgSharedModules;
  const shared = (workspaceId: string, environmentSlug: string) =>
    orgShared.forTarget(workspaceId, environmentSlug);
  const publisher = new ManifestPublisher({
    systemDb,
    withTenant: tenant,
    instance: () => settings.storage(),
    encryptionKey: fastify.config.encryptionKey,
    webhooks,
    logger,
    shared,
  });

  // Publish after every manifest change: queued (retried) when the job queue runs, inline
  // otherwise (tests, queue unavailable). `singletonKey` keeps at most one *queued* publish
  // per environment — it reads the latest state when it runs, so bursts collapse — while
  // a change made during a running publish still queues a new one. (No singletonSeconds:
  // that would drop the second publish of a burst and leave the CDN copy stale.)
  const enqueuePublish = async (environmentId: string) => {
    const environment = { id: environmentId };
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
  orgShared = new OrgSharedModules({ systemDb, cache, logger, republish: enqueuePublish });
  // Siblings in the organization see this workspace's shared modules (ORG-11).
  const onCommitted = async (target: MutationTarget) => {
    await enqueuePublish(target.environment.id);
    await orgShared.fanOut(target.workspace.id, target.environment.slug);
  };

  fastify.decorate('container', {
    cache,
    logger,
    db,
    systemDb,
    withTenant: tenant,
    boss,
    webhooks,
    mutations: new ManifestMutations({
      withTenant: tenant,
      cache,
      webhooks,
      logger,
      onCommitted,
      shared,
    }),
    publisher,
    orgShared,
    settings,
    get instanceStorage() {
      return settings.storage();
    },
    get mailer() {
      return settings.mailer();
    },
  });

  fastify.addHook('onClose', async (instance) => {
    instance.container.settings.stop();
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
