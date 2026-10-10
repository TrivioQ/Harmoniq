import { redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { createWorkspaceAction } from './w/[workspaceSlug]/actions';
import { createOrgAction } from './orgs/actions';
import { getTranslations } from 'next-intl/server';
import { getMe } from '@/lib/registry';

export default async function WorkspaceSelector() {
  const t = await getTranslations('WorkspaceSelector');
  const me = await getMe();
  if (!me) redirect('/auth/login');
  const { workspaces, organizations } = me;

  return (
    <div className="flex flex-col min-h-screen items-center p-6 md:p-24 bg-muted/30">
      <div className="w-full max-w-2xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-2">{t('description')}</p>
        </div>

        {organizations.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">{t('organizations')}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {organizations.map((org) => (
                <Link key={org.slug} href={`/orgs/${org.slug}`}>
                  <div className="p-4 border rounded-xl bg-card hover:border-primary transition-colors shadow-sm">
                    <h3 className="font-medium">{org.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {org.role === 'org_admin' ? t('orgAdmin') : t('orgMember')}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-4">
          {workspaces.map((ws) => (
            <Link key={ws.slug} href={`/w/${ws.slug}`}>
              <div className="p-6 border rounded-xl bg-card hover:border-primary transition-colors cursor-pointer shadow-sm">
                <h3 className="font-medium text-lg">{ws.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {ws.slug}
                  {ws.organization &&
                    ` · ${organizations.find((o) => o.slug === ws.organization)?.name ?? ws.organization}`}
                </p>
              </div>
            </Link>
          ))}
          {workspaces.length === 0 && (
            <div className="p-8 border border-dashed rounded-xl text-center">
              <p className="text-muted-foreground">{t('noWorkspaces')}</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-6 space-y-3">
          <h2 className="font-semibold">{t('createWorkspace')}</h2>
          <ActionForm
            action={createWorkspaceAction}
            submitLabel={t('create')}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              name="name"
              required
              placeholder="Acme Corp"
              aria-label={t('name')}
              className="rounded-md border px-3 py-1.5 text-sm"
            />
            <input
              name="slug"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              placeholder="acme-corp"
              aria-label={t('slug')}
              className="rounded-md border px-3 py-1.5 text-sm font-mono"
            />
          </ActionForm>
        </div>

        <details className="rounded-xl border bg-card p-6">
          <summary className="cursor-pointer font-semibold">{t('createOrg')}</summary>
          <p className="text-sm text-muted-foreground mt-2">{t('createOrgHint')}</p>
          <ActionForm
            action={createOrgAction}
            submitLabel={t('create')}
            className="flex flex-wrap items-center gap-2 mt-3"
          >
            <input
              name="name"
              required
              placeholder="Acme"
              aria-label={t('name')}
              className="rounded-md border px-3 py-1.5 text-sm"
            />
            <input
              name="slug"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              placeholder="acme"
              aria-label={t('slug')}
              className="rounded-md border px-3 py-1.5 text-sm font-mono"
            />
          </ActionForm>
        </details>
      </div>
    </div>
  );
}
