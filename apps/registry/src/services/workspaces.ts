// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError } from '@harmoniq/core/dist/errors/AppError';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import { invalidateDefaultHost, invalidateManifest } from './cacheKeys';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { StorageTarget } from '../adapters/storage/createStorage';
import type { OrgSharedModules } from './orgShared';
import { type ManifestPublisher, publishedPaths } from './manifestPublisher';

/**
 * A new workspace with its creator as owner and a default host app (staging and
 * production). Runs as the system role: the tenant doesn't exist yet. ORG-08: created
 * inside an organization when `organizationId` is given.
 */
export async function createWorkspace(
  systemDb: PrismaClient,
  input: { name: string; slug: string; organizationId?: string; owners?: string[] },
  /** A user becomes the owner. An org API key (IaC-01) creates it ownerless: org admins administer it. */
  creator: { userId: string; ip?: string } | { apiKeyId: string; ip?: string },
  /** Drops "not found" answers cached for the slug before it existed. */
  cache?: ICache
) {
  let created;
  try {
    created = await systemDb.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { name: input.name, slug: input.slug, organizationId: input.organizationId },
      });
      if ('userId' in creator) {
        await tx.workspaceMember.create({
          data: { workspaceId: ws.id, userId: creator.userId, role: 'owner', joinedAt: new Date() },
        });
      }
      // TLC-05: invited owners; their first sign-in with this email accepts the invitation.
      for (const email of new Set(input.owners ?? [])) {
        const user =
          (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) ??
          (await tx.user.create({ data: { email } }));
        if ('userId' in creator && user.id === creator.userId) continue;
        const member = await tx.workspaceMember.create({
          data: { workspaceId: ws.id, userId: user.id, role: 'owner' },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId: ws.id,
            ...('userId' in creator
              ? { actorId: creator.userId, actorType: 'user' as const }
              : { actorId: creator.apiKeyId, actorType: 'apiKey' as const }),
            action: 'member.invite',
            resourceType: 'member',
            resourceId: member.id,
            ip: creator.ip,
            metadata: { email, role: 'owner' },
          },
        });
      }
      await tx.hostApp.create({
        data: {
          workspaceId: ws.id,
          name: 'Default',
          slug: 'default',
          isDefault: true,
          Environments: {
            create: [
              { name: 'Staging', slug: 'staging' },
              { name: 'Production', slug: 'production', isDefault: true },
            ],
          },
        },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: ws.id,
          ...('userId' in creator
            ? { actorId: creator.userId, actorType: 'user' as const }
            : { actorId: creator.apiKeyId, actorType: 'apiKey' as const }),
          action: 'workspace.create',
          resourceType: 'workspace',
          resourceId: ws.id,
          ip: creator.ip,
          ...(input.organizationId && { metadata: { organizationId: input.organizationId } }),
        },
      });
      return ws;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Workspace slug "${input.slug}" is taken`);
    }
    throw err;
  }
  if (cache) {
    await invalidateDefaultHost(cache, created.slug);
    for (const env of ['staging', 'production']) {
      await invalidateManifest(cache, created.slug, 'default', env);
    }
  }
  return created;
}

/**
 * Deletes a workspace and everything in it (ORG-08, INST-09). Its org-shared modules
 * leave the siblings' manifests first (the fan-out needs the organization), and its
 * cached manifests are dropped. TLC-03 (gap analysis P0-3): its stored objects go too:
 * bundle objects and the published manifest and import-map copies, in its own bucket and
 * in the instance storage (versions from before the bucket stay there, BYOB-11). Object
 * deletion is best effort and reported; the audit trail stays (AUD-05).
 */
export async function deleteWorkspace(
  container: {
    systemDb: PrismaClient;
    cache: ICache;
    orgShared: OrgSharedModules;
    publisher: Pick<ManifestPublisher, 'targetFor'>;
    readonly instanceStorage: StorageTarget | null;
    logger: ILogger;
  },
  workspace: { id: string; slug: string }
): Promise<{ objectsDeleted: number; objectsFailed: number }> {
  const { systemDb, cache, orgShared, logger } = container;
  const envs = await systemDb.environment.findMany({
    where: { hostApp: { workspaceId: workspace.id } },
    include: { hostApp: { select: { slug: true } } },
  });
  // Collected while the rows (and the bucket configuration) still exist.
  const bundles = (
    await systemDb.moduleVersion.findMany({
      where: { workspaceId: workspace.id, storagePath: { not: null } },
      select: { storagePath: true },
    })
  ).map((v) => v.storagePath!);
  const own = await container.publisher.targetFor(workspace.id);
  const targets = [
    ...new Set([own, container.instanceStorage].filter((t) => !!t)),
  ] as StorageTarget[];

  const shared = await systemDb.remoteModule.updateMany({
    where: { workspaceId: workspace.id, orgShared: true },
    data: { orgShared: false },
  });
  if (shared.count) await orgShared.fanOut(workspace.id, undefined, { force: true });
  await systemDb.workspace.delete({ where: { id: workspace.id } });
  for (const env of envs) {
    await invalidateManifest(cache, workspace.slug, env.hostApp.slug, env.slug);
  }

  let objectsDeleted = 0;
  let objectsFailed = 0;
  for (const target of targets) {
    const keys = new Set([
      ...bundles,
      ...envs.flatMap((env) => {
        const paths = publishedPaths(workspace.slug, env.hostApp.slug, env.slug);
        return [target.prefix + paths.manifest, target.prefix + paths.importMap];
      }),
    ]);
    for (const key of keys) {
      try {
        await target.storage.delete(key);
        objectsDeleted++;
      } catch (err) {
        objectsFailed++;
        logger.warn(
          `Deleting object ${key} of deleted workspace ${workspace.slug} failed: ${(err as Error).message}`
        );
      }
    }
  }
  return { objectsDeleted, objectsFailed };
}
