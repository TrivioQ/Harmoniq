import type { Environment, HostApp, Prisma, Workspace } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { WebhookEventName } from '@harmoniq/core/dist/schemas/WebhookEventSchema';
import { LockedError } from '@harmoniq/core/dist/errors/AppError';
import { AuditActor, audit } from './audit';
import { BuiltManifest, buildManifest } from './manifestBuilder';
import { invalidateManifest, lastKnownGoodKey, manifestKey } from './cacheKeys';
import { WebhookDispatcher } from './webhookDispatcher';

export const MANIFEST_CACHE_TTL_SECONDS = 3600;

export interface MutationTarget {
  workspace: Pick<Workspace, 'id' | 'slug'>;
  hostApp: Pick<HostApp, 'id' | 'slug' | 'name'>;
  environment: Pick<Environment, 'id' | 'slug'>;
}

export interface MutationOutcome<T> {
  result: T;
  audit: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  };
  /** Domain events besides `manifest.updated`, which is always emitted. */
  events: Array<{ name: WebhookEventName; payload: Record<string, unknown> }>;
}

/** An environment is frozen until `freezeUntil` passes (or indefinitely without one). */
export function isFrozen(env: Pick<Environment, 'frozenAt' | 'freezeUntil'>, now = new Date()) {
  return !!env.frozenAt && (!env.freezeUntil || env.freezeUntil > now);
}

/**
 * The one path for every manifest-changing operation (deploy, rollback, promote, canary,
 * auto-rollback). Inside a single tenant transaction it checks the freeze, runs the
 * operation, writes the audit event and a snapshot of the resulting manifest; after
 * commit it refreshes the caches and enqueues webhooks.
 */
export class ManifestMutations {
  constructor(
    private deps: {
      withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
      cache: ICache;
      webhooks: WebhookDispatcher;
      logger: ILogger;
      /** After commit, e.g. publish the manifest to the CDN (M2.1). Must not throw. */
      onCommitted?: (target: MutationTarget) => Promise<void>;
    }
  ) {}

  async run<T>(
    target: MutationTarget,
    actor: AuditActor,
    operation: (tx: TenantTx) => Promise<MutationOutcome<T>>
  ): Promise<{ result: T; manifest: BuiltManifest; snapshotId: string }> {
    const { workspace, environment } = target;

    const committed = await this.deps.withTenant(workspace.id, async (tx) => {
      // Read inside the transaction so a concurrent freeze can't slip past (ENV-FRZ-02).
      const env = await tx.environment.findUniqueOrThrow({ where: { id: environment.id } });
      if (isFrozen(env)) {
        throw new LockedError(
          `Environment "${env.slug}" is frozen: ${env.freezeReason ?? 'no reason given'}`,
          {
            environment: env.slug,
            frozenAt: env.frozenAt,
            freezeUntil: env.freezeUntil,
            reason: env.freezeReason,
          }
        );
      }

      const outcome = await operation(tx);
      const auditEvent = await audit(tx, workspace.id, actor, outcome.audit);
      const { built, snapshotId } = await this.snapshot(tx, target, auditEvent.id);
      return { outcome, built, snapshotId };
    });

    const { outcome, built, snapshotId } = committed;
    await this.afterCommit(target, built, snapshotId, outcome.events);
    return { result: outcome.result, manifest: built, snapshotId };
  }

  /**
   * Re-snapshots and republishes an environment whose manifest changed as a side effect
   * of another change (e.g. a module's import-map specifier), linked to that change's
   * audit event.
   */
  async rebuild(target: MutationTarget, auditEventId: string): Promise<BuiltManifest> {
    const { built, snapshotId } = await this.deps.withTenant(target.workspace.id, (tx) =>
      this.snapshot(tx, target, auditEventId)
    );
    await this.afterCommit(target, built, snapshotId, []);
    return built;
  }

  /** SNAP-01: the exact manifest after a change, linked to what caused it. */
  private async snapshot(tx: TenantTx, target: MutationTarget, auditEventId: string) {
    const { workspace, hostApp, environment } = target;
    const now = new Date();
    const built = await buildManifest(
      tx,
      { workspaceSlug: workspace.slug, hostApp, environment },
      { generatedAt: now }
    );
    const snapshot = await tx.manifestSnapshot.create({
      data: {
        workspaceId: workspace.id,
        hostAppId: hostApp.id,
        environmentId: environment.id,
        manifestJson: built.manifest as unknown as Prisma.InputJsonValue,
        etag: built.etag,
        auditEventId,
        createdAt: now,
      },
    });
    return { built, snapshotId: snapshot.id };
  }

  /** Caches, webhooks and publishing are best effort and must not undo the change. */
  private async afterCommit(
    target: MutationTarget,
    built: BuiltManifest,
    snapshotId: string,
    events: MutationOutcome<unknown>['events']
  ) {
    const { workspace, hostApp, environment } = target;
    try {
      await invalidateManifest(this.deps.cache, workspace.slug, hostApp.slug, environment.slug);
      const value = JSON.stringify(built);
      await this.deps.cache.set(
        manifestKey(workspace.slug, hostApp.slug, environment.slug),
        value,
        MANIFEST_CACHE_TTL_SECONDS
      );
      await this.deps.cache.set(
        lastKnownGoodKey(workspace.slug, hostApp.slug, environment.slug),
        value
      );
    } catch (err) {
      this.deps.logger.error('Manifest cache refresh failed after commit', err as Error);
    }

    const common = {
      workspace: workspace.slug,
      hostApp: hostApp.slug,
      environment: environment.slug,
    };
    try {
      for (const event of events) {
        await this.deps.webhooks.dispatch(workspace.id, event.name, {
          ...common,
          ...event.payload,
        });
      }
      await this.deps.webhooks.dispatch(workspace.id, 'manifest.updated', {
        ...common,
        etag: built.etag,
        snapshotId,
      });
    } catch (err) {
      this.deps.logger.error('Webhook dispatch failed after commit', err as Error);
    }

    await this.deps
      .onCommitted?.(target)
      .catch((err) => this.deps.logger.error('Post-commit hook failed', err as Error));
  }
}
