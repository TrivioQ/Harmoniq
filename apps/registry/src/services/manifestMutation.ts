// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { withSpan } from './tracing';
import type { Environment, HostApp, Prisma, Workspace } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { WebhookEventName } from '@harmoniq/core/dist/schemas/WebhookEventSchema';
import type { Module } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { LockedError } from '@harmoniq/core/dist/errors/AppError';
import { AuditActor, audit } from './audit';
import { BuiltManifest, buildManifest } from './manifestBuilder';
import { invalidateManifest, lastKnownGoodKey, manifestKey } from './cacheKeys';
import { WebhookDispatcher } from './webhookDispatcher';
import { activeOrgFreeze, orgPolicyFor } from './policy';

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

/**
 * An environment is frozen from `freezeFrom` (or as soon as the freeze is set) until
 * `freezeUntil` (or indefinitely). ENV-FRZ-04.
 */
export function isFrozen(
  env: Pick<Environment, 'frozenAt' | 'freezeFrom' | 'freezeUntil'>,
  now = new Date()
) {
  return (
    !!env.frozenAt &&
    (!env.freezeFrom || env.freezeFrom <= now) &&
    (!env.freezeUntil || env.freezeUntil > now)
  );
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
      /** ORG-11: modules shared into this workspace's environment by its organization. */
      shared?: (workspaceId: string, environmentSlug: string) => Promise<Module[]>;
    }
  ) {}

  run<T>(
    target: MutationTarget,
    actor: AuditActor,
    operation: (tx: TenantTx) => Promise<MutationOutcome<T>>,
    /** `ignoreFreeze`: emergency controls (the kill switch) work in frozen environments. */
    opts: { ignoreFreeze?: boolean } = {}
  ): Promise<{ result: T; manifest: BuiltManifest; snapshotId: string }> {
    return withSpan(
      'harmoniq.mutation',
      {
        'harmoniq.workspace': target.workspace.slug,
        'harmoniq.environment': target.environment.slug,
        'harmoniq.actor_type': actor.principal.type,
      },
      () => this.runInTransaction(target, actor, operation, opts)
    );
  }

  private async runInTransaction<T>(
    target: MutationTarget,
    actor: AuditActor,
    operation: (tx: TenantTx) => Promise<MutationOutcome<T>>,
    opts: { ignoreFreeze?: boolean }
  ): Promise<{ result: T; manifest: BuiltManifest; snapshotId: string }> {
    const { workspace, environment } = target;

    const committed = await this.deps.withTenant(workspace.id, async (tx) => {
      // Read inside the transaction so a concurrent freeze can't slip past (ENV-FRZ-02).
      const env = await tx.environment.findUniqueOrThrow({ where: { id: environment.id } });
      // POL-05: an organization freeze window binds every workspace; only an org admin's
      // override lets changes through (a workspace owner's override does not).
      const orgFreeze = opts.ignoreFreeze
        ? null
        : activeOrgFreeze(
            await orgPolicyFor(
              tx,
              (
                await tx.workspace.findUniqueOrThrow({
                  where: { id: workspace.id },
                  select: { organizationId: true },
                })
              ).organizationId
            ),
            env.slug
          );
      if (orgFreeze && !orgFreeze.overridden) {
        throw new LockedError(
          `Environment "${env.slug}" is frozen by the organization: ${orgFreeze.window.reason}`,
          {
            environment: env.slug,
            organizationFreeze: orgFreeze.window.id,
            freezeUntil: orgFreeze.window.until ?? null,
            reason: orgFreeze.window.reason,
          }
        );
      }
      const frozen = isFrozen(env);
      if (frozen && !opts.ignoreFreeze && actor.freezeOverride) {
        // ENV-FRZ-03: an owner's documented override (authorized by the route).
        await audit(tx, workspace.id, actor, {
          action: 'env.freeze_override',
          resourceType: 'environment',
          resourceId: env.id,
          metadata: {
            environment: env.slug,
            reason: actor.freezeOverride,
            freezeReason: env.freezeReason,
          },
        });
      }
      // ENV-FRZ-03: inside an owner's override window, changes pass and say so.
      const overrideWindow =
        frozen && !opts.ignoreFreeze && !actor.freezeOverride && env.freezeOverrideUntil
          ? env.freezeOverrideUntil > new Date()
          : false;
      if (frozen && !opts.ignoreFreeze && !actor.freezeOverride && !overrideWindow) {
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
      if (actor.approval) {
        outcome.audit.metadata = { ...outcome.audit.metadata, approval: actor.approval };
      }
      if (orgFreeze?.overridden) {
        outcome.audit.metadata = {
          ...outcome.audit.metadata,
          orgFreezeOverride: { window: orgFreeze.window.id, ...orgFreeze.window.override },
        };
      }
      if (overrideWindow) {
        outcome.audit.metadata = {
          ...outcome.audit.metadata,
          freezeOverride: {
            reason: env.freezeOverrideReason,
            by: env.freezeOverrideBy,
            until: env.freezeOverrideUntil,
          },
        };
      }
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
    const shared = await this.deps.shared?.(workspace.id, environment.slug);
    const built = await buildManifest(
      tx,
      { workspaceSlug: workspace.slug, hostApp, environment },
      { generatedAt: now, shared }
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
