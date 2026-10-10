import { createHash } from 'crypto';
import type { TenantTx } from '@harmoniq/db';
import type { Manifest, Module } from '@harmoniq/core/dist/schemas/ManifestSchema';
import type { CanaryInfo } from './canary';
import type { TargetingRule } from '@harmoniq/core/dist/schemas/CanaryRequestSchema';

export interface ManifestTarget {
  workspaceSlug: string;
  hostApp: { id: string; slug: string; name: string };
  environment: { id: string; slug: string };
}

export interface BuiltManifest {
  manifest: Manifest;
  etag: string;
  /**
   * Canaries running in the environment (not part of the public manifest). Cached with
   * the stable manifest so the manifest route can assign variants without the database.
   */
  canaries?: { workspaceId: string; running: CanaryInfo[] };
}

/** JSON with sorted keys, so equal content always hashes to the same ETag. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Builds the manifest for one host app environment: the stable variant from its active
 * versions, or, with `canaryModuleIds`, the variant where those modules run their canary.
 *
 * The ETag hashes the content only (not `generatedAt`), so every replica produces the
 * same ETag for the same state and clients revalidate correctly across replicas.
 */
export async function buildManifest(
  tx: TenantTx,
  target: ManifestTarget,
  opts: {
    canaryModuleIds?: string[];
    generatedAt?: Date;
    /** ORG-11: modules shared by the organization's other workspaces. */
    shared?: Module[];
  } = {}
): Promise<BuiltManifest> {
  const all = await tx.moduleVersion.findMany({
    where: {
      environmentId: target.environment.id,
      status: { in: ['active', 'canary'] },
      deletedAt: null,
    },
    include: { remoteModule: true },
    orderBy: { remoteModule: { slug: 'asc' } },
  });
  const canaryVersions = all.filter((v) => v.status === 'canary');
  const disabled = new Map(
    (
      await tx.moduleEnvState.findMany({
        where: { environmentId: target.environment.id, disabled: true },
        select: { remoteModuleId: true, reason: true },
      })
    ).map((d) => [d.remoteModuleId, d.reason])
  );
  const useCanary = new Set(
    (opts.canaryModuleIds ?? []).filter((id) => canaryVersions.some((c) => c.remoteModuleId === id))
  );
  const versions = all.filter((v) =>
    v.status === 'canary' ? useCanary.has(v.remoteModuleId) : !useCanary.has(v.remoteModuleId)
  );

  const modules: Module[] = versions.map((v) => ({
    name: v.remoteModule.slug,
    ...(v.remoteModule.specifier && { specifier: v.remoteModule.specifier }),
    url: v.url,
    integrity: v.integrity,
    version: v.version,
    ...(v.dependencies && { dependencies: v.dependencies as Record<string, string> }),
    ...(v.exposes && { exposes: v.exposes as Record<string, string> }),
    metadata: {
      ...((v.metadata as Record<string, unknown> | null) ?? {}),
      deployedBy: v.deployedBy,
      deployedAt: v.deployedAt.toISOString(),
      ...(v.commitSha && { commitSha: v.commitSha }),
      ...(v.promotedFromEnv && { promotedFrom: v.promotedFromEnv }),
      ...(v.status === 'canary' && { canary: true }),
    },
    ...(disabled.has(v.remoteModuleId) && {
      disabled: true,
      ...(disabled.get(v.remoteModuleId) && { disabledReason: disabled.get(v.remoteModuleId)! }),
    }),
  }));

  // The workspace's own module wins over a shared one of the same name.
  const own = new Set(modules.map((m) => m.name));
  modules.push(...(opts.shared ?? []).filter((m) => !own.has(m.name)));

  const content = {
    schemaVersion: 2 as const,
    workspaceSlug: target.workspaceSlug,
    hostApp: { slug: target.hostApp.slug, name: target.hostApp.name },
    environment: target.environment.slug,
    variant: useCanary.size ? ('canary' as const) : ('stable' as const),
    // Per-user cohort ids are set on the response; cached variants are shared by cohorts.
    cohortId: useCanary.size ? 'canary' : 'stable',
    modules,
  };
  const etag = `sha256-${createHash('sha256').update(canonicalJson(content)).digest('base64url')}`;

  const generatedAt =
    opts.generatedAt ??
    (
      await tx.manifestSnapshot.findFirst({
        where: { environmentId: target.environment.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    )?.createdAt ??
    new Date(0);

  const canaries = canaryVersions.length
    ? {
        workspaceId: canaryVersions[0].workspaceId,
        running: canaryVersions.map((c) => ({
          moduleId: c.remoteModuleId,
          module: c.remoteModule.slug,
          versionId: c.id,
          version: c.version,
          trafficPercent: c.trafficPercent ?? 0,
          ...(Array.isArray(c.targeting) &&
            c.targeting.length && { targeting: c.targeting as unknown as TargetingRule[] }),
        })),
      }
    : undefined;

  return {
    manifest: { ...content, generatedAt: generatedAt.toISOString(), etag },
    etag,
    ...(canaries && { canaries }),
  };
}
