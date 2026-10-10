// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { authedFetch } from '@/lib/registry';
import { StorageForm } from '@/components/StorageForm';

export default async function WorkspaceStoragePage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const t = await getTranslations('WorkspaceStoragePage');
  const res = await authedFetch<{ storageConfig: WorkspaceStorageConfigResponse | null }>(
    `/api/workspaces/${encodeURIComponent(slug)}/storage`
  ).catch(() => null);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title', { slug })}</h1>
      {!res ? (
        <div className="p-4 bg-red-50 text-red-700 rounded-md">{t('errorLoad')}</div>
      ) : (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
          <StorageForm slug={slug} initial={res.storageConfig} />
        </div>
      )}
    </div>
  );
}
