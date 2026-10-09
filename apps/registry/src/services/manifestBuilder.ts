import { createHash } from 'crypto';
import type { TenantTx } from '@harmoniq/db';
import type { Manifest, Module } from '@harmoniq/core/dist/schemas/ManifestSchema';

export interface ManifestTarget {
  workspaceSlug: string;
  hostApp: { id: string; slug: string; name: string };
  environment: { id: string; slug: string };
}

export interface BuiltManifest {
  manifest: Manifest;
  etag: string;
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
 * Builds the manifest for one host app environment from its active versions.
 *
 * The ETag hashes the content only (not `generatedAt`), so every replica produces the
 * same ETag for the same state and clients revalidate correctly across replicas.
 */
export async function buildManifest(
  tx: TenantTx,
  target: ManifestTarget,
  opts: { variant?: 'stable' | 'canary'; cohortId?: string; generatedAt?: Date } = {}
): Promise<BuiltManifest> {
  const versions = await tx.moduleVersion.findMany({
    where: { environmentId: target.environment.id, status: 'active', deletedAt: null },
    include: { remoteModule: true },
    orderBy: { remoteModule: { slug: 'asc' } },
  });

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
    },
  }));

  const content = {
    schemaVersion: 2 as const,
    workspaceSlug: target.workspaceSlug,
    hostApp: { slug: target.hostApp.slug, name: target.hostApp.name },
    environment: target.environment.slug,
    variant: opts.variant ?? 'stable',
    cohortId: opts.cohortId ?? 'stable',
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

  return { manifest: { ...content, generatedAt: generatedAt.toISOString(), etag }, etag };
}
