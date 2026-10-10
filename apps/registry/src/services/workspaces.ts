import { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError } from '@harmoniq/core/dist/errors/AppError';

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
