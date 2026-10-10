import { getTranslations } from 'next-intl/server';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { authedFetch } from '@/lib/registry';
import { StorageForm } from '@/components/StorageForm';

export default async function StorageSettingsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('SettingsPage');
  const res = await authedFetch<{ storageConfig: WorkspaceStorageConfigResponse | null }>(
    `/api/workspaces/${encodeURIComponent(workspaceSlug)}/storage`
  );
  return (
    <section className="rounded-xl border bg-card p-6 space-y-4 max-w-2xl">
      <h3 className="font-semibold">{t('storage')}</h3>
      <StorageForm slug={workspaceSlug} initial={res.storageConfig} />
    </section>
  );
}
