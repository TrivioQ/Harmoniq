import type { Environment, HostApp, ModuleVersion, RemoteModule } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { ConflictError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';

export type ModuleWithHost = RemoteModule & { hostApp: HostApp & { Environments: Environment[] } };

/**
 * Modules are addressed by id or slug. Slugs are unique per host app, so a slug that
 * exists in several host apps of the workspace is ambiguous and must be given by id.
 */
export async function resolveModule(tx: TenantTx, ref: string): Promise<ModuleWithHost> {
  const include = { hostApp: { include: { Environments: true } } };
  const byId = await tx.remoteModule.findUnique({ where: { id: ref }, include });
  if (byId) return byId;

  const bySlug = await tx.remoteModule.findMany({ where: { slug: ref }, include, take: 2 });
  if (bySlug.length === 0) throw new NotFoundError(`Module "${ref}" not found`);
  if (bySlug.length > 1) {
    throw new ConflictError(`Module slug "${ref}" exists in several host apps; use the module id`, {
      candidates: bySlug.map((m) => ({ id: m.id, hostApp: m.hostApp.slug })),
    });
  }
  return bySlug[0];
}

export function findEnvironment(module: ModuleWithHost, slug: string): Environment {
  const env = module.hostApp.Environments.find((e) => e.slug === slug);
  if (!env) {
    throw new NotFoundError(`Environment "${slug}" not found in host app "${module.hostApp.slug}"`);
  }
  return env;
}

export function versionDto(v: ModuleVersion, environmentSlug?: string) {
  return {
    id: v.id,
    moduleId: v.remoteModuleId,
    environmentId: v.environmentId,
    ...(environmentSlug && { environment: environmentSlug }),
    version: v.version,
    url: v.url,
    integrity: v.integrity,
    status: v.status,
    trafficPercent: v.trafficPercent,
    deployedBy: v.deployedBy,
    deployedByType: v.deployedByType,
    deployedAt: v.deployedAt.toISOString(),
    commitSha: v.commitSha,
    metadata: v.metadata,
    dependencies: v.dependencies,
    exposes: v.exposes,
    storagePath: v.storagePath,
    promotedFromId: v.promotedFromId,
    promotedFromEnv: v.promotedFromEnv,
  };
}

export type VersionDto = ReturnType<typeof versionDto>;

/** VER-03: exactly one non-canary active version per module + environment. */
export function deactivateActive(tx: TenantTx, moduleId: string, environmentId: string) {
  return tx.moduleVersion.updateMany({
    where: { remoteModuleId: moduleId, environmentId, status: 'active' },
    data: { status: 'inactive' },
  });
}
