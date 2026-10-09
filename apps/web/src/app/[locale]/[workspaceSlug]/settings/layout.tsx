import { getTranslations } from 'next-intl/server';
import { roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import { SettingsNav } from './SettingsNav';

// Settings are admin-only; the registry enforces this on every call as well.
export default async function SettingsLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('SettingsPage');
  const workspace = await workspaceApi.get(workspaceSlug);

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>
      {roleAtLeast(workspace.role, 'admin') ? (
        <div className="grid md:grid-cols-[180px_1fr] gap-8">
          <SettingsNav
            workspaceSlug={workspaceSlug}
            labels={{
              storage: t('storage'),
              keys: t('apiKeys'),
              members: t('members'),
              webhooks: t('webhooks'),
              alerts: t('alerts'),
              approvals: t('approvalRules'),
              sso: t('sso'),
            }}
          />
          <div className="min-w-0">{props.children}</div>
        </div>
      ) : (
        <p className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
          {t('adminOnly')}
        </p>
      )}
    </div>
  );
}
