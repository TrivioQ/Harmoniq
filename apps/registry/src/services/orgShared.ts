import type { PrismaClient } from '@prisma/client';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { Module } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { invalidateManifest } from './cacheKeys';

/**
 * ORG-10/11: modules a workspace shares with its organization. They appear, read-only,
 * in the manifests of the org's other workspaces for the environment of the same name,
 * at the owner's active (stable) version. Reads cross workspaces, so they use the
 * system client; nothing here writes tenant data.
 */
export class OrgSharedModules {
  constructor(
    private deps: {
      systemDb: PrismaClient;
      cache: ICache;
      logger: ILogger;
      /** Republish an environment (CDN copy). */
      republish: (environmentId: string) => Promise<void>;
    }
  ) {}

  /** The shared modules for a workspace's environment, owner workspaces excluded. */
  async forTarget(workspaceId: string, environmentSlug: string): Promise<Module[]> {
    const { systemDb } = this.deps;
    const workspace = await systemDb.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!workspace?.organizationId) return [];
    const versions = await systemDb.moduleVersion.findMany({
      where: {
        status: 'active',
        deletedAt: null,
        environment: { slug: environmentSlug },
        remoteModule: {
          orgShared: true,
          workspaceId: { not: workspaceId },
          workspace: { organizationId: workspace.organizationId },
        },
      },
      include: { remoteModule: { include: { workspace: { select: { slug: true } } } } },
    });
    if (!versions.length) return [];
    const disabled = new Map(
      (
        await systemDb.moduleEnvState.findMany({
          where: {
            disabled: true,
            OR: versions.map((v) => ({
              remoteModuleId: v.remoteModuleId,
              environmentId: v.environmentId,
            })),
          },
          select: { remoteModuleId: true, reason: true },
        })
      ).map((d) => [d.remoteModuleId, d.reason])
    );

    // One module per name; if two workspaces share the same name, the first owner wins.
    const byName = new Map<string, Module>();
    versions
      .sort((a, b) =>
        `${a.remoteModule.slug}/${a.remoteModule.workspace.slug}`.localeCompare(
          `${b.remoteModule.slug}/${b.remoteModule.workspace.slug}`
        )
      )
      .forEach((v) => {
        if (byName.has(v.remoteModule.slug)) return;
        byName.set(v.remoteModule.slug, {
          name: v.remoteModule.slug,
          ...(v.remoteModule.specifier && { specifier: v.remoteModule.specifier }),
          url: v.url,
          integrity: v.integrity,
          version: v.version,
          ...(v.dependencies && { dependencies: v.dependencies as Record<string, string> }),
          ...(v.exposes && { exposes: v.exposes as Record<string, string> }),
          metadata: {
            ...((v.metadata as Record<string, unknown> | null) ?? {}),
            deployedAt: v.deployedAt.toISOString(),
            ...(v.commitSha && { commitSha: v.commitSha }),
          },
          shared: true,
          ownerWorkspace: v.remoteModule.workspace.slug,
          ...(disabled.has(v.remoteModuleId) && {
            disabled: true,
            ...(disabled.get(v.remoteModuleId) && {
              disabledReason: disabled.get(v.remoteModuleId)!,
            }),
          }),
        });
      });
    return [...byName.values()];
  }

  /**
   * After a change in a workspace that shares modules (or stopped sharing one), the
   * other workspaces' manifests for that environment (every environment when omitted)
   * are stale: drop their caches and republish them. Best effort.
   */
  async fanOut(workspaceId: string, environmentSlug?: string, opts: { force?: boolean } = {}) {
    const { systemDb, cache, logger } = this.deps;
    try {
      const workspace = await systemDb.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      });
      if (!workspace?.organizationId) return;
      if (!opts.force) {
        const shares = await systemDb.remoteModule.count({
          where: { workspaceId, orgShared: true },
        });
        if (!shares) return;
      }
      const environments = await systemDb.environment.findMany({
        where: {
          ...(environmentSlug && { slug: environmentSlug }),
          hostApp: {
            workspace: { organizationId: workspace.organizationId, id: { not: workspaceId } },
          },
        },
        include: { hostApp: { include: { workspace: { select: { slug: true } } } } },
      });
      for (const env of environments) {
        await invalidateManifest(cache, env.hostApp.workspace.slug, env.hostApp.slug, env.slug);
        await this.deps.republish(env.id);
      }
    } catch (err) {
      logger.error('Refreshing org-shared manifests failed', err as Error);
    }
  }
}
