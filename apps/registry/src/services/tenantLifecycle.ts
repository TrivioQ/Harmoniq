// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { StorageTarget } from '../adapters/storage/createStorage';
import {
  defaultHostKey,
  invalidateManifest,
  lastKnownDefaultHostKey,
  lastKnownGoodKey,
} from './cacheKeys';
import { type ManifestPublisher, publishedPaths } from './manifestPublisher';
import type { OrgSharedModules } from './orgShared';
import { deleteWorkspace } from './workspaces';

/** What the lifecycle functions need from the app container. */
export interface LifecycleDeps {
  systemDb: PrismaClient;
  cache: ICache;
  orgShared: OrgSharedModules;
  publisher: Pick<ManifestPublisher, 'targetFor' | 'publish'>;
  readonly instanceStorage: StorageTarget | null;
  logger: ILogger;
}

const DAY_MS = 24 * 3_600_000;

/** The actor recorded on a deletion (user, API key or instance admin). */
export interface LifecycleActor {
  type: 'user' | 'apiKey' | 'system';
  id: string;
}

async function environmentsOf(db: PrismaClient, workspaceId: string) {
  return db.environment.findMany({
    where: { hostApp: { workspaceId } },
    include: { hostApp: { select: { slug: true } } },
  });
}

/** Drops every cached copy of the workspace's manifests, last-known-good included. */
async function forgetCached(
  deps: LifecycleDeps,
  workspace: { slug: string },
  envs: Array<{ slug: string; hostApp: { slug: string } }>
) {
  await deps.cache.del(defaultHostKey(workspace.slug));
  await deps.cache.del(lastKnownDefaultHostKey(workspace.slug));
  for (const env of envs) {
    await invalidateManifest(deps.cache, workspace.slug, env.hostApp.slug, env.slug);
    await deps.cache.del(lastKnownGoodKey(workspace.slug, env.hostApp.slug, env.slug));
  }
}

/**
 * TLC-02: deletes a workspace, restorably. Writes and manifests answer `410` at once, its
 * published manifest copies leave the CDN (hosts stop loading its modules), its shared
 * modules leave the organization's manifests, and the bundles stay until the purge so a
 * restore brings everything back. With a restore window of 0 days it is purged now.
 */
export async function softDeleteWorkspace(
  deps: LifecycleDeps,
  workspace: { id: string; slug: string },
  actor: LifecycleActor,
  restoreDays: number
): Promise<{ purgeAfter: Date | null; objectsDeleted?: number; objectsFailed?: number }> {
  if (restoreDays === 0) {
    return { purgeAfter: null, ...(await deleteWorkspace(deps, workspace)) };
  }
  const { systemDb, logger } = deps;
  const envs = await environmentsOf(systemDb, workspace.id);
  const shared = await systemDb.remoteModule.updateMany({
    where: { workspaceId: workspace.id, orgShared: true },
    data: { orgShared: false },
  });
  if (shared.count) await deps.orgShared.fanOut(workspace.id, undefined, { force: true });
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + restoreDays * DAY_MS);
  await systemDb.workspace.update({
    where: { id: workspace.id },
    data: { deletedAt: now, deletedBy: `${actor.type}:${actor.id}`, purgeAfter },
  });
  await forgetCached(deps, workspace, envs);
  // Published copies are public URLs: they go now, not at the purge.
  const target = await deps.publisher.targetFor(workspace.id).catch(() => null);
  if (target) {
    for (const env of envs) {
      const paths = publishedPaths(workspace.slug, env.hostApp.slug, env.slug);
      for (const key of [paths.manifest, paths.importMap]) {
        await target.storage
          .delete(target.prefix + key)
          .catch((err: Error) =>
            logger.warn(`Removing published ${key} of deleted ${workspace.slug}: ${err.message}`)
          );
      }
    }
  }
  return { purgeAfter };
}

/** TLC-02: undoes a deletion before the purge; manifests are rebuilt and republished. */
export async function restoreWorkspace(
  deps: LifecycleDeps,
  workspace: { id: string; slug: string }
) {
  const { systemDb } = deps;
  await systemDb.workspace.update({
    where: { id: workspace.id },
    data: { deletedAt: null, deletedBy: null, purgeAfter: null },
  });
  const envs = await environmentsOf(systemDb, workspace.id);
  await forgetCached(deps, workspace, envs);
  for (const env of envs) {
    await deps.publisher.publish(env.id).catch(() => undefined); // recorded on the environment
  }
}

/**
 * TLC-03: purges workspaces and organizations whose restore window ended: rows, stored
 * objects (workspaces) and, for organizations, the slug. Audit trails stay (AUD-05). Each
 * purge is recorded in the instance audit log.
 */
export async function purgeDueTenants(deps: LifecycleDeps, now = new Date()) {
  const { systemDb, logger } = deps;
  const workspaces = await systemDb.workspace.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true, slug: true },
  });
  for (const workspace of workspaces) {
    try {
      const result = await deleteWorkspace(deps, workspace);
      await systemDb.instanceAuditEvent.create({
        data: {
          actorType: 'system',
          actorId: 'system:tenant.purge',
          action: 'instance.workspace_purged',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: { slug: workspace.slug, ...result },
        },
      });
    } catch (err) {
      logger.error(`Purging workspace ${workspace.slug} failed`, err as Error);
    }
  }
  const orgs = await systemDb.organization.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true, slug: true, _count: { select: { Workspaces: true } } },
  });
  let orgsPurged = 0;
  for (const org of orgs) {
    // An organization is deleted only once it has no workspaces; one attached since is kept.
    if (org._count.Workspaces) continue;
    await systemDb.organization.delete({ where: { id: org.id } });
    await systemDb.instanceAuditEvent.create({
      data: {
        actorType: 'system',
        actorId: 'system:tenant.purge',
        action: 'instance.org_purged',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug },
      },
    });
    orgsPurged++;
  }
  if (workspaces.length || orgsPurged) {
    logger.info(`Purged ${workspaces.length} workspaces and ${orgsPurged} organizations`);
  }
  return { workspaces: workspaces.length, organizations: orgsPurged };
}
