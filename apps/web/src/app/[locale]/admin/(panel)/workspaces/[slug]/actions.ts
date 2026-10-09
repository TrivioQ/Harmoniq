'use server';

import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { RegistryError, authedFetch } from '@/lib/registry';

export type SaveStorageState =
  | { status: 'idle' }
  | { status: 'success'; config: WorkspaceStorageConfigResponse }
  | { status: 'error'; message: string };

const CREDENTIAL_FIELDS = {
  S3: ['accessKeyId', 'secretAccessKey'],
  GCS: ['projectId', 'clientEmail', 'privateKey'],
} as const;

// Authorization happens in the registry (workspace admin or instance admin); the slug
// coming from the client is not trusted for anything else.
export async function saveStorageConfig(
  slug: string,
  _prev: SaveStorageState,
  form: FormData
): Promise<SaveStorageState> {
  const provider = String(form.get('provider')) as keyof typeof CREDENTIAL_FIELDS;
  if (!(provider in CREDENTIAL_FIELDS)) {
    return { status: 'error', message: 'Choose a storage provider' };
  }

  // Blank secret fields mean "keep what is stored"; only send credentials when all are set.
  const entries = CREDENTIAL_FIELDS[provider].map((name) => [name, String(form.get(name) ?? '')]);
  const credentials = entries.every(([, value]) => value) ? Object.fromEntries(entries) : undefined;
  const cdnPrefix = String(form.get('cdnPrefix') ?? '').trim();

  try {
    const res = await authedFetch<{ storageConfig: WorkspaceStorageConfigResponse }>(
      `/api/workspaces/${encodeURIComponent(slug)}/storage`,
      {
        body: {
          provider,
          bucket: String(form.get('bucket') ?? '').trim(),
          region: String(form.get('region') ?? '').trim(),
          ...(credentials && { credentials }),
          ...(cdnPrefix && { cdnPrefix }),
        },
      }
    );
    return { status: 'success', config: res.storageConfig };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : 'Failed to update storage',
    };
  }
}
