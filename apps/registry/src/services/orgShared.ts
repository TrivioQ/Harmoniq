// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { Module } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { invalidateManifest } from './cacheKeys';

/**
 * ORG-10/11: modules a workspace shares with its organization. They appear, read-only,
 * in the manifests of the org's other workspaces for the environment of the same name,
 * at the owner's active (stable) version. Reads cross workspaces, so they run in the
 * organization's scope (`withOrg`, MT-08): RLS keeps them inside the organization. Only the
 * workspace's organization is looked up with the system client (tenant resolution).
 */
export class OrgSharedModules {
  constructor(
    private deps: {
      systemDb: PrismaClient;
      withOrg: <T>(organizationId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
      cache: ICache;
      logger: ILogger;
      /** Republish an environment (CDN copy). */
      republish: (environmentId: string) => Promise<void>;
    }
  ) {}

  /** The shared modules for a workspace's environment, owner workspaces excluded. */
  async forTarget(workspaceId: string, environmentSlug: string): Promise<Module[]> {
    const organizationId = await this.organizationOf(workspaceId);
    if (!organizationId) return [];
    return this.deps.withOrg(organizationId, (tx) =>
      this.sharedIn(tx, organizationId, workspaceId, environmentSlug)
    );
  }

  /** Tenant resolution: the organization a workspace belongs to, if any. */
  private async organizationOf(workspaceId: string) {
    const workspace = await this.deps.systemDb.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    return workspace?.organizationId ?? null;
  }

  private async sharedIn(
    tx: TenantTx,
    organizationId: string,
    workspaceId: string,
    environmentSlug: string
  ): Promise<Module[]> {
    const versions = await tx.moduleVersion.findMany({
      where: {
        status: 'active',
        deletedAt: null,
        environment: { slug: environmentSlug },
        remoteModule: {
          orgShared: true,
          workspaceId: { not: workspaceId },
          workspace: { organizationId },
        },
      },
      include: { remoteModule: { include: { workspace: { select: { slug: true } } } } },
    });
    if (!versions.length) return [];
    const disabled = new Map(
      (
        await tx.moduleEnvState.findMany({
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
    const { cache, logger } = this.deps;
    try {
      const organizationId = await this.organizationOf(workspaceId);
      if (!organizationId) return;
      const environments = await this.deps.withOrg(organizationId, async (tx) => {
        if (!opts.force) {
          const shares = await tx.remoteModule.count({ where: { workspaceId, orgShared: true } });
          if (!shares) return [];
        }
        return tx.environment.findMany({
          where: {
            ...(environmentSlug && { slug: environmentSlug }),
            hostApp: { workspace: { organizationId, id: { not: workspaceId } } },
          },
          include: { hostApp: { include: { workspace: { select: { slug: true } } } } },
        });
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
