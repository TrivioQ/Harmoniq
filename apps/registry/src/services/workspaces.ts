import { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError } from '@harmoniq/core/dist/errors/AppError';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import { invalidateManifest } from './cacheKeys';
import type { OrgSharedModules } from './orgShared';

/**
 * A new workspace with its creator as owner and a default host app (staging and
 * production). Runs as the system role: the tenant doesn't exist yet. ORG-08: created
 * inside an organization when `organizationId` is given.
 */
export async function createWorkspace(
  systemDb: PrismaClient,
  input: { name: string; slug: string; organizationId?: string },
  creator: { userId: string; ip?: string }
) {
  try {
    return await systemDb.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { name: input.name, slug: input.slug, organizationId: input.organizationId },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: ws.id, userId: creator.userId, role: 'owner', joinedAt: new Date() },
      });
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
          actorId: creator.userId,
          actorType: 'user',
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
}

/**
 * Deletes a workspace and everything in it (ORG-08, INST-09). Its org-shared modules
 * leave the siblings' manifests first (the fan-out needs the organization), and its
 * cached manifests are dropped.
 */
export async function deleteWorkspace(
  container: { systemDb: PrismaClient; cache: ICache; orgShared: OrgSharedModules },
  workspace: { id: string; slug: string }
) {
  const { systemDb, cache, orgShared } = container;
  const envs = await systemDb.environment.findMany({
    where: { hostApp: { workspaceId: workspace.id } },
    include: { hostApp: { select: { slug: true } } },
  });
  const shared = await systemDb.remoteModule.updateMany({
    where: { workspaceId: workspace.id, orgShared: true },
    data: { orgShared: false },
  });
  if (shared.count) await orgShared.fanOut(workspace.id, undefined, { force: true });
  await systemDb.workspace.delete({ where: { id: workspace.id } });
  for (const env of envs) {
    await invalidateManifest(cache, workspace.slug, env.hostApp.slug, env.slug);
  }
}
