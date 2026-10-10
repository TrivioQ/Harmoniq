// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { RegistryError, authedFetch } from '@/lib/registry';

// BYOB-01..06: a workspace's own bucket. Authorization happens in the registry
// (workspace admin or instance admin); the slug from the client is not trusted otherwise.

export type StorageState =
  | { status: 'idle' }
  | { status: 'saved'; config: WorkspaceStorageConfigResponse; firstTime: boolean }
  | { status: 'tested'; ok: boolean; latencyMs: number; error?: string }
  | { status: 'removed' }
  | { status: 'error'; message: string };

const CREDENTIAL_FIELDS = {
  S3: ['accessKeyId', 'secretAccessKey', 'roleArn', 'externalId'],
  GCS: ['serviceAccountJson'],
  AZURE: ['connectionString'],
} as const;

const path = (slug: string, rest = '') =>
  `/api/workspaces/${encodeURIComponent(slug)}/storage${rest}`;
const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const failure = (err: unknown, fallback: string): StorageState => ({
  status: 'error',
  message: err instanceof RegistryError ? err.message : fallback,
});

/** The config in the form. Blank credential fields mean "keep what is stored". */
function configFrom(form: FormData) {
  const provider = text(form, 'provider') as keyof typeof CREDENTIAL_FIELDS;
  const filled = (CREDENTIAL_FIELDS[provider] ?? [])
    .map((name) => [name, text(form, name)] as const)
    .filter(([, value]) => value);
  const optional = (name: string) => text(form, name) || undefined;
  return {
    provider,
    bucket: text(form, 'bucket'),
    region: text(form, 'region'),
    endpoint: provider === 'S3' ? optional('endpoint') : undefined,
    cdnPrefix: optional('cdnPrefix'),
    pathPrefix: optional('pathPrefix'),
    ...(filled.length && { credentials: Object.fromEntries(filled) }),
  };
}

/** BYOB-04/06: the registry tests the bucket before saving; failures come back here. */
export async function saveStorageConfig(
  slug: string,
  _prev: StorageState,
  form: FormData
): Promise<StorageState> {
  try {
    const res = await authedFetch<{
      storageConfig: WorkspaceStorageConfigResponse;
      firstTime?: boolean;
    }>(path(slug), { body: configFrom(form) });
    revalidatePath('/', 'layout');
    return { status: 'saved', config: res.storageConfig, firstTime: !!res.firstTime };
  } catch (err) {
    return failure(err, 'Failed to update storage');
  }
}

/** BYOB-05: Test Connection with what is in the form, without saving. */
export async function testStorageConfig(
  slug: string,
  _prev: StorageState,
  form: FormData
): Promise<StorageState> {
  try {
    const res = await authedFetch<{ ok: boolean; latencyMs: number; error?: string }>(
      path(slug, '/test'),
      { body: configFrom(form) }
    );
    return { status: 'tested', ...res };
  } catch (err) {
    return failure(err, 'The test could not run');
  }
}

/** Back to the instance default storage (new deploys only). */
export async function removeStorageConfig(
  slug: string,
  _prev: StorageState
): Promise<StorageState> {
  try {
    await authedFetch(path(slug), { method: 'DELETE' });
    revalidatePath('/', 'layout');
    return { status: 'removed' };
  } catch (err) {
    return failure(err, 'Failed to remove storage');
  }
}
