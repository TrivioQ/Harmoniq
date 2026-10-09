import type { PrismaClient } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { toImportMap } from '@harmoniq/core/dist/manifest/formats';
import { StorageTarget, workspaceStorageTarget } from '../adapters/storage/createStorage';
import { buildManifest } from './manifestBuilder';
import type { WebhookDispatcher } from './webhookDispatcher';

// Short browser/CDN cache with a long stale window: hosts pick up changes within ~30s and
// keep working from the CDN copy even when the registry is down (product-analysis §5.1).
export const PUBLISHED_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=300';

export const publishedPaths = (ws: string, host: string, env: string) => ({
  manifest: `manifests/${ws}/${host}/${env}.json`,
  importMap: `importmaps/${ws}/${host}/${env}.json`,
});

export interface PublishResult {
  etag: string;
  manifestUrl: string | null;
  importMapUrl: string | null;
}

/**
 * M2.1: writes the current manifest (and import map) of one environment to storage, so
 * hosts can load it from the CDN without depending on the registry.
 */
export class ManifestPublisher {
  constructor(
    private deps: {
      systemDb: PrismaClient;
      withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
      /** Instance default storage, used for workspaces without their own bucket. */
      instance: StorageTarget | null;
      encryptionKey: Buffer;
      webhooks: WebhookDispatcher;
      logger: ILogger;
    }
  ) {}

  /** The workspace bucket when configured (BYOB-07), otherwise the instance default. */
  async targetFor(workspaceId: string): Promise<StorageTarget | null> {
    const own = await this.deps.systemDb.workspaceStorageConfig.findUnique({
      where: { workspaceId },
    });
    return own ? workspaceStorageTarget(own, this.deps.encryptionKey) : this.deps.instance;
  }

  /** Returns null when no storage is configured (publishing disabled for this workspace). */
  async publish(environmentId: string): Promise<PublishResult | null> {
    const { systemDb } = this.deps;
    const env = await systemDb.environment.findUniqueOrThrow({
      where: { id: environmentId },
      include: { hostApp: { include: { workspace: true } } },
    });
    const { hostApp } = env;
    const { workspace } = hostApp;

    const target = await this.targetFor(workspace.id);
    if (!target) return null;

    try {
      const built = await this.deps.withTenant(workspace.id, (tx) =>
        buildManifest(tx, { workspaceSlug: workspace.slug, hostApp, environment: env })
      );
      const paths = publishedPaths(workspace.slug, hostApp.slug, env.slug);
      const manifestKey = target.prefix + paths.manifest;
      const importMapKey = target.prefix + paths.importMap;
      const opts = { contentType: 'application/json', cacheControl: PUBLISHED_CACHE_CONTROL };

      await target.storage.put(manifestKey, JSON.stringify(built.manifest), opts);
      await target.storage.put(importMapKey, JSON.stringify(toImportMap(built.manifest)), {
        ...opts,
        contentType: 'application/importmap+json',
      });

      await systemDb.environment.update({
        where: { id: env.id },
        data: {
          lastPublishedEtag: built.etag,
          lastPublishedAt: new Date(),
          lastPublishError: null,
        },
      });
      return {
        etag: built.etag,
        manifestUrl: target.publicUrl(manifestKey),
        importMapUrl: target.publicUrl(importMapKey),
      };
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? String(err);
      await systemDb.environment.update({
        where: { id: env.id },
        data: { lastPublishError: message },
      });
      this.deps.logger.error(
        `Publishing manifest for ${workspace.slug}/${hostApp.slug}/${env.slug} failed`,
        err as Error
      );
      await this.deps.webhooks
        .dispatch(workspace.id, 'manifest.publish_failed', {
          workspace: workspace.slug,
          hostApp: hostApp.slug,
          environment: env.slug,
          error: message,
        })
        .catch(() => undefined);
      throw err;
    }
  }
}
